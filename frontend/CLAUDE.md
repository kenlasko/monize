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

`src/` contains `app/` (App Router routes), `components/` (feature-organized React components plus shared `ui/`), `contexts/`, `hooks/`, `lib/` (axios API clients and utilities), `store/` (Zustand: `authStore`, `preferencesStore`, `demoStore`), `types/`, `test/`, and `proxy.ts`. Use the filesystem or LSP `workspaceSymbol` to discover specific files -- they're self-describing.

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

Feature API modules (one per feature, typed axios wrappers) live alongside `api.ts`. Use the filesystem to discover them.

### A paged endpoint is never asked for more rows than it accepts

`API_MAX_PAGE_LIMIT` (`lib/api-page-limits.ts`) is the ceiling both paged list
endpoints enforce, and neither of them clamps: `GET /transactions` (via the
backend's `PAGINATION_MAX_LIMIT`) and `GET /investment-transactions` (a
hand-written check in its controller) answer **400** to a larger `limit`. Every
one of these calls sits behind a `.catch()` that degrades to an empty list, so
the rejection never reaches the user as an error -- it reaches them as a figure
that is quietly, permanently zero. `limit: 500` on the recurring-charges panel is
issue #1229 (no subscriptions ever detected); the same literal on the investment
detail page reported every year's dividends and interest as $0.00.

Lowering the literal to the cap is **not** the fix. That trades a visible zero
for a plausible undercount, which is the worse of the two: nothing on screen
distinguishes a truncated year from a quiet one. Either walk the pages --
`transactionsApi.getAllPages` and `investmentsApi.getAllTransactionPages`, both
defaulting their page size to the constant -- or narrow the query server-side
until one page is genuinely enough. The YTD income figure does the second,
asking for `DIVIDEND` and `INTEREST` separately because that endpoint matches one
action per request, and still walks pages within each.

Prefer narrowing to walking. A page walk that pulls a whole year of rows down in
order to distil a handful of ids is a side panel paying for a report, and the
request count grows with the user's history.

`src/test/api-page-limits.test.ts` scans the tree for a call site above the cap
and checks the constant against **both** backend sources, so the layers cannot
drift apart quietly. Its known-violation register is the honest half: an entry
there is a defect being tracked with the change that fixes it, and the test fails
once the violation is gone, so a stale entry cannot outlive its fix.

### A write that moves money calls `invalidateBalanceCaches()`

`accountsApi.getAll`, `investmentsApi.getPortfolioSummary` and the budget
progress views are cached in `apiCache.ts`, and the backend computes all three
live from transaction rows -- so a write that does not drop those entries leaves
the Accounts page showing the pre-write number. Navigating away and back does not fix it:
the page refetches on mount and the refetch is served from the same cache, so
only a browser reload clears it. Call `invalidateBalanceCaches()` (both
prefixes at once) after any write that adds, removes, re-dates, re-prices or
voids a transaction -- and note that "goes through `transactionsApi`" is not the
test. Posting a scheduled transaction, editing splits (a split can carry a
`transferAccountId`, so the counterpart lands in an account the parent never
named), an investment trade hitting its INVESTMENT_CASH account, and a QIF/OFX/
CSV/MNY import all write transaction rows from their own modules. That omission
on `scheduledTransactionsApi.post` is the bug this rule came from;
`src/lib/balance-cache.guard.test.ts` now scans for it.

**The prefix list inside the helper is the other half of the rule.** It covers
`accounts:`, `investments:` and `budgets:` -- three views of the same rows. A
categorised expense moves a budget's progress exactly as it moves the account's
balance, and `budgets:dashboard` (30s) and `budgets:cat-status:*` (60s) used to
survive the write, so the toast said saved while the remaining-funds figure
beside it was pre-write. Adding a cached family that reads transaction rows means
adding its prefix in `invalidateBalanceCaches` in the same change;
`apiCache.test.ts` pins the set, both what it drops and what it leaves alone.

Pinning the set is not enough on its own, because that is what was green while
`budgets:` was missing from it: the pinned set matched the helper, and neither
knew about the new family. So `cache-prefix-classification.guard.test.ts` scans
`src/` for every prefix any cache call uses and requires each one to be listed as
transaction-derived (and therefore dropped) or as reference data (and therefore
kept). A prefix in neither list fails, which forces the decision at the moment it
is cheap to make. The list also fails when it names a prefix nothing uses any
more, so it cannot drift into fiction.

Where the write can touch anything -- undo/redo, an AI assistant action, a
backup restore -- use `clearAllCache()` instead; no prefix is narrow enough to
be correct. This matters most for `notifyUndoRedo`/`notifyAiAction`: they exist
to make mounted pages refetch, and a refetch served from a stale cache makes
the whole signal a no-op.

## Proxy (`src/proxy.ts`)

