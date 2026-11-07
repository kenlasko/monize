# Tasks: the assistant answers from the guide

Task list for `docs/future-plans/in-app-help-assistant-tool.md`. Needs plans 1
and 3 merged (plan 4 piece C for in-panel citations). Check a box only when its
gate passes and is quoted in the commit or PR.

## Backend

- [x] `HelpService.getLlmHelp`: plan 3's search plus capped section text, URL,
      guide version, language.
- [x] Assistant adapter: `search_help` in `FINANCIAL_TOOLS`, executor
      `{ summary, sources }`, no-hit summary, one system-prompt sentence.
- [x] `DELEGATE_ALLOWED_AI_TOOLS` entry, named in the PR as a reviewed decision.
- [x] MCP adapter `help.tool.ts`, output schema, read-only annotations, `read` scope.

## Tests

- [x] Domain, executor and MCP specs listed in the plan.
- [ ] `tools-list-budget.spec.ts` and the delegate guard green without raising a cap.
      Both are green and no existing cap moved, but a new tool has to be
      counted: `search_help` got its own 1,100-byte cap and the total went
      64,595 -> 65,530. That growth is less than the tool's 1,098 bytes,
      because the table measured 64,428 before it. It is recorded in the spec
      as a reviewed decision and awaits the owner's approval in the PR.
- [x] Real-question retrieval fixture through `getLlmHelp`.
- [ ] Manual check on two providers; transcripts in the PR.

## Docs

- [x] `docs/backend/ai-and-payees.md` paragraph.
- [x] `docs/backend/mcp.md` tool list.
- [x] `website/docs/ai.md` describes the help answers and the MCP tool;
      `npm run docs:build`.

## Verification

- [ ] Backend gates green, quoted; frontend gates if touched; `docs:check` green.
