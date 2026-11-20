# Dashboard trivia that changes every day: task list

The task graph for `docs/future-plans/trivia-variety.md`. All phases ship in one PR on `feat/trivia-variety`, one commit per phase, in this order. Each phase is written for an agent with no other context. Before starting, read the plan sections the phase names, `AGENTS.md`, and the layer `CLAUDE.md` of each layer it touches.

Rules for every phase:

- Run only the focused specs the phase lists, from the layer directory: `npm run test:unit -- <paths>` in `backend/` and `npm run test -- <paths>` in `frontend/`. No full suite, no `test:changed`.
- Stage new files (`git add -N`) before running anything, because the tree-walking guards cannot see untracked files.
- Frontend files are never run through Prettier. The pre-commit hook runs eslint with `--max-warnings=0`, and a warning blocks the commit: fix it, never `--no-verify`.
- After editing `frontend/src/i18n/messages/en/*.json`, run `npm run i18n:pseudo` in `frontend/`. Never hand-edit `xx/*`. Grep for a key before adding it.
- `frontend/src/i18n/messages.parity.test.ts` is expected to fail from phase B until G2 (plan, Open decision 11). `backend/src/ai/trivia/trivia-catalog.spec.ts` must pass in every phase.
- Commit subject: Conventional Commits, imperative, no trailing period, no emojis. End each message with the `Co-Authored-By:` trailer of the agent that wrote it.

| ID | Phase | Depends on | Status |
| --- | --- | --- | --- |
| A | Types, figure kinds, families table, shared figure helpers, frontend formatting | none | Done |
| B1 | Daily-moving facts, the purchase predicate, the pool builder, cron timezone | A | Done |
| B2 | Calendar and event facts | B1 | Done |
| C | Parametrised (windowed and ranked) facts | B2 | Done |
| D | Daily selection and rotation | C | Done |
| E | Prompt, validator, equivalence facts | D | Done |
| F | Catalog variants in English, widget pick | E | Done |
| G1 | Translations: de, es, fr, it, nl, pl, pt, pt-BR, en-GB | F | Done |
| G2 | Translations: hi, id, ja, ko, ru, tr, uk, vi, zh-CN, zh-TW | G1 | Done |
| H | Docs and final gate | G2 | Open (one guard red: investment-filter.guard.spec.ts) |

---

## A. Types, figure kinds, families table, frontend formatting

Plan sections: 1, 2, 7 (widget bullets only), 9.

Backend:

1. `backend/src/ai/trivia/trivia.types.ts`:
   - Add the kinds `date` / `day` (`value: string`, `YYYY-MM-DD`) and `days` / `years` (`value: number`) to `TriviaFigure`.
   - Add `TRIVIA_WINDOWS`, `TriviaWindow` and `TriviaFactParams`.
   - Add `params?` to `TriviaFact`, `params?` to the calculated `TriviaItem`, and `factIds?` to the AI `TriviaItem`, exactly as in plan section 1.
2. New `backend/src/ai/trivia/trivia-figures.ts`: the figure constructors for every kind and `fact(id, topic, figures, params?)`. Delete the private copies from `backend/src/ai/trivia/trivia-facts.ts` and `backend/src/ai/trivia/trivia-ledger-facts.ts` and import these. No behaviour change.
3. New `backend/src/ai/trivia/trivia-families.ts`: `TriviaLane`, `TRIVIA_FAMILIES`, `TriviaFamily`, `familyOf`, `laneOf`, for the 26 existing ids only. Every family is `evergreen` in this phase. The grouped ones are:
   - `netWorthHighPoint` = `netWorthHighPoint` + `netWorthAtHighPoint`
   - `netWorthBiggestDip` = `netWorthBiggestDip` + `netWorthBiggestDipRecovered`
   - `investmentsGain` = `investmentsGain` + `investmentsLoss`

   Every other id is its own family, named after the id.
