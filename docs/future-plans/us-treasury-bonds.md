# US Treasury securities: plan

Implements `docs/specs/bond-marketable-primitives.md` (engine) and
`docs/specs/us-treasury-securities.md` (the `US` adapter). Task list:
`docs/future-plans/us-treasury-bonds-tasks.md`.

## Assumptions (restated for a fresh session)

- The engine is country-agnostic; `country-agnostic.guard.spec.ts` fails a US
  literal in `domain/`, `engine/` or a shared bond service. Every US rule is
  data in a template or code under `adapters/us/`.
- Stored terms are immutable (INV-BOND-001): every new terms field is optional
  and its absence means today's behaviour; every Polish golden stays green
  unchanged.
- No new dependency, no migration (`benchmark_series.unit` and
  `bond_instruments.marketability` are free text; `kind` stays `STEP` or
  `MONTHLY`).
- Tests never touch the network; the fixtures the shell could not record are
  constructed and listed in the country spec section 10.
- Money is `ExactDecimal` in the engine (no `Number(`, `parseFloat(`, `Math.`).

## Phases

| Phase | What | Spec sections | Gate |
| --- | --- | --- | --- |
| 1 | P1 marketability, P2 rounding basis, P5 lot cost (engine, lot fold, price policy) | primitives 3, 4, 6 | `npm run test:unit -- bonds` green, Polish goldens unchanged |
| 2 | P3 `COUPON_DATES`, P4 `ACTUAL_ACTUAL_ICMA`, purchased accrued interest | primitives 5, 6.2 | E4 to E7 as engine unit tests |
| 3 | `US` adapter: calendar, CUSIP, programs, templates BILL/NOTE/BOND, TA_WS fetch with fixtures, provider id, spec guard, goldens, i18n labels, frontend unit hint | country 1 to 5, 7, 9 | adapter and golden specs, guards |
| 4 | P6 `INDEX_RATIO` + `US_CPI_U_NSA`; P7 `DAILY_INDEX_PLUS_SPREAD` + `US_TBILL_13W_MMY`; TIPS and FRN templates | primitives 7, country 6 | E8 to E13 |
| 5 | Savings bonds I and EE | primitives 8 | not started |

Each phase is one or more commits on `feat/us-treasury-bonds`, each with its
tests and doc lines; a phase ends with
`npm run lint && npx tsc --noEmit && npm run typecheck` and
`npm run test:changed` from `backend/`.
