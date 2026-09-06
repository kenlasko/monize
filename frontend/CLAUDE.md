# Frontend Directory

Next.js App Router application. All commands run from this directory.

Two cross-layer contracts in `docs/` bind this layer, and both have been violated here before. [`docs/system-invariants.md`](../docs/system-invariants.md) indexes them and records whether the code currently upholds each:

- [`docs/financial-semantics.md`](../docs/financial-semantics.md) -- a figure the server could not compute must not be rendered as a measured one, splits are validated at the storage precision (4dp, not cents), and a stored override price is never replaced by a fresh quote as a side effect of opening a dialog (INV-OCCURRENCE-002).
- [`docs/verification-contract.md`](../docs/verification-contract.md) -- where a mistake is mechanical, the durable guard is a source scan rather than a test of one component. `src/test/ui-conventions.test.ts` is the pattern; INV-CACHE-001 is owed one, because `invalidateBalanceCaches` drops two cache prefixes and `budgets:` is not among them.

## Commands

```bash
npm run dev                # Dev server (port 3000)
npm run build              # Production build (standalone output for Docker)
npm run lint               # ESLint
npm run type-check         # tsc --noEmit
npm run test               # Vitest (single run)
npm run test:watch         # Vitest (watch mode)
npm run test:cov           # Coverage report (91% lines, 90% stmts, 87% funcs, 85% branches)
npm run i18n:pseudo        # Regenerate the xx pseudo-locale from en
npm run i18n:check         # Verify the pseudo-locale is up to date (CI gate)
```

## Layout

`src/` contains `app/` (App Router routes), `components/` (feature-organized React components plus shared `ui/`), `contexts/`, `hooks/`, `lib/` (axios API clients and utilities), `store/` (Zustand: `authStore`, `preferencesStore`, `demoStore`), `types/`, `test/`, and `proxy.ts`. Use the filesystem or LSP `workspaceSymbol` to discover specific files.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Vitest resolve alias)
- **TypeScript:** ES2017 target, strict mode, bundler module resolution, React JSX
- **Vitest:** jsdom environment, 30s timeout, V8 coverage provider; thresholds 91% lines, 90% statements, 87% functions, 85% branches
- **Tailwind CSS v4:** Via `@tailwindcss/postcss` in `postcss.config.js`, `@import "tailwindcss"` in `globals.css`
- **Next.js:** Standalone output (Docker), strict mode, security headers in `next.config.js`

## API Layer (`src/lib/`)

**Central client** (`api.ts`): Axios instance with `baseURL: /api/v1`, `withCredentials: true`, 10s timeout.

**Interceptors (non-obvious behavior):**
- **Request:** Reads `csrf_token` cookie, injects `X-CSRF-Token` header
- **Response (403 CSRF):** Transparent refresh via `/auth/csrf-refresh`, retries request
- **Response (401):** Token refresh via `/auth/refresh`, queues concurrent requests during refresh
- **Fallback:** On refresh failure, logs out and redirects to `/login`

Feature API modules (one per feature, typed axios wrappers) live alongside `api.ts`.

### A paged endpoint is never asked for more rows than it accepts