4. New `backend/src/ai/trivia/trivia-windows.ts`: `seedHash(...parts: string[]): number` (`createHash("sha256").update(parts.join("\u001f")).digest().readUInt32BE(0)`), `dayIndex(today)`, `weekIndex(today)`, `asOfDay(today)`, `windowRange(window, today)`, `pickWindow(userId, family, today)` and `pickRank(userId, family, today)`, as in plan section 3.4. `windowRange("m12", ...)` delegates to `triviaWindow` in `backend/src/ai/trivia/trivia-ledger.loader.ts`; leave `triviaWindow` exported there.
5. New `backend/src/ai/trivia/__fixtures__/trivia-pool.fixture.ts`: `fullTriviaFactsInput()` and `fullLedgerInput()`, inputs that make `buildTriviaFacts` and `buildLedgerTriviaFacts` produce every current id they can. Each later phase extends it for the builders it adds. The two investments variants that exclude each other (gain/loss, dip/recovered, high point/at high point) need a second fixture each. Export `alternateInputs()` returning those.
6. New specs:
   - `backend/src/ai/trivia/trivia-families.spec.ts`: every `TRIVIA_FACT_IDS` member is in exactly one family; from the fixtures, a builder yields at most one fact per family; no figure name appears in two families; every fact of a family has one topic.
   - `backend/src/ai/trivia/trivia-windows.spec.ts`: `seedHash` is stable for fixed input (pin one value); `dayIndex("1970-01-02") === 1`; each `windowRange`, including the `ytd` fallback before January 8 and `all` with an `undefined` start; `pickRank` is in {2, 3}; `pickWindow` is stable within a week.

Frontend:

7. `frontend/src/types/dashboard-trivia.ts`: the same four kinds, `params?: { window?: string }` on the calculated item, `factIds?: string[]` on the AI item.
8. `frontend/src/lib/utils.ts`: add `'MMMM d, yyyy'` to `ChartDatePattern` and `CHART_DATE_OPTIONS` (`{ month: 'long', day: 'numeric', year: 'numeric' }`).
9. New `frontend/src/components/dashboard/trivia-format.ts`: `useTriviaFigureFormat()`, moved out of `TriviaWidget.tsx`'s `formatFigure` with the new kinds per plan section 2, and a `default` branch returning `String(figure.value)`. `days` and `years` use `useTranslations('dashboard')` with `trivia.units.days` / `trivia.units.years`.
10. `frontend/src/components/dashboard/TriviaWidget.tsx`:
    - use `useTriviaFigureFormat()`;
    - drop calculated items whose `trivia.facts.<id>` does not exist (`t.has`) before counting;
    - pass `window: item.params?.window ?? 'other'` in the values given to `t()`.
11. `frontend/src/i18n/messages/en/dashboard.json`: add `trivia.units.days` and `trivia.units.years` exactly as in plan section 2. Then run `npm run i18n:pseudo`.
12. Tests:
    - new `frontend/src/components/dashboard/trivia-format.test.ts`: every kind, the plural units at 1 and 3, the unknown-kind default;
    - extend `frontend/src/components/dashboard/TriviaWidget.test.tsx`: an unknown factId is skipped and the count shows one fewer; a `day` figure renders its weekday.

Run:

- `backend/`: `npm run test:unit -- src/ai/trivia`
- `frontend/`: `npm run test -- src/components/dashboard/TriviaWidget.test.tsx src/components/dashboard/trivia-format.test.ts src/lib/utils.test.ts`. Extend `frontend/src/lib/utils.test.ts` with the new `'MMMM d, yyyy'` pattern.

Observe: the trivia suites are green, and the widget renders exactly as before for every existing fact.

Commit: `feat(trivia): add date and day-count figure kinds and fact families`.

---

## B1. Daily-moving facts, purchase predicate, pool builder, cron timezone

Plan sections: 3.1, 3.5, 3.7 (the daily rows), 4, 8.

