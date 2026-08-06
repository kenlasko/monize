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

### A write that moves money calls `invalidateBalanceCaches()`

`accountsApi.getAll` and `investmentsApi.getPortfolioSummary` are cached in
`apiCache.ts` for two minutes, and the backend computes balances live from
transactions -- so a write that does not drop those entries leaves the Accounts
page showing the pre-write number. Navigating away and back does not fix it:
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

### Date entry -- `DateInput`, never a raw `<input type="date">`

`components/ui/DateInput.tsx` is the only place a raw date input is allowed, and `ui-conventions.test.ts` fails the build if another appears. It carries the locale-aware parsing, the keyboard shortcuts, and `CalendarPopover` -- the custom picker that the `.date-picker-hide` CSS in `globals.css` exists to make room for by hiding the browser's own icon. A bare `<input type="date">` gets none of that and shows two calendar icons. 32 components use `DateInput`; yours should too.

### Currency entry -- `CurrencyInput`, never a raw number input

`components/ui/CurrencyInput.tsx` is the only way to take a money amount. It is a `type="text"` field with `inputMode="decimal"`, not `<input type="number">`: it filters non-numeric characters as you type, formats with thousands separators and two decimals on blur, strips the commas and clears a `0.00` on focus so the field is immediately typable, parses back through `parseAmount` so the value reaching the form is rounded to cents, and re-syncs when the parent changes the value externally (a form reset, or a category auto-signing the amount negative). It also accepts inline calculator expressions -- typing `100*1.13` and blurring or pressing Enter evaluates it in place instead of submitting the form -- and offers a calculator modal via the in-field icon. Props worth knowing: `prefix` for the currency symbol, `allowNegative` (default true), `allowCalculator` (default true), `allowSignToggle` for the in-field `±` button. 22 components use it; yours should too.

A raw `<input type="number">` gets none of this and adds spinner arrows, scroll-wheel value changes, and locale-dependent decimal handling. For non-money numbers -- share counts, rates, percentages, day-of-month, retention counts -- use `NumericInput` instead: same filtering and blur formatting, but with `decimalPlaces`, a `suffix`, `min`/`max`, `allowNegative` defaulting to false, and no calculator.

`ui-conventions.test.ts` now fails the build on any `<input type="number">` or `<Input type="number">`. It resolves the tag each `type="number"` belongs to rather than grepping the file, because recharts' `<XAxis type="number">` declares a continuous scale and appears in about twenty chart components -- those are not inputs and are deliberately left alone.

Both components take a *number*, not the field's text: `value: number | undefined` and `onChange: (value: number | undefined) => void`. Two consequences worth knowing before converting a form:

- **`register()` does not fit.** Wrap the field in react-hook-form's `Controller` and pass `value`/`onChange`/`onBlur`/`ref` (plus `name={field.name}`, or a `name`-based test selector stops matching). Where the form's schema stores the field as a string, bridge inside the render callback rather than restructuring the schema.
- **`min` clamps while typing; `max` only on blur.** Every prefix of a number is smaller than the number, so a ceiling must not fire mid-word -- `max={31}` would otherwise hand the parent 31 while the user is still typing `50`. That also means `min` is wrong for a multi-digit floor (`min={2}` eats the `1` of `14`): leave it off and let Zod report. Where a value outside the range must be *discarded* rather than trimmed -- a budget alert threshold, a months remainder that cannot roll into years -- keep the explicit range check in the component's `onChange`; `MortgageFields` and `BudgetWizardStrategy` are the worked examples.

Give each field an explicit `id` when two on the same screen share a label. Both components derive `id` from the label text, so a "Years"/"Months" pair rendered twice (term and amortization) collides and every label points at the first input.

### A clickable table row -- `useLongPress({ onClick })`

`useLongPress` takes an `onClick` alongside `onLongPress` for exactly this: a plain click runs the row's primary action, a 750ms press (or right-click) opens the mobile action sheet, and a click that followed a long-press is suppressed. Spread `getRowHandlers(item)` on the `<tr>` and add `cursor-pointer`. The accounts, payees, tags, categories and securities lists all do this.

Do not put the click on a button around the symbol or the name instead. It looks identical and is not: the rest of the row -- all the cell padding, every other column -- becomes dead, and clicking a row "does nothing" for the majority of its area. Controls *inside* the row (a favourite star, `RowActions`) must `stopPropagation` so they act on themselves; both already do.

### A category picker lists every category in tree order as "Parent: Child"

