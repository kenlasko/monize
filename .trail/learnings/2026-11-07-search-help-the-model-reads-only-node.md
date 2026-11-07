---
title: "search_help: the model reads only tool data, and a new MCP tool always grows the tools/list total"
author: Node
date: 2026-11-07
branch: claude/issue-2056
cost: { minutes: 51, tokens: 246024 }
touches:
  - backend/src/help/help-llm-shape.ts
  - backend/src/help/help.service.spec.ts
  - backend/src/help/help.service.ts
  - backend/src/mcp/tools/help.tool.spec.ts
  - docs/backend/ai-and-payees.md
  - backend/src/ai/context/prompt-templates.spec.ts
  - backend/src/ai/context/prompt-templates.ts
  - backend/src/ai/query/tool-executor.service.ts
  - backend/src/help/help.real-docs.spec.ts
  - backend/src/ai/query/tool-executor.search-help.spec.ts
---

## Decided
- `search_help` is `HelpService.getLlmHelp` (backend/src/help/help.service.ts; shape and caps in help-llm-shape.ts) with two thin adapters: `ToolExecutorService.searchHelp` and `backend/src/mcp/tools/help.tool.ts`. Both share `searchHelpSchema` and `SEARCH_HELP_DESCRIPTION` from tool-input-schemas.ts. It is in `DELEGATE_ALLOWED_AI_TOOLS` because it reads only the public guide.
- Anything the model must act on goes in `data`, never in the executor's `summary`. ai-query.service.ts sends the model only `JSON.stringify(sanitizeToolResultStrings(result.data))`; `summary` is the reader's tools-used line. So `getLlmHelp` carries a `notice` whenever `sections` is empty: "no guide here" or "no match, retry in English".
- getLlmHelp ranks only sections with text. 25 heading-only parents in search-index.json otherwise win on their heading match and spend a slot on nothing.

## Tried and ruled out
- Keeping the "no section covers this" and "guide unavailable" messages only in the summary: the model never sees them.
- Fitting a new MCP tool inside the existing TOTAL_BYTE_BUDGET: impossible, the table had 167 bytes of slack and search_help is 1,098. The total was raised by less than the tool's bytes, with no per-tool cap moved, pending owner approval (the plan says stop and report).

## Watch out
- The help scorer tokenizes only [a-z0-9] after NFKD folding, so a question in Cyrillic, CJK or another non-Latin script finds nothing.
- A fork of /code-review raised Node's heap to 8 GB to typecheck; pass it the 4 GB limit explicitly.
- tsc over the backend needs NODE_OPTIONS=--max-old-space-size=4096 on this machine, or it aborts out of heap.