1. **Purchase predicate.** Create `backend/src/built-in-reports/purchase-rows-sql.ts` with `PURCHASE_ROW_CONDITIONS_SQL` and `PURCHASE_AMOUNT_SQL`, moved from `getSpendingByPayee` in `backend/src/built-in-reports/spending-reports.service.ts`, which then uses them. Before changing anything, run `npm run test:unit -- src/built-in-reports/spending-reports.service.spec.ts`. It must be green before and after with no edits: this is a pure move.
2. **Pool builder.** Create `backend/src/ai/trivia/trivia-pool.builder.ts` (`TriviaPoolBuilder`, plan section 4). Move `loadFacts`, `loadPortfolio` and `otherAssets` out of `backend/src/ai/trivia/dashboard-trivia.service.ts` into it. Add `timezoneOf`. `TriviaLedgerLoader.load(userId, currency, today)` takes `today` and no longer reads the timezone. Update `backend/src/ai/trivia/trivia-ledger.loader.spec.ts` to match.
3. **Cron timezone** (plan section 8) in `handleDailyGeneration` / `generateForUser`. `getTrivia` passes `{ today: todayInTimezoneOrUtc(await this.pool.timezoneOf(userId)), mode: "page" }`, and the cron passes `mode: "cron"`. For now the service keeps showing every fact, shuffled as today; phase D replaces that.
4. **Daily loader.** `backend/src/ai/trivia/trivia-daily.loader.ts`, `TriviaDailyLoader.load(userId, currency, today, { bills })` returns `TriviaDailyInput`:

   ```ts
   {
     currency;
     monthToDate: { through; spent; previousSpent } | null;
     lastDay: { date; spent } | null;
     lastSevenDays: { from; spent } | null;
     biggestPurchase: { amount; currency; payee; date } | null;
     lastSpendDate: string | null;
     sincePayee: { name; lastDate } | null;
     bills: { occurrences: ResolvedScheduledOccurrence[]; total: number | null } | null;
     budget: { name; currency; spent; total } | null;
     topMover: TopMover | null;
   }
   ```

   Each field comes from its own `attempt`; copy `attempt` from the ledger loader. `sincePayee` needs the twelve-month `spendingByPayee`: the pool builder passes the ledger loader's result in. Raw SQL selects dates with `to_char(..., 'YYYY-MM-DD')` and amounts with `Number(...)` at the boundary. Inject `ScheduledOccurrenceService`, `ExchangeRateService`, `PortfolioService`, `BuiltInReportsService` and `DataSource`.
5. **Daily facts.** `backend/src/ai/trivia/trivia-daily-facts.ts`, `buildDailyTriviaFacts(input)`: the ten families of plan section 3.1, with every guard in that table. Register the ids in `TRIVIA_FACT_IDS` and the families in `TRIVIA_FAMILIES` with `lane: "daily"`.
6. Register `TriviaPoolBuilder` and `TriviaDailyLoader` in `backend/src/ai/ai.module.ts`.
7. **English sentences.** Add the en sentences of the twelve daily ids (plan section 3.7) to `trivia.facts` in `frontend/src/i18n/messages/en/dashboard.json`, then run `npm run i18n:pseudo` in `frontend/`.
8. Tests:
   - new `backend/src/ai/trivia/trivia-daily-facts.spec.ts`: every fact and every refusal in the table. Required refusals: the 1st of a month gives no month-to-date; a `null` report total; a previous month at 0; a multi-currency week gives no biggest purchase; a null payee name; a streak of 1 and of 31; an unpriced next bill with a priced second one gives no next-bill fact; a bills total of `null`; an income-linked budget; one budget line `null`; a top mover with `dailyValueChange: null`.
   - new `backend/src/ai/trivia/trivia-daily.loader.spec.ts`:
     - the window dates passed to each report for a fixed `today`, including the previous-month clamp (T = 2026-03-31 gives a previous span of Feb 1 to Feb 28);
     - `findOccurrences` is called with `{ from: T, through: T + 6 }` and `{ outflowsOnly: true }`, and not at all when `bills: false`;
     - `queryCategorySpending` gets the budget's id;
     - one throwing source nulls only its own field.

     Type the mocks as their real collaborators (`docs/backend/testing.md`).
   - extend `backend/src/ai/trivia/trivia-catalog.spec.ts`: build the daily facts from the fixture (extend `backend/src/ai/trivia/__fixtures__/trivia-pool.fixture.ts` with `fullDailyInput()`) and hold each sentence to its fact's figure set.
   - new `backend/src/ai/trivia/trivia-pool.builder.spec.ts`: `mode: "page"` passes `bills: false`; `today` reaches every loader.
   - update `backend/src/ai/trivia/dashboard-trivia.service.spec.ts`: the cron enters `withUserContext` with the resolved timezone (assert the third argument).