However a surface selects a category -- the transaction form's Combobox, a
switcher, a reassign target -- the option list is the one shape: built from
`buildCategoryTree` (each parent followed by its children), a child labelled
`Parent: Child`, a top-level category by its bare name, and **every row
selectable, parents included**. A bare leaf name is ambiguous once two parents
own the same leaf, and a picker shaped differently from the transaction form's
reads as a second component. `CategorySwitcher` carries the regression tests.

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

## Testing Conventions

**Custom render** (`test/render.tsx`): Wraps components with `ThemeProvider`. Import `render` from `@/test/render` instead of `@testing-library/react`.

**Global mocks** (`test/setup.ts`): `next/navigation` (useRouter, usePathname, useSearchParams), `react-hot-toast`, `localStorage`, `window.scrollTo`, `window.matchMedia`.

**Test file naming:** `Component.test.tsx` (co-located with component).

## Theme

`ThemeContext` provides `theme` (light/dark/system), `resolvedTheme`, and `setTheme()`, plus `colorTheme`/`setColorTheme()` for the colour palette (`src/lib/color-themes.ts`). Both persisted to localStorage; applies `dark` class (Tailwind dark mode strategy) and a `data-theme` attribute (`default` = no attribute) to `<html>`; listens for system preference changes via `matchMedia`. Custom theme variables in `globals.css` `@theme` block; dark variant `@variant dark (&:where(.dark, .dark *))`.

Colour themes are pure CSS variable overrides in `src/app/themes.css` (`html[data-theme="..."]` redefines the gray/blue ramps etc. -- Tailwind v4 utilities compile to `var(--color-*)` so no component changes are needed). Chart colours go through `src/lib/chart-colors.ts`, which exposes `var(--chart-*)` strings for Recharts props; never hardcode hex colours in charts, and never theme user-chosen entity colours (tags, categories, payees).

**A hand-rolled CSS bar is a chart.** `chartColors` is not only for Recharts props -- a `<div>` bar, and the amount printed beside it, take the tokens through `style={{ backgroundColor }}` / `style={{ color }}`. Reaching for `bg-green-400 dark:bg-green-500` or `text-red-600 dark:text-red-400` instead looks right on the default palette and then stays Tailwind red/green on every other theme, which is exactly the thing that gets noticed. To emphasise one bar among many (a peak, a selection), vary `opacity` on the same token rather than picking a second shade -- opacity moves toward the card in both light and dark mode, so the emphasis reads the same way in each.

**The tokens cover more than series colour.** `chartColors.grid` and `.axis` carry their own dark overrides, so a `CartesianGrid` using them needs no `dark:stroke-*` class beside it. `chartColors.surface` is the card behind the chart -- use it for the ring around a marker dot, which exists to separate the dot from the line beneath it and so must be the background, not white. `chartColors.neutral` is for unclassified data (an "Other" slice, an item with no colour). `ui-conventions.test.ts` fails on any hex reaching a `fill`, `stroke` or `stopColor` in a component that imports recharts. Two things it deliberately does not police: `summaryCards[].color` for the PDF export, where `pdf-export.ts` parses the string as hex and a `var(...)` would produce NaN, and colour on a *data* field (`color:` on a datum), which is indistinguishable from the PDF case by regex. White drawn on top of a filled shape -- label text inside a coloured flag bubble -- is contrast-on-fill and stays literal; `surface` there would be invisible in dark mode.

**Spending is not an error: default a breakdown to `chartColors.primary`, not `chartColors.expense`.** Red is loud and the app spends it deliberately -- the Monthly Totals chart, where a loss month is the point. A routine breakdown (top categories, paid-from accounts, a seasonality strip) is a magnitude comparison, so its bars take the theme accent, which re-colours per palette because `--chart-primary` follows the theme's blue ramp. Keep `chartColors.income` for genuine inflows so a refund is still distinguishable; that leaves red spent only where it means something. `TopGroupsPanel` and `PayeeSeasonalityPanel` are the worked examples, and both carry a guard test asserting no `bg-`/`text-red|green-N` and no `var(--chart-expense)` survives in their output. Note that `income`/`expense` remain right for a chart genuinely *about* the in/out split -- the rule is about breakdowns that merely happen to be negative.

## Security Notes

- **Zod:** Configured with `jitless: true` (`zodConfig.ts`) for CSP compliance -- no `new Function()`
- **Auth tokens:** Stored in httpOnly cookies (backend-managed), never in JS-accessible storage
- **CSP:** Per-request nonce generated in proxy, `strict-dynamic` for script-src
- **ESLint:** `no-new-func: error` enforced to prevent CSP violations
