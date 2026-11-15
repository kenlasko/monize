---
title: "Query pipes see the global ValidationPipe's converted value, by emitted param type (#2221)"
author: Node
date: 2026-11-15
branch: claude/issue-2221
cost: { minutes: 35, tokens: 238863 }
touches:
  - backend/src/bonds/bond-query.pipes.ts
  - backend/src/common/global-validation-param-pipes.guard.spec.ts
  - docs/backend/entities-and-dtos.md
  - backend/CLAUDE.md
  - backend/src/bonds/bond-query.pipes.spec.ts
  - backend/src/bonds/bonds-redemption-split.http.spec.ts
  - backend/src/bonds/bonds.controller.spec.ts
  - backend/src/bonds/bonds.controller.ts
  - backend/src/common/pipes/global-validation.pipe.ts
  - backend/src/main.ts
---

## Decided
- A pipe that checks query text sits on a parameter declared `string`, returns the validated text, and the handler converts it (`Number(quantity)` on <=10 digits). ParseBondQuantityPipe follows this, like ParseCalendarDatePipe / ParseCurrencyCodePipe.
- The global ValidationPipe is built once in `backend/src/common/pipes/global-validation.pipe.ts` (`createGlobalValidationPipe`); HTTP specs use it with supertest (`bonds-redemption-split.http.spec.ts`).
- `global-validation-param-pipes.guard.spec.ts` requires every controller and reads the emitted `design:paramtypes`; only Nest's ParseInt/ParseFloat/ParseBool/DefaultValue pipes (matched by identity) may sit on a Number/Boolean query or param.

## Tried and ruled out
- Letting the pipe accept the number the global pipe hands over: `+value` reads `0x10` as 16 and `2.9999999999999999` as 3, so the route would answer a split for a quantity nobody typed.
- A branded type (`number & {brand}`) to dodge the conversion: TypeScript still emits `Number`.
- Scanning the written annotation with the TS AST: `x?: number` emits Number but `x: number | undefined` emits Object, so only runtime metadata is authoritative.

## Watch out
- transformPrimitive (Nest 12): Number -> `+value`, Boolean -> `value === "true"` (so ParseBoolPipe never 400s), String -> `String(value)` (a repeated key arrives as "a,b", not an array).
- `test/helpers/test-database.ts` builds its own ValidationPipe with `enableImplicitConversion: true`, which differs from main.ts.
- `loan-payment-frequency.guard.spec.ts` fails outside TZ=UTC; run test:changed with TZ=UTC.