Run:

- `backend/`: `npm run test:unit -- src/ai/trivia src/built-in-reports/spending-reports.service.spec.ts src/module-graph.spec.ts`
- `frontend/`: `npm run test -- src/components/dashboard/TriviaWidget.test.tsx`

Observe: a user with spending yesterday gets a `spendingLastDay` item, and the widget renders it with a weekday date.

Commit: `feat(trivia): add facts that move with each day`.

---

## B2. Calendar and event facts

Plan sections: 3.2, 3.3, 3.7 (those rows).

1. **Calendar loader.** `backend/src/ai/trivia/trivia-calendar.loader.ts`, `TriviaCalendarLoader.load(userId, currency, today)` returns:

   ```ts
   {
     accountFirstDates: { name: string; firstDate: string }[] | null;
     transactionsRecordedBefore: number | null;   // the 30-day created_at count
     yearAgoMonth: SpendingByCategoryResponse | null;
   }
   ```

   The account read joins `accounts` to `transactions` under `withScopedDb`, open accounts only, with `stripBrokerageSuffix` applied in TypeScript.
2. **Calendar facts.** `backend/src/ai/trivia/trivia-calendar-facts.ts`, `buildCalendarTriviaFacts(input: { today; currency; months: TriviaNetWorthMonth[]; records: TriviaRecordCounts | null; warranties: TriviaWarranties | null; calendar })`. Ids and families:
   - event lane: `activityAnniversary`, `activityAccountAnniversary`, `netWorthMilestone`, `activityTransactionMilestone`, `warrantiesExpiresSoon`;
   - evergreen lane: `spendingYearAgoMonth`, and `netWorthYearAgo` with the ids `netWorthYearAgoUp` / `netWorthYearAgoDown`.

   The dedupe "`warrantiesExpiresSoon` drops `warrantiesNextExpiry`" is done in `TriviaPoolBuilder` after concatenation; test it there. Export `monthsBetween` from `backend/src/ai/trivia/trivia-facts.ts` rather than copying it.
3. Register `TriviaCalendarLoader` and wire it into `TriviaPoolBuilder`.
4. Add the en sentences (plan section 3.7), then run `npm run i18n:pseudo`.
5. Tests:
   - new `backend/src/ai/trivia/trivia-calendar-facts.spec.ts`:
     - the anniversary week edges at 0, 6 and 7 days;
     - 02-29 in a non-leap year;
     - 0 years gives nothing;
     - the brokerage pair counted once, and the ledger's own first date excluded;
     - net worth crossing exactly R gives a fact, and a fall through R gives none;
     - milestones 99 to 100 (fact), 1999 to 2000 (fact) and 2000 to 2001 (none);
     - warranty days of 0, 1, 30 and 31;
     - the year-ago month when records begin mid-month (none);
     - the year-ago net worth with the earlier month `fxComplete: false` (none).
   - new `backend/src/ai/trivia/trivia-calendar.loader.spec.ts`: the year-ago window dates for T = 2026-01-15 (2025-01-01 to 2025-01-31); each source isolated.
   - extend `backend/src/ai/trivia/trivia-pool.builder.spec.ts` (the warranty dedupe), `backend/src/ai/trivia/trivia-catalog.spec.ts` and `backend/src/ai/trivia/trivia-families.spec.ts` (with `fullCalendarInput()` in the fixture).