`API_MAX_PAGE_LIMIT` (`lib/api-page-limits.ts`) is the ceiling both paged list endpoints enforce, and neither clamps: `GET /transactions` and `GET /investment-transactions` answer **400** to a larger `limit`. These calls sit behind `.catch()`es that degrade to an empty list, so the rejection reaches the user as a figure that is quietly zero (`limit: 500` on the recurring-charges panel is issue #1229; the same literal reported every year's dividends as $0.00).

Lowering the literal to the cap is **not** the fix -- that trades a visible zero for a plausible undercount. Either walk the pages (`transactionsApi.getAllPages`, `investmentsApi.getAllTransactionPages`, both defaulting their page size to the constant) or narrow the query server-side until one page is genuinely enough. Prefer narrowing to walking: a page walk that pulls a year of rows to distil a handful of ids is a side panel paying for a report.

`src/test/api-page-limits.test.ts` scans for call sites above the cap and checks the constant against **both** backend sources. Its known-violation register tracks defects with the change that fixes them, and fails once a violation is gone, so a stale entry cannot outlive its fix.

### A filter the server can apply is not a list the client enumerates

`transactionsApi.getRecurringCharges` takes an `accountId`; it used to take only `payeeIds`, so the panel sent back a payee-id list whose size grew with the account (~250 payees exceeded proxy request-line limits; ~430 exceeded Node's header budget) and the failure arrived as "no recurring charges". The tell is a client that fetches rows **only to extract ids from them** -- that is an account-shaped question asked in the shape of an id list. Send the narrow thing the server can filter on; an array parameter is for a bounded set the caller genuinely holds.

Two obligations come with moving a filter server-side: the endpoint must **authorize** what it now accepts (an `accountId` is a new door, so it goes through the same own/joint resolution the register uses, `resolveOwnContextJointScope`, and a joint account's detection runs as its owner), and the *meaning* usually sharpens (detection scoped to an account measures cadence from that account's own rows). Say which you intended, and test it.

### A write that moves money calls `invalidateBalanceCaches()`

`accountsApi.getAll`, `investmentsApi.getPortfolioSummary` and the budget progress views are cached in `apiCache.ts`, and the backend computes all three live from transaction rows -- a write that does not drop those entries leaves stale figures that even navigation cannot fix (the refetch on mount is served from the same cache). Call `invalidateBalanceCaches()` after any write that adds, removes, re-dates, re-prices or voids a transaction. "Goes through `transactionsApi`" is not the test: posting a scheduled transaction, editing splits (a split can carry a `transferAccountId`), an investment trade hitting its INVESTMENT_CASH account, and QIF/OFX/CSV/MNY imports all write transaction rows from their own modules. `src/lib/balance-cache.guard.test.ts` scans for the omission.

**The prefix list inside the helper is the other half of the rule.** It covers `accounts:`, `investments:` and `budgets:` -- three views of the same rows. Adding a cached family that reads transaction rows means adding its prefix in `invalidateBalanceCaches` in the same change; `apiCache.test.ts` pins the set. Pinning alone is not enough (that is what was green while `budgets:` was missing), so `cache-prefix-classification.guard.test.ts` scans `src/` for every prefix any cache call uses and requires each to be classified as transaction-derived (dropped) or reference data (kept); a prefix in neither list fails, and so does a listed prefix nothing uses.

Where the write can touch anything -- undo/redo, an AI assistant action, a backup restore -- use `clearAllCache()`; no prefix is narrow enough. This matters most for `notifyUndoRedo`/`notifyAiAction`: a refetch served from a stale cache makes the whole signal a no-op.

## Proxy (`src/proxy.ts`)

This is Next.js middleware (NOT the deprecated middleware pattern from this project's conventions). It handles:

- **API routing:** `/api/*` proxied to `INTERNAL_API_URL` (default `http://localhost:3001`)
- **CSP nonce:** Per-request nonce generated in `x-nonce` header, used by Next.js for inline scripts
- **Auth redirects:** Unauthenticated requests to protected routes redirect to `/login`
- **Security headers:** CSP with `strict-dynamic`, nonce-based script-src
- **Public paths:** `/login`, `/register`, `/auth/callback`, `/forgot-password`, `/reset-password` (no auth required)
- **MCP traffic at the bare origin:** a request to `/` carrying `Authorization: Bearer`, `Mcp-Method`, `Mcp-Name`, `Mcp-Session-Id`, `MCP-Protocol-Version` or an event-stream `Accept` is forwarded to the backend's MCP endpoint. **The app shell must never answer an MCP request**: a bearer-only probe used to fall through to it and be answered 307 to `/login` then 200, which a security scan reads as the server accepting an invalid token, while `/api/v1/mcp` had been refusing it with a 401 all along. None of those signals is something a page load sends -- this app authenticates with cookies and never sends an `Authorization` header.

## Component Patterns

- All interactive components use `'use client'`. Server components are the default for pages/layouts.
- Use dynamic imports for heavy components: `dynamic(() => import('./Chart'), { ssr: false })`.
- `ProtectedRoute` (`components/auth/ProtectedRoute.tsx`) wraps authenticated pages.
- **No `setState` in `useEffect`** — ESLint rule `react-hooks/set-state-in-effect` is enforced. To reset child state when a prop changes, use the "info from previous render" pattern (track the prop in `useState` and update during render).
- **Dialogs use `Modal`** (`components/ui/Modal.tsx`) — handles Escape, focus trap, body scroll lock, focus restore, and stacked-modal popstate. Opt into `pushHistory` so the browser back button also closes. `ConfirmDialog` forwards `pushHistory` for stacked confirm flows.

## Reusing existing UI patterns

Each of these exists once. Use it; do not hand-roll a second one. Every rule here was added after an agent wrote the generic version and a human had to point it out.

### A panel card is `Card` / `CARD_CLASS`, never an inline class trio

`components/ui/Card.tsx` is the one card surface -- background, radius, shadow, and the border that keeps a card legible on themes where the weakest shadow disappears. Use the `Card` component where a plain wrapper works (`padding="md"` matches the widget shell) and `CARD_CLASS` where the element already exists. The old inline `bg-white dark:bg-gray-800 rounded-lg shadow` trio survives in a recorded, shrink-only baseline in `ui-conventions.test.ts`; converting a file means deleting its baseline line. Everything stays on the gray ramp so the colour themes re-skin it -- never add a literal hex or an off-ramp hue to a card.

**Do not drop the border to make surfaces match.** Card-versus-page luminance is ~1.0 in `default` light, `midnight` and `highcontrast` (page and card both pure white there), so the border is the only thing that defines a card at all in those themes -- removing it makes panels disappear, and the change looks safe from every theme except the three it breaks.

### A category's colour and icon are inherited, and drawn by `CategoryGlyph`

Both are resolved server-side in one walk up the ancestry: read `category.effectiveIcon ?? category.icon`, never the raw column (null for most leaves). `components/categories/CategoryGlyph.tsx` draws the result: icon when there is one, colour dot otherwise, dimmed when inherited. Never interpolate `category.icon` into text -- it is a name like `shopping-cart`, so `{category.icon} {name}` renders the icon's *name*. A surface holding a *joined* category row (a transaction, a payee's default category) has no inherited value, so it reads `buildCategoryIconMap` / `buildCategoryColorMap` (`lib/categoryUtils.ts`) built from the full category list, as the register does.

### A brand favicon is `BrandLogo`, addressed by its entity's wrapper

`components/ui/BrandLogo.tsx` renders a cached favicon with the neutral badge fallback, and owns the one rule that matters: the bytes always come from our own backend, never a third party, so drawing a logo cannot leak which institutions or payees a user has. `InstitutionLogo` and `PayeeLogo` are thin wrappers naming the `/:id/logo` route, gated on `hasLogo` so icon-less rows issue no requests. A 404 lands on `onError` and shows the same badge. A third entity gets a wrapper, not a second component.

**Hiding a logo responsively is spelled `max-sm:hidden`, never a bare `hidden`.** Tailwind emits `.hidden` *first* among the display utilities, so on the fallback badge -- whose own classes include `inline-flex` -- a caller's `hidden sm:inline-flex` never hides anything: the letter circles stayed visible on mobile while the favicons vanished. A `max-*` variant sorts after every base utility and wins below its breakpoint. The brand-logo guard in `ui-conventions.test.ts` fails on a bare `hidden` token in any logo call site's `className`.

### A status pill is `Badge`; table chrome is `Table.tsx`

`components/ui/Badge.tsx` is the small status pill (previously hand-rolled ~50 times). Pass `variant` and `size`; pass `as="button"` where the pill is also a control, rather than nesting a button in a span. It deliberately does not absorb pills whose colour *means* something -- `CategoryPill`, `AccountTypePill` and `SCHEDULED_KIND_CHIP_CLASSES` are each already one source of truth, exempted by name.

`components/ui/Table.tsx` is constants (`TABLE_CLASS`, `TH_CLASS`, `TD_CLASS`) plus thin `Th`/`Td` cells, not a `<Table>` wrapper -- these tables are hand-laid with colspans and sticky cells. `SortableHeader` deliberately stays off `TH_CLASS` (about twenty-five report tables draw a lighter header, and folding it in would restyle every report).

### The card shadow is `--shadow-card`; the bare `shadow` reads no token

Tailwind v4 trap: the bare `shadow` utility is a legacy alias with the stock value compiled in, so redefining `--shadow-sm` in `@theme` touches `shadow-sm` (worn by form fields) and leaves cards flat. `ui-conventions.test.ts` fails on a `--shadow-sm` redefinition. Card elevation goes through `--shadow-card`, worn by `CARD_CLASS`.

### A focus ring is `focus-visible:`, and a hover animates

`focus:ring-*` paints on a mouse click as well as a Tab; use `focus-visible:` on anything clickable. Text inputs are the one exception (`inputBaseClasses` and the element selectors in `globals.css`). Row hover comes from `HOVER_ROW_ON_CARD` / `HOVER_ROW_ON_PAGE` in `Card.tsx`, not a hand-picked grey, and includes the transition (a hover that snaps reads as a redraw). Pair any new transition with `motion-reduce:transition-none`. Both rules carry shrink-only baselines in `ui-conventions.test.ts`.

### A dialog is titled through `Modal`, never by a hand-rolled heading

`Modal` takes `title` (and optional `description`, `footer`, `padding`), draws the standard header and wires `aria-labelledby` -- before it, none of the 74 hand-rolled headings reached the dialog, so every dialog announced itself as an unnamed region. `padding` defaults to `none` and leaves children unwrapped, because several call sites make the panel their own scroll or flex parent. A genuinely bespoke header (ConfirmDialog's icon) stays on the baseline deliberately.

### An empty list renders `EmptyState`

`components/ui/EmptyState.tsx` (glyph, title, optional description and action). `ui-conventions.test.ts` bans the `text-center py-12` container fingerprint outside the component, with no grandfathered baseline.

### An auth screen renders inside `AuthShell`

`components/auth/AuthShell.tsx` is the single shell for login, register, forgot/reset/change-password, verify-email and setup-2fa: transparent brand mark, title/subtitle, notices slot, shared `Card` around the body (`plain` for a bare status line). Language picker and version line are opt-in props. Use `/icons/monize-logo-transparent.svg` everywhere in the UI -- the boxed `monize-logo.svg` bakes in a white background and renders as a white square in dark mode. Guarded in `ui-conventions.test.ts`.

### Navigation links and their icons live in `lib/nav-links.ts`

The header's link arrays and the per-route Heroicon map are declared side by side so `nav-links.test.ts` can hold "every nav route has an icon". The mobile drawer and header dropdowns render `NAV_ICONS[href]`; the desktop top-bar pills stay text-only on purpose (six leading icons overflow 1280-1440px laptops). A new route means one entry in the array and one in the map, in the same file.

### Account-type colour and icon come from `lib/account-type-meta.tsx`

`ACCOUNT_TYPE_META` maps each account type to its pill classes and Heroicon; render `AccountTypePill` / `AccountTypeIcon` rather than re-deriving either. `ui-conventions.test.ts` fails on a second type-to-pill-class mapping. An account with no institution shows its type icon in the brand-badge slot (`InstitutionLogo`'s `fallbackIcon`), not a generic glyph.

### Which account types have a detail page is `lib/account-detail-views.ts`

`ACCOUNT_DETAIL_VIEWS` maps an account type to the view `/accounts/<id>` renders for it, and everything else about "does this account have a Details page" derives from that one registry: `resolveAccountDetailView` (the route), `hasAccountDetailView` (the row action, the tour requirement), `DETAIL_ACCOUNT_TYPES` (the key set). Three surfaces ask the question, so three copies of the list is how they come to disagree -- the account row and the route registry already held one each. `loan-rate-changes.contract.test.ts` checks the `loan` arm against `RATE_CHANGE_ACCOUNT_TYPES` and against the branch the account page actually fetches rate history in.

### A tour step pinned to a dynamic route is reachable only by the user

`routeMatch: '/accounts/'` names an id the tour never knew, so the engine cannot navigate there: pushing the step's `route` can never satisfy the prefix, and the step sits in its `navigating` phase behind an overlay that renders nothing -- the tour disappearing mid-run. `isStepReachable` (`lib/tours/navigation.ts`) is the one test, and both doors use it: Back walks past such a step once the user has left that route, and `TourHost` skips it rather than hanging when the user arrives any other way (they skipped the step that asks them to open the page). The step's own `route` satisfying the prefix is the ordinary case and stays navigable ('/reports?category=insights' for '/reports').

A step gated by `requires` is the omit effect's to remove: the engine neither navigates to it nor skips it as unreachable while its requirement is unmet or still resolving, or the two race and a deliberate omission is reported as a degraded tour.

### A coach mark parks in the corner the step is not about

An `unobtrusive` anchorless step parks its card in the bottom-**right** corner, which is exactly where every list puts its row actions (`RowActions` is `justify-end`, in a sticky-right cell). A step that asks the user to click one therefore had its own card intercepting that click -- CI caught the account-detail step's card over the **Details** button at a 720px-tall viewport, and the shipped 1.13 foreign-currency tour had the same collision. Such a step sets `placement: 'left'` (the only meaning `placement` has for a corner-parked card). The card is also draggable, but a tour whose first move is "get my card out of the way" is not one to ship: park it clear. `tours.spec.ts` clicks the real row action, so the collision fails the E2E rather than the user.

### A register's category chip is `CategoryPill`

`components/transactions/CategoryPill.tsx` owns the colour-mix pill and the category's optional icon (via `getIconComponent`, as tag chips do). Categories carry `icon` end-to-end -- `CategoryForm` collects it through the shared `IconPicker` (whose `onClear`/`clearLabel` props make "no icon" a real state) -- so a surface showing a category name with its colour shows its icon too, and an unset icon renders nothing, never a default glyph.

### A dashboard widget header carries its icon from `widget-meta.tsx`

`WIDGET_ICONS` gives every registered widget a distinct Heroicon (`widget-meta.test.tsx` enforces coverage), rendered as the tinted `WidgetIconPuck` -- blue ramp only, so themes re-tint it. Widgets on `WidgetCard` get it from their `widgetId`; a widget drawing its own header uses `WidgetHeading`, which also owns the title-button markup.

### The device can override a stored preference, and the predicate is never the viewport

Two settings mean "unless this device knows better". `DateInput` is a text box on
desktop *regardless of the format preference*, because the pointer decides the
mode (touch keeps the native picker). `mapsUrl` (`lib/contact-links.ts`) ignores
the stored `defaultMapProvider` on iOS and Android, because a device with its own
map app should open it -- the preference describes what a desktop browser does.

Both checks live in the one function that produces the result, never at a call
site: a second caller that skipped it would be a rule nobody enforces. And both
ask about the *platform* (`detectMapPlatform`, `pointer: coarse`), never
`useIsMobile` -- that is a 639px viewport query, so a narrow desktop window would
flip the behaviour mid-session.

### Date entry -- `DateInput`, never a raw `<input type="date">`

`components/ui/DateInput.tsx` is the only place a raw date input is allowed; `ui-conventions.test.ts` fails the build if another appears. It carries lenient parsing of typed text, keyboard shortcuts, and `CalendarPopover`. Key behaviors:

- **On desktop it is a text box regardless of format preference** -- the pointer decides the mode, not the format (touch keeps the native picker). The native control's segment-jumping entry is issue #1201.
- **`browser` is not a pattern, and nothing below `useDateFormat` should see it.** `datePattern` off that hook is the concrete arrangement, resolved by `resolveDateFormatPattern` (`lib/date-parse.ts`). `parseFlexibleDate` takes the pattern (7/8 is ambiguous without it); `parseDateFromFormat` stays strict for canonical values.
- **A partial entry is completed, and an unreadable one changes nothing.** Day+month take the year from the field's current date (today when empty); a lone number is a day in the month on screen; unparseable text restores what was there -- clearing the box is the only way to mean "no date". None of this happens on the keystroke: the lenient reading waits for blur or Enter.
- **`setValue()` moves the form, not the box.** Registered with `register('date')`, `DateInput` is uncontrolled: it renders its own `displayValue`/`isoValue` state and only reads the DOM once on mount, so a react-hook-form `setValue` on that field changes what gets *submitted* while the date on screen stays put -- the two silently disagree. To move a date the user can see, pass `value` (the sync effect runs only when `externalValue !== undefined`) or drive it through `onDateChange`. A test asserting the visible input's value cannot see the difference; assert the submitted payload.
- **A screen hosting a date field does not answer a load with a second tree.** `if (isLoading) return <Skeleton/>` unmounts the field being typed into; render load/error states *inside* the one tree. Duplicating the controls block into the second `return` is not a fix (different child indexes still reconcile wrong -- `CashFlowReport` did this). `ui-conventions.test.ts` fails both shapes for any component pairing a date control with a `useReportData` loading flag; a one-shot prerequisite load (the report *forms*' `isLoadingData`) is deliberately not policed.

### Currency entry -- `CurrencyInput`, never a raw number input

`components/ui/CurrencyInput.tsx` is the only way to take a money amount: a `type="text"` field with `inputMode="decimal"` that filters as you type, formats with separators on blur, clears a `0.00` on focus, parses through `parseLocaleNumber` and rounds the result to cents (`roundToCents`, so the stored value never carries sub-cent precision the 2dp display hides), re-syncs on external value changes, and accepts inline calculator expressions (`100*1.13` + Enter/blur) plus a calculator modal. Props: `prefix`, `allowNegative` (default true), `allowCalculator` (default true), `allowSignToggle`. For non-money numbers (share counts, rates, percentages, day-of-month) use `NumericInput`: same filtering, with `decimalPlaces`, `suffix`, `min`/`max`, `allowNegative` defaulting false, no calculator.

`ui-conventions.test.ts` fails the build on any `<input type="number">` or `<Input type="number">` -- resolving the tag each `type="number"` belongs to, because recharts' `<XAxis type="number">` is not an input and is left alone.

**Both components read and write in the user's number locale, and that is the only place a number is parsed from typed text.** A comma-decimal user (pl, de, fr, ...) types and pastes "1200,99", not "1200.99", and the field must round-trip it -- the two fields resolve the decimal/grouping separators from `useNumberFormat().numberSeparators` and go through `lib/number-parse.ts` (`parseLocaleNumber`, `filterNumberTyping`, `formatNumberForEdit`, `normalizeExpression`). Never hand-roll a `replace(/[^0-9.-]/g, '')` filter or a `parseFloat` on raw input text -- that is the dot-only assumption these helpers exist to remove, and it silently drops a comma decimal (turning 1200,99 into 120099); `src/lib/number-parse.guard.test.ts` scans `src/` for that filter fingerprint and fails on a new one outside the legacy `format.ts` helpers. For well-formed en-US input the result is unchanged, and `formatAmountWithCommas` stays the display seam `CurrencyInput` delegates to for the plain en locales; the shared `number-parse` helpers default to en-US separators so a partial mock or an older build never crashes.

**A single `.`/`,` separator is grouping only when its digit runs are valid thousands groups (1-3 digits, then exactly 3 per group); otherwise it is the decimal point.** This is symmetric and is what makes the DOT-GROUP locales (de/es/it/nl/pt-BR/tr) safe: `parseLocaleNumber` reads a typed or pasted `1200.99` / `5.5` as a decimal there, not as `120099` / `55` (the old "a `.` matching the locale group is always grouping" rule was a ~100x/10x silent money error), while `1.234` still reads as `1234`. `filterNumberTyping` therefore does **not** strip a `.`/`,` group separator while typing -- doing so destroyed the dot-decimal before `parseLocaleNumber` could disambiguate it -- and the read-only display of a plain amount goes through `useLocalizedAmount()` (the one bound `formatAmountLocalized` closure), never a hand-copied `seps ?? default` wrapper.

**An editable field works in the locale's Latin-digit form, and every entry point normalizes what the user pastes.** `Intl` renders `ar-EG` as `١٬٢٠٠٫٩٩` (Arabic-Indic digits, U+066B/U+066C separators), and the "Browser" number-format setting reaches such a locale through `getEffectiveLocale` returning `undefined`, so an ASCII-only filter turned an edit of that text into the one digit just typed and the calculator into `1200995`. `getNumberSeparators` therefore returns the `numberingSystem: 'latn'` separators (plus `nativeDecimal`/`nativeGroup` where they differ), `CurrencyInput.formatDisplay` passes `{ latnDigits: true }` so the field shows `1,200.99`, and `parseLocaleNumber` / `filterNumberTyping` / `normalizeExpression` / `stripGroupSeparator` all start with `normalizeNumeralText` (any Unicode `Nd` digit to ASCII, native symbols to latn, bidi marks dropped, U+2212 to `-`). Read-only surfaces stay native like `formatCurrency`; the round-trip test in `lib/number-parse.test.ts` holds "what the pipeline formats, it parses back" for en/pl/de/hi/ar-EG/fa-IR, negatives included.

Both components take a *number* (`value: number | undefined`, `onChange: (value: number | undefined) => void`):

- **`register()` does not fit.** Wrap in react-hook-form's `Controller` and pass `value`/`onChange`/`onBlur`/`ref` (plus `name={field.name}`, or `name`-based test selectors stop matching). Where the schema stores a string, bridge inside the render callback.
- **`min` clamps while typing; `max` only on blur.** Every prefix of a number is smaller than the number, so a ceiling must not fire mid-word -- and `min` is wrong for a multi-digit floor (`min={2}` eats the `1` of `14`): leave it off and let Zod report. Where an out-of-range value must be *discarded* rather than trimmed, keep the explicit range check in the component's `onChange` (`MortgageFields`, `BudgetWizardStrategy`).
- Give each field an explicit `id` when two on one screen share a label -- both components derive `id` from the label text, so a repeated "Years"/"Months" pair collides.

**A field that hands back its own value has not been edited.** Both components re-parse the on-screen text on blur, and for an untouched field that text *is* the parent's value formatted -- reporting it is destructive to parents that do more than store it (the FX panels derived a rate from the cents-rounded total and marked it user-overridden). Both notify only when the value actually moved (`notifyIfChanged`), and both carry a blurred-untouched regression test. The general rule: **an `onChange` that does more than store the number must also be idempotent** -- guard the side effect on the value having changed at the handler too (`handleConvertedTotalChange` returns early when the incoming total equals the derived one).

### A clickable table row -- `useLongPress({ onClick })`

`useLongPress` takes `onClick` alongside `onLongPress`: a plain click runs the row's primary action, a 750ms press (or right-click) opens the mobile action sheet, and a click following a long-press is suppressed. Spread `getRowHandlers(item)` on the `<tr>` and add `cursor-pointer` (accounts, payees, tags, categories, securities lists all do). Do not put the click on a button around the name instead -- the rest of the row becomes dead area. Controls *inside* the row (a favourite star, `RowActions`) must `stopPropagation`.

### A detail page returns to its list above the title, and switches with the caret beside it

Every detail page carries the same two controls: a chevron and "Back to <List>" on the line *above* the title, and `EntitySwitcher`'s caret immediately after the title. The way back is not an action on the thing being viewed, so it does not belong among the buttons on the right. For reports the pair is `BackToReportsLink` and `ReportDetailHeader` (`components/reports/`); `ReportSwitcher` builds the route itself so no call site spells it out. `ui-conventions.test.ts` scans for a hand-rolled back-chevron-to-`/reports`.

**Two switchers on one line means at least one says its name.** `EntitySwitcher` takes `triggerText` (the GEM report's scenario picker reads "Scenario ⌄"); the bare caret stays the default when it is the only one.

**A detail page's actions sit on the title row, not in a row above the body.** `AccountDetailShell` takes `headerActions` for type-specific actions beside the standard set; a signal they need to send the body travels down as a prop (`refreshKey`) rather than keeping the button in the body. A `size="sm"` button in a report toolbar takes `size="md"` in that header.

A switcher list too long to scan takes `group` on its items (`ReportSwitcher` groups in `REPORT_CATEGORIES` order); sections follow the order their first item appears in, so ordering happens in the caller.

### A category picker lists every category in tree order as "Parent: Child"

However a surface selects a category, the option list is one shape: built from `buildCategoryTree` (each parent followed by its children), a child labelled `Parent: Child`, a top-level category by its bare name, and **every row selectable, parents included**. `CategorySwitcher` carries the regression tests.

**A picker the user types into creates through `createCategoryFromInput` (`lib/category-create.ts`), never inline.** It owns title casing and the `Parent: Child` shorthand (create or reuse the parent, then the child), and returns every row it created so the caller can append all of them. The guard in `src/test/ui-conventions.test.ts` fails on a second `categoriesApi.create` call site outside the helper and the Categories page's own full create form.

Whether a picker *offers* to create is a property of the surface, not the field: a form that can create passes the creator to **every** category picker it renders, split lines included (`SplitEditor`'s lines silently discarded unmatched text while the Category field offered "+ Create" -- issue #1187). An asynchronous create addresses the row it came from **by id** (rows can move while the request is in flight), and the new category's `isIncome` comes from what the creator returned.

### A number a person reads is formatted by `useNumberFormat()`, never by `toFixed`, `toLocaleString()` or the raw `@/lib/format` helpers

`useNumberFormat()` is to numbers what `useDateFormat()` is to dates: the one seam
where the user's `numberFormat` preference decides separators, grouping, decimal
mark and currency placement. `@/lib/format` keeps `formatCurrency` and
`formatShareQuantity` as pure deterministic `en-US` helpers -- fine in a non-React,
non-user-facing context, and exactly wrong in a component, which is how a Polish
reader came to see `zl18,812.71` and `755.8342` on Securities while every other
screen used their own convention (issue #1316).

Three ways in, and the second is the one that looks like a fix and is not:

- **A literal `%` beside a number** -- `` `${x.toFixed(1)}%` `` and the far
  commoner `{percentage}%` -- writes a `.` decimal in every locale and puts the
  `%` where English puts it (fr-FR writes `12,3 %`). Use
  `formatPercent(value, decimals)` where the surface has decided a decimal count,
  `formatPercentTrimmed(value)` where the value arrives already rounded (the
  server rounds `percentUsed` to 2dp, so the same expression must still render
  `80%`, `80.5%` and `80.55%` -- pinning a count would change the figure, which
  is the one thing a localization fix must not do), or `formatSignedPercent`
  where an explicit leading sign is wanted. A CSS length (`width: ${pct}%`) is
  the one legitimate case and stays a plain number: CSS reads no locale.
- **A bare `toLocaleString()`** follows the *browser*, and an explicit
  `numberFormat` exists precisely to override the browser: a reader on `en-US`
  hardware who picked `pl-PL` still gets `12,345`. Swapping a hardcoded `en-US`
  for `toLocaleString()` is not a migration. Use `formatNumber(value, 0)` for a
  count.
- **The raw helpers**, imported into a component because the hook needs a hook.
  A tooltip, a table cell and a recharts `content={<Tooltip/>}` are all React
  components and can call it; a genuinely pure module takes the formatters as an
  argument (`NumberFormatters`, exported from the hook -- `compareMetricRows`,
  `MonteCarloPerformanceSummary` and `HoldingStatsTable` are the worked examples).

**A share count is `formatShareQuantity`, not `formatQuantity`.** Eight decimals,
not four: a residual position of `0.0003` shares is what the holdings column
exists to expose, and the migration must not round it away. It normalizes the
`-0` Intl produces for a residue that rounds to zero, and renders a nullish or
NaN quantity as `0`.

**The ISO code beside a foreign amount is not this rule.** `withCurrencyCode`
appends it deliberately when a security's currency is not the reader's; localize
the number *before* the suffix and leave the suffix alone.

`src/test/number-locale.guard.test.ts` scans for all four fingerprints with a
classified allowlist (a `new Date(...).toLocaleString()` is a date, which
`useDateFormat` governs; `lib/utils.ts`'s `sv-SE` timestamps are machine-shaped).
**Its percentage scan is keyed on the literal `%`, not on `toFixed`** -- written
from the diff it matched only the shapes the migration had just removed and
reported clean over fourteen survivors, because the shape that actually
dominates names no formatter at all. A scan written from a diff sees what was
fixed; write it from the rule.
A component test must not build its expectation with the same helper the
component uses -- `SecurityList.test.tsx` did, so it proved the component agreed
with a hardcoded formatter while the screen disagreed with the user. Set a real
preference row and assert the rendered string, including one case where the
preference deliberately differs from the host locale.

### An account balance is coloured by its sign -- `balanceColor`, never by account type

`balanceColor` (`lib/format.ts`) is the one rule: negative is red, everything else neutral. Do not add `|| isLiability` (or any `accountType` test) -- a credit card at a credit balance is not in the red, and the sign already carries the meaning. `gainLossColor` is the sibling for a *change* in value (green when up), not for a balance.

### A chart over values of both signs keeps the sign beside the magnitude

A pie can only size a slice from `Math.abs`, but the abs is presentation, never the value: carry the signed figure with the datum, print it in the legend and tooltip, colour the two sides from the semantic pair (`CHART_COLOURS_ASSETS` / `CHART_COLOURS_LIABILITIES` in `lib/chart-colours.ts`), and net a mixed group the way the table beside it does. The footer of a mixed chart is the signed net figure under its honest name (Net Worth) -- a sum of absolute values labelled "Total" reports assets plus debt as if both increased financial value (issue #1243). `AccountBalancesReport`'s chart is the worked example.

### A scheduled occurrence's amount is `nextOccurrenceEffectiveAmount`, never `nextOverride?.amount ?? amount`

`ScheduledTransaction.amount` was computed at whatever FX rate was current when it was written, so for a top-level investment schedule (whose `amount` is the *security-currency* cash impact) or a split parent carrying an investment line it is a stale snapshot -- and it is labelled with the brokerage account's `currencyCode`, not the settlement currency the cash lands in. Read `effectiveAmount` / `effectiveAmountComplete` / `effectiveCurrencyCode` through `lib/scheduled-effective-amount.ts` (`scheduleEffectiveAmount`, `overrideEffectiveAmount`, `nextOccurrenceEffectiveAmount`, `sumEffectiveOccurrences`).

`null` means the server could not work the amount out. Render `UnknownAmount` (`components/ui/UnknownAmount.tsx`) -- never the stored figure and never a zero -- and withhold any total containing it, keeping the partial sum under its own name. An **absent** field is an older backend mid rolling deploy, which the helper already reads as unknown for an FX-sensitive schedule and as the stored amount for everything else.

**The date is the other half, and `nextDueDate` is not it.** That column is the recurrence *slot*; an override addressed to the slot can move the occurrence, so filter, sort and print `nextOccurrenceDueDate(st)`. A surface that reads the slot announces a payment on a day the user has already changed -- the same defect as reading the stored amount, applied to the date.

**Which account an occurrence charges is `occurrenceSettlementAccountId`, never `st.accountId`.** A scheduled investment's `accountId` is the *brokerage*; its cash settles in the named funding account or the brokerage's linked cash account. The dashboard's below-zero projection ran on `accountMap.get(item.accountId)`, so a purchase whose funding account covers it to the cent was flagged as overdrawing a balance the trade never moves, and the account that pays was left out of the projection altogether. The server sends `settlementAccountId` on the `findAll` read model -- the same decision `resolveSettlementAccountId` makes for the posting -- and the helper falls back to the funding/linked account when the field is absent (an older backend), answering `undefined` rather than naming the brokerage when neither resolves; a caller projects nothing there. `effectiveCurrencyCode` is that account's currency by construction, which is what makes adding the two sound -- compare them before you add, and treat a mismatch as unknown. A running balance is also rounded at each step (`roundMoney`): 647.67 + 301.70 - 949.37 is exactly zero in `decimal(20,4)` and a shade below it in binary floating point, which is all `< 0` needs to raise the warning. `scheduled-effective-amount.guard.test.ts` fails a `<map>.get(<x>.accountId)` in any file that resolves an occurrence's amount.

**A total over occurrences is converted, never added.** `sumEffectiveOccurrences` (`lib/scheduled-effective-amount.ts`) takes the converter and cannot be called without one; its predecessor accepted an `EffectiveScheduledAmount` accessor and read only the `amount`, so the Upcoming Bills report and the budget panel summed a CAD occurrence beside a USD one and formatted the result in the reader's default currency. Check `isComplete` before displaying the value, and format a *row* with its own `currencyCode` -- `formatCurrency(amount)` with no code labels a CAD figure with whatever the reader's default is. `UnknownAmount`'s `reason` tells the two causes apart: `displayFx` is a missing display rate (fix it on Currencies), `scheduledFx` is the occurrence's own settlement rate.

**A list of occurrences comes from the server, not from a loop here.** `scheduledTransactionsApi.getOccurrences({ through })` returns one row per occurrence with the amount THAT occurrence would post; expanding the recurrence in the browser can produce dates but never per-occurrence amounts, which is how the Upcoming Bills report came to print, total and export one schedule-level figure against every occurrence it drew. `lib/forecast.ts`, the bills calendar and `OccurrenceDatePicker` are the named exemptions, each for a reason the guard records.

`lib/scheduled-effective-amount.guard.test.ts` scans `src/` for the `override.amount ?? …amount` fingerprint, for a client-side recurrence expansion outside those exemptions, and for the report actually calling `getOccurrences` -- import presence is not proof, since the report imported this helper throughout the period it was applying one amount to every occurrence. `PostTransactionDialog` is the one fallback exemption: it seeds the POST form's editable field, which is the write path. Issue #1247, INV-OCCURRENCE-003.

### A scheduled transaction has four kinds, not two -- `scheduledKind`

`amount < 0` / `> 0` answers half the question: a **transfer** between own accounts is neither bill nor deposit, and exactly **zero** is a deliberate placeholder for an amount unknown until it arrives. A sign ternary paints the zero green, and a `!st.isTransfer` filter deleted a scheduled transfer from both calendars (issue #1124).

Classify with `scheduledKind` (`lib/scheduled-kind.ts`) -- `bill | deposit | transfer | reminder` -- and colour from `SCHEDULED_KIND_CHIP_CLASSES` / `SCHEDULED_KIND_AMOUNT_CLASSES`. Where the surface is about one occurrence, classify it with `occurrenceKind(occurrence, schedule)` from the same file rather than composing an amount at the call site: kind is a question about direction, an exchange rate is positive, so the schedule's *sign* still classifies correctly when the occurrence's own magnitude is unknown -- and `Number(null)` would paint an unpriceable bill as a grey reminder. `scheduled-effective-amount.guard.test.ts` scans for the composed `scheduledKind({ amount: x ?? y })` shape.

A surface listing *occurrences* includes every active schedule whatever its kind. Filtering by kind is for a surface genuinely about bills or deposits, and there a `reminder` belongs in neither bucket -- except where the surface is about *what the user still has to pay*, where a zero-amount reminder counts as an upcoming bill contributing nothing (`BudgetUpcomingBills`). A **money total** is a separate decision from the count: a transfer is counted as upcoming but its amount never joins a bills-and-deposits sum (`UpcomingBillsReport`'s `summary.totalOf`), and a reminder's zero is never given a sign or a red/green treatment.

### A stored occurrence price is an instruction; the market close is a suggestion

An investment price *or quantity* the user saved is a decision, not a stale default: live market data may be *offered* beside it but never *written over* it. `OverrideEditorDialog` auto-fills from the latest close only when the occurrence has no price of its own and the user has not typed a total (`hasStoredPrice` false, `userEditedTotal` false, field empty), otherwise exposing an explicit "use latest close" action. `PostTransactionDialog` skips its market-price refresh when the prefill came from a per-occurrence override (`investmentFromStoredOverride`, keyed off a stored price *or* quantity) or when the user has edited any field (`userEditedInvestment`).

Both fills are **total-first** (issue #1148): they preserve the amount invested and re-derive the share count. The two guards differ because the state each fill runs against differs: the override editor blocks only on a typed **total** (the one state where the fill would rescale the quantity), while the post dialog always carries a total and so blocks on **anything** typed. The fetch is asynchronous -- it can resolve after the dialog opens, and a value typed in the meantime is the user's instruction. A NaN or zero close is not a usable price -- normalize to null where `marketPrice` is set (`usableClose`).

`marketPrice == null` is three states at once (loading, failed lookup, genuinely empty history), so it must not gate the "no price history, enter manually" hint. Each surface carries a `priceHistoryEmpty` flag set true *only* when a request completes with no usable close, reset while in flight, left false on rejection.

Three surfaces fill these fields -- the two dialogs and `ScheduledTransactionForm` -- and all three do the price/quantity/total arithmetic through `lib/investmentFold.ts` (`totalFromQuantity` / `quantityFromTotal`: one rounding scale, one signed commission fold). Never hand-roll the fold; `lib/investmentFold.guard.test.ts` scans for the 8dp share-precision rounding that fingerprints a hand-rolled copy. State a stored price's provenance truthfully ("saved on this occurrence" vs "from the schedule" are different keys); format "latest close" copy through `useNumberFormat().formatPrice` (a price is not money: up to six decimals, Intl-trimmed), never a hand-rolled `toFixed`. Compose any "Label: value" line in the catalog as one string a translator can reorder, never `{t('label')}: {value}` fragments.

`ScheduledTransactionForm` adds two invariants because its `Total Value` is a shown figure that submit recomputes: **the displayed total and the persisted amount must never disagree** -- every field that moves the economic total (price, quantity, **commission, and the BUY/SELL action whose sign flips the fee**) recomputes the shown total through the same fold, and an async close arriving mid-entry preserves a typed total and re-derives the quantity. And **a market price belongs to one security**: changing the selected security clears the auto-filled price and the seen-market-price latch. Gate the "Latest:" placeholder on a positive `roundedMarketPrice`, never a bare `marketPrice != null`, so it never renders "Latest: NaN".

### Two transaction lists, two opposite delete contracts -- read the tense

`InvestmentTransactionList`'s `onDelete` **asks the parent to delete** (the list confirms and hands back an id). `TransactionList`'s `onDeleted` **reports a delete it already performed** (it owns the confirmation, the API call and the toast). A handler written for the first shape and wired to the second deleted every cash row twice (issue #1192) -- worse for a transfer, where the list correctly calls `deleteTransfer` and the parent then calls plain `delete`. Reach for `onRefresh` to reload after a delete, and for `onDeleted` only when you need the id itself -- never to perform the delete. `ui-conventions.test.ts` scans every `<TransactionList` for an `onDeleted` handler that deletes.

**The signal has to reach whatever else is derived from those rows.** The panel's own reload is not the page: the account detail view draws the portfolio summary, allocation and Holdings by Account above the register, and a write that only reloaded the register left all three stale (issue #1190). Dropping caches is half of it -- nothing mounted refetches on its own. `InvestmentRegisterPanel` raises `onDataChanged` after every write, and `InvestmentDetailView` re-runs its load from it.

**Every write path on a page shares one refresh, including the ones nobody reported.** A delete is a write, and so is an undo, a redo, an AI action and a status change; a reported create symptom says nothing about which paths are broken. `useInvestmentData.refreshAfterWrite` is that one function for the Investments page (`InvestmentRegisterPanel.afterWrite` is the detail page's). When you fix a stale-figure defect, grep the surface for its other write paths and route them through the same function in the same commit.

**A sibling that fetches for itself needs the signal as a prop, not as a re-render.** `InvestmentValueChart` fetches its own series, so the write reaches it as `refreshKey`. Two details: the intraday series is served from `sessionStorage`, so drop it (`clearAllIntradayCache`) and pass `skipCache`; and the effect must gate on the key it has already **acted on**, not on running -- `loadData` changes identity on every range/account/currency change, and an ungated second effect double-fetches on each.

**Both registers of one account are paged, filtered and drawn the same way.** The bar above the rows is `ListTopToolbar` (`components/ui/ListTopToolbar.tsx`) -- position info left, density toggle and list buttons right -- and both `TransactionList` and `InvestmentTransactionList` compose it; `ui-conventions.test.ts` fails on a second call site handing `Pagination` an `infoRight`.

**A register pages from both ends, and the second one is `ListBottomPager`** (`components/ui/ListBottomPager.tsx`). On a single page it draws the count instead of an inert pager -- the opposite of the top strip, which keeps its pager because "Showing 1-7 of 7" answers "did that filter work?". The top strip is the card's own header row and belongs inside the list component; `Pagination` carries its own background and shadow and must sit *outside* the card. `ui-conventions.test.ts` fails on a raw `<Pagination>` anywhere but the two wrappers and the four standalone list pages, and separately requires each register surface to reference `ListBottomPager`. Nothing repeats the density toggle down there: repeating a position is the point, repeating a control is not.

Filtering follows the same rule: a trade is narrowed by symbol and action (the brokerage list's own filter row), a cash row by payee and category (`CashFilterBar`, shared by the Investments page and the account detail page). Each register's page returns to 1 when its filter changes, and the filters belong in the register's request key. The chrome is part of "the same way": one heading (*Recent Transactions* on both -- the toggle already says which ledger), a new-row button marked the same on both, the same gaps.

**A filter picker offers what the rows use, and it loads because the register is on screen.** `useCashFilterOptions` asks `transactionsApi.getRegisterFilterOptions` for the payees and categories the selected accounts' rows actually reference. The endpoint reads split lines as well as parents (a split parent's own `categoryId` is NULL), and returns the **ancestors** of every used category, because `MultiSelect` builds its top level from `parentId == null` and drops a child whose parent is absent. Trigger the load from the view being displayed, never from the click that reaches it (the view is remembered, so the register is reachable without the click).

`useBrokerageFilterOptions` (`hooks/useBrokerageFilterOptions.ts`) fetches the actions and symbols those accounts have actually used. Absent or empty is "no information", so the action list keeps offering everything; whatever is selected stays in the control even when the rows no longer use it. **Symbols come from the rows, never from current holdings** -- a position sold in full is exactly what somebody filtering by symbol is looking for.

**A one-shot fetch guarded by a ref cannot also be cancelled in its cleanup.** Under StrictMode (on in Next.js) an effect runs, cleans up, and runs again: the first pass claims the `loadedKeyRef`, the cleanup marks the only request cancelled, and the second pass starts nothing -- pickers sit empty all session. Let the ref decide instead: adopt the response while `loadedKeyRef.current === key` (which also drops an answer a newer selection overtook). Testing Library does not double-invoke effects, so only a test rendering the hook inside `<StrictMode>` catches this; both hooks carry one.

**A register that has rows keeps them while the next page loads.** Gate the skeleton on there being nothing to show yet (`loadedKey === null`), not on a request being in flight (the Investments page's `hasLoadedRef` is the same decision) -- swapping a table for a skeleton scrolls the reader to the top.

**A pager stays drawn when a filter narrows the list to one page.** The buttons are inert, but "Showing 1-7 of 7" is the answer to "did that filter work?", read at exactly the moment hiding it would remove it.

**A nav tab is lit by the section a page belongs to, not by an exact path.** `isNavSectionActive` (`lib/nav-section.ts`) is the one predicate, used by the header and the mobile drawer: `/accounts/<id>` is Accounts, `/securities/<id>` is Tools. The boundary is a slash, so `/accounts` never claims `/accounts-archive`.

**A cash register holds rows that are not cash transactions, and one function decides which editor each gets** -- `editCashRow` (`lib/cash-row-edit.ts`). A trade's cash leg (`linkedInvestmentTransactionId`) is edited as the *trade*; a transfer is fetched in full first (the list payload lacks its counterpart); everything else opens on the row as listed. A failed lookup for a trade opens nothing rather than falling back to the cash form -- the fallback is the same defect by another door.

**A modal this page already mounts is opened, not navigated to.** Clicking an investment-linked row pushed `/investments?edit=<id>`, remounting and refetching everything to reach a form that was mounted the whole time. Fetch the row and call the modal's own `openEdit`; keep the URL parameter for arrivals from another page.

**A form's account list is a property of the form, not of the page that opened it.** `InvestmentTransactionForm` is mounted from two surfaces, and only one passed `allAccounts` -- so "Funds From (optional)" offered only the one option the field exists to replace (issue #1191). When a surface mounts a shared form against a narrower scope, narrow the *scope* props (`accounts`, `defaultAccountId`) and keep supplying the wide ones. A failed lookup stays `undefined`, never `[]`: undefined is "not supplied", an empty array claims the user has no other accounts.

### The transaction register's columns are one contract -- `register-columns.ts`

The register's column order and the width each column appears at live once, in `components/transactions/register-columns.ts`: an ordered id list and a priority tier per column (`always` / `high` / `medium` / `low` / `exceptPhones`), each tier mapping to one breakpoint. Hand-written visibility classes are the defect this replaced -- Status (ranked high) surfaced last at 1400px, Attachments (low) before Tags (medium). **The tiers are container queries, never viewport breakpoints**: the register sits inside page padding, so viewport-keyed columns appeared before the table could hold them, it overflowed its `overflow-x-auto` wrapper, and with Actions pinned sticky-right it was exactly Status -- ranked high -- that scrolled out of view while low-ranked Description stayed on screen. The wrapper carries `REGISTER_TABLE_CONTAINER` and every tier measures that container; **Description is the column that yields** (`REGISTER_DESCRIPTION_CELL_FLEX`, `w-full max-w-0` + truncate), growing with the page when there is room and shrinking to nothing before the table can outgrow its container, and once even a squeezed Description is not worth having the low tier removes it and Ref # together. **Payee outranks Description for width, and its cap is never a fixed pixel figure** (`REGISTER_PAYEE_NAME_CAP`): the cap scales with the register in `cqw` -- `max(280px, 35cqw)` while nothing can yield, opening to `60cqw` once Description is on screen to yield, so the longest realistic payee renders in full and a wider register always shows more payee. It stays a bound rather than `max-w-none` because a payee at the column's 255-char maximum would overflow the table and push Amount, Balance and Status into the horizontal scroll. **A yielding column takes the leftover, so the columns above it have to say what they need** (`REGISTER_PAYEE_CELL_FLOOR`, on the payee `<th>` and `<td>` alike): `w-full` is not "take what is spare", it is a claim on 100% of the table, and an auto-layout table settles that claim against the content columns *in proportion to their content*. So filtering the register to one payee -- which shortens Payee, Category, Ref # and the amounts at once -- handed Description the difference: on a 1710px register Payee went 270px to 212px and Description 386px to 517px, truncating the very payee just filtered for while Description rendered a column of "-". The floor is a length because `min-width: max-content` and `fit-content` are both ignored on a table cell, and it is `sm:`-scoped because `min-width` beats `max-width` and would otherwise override the payee cell's phone caps. `TransactionList` and `TransactionRow` read `registerColumnClass(id)`; `register-columns.guard.test.ts` fails a `hidden *:table-cell` spelled in either file (viewport or container variant), a column mentioned out of order, tiers whose breakpoints invert their rank, a wrapper missing the container mark, a description cell without the yield classes, and a payee header or cell that does not carry the floor (or hand-writes one instead of importing it). Two rules the tiers cannot express: **density never changes which columns exist** (Normal/Compact/Dense move padding and secondary content only), and **the Account column is structural** -- rendered only when the list spans more than one account (`!isSingleAccountView`), omitted from the DOM entirely on a single account's page. The first of those two has one exception, and it is a **layout** mode rather than a data or behaviour predicate: on a phone (`useIsMobile`) at Normal density `TransactionList` passes `TransactionRow` a `wrapped` prop and the row renders as a two-line card in a single `<td>` -- date, payee, amount, balance, category, status and account, with the row's tags on a third line of their own under the category when it has any, and description, ref #, attachments and the row actions omitted; the full column header is replaced by a slim control header keeping the day/month date toggle and the select-all-on-page box -- while Compact and Dense keep the tier table on a phone and every non-phone width keeps it at all three levels. The foreign-currency fee surfaces (`showFxColumns`) also keep the tier table on a phone, since the card carries none of their paid-currency / amount / fee columns. `useIsMobile` is acceptable here because it selects a *presentation*, not a different set of facts or a different answer to a money question (contrast `DateInput` and `mapsUrl`, which ask about the *platform*): both layouts show the same figures, the date toggle and select-all stay in the card's slim header, and the row's Edit / Copy / Delete move to the long-press or right-click action sheet a mouse can still open, so a narrow desktop window flipping between the two loses no capability. Column presence in the tier table itself is still never density-dependent. The day/month date view (`useCompactMobileDates`) is selectable at every width on this register, not only on phones; the reconcile table still shortens below `sm` only.

### Row density is remembered per view, by one store -- `useDensityPreference(view)`

Each surface keeps its own level, but exactly one store holds them all. Read it with `useDensityPreference(view)` (`@/store/densityStore`), which returns `density`, `setDensity` and `cycleDensity` bound to that view; pass the level *down* to rows and `RowActions` as a prop, never accept a change callback back up. `DensityView` is a union, so a mistyped view is a compile error. (It was thirteen drifting stores before issue #1193; `densityStore.ts` migrates all twelve legacy keys.)

**A component rendered from more than one surface takes a `densityView` prop.** `TransactionList` is mounted from six places; the prop defaults to the owning page's view, so a caller that forgets it silently shares the register's bucket. The guard fails on a call site outside the owning page that does not pass one.

The preference is browser-local rather than a `user_preferences` column on purpose -- a laptop and a desktop on the same account should not have to agree -- and is classified in `persisted-storage.guard.test.ts`.

**The button is `DensityToggle`, and the strip above a table is `DensityToggleBar`** (`components/ui/DensityToggle.tsx`). The copy lives once, at `common.density.*` (per-surface namespaces let fourteen locales drift, with Korean holding six words for "Dense"). Pass `size` (`sm` above a table, `md` beside `text-sm` toolbar controls, `chip` in a filter-chip row) and `className`; never colour or padding.

**Cell padding is `useTableDensity(density, scale)`**, whose table is data in one file. Two scales are deliberate: `default`, and `wide` for a register with enough columns that the phone inset yields first (the investment register). A third variant means a named entry there, not a `switch` in a component.

`density-preference.guard.test.ts` holds all of it as a scan: a local density `useState`, a density key at any storage call site, an `onDensityChange` prop, a `cycleDensity` not from the store, a shared list rendered without a `densityView`, a second copy of the toggle markup, a density string in any catalog but `common`, and a hand-rolled padding `switch` all fail.

### Asking for the Balance column and supplying the balance are one decision

`<TransactionList isSingleAccountView>` draws the Balance column, and the number in it is the backend's `startingBalance` run down the page -- the list derives nothing, so the column arrives empty without it (issue #1188). Take both from the same response and adopt them in the same block: a starting balance is computed for one page of one account, and a failed reload that keeps the rows has to keep the balance too. `ui-conventions.test.ts` fails any `<TransactionList>` setting `isSingleAccountView` without `startingBalance`.

### An overdue-reconciliation window is the server's number, never the client's

Whether an unreconciled row is *overdue* is decided by `classifyStaleRow` (`lib/stale-reconciliation.ts`), and it takes the boundary date as an argument because the server owns it: every response that asks for a classification carries `overdueBefore` (and `staleAfterDays` for the copy that names it), from `STALE_UNRECONCILED_DAYS` in `backend/src/transactions/stale-reconciliation.ts`. A hardcoded number goes on saying 45 after the constant moves, and the row highlight then disagrees with the header badge.

**Which of its two answers a surface *draws* is the surface's decision** -- the register draws `missed` only (`registerStaleReason` in `TransactionList.tsx`; "overdue" is true of every row at once on a page of history), `ReconcileTable` draws both, the header badge counts both. That presentation choice is the *only* thing a call site may vary. Three things the helper decides that a call site must not re-decide:

- **An account nobody reconciles has no overdue rows** (`lastReconciledDate` null is the whole test) -- reconciliation is opt-in.
- **`missed` wins over `overdue`** -- a row counted under both makes the reminder's lines add up to more than the badge.
- **A RECONCILED or VOID row is never outstanding** -- the status test lives inside the helper.

**A failed lookup is not a clean ledger.** `useStaleReconciliation` returns `undefined` on failure, and every consumer reads undefined as "no information" and marks nothing. An empty context instead would make an outage indistinguishable from an up-to-date ledger -- the same class of mistake as `accounts = []` on a failed request.

### A phone number is shown through `formatPhoneForDisplay`, never raw

`payee.phone` is stored as E.164 with an optional RFC 3966 extension suffix
(`+12064488762`, `+442079460958;ext=12`). `formatPhoneForDisplay`
(`lib/phone-number.ts`) is the only way it reaches a reader -- grouped, with the
extension as ` x12` -- and it is **total**: rows written before normalization are
not backfilled, so a value it cannot parse comes back unchanged rather than
blanked (a stored "call the shop" is worth showing even though it cannot be
dialled). `telHref` is the exception and takes the stored value on purpose: it
needs the digits and the `;ext=` suffix, which it carries into the `tel:` link.

The payee form validates with `normalizePhoneNumber` under the field, using the
region from `phoneRegionFromPreferences` over the stored `numberFormat` and
`language`. That is not belt-and-braces: both layers assert
`backend/src/common/phone-number-cases.json`, so the field can neither block a
number the API would store nor submit one it would refuse. The waiver is part of
that agreement -- `buildPayeeSchema` takes the phone the payee already holds and
passes an unchanged value, exactly as the server does, because rows written
before normalization are not backfilled and a stricter field would make a payee
holding free text impossible to edit at all.
`lib/phone-number.guard.test.ts` scans for a raw `{x.phone}` render and requires
every known display surface to reference the formatter.

**An input is a display surface.** A value reaches a reader through `setValue`
as surely as through JSX, and the lookup prefill wrote the suggestion's stored
form into the Phone field -- so the same box formatted on load and showed
`+442079460958;ext=12` when a lookup filled it. A loop that writes contact
fields generically decides the phone's form at the write site
(`field === 'phone' ? formatPhoneForDisplay(value) : value`), which the guard
scans for; comparing the two forms is the same bug wearing a different hat, and
reported an unchanged number as a replaced one.

**Not knowing the region is a third state, and it is not a default.**
`phoneRegion` is `undefined` while `usePreferencesStore` holds no row -- before
the fetch lands, and after one that failed -- and the field checks nothing then,
leaving the answer to the server, which reads the row. `null` is different: it
is an *answer* (the preferences name no region), and it asks for a country code.
Collapsing the two applies the `en-US` column default to a `de-DE` user and
rejects a Berlin number the API stores happily. The shared truth table proves
the two layers' *functions* agree; only the wiring can prove they were handed
the same inputs, so read the whole `preferences` object, never fields off it.

### A long list -- page it, or bound it and scroll with `scrollbar-slim`

A full-page list uses `components/ui/Pagination.tsx`. A list inside a card caps its height and scrolls: `scrollbar-slim max-h-* overflow-y-auto pr-1`. The thing to avoid is the *default* scrollbar, not scrolling -- on Linux/Windows the native bar inside a small card reads as a rendering fault. `scrollbar-slim` (defined in `globals.css` alongside `scrollbar-hide`) keeps a thin themed thumb.

Bound the height rather than letting the card grow or hiding rows behind a "Show N more" expander -- a card in a grid must be the same height whatever its contents (`SecurityWeightingBars` and the detail page's "Held in accounts" are the worked examples). `scrollbar-hide` is for a horizontal chip strip where overflow is obvious; never use it on a vertical list.

### A table a phone renders must fit the phone -- `overflow-x-auto` is not containment there

Mobile Chrome sizes the viewport that `position: fixed` elements attach to from the page's *widest* content, and a table inside `overflow-x-auto` still counts even though it scrolls -- the reconcile table at ~690px put every modal on its page (the transaction edit form) hundreds of pixels off a 390px screen while the page itself looked fine. Desktop windows and plain narrow viewports never show this; only real mobile emulation (`isMobile`) or a phone does. So a register-like table makes the register's trades rather than relying on horizontal scroll: hide the secondary columns below `sm` (`hidden sm:table-cell`), collapse the actions column with them and back it on every width with the shared `RowActionSheet` opened by `useLongPress` (press-and-hold, or right-click), offer the register's year-hiding toggle (`useCompactMobileDates` + `registerDateColumnPadding`, one store for every register surface), cap the payee (`max-w-* sm:max-w-none overflow-hidden`), and give a grouping row per-column filler cells that collapse with their columns instead of one desktop-sized `colSpan`. The mobile reconcile spec in `e2e/tests/mobile.spec.ts` holds the property end to end: `window.innerWidth` stays at device width with the table on screen, and the modal's box fits the viewport.

### A wide table wraps each row into a card on a phone, by one of two mechanisms

Below `sm` a table that cannot fit five or more columns does not scroll sideways; each row becomes a two-to-four-line grid card so every column keeps half (or a third) of the width. Twenty-odd surfaces were converted this way, three high-effort review passes each, and the rules below are the ones a reviewer caught at least once. `docs/mobile-table-review.html` is the device checklist for them.

- **Mechanism A (CSS single tree)** for a table with no density toggle: `<table className="block ... sm:table">`, `thead`/`tbody`/`tfoot` block below `sm`, each `<tr>` a `grid grid-cols-N ... sm:table-row`, every `<td>` with explicit `col-start`/`row-start` (never auto-flow) and `role="cell"`, explicit `role="table"/"rowgroup"/"row"` (restyling `display` strips the implicit semantics). The `sm`+ output is identical *as resolved* at 640px and above; prove it with a DOM diff normalised for `sm:` restorations and an 800px pixel diff, never by class-attribute equality. `IncomeVsExpensesReport` is the worked example. **Mechanism B (Model B)** for a list that reads `useDensityPreference`: on a phone Normal density renders the card, Compact and Dense keep the tier table (the register section above has the full contract).
- **Every bare figure carries `CellLabel`** (`components/ui/Table.tsx`, `className="sm:hidden"` under A) reusing the column's existing header key; self-describing pills, names and a descriptor sitting under its identity (a category under a payee) carry none. `CellLabel` owns `whitespace-normal` because `white-space` is inherited from the nowrap money cell around it. Captions are separate text nodes, so an existing `getByText(<value>)` still matches; an existing test that *clicks* a header by label must address the column header row by its displaying class.
- **A header that holds controls is replaced, never hidden.** Sort controls come back as a phone-only strip of the same `SortableHeader` chips (30px targets) rendered from one exhaustive mapped-type record `{ [K in SortField]: SortColumn & { field: K } }` whose `Object.values` both header rows render; the register's slim header keeps its date toggle and select-all. A dropped chip strands a persisted sort field.
- **Money never truncates or wraps, so the tracks are sized by measurement**: a hand-CSS replica at 320 and 390 with the real page and card insets, the widest cell that wears the class (the bold footer total in the ISO-code currency fallback), and the `overflow-x-auto` wrapper's `scrollWidth === clientWidth` (the table's own is not the check, and `document.scrollWidth` hides it). The line count is `ceil(cells / tracks)`; 2dp money is two per line, the compact formatter three. `whitespace-nowrap` is for numbers and formatted dates; a translated word keeps wrapping.
- **The identity wraps unclamped** in a `min-w-0` `minmax(0,1fr)` track with `break-words sm:break-normal`; a clamp cuts a trailing marker before the tail of the name, and no width assertion sees it. `auto` tracks are sized by their caption, not their value; a bounded caption-less identity (a month) is the one thing that takes `auto`.
- **A footer that hides cells below `sm` states `aria-colindex`** on every cell; a footer with 1x1 cells over the same columns owes none.

### A header panel is `fixed` inside a transformed ancestor -- give it a height, never a bottom anchor

The sliding `AppHeader` always carries a `transform` (`useHideOnScroll`), which makes the header -- not the viewport -- the containing block for every `position: fixed` descendant. A panel mounted in the header (the notifications dropdown, `ActionHistoryPanel`) that anchors with `bottom-0`/`inset-0` is therefore capped at the header's own ~56px box: the full-screen notifications panel only *looked* full while rows overflowed it, and collapsed when empty. Size such a panel with an explicit height (`h-dvh` for the mobile full-screen treatment) and edge offsets that grow past the containing block; `NotificationList.test.tsx` pins the class shape.

### A control is not offered when nothing can answer it -- and which question to ask depends on the control

Two hooks, because two different prerequisites. A control whose one possible outcome is "configure something first" is worse than an absent one: it costs a click to learn nothing.

- **A payee contact lookup asks `hooks/useContactLookupAvailable.ts`.** Google Places can answer that lookup as well as an AI provider, so the question is "can a lookup run", never "is there a model". Gated on the AI hook instead, the button disappears for a user who configured Places and no AI -- exactly the configuration the feature exists for. The surfaces are the payee form's and detail card's lookup buttons, the transaction page's quick-create confirmation, and the automatic-lookup toggle in Settings. The guard in `src/test/ui-conventions.test.ts` fails any file that reaches a lookup API and imports `useAiConfigured`.

  **A control the user is looking AT is disabled, not hidden.** The buttons on the payee form and detail card are withheld when nothing can answer, because their surface says nothing about why. The automatic-lookup toggle sits directly under the two source rows that cause the state, so switching the last source off makes it read off and disabled (with copy naming the repair) rather than vanish -- a control that disappears under the change you just made reads as a bug. It shows off without WRITING false: switching a source back on restores the setting the user chose.

  **The hook is read once on mount, so the one surface that changes the answer re-reads it.** `refresh()` exists for `PayeeLookupSection` alone: it writes the switches that decide `available`, and `payeeLookupApi.updateSettings` dropping the cache does nothing for a hook already holding its value. It is awaited inside the save, while the card is still in its saving state, so the toggle never renders live against a source that was just switched off. Re-deriving availability from the settings row on the client instead is the thing not to do -- the server's answer already folds in the spent cap and a key it cannot decrypt.
- **The assistant asks `hooks/useAiConfigured.ts`**, because a chat genuinely needs a model: the floating bubble and its own settings toggle.

**A preference outlives the provider that justified it.** `aiBubbleEnabled` stays true after the last provider is deleted, so the floating chat bubble gates on the provider as well as on the opt-in; without that it sits on every page and opens a chat that can only fail. Any future preference guarding provider-backed work inherits the same pair.

The hook answers `configured: false` until the status settles **and** for a status read that failed -- deliberately, because "we could not ask" is not "there is a provider", and it is also what keeps a control from flashing in and vanishing. Read the cached `aiApi.getStatus` through the hook rather than fetching status again: one request serves every mounted surface, and a provider added or removed in Settings drops that cache.

### A push subscription belongs to an account; `localStorage` belongs to an origin

`monize.push.registeredEndpoint` records the endpoint this browser registered
**and whose registration it was** (`rememberRegisteredEndpoint(userId,
fingerprint)`), because two people share one browser profile: with the owner
missing, the second account signing in saw a subscription it had no server row
for, read it as a revocation and unsubscribed the browser -- taking push away
from the first account, whose device list still showed the row as active.
`classifyPushRegistration` therefore takes the marker *and* the reader's id, and
answers `foreign` for a marker somebody else wrote -- **whichever endpoint it
names**: read as a rotation, a foreign marker naming a different endpoint had the
panel register a device for a reader who never asked for notifications, passing
the permission gate only because the other account had granted it. The panel acts
on nothing there, because neither repair (release, or re-register) is the reader's
to make, and sign-out leaves such a subscription alone for the same reason. A
value in the pre-owner format, or one with no reader identity, reads as "no
information" -- which errs toward doing nothing.

**Replacing this browser's endpoint means retiring the row for the one it
replaced** (`retireServerRowFor`). Nothing else ever would: a row is retired by a
delivery's own 404, and nothing delivers to an endpoint that no longer exists --
so each rotation, and each Enable on a browser that does not expose
`options.applicationServerKey`, left a permanent undeliverable "device" in the
user's list holding one of their `MAX_LIVE_DEVICES_PER_USER` slots. That cleanup
is also what makes the conservative reading of an unknown key affordable: an
unreadable key is treated as a mismatch, because a silently undeliverable
subscription is worse than a fresh endpoint.

Whatever `getPushSupport` reads is the same shape of problem in time rather than
identity: `Notification.permission` and "is this the installed iOS app" are
states the user changes *elsewhere* and then comes back, so the panel re-reads
them when the page becomes visible. Read once on mount, it kept telling the user
the browser had refused after they had allowed it, with the Enable button hidden.

### The notification permission is asked for once, from a click

`Notification.requestPermission()` appears in exactly one file -- `lib/push.ts`,
reached through `enablePushOnThisDevice` -- and
`lib/push-permission-request.guard.test.ts` fails on a second call site. The rule
is not politeness, it is what works: **there is no way to grant this permission at
install time** (no manifest field, no API), and a request without a user gesture
is refused rather than shown -- Firefox has required one since 72, Chrome quiets
the prompt for origins with a poor grant rate, and iOS shows it only inside an
installed web app. A permission an origin loses this way cannot be asked for
again, which is why the news-site pattern (ask on page load) is the one shape this
must never take.

So "install with notifications" is really **ask at the right moment, with a
button**, and `pushPromptState` (`lib/push.ts`) decides that moment.
`PushEnableBanner` renders its three answers app-wide, and two of them carry no
button because nothing a button could do would help: an iPhone in a Safari tab
needs the Home Screen app first, and a browser already refusing can only be
undone in its own settings -- **iOS Settings, then Notifications, then Monize**
for an installed app, not any site settings. Those two states are exactly what
the product had nothing to say about, and the reported experience was a user
deleting the PWA to find out.

Two mechanics that keep it honest. `handleEnable` is **not** an `async` function
in either surface: iOS spends the click's transient activation on the first
suspension, so the request has to be the first thing the handler does -- written
`async () => { setBusy(true); await enable() }` it asks for a permission the user
is then told they did not grant, with no prompt ever shown. And the dismissal is
remembered per account **and** per kind (`monize.push.promptDismissed`): the
account for the reason the registered-endpoint marker carries one, and the kind
because waving away the offer says nothing about wanting to know, later, that the
browser has started blocking Monize.

### A settings screen has one save contract, and it is save-on-change

`PreferencesSection` had two: language, theme and colour theme persisted the
moment they changed (each selector owns its own write, because each has work to
do beyond it), and the other thirteen controls waited for a "Save Preferences"
button -- with nothing on screen saying which a given control followed, so a
change made and navigated away from was silently lost. Every field now writes as
it changes, through `useSavedPreference` (`hooks/useSavedPreference.ts`) and the
one `commitPreference` the section owns: optimistic local state, the PATCH, and
on failure a revert to the value THAT change replaced plus an error toast --
the same shape the notification toggles already used.

Three properties the hook carries, each with a test:

- **The patch is the one field that changed**, never a resend of everything the
  screen holds. The bulk payload had the opposite failure mode: a field left out
  of it was reset the next time anything else was saved.
- **A control re-emitting the value it already holds writes nothing.** A request
  per non-edit is a toast per non-edit.
- **The revert closes over the value of its own change**, so two changes in
  flight cannot restore each other's.

Do not reintroduce a Save button beside auto-saving controls. Where a field
genuinely needs one -- a multi-part form that is invalid mid-edit -- the whole
screen takes that contract, not one control on it.

**A removed control has consumers `npx vitest run` never loads.** The E2E suite
lives in `e2e/`, outside `frontend/src`, so a green Vitest run says nothing about
it: deleting the Save button left `e2e/tests/settings.spec.ts` clicking a button
that no longer exists, and only CI found it. Deleting or renaming any control an
E2E spec drives means grepping `e2e/` for its accessible name in the same commit.

**An E2E alert locator is scoped to a region, never page-wide.** Next mounts its route announcer (`__next-route-announcer__`, `role="alert"`, in a shadow root under `<body>`) on every hydrated page, and Playwright's role engine matches it, so `page.getByRole('alert')` resolves to two elements the moment an error panel renders -- a strict-mode failure. The payee and category detail specs passed for months only because the poll that saw the announcer alone, before the panel, satisfied `toBeVisible`. Scope it: `page.getByRole('main').getByRole('alert')`, or a dialog. `src/test/e2e-conventions.test.ts` scans `e2e/tests` for the bare form.

### A password field declares what may be autofilled into it

Every `<Input type="password">` carries an `autoComplete`: `current-password` when it really is this account's password, `new-password` when one is being set here, `off` when it is not a credential of this site at all. Omitting it is not neutral -- a password manager fills a bare box with the saved credential, and the form submits it as typed: the AI provider's API key field silently replaced the stored key ("Saved" on screen, provider dead, row shows `****` either way), and the backup export password is the same shape and worse. `ui-conventions.test.ts` fails on a password input with no `autoComplete`, and on a value outside those three.

### A view that graduates to its own page -- delete the modal, do not flag it

Remove the modal mode instead of keeping it behind a prop: an `onClose?` nobody passes and an `embedded` flag whose only caller always sets it leave every `!embedded` branch compiling, tested and unreachable, still fetching data they no longer show. Delete the props, those branches, the orphaned catalog strings in every locale, and whatever in a shared component only that modal used.

### Copy -- `--` is comment style, never UI text

The repo writes `--` in code comments, and the habit leaks into catalog strings, where it renders literally. In copy use an em dash, or recast the sentence. `messages.punctuation.test.ts` fails the build on a new one (shrink-only baseline for existing). The same applies to anything else that is punctuation rather than words: compose it in the catalog, not in JSX -- `"{units} ({share})"` is one string a translator can reorder; `{value}{' ('}{share}{')'}` is three fragments they cannot reach.

### A transfer's direction comes from the row's own amount -- `transferDirection`

Money leaving an account went **to** the counterpart; money arriving came **from** it. The two legs of one transfer are labelled differently and both are right, and a split line pointing at another account is asked with *its* own amount, not the parent's. `transferDirection` (`lib/transfer-label.ts`) is the only place that decision is made; `transferCsvLabel` is the export's rendering, and the register renders the same decision as its arrow chip. A `ui-conventions.test.ts` guard fails on a new `? 'to' : 'from'` outside the helper.

Coerce before comparing: `'-67.9900' < 0` is false, and a decimal string is what the API sends.

### A transaction's payee display is `usePayeeDisplay`, never a bare `payeeName` read

A transfer created with a blank payee is PERSISTED blank (issue #1214); migration 161 blanked the legacy-stamped rows. The label is resolved at render time: `usePayeeDisplay()` (`hooks/usePayeeDisplay.ts`) returns the stored payee when there is one, otherwise for a transfer leg the localized `common.transferPayee` string built from `linkedTransaction.account.name` -- the counterpart's CURRENT name, so renames and language switches reach every historical row. A surface reading `tx.payeeName || tx.payee?.name` directly shows those transfers as unnamed. English CSV exports use `transferPayeeCsvLabel` (`lib/transfer-label.ts`), byte-identical twin of the backend's `transferPayeeLabel`.

### A CSV file is written by `exportToCsv`, and a number in it is a number

`lib/csv-export.ts` is the only CSV writer: BOM, CRLF, RFC 4180 quoting, formula-injection guard, download. Multi-table exports take `exportCsvSections` (`MonteCarloReport` had a hand-rolled copy that quoted every field and guarded none). `ui-conventions.test.ts` fails on a second `text/csv` Blob or a second `replace(/"/g, '""')`.

The guard cannot key off the first character (`-` opens both a formula and every debit -- issue #1134: Excel refused to total 59 of 64 rows). It asks whether the value *is* a number (optional sign, digits, separators, whitespace, currency symbols, optional `%`), which is provably inert as a formula.

**The reason it reached the user is worth more than the fix.** A prior pass had exempted negative numbers, with a passing test -- but it tested `-100` the JS number, while the API sends the *string* `"-67.9900"` (`decimal(20,4)` crosses the wire as a string while `types/transaction.ts` declares `amount: number`). Two consequences:

- **A money value off the API is a string until you make it one.** `Number(...)` it at the boundary of anything that branches on its type -- an export, a `typeof` check, a `.toFixed`.
- **A test for a type-dependent branch uses the shape the API sends**, not the shape the interface claims (`page.test.tsx` exports a fixture whose `amount` is `'-67.9900'` for this reason).

### Asynchronous data carries the request that produced it

**Asynchronous data is not only a payload. It is the payload plus the complete request key that produced it.** A component holding `data` without knowing which request answered cannot tell "the report you are looking at" from "the report you were looking at a moment ago", and every action it offers is aimed at whichever of the two it happens to read.

The request key is every selector that changes the *meaning* of the response, not merely its freshness: the scenario or strategy id, the account id, the date range, the reporting currency, the active filters, the locale where the server localizes output, and the revision where one exists. If changing it would make the same payload mean something else, it is part of the key.

**Stale data may stay on screen; it may not stay actionable.** Keeping the previous view during a load is often the better read. It is allowed while all of the following hold: it is visually marked as stale or loading; editable controls are disabled; mutations are disabled; no action can submit an id taken from the stale payload under the new selection; assistive technology is told the same thing the pixels say (`aria-busy`). Clearing the screen is not required. Non-actionable is.

**A mutation captures an immutable origin key when it starts**, and its response is adopted only when `mutationOriginKey === currentRequestKey` *and* the entity the response describes is the one the mutation targeted. Derive that origin from the data the component was rendering, not from current React state read after the request began -- state has already moved by the time the response lands.

**A failed lookup is not an empty dataset.** A failed accounts request is not `accounts = []`, and a failed report is not a report of zeros -- rendering the failure as emptiness turns an outage into a plausible answer and leaves the save button live over prerequisites that never loaded. Five states stay distinguishable: loaded-and-empty, loading, failed, stale-previous, and current. Where a prerequisite failed, use the shared retryable error presentation, keep the stored ids, and disable the actions that depend on it.

**The `catch` belongs where the decision is, and a fetch helper is not that place.** `fetchLoanInterestTransactions` returned `[]` from a `catch`, which made a transient 500 indistinguishable from "this loan books no separate interest" -- and every one of its five callers already had the error state it should have reached (`useLoanProjection` reports the projection unknown, the account page has an outer boundary, two reports run on `useReportData`). The helper was starving all of them. The consequence was not a visible blank: with the interest list empty, `deriveLoanPaymentHistory` reads `hasSeparateInterest` as false and every row falls to the ANALYTIC estimate, so a loan that books interest separately renders a full history of invented interest that looks exactly like a real one. A swallowed failure is worst where the fallback is *plausible*. `LoanAmortizationReport` was the one caller that also caught it itself and cleared both arrays; it goes through `useReportData` now like every other loader on that surface.

**A surface that swallows a failure also hides the tests that depend on it.** Five fixtures in `LoanAmortizationReport.test.tsx` omitted `pagination.hasMore`, so `fetchAllAccountTransactions` threw on the first page and the report rendered its error screen -- and every one of those tests was green, because each asserted something that did not need the history. Making the failure visible turned four of them red at once, and a fifth test (`handles loadTransactions error gracefully`) turned out to be *asserting* the silence: it expected the report chrome to render on a failed history load. So the removed `catch` is itself the guard a source scan could not be; a repo-wide "fixture carries its pagination" scan reports 261 candidate blocks, nearly all legitimate.

**A dirty keyed form is data.** Changing the request key while a form has unsaved edits calls for a confirmation, a preserved draft, or an explicit save/discard flow; silently unmounting it is data loss. A form rendered for scenario A must also stop being editable once scenario B is the current selection -- two obligations, and meeting the second by discarding the first is not meeting both.

**A background load finishing is not the user acting.** State a page throws away when the user changes a filter -- a selection, a draft, a scroll position -- keys off the criteria the *user* chose, never off a derived object the page recomputes as data lands. The transactions page's `bulkUpdateFilters` falls back to every visible account when no account filter is set, so it changes the moment the accounts request answers; `useTransactionSelection` compared that object and silently cleared a selection the user had already made (CI run #2873 saw it as a bulk-update banner that never appeared). Pass the user's own criteria as the reset key and keep the resolved scope for the server payload -- derived from the one object, so the two lists cannot drift. The row set carries the same distinction: the first page of rows arriving is a load finishing, not a page change.

**A `useMemo` that sorts copies first.** `Array.prototype.sort` reorders in place, so a display memo sorting a shared memoized array reorders what every other consumer reads, and the value then depends on which memo happened to run first -- `accountFilterOptions` sorting `filteredAccounts` decided the bulk-update account scope's order as a side effect of rendering a dropdown. Write `[...xs].sort(...)`, always.

Regression tests for this class need deferred promises, and must assert on what the user *can do*, not only on what is rendered (`docs/testing-contract.md` carries the wider adversarial list):

| Case | Assertion |
| --- | --- |
| A starts, B starts, B resolves, A resolves late | the display is still B |
| A shown, B selected and loading | A's form cannot submit |
| Save for A starts, user selects B, A resolves | A's response is discarded and does not retire B's request |
| A shown, B selected, B fails | the failure is shown; A is not presented as B |
| Form dirty, user selects B | confirmation is asked for, or the draft survives |
| Save on the default selection, nothing else happens | the response is adopted |

**Both sides of that comparison must come from the same place.** The origin key a mutation captures and the key the loader is holding have to be produced by one expression -- take the origin from what the loader actually stamped (`dataKey` on `useReportData`), never rebuild it from the rendered payload's fields. The GEM report built its page key from a `strategyId` *state* unset until the user picks from a switcher, and the save's origin from `data.strategy.id`, always a real id: they could never match on the ordinary path, so every save was discarded with no refetch behind it. A key comparison that silently drops the common case looks exactly like one that works.

### An act() warning is a failure, not a log line

A test asserting on a tree React has not finished updating reads whatever
happened to be committed when the assertion ran -- it passes or fails on
timing, not on behaviour. React says so, on stderr, and nobody is watching
stderr in a 14,000-test run: CI run #2873 carried fifteen act warnings under a
green tick, in the same job whose one real failure was a race. So `src/test/setup.ts`
routes them into `src/test/act-guard.ts`, which **fails** the test that earned
them. `act-guard.test.ts` checks the behaviour and scans `setup.ts` for the
wiring, because a guard nothing calls is not a guard.

Fix the update, never the message. In order of preference: await the thing that
lands late (`await screen.findBy...`, `await waitFor(...)`); or wrap the trigger
in `await act(async () => { ... })`. Adding the text to a console filter is the
one response that is always wrong.

**Exactly one message is that failure**: `An update to <Component> inside a test
was not wrapped in act(...)`. React's other act-related line -- `The current
testing environment is not configured to support act(...)` -- is a different
condition and is deliberately *not* failed on. It fires when an update is
checked while `IS_REACT_ACT_ENVIRONMENT` is unset, which happens during teardown
after RTL has restored the flag; it names no component, so it points at nothing,
and it depends on timing the suite does not control. Matching it turned `main`
red on CI run #2875, on a test nothing had changed and that neither the PR run
nor three full local runs of the same commit had flagged. **A guard against
flakiness that is itself timing-dependent is worse than none.**

And a guard classifies in one place: `recordIfActWarning` both recognises and
records, because the two were separate functions that disagreed -- the
classifier rejected a message the recorder stored anyway, so a warning nothing
recognised could still fail a test.

Three sources produce nearly all of them here:

- **A synchronous test with a request still in flight.** The response commits
  after the test returns, into whichever tree is mounted by then. Settle it
  before returning, even when the assertion is about the state *before* it
  arrives (`useStaleReconciliation.test.ts`).
- **`vi.waitFor` and `element.dispatchEvent`, which are not act-aware.** Prefer
  RTL's `waitFor` and `fireEvent`; `fireEvent(element, event)` takes an event
  object when a test needs to spy on that exact one. Where Vitest's fake timers
  rule out RTL's `waitFor` -- it cannot drive them -- drain the clock inside
  act: `await act(async () => { await vi.advanceTimersByTimeAsync(n); })`.
- **A store write with the tree mounted.** Zustand notifies subscribers
  synchronously, so `useDensityStore.setState(...)` re-renders outside act
  unless wrapped. Writing *before* the render does not need it.

### Awaiting static chrome synchronises nothing

`await screen.findByText('Portfolio Value Over Time')` resolves on the page's
title -- markup that renders before any request does. Every assertion keyed off
it is asserting on an async call it never waited for. Wait for the thing being
asserted (`await waitFor(() => expect(api.x).toHaveBeenCalledTimes(1))`), which
cannot mask a real failure: a call that never happens still times out.

The trap is worst where a call is **second-stage** -- issued only after an
earlier response commits. The Portfolio Value chart's prior-close baseline is
gated on `chartPoints[0]`, so it cannot fire until the intraday response lands;
tests asserting it right after the title passed on a fast machine and failed on
CI run #2877. Before asserting that a request was made, ask what has to resolve
first.

Two exceptions, both real: an assertion already inside a `waitFor` callback, and
one inside a pinned clock -- RTL's `waitFor` cannot drive Vitest's fake timers
and will hang until the test times out, so there the act-wrapped drain is the
barrier. A blanket sweep over a file with mixed timer regimes walks into that.

### Test isolation is every storage, not just `localStorage`

`src/test/setup.ts` clears `localStorage` between tests, and for a long time
cleared nothing else. The Portfolio Value chart caches its intraday response in
`sessionStorage`, and a leaked entry hydrates the next test's chart
*synchronously on mount* -- which moves a second-stage request to immediate and
silently changes what that test is exercising. Anything a component persists is
shared state between tests: clear it, or the suite's behaviour depends on
ordering.

### A busy flag shared by nesting operations is a counter, not a boolean

One mutation can start another ("save and carry on" runs the deferred scenario create from inside the settings save's own `onSaved`). With a single boolean the inner sets it, the outer's `finally` clears it, and the page goes live over a request still on the wire. Count the operations in flight and derive the flag (`pending > 0`); every begin needs exactly one end, on both success and failure paths.

### Nothing interactive goes inside a `<button>` or an `<a>`

The parser closes the outer element at the inner tag, so the click target ends where the nested control begins and the server's HTML stops matching React's -- a hydration mismatch. Fix it at the call site by making the two **siblings**: a wrapper carrying the border and hover, with the navigation button and the nested control side by side. Do not demote the inner control to a focusable `<span>` -- its implicit role is generic, screen readers drop its `aria-label`, and the result is a tab stop announcing nothing. `ui-conventions.test.ts` scans for this; changing a shared component's trigger element is a change to every call site, and the guard tells you which.

### A short-range portfolio change is measured from the prior close

On `1d`, `1w` and `mtd` the Change and Change % measure from the close of the last trading day *before* the window -- the convention every quote source reports against. The longer ranges measure from their first point (their window opens on a day whose first point already is that day's close). Which ranges are which lives in `PRIOR_CLOSE_BASELINE_RANGES`.

This was briefly a user preference (migration 152, dropped by 153); it was removed because the prior close is the right answer rather than a taste. `usesPriorCloseBaseline` takes the range and nothing else -- if you find yourself adding a second argument, first ask whether the alternative is actually defensible.

Both halves come from **one hook**, `hooks/usePortfolioChangeBaseline.ts` (`usesPriorClose` and the `priorClose` together); the arithmetic and range set live once in `components/investments/portfolio-change-baseline.ts`. Deciding *whether* a prior close applies in one place and reading the close in another is the specific bug the single hook prevents. The baseline is looked up for the **first point on screen**, never the requested window start (on a weekend the 1D chart shows the last session). A baseline that has not loaded makes the change **unknown** -- both cards read N/A, never the first-point change.

### The window a price chart requests is not the period its range names

`resolveRangePreset` answers "what period is the user asking about", and ten reports depend on that answer. A *price* chart asks a narrower question -- **which close is the series measured from** -- so it has its own function: `components/investments/portfolio-range-window.ts` holds the table (`PORTFOLIO_WINDOW_STARTS`), and the Portfolio Value report, the Investments chart and the dashboard widget resolve through `usePortfolioRangeWindow`. Do not reach for `resolveRangePreset` in a fourth portfolio surface, and do not "fix" a range by editing the shared resolver.

The rules are not uniform -- each matches the platform being compared against:

- **3M, 6M, 1Y, 2Y, 5Y** open on the calendar day *before* the period (2Y follows the calendar, not a 730-day count).
- **YTD** opens on the year's first *trading* day (`netWorthApi.getFirstPricedDay` answers from `security_prices`). A null answer keeps the calendar boundary rather than claiming a trading day nobody observed.
- **1M** keeps its window and collapses its first *day* to that day's close (`trimIntradayToFirstDayClose`) -- it is an intraday chart, and opening mid-session a month ago mixes a mid-session price into a series of closes. 1D deliberately opens at the open; 1W and MTD are measured from the prior close already.

Both intraday adjustments live inside `trimIntradayPoints`, which every intraday render site calls -- a shaping step applied at three of four call sites is a chart that disagrees with itself.

**A range served monthly cannot honour a day-precision rule.** 2Y and 5Y use month buckets, so their first point is a month-end close. Switch the range to daily if the exact opening close matters; do not prepend a single daily point to a monthly series (the sampling splice `docs/time-series-contract.md` section 1.2 exists to stop).

`mtd` is a chart range with no backend series of its own: it rides on the rolling 1M series and is trimmed client-side. Both halves go through `portfolio-chart-utils.tsx` -- `intradayRangeParam` before every intraday request, `trimIntradayPoints` on every response, including the sessionStorage-cached one and the per-security breakdown. Sending `mtd` verbatim is a 400 from `IntradayValueQueryDto`'s enum; a response used untrimmed puts last month's bars in a month-to-date chart. A guard test asserts every member of `INTRADAY_RANGES` maps onto a range the endpoint accepts.

### A loan's payment, payoff and remaining interest are decided once -- `deriveLoanFigures`

Three figures appear on every amortizing-debt surface (the loan detail page's summary cards, the transactions Details sidebar), and each has a state that is neither a number nor "unknown":

- A **settled** debt owes nothing: remaining interest is a known **zero** and the payoff is "Paid off" -- not `null`. Settled means *nothing outstanding* (`-balance <= 0.01`), so an overpaid loan in credit is settled too (`Math.abs` read that credit as debt).
- A projection that hits its horizon without paying off (`paidOff` false) has no payoff date, and its accumulated interest is a subtotal -- both figures are unknown; printing the horizon's number under "Est. Remaining Interest" is a total's label over a partial sum.

`lib/loan-figures.ts` makes the decision once and both surfaces render its output. The data comes from `hooks/useLoanProjection.ts` or a `baseline` the caller already has -- never a second copy of the branching. A failed history load is `status: 'error'` with every figure unknown, never an empty history (which would project a plausible payoff from no payments at all).

### "Today" for a financial decision is the user's day -- `useFinancialToday()`, never `toISOString()`

`new Date().toISOString().slice(0, 10)` is a UTC calendar day, and the backend has never used one: `RequestContextInterceptor` resolves `todayYMD()` from `user_preferences.timezone`, falling back to the `X-Client-Timezone` header the axios interceptor sends. A client that slices a UTC instant is on a third calendar for the first hours after local midnight east of Greenwich (fourteen at UTC+14) and the mirror window before it in the west -- long enough that the loan report accepted an anchor the bill had already called overdue and projected from a balance the ledger no longer held.

`lib/financial-today.ts` (`financialTodayYmd`) is that resolution, and `hooks/useFinancialToday.ts` is how a component gets it. Pass the day into the pure calculation rather than letting it read the clock -- a boundary case is then a stated day and a pinned instant, not a test that only fails when the runner's `TZ` sits on the wrong side. `lib/loan-projection-today.guard.test.ts` fails a projection call that omits `todayYmd`, one whose day comes from anywhere else, and any `toISOString()` day-slice in `lib/loan-history.ts` or its call sites. (`getLocalDateString` stays right for a browser-local default like a form's date field; it is not the answer to "which day is this loan being priced on".)

### A historical loan row states the ledger; only a projection may estimate

`deriveLoanPaymentHistory` reports what a payment actually recorded -- a recorded interest split, else the separate interest expense paired to its date, else **zero**. It never derives interest from the balance and the rate: a $450 principal-only transfer was printed as Payment $500 / Principal $450 / Interest $50, and that fabricated $50 flowed into Interest Paid, every cumulative total, the CSV and PDF exports and the installment the forward projection is seeded with (issue #1255). Estimating is the projection's job, and a projected row is labelled as one. Nothing in `lib/loan-history.ts` reads `getPeriodicRate` to produce an *amount*; a matrix in `loan-history.test.ts` asserts zero interest for a principal-only payment across every account type, Canadian/variable flag, frequency and rate-timeline combination, because each was a separate door into the estimate.

**Not estimating has a price, and the place to pay it is the seed, not the history.** A loan booking its interest outside the app yields `principal + 0` as its observed installment, which `generateLoanSchedule` refuses outright, taking the payoff date and remaining interest with it. `resolveSeedPayment` therefore falls back to the stored contractual `paymentAmount` -- but only for an **incomplete** installment, and the two cases look identical from the number alone. **Complete** (the row's interest was recorded) is the payment, whether or not it still covers the interest: a payment that has fallen behind a rate rise is a real financial state and the schedule refusing it is the honest answer. **Incomplete** (`principal + 0`) is not a smaller payment but a partial one, and the contractual figure is the only complete payment fact such a loan has. Do not restore the estimate to keep a projection alive, and do not pick the largest number to hand -- that dresses a refusal up as a decision about the loan.

**"Current Payment" and the projection seed are one function.** They were two, resolved separately, and disagreed: the card read `principal + 0` = "$450" beside a payoff computed from the contractual $950 -- issue #1255 inverted, with the payment understated by its whole interest portion instead of the interest being invented. The analytic estimate had been hiding it by making the two agree. `resolveCurrentLoanTerms` and `buildLoanProjectionInput` both return `resolveSeedPayment`'s answer -- the rate as well as the payment, so the summary card, the PDF, the two loan reports and the transactions sidebar all print the terms the schedule beside them is built from. A surface needing "the terms in effect" calls that one function; `observedInstallment` is the only derivation of the raw last-installment figure, and the `deriveCurrentInstallment`/`resolveCurrentInstallment` pair it replaced is gone rather than left exported with the pre-change semantics for someone to call by mistake.

**A projection's rate and payment come from one effective state, and the rate timeline is it.** Recording a rate change deliberately does *not* write `account.interestRate` / `account.paymentAmount` — the backend keeps them user-owned, settable only from the account edit form — so after any change entered through the rate-history UI the scalars hold the *old* terms while `loan_rate_changes` holds the current ones. `buildLoanProjectionInput` resolves both from the rows dated at or before today, falling back to the scalar only when no row applies; taking the payment from one source and the rate from the other prices a payoff at a rate nobody is paying (a stale 5% against a real 12% makes a payment $100 short of the interest look comfortably amortizing). Two consequences worth spelling out:

- **Every surface that projects must load the timeline.** The Loan Amortization and Debt Payoff Timeline reports passed `[]` for years, so the same loan had two payoff dates depending on which screen you opened. Both now fetch it inside their existing request key.
- **Do not reach for `buildRateTimeline`'s `startingAnnualRate` / `startingPaymentAmount` for a schedule anchored *today*.** Those carry a deliberate "before the earliest row, the earliest row applies" fallback, which is right for a schedule anchored at **origination** (`loan-past-impact.ts` builds the contractual schedule that way) and wrong here: under it a rate change dated next year sets today's rate *and* is applied again as a future step. Rows dated ahead are steps, never the current state. `resolveEffectiveLoanTerms` (`lib/loan-schedule.ts`) is the today-anchored answer, living beside `buildRateTimeline` so a test pins the difference between the two anchors.
- **An `initial` row's payment is neither authoritative nor worthless.** Two things write that source and it means different things in each, with nothing on the row to tell them apart: `insertInitialRowIfFirst` copies `account.paymentAmount` verbatim (a snapshot that goes stale the moment the user corrects that field), while `RateChangeInferenceService`'s first segment carries the *modal observed* payment. So `resolveEffectiveLoanTerms` returns it as `snapshotPaymentAmount`, and `resolveSeedPayment` ranks it with the account's scalar and tests it against the period's interest: an observation that amortizes is used, a stale copy that no longer covers the interest falls through to the corrected scalar. Seeding it unconditionally pinned the projection to the snapshot; discarding it threw away the observation. Its *rate* is authoritative either way -- that really is the origination rate. Only `manual` and `inferred` rows state a payment outright; detection writes null when interest is booked separately.
- **The amortization guard is evaluated at the rate row 1 will run at, not today's.** `firstPaymentDate` is a full period ahead and `generateLoanSchedule` applies every step dated on or before a row to that row, so a change recorded for next week lands on row 1; guarding at today's rate passes a candidate the next line then refuses, and the projection vanishes instead of using one that works. Same "a preview computes what the commit will do, through the same code" rule as the FX previews.
- **A surface listing debt accounts cannot assume the selected one has a rate history.** Every `/accounts/:id/rate-changes` route answers **400** for anything but LOAN and MORTGAGE, and all three loan reports list `LINE_OF_CREDIT` too. Gate the fetch with `supportsRateChanges` (`lib/loan-rate-changes.ts`, where the endpoint's precondition is written once); an ungated fetch replaced a whole report with its error state, persisted in localStorage so it stayed broken across reloads with no in-page way to pick another account. The report tests missed it because their mock resolved `[]` for every account type -- a fixture the API cannot produce.

  "Written once" is a claim about four other lists, so a test makes it one: `lib/loan-rate-changes.contract.test.ts` checks `RATE_CHANGE_ACCOUNT_TYPES` against the backend's copy (parsed out of `loan-rate-changes.service.ts`, since the two cannot import each other), against the account page's detail-view registry, and against the overpayment simulator's debt-account list -- and it enumerates every caller of `loanRateChangesApi.getAll`, so a fifth one fails the suite until it either gates on the predicate or is tied structurally like the four. `useLoanProjection`'s "amortizing debt" set derives from the export rather than repeating it, which is load-bearing rather than tidy: that hook fetches rate history for every type in the set, so a type in one list and not the other would take a 400 on every load and report the projection as `error`.

**The amortization report's projection is anchored on the next scheduled bill, not on today.** `account.currentBalance` runs through today, so a future-dated or between-occurrences principal payment left the report's first projected row disagreeing with the bill the backend prepares from the ledger through the schedule's due date (issue #1253, INV-LOAN-006). `scheduledTransactionsApi.getLoanProjectionAnchor(accountId)` returns that boundary -- `{ nextDueDate, debt }`, both null when the loan has no active scheduled payment -- and `LoanAmortizationReport` fetches it inside the same request key as the history and passes it to `buildLoanProjectionInput` / `resolveCurrentLoanTerms` as the optional `anchor`. Anchored, the first projected row and the next bill are measured at the same date against the same balance. The **rate** comes from the same place on both sides: the backend resolves the bill's rate through the timeline too (`effectiveAnnualRateOn`), against a truth table both layers assert (`loan-rate-timeline-cases.json`). Which surfaces pass an anchor is enumerated by `lib/loan-projection-anchor.guard.test.ts` -- an omitted optional argument is otherwise indistinguishable from a deliberate today-anchored projection, which is how #1247 recurred. Unanchored surfaces (loan detail payoff, Debt Payoff Timeline, Overpayment Simulator) deliberately keep the today-anchored semantics; they make no per-installment parity claim. Like the rate history, the anchor is a prerequisite: a failed fetch reaches the report's error state rather than silently projecting from today.

The rate history is therefore a prerequisite, not decoration: a failed `loanRateChangesApi.getAll` fails the account-detail load rather than degrading to `[]`. The scenarios list beside it still degrades with a toast, because no headline figure is derived from it — that difference is the whole rule.

**An amortization guard filters candidates; it does not overrule the authoritative one.** The rate timeline's `startingPaymentAmount` is the payment *in effect* (`LoanRateChangesService.resolveCurrentTimeline`), and it can never be a principal-only figure -- `RateChangeInferenceService.persistSegments` writes `newPaymentAmount: null` outright when interest is booked separately, for exactly that reason. So `buildLoanProjectionInput` seeds it whether or not it amortizes: a timeline payment that no longer covers the interest is a fact about the loan (a rate rise the installment has not caught up with), and swapping in the independently user-owned `account.paymentAmount` reports a payoff computed from a payment the timeline says nobody is making. Rank candidates by *authority* first and test only the unranked ones against the guard.

**A failure identity must be retired by the success that answers it.** `useLoanProjection` stamps both its payload and its failure with the account they belong to, and the failure is checked first -- so a success that does not clear it leaves fresh, complete data outranked by a stale error, and no in-page refresh recovers the figures. Clear it inside the state updater (`setFailedAccountId((failed) => (failed === accountId ? null : failed))`), never against the render's value, so a failure recorded for a *different* account mid-flight survives. Do not clear it when the load *starts*: that turns a truthful error into `loading` before the retry has proved anything. This is the retry half of "asynchronous data belongs to the request that produced it", and the test that catches it has to combine two states -- failure, then same-account refresh, then success -- which is why per-state tests all passed while the latch shipped.

**The rate is a separate fact from the interest, and the fix for one must not drop the other.** With no recorded rate history the Rate column is reconstructed from the interest charged -- but a row that charged nothing still has a known rate when the loan is *fixed*: `assignObservedRates` falls back to the configured `interestRate` there, and only there. A variable-rate loan's scalar rate is only today's, so its unrecorded history stays `null`.

**0% is a rate, and `Number(null)` is 0 -- so the test is `!= null`, never `> 0` or truthiness.** That one coercion produced the same defect at three depths of the same feature: `assignObservedRates` gated its fixed-rate fallback on `configuredRate > 0` and so drew "--" on every row of an interest-free loan; `observedInstallment` read `interest > 0` as "the interest is known" and marked a 0% loan's fully stated `principal + 0` installment *incomplete*, refusing the payoff of the one loan whose figures are certain; and five render sites read the resolved `annualRate` for truthiness and printed "Not set" over a recorded 0%. The rule is symmetric with the unknown-value rule above and easy to get backwards: **an unknown must not render as a measured zero, and a measured zero must not render as unknown.** Decide which of the two a branch is in before writing it. `lib/loan-history.guard.test.ts` scans `src/` for the render half.

**Interest is identified by provenance, not by absence.** `readRecordedInterest` used to take "the first split that is not the principal transfer" — a predicate that says what a line is *not*. A real mortgage payment has more than two lines (principal to the loan, escrow or property tax, insurance, a fee, the interest), so whichever non-principal line happened to be listed first became Interest Paid: $500 of escrow reported as interest on a payment whose interest was $300, and on into every cumulative total, export and projection seed. The loan already names its interest category, so the rule is `categoryId === account.interestCategoryId`, summed over matching lines and order-independent by construction. Without a configured category only a *single* category line is unambiguous; two or more return `null` so the caller falls through to a paired separate expense and then to zero, because guessing one is the defect. A transfer leg is never interest — interest is paid to the lender, so it is an expense, and the old `!== loanAccountId` predicate accepted a transfer to any third account.

**"A categorized line" means the same thing on both sides of that rule.** `readRecordedInterest` and `ScheduledTransactionLoanService` (which recalculates the templates it reads back) both count `categoryId && !transferAccountId`. They differed by that one clause, so `[principal, categorized interest, uncategorized fee]` was one candidate line to the writer and two to the reader -- ambiguous, and reported as no interest at all while the recorded amount sat in the split. A parent with no categorized line still falls back to a single uncategorized non-transfer line, which is how legacy splits recorded interest.

The writer's ambiguous case resolves differently from the reader's on purpose, and in the opposite direction to the one that looks safe. It rewrites the parent as principal + interest + extra, so it understands exactly that template shape; a template carrying an escrow, tax or insurance line would come out with a parent that no longer equals the sum of its children, and the posting path's exact-4dp split validator then refuses **every** occurrence -- the bill stops posting with the amount it would have charged nowhere on screen. So `ScheduledTransactionLoanService` **declines the recalculation and returns without writing** (logging which of the two reasons applied, and what to configure) whenever no line carries the loan's interest category or any line falls outside principal/interest/extra. The cost is a P/I split frozen at last period's figures; the alternative cost is a schedule that never posts again. Declining is also what removes the last place a line was chosen by *position* -- picking the first categorized line is what put an amortization figure onto a property-tax line. The reader, which only reports, returns `null` for the same ambiguity and lets a paired separate expense answer.

**Standalone interest is attributed by category + source account, which is not per-loan (`INV-LOAN-HISTORY-001`, `partial`).** `fetchLoanInterestTransactions` selects on exactly that pair and nothing on those rows names the loan, so two loans paid from one account and sharing one interest category absorb each other's interest -- and the setup default manufactures that state, because `LoanPaymentSetupService` falls back to the single user-level `Loan -> Loan Interest` category for every loan. Until a durable provenance link exists (the loan account, or the principal payment the interest belongs to, recorded on the transaction), a loan that books interest separately needs its **own** interest category, and any new surface reading standalone interest inherits the same limitation rather than working around it. Do not add a heuristic discriminator here: a date-and-amount guess would be the escrow-ordering defect again, one layer up.

`accounts.interestBookingMode` (`AUTO | SPLIT | SEPARATE`) is *not* that mechanism today -- it is persisted, offered in the account form and written by the MNY importer, but no reader branches on it, so it constrains nothing. Defining what it means for the historical reader, rate detection and scheduled posting needs a cross-layer truth table first; adding a branch on it without one would make a `SPLIT` loan silently stop counting interest it has always counted.

**In `lib/loan-history.ts` an empty list is a claim, so nothing in that module catches.** An empty `interestTransactions` is what tells the derivation "these payments booked no interest"; a `catch { return [] }` in `fetchLoanInterestTransactions` therefore turned a timeout into a confident Interest Paid of $0.00. Every failure propagates to a caller that owns an error-and-retry state -- `useReportData` in the three loan reports, `failedAccountId` in `useLoanProjection`, the page error on the account detail route. `lib/loan-history.guard.test.ts` fails on any `catch` reappearing in the module.

### A chart reduction is rendering; it never reaches a count, a total or an export

A long series is reduced before it can be drawn, and that reduction is the only
thing it is for. The Debt Payoff Timeline built **one** array -- payment events,
aggregated by month, then sampled down to about 60 points for the axis -- and
read "Payments Made" off it, so a loan with 300 payments reported 61 (issue
#1244). Keep the sets apart and name them apart: the full data every figure is
derived from, and the reduced series a chart is handed.

Which reduction depends on what the series *is*, and `lib/chart-sampling.ts`
holds both:

- **A stock** (a balance, a running total) has a value at a point in time, so
  `sampleStockSeries` draws every Nth point: resolution drops, and every point
  still drawn means exactly what it meant. Pass `keep` for the points that carry
  meaning beyond their value -- the last historical row and the first projected
  one, which the "Today" line and the area join sit on.
- **A flow** (what a period paid) only means anything over an interval, so
  dropping a point *deletes* the months it stood for and the chart shows a
  subset presented as the whole. `bucketFlowSeries` sums contiguous groups
  instead, and its `boundary` keeps a bucket from straddling the
  history/projection line -- one bar cannot honestly be half measured and half
  predicted.

**Monthly aggregation is the same mistake one step earlier: a month is not a
payment.** A biweekly loan makes 26 a year, extra principal payments are their
own events, and two payments in one month are two. The count is
`historicalPaymentCount(history)` (`lib/loan-history.ts`), read by both loan
reports so one loan cannot have two answers.

**Provenance is part of an aggregation's identity, never computed from its
members.** A weekly, biweekly or semi-monthly loan routinely has a real payment
and a projected one in the same calendar month. Grouped on the month alone and
then asked `group.every((item) => item.isProjected)`, August came out
*historical* while holding two thirds forecast principal and the projection's
end-of-month balance -- and when the loan paid off inside that month, no
projected row survived at all, so the "Today" divider and the Est. Payoff card
went with it. `bucketFlowSeries`'s `boundary` cannot repair that: by the time it
runs the two sides are one row. Group on the month *and* the side of the line,
over a date-ordered series and as contiguous runs, so a future-dated posted
payment landing among the projected rows opens its own run. And ask the
projection whether a projection exists -- not the buckets.

**A label is not an identity.** Two chart rows share one -- the month either
side of the line, and a bucketed flow row labelled as the span it covers --
while recharts keys its category axis, its tooltip lookup and every
`ReferenceLine` on the datum's own value. Give each row an `axisKey`
(`axisKeyFor` in `lib/chart-sampling.ts`: its position, then its label), key the
axis on that, and pass `axisTickLabel` as the `tickFormatter` so the tick still
reads "Aug 2026". Keyed on the label, the two rows collapse onto one category
and the divider lands on whichever came first.

**A marker drawn on a reduced series is keyed to that series.** A recharts
`ReferenceLine` whose value matches no axis category is silently not drawn, so
the Payment Distribution chart's "Today" divider comes from the first projected
*bucket's own axis key* -- the balance chart's key addresses a row of a
different series, and the divider disappears on exactly the long loans bucketing
exists for.

Assigning a reduced series back over its source (`points = points.filter(...)`)
is how this happens -- once the two are one variable, nothing downstream can
tell which it holds. So is renaming it on the way out
(`return { points: chartPoints }`), which hands a caller the reduced series
under the full one's name. `lib/chart-reduction.guard.test.ts` scans for a count
taken by filtering a schedule on `isProjected`, for both reports reading the
shared count, and for any reduced series -- or any name one is aliased to in the
same file -- being *measured* (`.length`, `.reduce`, `.filter`, `.some`,
`.every`, `.forEach`); a `.find` for the row a tooltip hovers is allowed,
because a lookup cannot aggregate. It also scans for a group's provenance
derived from its members (`.every(... isProjected ...)`) and pins the Debt
Payoff Timeline's three axes to `dataKey="axisKey"`. INV-REPORT-002.

### An unknown value must not render as a measured zero

The server sends `null` rather than `0` for anything it could not work out (`docs/financial-calculation-contract.md`), and the last hundred pixels are where that gets thrown away:

- **`connectNulls` on a line chart** draws a measured-looking segment through the gap. Default to `connectNulls={false}`.
- **A bar, gauge or meter at zero width** beside an "unknown" label reads as a measured zero. Draw a distinct no-data treatment, or nothing.
- **A row that disappears** when its value is `null` conflates "not applicable" with "could not be computed" -- where the payload can tell them apart, render the row with an unknown marker.
- **`?? 0`, `|| 0`, `?? 1` on an API value** is the same mistake in arithmetic form. Guard with an `isKnown()`-style check first.

Whoever adds the `null` on the server owns how it looks; a component test asserting the gap, marker or absent fill is what keeps it.

**A missing exchange rate is the same class.** `useExchangeRates().convert` / `convertToDefault` / `convertWithRateMap` return `number | null`; they previously returned the amount *unconverted*, so a 100.00 USD balance with no rate was formatted as "100.00 EUR" and summed into Net Worth. Pick the treatment from what the figure is:

- **An aggregate** uses `sumConverted` / `combineTotals` (`lib/currency-total.ts`), which keep the subtotal and the missing currencies together, rendered through `PartialTotal`. Incompleteness is a union: net worth built from a complete asset total and a partial liability total is partial.
- **A single displayed value** shows an unknown marker, or nothing. Never the unconverted number beside the target currency's symbol.
- **A chart series** uses `null` and `connectNulls={false}`; a bar, slice or gauge cannot say "unknown", so an unconvertible component leaves the chart.
- **A cumulative series** (a running balance, a forecast) is withheld whole: one missing rate invalidates every point after it, so `buildForecast` returns no points and names the currencies; `buildMultiAccountForecast` withholds every line and the total together.
- **A summary over a series** (`computeBalanceSummary`) refuses when any point is unknown -- "minimum" and "goes negative" are claims about all of it.

Same currency is 1:1 *by definition* and stays a known conversion -- keep it distinguishable from the missing case, and keep a real zero rendering as a number.

**And a rate table that has not loaded is not a table missing that rate.** `useExchangeRates` starts with no rates and keeps none if the fetch fails, so every cross-currency `convert` returns `null` in both states: a surface that names the missing pair then instructs the reader to add a rate that already exists. Check `ratesUnavailable` (loading or failed) before naming any pair; `ratesFailed` tells an outage from a table still arriving. The reporting currency itself comes from `preferredCurrency` (`lib/default-currency.ts`) -- never a hand-written `|| 'CAD'`, which is how ten call sites came to disagree with each other and with the server.

**Where more than one thing can withhold a figure, the reader is told about all of them.** The bills page's Monthly Net can be incomplete because a schedule could not be priced *and* because a currency has no rate; naming one makes the reader fix it and watch nothing change. Compose the causes, do not pick between them.

## `accountsApi.getAll()` is not "the user's accounts"

In own context the endpoint returns a **union**: accounts the caller owns, plus accounts another owner shared with them jointly, told apart by `account.isJoint` (true means the row belongs to someone else; `ownerLabel` names the owner). Any screen treating the list as "mine" is wrong for whichever half it forgot.

Filter to `!a.isJoint` before offering an account as something to **give away, delegate, or otherwise re-share** -- a delegate must not pass on the access they were given. The Edit Access modal (`components/settings/DelegateAccessModal.tsx`) derives `grantableAccounts` and uses it for the grouping, the empty state, the baseline diff and the save payload -- not just the rows it draws. The server refuses a non-owned account too (`setGrants` -> 403), so every toggle on an unfiltered list is one whose save cannot succeed. The converse is not true: an account the caller owns and has shared *out* carries `jointGranteeCount` and stays assignable.

### On a joint row, *every* picker reads the owner's list -- and creation is off

A joint row may only carry the owner's reference ids, so `TransactionForm` derives `effectiveCategories` / `effectivePayees` from the grant-gated reference-data endpoint, and **everything** downstream reads those, not the caller's own `categories`: the option list, the income/expense sign lookups, and the split editor (three sites still read `categories` and each failed quietly -- a pick in `SplitEditor` wrote one of the caller's ids onto the owner's row). Split mode being blocked on the *mode button* is not the same as unreachable: opening a split row that already lives there puts the form straight into it.

Creation gets a blunter answer: **do not offer it.** `categoriesApi.create` writes to the caller's ledger, so "+ Create" on a joint account made the category in the wrong place. Until an owner-scoped create exists, withhold the creator (`jointSafeCategoryCreator`) rather than gate the button on a `categoriesCanCreate` flag the code cannot honour -- withholding is also what makes the rule hold everywhere at once, since the Category field, the transfer form's, and every split line take the same optional prop.

## Form Patterns

`useFormModal<T>` (`hooks/useFormModal.ts`) manages create/edit modal state with browser-history integration (back button closes), unsaved-changes detection via `UnsavedChangesDialog`, and form submit exposed via ref. Returns `showForm`, `editingItem`, `openCreate()`, `openEdit(item)`, `close()`, `modalProps`, `unsavedChangesDialog`.

Supporting hooks: `useFormSubmitRef` (expose submit via ref), `useFormDirtyNotify` (track dirty state). Forms use react-hook-form + Zod.

**A quick-fill copies what a row says, never the context the user is entering in.** The transaction form's Recent (history) button lists recents deduped *across accounts*, so the chosen row usually belongs to somewhere other than the account the modal was opened on. `handleQuickFill` fills payee, category, amount, description, tags and split lines, and leaves three fields exactly as the form holds them:

- `accountId` -- moving the entry to the source's account silently changes which ledger the user is writing to.
- `currencyCode` -- it is derived from the selected account by the account effect in `TransactionForm.tsx`, and a copied code would denominate the amount in a currency the account does not hold (the same "currency comes from the account, not the request" rule the backend enforces with `assertTransactionCurrencyMatchesAccount`).
- `transactionDate` -- the date on screen is the user's, typed or carried over from the remembered last entry. Resetting it to today re-dates a back-dated batch one row at a time, and the source row's own date is when *that* transaction happened, not this one.

The date case is also the worked example of the `DateInput` `setValue` trap above: the old reset never moved the visible box, only the submitted value. `TransactionForm.test.tsx`'s quick-fill block pins all three, and asserts the *submitted payload* for the date and the currency.

## Internationalization (i18n)

All user-facing strings go through `next-intl` -- no hardcoded literals. Read them with `useTranslations('namespace')`; catalogs live in `src/i18n/messages/{locale}/{namespace}.json` (locales `de`, `en`, `en-US`, `en-CA`, `en-GB`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, `xx`; the `en-*` locales are lean regional variants holding only the strings that differ from `en`; register new namespaces in `src/i18n/messages.ts`). Use `t.rich` for embedded markup and `t.raw` for template strings. Adding or changing a string means updating every locale (`src/i18n/messages.parity.test.ts` fails otherwise), then `npm run i18n:pseudo`. The language is a user preference (`LanguageSelector` in Settings -> Preferences). Full contributor flow: `src/i18n/messages/README.md`.

## React Testing (act() Pattern)

Components with async `useEffect` (API calls on mount) MUST use this pattern to avoid act() warnings:

```typescript
async function renderMyComponent() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MyComponent />);
  });
  return result!;
}

it('renders data', async () => {
  const { getByText } = await renderMyComponent();
  expect(getByText('Expected')).toBeInTheDocument();
});
```

Wrap user interactions that trigger async state updates: `await act(async () => { fireEvent.click(button); });`

When a mock rejects a Promise, the component's error handler runs in a subsequent microtask after `act()` resolves. Add a flush after the interaction to drain it:

```typescript
await act(async () => { fireEvent.click(runBtn); });
await act(async () => {}); // flush pending rejection handlers
await waitFor(() => expect(screen.getByText('Error message')).toBeInTheDocument());
```

Never use synchronous `act(() => {...})` for calls that trigger async side-effects — always `await act(async () => {...})`.

**`vitest run` does not show you the warnings.** The default reporter buffers console output and prints it only for failing tests. Use `npx vitest run --reporter=verbose` and grep for `not wrapped in act`.

**A store reset in a file's `afterEach` runs while the tree is still mounted.** Testing Library registers its `cleanup` at import time and vitest runs after-hooks in reverse registration order, so the file's own hook goes first, and a Zustand write there re-renders the mounted component outside act. Call `cleanup()` at the top of the hook. `src/test/test-hygiene.test.ts` scans for it.

**Three quieter sources of the same warning:**

- A **synchronous `render(...)` of a component that fetches on mount** -- even in a test that only asserts static copy, and even with a stubbed `mockResolvedValue([])`. Give the file one `await act(async () => { render(...) })` helper and use it everywhere.
- **Moving a `setState` out of an effect and into a data hook changes WHEN it lands, so a passing synchronous-`render` test can start failing on a component whose fetching nobody changed.** `LoanAmortizationReport` already fetched on mount, and its "shows loading state initially" test was safe for a reason that had nothing to do with that: the loader's *no-selection* branch called `setTransactions([])` synchronously inside the effect, so it committed inside `render`. Routing the same branch through `useReportData` made it resolve a promise instead, and the update moved to a microtask after the test body. The trigger for this guard is not "does the component fetch" but **"can any branch of its loaders resolve through a promise"** -- including the early-return branch that fetches nothing.
- An **awaited handler behind a click**: `fireEvent.click` is act-wrapped, but the `finally { setBusy(false) }` after an `await` lands in a later microtask. Wrap the click in `await act(async () => ...)`.
- A **bare `await new Promise(r => setTimeout(r, n))`** used to let a `requestAnimationFrame` run -- put the wait inside `await act(async () => { ... })`.

**A fixture that means "the reader's own currency" says so through the constant, not by spelling a code.** Four test files pinned behaviour against a reader on CAD -- one by hardcoding the conversion target inside its own `useExchangeRates` mock, one by giving the security `currencyCode: 'USD'` to mean *foreign*, one by setting `defaultCurrency` in a `usePreferencesStore` mock that ignored its selector (so the value never reached the component and every case silently ran on the fallback). All four passed for as long as the fallback happened to be CAD, and when it moved to USD they failed with the components correct: the fixtures had been asserting the opposite of their own names. Derive from `FALLBACK_DEFAULT_CURRENCY` (`lib/default-currency.ts`) where a case is about the reader's own currency, and pick a code that can never be the fallback where it is about a foreign one.

**A mocked selector hook applies the selector.** `usePreferencesStore: () => ({ preferences: {...} })` returns the whole state whatever it is asked for, so `usePreferencesStore((s) => s.preferences)` gets one level too deep and every read off it is `undefined` -- the component takes its no-preferences branch while the fixture claims to have set one. `src/test/test-hygiene.test.ts` scans for a zero-argument mock of any selector store.

**A mocked hook must return a stable object if the real one does.** `useRouter()` returns the same router every render; a mock written as `useRouter: () => ({ push: vi.fn(), ... })` returns a new one per call, so every `useCallback([router])` changes identity each render and an effect that also sets state loops forever (the Transactions page made 83 `getAll` calls in 300ms under its own local mock). The mock in `src/test/setup.ts` builds one router for the run; a file overriding it to observe `push` must do the same (build it lazily inside the factory -- `vi.mock` is hoisted above the `const mockPush` it closes over). Applies to any mocked hook returning an object or array.

## Testing Conventions

**Custom render** (`test/render.tsx`): Wraps components with `ThemeProvider` and a `NextIntlClientProvider` carrying every English namespace. Import `render` **and `renderHook`** from `@/test/render`, never from `@testing-library/react`.

### A missing message is a failure, and the harness is what supplies them

`useTranslations` does not throw on a missing message -- it reports the error and returns the KEY, so a toast renders `common.importComplete` instead of "Import complete" while the test passes. Vitest's default reporter buffers that stderr line away for passing tests, so it is visible only in a CI log.

The harness looked correct throughout: `render.tsx` has always loaded every English namespace from an `import.meta.glob`. But it wrapped only `render`, and its `export * from '@testing-library/react'` re-exported `renderHook` **untouched** -- so a hook test had no way to get a provider except to build one, and fourteen files did, each with a hand-picked namespace list, every one of them partial. `useImportWizard` reads `import` and `common`; its test supplied `import` alone. A hand-picked list is a snapshot of what its subject used the day it was written, and nothing fails when it rots.

So: **`renderHook` is exported from `@/test/render` too**, wrapped in the same providers, and both compose a caller's own `wrapper` *inside* them rather than replacing them (a test needing StrictMode no longer has to give up intl to get it). A nested provider is worse than it looks -- it SHADOWS the full message set for everything below it, so adding one narrows the catalogue rather than widening it.

`src/test/intl-guard.ts` turns any `MISSING_MESSAGE` / `INVALID_MESSAGE` / `INVALID_KEY` / `INSUFFICIENT_PATH` / `FORMATTING_ERROR` into a test failure, wired both as the shared provider's `onError` and as a `console.error` filter in `setup.ts` -- two doors, so a tree rendered outside the harness is still caught. `ENVIRONMENT_FALLBACK` is deliberately excluded: it is a property of the harness, fires identically for every test, and names nothing an author can act on (the same reasoning as the act guard's second React message).

`intl-harness.guard.test.ts` scans for the two ways round it: `render`/`renderHook` imported from `@testing-library/react`, and a `NextIntlClientProvider` built in a test. Its `ALLOWED_*` sets are deliberate exceptions -- tests that genuinely vary the locale, and the boot-path components defined by having no providers -- while `RTL_IMPORT_BASELINE` is shrink-only: 45 older tests that work today only because their subjects happen not to translate anything. Converting one means deleting its line.

Fix the lookup, never the symptom. Adding a code to the ignore list only restores the silence the guard exists to remove.

**A `useNumberFormat` mock spreads `numberFormatMockDefaults()`.** That hook is
mocked in ~127 files, each with a bare factory listing the formatters its
component used the day the test was written -- and a bare factory REPLACES the
module, so the literal is the hook's whole surface for that file. Nothing failed
while those lists rotted; adding a `formatPercent` call to a component turned
thirty-nine unrelated suites red with "formatPercent is not a function", not one
of which was a real defect. Spread `numberFormatMockDefaults()`
(`@/test/number-format-mock`) first and override only what the case asserts on.
The factory has to be `async` so it can `await import` the helper past
`vi.mock`'s hoisting. The defaults are functions only: `defaultCurrency`,
`numberFormat` and `numberLocale` are identity-bearing values a case states for
itself, and defaulting them would change what an existing assertion is about,
while a missing function can only ever have been a crash.

**Global mocks** (`test/setup.ts`): `next/navigation` (useRouter, usePathname, useSearchParams), `react-hot-toast`, `localStorage`, `window.scrollTo`, `window.matchMedia`.

**Test file naming:** named after the component and co-located with it, e.g. `AccountForm.test.tsx` beside `AccountForm.tsx`.

**A `vi.mock` factory replaces the whole module, so mock a module you only partly want with `importOriginal`.** A factory listing the one api object it needs turns every *other* export of that module into `undefined`, for the entire module graph under test -- and the failure is nowhere near the mock. Two shapes of it happened on the same module in one PR: a gating predicate became "not a function" and silently stopped gating, and a constant another module derives a `Set` from threw at import. Spread the original and override what you are faking:

```ts
vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: { getAll: (...args: unknown[]) => getRateChanges(...args) },
}));
```

The bare-factory form is only right when you mean to blank the module. Where a module's non-api exports are load-bearing in production code, pin the rule with a scan rather than prose -- `lib/loan-rate-changes.contract.test.ts` fails on a factory mock of that module anywhere in the tree.

## Theme

`ThemeContext` provides `theme` (light/dark/system), `resolvedTheme`, and `setTheme()`, plus `colorTheme`/`setColorTheme()` for the colour palette (`src/lib/color-themes.ts`). Both persisted to localStorage; applies `dark` class and a `data-theme` attribute (`default` = no attribute) to `<html>`; listens for system preference changes via `matchMedia`. Custom theme variables in `globals.css` `@theme` block; dark variant `@variant dark (&:where(.dark, .dark *))`.

Colour themes are pure CSS variable overrides in `src/app/themes.css` (`html[data-theme="..."]` redefines the gray/blue ramps; Tailwind v4 utilities compile to `var(--color-*)` so no component changes are needed). Chart colours go through `src/lib/chart-colors.ts`, which exposes `var(--chart-*)` strings for Recharts props; never hardcode hex colours in charts, and never theme user-chosen entity colours (tags, categories, payees).

### The boot surfaces read the theme from cookies, not from localStorage

`ThemeProvider` returns `null` until it has read localStorage, so nothing it renders can decide the first paint. The surfaces that paint before hydration -- the server-stamped `dark` class and `data-theme` attribute in `layout.tsx`, the boot splash (`components/layout/BootSplash.tsx`, hidden by `BootSplashHider` once the app mounts -- *hidden*, never removed: detaching a React-owned node outside React crashes the reconciler on the next client-side navigation), the `theme-color` viewport meta, and the PWA manifest's splash palette (`app/manifest.webmanifest/route.ts`) -- read the `monize-resolved-theme` and `monize-color-theme` cookies that `ThemeContext` mirrors on every change (`src/lib/pwa-theme.ts` owns the names and fallback colours).

A non-CSS consumer needing a palette's actual hex goes through `THEME_SWATCHES` (`src/lib/theme-swatches.ts`), never a literal; the service worker's offline fallback cannot import either, so `components/providers/OfflineFallbackSync.tsx` posts it the localized copy and computed page colours, and `src/test/sw-offline.test.ts` holds sw.js's built-in fallbacks equal to the catalog and `pwa-theme` constants. The manifest link is hand-written in `layout.tsx` with `crossorigin="use-credentials"` (a manifest fetch carries no cookies without it, which Next's static manifest convention cannot express -- hence the route handler). The link's href also encodes the theme as query parameters so a cookieless manifest update check still resolves the installed theme (cookies, when present, win); the manifest pins `id: '/'`. The OS bakes splash colours in at install time and refreshes lazily; the boot splash is the surface that follows a theme change immediately.

**A palette needs a dark block, or dark mode renders its light colours.** A theme's `html[data-theme]` block (0,1,1) beats the `.dark` defaults (0,1,0), so light-tuned values win in dark mode too. Every such theme carries an `html.dark[data-theme='x']` block (0,2,1), and `src/test/theme-contrast.test.ts` fails when one is missing or partial.

The same test holds the contrast floors -- body text, muted text, links and every chart token against their surfaces, per theme and mode, plus a minimum page/card/border separation in dark mode. Pre-existing shortfalls live in a shrink-only `KNOWN_CONTRAST_DEBT`; genuine design exceptions (midnight is black-on-black by intent) in `DELIBERATE`. Values must be literal 6-digit hex: `resolvePdfColor` accepts nothing else and silently falls back to grey. `frontend/scripts/derive-dark-palette.mjs` generates a starting point; the test, not the script, is the authority.

**The gray ramp is the theme, and it is generated.** Cards, pages, borders and most text read from the gray ramp (nearly every pixel), while the accent shows only on buttons, links and chart series -- so near-neutral ramps made themes interchangeable. The ramps come from `frontend/scripts/derive-theme-ramp.mjs`: one lightness curve shared by every theme, each theme setting hue and intensity. Consequences: contrast is a property of the curve, checked once; chroma is spent as a *share of what the hue can hold* (the gamut near white is wildly asymmetric -- a flat target tints warm themes hard and leaves cool ones untouched); hue-shifting themes concentrate the shift in the midtones.

**Intensity is not a tuning knob, it is half the identity.** Hue alone cannot separate the cream/parchment family (gruvbox vs solarized, MS Money's pale parchment); members are told apart by how strongly the paper is tinted and where the ramp's dark end goes. `theme-swatches.test.ts` therefore measures **perceptual distance** between every pair of tinted papers rather than comparing hex strings (the reported collisions differed in every byte and measured 0.0032 in OKLab); floors are set below the achievable minimum for eleven themes on one hue wheel.

Three themes are deliberately ungenerated and near-neutral: `default`, `midnight` (black AMOLED by design) and `highcontrast` (maximum luminance contrast). That policy is asserted, so the exceptions read as decisions.

**An accessibility theme is exempt from what it actually guarantees, and no more.** `colorblind`'s promise is its Okabe-Ito CHART palette, not its chrome -- leaving its greys stock made it byte-identical to `default` on every chartless screen. Its ramp is generated now; `highcontrast` stays exempt because *its* promise is about luminance, which chroma really would spend.

**Two themes that share a strategy need different jobs, not different hexes.** `highcontrast` and `midnight` were both a black page under a near-black card and read as one theme. Midnight optimises for OLED (unlit blacks, quiet borders); highcontrast for visible STRUCTURE (a panel edge you cannot locate is the accessibility failure), so its card sits well clear of its page with a bright border -- which is also why it no longer needs the `card-vs-page` exemption midnight still carries.

Changing the curve is a change to every theme at once -- expect the guard to name chart colours and accents that need re-seating, and re-seat them rather than widening the debt register.

**A theme preview is a copy of the stylesheet, and copies rot.** A browser only computes the *active* theme's custom properties, so the picker's swatches live in `src/lib/theme-swatches.ts`. `theme-swatches.test.ts` parses the CSS through the same cascade the contrast guard uses (`src/test/theme-css.ts`) and fails when a swatch disagrees with the token it claims to show, or when two themes end up with identical swatches.

**A hand-rolled CSS bar is a chart.** `chartColors` is not only for Recharts props -- a `<div>` bar, and the amount printed beside it, take the tokens through `style={{ backgroundColor }}` / `style={{ color }}`. `bg-green-400 dark:bg-green-500` stays Tailwind green on every other theme. To emphasise one bar among many, vary `opacity` on the same token rather than picking a second shade -- opacity moves toward the card in both modes.

**The tokens cover more than series colour.** `chartColors.grid` and `.axis` carry their own dark overrides (no `dark:stroke-*` needed). `chartColors.surface` is the card behind the chart -- use it for the ring around a marker dot (it must be the background, not white). `chartColors.neutral` is for unclassified data. `ui-conventions.test.ts` fails on any hex reaching a `fill`, `stroke` or `stopColor` in a component that imports recharts. Two deliberate non-targets: `summaryCards[].color` for the PDF export (`pdf-export.ts` parses hex; `var(...)` would be NaN), and colour on a *data* field, indistinguishable from the PDF case by regex. White drawn on top of a filled shape (label text in a coloured flag bubble) is contrast-on-fill and stays literal.

**Spending is not an error: default a breakdown to `chartColors.primary`, not `chartColors.expense`.** Red is loud and spent deliberately (the Monthly Totals chart, where a loss month is the point). A routine breakdown (top categories, paid-from accounts, a seasonality strip) is a magnitude comparison, so its bars take the theme accent. Keep `chartColors.income` for genuine inflows so a refund is still distinguishable. `TopGroupsPanel` and `PayeeSeasonalityPanel` are the worked examples, each with a guard test asserting no `bg-`/`text-red|green-N` and no `var(--chart-expense)` survives. `income`/`expense` remain right for a chart genuinely *about* the in/out split.

**A member series drawn beside a total takes `chartSeriesColorAsidePrimary`, not `chartSeriesColor`.** `--chart-1` is the theme accent in every palette, and so is `--chart-primary` -- so a chart drawing an aggregate line in `chartColors.primary` and starting members at palette slot 0 hands the first member the total's own colour. The helper excludes that slot from the cycle rather than deferring it (a modulo over the full palette gives it back on the tenth series). `CashFlowForecastChart` is the worked example; `chart-colors.test.ts` pins both halves. Use plain `chartSeriesColor` where there is no primary series to collide with.

## Security Notes

- **Zod:** Configured with `jitless: true` (`zodConfig.ts`) for CSP compliance -- no `new Function()`
- **Auth tokens:** Stored in httpOnly cookies (backend-managed), never in JS-accessible storage
- **localStorage is readable by any XSS, and by any scanner pointed at a public page.** A store that persists there must be listed in `src/store/persisted-storage.guard.test.ts` with the reason its contents may sit in storage, and the pre-login footprint (`auth-storage` and `monize-preferences`, both empty envelopes) is pinned there byte for byte -- the ZAP baseline's rule 120000 is silenced in `.github/zap/rules.tsv` on exactly that claim, so widening a `partialize` fails the guard rather than shipping under an IGNORE written for a smaller footprint.
- **CSP:** Per-request nonce generated in proxy, `strict-dynamic` for script-src
- **ESLint:** `no-new-func: error` enforced to prevent CSP violations
