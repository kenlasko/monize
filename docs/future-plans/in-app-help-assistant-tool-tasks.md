# Tasks: the assistant answers from the guide

Task list for `docs/future-plans/in-app-help-assistant-tool.md`. Needs plans 1
and 3 merged (plan 4 piece C for in-panel citations). Check a box only when its
gate passes and is quoted in the commit or PR.

## Backend

- [ ] `HelpService.getLlmHelp`: plan 3's search plus capped section text, URL,
      guide version, language.
- [ ] Assistant adapter: `search_help` in `FINANCIAL_TOOLS`, executor
      `{ summary, sources }`, no-hit summary, one system-prompt sentence.
- [ ] `DELEGATE_ALLOWED_AI_TOOLS` entry, named in the PR as a reviewed decision.
- [ ] MCP adapter `help.tool.ts`, output schema, read-only annotations, `read` scope.

## Tests

- [ ] Domain, executor and MCP specs listed in the plan.
- [ ] `tools-list-budget.spec.ts` and the delegate guard green without raising a cap.
- [ ] Real-question retrieval fixture through `getLlmHelp`.
- [ ] Manual check on two providers; transcripts in the PR.

## Docs

- [ ] `docs/backend/ai-and-payees.md` paragraph.
- [ ] `docs/backend/mcp.md` tool list.
- [ ] `website/docs/ai.md` describes the help answers and the MCP tool;
      `npm run docs:build`.

## Verification

- [ ] Backend gates green, quoted; frontend gates if touched; `docs:check` green.