Run:

- `backend/`: `npm run test:unit -- src/ai/trivia`
- `frontend/`: `npm run test -- src/components/dashboard/TriviaWidget.test.tsx` (a `date` and a `years` figure render).

Observe: on a ledger whose first transaction was 2023-11-17, the list on 2026-11-19 holds "This week marks 3 years since your first transaction in Monize, on November 17, 2023."

Commit: `feat(trivia): add anniversaries, milestones and year-ago facts`.

---

## C. Parametrised facts

Plan sections: 1 (params), 3.4, 3.7 (the windowed rows), 7 (the `window` argument).

1. **Ledger loader.** `backend/src/ai/trivia/trivia-ledger.loader.ts`: `load(userId, currency, today, picks)` adds `windowed: { spendingByCategory: Map<TriviaWindow, SpendingByCategoryResponse | null>; spendingByPayee: ...; incomeBySource: ... }`. It reads only the windows in `picks`, each `(report, window)` once, and reuses the `m12` reads for `m12`. Keep the file under 400 lines. If it would pass that, move the windowed reads into a private helper file `backend/src/ai/trivia/trivia-windowed-reads.ts`.
2. **Picks.** `TriviaPoolBuilder` computes `picks` for the six windowed families with `pickWindow` / `pickRank` (`backend/src/ai/trivia/trivia-windows.ts`).
3. **Ranked facts.** New `backend/src/ai/trivia/trivia-ranked-facts.ts`, `buildRankedTriviaFacts({ currency, picks, windowed, m12 })`:
   - the families `spendingTopCategory`, `spendingTopPayee` and `incomeTopSource` move here from `backend/src/ai/trivia/trivia-ledger-facts.ts` (`m12` gives the legacy id with no `params`; any other window gives the `...Window` id with `params.window`);
   - add `spendingRankedCategory`, `spendingRankedPayee` and `incomeRankedSource` (`params.window` always set).
4. Add the six new ids to `TRIVIA_FACT_IDS` and `TRIVIA_FAMILIES` (evergreen, and the three legacy families gain their `...Window` id).
5. **English sentences.** Add the six en sentences with the full `W` select (plan section 3.7), then run `npm run i18n:pseudo`. Check that the generated `xx` keeps the `select` keywords and branch names unpseudoed (`frontend/scripts/i18n-pseudo.mjs` handles nested ICU). If it does not, stop and report rather than hand-editing `xx`.
6. **Catalog spec.** `backend/src/ai/trivia/trivia-catalog.spec.ts`:
   - before extracting `{name}` placeholders, strip a window select with `/\{window, select,(?:[^{}]|\{[^{}]*\})*\}/g`;
   - assert every windowed id's sentence holds that select with exactly the branches `d30 d90 ytd m12 all other`;
   - update the legacy-ledger count assertion (11 becomes 8, since the three top facts moved) and add the ranked builder to the coverage of every id.
7. Tests:
   - new `backend/src/ai/trivia/trivia-ranked-facts.spec.ts`:
     - `m12` gives the legacy id with no params;
     - `d90` gives `spendingTopCategoryWindow` with `params.window === "d90"`;
     - rank 3 when only two categories exist gives nothing;
     - an "Unknown" payee row (`payeeId: null`) is never ranked;
     - a `null` `totalSpending` gives no ranked category.
   - extend `backend/src/ai/trivia/trivia-ledger.loader.spec.ts`: two families that pick the same window cause one report call.
   - extend `frontend/src/components/dashboard/TriviaWidget.test.tsx`: an item `{ factId: 'spendingTopCategoryWindow', params: { window: 'd90' } }` renders "Over the last 90 days, ...".

Run:

