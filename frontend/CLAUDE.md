# Frontend Directory

Next.js App Router application (React 19, Tailwind CSS v4, Zustand, react-hook-form + Zod, next-intl, Vitest). All commands run from this directory.

This file is an index. The rules themselves live in `docs/frontend/` (start at `docs/frontend/README.md`) and are read when the work touches their subject. Most of them are also enforced by a source-scanning test whose failure message names the thing to use, so a rule is met by fixing the code, never by widening a guard's baseline or its allowlist.

## Commands

```bash
npm run dev                # Dev server (port 3000)
npm run build              # Production build (standalone output for Docker)
npm run lint               # ESLint
npm run type-check         # tsc --noEmit
npm run test               # Vitest (single run)
npm run test:changed       # Tests related to changes since origin/main plus every guard; prints failures only; no coverage
npm run test:watch         # Vitest (watch mode)
npm run test:cov           # Coverage report (91% lines, 90% stmts, 87% funcs, 85% branches)
npm run i18n:pseudo        # Regenerate the xx pseudo-locale from en
npm run i18n:check         # Verify the pseudo-locale is up to date (CI gate)
npm run docs:build         # Regenerate the user docs (website/docs/) from their Markdown
```

## Layout

`src/` is organized by feature under `app/` and `components/` (shared primitives in `components/ui/`), with `lib/` for API clients and pure utilities, `store/` for Zustand, `test/` for the shared test harness and `proxy.ts` for the Next middleware. Use the filesystem or LSP `workspaceSymbol` for anything more specific.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Vitest resolve alias).
- **Tailwind CSS v4:** utilities compile to `var(--color-*)`; theme variables live in the `globals.css` `@theme` block and colour themes in `src/app/themes.css`.
- **Next.js:** standalone output (Docker); security headers and the CSP nonce come from `next.config.js` and `src/proxy.ts` (Next middleware, not this project's deprecated middleware pattern).

## Rules that apply to every change

**Find how the codebase already does it and do it the same way.** Each of these exists once; the generic version looks fine in isolation and wrong in place. `src/test/ui-conventions.test.ts` and the guard tests named in `docs/frontend/` fail on most of the hand-rolled versions.

| Need | Use | Never |
|---|---|---|
| Panel card | `Card` / `CARD_CLASS` (`components/ui/Card.tsx`) | an inline `bg-white dark:bg-gray-800 rounded-lg shadow` trio |
| Dialog | `Modal` with `title` (`components/ui/Modal.tsx`) | a hand-rolled heading or overlay |
| Status pill / table chrome | `Badge`; `Th`/`Td` and the constants in `components/ui/Table.tsx` | a hand-rolled pill or `<th>` class string |
| Empty list | `EmptyState` | a `text-center py-12` block |
| Date entry | `DateInput` | a raw `<input type="date">` |
| Money entry / other numbers | `CurrencyInput` / `NumericInput` | any `type="number"` input; `parseFloat` on typed text |
| Number a person reads | `useNumberFormat()` (`formatCurrency`, `formatNumber`, `formatPercent`, `formatShareQuantity`, `formatBytes`) | `toFixed`, `toLocaleString()`, the raw `@/lib/format` helpers, a literal `%` |
| Rounding, a bound, an id check, a foreign ISO code | `roundToCents` / `roundMoney` / `sumMoney` / `withCurrencyCode` (`lib/format.ts`), `clamp` (`lib/clamp.ts`), `isUuid` (`lib/uuid.ts`) | a local `round2`, `clamp` or UUID regex, or a component's own `formatCurrency` |
| Today, for a financial decision | `useFinancialToday()` / `financialTodayYmd` | `new Date().toISOString().slice(0, 10)` |
| Help that explains a figure or setting | `InfoTooltip` (opens on hover, focus and tap) | a hand-rolled `role="tooltip"`, or a help icon hidden below a breakpoint |
| Clickable table row | `useLongPress({ onClick })` spread on the `<tr>` | a button around the name |
| Category colour and icon | `CategoryGlyph`, `CategoryPill`, `buildCategoryIconMap` / `buildCategoryColorMap` | reading `category.icon` or interpolating it into text |
| Brand favicon | `InstitutionLogo` / `PayeeLogo` over `BrandLogo` | a third-party favicon URL |
| Row density | `useDensityPreference(view)` and `DensityToggle` | a local density `useState` or a second store |
| The account default behind a browser-local view setting | `useViewDefault(key)`, applied after the browser's own choice | reading `preferences.viewDefaults` directly, or a store that cannot tell "never chosen" from the built-in value |
| Hiding a table column | `useHiddenColumns(table)` in the list (the row takes `hidden` as a prop) and `ColumnChooserMenu` in the toolbar; the cell wrapped in `isVisible('<id>') &&` | a visibility class, a local state, or a second read in the row |
| Scheduled occurrence amount, date, account | `nextOccurrenceEffectiveAmount`, `nextOccurrenceDueDate`, `occurrenceSettlementAccountId` (`lib/scheduled-effective-amount.ts`) | `nextOverride?.amount ?? amount`, `nextDueDate`, `st.accountId` |
| Reporting currency fallback | `preferredCurrency` (`lib/default-currency.ts`) | `pref?.defaultCurrency \|\| 'USD'` |
| A portfolio chart's window and opening point | `usePortfolioRangeWindow` (`start` for the series, `periodStart` for the period) and `openingSessionDate` for the first label | `resolveRangePreset`, a lookback of your own, a first point dated by a day the market was shut |
| An investment row's money | the row's own `amountCurrencyCode` / `priceCurrencyCode` / `commissionCurrencyCode`, converted with `convertRowAmount`; a VOID row dropped with `investmentRowHasEffect` | the account's currency, the reader's, or a client-side sum across rows |
| CSV | `exportToCsv` / `exportCsvSections` (`lib/csv-export.ts`) | a second `text/csv` Blob |
| Link to the user documentation (`PageHeader` `helpUrl`, an inline guide link) | `docsUrl(key)` (`lib/docs-links.ts`) | a docs or wiki URL literal |
| Random id | `crypto.randomUUID()` | `Math.random()` |
| Chart colour | `chartColors` tokens (`lib/chart-colors.ts`) | a hex literal in a `fill`, `stroke` or `stopColor` |
| Widget title that opens the fuller view | `titleHref` on `WidgetCard`, `href` on `WidgetHeading` | a button or link hand-rolled around the heading |
| Month grid | `MonthGrid` + `monthGridDays` (`lib/calendar-month.ts`); occurrence placement stays `buildScheduledCalendarDays` + `ScheduledCalendarGrid` until the bills grid migrates | a third month grid, or a `Date` built from a calendar date |
| Table / Calendar choice for a screen | `useViewMode(surface)` (`store/viewModeStore.ts`) and `ViewModeToggle` | a local `useState`, a second store or a URL parameter |
| Segmented control (a pill of buttons, one pressed) | `SEGMENTED_GROUP_CLASS` + `segmentClass` (`components/ui/segmented-control.ts`) | a local `BUTTON_BASE`/`BUTTON_ACTIVE` trio, or the pressed classes inlined |
| Switcher in a dashboard widget header | `WidgetSegmentedControl` (`components/dashboard/`), an `icon` option where two must share the line | a toolbar pill beside it, or a wrapping second row |
| A dashboard widget's breakdown of the ledger | the report's own endpoint through `builtInReportsApi` | summing transactions in the widget |
| Report refresh / export buttons | `ReportToolbarActions`, last child of the toolbar row | rendering `ExportDropdown` or `RefreshPricesButton` in a report |
| A dashboard card filling its grid row | the grid's own `stretch` plus the card's min-height | `h-full` on a widget's outermost element |
| Toolbar row on a phone | `flex-wrap`, `w-full sm:w-auto`, `sm:ml-auto`, a button's height from `items-stretch` + `LabelSpacer` | an unwrapped row, a bare `ml-auto`, a hand-matched padding |
| A control alone on its phone line (list filter, lone button) | `w-full sm:w-auto`; a list toolbar's filter is `SEGMENTED_TOOLBAR_GROUP_CLASS` + `toolbarSegmentClass` | a pill or button keeping its desktop width on its own line |
| A register's running balance | `walkRunningBalances` (`lib/running-balance.ts`) over the response's `startingBalance` | a second walk in a component, or a balance drawn under a sort other than date |
| A picker that applies tags to a transaction | `useTagPickerOptions` (`hooks/useTagPickerOptions.ts`), recent-first | a local A-Z sort of `tags`, or the usage fetch inside the form's `Promise.all` |
| Category filter pseudo-ids (`uncategorized`, `transfer`, `income`, `expense`) | `SPECIAL_CATEGORY_FILTER_IDS`, `canonicalizeCategoryFilter`, `useCategoryFilterLabels` (`lib/categoryUtils.ts`) | a literal pseudo-id check, or a type sent as its enumerated ids |

**A write that moves money calls `invalidateBalanceCaches()`** (or `clearAllCache()` where the write can touch anything). `src/lib/balance-cache.guard.test.ts` scans for the omission.

**So does a write that recategorises rows or changes a valuation input** (a price, a security, a rate), and a cached read goes through `dedupe`, never `getCached`/`setCache` (`docs/frontend/api-and-cache.md`).

**Asynchronous data belongs to the request that produced it.** Keep the payload with its request key, adopt a mutation's response only when its origin still matches the current selection, and never render a failed lookup as an empty result (`accounts = []`, `interest = []`, a total of zero). `docs/frontend/api-and-cache.md` has the rule and the regression matrix.

**An unknown value is `null` and renders as unknown; a known zero renders as a number.** Never `?? 0`, `|| 0` or `?? 1` on an API value, never `connectNulls` by default, and never `> 0` or truthiness where `0` is a legitimate value. Decide which of the two states a branch is in before writing it.

**A change to what a user sees or does updates its page in `website/docs/*.md`** in the same PR, regenerates the screenshots of the screens it changed (`npm run docs:screenshots` in `e2e/`), then `npm run docs:build`; `website/README.md` has the conventions.

**Every user-facing string is translated.** `useTranslations('namespace')`; catalogs in `src/i18n/messages/{locale}/{namespace}.json`, new namespaces registered in `src/i18n/messages.ts`. Develop English-first and run `npm run i18n:pseudo`; translate every other locale as the final commit on the PR (`src/i18n/messages.parity.test.ts`). Compose punctuation in the catalog, not in JSX, and never write `--` in copy. Full flow: `src/i18n/messages/README.md`.

**A form round-trips the row it opened.** Each field loads from the leg it represents (a transfer's Transfer Amount from its FROM leg) and at its stored four decimals, an unedited save sends back what was loaded, and an edit offers only modes with a route that saves the row itself: switching family on an existing row calls `convertToTransfer` / `convertToTransaction`, never `createTransfer`; `docs/frontend/forms-and-formatting.md`, "Form Patterns".

**Currency precision applies to the calculator too.** Pass the currency's `decimalPlaces` through `CurrencyInput`; shared expenses use `SharedMoneyInput` and disclose server conversion snapshots through `SharedEntryConversion` (`docs/frontend/forms-and-formatting.md`).

**Shared expenses stay group-only and reuse the standard controls**; staged files save with the entry (`docs/specs/shared-expenses-ui-polish.md`, `docs/specs/shared-expenses-ui-consistency.md`).

**Components:** interactive components are `'use client'`; server components are the default for pages and layouts. No `setState` in `useEffect` (`react-hooks/set-state-in-effect`); reset child state from a prop with the "info from previous render" pattern. Nothing interactive goes inside a `<button>` or an `<a>`. Focus rings are `focus-visible:`; transitions carry `motion-reduce:transition-none`.

**Tests** import `render` and `renderHook` from `@/test/render`, never from `@testing-library/react`; wrap a render or interaction that fetches in `await act(async () => ...)`; spread `numberFormatMockDefaults()` into any `useNumberFormat` mock; mock a module you only partly want with `importOriginal`. An act() warning or a missing message fails the test.

## Read when the work touches it

| Work | Read |
|---|---|
| API calls, caching, asynchronous state, ownership of joint accounts | `docs/frontend/api-and-cache.md` |
| Cards, dialogs, pickers, switchers, rows, links, attachments, tours, settings screens, report toolbars | `docs/frontend/ui-conventions.md` |
| A new page, dialog or toolbar: the reference screen to copy, dialog chrome, list and detail page layout, labels | `docs/frontend/screens-and-dialogs.md` |
| Inputs, number and date formatting, phone numbers, text caps, CSV, form modals | `docs/frontend/forms-and-formatting.md` |
| Tables, registers, density, pagination, phones | `docs/frontend/tables-and-registers.md` |
| Money figures: scheduled occurrences, loans, portfolio ranges, chart reductions, unknown values | `docs/frontend/financial-figures.md`, then `docs/financial-semantics.md`, `docs/time-series-contract.md`, `docs/system-invariants.md` |
| Push, service worker, Web Share Target | `docs/frontend/pwa-push-share.md` |
| Tests, mocks, harness | `docs/frontend/testing.md` and `docs/testing-contract.md` |
| Theme, palettes, chart colours | `docs/frontend/theming.md` |

Do not invent or duplicate financial semantics in a component. Where a figure is derived, the derivation lives once in `lib/` and every surface reads it; `docs/frontend/financial-figures.md` names the helper for each one.

## Security Notes

- **Zod** runs with `jitless: true` (`zodConfig.ts`) for CSP compliance -- no `new Function()`; ESLint `no-new-func: error`.
- **Auth tokens** live in httpOnly cookies managed by the backend, never in JS-accessible storage.
- **localStorage is readable by any XSS.** A store that persists there is listed in `src/store/persisted-storage.guard.test.ts` with the reason its contents may sit in storage, and the pre-login footprint is pinned there byte for byte.
- **CSP:** per-request nonce generated in `src/proxy.ts`, `strict-dynamic` for `script-src`.

## Before you finish

Run the focused test for what you changed while developing, then:

1. `npm run lint && npm run type-check && npm run i18n:check`
2. `npm run test:cov` (CI runs the coverage thresholds, not a bare `npm run test`)
3. `npm run build` (bundle size is checked on every PR)
4. `node scripts/check-env-docs.mjs` from the repository root when a `process.env` read was added

Deleting or renaming a control an E2E spec drives means grepping `e2e/` for its accessible name in the same commit -- `npm run test` never loads that suite.

Shared expense review stays on its explicit page; activity uses Notifications, as specified in `docs/frontend/screens-and-dialogs.md`.
