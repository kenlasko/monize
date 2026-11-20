---
title: "Daily trivia is built per reader just after their local midnight, and picks a rotating subset with no history table"
author: Ken
date: 2026-11-20
branch: feat/trivia-variety
cost: { minutes: 1, tokens: 1827 }
id: l-830728e1
scope: repo
status: active
src: agent
touches:
  - backend/src/built-in-reports/purchase-rows-sql.ts
  - backend/src/common/investment-filter.guard.spec.ts
  - backend/test/integration/trivia-sql.integration.spec.ts
  - docs/future-plans/trivia-variety.md
---

## Decided
- The trivia list is built for the reader's local day, so the job runs hourly and builds each reader in the first hours after their local midnight; the job claim is keyed on the local day. One run at a fixed UTC time was wrong once the list held day-relative figures (days until a warranty ends, bills in the next seven days).
- No history table or migration was added to avoid repeats: a rotation seeded from the user and the day number, filtered against the one stored row, is enough. The stored row counts as "yesterday" only while its generated time falls on an earlier local day.
- The rotation takes calendar events first, then its evergreen facts, then daily facts, then fills up, because the evergreen walk advances a fixed step each day and must take its full step.
- A page load that finds a row from an earlier local day builds a calculated list and does not store it, so the job still sees the real yesterday. A rewording after a language change keeps the row's original generated time for the same reason.
- A count or ratio is shown as a preformatted chip, so a sentence can never agree with it in number. Catalog sentences use a label shape ("Payees you keep: N") in every locale.
- The model is told the period of every fact whose sentence names one; without it a sentence could pass validation and state the wrong period.

## Tried and ruled out
- Events, then daily, then evergreen: on a crowded day fewer evergreens were taken than the walk advanced by, and 7 of 28 evergreen families were never shown in a 30-day simulation.
- Calling the budget service's own actuals method for budget pace: it is private and drops a row with no exchange rate, where trivia must withhold a partial sum.
- Stating the next bill or the week's bill total when an occurrence's amount is an estimate: the sentence read as exact, so those facts are withheld.

## Watch out
- The report guard for investment exclusion reads each report service's own SQL template for the names of the exclusion and the reportable amount. Moving a report's predicate into a shared constant hides them and turns the guard red; pass both into a shared function from the report instead.
- The no-spend streak and "you spent X on that day" use two definitions of spending and can contradict each other in one list; emit the streak only when the report-based spend over its days is zero.
- Adding or removing an evergreen fact shifts the deterministic rotation, so specs must not depend on which facts a given day selects.
- Machine translation of chip sentences needs a native read for locales derived from a sibling (zh-TW from zh-CN, pt-BR from pt).

In the code: backend/src/ai/trivia/ (trivia-rotation.ts, trivia-due-users.ts, trivia-kept.ts, trivia-families.ts TRIVIA_PERIODS, trivia-prompt.ts, dashboard-trivia.service.ts cron "17 * * * *"), backend/src/built-in-reports/purchase-rows-sql.ts purchaseRowConditionsSql, backend/src/common/investment-filter.guard.spec.ts, backend/test/integration/trivia-sql.integration.spec.ts, docs/future-plans/trivia-variety.md.