- `backend/`: `npm run test:unit -- src/ai/trivia`
- `frontend/`: `npm run test -- src/components/dashboard/TriviaWidget.test.tsx`

Commit: `feat(trivia): rotate the window and rank of the ranking facts`.

---

## D. Daily selection and rotation

Plan section 5.

1. New `backend/src/ai/trivia/trivia-rotation.ts`: the constants, `yesterdayOf`, `familyOrder`, `selectDailyTrivia` and `orderForDisplay`, exactly as specified. They are pure, and `seedHash` comes from `backend/src/ai/trivia/trivia-windows.ts`.
2. `backend/src/ai/trivia/trivia-sentences.ts`: `mergeTriviaItems` becomes per fact (plan section 5, last paragraph) and copies `params` onto calculated items.
3. `backend/src/ai/trivia/dashboard-trivia.service.ts`:
   - delete `shuffled` and the `randomInt` import;
   - `generateForUser` and `getTrivia` follow plan section 5, "Service integration", including the rewording path that keeps today's facts;
   - the model receives only `selected` (the prompt change itself is phase E).
4. Tests:
   - new `backend/src/ai/trivia/trivia-rotation.spec.ts`:
     - **Determinism:** the same input gives the same output, twice.
     - **Rotation guarantee:** with a fixed pool of 30 evergreen families and yesterday fed from the previous day's output, simulate 60 consecutive days. No family appears twice within any 7 consecutive days, and none on two consecutive days.
     - **Topic spread:** no topic holds more than `TOPIC_CAP` facts on any simulated day where the pool allows it.
     - **Daily lane:** a daily fact shown yesterday with identical figures is excluded, and with one figure changed it is eligible.
     - **Event lane:** an event shown yesterday is skipped today and shown the day after.
     - **Pool size:** a pool smaller than 8 is returned whole; at most one fact per family.
     - **Old rows:** a yesterday row from before this change (no `factIds`, unknown ids) does not throw.
     - **Display order:** `orderForDisplay` never puts two facts of one topic side by side when another order exists.
   - extend `backend/src/ai/trivia/trivia-sentences.spec.ts` (per-fact merge; an AI item without `factIds` keeps the per-topic rule).
   - update `backend/src/ai/trivia/dashboard-trivia.service.spec.ts`:
     - the stored row holds at most `TRIVIA_DAILY_COUNT` items;
     - the rewording path keeps the stored facts;
     - no `randomInt` (assert by importing nothing from `crypto` in the service, or simply drop the old shuffle assertions).

Run:

- `backend/`: `npm run test:unit -- src/ai/trivia`

Observe: with a large pool, two consecutive `generateForUser` runs on two dates store lists that share no evergreen family.

Commit: `feat(trivia): show a rotating daily subset of the facts`.

---

## E. Prompt, validator, equivalence facts

Plan sections: 3.6, 6.

1. New `backend/src/ai/trivia/trivia-prompt.ts`:
   - move `buildTriviaPrompt` out of `backend/src/ai/trivia/trivia-sentences.ts` and give it the signature `buildTriviaPrompt(facts, { avoid, angle })`;
   - add the window line and the new-kind descriptions;
   - add `pickTriviaAngle(userId, today)`.