This is Next.js middleware (NOT the deprecated middleware pattern from this project's conventions). It handles:

- **API routing:** `/api/*` proxied to `INTERNAL_API_URL` (default `http://localhost:3001`)
- **CSP nonce:** Per-request nonce generated in `x-nonce` header, used by Next.js for inline scripts
- **Auth redirects:** Unauthenticated requests to protected routes redirect to `/login`
- **Security headers:** CSP with `strict-dynamic`, nonce-based script-src
- **Public paths:** `/login`, `/register`, `/auth/callback`, `/forgot-password`, `/reset-password` (no auth required)

## Component Patterns

- All interactive components use `'use client'`. Server components are the default for pages/layouts.
- Use dynamic imports for heavy components: `dynamic(() => import('./Chart'), { ssr: false })`.
- `ProtectedRoute` (`components/auth/ProtectedRoute.tsx`) wraps authenticated pages.
- **No `setState` in `useEffect`** — ESLint rule `react-hooks/set-state-in-effect` is enforced. To reset child state when a prop changes (e.g. on a dialog open transition), use the "info from previous render" pattern (track the prop in `useState` and update during render).
- **Dialogs use `Modal`** (`components/ui/Modal.tsx`) — handles Escape, focus trap, body scroll lock, focus restore, and stacked-modal popstate. Opt into `pushHistory` so the browser back button also closes. `ConfirmDialog` forwards `pushHistory` for stacked confirm flows.

## Reusing existing UI patterns

Each of these exists once. Use it; do not hand-roll a second one. Every rule here was added after an agent wrote the generic version and a human had to point it out.

### A panel card is `Card` / `CARD_CLASS`, never an inline class trio

`components/ui/Card.tsx` is the one card surface -- background, radius,
shadow, and the border that keeps a card legible on themes where the weakest
shadow disappears. Use the `Card` component where a plain wrapper works
(`padding="md"` matches the widget shell) and `CARD_CLASS` where the element
already exists (a table shell with `overflow-hidden`). The old inline
`bg-white dark:bg-gray-800 rounded-lg shadow` trio survives in a recorded,
shrink-only baseline in `ui-conventions.test.ts`; converting a file means
deleting its baseline line, and new code takes the primitive from the start.
Everything in it stays on the gray ramp so the colour themes re-skin it --
never add a literal hex or an off-ramp hue to a card.

**A theme with a strong border is a test the rest of the app has to pass.**
Ten dashboard widgets drew the borderless trio by hand while thirteen went
through `WidgetCard` -> `Card`, so half the dashboard had an edge and half did
not. Nobody could see it while the border was `gray-200`; raising
`highcontrast`'s to `#b0b0b0` turned it into alternating outlined and
un-outlined panels. All twenty-three now resolve to `CARD_CLASS`.

The tempting fix is the other one -- drop the border so everything matches the
widgets that had none -- and the numbers say no. Card-versus-page luminance is
1.045 in `default` light, 1.044 in `midnight` and exactly **1.000** in
`highcontrast`, whose page and card are both pure white. In those three the
border is the only thing that defines a card at all, so removing it does not
make the dashboard consistent, it makes the panels disappear. Every other
theme clears the guard's 1.15 separation floor and would have survived it,
which is exactly why this is worth writing down: the change looks safe from
any theme except the three it breaks.

### A category's colour and icon are inherited, and drawn by `CategoryGlyph`

A category shows its own colour and icon, or the nearest ancestor's when it
sets none. Both are resolved server-side in one walk up the ancestry
(`effectiveColor` / `effectiveIcon`), so read `category.effectiveIcon ??
category.icon` rather than `category.icon` -- the raw column is only what this
row set, which is null for most leaves.

`components/categories/CategoryGlyph.tsx` draws the result: the icon when
there is one, the colour dot otherwise, dimmed when the value came from an
ancestor. Never interpolate `category.icon` into text -- it is a name like
`shopping-cart`, so `{category.icon} {name}` renders the name of the icon
instead of the icon, which reads as a typo rather than a missing feature. That
is what the detail header and the subcategory table both did.

A surface holding a *joined* category row (a transaction, a payee's default
category) has no inherited value at all, so it reads
`buildCategoryIconMap` / `buildCategoryColorMap` (`lib/categoryUtils.ts`) built
from the full category list, exactly as the register does.

### A brand favicon is `BrandLogo`, addressed by its entity's wrapper

`components/ui/BrandLogo.tsx` renders a cached favicon with the neutral badge
fallback, and owns the one rule that matters: the bytes always come from our
own backend, never a third party, so drawing a logo cannot leak which
institutions or payees a user has. `InstitutionLogo` and `PayeeLogo` are thin
wrappers that only say which `/:id/logo` route to read, gated on the entity's
`hasLogo` so a list of icon-less rows issues no requests at all. A 404 (no icon
cached, or the fetch failed) lands on `onError` and shows the same badge, so the
two "no image" states look identical to the reader. Adding the treatment to a
third entity means a wrapper, not a second component.

### A status pill is `Badge`; table chrome is `Table.tsx`

`components/ui/Badge.tsx` is the small status pill -- a count, a state, a
label beside a name. The shape was hand-rolled about fifty times in six
padding combinations with every colour pair spelled out at the call site.
Pass `variant` and `size`; pass `as="button"` where the pill is also a
control, rather than nesting a button inside a span. It deliberately does not
absorb the pills whose colour *means* something -- `CategoryPill`,
`AccountTypePill` and `SCHEDULED_KIND_CHIP_CLASSES` are each already one
source of truth for their mapping, and the guard exempts them by name rather
than baselining them.

`components/ui/Table.tsx` is constants (`TABLE_CLASS`, `TH_CLASS`, `TD_CLASS`)
plus thin `Th`/`Td` cells, not a `<Table>` wrapper: these tables are hand-laid
with colspans, sticky cells and per-density padding, so a component owning the
markup would be fought everywhere. `SortableHeader` deliberately stays off
`TH_CLASS` -- about twenty-five report tables draw a lighter, non-upper-case
header inside a `text-sm` table, and folding it in would restyle every report
under cover of a refactor.

### The card shadow is `--shadow-card`; the bare `shadow` reads no token

A Tailwind v4 trap worth knowing before you try to restyle elevation: the
bare `shadow` utility is a legacy alias with the stock value compiled into
it, so redefining `--shadow-sm` in `@theme` does not touch it. It changes
`shadow-sm`, which in this codebase is worn almost entirely by form fields --
so that override puffs up every input and leaves every card exactly as flat.
The mistake is invisible in the source and only shows in the built
stylesheet, which is why `ui-conventions.test.ts` fails on a `--shadow-sm`
redefinition. Card elevation goes through `--shadow-card`, worn by
`CARD_CLASS`.

### A focus ring is `focus-visible:`, and a hover animates

`focus:ring-*` paints on a mouse click as well as a Tab, which is the most
visible unfinished-looking detail a UI can have. Use `focus-visible:` on
anything clickable. Text inputs are the one exception, in `inputBaseClasses`
and the element selectors in `globals.css`: a field showing its focused border
after a click is telling the user where their typing will go.

Row hover comes from `HOVER_ROW_ON_CARD` / `HOVER_ROW_ON_PAGE` in `Card.tsx`,
not a hand-picked grey -- there were twelve variants of one decision, and the
half most call sites forgot was the transition. A hover that snaps reads as a
redraw. Pair any new transition with `motion-reduce:transition-none`.

Both rules carry shrink-only baselines in `ui-conventions.test.ts`; converting
a file means deleting its line there in the same commit.

### A dialog is titled through `Modal`, never by a hand-rolled heading

`Modal` takes `title` (and optional `description`, `footer`, `padding`), draws
the standard header and wires `aria-labelledby`. Before it existed all 74 call
sites drew their own heading in eight different treatments, and -- the part
that mattered -- none of them reached the dialog, so every dialog announced
itself as an unnamed region. `padding` defaults to `none` and leaves children
unwrapped, because several call sites make the panel their own scroll or flex
parent. A header that is genuinely bespoke (ConfirmDialog puts an icon beside
its heading) stays on the baseline deliberately rather than being flattened.

### An empty list renders `EmptyState`

`components/ui/EmptyState.tsx` (glyph, title, optional description and
action) replaced fourteen hand-rolled `text-center py-12` blocks in three
drifting variants. `ui-conventions.test.ts` bans the container fingerprint
outside the component, with no grandfathered baseline.

### An auth screen renders inside `AuthShell`

`components/auth/AuthShell.tsx` is the single shell for login, register,
forgot/reset/change-password, verify-email and setup-2fa: transparent brand
mark, title/subtitle, a notices slot, and the shared `Card` around the body
(`plain` for a bare status line). The language picker and version line are
opt-in props. Use `/icons/monize-logo-transparent.svg` everywhere in the UI
-- the boxed `monize-logo.svg` bakes in a white background rect and renders
as a white square in dark mode. Guarded in `ui-conventions.test.ts`.

### Navigation links and their icons live in `lib/nav-links.ts`

The header's link arrays and the per-route Heroicon map are declared side by
side so `nav-links.test.ts` can hold "every nav route has an icon". The
mobile drawer and the header dropdowns render `NAV_ICONS[href]`; the desktop
top-bar pills stay text-only on purpose (the bar collapses at `xl`, and six
leading icons overflow 1280-1440px laptops). A new route means one entry in
the array and one in the map, in the same file.

### Account-type colour and icon come from `lib/account-type-meta.tsx`

`ACCOUNT_TYPE_META` maps each account type to its pill classes and Heroicon;
render `AccountTypePill` / `AccountTypeIcon` rather than re-deriving either.
`ui-conventions.test.ts` fails on a second type-to-pill-class mapping. An
account with no institution shows its type icon in the brand-badge slot
(`InstitutionLogo`'s `fallbackIcon`), not a generic glyph.

### A register's category chip is `CategoryPill`

`components/transactions/CategoryPill.tsx` owns the colour-mix pill and the
category's optional icon (drawn via `getIconComponent`, the same way tag
chips do). Categories carry `icon` end-to-end -- `CategoryForm` collects it
through the shared `IconPicker` (whose `onClear`/`clearLabel` props make "no
icon" a real state) -- so a surface that shows a category name with its
colour should show its icon too, and an unset icon renders nothing, never a
default glyph.

### A dashboard widget header carries its icon from `widget-meta.tsx`

`WIDGET_ICONS` gives every registered widget a distinct Heroicon
(`widget-meta.test.tsx` enforces coverage), rendered as the tinted
`WidgetIconPuck` -- blue ramp only, so the themes re-tint it. Widgets on
`WidgetCard` get it from their `widgetId`; a widget that draws its own
header uses `WidgetHeading`, which also owns the title-button markup the
core widgets used to duplicate per loading/empty/loaded branch.

### Date entry -- `DateInput`, never a raw `<input type="date">`

`components/ui/DateInput.tsx` is the only place a raw date input is allowed, and `ui-conventions.test.ts` fails the build if another appears. It carries the lenient parsing of what someone typed, the keyboard shortcuts, and `CalendarPopover` -- the custom picker whose icon is the only one on screen, because the desktop field is no longer a native date input at all. A bare `<input type="date">` gets none of that, and hands the user the browser's segment-jumping entry instead. 32 components use `DateInput`; yours should too.

**On a desktop it is a text box, whatever the user's format preference is.** It
used to render a native `<input type="date">` for the `browser` preference --
which is the default, so most users got it -- and the shared text input for
everybody else. That is one component behaving as two: the native control jumps
to its own next segment after two keystrokes, takes only the first two digits of
a year typed into a partly-filled field, and cannot be handed `9-14` at all
(issue #1201). The pointer decides the mode now, not the format: touch keeps the
native picker, because a phone's date wheel is the better control there and
nobody types a date on one by choice.

**`browser` is not a pattern, and nothing below `useDateFormat` should see it.**
`datePattern` off that hook is the concrete arrangement (`MM/DD/YYYY`,
`DD.MM.YYYY`, ...), resolved from the locale by `resolveDateFormatPattern`
(`lib/date-parse.ts`). Parsing what someone typed is impossible without it: `7/8`
is 8 July in one arrangement and 7 August in another, and a sentinel cannot
answer that question. `parseFlexibleDate` takes the pattern for exactly this
reason; `parseDateFromFormat` stays strict, for a value that should already be
canonical.

**A partial entry is completed, and an unreadable one changes nothing.** A day
and month take the year from the date the field already holds (today when it is
empty), and a lone number is a day in the month on screen. Text that names no
real date restores what was there -- clearing the box is the only way to mean
"no date". None of that happens on the keystroke: the lenient reading waits for
blur or Enter, because `9` is a valid day on its own and announcing it mid-word
sends a report off fetching a date nobody asked for.

**A screen that hosts a date field does not answer a load with a second tree.**
`if (isLoading) return <Skeleton/>` returns a different tree, and React unmounts
whatever the previous one held at that position -- including the field being
typed into. Render the load and error states *inside* the one tree the component
always returns. Duplicating the controls block into the second `return` is not a
fix and looked like one: `CashFlowReport` did that, and its two trees put the
block at different child indexes, so React reconciled it against the summary
cards and unmounted it anyway. `ui-conventions.test.ts` fails both shapes for any
component that pairs a date control with a `useReportData` loading flag -- the
flag the date change itself re-triggers. A one-shot prerequisite load (the report
*forms*' `isLoadingData`) is a different thing and is deliberately not policed:
it resolves before the date field exists and never fires again.

### Currency entry -- `CurrencyInput`, never a raw number input

`components/ui/CurrencyInput.tsx` is the only way to take a money amount. It is a `type="text"` field with `inputMode="decimal"`, not `<input type="number">`: it filters non-numeric characters as you type, formats with thousands separators and two decimals on blur, strips the commas and clears a `0.00` on focus so the field is immediately typable, parses back through `parseAmount` so the value reaching the form is rounded to cents, and re-syncs when the parent changes the value externally (a form reset, or a category auto-signing the amount negative). It also accepts inline calculator expressions -- typing `100*1.13` and blurring or pressing Enter evaluates it in place instead of submitting the form -- and offers a calculator modal via the in-field icon. Props worth knowing: `prefix` for the currency symbol, `allowNegative` (default true), `allowCalculator` (default true), `allowSignToggle` for the in-field `±` button. 22 components use it; yours should too.

A raw `<input type="number">` gets none of this and adds spinner arrows, scroll-wheel value changes, and locale-dependent decimal handling. For non-money numbers -- share counts, rates, percentages, day-of-month, retention counts -- use `NumericInput` instead: same filtering and blur formatting, but with `decimalPlaces`, a `suffix`, `min`/`max`, `allowNegative` defaulting to false, and no calculator.

`ui-conventions.test.ts` now fails the build on any `<input type="number">` or `<Input type="number">`. It resolves the tag each `type="number"` belongs to rather than grepping the file, because recharts' `<XAxis type="number">` declares a continuous scale and appears in about twenty chart components -- those are not inputs and are deliberately left alone.

Both components take a *number*, not the field's text: `value: number | undefined` and `onChange: (value: number | undefined) => void`. Two consequences worth knowing before converting a form:

- **`register()` does not fit.** Wrap the field in react-hook-form's `Controller` and pass `value`/`onChange`/`onBlur`/`ref` (plus `name={field.name}`, or a `name`-based test selector stops matching). Where the form's schema stores the field as a string, bridge inside the render callback rather than restructuring the schema.
- **`min` clamps while typing; `max` only on blur.** Every prefix of a number is smaller than the number, so a ceiling must not fire mid-word -- `max={31}` would otherwise hand the parent 31 while the user is still typing `50`. That also means `min` is wrong for a multi-digit floor (`min={2}` eats the `1` of `14`): leave it off and let Zod report. Where a value outside the range must be *discarded* rather than trimmed -- a budget alert threshold, a months remainder that cannot roll into years -- keep the explicit range check in the component's `onChange`; `MortgageFields` and `BudgetWizardStrategy` are the worked examples.

Give each field an explicit `id` when two on the same screen share a label. Both components derive `id` from the label text, so a "Years"/"Months" pair rendered twice (term and amortization) collides and every label points at the first input.

**A field that hands back its own value has not been edited.** Both components re-parse whatever text is on screen on blur (and `CurrencyInput` on every keystroke and on Enter), and for a field nobody touched that text *is* the parent's value formatted to two decimals. Reporting it is invisible to a parent that only stores the number and destructive to one that does more: the FX panels derive an exchange rate from the converted total and mark it user-overridden, so tabbing through the field replaced the fetched 10dp rate with one reverse-engineered from the cents-rounded total (`1.365234` became `54.61 / 40 = 1.365250`) and stopped the date effect re-fetching -- a rate the user never chose, posted against a date it was never quoted for. Both components now notify only when the value actually moved (`notifyIfChanged`), and both carry a blurred-untouched regression test.

The general rule that follows: **an `onChange` that does more than store the number must also be idempotent**, because a controlled field can legitimately re-report the same value. Guard the side effect on the value having changed at the handler too -- `handleConvertedTotalChange` and `handleConvertedTotalOverride` both return early when the incoming total already equals the derived one -- rather than trusting the field to be the only caller.

### A clickable table row -- `useLongPress({ onClick })`

`useLongPress` takes an `onClick` alongside `onLongPress` for exactly this: a plain click runs the row's primary action, a 750ms press (or right-click) opens the mobile action sheet, and a click that followed a long-press is suppressed. Spread `getRowHandlers(item)` on the `<tr>` and add `cursor-pointer`. The accounts, payees, tags, categories and securities lists all do this.

Do not put the click on a button around the symbol or the name instead. It looks identical and is not: the rest of the row -- all the cell padding, every other column -- becomes dead, and clicking a row "does nothing" for the majority of its area. Controls *inside* the row (a favourite star, `RowActions`) must `stopPropagation` so they act on themselves; both already do.

### A detail page returns to its list above the title, and switches with the caret beside it

Every detail page in the app -- an account, a payee, a category, a security, a
report -- carries the same two controls: a chevron and "Back to <List>" on the
line *above* the title, and `EntitySwitcher`'s caret immediately after the
title, which jumps straight to another entity of the same kind. The way back is
not an action on the thing being viewed, so it does not belong among the
buttons on the right; that is where it drifted to on the report pages, and one
of them grew a breadcrumb instead, so the section read as three pages that
happened to share a URL prefix.

For reports the pair is `BackToReportsLink` and `ReportDetailHeader`
(`components/reports/`), used by the generic `[reportId]` renderer and the
custom and investment viewers; the GEM report has its own header and mounts the
two directly. `ReportSwitcher` builds the route itself -- an id in that menu
*is* a path under `/reports/` -- so no call site spells it out.
`ui-conventions.test.ts` scans for a hand-rolled back-chevron-to-`/reports`.

**Two switchers on one line means at least one of them says its name.** The GEM
report carries both: the report caret beside the title, and a scenario picker
one level in. Two bare chevrons a few pixels apart are indistinguishable, so
`EntitySwitcher` takes `triggerText` and the scenario one reads "Scenario ⌄".
The bare caret stays the default -- it is unambiguous when it is the only one.

**A detail page's actions sit on the title row, not in a row above the body.**
`AccountDetailShell` takes `headerActions` for the type-specific ones, beside
the standard Export/View Transactions/Reconcile/Edit set; the investment view
had grown its own `flex justify-end` row instead, so that page had two action
rows and neither was where every other detail page puts one. Type-specific
actions therefore live in a small component the page passes as `headerActions`
(`InvestmentDetailActions`), and any signal they need to send the body -- a
price refresh that the body must re-fetch after -- travels down as a prop
(`refreshKey`) rather than keeping the button in the body to stay near its own
state. A button that is `size="sm"` in a report toolbar takes `size="md"` in
that header, or it stands a few pixels short of everything beside it.

A switcher list too long to scan takes `group` on its items
(`ReportSwitcher` groups by the section the Reports page files each report
under, in `REPORT_CATEGORIES` order). Sections follow the order their first
item appears in, so ordering happens in the caller, and a section whose rows
are all filtered out takes its heading with it.

### A category picker lists every category in tree order as "Parent: Child"

However a surface selects a category -- the transaction form's Combobox, a
switcher, a reassign target -- the option list is the one shape: built from
`buildCategoryTree` (each parent followed by its children), a child labelled
`Parent: Child`, a top-level category by its bare name, and **every row
selectable, parents included**. A bare leaf name is ambiguous once two parents
own the same leaf, and a picker shaped differently from the transaction form's
reads as a second component. `CategorySwitcher` carries the regression tests.

**A picker the user types into creates through `createCategoryFromInput`
(`lib/category-create.ts`), and never inline.** It owns title casing and the
`Parent: Child` shorthand -- create or reuse the parent, then the child under
it -- and returns every row it created so the caller can append all of them to
its own list, not only the leaf. Three inline copies of that parsing existed
and the scheduled transaction form's had none of it, so `travel: hotels` became
a child of Travel in two fields and one flat category named "Travel: Hotels" in
the third. The guard in `src/test/ui-conventions.test.ts` fails on a second
`categoriesApi.create` call site outside the helper and the Categories page's
own full create form.

Whether a picker *offers* to create is a property of the surface, not of the
field: a form that can create passes the creator to **every** category picker it
renders, its split lines included. `SplitEditor`'s lines silently discarded text
matching no category while the Category field beside them offered "+ Create"
(issue #1187) -- the split copy was the same `Combobox` missing
`allowCustomValue` and `onCreateNew`. An asynchronous create addresses the row
it came from **by id**: rows can be added, removed or reordered while the
request is in flight, and the new category's `isIncome` comes from what the
creator returned, since the parent's appended list has not re-rendered the
editor yet.

### An account balance is coloured by its sign -- `balanceColor`, never by account type

`balanceColor` (`lib/format.ts`) is the one rule: negative is red, everything
else is the neutral body colour. Do not add `|| isLiability` (or any
`accountType` test) to that condition. A credit card sitting at a credit balance
is not in the red, and the transactions sidebar painted every liability red
regardless of what it held; the same branch also left an overdrawn chequing
account looking fine on the days its sign was the only thing that had changed.
The sign already carries the meaning -- the account type adds nothing the number
does not say.

`gainLossColor` is the sibling for a *change* in value (green when up), not for
a balance: most accounts are in credit most of the time, and green there spends
the emphasis on the ordinary case.

### A scheduled transaction has four kinds, not two -- `scheduledKind`

`amount < 0` / `amount > 0` answers only half the question, and the half it
leaves out is invisible: a **transfer** between the user's own accounts is
neither a bill nor a deposit, and an amount of exactly **zero** is a deliberate
placeholder for something whose amount is not known until it arrives (a credit
card bill, a variable utility). A ternary on the sign paints the zero green as a
deposit, and a `!st.isTransfer` filter deletes the transfer from the screen
entirely -- which is how a scheduled transfer the Bills list showed was missing
from both calendars (issue #1124).

Classify with `scheduledKind` (`lib/scheduled-kind.ts`), which returns
`bill | deposit | transfer | reminder`, and colour from
`SCHEDULED_KIND_CHIP_CLASSES` / `SCHEDULED_KIND_AMOUNT_CLASSES` so every surface
reads the same way -- the two calendars, the dashboard widget's type badge, and
the budget panel all go through it. Pass the *effective* amount
(`nextOverride?.amount ?? amount`) where the surface is about one occurrence.

A surface listing *occurrences* -- a calendar, an upcoming list -- includes every
active schedule whatever its kind. Filtering by kind is for a surface genuinely
about bills or about deposits (the Bills/Deposits tabs, the budget's committed
spending), and there a `reminder` belongs in neither bucket rather than silently
in the positive one -- except where the surface is about *what the user still has
to pay*, where a zero-amount reminder counts as an upcoming bill contributing
nothing to the total (`BudgetUpcomingBills`).

A **money total** is the separate decision, and it is not the same list as the
count: a transfer is counted as something coming up but its amount never joins a
bills-and-deposits sum, or the same money is reported twice
(`UpcomingBillsReport`'s `summary.totalOf`). A reminder's zero is a placeholder,
not a measurement, so it is never given a `+`/`-` sign or a red/green treatment
that would read as a real amount.

### A stored occurrence price is an instruction; the market close is a suggestion

An investment price *or quantity* the user saved -- on a scheduled occurrence's
override, or carried from the schedule -- is a decision, not a stale default, so
live market data may be *offered* beside it but never *written over* it. Both
dialogs that fill a price obey this. `OverrideEditorDialog` fills the field from
the latest close only when the occurrence has no price of its own and the user
has not typed a total (`hasStoredPrice` false, `userEditedTotal` false, field
empty), otherwise exposing an explicit "use latest close" action;
`PostTransactionDialog` skips its market-price refresh when the prefill came from
a per-occurrence override (`investmentFromStoredOverride`, keyed off a stored
price *or quantity* -- an override that set only the shares must not have them
rescaled) or when the user has edited any field, keeping the base-schedule DCA
refresh only for a price that is a creation-time snapshot.

Both fills are **total-first** (issue #1148): they preserve the amount invested
and re-derive the share count, so the override editor's "use latest close" button,
its keystroke path (`handleInvestmentPriceChange`), and the post dialog's refresh
all book the same quantity and total for the same price -- the button used to be
quantity-first and was the odd one out. The two guards **still differ**, not
because the precedence differs but because the state each fill runs against does,
and the guard protects the field the fill would clobber in that state. The
override editor auto-fills only on an occurrence with no stored price, where the
price field is empty and no total has been computed yet: with no total present the
total-first fill degrades to deriving the total from the shares, which preserves a
quantity-only edit -- so it blocks only once the user has typed a **total**
(`userEditedTotal`), the one state where a total is present and the fill would
rescale the quantity beside it. The post dialog's refresh carries the scheduled
total, so a total is always present and the fill always rescales the shares --
which is why it must block once the user has typed **anything**
(`userEditedInvestment`), a typed quantity included. The fetch being asynchronous
is what makes this matter: it can resolve
*after* the dialog opens, and a value typed in the meantime (price still blank,
so an "is the field empty" check alone lets the fill through) is the user's own
instruction. The defect all of this prevents is a silent re-price: reopening an
override to change only its date, posting an occurrence whose price the user set,
or having a value you just typed re-derived under you, must not move money to
today's close. A NaN or zero close is not a usable price -- normalize it to null
where `marketPrice` is set (through `usableClose`), so the fill, the placeholder
and the latch all treat it as "no price" rather than a value.

`marketPrice == null` is three states at once -- loading, a failed lookup, and a
genuinely empty history -- so it must not gate the "no price history, enter
manually" hint: a failed lookup is not an empty dataset, and flashing the hint
mid-fetch is a lie the resolve then retracts. Each surface carries a
`priceHistoryEmpty` flag set true *only* when a request completes with no usable
close, reset false while in flight and left false on rejection; the hint reads
that flag, never the bare null.

There are three surfaces that fill these fields -- the two dialogs and
`ScheduledTransactionForm` -- and all three do the price/quantity/total
arithmetic through `lib/investmentFold.ts` (`totalFromQuantity` /
`quantityFromTotal` -- one rounding scale and one signed commission fold, so the
surfaces cannot drift on the math, only on which conversion they run). Never
hand-roll the fold inline; `lib/investmentFold.guard.test.ts` scans for the 8dp
share-precision rounding that fingerprints a hand-rolled `quantityFromTotal` and
fails for any occurrence outside the helper. State a stored price's provenance
truthfully (a price on this override reads "saved on this occurrence", one
inherited from the schedule reads "from the schedule" -- the two are different
keys, not one); and format the "latest close" copy through
`useNumberFormat().formatPrice` (a price is not money: up to six decimals,
trailing zeros trimmed by Intl), never a hand-rolled `toFixed`/trailing-zero
regex, which leaves a dangling separator in comma-decimal locales. Compose any
"Label: value" line (the transfer and category banners) in the catalog as one
string a translator can reorder, never as `{t('label')}: {value}` fragments in
JSX.

`ScheduledTransactionForm` reconciles the same way the dialogs do, and two more
invariants live here because its `Total Value` is a shown figure that submit
recomputes from `quantity * price (+/-) commission`: **the displayed total and
the persisted amount must never disagree.** So every field that moves the
economic total -- price, quantity, **commission, and the BUY/SELL action whose
sign flips the fee** -- recomputes the shown total through the same fold, and the
async close arriving mid-entry preserves an already-typed total and re-derives
the quantity from it (total-first) rather than only writing the price. And **a
market price belongs to one security**: changing the selected security clears the
auto-filled price (and the seen-market-price latch) so the new security's own
close fills the field, instead of the previous security's quote lingering because
the field is non-empty. A NaN or zero close is not a usable price -- gate the
"Latest:" placeholder on a positive `roundedMarketPrice`, never a bare
`marketPrice != null`, so it never renders as "Latest: NaN".

### Two transaction lists, two opposite delete contracts -- read the tense

`InvestmentTransactionList`'s `onDelete` **asks the parent to delete**: the list
raises a confirmation and hands back an id. `TransactionList`'s `onDeleted`
**reports a delete it already performed** -- it owns the confirmation, the
`transactionsApi.delete`/`deleteTransfer` call and the toast. The two are a few
lines apart in `InvestmentRegisterPanel`, and a handler written for the first
shape and wired to the second deleted every cash row twice: the second request
404'd on the row the first had removed, so the user got "Transaction deleted"
and "not found" side by side (issue #1192). Worse for a transfer, where the list
correctly calls `deleteTransfer` and the parent then calls the plain `delete`.

Reach for `onRefresh` to reload after a delete, and for `onDeleted` only when
you need the id itself (an optimistic removal, a counterpart to drop) -- never to
perform the delete. `ui-conventions.test.ts` scans every `<TransactionList` for
an `onDeleted` handler that deletes, in both the named and inline forms.

**The signal has to reach whatever else is derived from those rows.** The panel's
own reload is not the page: the account detail view draws the portfolio summary,
the allocation and the Holdings by Account list -- cash row included -- above it,
and a cash deposit that only reloaded the register left all three at their
pre-write figures until the page was reloaded by hand (issue #1190). Dropping the
caches is half of it; `invalidateBalanceCaches` only makes the *next* fetch
honest, and nothing mounted refetches on its own. `InvestmentRegisterPanel` raises
`onDataChanged` after every write for exactly this, and `InvestmentDetailView`
re-runs its load from it.

**Every write path on a page shares one refresh, including the ones nobody
reported.** The #1190 fix wired the account detail page's writes together and
left the Investments page's own paths as they were, so adding a cash row there
refreshed the summary, the allocation, Holdings by Account and the brokerage
register, while deleting one reloaded the cash rows alone -- the row vanished
and every figure above it kept its pre-delete value until the user pressed
Refresh. A delete is a write, and so is an undo, a redo, an AI action and a
status change; the fact that the reported symptom was a create says nothing
about which paths are broken. `useInvestmentData.refreshAfterWrite` is that one
function for the Investments page (`InvestmentRegisterPanel.afterWrite` is the
detail page's), and each write path calls it rather than reloading the list the
write happened on. When you fix a stale-figure defect, grep the surface for its
other write paths and route them through the same function in the same commit.

**A sibling that fetches for itself needs the signal as a prop, not as a
re-render.** Re-running the parent's load refreshes what the parent fetched, and
`InvestmentValueChart` fetches its own series -- so the write reaches it as
`refreshKey`, the same convention the header's price refresh uses. Two details it
cannot skip: the intraday series is served from `sessionStorage`, so a re-fetch
that trusted the cache hands back the pre-write points (drop it with
`clearAllIntradayCache` and pass `skipCache`), and the effect must gate on the
key it has already **acted on** rather than on running -- `loadData` changes
identity on every range, account and currency change, and the load effect already
covers those, so an ungated second effect fetches twice for each of them and
again on any mount under a non-zero key.

**Both registers of one account are paged, filtered and drawn the same way.**
They are one account's two ledgers a toggle apart, so a difference between them
reads as a bug even when each half is defensible on its own. The bar above the
rows is `ListTopToolbar` (`components/ui/ListTopToolbar.tsx`) -- where you are in
the list on the left, the density toggle and the list's own buttons on the right
-- and both `TransactionList` and `InvestmentTransactionList` compose it rather
than rebuilding the markup; `ui-conventions.test.ts` fails on a second call site
handing `Pagination` an `infoRight`. A pager *only* below the table is one the
reader meets after scrolling past everything it could have helped them skip,
which is what the brokerage register had while the cash register beside it paged
from above.

**A register pages from both ends, and the second one is `ListBottomPager`**
(`components/ui/ListBottomPager.tsx`). The top strip is met before the rows; the
bottom pager is where a reader who scrolled the whole page actually finishes, and
the Transactions page has ended that way for as long as it has had a pager. On a
single page it draws the count instead of an inert pager -- the opposite of the
top strip, which keeps its pager because "Showing 1-7 of 7" is the answer to "did
that filter work?", asked once, up where the filter controls are.

Which end lives where is a layout fact, not a preference: the top strip is the
card's own header row, so it belongs inside the list component, while
`Pagination` carries its own background and shadow and so must sit *outside* the
card -- inside it, it reads as a white box on a white panel. That is why the
surface draws the bottom one and passes it the same paging state it gave the
list. `ui-conventions.test.ts` fails on a raw `<Pagination>` anywhere but the two
wrappers and the four standalone list pages, and separately requires each
register surface to reference `ListBottomPager`. Nothing repeats the density
toggle down there: repeating a position is the point, repeating a control is
not.

Filtering follows the same rule with different questions: a trade is narrowed by
symbol and action (the brokerage list's own filter row), a cash row by payee and
category (`CashFilterBar`, shared by the Investments page and the account detail
page). Each register's page returns to 1 when its filter changes, and the filters
belong in the register's request key -- otherwise the rows keep answering the
previous question until something else triggers a fetch.

The chrome around them is part of "the same way": one heading (*Recent
Transactions* on both -- the toggle beside it already says which ledger), a
new-row button marked the same way on both, and the same gap between the header
and the strip. A heading that renames itself and a spacer present on one side
only made the toggle read as a navigation rather than a change of ledger. The
Investments page and the account detail page draw the same two registers, so
they take the same treatment: both page from the strip and from a
`ListBottomPager` below the rows, and neither page puts a density toggle in its
own heading beside the register's.

**A filter picker offers what the rows use, and it loads because the register is
on screen.** `useCashFilterOptions` asks
`transactionsApi.getRegisterFilterOptions` for the payees and categories the
selected accounts' rows actually reference -- a brokerage cash ledger has a dozen
payees, and offering the household's whole address book to narrow it buries them.
The endpoint reads split lines as well as parent rows (a split parent's own
`categoryId` is NULL, and the register's category filter matches split lines), and
returns the **ancestors** of every used category, because `MultiSelect` builds its
top level from `parentId == null` and drops a child whose parent is absent.
Trigger the load from the view being displayed, never from the click that reaches
it: the Investments page remembers its view, so the cash register is reachable
without that click, and gating on it left both pickers reading "No options found"
for the users who live there.

The brokerage side asks the same question of its own vocabulary:
`useBrokerageFilterOptions` (`hooks/useBrokerageFilterOptions.ts`) fetches the
actions and symbols those accounts have actually used, and the pickers offer
those rather than all twenty-odd actions. Absent or empty is "no information" --
still loading, or the lookup failed -- so the action list keeps offering
everything; and whatever is currently selected stays in the control even when the
rows no longer use it, or the list is narrowed by something the user can neither
see nor undo. **Symbols come from the rows, never from current holdings**: the
picker was built from `portfolioSummary.holdings`, so a position sold in full was
not offered, and its trades are exactly the rows somebody filtering by symbol is
looking for.

**A one-shot fetch guarded by a ref cannot also be cancelled in its cleanup.**
Both option hooks latch a `loadedKeyRef` so a re-render does not re-ask, and both
originally set a `cancelled` flag in the effect's cleanup. Under React's
development StrictMode -- which Next.js has on -- an effect runs, is cleaned up,
and runs again: the first pass claims the key and starts the only request, the
cleanup marks it cancelled, and the second pass finds the key already claimed and
starts nothing. The response is then discarded and the pickers sit empty for the
whole session, which is what "No options found" and an Action picker still
offering all twenty were. Let the ref decide instead -- adopt the response while
`loadedKeyRef.current === key` -- which also drops an answer a newer selection has
overtaken. Testing Library does not double-invoke effects, so this class of defect
is only caught by a test that renders the hook inside `<StrictMode>`; both hooks
carry one.

**A register that has rows keeps them while the next page loads.** Answering a
filter or page change with a skeleton swaps a table for three lines, the page
shortens under the reader, and the browser scrolls to the top -- which is what
applying a filter on the account detail page used to do. Gate the skeleton on
there being nothing to show yet (`loadedKey === null`), not on a request being in
flight; the Investments page's `hasLoadedRef` is the same decision.

**A pager stays drawn when a filter narrows the list to one page.** The buttons
are inert there, but the line beside them -- "Showing 1-7 of 7 transactions" --
is the answer to "did that filter work?", and hiding it exactly when a filter has
just been applied takes the count away at the moment it is being read.

**A nav tab is lit by the section a page belongs to, not by an exact path.**
`isNavSectionActive` (`lib/nav-section.ts`) is that one predicate, used by the
header and the mobile drawer: `/accounts/<id>` is Accounts, `/securities/<id>` is
Tools. Comparing the pathname to the href unlit the tab the user had just come
through, so the bar said nothing about where they were. The boundary is a slash,
so `/accounts` never claims `/accounts-archive`.

**A cash register holds rows that are not cash transactions, and one function
decides which editor each gets** -- `editCashRow` (`lib/cash-row-edit.ts`). A
trade's cash leg (`linkedInvestmentTransactionId`) is edited as the *trade*: its
amount, date and payee are consequences of the trade, so a cash form over it
offers to change figures it does not own. A transfer is fetched in full first,
because the list payload does not carry its counterpart. Everything else opens
on the row as listed. The account detail page's register had only the third
case, which is how clicking a trade there opened a cash form -- and a failed
lookup for a trade opens nothing rather than falling back to the cash form,
since that fallback is the same defect arriving by another door.

**A modal this page already mounts is opened, not navigated to.** Clicking an
investment-linked row in the cash register pushed `/investments?edit=<id>`, which
remounted the page, scrolled it to the top and refetched every section before the
dialogue appeared -- to reach a form that was mounted the whole time. Fetch the
row and call the modal's own `openEdit`; keep the URL parameter for arrivals from
another page.

**A form's account list is a property of the form, not of the page that opened
it.** The same `InvestmentTransactionForm` is mounted from the Investments page
and from an account's detail page, and only the first passed `allAccounts` -- so
"Funds From (optional)" on the detail page offered nothing but the account's own
linked cash, which is the one option the field exists to replace (issue #1191).
When a surface mounts a shared form against a narrower scope, narrow the *scope*
props (`accounts`, `defaultAccountId`) and keep supplying the wide ones. A failed
lookup there stays `undefined`, never `[]`: the form reads undefined as "not
supplied" and falls back, while an empty array is a claim that the user has no
other accounts.
### Row density is remembered per view, by one store -- `useDensityPreference(view)`

Each surface keeps its own level -- Accounts at normal while the transactions
register is dense -- but exactly one store holds them all, under one key. Read
it with `useDensityPreference(view)` (`@/store/densityStore`), which returns
`density`, `setDensity` and `cycleDensity` already bound to that view; pass the
level *down* to rows and `RowActions` as a prop, but never accept a change
callback back up. `DensityView` is a union, so a mistyped view is a compile
error rather than a bucket nothing ever writes to.

It was thirteen stores before issue #1193: eleven pages each owning a
`useLocalStorage('monize-<view>-density')`, `AccountList` hand-rolling a
twelfth under `accounts.filter.density`, and three surfaces -- the investment
account detail register among them -- persisting nothing at all, so they fell
through to a `useState('normal')` that reset on every remount. The defect was
never that the levels differed per view; it was that each surface reimplemented
storing them and some forgot. `densityStore.ts` migrates all twelve legacy keys
into their own views and deletes them, so nobody loses a setting on the release
that fixes losing settings.

**A component rendered from more than one surface takes a `densityView` prop.**
`TransactionList` is mounted from six places and `InvestmentTransactionList`
from two; the prop defaults to the owning page's view, so a caller that is not
that page and forgets it silently shares the register's bucket -- two unrelated
screens moving together, with nothing on screen to explain why. The guard fails
on a call site outside the owning page that does not pass one.

The preference is browser-local rather than a `user_preferences` column on
purpose -- a 13" laptop and a desktop monitor signed into the same account
should not have to agree -- and it is classified in
`persisted-storage.guard.test.ts` like every other localStorage-backed store.

**The button is `DensityToggle`, and the strip above a table is
`DensityToggleBar`** (`components/ui/DensityToggle.tsx`). Eleven surfaces drew
it by hand: seven byte-identical, the rest differing only in size and placement,
but each reading its label from its own namespace under one of five key shapes.
That is how the *translations* drifted without anyone noticing -- fourteen of
nineteen locales had at least one density string that disagreed with itself
across surfaces, and Korean had six different words for "Dense". The copy now
lives once, at `common.density.*`. Pass `size` (`sm` above a table, `md` beside
`text-sm` toolbar controls, `chip` in a row of filter chips) and `className` for
positioning; never colour or padding.

**Cell padding is `useTableDensity(density, scale)`**, whose table is data in
one file. There were five copies of it, agreeing at some levels and silently
disagreeing at others, so a deliberate difference was indistinguishable from a
drifted one. Two scales are deliberate: `default`, and `wide` for a register
with enough columns that the phone inset has to give way before the data does
(the investment register). A third variant means a named entry there, not a
`switch` in a component.

None of those files was wrong on its own, which is why the rule is a scan:
`density-preference.guard.test.ts` fails on a local density `useState` (typed or
bare), a density key at any storage call site, an `onDensityChange` prop, a
`cycleDensity` that does not come from the store, a shared list rendered without
a `densityView`, a second copy of the toggle markup, a density string in any
catalog but `common`, and a hand-rolled padding `switch`.

### Asking for the Balance column and supplying the balance are one decision

`<TransactionList isSingleAccountView>` draws the Balance column, and the number
in it is the backend's `startingBalance` run down the page -- the list derives
nothing on its own, so the column arrives empty without it. `InvestmentRegisterPanel`
read the rows off `transactionsApi.getAll` and dropped the `startingBalance` that
came with them, so the account detail page's cash register showed "-" on every row
while the Investments page's copy of the same register was right (issue #1188).

Take both from the same response and adopt them in the same block: a starting
balance is computed for one page of one account and means nothing beside another
page's rows, and a failed reload that keeps the rows has to keep the balance too.
`ui-conventions.test.ts` fails any `<TransactionList>` that sets
`isSingleAccountView` without passing `startingBalance`.

### An overdue-reconciliation window is the server's number, never the client's

Whether an unreconciled row is *overdue* is decided by `classifyStaleRow`
(`lib/stale-reconciliation.ts`), and it takes the boundary date as an argument
because the server owns it: every response that asks for a classification
carries `overdueBefore` (and `staleAfterDays` for the copy that names it), from
`STALE_UNRECONCILED_DAYS` in `backend/src/transactions/stale-reconciliation.ts`.
A component that hardcodes the number goes on saying 45 after the constant
moves, and the row highlight then disagrees with the count in the header badge
about which rows it is counting -- two surfaces describing the same ledger,
neither obviously wrong.

**Which of its two answers a surface *draws* is the surface's decision.** The
register draws `missed` only (`registerStaleReason` in `TransactionList.tsx`):
"overdue" says nobody has reconciled the account recently, which is true of
every row in it at once, so on a page of history it marked transaction after
transaction for a condition about none of them. `ReconcileTable` still draws
both -- there it is about the statement being worked on -- and the header badge
still counts both. That is a presentation choice about where the mark helps, and
it is the *only* thing a call site may vary; everything below is the helper's.

Three things the helper decides that a call site must not re-decide:

- **An account nobody reconciles has no overdue rows**, whatever their age.
  `lastReconciledDate` null is the whole of that test. Reconciliation is opt-in,
  and a badge telling a user who has never reconciled that their entire history
  is outstanding is one they will turn off and never look at again.
- **`missed` wins over `overdue`.** A row can satisfy both comparisons; counted
  under both, the two lines in the reminder add up to more than the badge.
- **A RECONCILED or VOID row is never outstanding.** The status test lives
  inside the helper rather than beside each caller, because both callers had
  their own reason to believe they would never be handed one.

**A failed lookup is not a clean ledger.** `useStaleReconciliation` returns
`undefined` when the request fails, and every consumer reads undefined as "no
information" and marks nothing -- the register keeps rendering, the badge does
not appear. Returning an empty context instead would make an outage
indistinguishable from a ledger that is up to date, which is the same class of
mistake as `accounts = []` on a failed accounts request.

### A long list -- page it, or bound it and scroll with `scrollbar-slim`

Two patterns, depending on where it lives:

- A full-page list uses `components/ui/Pagination.tsx`.
- A list inside a card caps its height and scrolls: `scrollbar-slim max-h-* overflow-y-auto pr-1`.

The thing to avoid is the *default* scrollbar, not scrolling. On Linux and Windows
the native bar is a wide arrowed control drawn hard against the content, and inside
a small card it reads as a rendering fault rather than as an affordance. That is
what gets complained about. `scrollbar-slim` keeps the bar -- a bounded list needs
one, or the rest of it is invisible -- as a thin rounded thumb on an empty track,
in the theme's greys, light and dark. The utility is defined in `globals.css`
alongside `scrollbar-hide`; it arrives with the security-detail branch, so on a
branch that predates it, add it there rather than styling a bar inline.

Bound the height rather than letting the card grow, and rather than hiding rows
behind a "Show N more" expander. A card in a grid or beside a chart has to be the
same height whatever its contents, or it drags the layout around: a breakdown card
next to the price chart left a gap under the chart when it collapsed, and an
expander also puts a click in front of information the card exists to show at a
glance. `SecurityWeightingBars` and the detail page's "Held in accounts" are the
worked examples.

`scrollbar-hide` is for a horizontal strip of chips, where the overflow is obvious
from the content being cut. Never use it on a vertical list: hiding a bar you need
is worse than a plain one.

### A password field declares what may be autofilled into it

Every `<Input type="password">` carries an `autoComplete`, and which value is a
judgement about the field: `current-password` when it really is this account's
password (a re-auth prompt, a confirm-before-delete box), `new-password` when one
is being set here, `off` when it is not a credential of this site at all.

Omitting it is not neutral. A browser or password manager fills a bare password
box with the saved credential for the origin, and the form then submits it as
though the user typed it -- so the AI provider's API key field, whose edit form
sends `apiKey` whenever the box is non-empty, silently replaced the stored
provider key on the next save: "Saved" on screen, provider dead, and no way to
tell from the UI because the row shows `****` either way. The backup export
password is the same shape and worse, since the artifact is then encrypted under
a password nobody knows. `ui-conventions.test.ts` fails the build on a password
input with no `autoComplete`, and on a value outside those three.

### A view that graduates to its own page -- delete the modal, do not flag it

Remove the modal mode instead of keeping it behind a prop: an `onClose?` nobody
passes and an `embedded` flag whose only caller always sets it leave every
`!embedded` branch compiling, tested and unreachable, still fetching the data
they no longer show. Delete the props, those branches, the orphaned catalog
strings in every locale, and whatever in a shared component only that modal used
(a `Modal` prop, a row-action icon).

### Copy -- `--` is comment style, never UI text

This repo writes `--` in code comments, and the habit is strong enough that it
leaks into catalog strings, where it renders literally on screen and reads as a
typo. In copy use an em dash, or recast the sentence and drop the aside.
`messages.punctuation.test.ts` fails the build on a new one; it carries a
shrink-only baseline of the strings that already had them.

The same applies to anything else that is punctuation rather than words: compose
it in the catalog, not in JSX. `"{units} ({share})"` is one string a translator
can reorder; `{value}{' ('}{share}{')'}` in a component is three fragments they
cannot reach.

### A transfer's direction comes from the row's own amount -- `transferDirection`

Money leaving an account went **to** the counterpart; money arriving came
**from** it. So the two legs of one transfer are labelled differently and both
are right, and a split line pointing at another account is asked with *its* own
amount rather than the parent's. `transferDirection` (`lib/transfer-label.ts`)
is the only place that decision is made, and `transferCsvLabel` is the export's
rendering of it (`Transfer To Savings`); the register renders the same decision
as its arrow chip.

The rule had been written out four times inside `TransactionRow` and was missing
from both CSV exports entirely -- the Transactions export left the Category cell
empty for a transfer, and a transfer split line was exported as `Uncategorized`,
which is not merely blank but wrong. A `ui-conventions.test.ts` guard fails on a
new `? 'to' : 'from'` outside the helper.

Coerce before comparing: `'-67.9900' < 0` is false, and a decimal string is what
the API sends, so a hand-rolled comparison labels every debit backwards.

### A transaction's payee display is `usePayeeDisplay`, never a bare `payeeName` read

A transfer created with a blank payee is PERSISTED blank (issue #1214) --
nothing stamps "Transfer to Savings" into the row any more, and migration 161
blanked the rows the old writers stamped. The label is resolved at render
time: `usePayeeDisplay()` (`hooks/usePayeeDisplay.ts`) returns the stored
payee when there is one and otherwise, for a transfer leg, the localized
`common.transferPayee` string built from `linkedTransaction.account.name` --
the counterpart's CURRENT name, so an account rename or a language switch
updates every historical row at once. A surface that reads
`tx.payeeName || tx.payee?.name` directly shows those transfers as unnamed.
English CSV exports use `transferPayeeCsvLabel` (`lib/transfer-label.ts`), the
byte-identical twin of the backend's `transferPayeeLabel`.

### A CSV file is written by `exportToCsv`, and a number in it is a number

`lib/csv-export.ts` is the only CSV writer: it owns the BOM, the CRLF line
endings, the RFC 4180 quoting, the formula-injection guard and the download.
Multi-table exports take `exportCsvSections` rather than assembling their own
lines -- `MonteCarloReport` had a hand-rolled copy that quoted every field and
guarded none of them, so the report with the *most* user-supplied text in it was
the one export a formula could ride out of. `ui-conventions.test.ts` fails the
build on a second `text/csv` Blob or a second `replace(/"/g, '""')`.

The guard cannot key off the first character, because `-` opens both
`-1+cmd|'/c calc'!A0` and every debit in the ledger. Deciding from that
character alone is issue #1134: Excel showed `-67.99` as the text ` -67.99` and
refused to total the column, on 59 of 64 rows. So it asks whether the value *is*
a number -- an optional sign then only digits, separators, whitespace and
currency symbols, with an optional `%` -- which is provably inert as a formula
and covers a formatted `-$1,652.73` as well as a bare `-67.99`.

**The reason it reached the user is worth more than the fix.** A prior pass had
already exempted negative numbers, with a passing test to prove it -- but it
tested `-100`, the JS number, and the value the API actually sends is the
*string* `"-67.9900"`. `decimal(20,4)` columns cross the wire as strings while
`types/transaction.ts` declares `amount: number`, so the fix and its test agreed
with each other and neither described the running app. Two consequences:

- **A money value off the API is a string until you make it one.** `Number(...)`
  it at the boundary of anything that branches on its type -- an export, a
  `typeof` check, a `.toFixed`. The transactions export now does; the split
  branch beside it always did, which is precisely why split rows were the only
  ones the reporter found intact.
- **A test for a type-dependent branch uses the shape the API sends**, not the
  shape the interface claims. `page.test.tsx` exports a fixture whose `amount`
  is `'-67.9900'` for this reason. Where a fixture disagrees with the wire, the
  suite is checking the type declaration rather than the code.

### Asynchronous data carries the request that produced it

**Asynchronous data is not only a payload. It is the payload plus the complete
request key that produced it.** A component holding `data` without knowing
which request answered cannot tell "the report you are looking at" from "the
report you were looking at a moment ago", and every action it offers is aimed
at whichever of the two it happens to read.

The request key is every selector that changes the *meaning* of the response,
not merely its freshness. Typically: the scenario or strategy id, the account
id, the date range, the reporting currency, the active filters, the locale
where the server localizes its output, and the revision or version where one
exists. If changing it would make the same payload mean something else, it is
part of the key.

**Stale data may stay on screen; it may not stay actionable.** Keeping the
previous view during a load is often the better read -- a blank page loses the
user's place. It is allowed while all of the following hold:

- it is visually marked as stale or loading;
- editable controls are disabled;
- mutations are disabled;
- no action can submit an id taken from the stale payload under the new
  selection;
- assistive technology is told the same thing the pixels say (`aria-busy`, or
  an equivalent that does not rely on the greyed-out styling alone).

Clearing the screen is not required. Non-actionable is.

**A mutation captures an immutable origin key when it starts**, and its
response is adopted only when

```text
mutationOriginKey === currentRequestKey
```

*and* the entity the response describes is the one the mutation targeted. A
late response from scenario A must never replace scenario B merely by arriving
last. Derive that origin from the data the component was rendering, not from
current React state read after the request began -- state has already moved by
the time the response lands, which is the whole problem.

**A failed lookup is not an empty dataset.** A failed accounts request is not
`accounts = []`, a failed securities request is not `securities = []`, and a
failed report is not a report of zeros. Rendering the failure as emptiness
turns an outage into a plausible answer, and leaves the save button live over
prerequisites that never loaded. Five states have to stay distinguishable:
loaded-and-empty, loading, failed, stale-previous, and current. Where a
prerequisite failed, use the shared retryable error presentation, keep the
stored ids, and disable the actions that depend on it.

**A dirty keyed form is data.** Changing the request key while a form has
unsaved edits calls for a confirmation, a preserved draft, or an explicit
save/discard flow; silently unmounting it is data loss, and remounting it under
a new key is the same loss with extra steps. A form rendered for scenario A
must also stop being editable once scenario B is the current selection -- those
are two obligations, and meeting the second by discarding the first is not
meeting both.

Regression tests for this class need deferred promises, and must assert on what
the user *can do*, not only on what is rendered (`docs/testing-contract.md`
carries the wider list of adversarial inputs, including the asynchronous ones):

| Case | Assertion |
| --- | --- |
| A starts, B starts, B resolves, A resolves late | the display is still B |
| A shown, B selected and loading | A's form cannot submit |
| Save for A starts, user selects B, A resolves | A's response is discarded and does not retire B's request |
| A shown, B selected, B fails | the failure is shown; A is not presented as B |
| Form dirty, user selects B | confirmation is asked for, or the draft survives |
| Save on the default selection, nothing else happens | the response is adopted |

**Both sides of that comparison must come from the same place.** The origin
key a mutation captures and the key the loader is holding have to be produced
by one expression, not by two that agree in the cases you happened to think
about. Take the origin from what the loader actually stamped -- `dataKey` on
`useReportData` -- and never rebuild it out of the rendered payload's fields.
The GEM report built its page key from a `strategyId` *state* that stays unset
until the user picks from a switcher, and the save's origin key from
`data.strategy.id`, which is always a real id: the two could never match on
the ordinary single-scenario path, so every settings save was discarded as
belonging to a selection nobody was on, with no refetch behind it. A key
comparison that silently drops the common case looks exactly like one that
works.

### A busy flag shared by nesting operations is a counter, not a boolean

One mutation can start another -- "save and carry on" runs the deferred
scenario create from inside the settings save's own `onSaved`. With a single
boolean the inner operation sets it, the outer one's `finally` runs
immediately afterwards and clears it, and the page goes live over a request
still on the wire: a second create can be started, and a late response can be
adopted under a newer selection. Whichever finishes first speaks for both.

Count the operations in flight and derive the flag (`pending > 0`). Every
begin needs exactly one end, on both the success and the failure path.

### Nothing interactive goes inside a `<button>` or an `<a>`

The parser closes the outer element at the inner tag, so the click target ends
wherever the nested control begins and the server's HTML stops matching what
React builds -- a hydration mismatch. Fix it at the call site by making the
two **siblings**: give the card a wrapper that carries the border and hover,
and put the navigation button and the nested control inside it side by side.

Do not fix it by demoting the inner control to a focusable `<span>`. A span's
implicit role is generic, screen readers drop its `aria-label`, and the result
is a tab stop that announces nothing -- which is how `InfoTooltip` came to be
a `<button>` in the first place. Trading one defect for the other just moves
it.

`ui-conventions.test.ts` scans for this, and it is the kind of rule only a
scan can hold: neither file is wrong on its own. Changing a shared component's
trigger element is a change to every call site, so the guard is what tells you
which ones.

### A short-range portfolio change is measured from the prior close

On `1d`, `1w` and `mtd` the Change and Change % measure from the close of the
last trading day *before* the window, so a chart showing a week from Aug 5
measures from Aug 4 and includes Aug 5's own movement. That is the convention
every quote source reports a daily move against. The longer ranges measure from
their first point instead -- their window opens on a calendar date whose first
point already *is* that day's close, so there is nothing earlier to reach for.
Which ranges are which lives in `PRIOR_CLOSE_BASELINE_RANGES`.

This was briefly a user preference (`portfolio_change_baseline`, added by
migration 152 and dropped by 153). It was removed because the prior close is
the right answer rather than a taste, and a settings row asking the user to
adjudicate it made the figure harder to trust, not easier. `usesPriorCloseBaseline`
now takes the range and nothing else; if you find yourself adding a second
argument to it, the question to ask first is whether the alternative is
actually defensible.

Both halves of the decision come from **one hook**,
`hooks/usePortfolioChangeBaseline.ts`, which returns `usesPriorClose` and the
`priorClose` together; the arithmetic and the range set live once in
`components/investments/portfolio-change-baseline.ts`. The Investments-page
chart and the Portfolio Value report both go through them, and a new surface
showing the same figure must too, rather than deciding for itself or
subtracting `points[0]`. Deciding *whether* a prior close applies in one place
and reading the close in another is the specific bug the single hook prevents:
while the two are out of step the card shows one under the rules of the other,
and nothing about it looks wrong.

The baseline is looked up for the **first point on screen**, never for the
requested window start: on a weekend or a holiday the 1D chart shows the last
session rather than today, and the day before *that* is the close the change
belongs to. A baseline that has not loaded, or could not be established, makes
the change **unknown** -- both cards read N/A. It never falls back to the
first-point change, which would put a different number under the same label.

### The window a price chart requests is not the period its range names

`resolveRangePreset` answers "what period is the user asking about", and ten
reports depend on that answer -- a spending report's 3M window must not quietly
start a day early. A *price* chart asks a narrower question: **which close is
the series measured from**, so the figure beside it matches what every other
quote source reports for the same period. Those are different questions, so
they have different functions:
`components/investments/portfolio-range-window.ts` holds the second one as a
table (`PORTFOLIO_WINDOW_STARTS`), and the Portfolio Value report, the
Investments chart and the dashboard widget all resolve through
`usePortfolioRangeWindow`. Do not reach for `resolveRangePreset` directly in a
fourth portfolio surface, and do not "fix" a range by editing the shared
resolver.

The rules are not uniform, and that is the point -- each was set to match the
platform being compared against, not derived from a principle:

- **3M, 6M, 1Y, 2Y, 5Y** open on the calendar day *before* the period, so 1Y on
  12 Aug 2026 opens on 11 Aug 2025. A rule naming an exact day ignores month
  alignment, and 2Y follows the calendar rather than a 730-day count, which
  differ in any window containing a leap day.
- **YTD** opens on the year's first *trading* day. The daily series values every
  calendar day at the latest close at or before it, so 1 January plots
  December's close and a market holiday is indistinguishable from a flat
  session there. `netWorthApi.getFirstPricedDay` answers it from
  `security_prices`, whose rows exist only for days a price was struck. A null
  answer is unknown, not "1 January is a trading day": the window keeps its
  calendar boundary rather than claiming a trading day nobody observed.
- **1M** keeps its window and collapses its first *day* to that day's close
  (`trimIntradayToFirstDayClose`), because it is an intraday chart and opening
  partway through the session a month ago mixes a mid-session price into a
  series of closes. 1D deliberately still opens at the open; 1W and MTD are
  measured from the prior close already, so collapsing their first day would
  only throw away detail.

Both intraday adjustments live inside `trimIntradayPoints`, which every
intraday render site already calls -- a shaping step applied at three of four
call sites is a chart that disagrees with itself depending on which path drew
it.

**A range served monthly cannot honour a day-precision rule.** 2Y and 5Y use
month buckets on the report and the widget, so their first point is a
month-end close and moving the window by a day changes nothing visible. Switch
the range to daily if the exact opening close matters; do not prepend a single
daily point to a monthly series, which is the sampling splice
`docs/time-series-contract.md` section 1.2 exists to stop.

Relatedly, `mtd` is a chart range with no backend series of its own: its window
is 1 to 31 days long, so it rides on the rolling 1M series and is trimmed to the
month client-side. Both halves go through `portfolio-chart-utils.tsx` --
`intradayRangeParam` before every intraday request, `trimIntradayPoints` on
every response, including the sessionStorage-cached one and the per-security
breakdown. Sending `mtd` verbatim is a 400 from `IntradayValueQueryDto`'s enum,
which surfaces as the chart's generic "couldn't load" fallback and so reads as
an outage rather than as a missing case; a response used untrimmed puts last
month's bars in a month-to-date chart, where they can become its high or low.
A guard test asserts every member of `INTRADAY_RANGES` maps onto a range the
endpoint accepts, so a fourth one cannot be added without a mapping.

### A loan's payment, payoff and remaining interest are decided once -- `deriveLoanFigures`

Three figures appear on every amortizing-debt surface (the loan detail page's
summary cards, the transactions Details sidebar), and each one has a state that
is neither a number nor "unknown":

- A **settled** debt owes nothing, so its remaining interest is a known **zero**
  and its payoff is "Paid off" -- not `null`, which reports a finished mortgage
  as one that could not be worked out. Settled means *nothing outstanding*
  (`-balance <= 0.01`), so an overpaid loan sitting in credit is settled too;
  `Math.abs(balance) <= 0.01` read that credit as debt of the same size.
- A projection that hits its horizon without paying off (`paidOff` false) has no
  payoff date, and its accumulated interest is the interest over that horizon --
  a subtotal. Both figures are unknown; printing the horizon's number under
  "Est. Remaining Interest" is a total's label over a partial sum.

`lib/loan-figures.ts` makes that decision once and both surfaces render its
output. The data behind it comes from `hooks/useLoanProjection.ts` (which fetches
the account's history) or from a `baseline` the caller already has -- but never
from a second copy of the branching. A failed history load is `status: 'error'`
with every figure unknown, never an empty history, which would project a
plausible payoff date from no payments at all.

### An unknown value must not render as a measured zero

The server goes to real trouble to send `null` rather than `0` for anything it
could not work out (`docs/financial-calculation-contract.md`), and the last
hundred pixels are where that gets thrown away:

- **`connectNulls` on a line chart** draws a straight segment through the gap.
  It is indistinguishable from measured data, and a tooltip saying "unknown"
  under the cursor does not undo it. Default to `connectNulls={false}`.
- **A bar, gauge or meter at zero width** beside an "unknown" label reads as a
  measured zero to everyone who looks at the shape rather than the number.
  Draw a distinct no-data treatment, or nothing at all -- not an empty fill.
- **A row that disappears** when its value is `null` conflates "not
  applicable" with "could not be computed". Where the payload can tell those
  apart -- a configured tax rate with an uncomputable tax, say -- render the
  row with an unknown marker rather than dropping it.
- **`?? 0`, `|| 0`, `?? 1` on an API value** is the same mistake in arithmetic
  form. Guard with an `isKnown()`-style check first; a fallback inside a
  `reduce` that a guard already covers is dead code at best and a silent
  subtotal at worst.

Whoever adds the `null` on the server owns how it looks. A component test
asserting the gap, the marker or the absent fill is what keeps it.

**A missing exchange rate is the same class, and it used to be the worst case
of it.** `useExchangeRates().convert` / `convertToDefault` /
`convertWithRateMap` return `number | null`; they previously returned the amount
*unconverted*, so a 100.00 USD balance with no USD→EUR rate was formatted as
"100.00 EUR" and summed into Assets, Liabilities and Net Worth. Silent,
unbounded, one instance per unconverted account, and able to reverse a trend.

Pick the treatment from what the figure is:

- **An aggregate** uses `sumConverted` / `combineTotals`
  (`lib/currency-total.ts`), which keep the subtotal and the missing currencies
  together, and renders through `PartialTotal`. Incompleteness is a union: net
  worth built from a complete asset total and a partial liability total is
  partial.
- **A single displayed value** shows an unknown marker, or nothing. Never the
  unconverted number beside the target currency's symbol -- "≈" does not make a
  euro figure an approximate zloty one.
- **A chart series** uses `null` and `connectNulls={false}`. A bar, slice or
  gauge cannot say "unknown", so an unconvertible component leaves the chart
  rather than appearing at an arbitrary size.
- **A cumulative series** (a running balance, a forecast) is withheld whole:
  one missing rate invalidates every point after it, so `buildForecast` returns
  no points and names the currencies. A short series there is not a partial
  answer, it is a wrong one. `buildMultiAccountForecast` withholds every line
  and the total together for the same reason -- the accounts that *did* convert
  are not a smaller forecast, they are a total labelled as something it is not.
- **A summary over a series** (`computeBalanceSummary`) refuses when any point
  is unknown. "Minimum" and "goes negative" are claims about all of it.

Same currency is 1:1 *by definition* and stays a known conversion -- keep it
distinguishable from the missing case, and keep a real zero rendering as a
number.

## `accountsApi.getAll()` is not "the user's accounts"

In own context the endpoint returns a **union**: accounts the caller owns, plus
accounts another owner shared with them jointly. The two are told apart by
`account.isJoint` -- true means the row belongs to someone else and is only
shown natively because a grant says so (`ownerLabel` names the owner). Any
screen that treats the list as "mine" is wrong for whichever half it forgot.

Filter to `!a.isJoint` before offering an account as something to **give away,
delegate, or otherwise re-share**. A delegate must not be able to pass on the
access they were given, so the Edit Access modal
(`components/settings/DelegateAccessModal.tsx`) derives `grantableAccounts` and
uses it for the grouping, the empty state, the baseline diff and the save
payload -- not just for the rows it draws. The server refuses a non-owned
account too (`setGrants` -> 403), which is why an unfiltered list is not merely
untidy: every toggle on it is one whose save cannot succeed.

The converse is not true. An account the caller owns and has shared *out*
carries `jointGranteeCount`, is still theirs, and stays assignable.

### On a joint row, *every* picker reads the owner's list -- and creation is off

A joint row belongs to the sharing owner and may only carry the owner's
reference ids, so `TransactionForm` derives `effectiveCategories` /
`effectivePayees` from the grant-gated reference-data endpoint. The rule is that
**everything** downstream reads those, not the caller's own `categories`: the
option list, the income/expense sign lookups, and the split editor. Three sites
still read `categories`, and each failed differently and quietly -- the sign
lookup could not resolve an owner id, so choosing an income category left the
amount negative; `SplitEditor` was handed the caller's list, so the owner's
split lines resolved to nothing and any pick wrote one of the caller's ids onto
the owner's row. Split mode is blocked on the *mode button* for a joint account,
which is not the same as being unreachable: opening a split row that already
lives there puts the form straight into it.

Creation is a separate question with a blunter answer: **do not offer it.**
`categoriesApi.create` writes to the caller's ledger and there is no client path
that creates on someone else's, so "+ Create" on a joint account made the
category in the wrong place and put an id the owner does not own on the form.
The delegation carries a `categoriesCanCreate` capability with nothing on the
client to drive yet; until an owner-scoped create exists, withhold the creator
(`jointSafeCategoryCreator`) rather than gate the button on a flag the code
cannot honour. Withholding it is also what makes the rule hold everywhere at
once -- the Category field, the transfer form's, and every split line take the
same optional prop, so there is one decision rather than four.

## Form Patterns

`useFormModal<T>` (`hooks/useFormModal.ts`) manages create/edit modal state with browser-history integration (back button closes), unsaved-changes detection via `UnsavedChangesDialog`, and form submit exposed via ref. Returns `showForm`, `editingItem`, `openCreate()`, `openEdit(item)`, `close()`, `modalProps`, `unsavedChangesDialog`.

Supporting hooks: `useFormSubmitRef` (expose submit via ref), `useFormDirtyNotify` (track dirty state). Forms use react-hook-form + Zod.

## Internationalization (i18n)

All user-facing strings go through `next-intl` -- no hardcoded literals. Read them with `useTranslations('namespace')`; catalogs live in `src/i18n/messages/{locale}/{namespace}.json` (locales `de`, `en`, `en-US`, `en-CA`, `en-GB`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, `xx`; the `en-*` locales are lean regional variants holding only the strings that differ from `en`; register new namespaces in `src/i18n/messages.ts`). Use `t.rich` for embedded markup and `t.raw` for template strings. Adding or changing a string means updating every locale -- the parity test `src/i18n/messages.parity.test.ts` fails otherwise -- then regenerating the pseudo-locale with `npm run i18n:pseudo`. The language is a user preference (`LanguageSelector` in Settings -> Preferences). Full contributor flow: `src/i18n/messages/README.md`.

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

**`vitest run` does not show you the warnings.** The default reporter buffers console output and prints it only for failing tests, so a suite full of act warnings looks spotless locally and prints eighty of them in CI. Use `npx vitest run --reporter=verbose` when checking for them, and grep for `not wrapped in act`.

**A store reset in a file's `afterEach` runs while the tree is still mounted.** Testing Library registers its `cleanup` at import time and vitest runs after-hooks in reverse registration order, so the file's own hook goes first. Writing to a Zustand store there re-renders the mounted component outside act, once per selector it reads through -- `SecurityDetailHeader` emitted three warnings in every one of its tests for exactly this. Call `cleanup()` at the top of the hook; a second cleanup afterwards is a no-op. `src/test/test-hygiene.test.ts` scans for it.

**Three quieter sources of the same warning**, all of which show up as "an update to X inside a test was not wrapped in act":

- A **synchronous `render(...)` of a component that fetches on mount** -- even in a test that only asserts on static copy, and even when the fetch is a stubbed `mockResolvedValue([])`. `GemStrategyHeader`'s tests were clean-looking for this reason; the switcher beside the title loads saved reports. Give the file one `await act(async () => { render(...) })` helper and use it everywhere, not only in the tests that await something.
- An **awaited handler behind a click**: `fireEvent.click` is act-wrapped, but the `finally { setBusy(false) }` after an `await` lands in a later microtask. Wrap that click in `await act(async () => ...)`.
- A **bare `await new Promise(r => setTimeout(r, n))`** used to let a `requestAnimationFrame` run. Whatever rAF you were waiting on is inside act; the ones beside it are not. Put the wait inside `await act(async () => { ... })`.

**A mocked hook must return a stable object if the real one does.** `useRouter()` returns the same router every render; a mock written as `useRouter: () => ({ push: vi.fn(), ... })` returns a new one per call. Every `useCallback([router])` then changes identity each render, every effect depending on such a callback re-runs each render, and an effect that also sets state loops forever. The Transactions page made **83 `transactions.getAll` calls in 300ms** under its own local mock -- invisible except as a slow test file and sixteen act warnings from updates still landing after the test had ended. The mock in `src/test/setup.ts` builds one router for the run; a file overriding it to observe `push` must do the same (build it lazily inside the factory -- `vi.mock` is hoisted above the `const mockPush` it closes over). The same reasoning applies to any mocked hook returning an object or array.

## Testing Conventions

**Custom render** (`test/render.tsx`): Wraps components with `ThemeProvider`. Import `render` from `@/test/render` instead of `@testing-library/react`.

**Global mocks** (`test/setup.ts`): `next/navigation` (useRouter, usePathname, useSearchParams), `react-hot-toast`, `localStorage`, `window.scrollTo`, `window.matchMedia`.

**Test file naming:** named after the component and co-located with it, e.g. `AccountForm.test.tsx` beside `AccountForm.tsx`.

## Theme

`ThemeContext` provides `theme` (light/dark/system), `resolvedTheme`, and `setTheme()`, plus `colorTheme`/`setColorTheme()` for the colour palette (`src/lib/color-themes.ts`). Both persisted to localStorage; applies `dark` class (Tailwind dark mode strategy) and a `data-theme` attribute (`default` = no attribute) to `<html>`; listens for system preference changes via `matchMedia`. Custom theme variables in `globals.css` `@theme` block; dark variant `@variant dark (&:where(.dark, .dark *))`.

Colour themes are pure CSS variable overrides in `src/app/themes.css` (`html[data-theme="..."]` redefines the gray/blue ramps etc. -- Tailwind v4 utilities compile to `var(--color-*)` so no component changes are needed). Chart colours go through `src/lib/chart-colors.ts`, which exposes `var(--chart-*)` strings for Recharts props; never hardcode hex colours in charts, and never theme user-chosen entity colours (tags, categories, payees).

**A palette needs a dark block, or dark mode renders its light colours.** A
theme's `html[data-theme]` block has specificity (0,1,1) and the `.dark`
defaults in `globals.css` have (0,1,0), so a theme that sets `--chart-*` in
its light block wins in dark mode too -- and those values were picked to sit
on white paper. That is what "the dark themes look washed out" was: fourteen
of fifteen palettes drawing light-tuned chart colours on a dark card. Every
such theme now carries an `html.dark[data-theme='x']` block (0,2,1), and
`src/test/theme-contrast.test.ts` fails when one is missing or partial.

The same test holds the contrast floors -- body text, muted text, links and
every chart token against the surface they sit on, per theme and mode, plus a
minimum page/card/border separation in dark mode. Shortfalls that predate it
are listed in a shrink-only `KNOWN_CONTRAST_DEBT`; genuine design exceptions
(midnight is black-on-black by intent, separated by its border) are listed
separately in `DELIBERATE`, so the two never blur together.
Values must be literal 6-digit hex: `resolvePdfColor` accepts nothing else and
silently falls back to grey. `frontend/scripts/derive-dark-palette.mjs` generates a
starting point for a new palette; the test, not the script, is the authority.

**The gray ramp is the theme, and it is generated.** Cards, pages, borders
and most text all read from the gray ramp, so it covers nearly every pixel,
while the accent shows up only on buttons, links and chart series. Themes
whose ramps were near-neutral therefore looked interchangeable no matter how
distinct their accents were -- and a first attempt at fixing it by tinting
`--color-white` a percent or two did not move anything, because at that
lightness sRGB has almost no chroma to give.

So the ramps come from `frontend/scripts/derive-theme-ramp.mjs`: one lightness
curve shared by every theme, with each theme setting its own hue and
intensity. Three consequences worth knowing before editing a palette by hand.
Contrast is a property of the curve rather than of each value, so it is
checked once. Chroma is spent as a *share of what the hue can hold* rather
than as a flat number, because the gamut is wildly asymmetric near white --
at L 0.95 a green carries about four times the chroma of a blue, so a flat
target tints the warm themes hard and leaves the cool ones looking untouched.
And themes that shift hue between their light and dark ends (parchment over
navy) concentrate the shift in the midtones and damp chroma across it, so the
ramp does not detour through a colour the theme never chose.

**Intensity is not a tuning knob, it is half the identity.** A version that
varied only the hue flattened every palette into the same theme at a
different angle, and a human reported both costs: palettes whose hues sat
close became indistinguishable (gruvbox and solarized read as one cream,
newspaper and burgundy as one pink), and MS Money -- whose character is *pale*
parchment with navy text and a green accent -- became a yellow theme wearing
MS Money's accent. Cream and parchment is a crowded, legitimate family that
hue alone cannot separate; its members are told apart by how strongly the
paper is tinted and by where the ramp's dark end goes.

That is why `theme-swatches.test.ts` measures **perceptual distance** between
every pair of tinted papers rather than comparing hex strings. Byte-equality
is far too weak a test for "these look the same": the reported collisions
differed in every byte, and the closest measured 0.0032 in OKLab. Eleven
tinted themes on one hue wheel do have a bounded best case, so the floors are
set below the achievable minimum rather than at some ideal.

Three themes are deliberately ungenerated and near-neutral: `default` (the
stock identity), `midnight` (a black AMOLED palette by design) and
`highcontrast`, whose whole point is maximum luminance contrast. That policy
is asserted, so the exceptions read as decisions.

**An accessibility theme is exempt from what it actually guarantees, and no
more.** `colorblind` was on that list too, on the reasoning that chroma
"spends CVD budget". That is true of the CHART palette, which is the promise,
and false of the chrome: surfaces are not data. Leaving its greys stock made
it byte-identical to `default` on every screen without a chart -- every grey
token matched to the byte, and the dark link accent differed by 0.069 -- so a
user picking it saw no change at all until they opened a report. Its ramp is
generated now and only its Okabe-Ito charts are hand-picked. `highcontrast`
stays exempt because *its* promise is about luminance, which chroma really
would spend.

**Two themes that share a strategy need different jobs, not different hexes.**
`highcontrast` and `midnight` were both a black page under a near-black card
(#0a0a0a and #0c0c0c) and read as one theme in dark mode. The fix was not to
nudge a value but to separate what they optimise for: midnight is for an OLED
panel, where every black pixel is unlit and borders stay quiet, and
highcontrast is for visible STRUCTURE, where a panel edge you cannot locate is
the accessibility failure. Its card now sits well clear of its page with a
much brighter border -- which is also why it no longer needs the
`card-vs-page` exemption midnight still carries.

Changing the curve is a change to every theme at once, which is the point --
but it moves every value sitting on those surfaces too, so expect the guard
to name chart colours and accents that need re-seating, and re-seat them
rather than widening the debt register.

**A theme preview is a copy of the stylesheet, and copies rot.** A browser
only computes the *active* theme's custom properties, so the picker's swatches
live in `src/lib/theme-swatches.ts`. `theme-swatches.test.ts` parses the CSS
through the same cascade the contrast guard uses (`src/test/theme-css.ts`) and
fails when a swatch disagrees with the token it claims to show, or when two
themes end up with identical swatches -- a preview that cannot tell two
palettes apart is the problem it was built to solve.

**A hand-rolled CSS bar is a chart.** `chartColors` is not only for Recharts props -- a `<div>` bar, and the amount printed beside it, take the tokens through `style={{ backgroundColor }}` / `style={{ color }}`. Reaching for `bg-green-400 dark:bg-green-500` or `text-red-600 dark:text-red-400` instead looks right on the default palette and then stays Tailwind red/green on every other theme, which is exactly the thing that gets noticed. To emphasise one bar among many (a peak, a selection), vary `opacity` on the same token rather than picking a second shade -- opacity moves toward the card in both light and dark mode, so the emphasis reads the same way in each.

**The tokens cover more than series colour.** `chartColors.grid` and `.axis` carry their own dark overrides, so a `CartesianGrid` using them needs no `dark:stroke-*` class beside it. `chartColors.surface` is the card behind the chart -- use it for the ring around a marker dot, which exists to separate the dot from the line beneath it and so must be the background, not white. `chartColors.neutral` is for unclassified data (an "Other" slice, an item with no colour). `ui-conventions.test.ts` fails on any hex reaching a `fill`, `stroke` or `stopColor` in a component that imports recharts. Two things it deliberately does not police: `summaryCards[].color` for the PDF export, where `pdf-export.ts` parses the string as hex and a `var(...)` would produce NaN, and colour on a *data* field (`color:` on a datum), which is indistinguishable from the PDF case by regex. White drawn on top of a filled shape -- label text inside a coloured flag bubble -- is contrast-on-fill and stays literal; `surface` there would be invisible in dark mode.

**Spending is not an error: default a breakdown to `chartColors.primary`, not `chartColors.expense`.** Red is loud and the app spends it deliberately -- the Monthly Totals chart, where a loss month is the point. A routine breakdown (top categories, paid-from accounts, a seasonality strip) is a magnitude comparison, so its bars take the theme accent, which re-colours per palette because `--chart-primary` follows the theme's blue ramp. Keep `chartColors.income` for genuine inflows so a refund is still distinguishable; that leaves red spent only where it means something. `TopGroupsPanel` and `PayeeSeasonalityPanel` are the worked examples, and both carry a guard test asserting no `bg-`/`text-red|green-N` and no `var(--chart-expense)` survives in their output. Note that `income`/`expense` remain right for a chart genuinely *about* the in/out split -- the rule is about breakdowns that merely happen to be negative.

**A member series drawn beside a total takes `chartSeriesColorAsidePrimary`, not `chartSeriesColor`.** `--chart-1` is the theme accent in every palette in `themes.css`, and so is `--chart-primary` -- so a chart that draws an aggregate line in `chartColors.primary` and starts its members at palette slot 0 hands the first member the total's own colour, in the chart, the legend and the tooltip alike. The helper excludes that slot from the cycle rather than deferring it, because a modulo over the full palette gives it back on the tenth series: the same collision, arriving late. `CashFlowForecastChart`'s "Total of Accounts" line and its per-account lines are the worked example; `chart-colors.test.ts` pins both halves. Use plain `chartSeriesColor` where there is no primary series to collide with.

## Security Notes

- **Zod:** Configured with `jitless: true` (`zodConfig.ts`) for CSP compliance -- no `new Function()`
- **Auth tokens:** Stored in httpOnly cookies (backend-managed), never in JS-accessible storage
- **localStorage is readable by any XSS, and by any scanner pointed at a public page.** A store that persists there must be listed in `src/store/persisted-storage.guard.test.ts` with the reason its contents may sit in storage, and the pre-login footprint (`auth-storage` and `monize-preferences`, both empty envelopes) is pinned there byte for byte -- the ZAP baseline's rule 120000 is silenced in `.github/zap/rules.tsv` on exactly that claim, so widening a `partialize` fails the guard rather than shipping under an IGNORE written for a smaller footprint.
- **CSP:** Per-request nonce generated in proxy, `strict-dynamic` for script-src
- **ESLint:** `no-new-func: error` enforced to prevent CSP violations
