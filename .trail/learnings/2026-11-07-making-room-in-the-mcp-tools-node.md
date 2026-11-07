---
title: Making room in the MCP tools/list budget by trimming descriptions
author: Node
date: 2026-11-07
branch: claude/issue-2056
cost: { minutes: 8, tokens: 291139 }
touches:
  - docs/future-plans/in-app-help-assistant-tool-tasks.md
  - backend/src/ai/query/tool-definitions.spec.ts
  - backend/src/ai/query/tool-input-schemas.ts
  - backend/src/mcp/tools-list-budget.spec.ts
  - backend/src/mcp/tools/accounts.tool.ts
  - backend/src/mcp/tools/investments.tool.ts
  - backend/src/mcp/tools/payees.tool.ts
  - backend/src/mcp/tools/relay.tool.ts
  - backend/src/mcp/tools/scheduled.tool.ts
  - backend/src/mcp/tools/transactions.tool.ts
---

## Decided
- For search_help the owner chose to trim other tool descriptions rather than raise TOTAL_BYTE_BUDGET (64,595). About 950 bytes came from nine MCP descriptions (list_upcoming_bills, manage_transactions, list_payees, manage_payees, report_progress, list_accounts, get_portfolio_summary, get_next_prompt, manage_securities), and each trimmed tool's cap was lowered to its new measured size. Approach: cut restatement and worked examples, and drop facts the server instructions already state for every tool (names resolve internally). Keep every rule: unknown is never guessed, null total vs known*Subtotal, name the totals' currency, resend complete splits.

## Tried and ruled out
- Raising the total by the new tool's bytes, the precedent for list_warranties: the plan says stop and report instead, and the owner rejected it.

## Watch out
- tools-list-budget.spec.ts only prints the size table when it fails. To measure, dump `client.listTools()` from `collectToolConfigs()` through an InMemoryTransport (the spec's own `listRealTools`) and sum `JSON.stringify(tool).length`.
- transactions.tool.spec.ts pins the phrases "EXISTING split transaction", "COMPLETE splits array", "splitId" and "Several split transactions CAN be sent in one call" in manage_transactions' description.
- The MCP descriptions live in src/mcp/tools/*.tool.ts and are separate from the assistant's tool-definitions.ts text (except tools such as list_warranties and search_help that share a constant). A trim on one surface does not touch the other.