2. `backend/src/ai/context/prompt-templates.ts`: update `TRIVIA_SYSTEM_PROMPT` as plan section 6 says (rules 2 and 5, the new angle/avoid rule, the topics paragraph; rules 1, 3, 4 and 6 word for word), and add `TRIVIA_ANGLES`.
3. `parseTriviaSentences`: the combined-fact rule and `factIds` (plan section 6, Validator).
4. `DashboardTriviaService.phraseWithAi(userId, selected, language, { avoid, angle })`: `avoid` comes from the stored row's AI items. Keep `skipRelay: true` and the relay check.
5. New `backend/src/ai/trivia/trivia-equivalence-facts.ts` (plan section 3.6). Export `completeFlows` from `backend/src/ai/trivia/trivia-ledger-facts.ts`, add the four ids (evergreen) to the types and families, and wire the builder into `TriviaPoolBuilder`.
6. Add the four en sentences, then run `npm run i18n:pseudo`.
7. Tests:
   - new `backend/src/ai/trivia/trivia-prompt.spec.ts`:
     - a `text` figure's value never appears in the prompt (put a distinctive name in the fixture and assert it is absent);
     - `avoid` sentences appear under their heading;
     - the angle line appears;
     - a `days` figure's description says not to write the unit;
     - a windowed fact carries its window words and no numeral.
   - extend `backend/src/ai/trivia/trivia-sentences.spec.ts`:
     - two facts of one topic in one sentence are kept, with both `factIds`;
     - three facts are dropped;
     - two topics are dropped;
     - a digit outside a placeholder is still dropped.
   - extend `backend/src/ai/context/prompt-templates.spec.ts` if it pins the trivia prompt.
   - new `backend/src/ai/trivia/trivia-equivalence-facts.spec.ts`: each fact, plus the refusals (fewer than 3 months, a `null` report total, an incomplete valuation, a result under 0.5).
   - extend `backend/src/ai/trivia/trivia-catalog.spec.ts` and `backend/src/ai/trivia/trivia-families.spec.ts` with the fixture's `fullEquivalenceInput()`.
   - extend `backend/src/ai/trivia/dashboard-trivia.service.spec.ts`: the prompt sent holds yesterday's AI texts; the relay is still never called.

Run:

- `backend/`: `npm run test:unit -- src/ai/trivia src/ai/context/prompt-templates.spec.ts`

Commit: `feat(trivia): give the model yesterday's wording, an angle and equivalences`.

---

## F. Catalog variants in English, widget pick

Plan section 7.

1. `frontend/src/i18n/messages/en/dashboard.json`: add `trivia.variants.<id>.b` and `.c` for every id in `TRIVIA_FACT_IDS`, 56 ids. Each variant:
   - quotes exactly the same placeholders as `trivia.facts.<id>`;
   - for a windowed id, carries the identical `{window, select, ...}` block, which may sit anywhere in the sentence;
   - is under 160 characters, plain, with no advice, no opinion, no `--` and no emoji;
   - is not a near-copy (change the structure, not one word).

   Then run `npm run i18n:pseudo`.
2. New `frontend/src/lib/trivia-variant.ts` (`pickTriviaVariant`, FNV-1a, no `Math.random`) and `frontend/src/lib/trivia-variant.test.ts`:
   - stable for fixed input;
   - spreads over 3 keys across 30 days (every key chosen at least once);
   - one key always gives that key.
3. `frontend/src/components/dashboard/TriviaWidget.tsx`: pick the key with `pickTriviaVariant(keys, item.factId, useFinancialToday())` over the keys that `t.has`. Extend `frontend/src/components/dashboard/TriviaWidget.test.tsx`: two different mocked days give two different sentences for one fact.
4. `backend/src/ai/trivia/trivia-catalog.spec.ts`:
   - every key under `trivia.variants` names an id in `TRIVIA_FACT_IDS`;
   - every variant's placeholder set (after stripping the window select) equals its fact's;
   - every windowed id's variants hold the select with the same branches.

Run:

- `frontend/`: `npm run test -- src/lib/trivia-variant.test.ts src/components/dashboard/TriviaWidget.test.tsx src/i18n/messages.punctuation.test.ts src/i18n/messages.duplicate-keys.test.ts`
- `backend/`: `npm run test:unit -- src/ai/trivia/trivia-catalog.spec.ts`

Commit: `feat(trivia): word each calculated fact in three ways`.

---

## G1 / G2. Translations

Every key added under `trivia` since `origin/main` (`git diff origin/main -- frontend/src/i18n/messages/en/dashboard.json` lists them) is translated into each listed locale's `frontend/src/i18n/messages/<locale>/dashboard.json`:

- `trivia.units.*`
- the new `trivia.facts.*`
- every `trivia.variants.*`

Rules:

- Placeholder names and the `window` select's argument, keyword and branch names (`d30 d90 ytd m12 all other`) stay in English. Only the branch texts are translated.
- The `units` plurals use the locale's own CLDR categories: for example `one few many other` in pl, ru and uk; `other` only in ja, ko, vi, zh-CN, zh-TW and id.
- "number {rank}" is rendered the locale's natural way ("Platz {x}", "n° {x}", "第{x}位").
- Keep each variant distinct in that language.
- `en-GB` (G1) holds only keys whose British spelling differs (as `investmentsCagr` does today). `en-US` and `en-CA` add nothing.
- G1 covers de, es, fr, it, nl, pl, pt, pt-BR and en-GB. G2 covers hi, id, ja, ko, ru, tr, uk, vi, zh-CN and zh-TW.

Run:

- `frontend/`: `npm run test -- src/i18n/messages.parity.test.ts src/i18n/messages.duplicate-keys.test.ts`. After G1 it reports only G2's locales; after G2 it must be fully green.
- `backend/`: `npm run test:unit -- src/ai/trivia/trivia-catalog.spec.ts` (English only, as a check that nothing in `en` moved).

Commits: `feat(i18n): translate the new trivia facts (de, es, fr, it, nl, pl, pt, pt-BR, en-GB)` and `feat(i18n): translate the new trivia facts (hi, id, ja, ko, ru, tr, uk, vi, zh-CN, zh-TW)`.

---

## H. Docs and final gate

1. `website/docs/dashboard.md`, the `## Trivia` section:
   - describe about eight facts a day, chosen afresh each morning, with a fact returning after about a week;
   - per topic, add what is new: the last complete day and week, the month so far against last month, the budget's pace, a no-spend streak and days since a payee (spending); upcoming bills, anniversaries and milestones (your records); the top mover of the latest session (investments); a year ago (net worth, spending); a warranty countdown (warranties); windows of 30 or 90 days, the year so far, twelve months or all time, and the second- or third-largest category, payee or income source;
   - say that a sentence is worded differently from day to day;
   - keep the paragraph on providers and names.
2. `website/docs/ai.md`, "AI Trivia": "facts about your net worth and investments" becomes "facts about your money and your records". Add one sentence: the model is shown its previous day's sentences so it does not repeat them, and may join two facts of one topic.
3. `README.md`, line about widgets: "a daily Trivia fact about your finances" becomes "daily Trivia facts about your finances".
4. `docs/cron-jobs.md`, the `dashboard-trivia.service` row:
   - the body runs per user in that user's timezone;
   - it builds the pool (adding the daily, calendar, windowed and equivalence reads and the next seven days' scheduled occurrences) and stores a rotating subset of about eight;
   - claim, schedule and failure behaviour are unchanged.
5. `docs/future-plans/dashboard-trivia-tasks.md` is left as is. In this file, set every phase's Status to Done.
6. In `frontend/`, run `npm run docs:build`.
7. No screenshot retake: the widget's layout is unchanged and its content is data. Say so in the PR body.
8. **Final gate.** Run once and quote the results:
   - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run i18n:check`, `npm run test:unit -- src/common/doc-paths.spec.ts src/common/source-comment-paths.spec.ts src/common/instruction-files.spec.ts src/ai/trivia`
   - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test -- src/i18n src/components/dashboard/TriviaWidget.test.tsx src/test/ui-conventions.test.ts`
   - root: `node scripts/check-docs-manifests.mjs`
9. PR body: invariant IDs touched are INV-OCCURRENCE-003 (bills through `ScheduledOccurrenceService`), INV-FX-001 (report totals, `convertingTotal`), INV-REPORT-001 (the shared purchase predicate) and WTY-002 (warranty bounds). State that there is no migration and why (plan, Open decision 2).

Commit: `docs(trivia): describe the daily rotating trivia`.
