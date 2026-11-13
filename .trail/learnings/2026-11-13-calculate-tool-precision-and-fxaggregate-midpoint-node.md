---
title: "Calculate tool precision and FxAggregate midpoint rounding (#2148)"
author: Node
date: 2026-11-13
branch: claude/issue-2148
cost: { minutes: 19, tokens: 130799 }
touches:
  - backend/src/common/fx-aggregate.spec.ts
  - backend/src/common/fx-aggregate.ts
  - docs/specs/fx-conversion-completeness.md
  - backend/src/ai/query/calculate-arithmetic.spec.ts
  - backend/src/ai/query/calculate-arithmetic.ts
  - backend/src/ai/query/calculate-tool.spec.ts
  - backend/src/ai/query/calculate-tool.ts
  - backend/src/ai/query/tool-definitions.ts
  - backend/src/mcp/tools/calculate.tool.ts
  - docs/backend/ai-and-payees.md
---

## Decided
- The shared `calculate` tool (AI Assistant + MCP) returns `result` unrounded; only `formattedResult` is rounded (2dp, half away from zero via `roundToDecimals`). Arithmetic is exact decimal on BigInt units in `backend/src/ai/query/calculate-arithmetic.ts`: each input is read from its shortest round-trip string, sums/differences are exact, quotients are carried to 21 significant digits and parsed once (so 0.07/0.1 = 0.7, 1/3 = the double nearest 1/3).
- `sumMoney` is wrong for general arithmetic: it rounds every input to 4dp first. Do not reuse it for non-money math.
- `FxAggregate` now scales each component via `roundMoney(x, FIAT_MONEY_DECIMALS) * 10000` then `Math.round`, so negative midpoints round away from zero like `roundMoney`.

## Tried and ruled out
- Raising the MCP `tools/list` TOTAL budget for the extra description words: tightened the existing calculate description instead (budget is within ~10 bytes).
- Adding an index line to `backend/CLAUDE.md`: it is ~20 bytes under its 16 KiB ceiling; the rule went into `docs/backend/ai-and-payees.md` only.

## Watch out
- `npm run test:changed` on this worker runs in TZ=America/Toronto; `loan-payment-frequency.guard.spec.ts` and one `budget-alert.service.spec.ts` case fail there and pass under TZ=UTC (CI). Not a regression.
- Plain `npx tsc --noEmit` OOMs at the default heap here; use NODE_OPTIONS=--max-old-space-size=4096.
