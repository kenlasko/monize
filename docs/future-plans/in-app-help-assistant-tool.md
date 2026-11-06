# Plan: the assistant answers from the guide (in-app help, plan 6)

Part of `docs/future-plans/in-app-help.md`; needs plan 1's bundled guide and
plan 3's scorer (plan 2 and plan 4 piece C make the citations clickable). A
shared AI tool, `search_help`, lets the assistant and MCP clients answer "how
do I..." questions about Monize from the guide and cite the section, instead of
answering from what the model guesses about the product. One PR, backend, plus
the small frontend part piece C already provides.

## Assumptions (verified against the tree, 2026-11)

- Every AI tool is shared between the assistant
  (`backend/src/ai/query/tool-executor.service.ts`, definitions in
  `backend/src/ai/query/tool-definitions.ts`, `FINANCIAL_TOOLS`) and the MCP
  server (`backend/src/mcp/tools/*.tool.ts`). The logic goes on a domain
  service, the two layers are thin adapters, and both are wired in the same PR
  (`docs/backend/ai-and-payees.md`, "Shared AI tools").
- MCP tools declare an output schema in `backend/src/mcp/tool-output-schemas.ts`.
  `tools/list` bytes are budgeted by `backend/src/mcp/tools-list-budget.spec.ts`,
  and raising that cap is a reviewed decision.
- An acting delegate's assistant offers only `DELEGATE_ALLOWED_AI_TOOLS`
  (`backend/src/ai/query/ai-query.service.ts`), and
  `delegate-ai-tools.guard.spec.ts` fails when a tool is in neither that list
  nor `DELEGATE_DENIED_AI_TOOLS`.
- Plan 3's `HelpService.search` returns sections with page, anchor, heading
  and a plain-text excerpt. The guide is content this repository wrote, not
  untrusted input, but it is still data to the model, never instructions.

## Design

### The domain method

`HelpService.getLlmHelp(query, { limit })` (default 5, maximum 8): plan 3's
`search`, then for each hit the section's full plain text, capped at about 1,500
characters with an ellipsis, plus `pageTitle`, `heading` and `url`, the section's
monize.net URL (`https://www.monize.net/docs/<page>#<anchor>`). It also returns
`guideVersion` and `language: "en"`. No user data, no database access, so no
`withScopedDb`, no RLS and no delegate scope question.

### The assistant adapter

- `search_help` in `FINANCIAL_TOOLS` (`query` required, at most 200 characters;
  `limit` optional). The description tells the model to call it for questions
  about how Monize works, where a setting is, or what a figure means, and to
  cite each section it relies on by its `url`.
- The executor returns `{ summary, sources }` as the other tools do. The summary
  lists the sections found and says "no section of the guide covers this" when
  there are none, so the model does not invent an answer.
- The assistant's system prompt gains one sentence: product questions are
  answered from `search_help` and cited; financial questions about the user's
  own data use the data tools as now.
- Added to `DELEGATE_ALLOWED_AI_TOOLS`: it reads only the public guide. Name
  this in the PR as the reviewed allow-list decision it is.

### The MCP adapter

- `backend/src/mcp/tools/help.tool.ts`, `search_help` with the same parameters,
  returning `toolResult(data)` of the same domain answer; an output schema in
  `tool-output-schemas.ts`; read-only annotations; `read` scope.
- Keep the description short enough to stay inside the `tools/list` budget. If
  it cannot fit, stop and report rather than raising the cap.

### Citations in the app

The model cites `https://www.monize.net/docs/...` links. Plan 4 piece C's
`isGuideUrl` override in `AssistantMarkdown` opens those in the help panel on a
plain click, so a citation lands beside the conversation. If piece C has not
landed, citations still work as ordinary links to monize.net.

## Tests

- `getLlmHelp`: limit bounds, text cap, URL shape, empty result, `language`.
- Executor spec: the full argument list reaches `getLlmHelp`; the summary for
  hits and for no hits.
- MCP tool spec: same arguments, same shape, output schema validates, read-only
  annotations; `tools-list-budget.spec.ts` stays green.
- `delegate-ai-tools.guard.spec.ts` green with the tool in the allowed list.
- `tool-definitions.spec.ts` and any schema-fragment guard green.
- Quality: plan 3's real-question fixture, run through `getLlmHelp`, each
  question's expected section present. This tests retrieval, which is what the
  code controls. The model's use of it is checked by hand on two providers
  before merge, with the transcripts in the PR.

## Docs

- `docs/backend/ai-and-payees.md`: a paragraph for `search_help` (domain method,
  both adapters, delegate decision, citation format).
- `docs/backend/mcp.md`: the tool in its list.
- The guide's `website/docs/ai.md`: the assistant can answer questions about
  using Monize and cites the guide; the MCP tool is listed with the others.

## What to run

`backend/` gates per `AGENTS.md`, including `tools-list-budget.spec.ts` and the
delegate guard; `frontend/` gates if the citation override changes there;
`npm run docs:check` for the guide edit.

## Observable when done

Asking the assistant "how do I undo a split?" returns steps from the
Transactions guide with a link to that section, and clicking the link opens it
in the help panel. An MCP client calling `search_help` gets the same sections.
