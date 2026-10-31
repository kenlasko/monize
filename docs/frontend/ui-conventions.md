# Frontend: UI conventions

The shared components and helpers that exist exactly once, and the rules for reusing them. Read this before writing a card, a dialog, a list, a picker, a switcher or any other control a user interacts with.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved. `frontend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Component Patterns

- All interactive components use `'use client'`. Server components are the default for pages/layouts.
- Use dynamic imports for heavy components: `dynamic(() => import('./Chart'), { ssr: false })`.
- `ProtectedRoute` (`components/auth/ProtectedRoute.tsx`) wraps authenticated pages.
- `PageLayout` (`components/layout/PageLayout.tsx`) supplies the background; each page supplies its `main` landmark and responsive content padding. The shared-expense review journey scopes its navigation to that landmark.
- **No `setState` in `useEffect`** — ESLint rule `react-hooks/set-state-in-effect` is enforced. To reset child state when a prop changes, use the "info from previous render" pattern (track the prop in `useState` and update during render).
- **Dialogs use `Modal`** (`components/ui/Modal.tsx`) — handles Escape, focus trap, body scroll lock, focus restore, and stacked-modal popstate. Opt into `pushHistory` so the browser back button also closes. `ConfirmDialog` forwards `pushHistory` for stacked confirm flows.
- **Leaving the page from inside a `pushHistory` modal** closes the modal first, then navigates through `afterModalHistoryPop` (`lib/after-modal-history-pop.ts`), never a bare link and never a fixed `setTimeout`. The closing modal pops its entry with an asynchronous `history.back()`, which undoes any push that lands before it; a guessed delay loses that race on a slow render, so the helper waits for the pop itself.

## Reusing existing UI patterns

Each of these exists once. Use it; do not hand-roll a second one. Every rule here was added after an agent wrote the generic version and a human had to point it out.

## A panel card is `Card` / `CARD_CLASS`, never an inline class trio

`components/ui/Card.tsx` is the one card surface -- background, radius, shadow, and the border that keeps a card legible on themes where the weakest shadow disappears. Use the `Card` component where a plain wrapper works (`padding="md"` matches the widget shell) and `CARD_CLASS` where the element already exists. The old inline `bg-white dark:bg-gray-800 rounded-lg shadow` trio survives in a recorded, shrink-only baseline in `ui-conventions.test.ts`; converting a file means deleting its baseline line. Everything stays on the gray ramp so the colour themes re-skin it -- never add a literal hex or an off-ramp hue to a card.

**Do not drop the border to make surfaces match.** Card-versus-page luminance is ~1.0 in `default` light, `midnight` and `highcontrast` (page and card both pure white there), so the border is the only thing that defines a card at all in those themes -- removing it makes panels disappear, and the change looks safe from every theme except the three it breaks.

## A category's colour and icon are inherited, and drawn by `CategoryGlyph`

Both are resolved server-side in one walk up the ancestry: read `category.effectiveIcon ?? category.icon`, never the raw column (null for most leaves). `components/categories/CategoryGlyph.tsx` draws the result: icon when there is one, colour dot otherwise, dimmed when inherited. Never interpolate `category.icon` into text -- it is a name like `shopping-cart`, so `{category.icon} {name}` renders the icon's *name*. A surface holding a *joined* category row (a transaction, a payee's default category) has no inherited value, so it reads `buildCategoryIconMap` / `buildCategoryColorMap` (`lib/categoryUtils.ts`) built from the full category list, as the register does.

## A brand favicon is `BrandLogo`, addressed by its entity's wrapper

`components/ui/BrandLogo.tsx` renders a cached favicon with the neutral badge fallback, and owns the one rule that matters: the bytes always come from our own backend, never a third party, so drawing a logo cannot leak which institutions or payees a user has. `InstitutionLogo` and `PayeeLogo` are thin wrappers naming the `/:id/logo` route, gated on `hasLogo` so icon-less rows issue no requests. A 404 lands on `onError` and shows the same badge. A third entity gets a wrapper, not a second component.

**A transparent logo that would vanish into the card gets a plain fill, decided from its pixels.** On load, `lib/logo-backing.ts` redraws the logo at 32px and reads only the round chip: an icon that is less than 15% see-through paints its own background and is left alone; otherwise the most populated colour bucket of its ink is compared with the default palette's light and dark cards, and below 2:1 contrast it gets `dark:bg-white` (dark ink, filled in dark mode only) or `bg-gray-800` (light ink, filled in light mode only), inset by a tenth of the size. The fill is CSS-variant driven, so a theme switch needs no re-read; every load re-reads the pixels (a refetched logo keeps its URL), and the last answer per URL is kept only so a remount paints its fill first time. A logo the canvas cannot read keeps no fill. The threshold is deliberately below the 3:1 non-text floor: a brand orange on white is legible, only a near-match is not.

**Hiding a logo responsively is spelled `max-sm:hidden`, never a bare `hidden`.** Tailwind emits `.hidden` *first* among the display utilities, so on the fallback badge -- whose own classes include `inline-flex` -- a caller's `hidden sm:inline-flex` never hides anything: the letter circles stayed visible on mobile while the favicons vanished. A `max-*` variant sorts after every base utility and wins below its breakpoint. The brand-logo guard in `ui-conventions.test.ts` fails on a bare `hidden` token in any logo call site's `className`.

## A status pill is `Badge`; table chrome is `Table.tsx`

`components/ui/Badge.tsx` is the small status pill (previously hand-rolled ~50 times). Pass `variant` and `size`; pass `as="button"` where the pill is also a control, rather than nesting a button in a span. It deliberately does not absorb pills whose colour *means* something -- `CategoryPill`, `AccountTypePill` and `SCHEDULED_KIND_CHIP_CLASSES` are each already one source of truth, exempted by name.

A warranty's status pill is `WarrantyStatusBadge` (`components/warranties/WarrantyStatusBadge.tsx`), fed by the server's `status` and `daysLeft`; no component compares a warranty's dates itself (WTY-002).

`components/ui/Table.tsx` is constants (`TABLE_CLASS`, `TH_CLASS`, `TD_CLASS`) plus thin `Th`/`Td` cells, not a `<Table>` wrapper -- these tables are hand-laid with colspans and sticky cells. `SortableHeader` deliberately stays off `TH_CLASS` (about twenty-five report tables draw a lighter header, and folding it in would restyle every report).

**A list's header cell is `Th` / `TH_CLASS`**, never a hand-copied `text-xs font-medium text-gray-500 uppercase tracking-wider` string or a local `HEADER_CLASS`. A sortable one is a `<th aria-sort>` in `TH_CLASS` holding a `<button>` with `SortIcon`: a `<th onClick>` is not reachable from the keyboard. `SortableHeader` reaches the same result the other way, a focusable `<th>` (`tabIndex={0}`, Enter and Space through `onKeyDown`) carrying `aria-sort`, and stays the report header. `SortableTh` (`components/ui/Table.tsx`) is that list cell, written once. Lists that still hand-copy the string are listed debt in `screens-and-dialogs.md`, not a pattern.

## The card shadow is `--shadow-card`; the bare `shadow` reads no token

Tailwind v4 trap: the bare `shadow` utility is a legacy alias with the stock value compiled in, so redefining `--shadow-sm` in `@theme` touches `shadow-sm` (worn by form fields) and leaves cards flat. `ui-conventions.test.ts` fails on a `--shadow-sm` redefinition. Card elevation goes through `--shadow-card`, worn by `CARD_CLASS`.

## A focus ring is `focus-visible:`, and a hover animates

`focus:ring-*` paints on a mouse click as well as a Tab; use `focus-visible:` on anything clickable. Text inputs are the one exception (`inputBaseClasses` and the element selectors in `globals.css`). Row hover comes from `HOVER_ROW_ON_CARD` / `HOVER_ROW_ON_PAGE` in `Card.tsx` (a text button in the bar above a table from `HOVER_TOOLBAR_BUTTON`, through `LIST_TOOLBAR_BUTTON_CLASS` on `ListTopToolbar.tsx`), not a hand-picked grey, and includes the transition (a hover that snaps reads as a redraw). Pair any new transition with `motion-reduce:transition-none`. Both rules carry shrink-only baselines in `ui-conventions.test.ts`.

## A dialog is titled through `Modal`, never by a hand-rolled heading

`Modal` takes `title` (and optional `description`, drawn as an `InfoTooltip` beside the title, `footer`, `padding`), draws the standard heading and wires `aria-labelledby` -- before it, none of the 74 hand-rolled headings reached the dialog, so every dialog announced itself as an unnamed region. `padding` defaults to `none` and leaves children unwrapped, because several call sites make the panel their own scroll or flex parent. A genuinely bespoke header (ConfirmDialog's icon) stays on the baseline deliberately.

What the header looks like is `screens-and-dialogs.md`: the reference is the New Transaction dialog (large bold title, no X, no full-width divider), and `Modal`'s `title` heading is drawn that way. There is no X, so a titled dialog draws its own Cancel or Close in every state. A confirmation (`ConfirmDialog`, `UnsavedChangesDialog`) is the one exempt kind -- icon, smaller title, the question as a paragraph -- and its buttons are still `Button` variants (`screens-and-dialogs.md`, "A confirmation is its own kind of dialog").

## An empty list renders `EmptyState`

`components/ui/EmptyState.tsx` (glyph, title, optional description and action). `ui-conventions.test.ts` bans the `text-center py-12` container fingerprint outside the component, with no grandfathered baseline.

## An auth screen renders inside `AuthShell`

`components/auth/AuthShell.tsx` is the single shell for login, register, forgot/reset/change-password, verify-email, confirm-email-change and setup-2fa: transparent brand mark, title/subtitle, notices slot, shared `Card` around the body (`plain` for a bare status line). Language picker and version line are opt-in props. Use `/icons/monize-logo-transparent.svg` everywhere in the UI -- the boxed `monize-logo.svg` bakes in a white background and renders as a white square in dark mode. Guarded in `ui-conventions.test.ts`.

## Navigation links and their icons live in `lib/nav-links.ts`

The header's link arrays and the per-route Heroicon map are declared side by side so `nav-links.test.ts` can hold "every nav route has an icon". The mobile drawer and header dropdowns render `NAV_ICONS[href]`; the desktop top-bar pills stay text-only on purpose (six leading icons overflow 1280-1440px laptops). A new route means one entry in the array and one in the map, in the same file.

## Account-type colour and icon come from `lib/account-type-meta.tsx`

`ACCOUNT_TYPE_META` maps each account type to its pill classes and Heroicon; render `AccountTypePill` / `AccountTypeIcon` rather than re-deriving either. `ui-conventions.test.ts` fails on a second type-to-pill-class mapping. An account with no institution shows its type icon in the brand-badge slot (`InstitutionLogo`'s `fallbackIcon`), not a generic glyph.

## Which account types have a detail page is `lib/account-detail-views.ts`

`ACCOUNT_DETAIL_VIEWS` maps an account type to the view `/accounts/<id>` renders for it, and everything else about "does this account have a Details page" derives from that one registry: `resolveAccountDetailView` (the route), `hasAccountDetailView` (the row action, the tour requirement), `DETAIL_ACCOUNT_TYPES` (the key set). Three surfaces ask the question, so three copies of the list is how they come to disagree -- the account row and the route registry already held one each. `loan-rate-changes.contract.test.ts` checks the `loan` arm against `RATE_CHANGE_ACCOUNT_TYPES` and against the branch the account page actually fetches rate history in.

## A tour step pinned to a dynamic route is reachable only by the user

`routeMatch: '/accounts/'` names an id the tour never knew, so the engine cannot navigate there: pushing the step's `route` can never satisfy the prefix, and the step sits in its `navigating` phase behind an overlay that renders nothing -- the tour disappearing mid-run. `isStepReachable` (`lib/tours/navigation.ts`) is the one test, and both doors use it: Back walks past such a step once the user has left that route, and `TourHost` skips it rather than hanging when the user arrives any other way (they skipped the step that asks them to open the page). The step's own `route` satisfying the prefix is the ordinary case and stays navigable ('/reports?category=insights' for '/reports').

A step gated by `requires` is the omit effect's to remove: the engine neither navigates to it nor skips it as unreachable while its requirement is unmet or still resolving, or the two race and a deliberate omission is reported as a degraded tour.

## A step inside a dropdown asks the engine to hold it open

A menu or panel in the header closes on a click outside itself, and the tour card is outside it -- so a `click` advance on the trigger opens the dropdown and the reader's very next press closes it under the step describing its contents. The step declares the intent instead (`openToolsMenu` for the header's Tools menu, `openNotificationBell` for the notification panel) and the component ORs that flag over its own state, so the flag also wins over the click-outside close. Two consequences: the step pointing at the closed trigger must NOT carry the flag (the open panel covers the button it names), and every step anchored inside the panel must, or the panel vanishes mid-tour. `NotificationBell.test.tsx` holds all three cases -- opens without a click, survives a click on `document.body`, closes again once the tour steps past.

## A coach mark parks in the corner the step is not about

An `unobtrusive` anchorless step parks its card in the bottom-**right** corner, which is exactly where every list puts its row actions (`RowActions` is `justify-end`, in a sticky-right cell). A step that asks the user to click one therefore had its own card intercepting that click -- CI caught the account-detail step's card over the **Details** button at a 720px-tall viewport, and the shipped 1.13 foreign-currency tour had the same collision. Such a step sets `placement: 'left'` (the only meaning `placement` has for a corner-parked card). The card is also draggable, but a tour whose first move is "get my card out of the way" is not one to ship: park it clear. `tours.spec.ts` clicks the real row action, so the collision fails the E2E rather than the user.

## A register's category chip is `CategoryPill`

`components/transactions/CategoryPill.tsx` owns the colour-mix pill and the category's optional icon (via `getIconComponent`, as tag chips do). Categories carry `icon` end-to-end -- `CategoryForm` collects it through the shared `IconPicker` (whose `onClear`/`clearLabel` props make "no icon" a real state) -- so a surface showing a category name with its colour shows its icon too, and an unset icon renders nothing, never a default glyph.

## A dashboard widget header carries its icon from `widget-meta.tsx`

`WIDGET_ICONS` gives every registered widget a distinct Heroicon (`widget-meta.test.tsx` enforces coverage), rendered as the tinted `WidgetIconPuck` -- blue ramp only, so themes re-tint it. Widgets on `WidgetCard` get it from their `widgetId`; a widget drawing its own header uses `WidgetHeading`.

A widget's title is a link to the fuller view of the same figures, named as a route: `titleHref` on `WidgetCard`, `href` on `WidgetHeading`. Both render it through `WidgetTitle`, the one place that decides what a title looks like and how it behaves; a widget with no fuller view passes neither and gets a plain heading.

A switcher in that header is `components/dashboard/WidgetSegmentedControl.tsx`, which wears the widget header's own chrome rather than the toolbar pill in `components/ui/segmented-control.ts` -- the two never appear together. An option may carry an `icon` instead of a word, which is what lets a widget keep two switches on the header's one line beside the heading (the Upcoming Bills widget's scope and List/Calendar view); the label then survives as the segment's accessible name and its tooltip, so the control is still named for a screen reader and for anyone who hovers it. A row holding two of them does not wrap: a switch that drops to its own line is the layout the icons were chosen to avoid. The row itself does take the header's own line on a phone (`w-full sm:w-auto`, the toolbar convention above) and holds its two ends apart there (`justify-between sm:justify-start`), so the scope pair stays against the card's left edge and the icon switch sits against its right rather than trailing the words. Not `sm:ml-auto` on the trailing switch: these two groups are one row, not a toolbar's leading and trailing groups, and the scope pair must stay left whichever line the row lands on.

## A dashboard widget card stretches to its row, and never sets `h-full`

The dashboard is a two-column grid of auto-sized rows (`app/dashboard/page.tsx`), and `align-items: stretch` is what already makes the two cards in a row the same height. `h-full` on top of that asks for a percentage of a track the card is itself supposed to size. Chromium and Gecko break the cycle by measuring the card's content first, so the row grows to fit; WebKit -- which is every browser on an iPad, Firefox included -- does not, and sizes the row without the card's own content in it, leaving the card at the height its neighbour set. With one widget per row there is no neighbour and the two agree, which is why the defect showed only on a landscape tablet: the Expense by Category card kept its neighbour's height while its opened Other list spilled out of the box, under the row below it.

So a widget's outermost element carries its min-height (`minHeightClass` on `WidgetCard`, `lg:min-h-[500px]` on the two shells that draw their own card) and nothing else about height. `ui-conventions.test.ts` scans `components/dashboard/` for `h-full` on a line that also names the card surface, the min-height or `minHeightClass`; an `h-full` *inside* a widget is not a grid item and is not the subject.

The inner content area stays `flex-1 min-h-0`: it is what lets a chart fill the card and an inner list scroll. It is also what lets content leave the card when the card's height is wrong, so a card that must grow with its content -- a disclosure, an expanding list -- depends on the row growing, and the row grows only while nothing pins the card's height.

## A month of scheduled occurrences is drawn once

`lib/scheduled-calendar.ts` decides what falls on which day (`occurrencesInWindow` applies each override, so a moved occurrence appears on the day it was moved to and not the day it was generated for; the scan reaches a month past the grid so an occurrence moved *into* view is still found), and `components/bills/ScheduledCalendarGrid.tsx` draws it. The Bills & Deposits page and the Upcoming Bills widget both read them, differing only in `maxChipsPerDay` and the cell height. Chip colour is `SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind(...)]` -- classified from the occurrence, never from the schedule's stored sign.

The grid prints names on dates and no amount per occurrence, which is why `scheduled-calendar.ts` is on the client-expansion exemption list in `scheduled-effective-amount.guard.test.ts`. Anything that wants a per-occurrence *amount* asks the server (`GET /scheduled-transactions/occurrences`) instead.

## A month grid is `MonthGrid`, and its days are strings

`components/ui/MonthGrid.tsx` is the month layout: whole weeks, `common.weekdaysMin` rotated to the reader's `weekStartsOn`, `role="grid"` with one roving tab stop, arrow keys, Home and End for the week's ends (with a modifier, the grid's), `aria-current="date"` on the day the *server* calls today, and `aria-selected` on the open day. Its `ref` is a `MonthGridHandle`, whose `focusDay` is how a host puts focus back on the cell a closing day panel came from -- dropping focus on the document instead makes a keyboard reader start the month again. It takes a `renderDay` and knows nothing about what goes in a cell -- no money, no filter, no endpoint -- which is what lets the Transactions and Investments calendars share one grid without sharing a contract.

`lib/calendar-month.ts` decides which days a month's grid holds (`monthGridDays`), rotates the labels (`rotateWeekdayLabels`), steps the month (`shiftMonth`) and the day (`shiftDate`), counts a run inclusively (`calendarDaysBetween`, negative when the range runs backwards, so a caller cannot read one as a single day) and classifies a day against a `today` it is *given* (`classifyCalendarDay`, which has no default: actual-versus-projected is the server's day, not the browser's). Every function takes and returns `YYYY-MM-DD` or `YYYY-MM` and does integer arithmetic on the parts. Nothing builds a `Date`: a `Date` from a calendar date is an instant in the browser's zone, so `new Date('2026-03-01')` is the last day of February west of UTC and the grid loses or repeats a day at the boundary. `lib/calendar-month.guard.test.ts` scans both modules for the call rather than leaving the rule in prose, because CI runs in UTC and the frontend suite pins no timezone -- restoring the mistake breaks nothing a behaviour test can see.

A key pressed on a control inside a cell belongs to that control. A keydown is dispatched at the focused element, so the grid handles one only when its target is the cell itself: claiming it would not merely add the day's action to the chip's, it would replace it, because the `preventDefault` that claims the key also cancels the default that activates a button or follows a link. The click handler has always deferred to inner controls; both halves of that rule are tested.

A weekday header is keyed by its **column**, never by its label. Portuguese abbreviates quarta and quinta alike (`qu`) and segunda and sexta alike (`se`), so a key taken from the label collides with its own sibling and moving the week start reconciles seven headers into nine, in the wrong order.

The grid is whole weeks covering the month, so it is 35 or 42 days -- and 28 for a non-leap February whose 1st falls on the week start, where four whole weeks already cover it.

The month heading in `CalendarToolbar` is a button, not a caption: it opens `components/calendar/CalendarMonthPicker.tsx`, which offers a focused text field first and a year stepper with twelve month buttons under it. Twelve buttons reach next spring in one click and March 1998 in eighty, so typing is what makes a distant month reachable; `lib/month-input.ts` reads what a person would actually type (`2026-03`, `03/1998`, `199803`, `Mar 1998`, `March`, `3`, `1998`) against the reader's OWN `common.monthsShort` labels, with the month on screen supplying whatever a partial entry leaves out -- never the clock, for the reason nothing else in the calendar reads it. It refuses rather than guesses: an unreadable entry and a prefix two months answer to are both reported at the field, because a guess moves the calendar somewhere nobody asked for. The heading stays the grid's `aria-labelledby` target, so the button lives inside the `<h2>` rather than replacing it.

Below `sm` a cell is the day number, a dot row coloured like the chips (`h-2.5`, wrapping onto as many rows as the day needs, `CALENDAR_DAY_DOT_LIMIT` of them -- one more than `CALENDAR_DAY_CHIP_LIMIT`, since a dot wraps where a chip is a line of a cell whose height is fixed) and a count, because a phone cell has no room for a label and a row of dots cannot say how many; below `lg` the day panel is a `Modal` over the month rather than a card beside it, since there is no column to put it in. The dots are decoration and are `aria-hidden`; **the count is not**, because the chip list beside it is `display: none` at that width, so hiding the count too leaves a screen reader a month of bare dates. The digit stays hidden beside an `sr-only` `day.itemCount`, so it is read once as a count of something rather than as a stray number. Both are decided by `useIsBelowDesktop` / `useIsMobile` (`hooks/useIsMobile.ts`, one `useMediaQuery` under both), never by a second `matchMedia` call. A phone cell's money figure is `formatCurrencyTight` and a wider one's is `formatCurrency` (`CalendarDayCell`'s `useDayFigureMoney`, read by the Balances and the Values layer alike): a fifty-pixel column has no room for `$13,344.33`, and the two renderings are different TEXT rather than one figure styled two ways, so drawing both and hiding one by breakpoint would read the day's balance to a screen reader twice. A note is the one thing a cell does NOT draw for itself at any width: it is a band across the days it covers (`CalendarNoteSpans` through `MonthGrid`'s `renderWeekSpans`), which on a phone is the only room its text has to be read in, and the cell carries an `sr-only` copy because that layer is `aria-hidden`.

Two hand-rolled grids remain, `components/bills/ScheduledCalendarGrid.tsx` (the Bills & Deposits calendar and the Upcoming Bills widget) and `components/reports/UpcomingBillsReport.tsx` (the report's own calendar view); both migrate onto `MonthGrid` in their own PR, and until then they are the shrink-only baseline of the "a month grid is MonthGrid" block in `frontend/src/test/ui-conventions.test.ts`, which fails an unprefixed `grid-cols-7` anywhere else. Two files lay out seven columns that are not a month and are recorded beside the baseline as decisions rather than debt: `components/ui/CalendarPopover.tsx` picks one day rather than displaying a month of content, and `components/reports/WeekendVsWeekdayReport.tsx` draws one tile per weekday under its chart. A third month grid is a test failure, not just a review failure.

What a calendar may do with what it draws is `frontend/src/components/calendar/calendar.guard.test.ts`: no fold or accumulation in a view and no money-named one in the hooks behind it (a day total has no currency and no way to withhold itself), no recurrence expanded in the browser, no `text-red-`/`bg-<hue>-100` literal where `gainLossColor`, `balanceColor`, `ACCOUNT_TYPE_META[...].pillClass` and `SCHEDULED_KIND_CHIP_CLASSES[...]` already answer, no `Date` built and no clock read, and every `pricesComplete` / `fxComplete` read as `=== false` rather than for truthiness, since a flag an older backend never sent is no information rather than a claim of incompleteness. A line carrying `role="alert"` may wear the app's error red -- an escape a figure cannot take, because a figure announced as an error is a different defect.

## A screen's Table / Calendar choice is `viewModeStore`, not a URL parameter

`store/viewModeStore.ts` holds `{ view, layers }` per surface (`transactions`, `investments`, `bills`; Bills & Deposits calls its table "the list" and offers no layer switch) under one localStorage key, the density store's pattern, and `components/ui/ViewModeToggle.tsx` is the segmented control that moves it. It wears `InvestmentViewToggle`'s chrome deliberately, because the two sit side by side in the Investments toolbar, and both take it from `components/ui/segmented-control.ts` (`SEGMENTED_GROUP_CLASS`, `segmentClass`) rather than each spelling the classes out -- which is how the two last drifted apart by a `motion-reduce:transition-none`. A guard in `frontend/src/test/ui-conventions.test.ts` holds the chrome in one place. Which view a screen is on is a fact about the screen, so a laptop and a desktop signed into the same account need not agree; it is not a `user_preferences` column and not a URL parameter, which would impose the sender's reading habit on whoever opens a shared link. `useViewMode(surface)` binds the actions to one surface so a caller cannot write to the other, and `LayerOf<S>` narrows `toggleLayer` and `isLayerOn` to that surface's own layers, so asking the investments calendar for a `balances` layer is a type error rather than a toggle that silently does nothing. At least one layer is always on: a calendar with every layer off is a month of empty boxes, which reads as a page that failed rather than as a choice.

The switch is drawn as two icons, not two words, and the words survive as each button's `aria-label` and `title`. It sits in one corner of the screen in both views: the right-hand end of `CalendarToolbar`'s row, grouped with the legend behind one `sm:ml-auto` (two `ml-auto` siblings would SPLIT the free space between them rather than both moving right), and in table mode `ListTopToolbar`'s `infoAfter`, immediately right of the "Showing 1-25 of 90" line, so what the reader is looking at and the control that changes its shape read as one statement while the right-hand end stays with the controls that act on the list as drawn (export, density) and, after them, the pager. A bar drawn without paging props -- the empty register -- has no count line, so there the switch stays last of the buttons. Neither component renders it; each takes it as a `viewToggle` node, because which surface it switches is the page's business. On the Investments page `InvestmentTransactionList` keeps `viewToggle` for the brokerage/cash switch beside its heading and takes the Table/Calendar one as `viewModeToggle`, which only reaches the strip when that list owns its paging.

## The device can override a stored preference, and the predicate is never the viewport

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

## A gate belongs to the thing it admits, not to the thing that produced it

The scan control checked the picked photo against `MAX_ATTACHMENT_BYTES` before
opening the scanner, copied from the plain upload where it is right -- there the
file *is* the attachment. Here it is the scanner's INPUT: what gets attached is
a JPEG capped at `OUTPUT_MAX_EDGE`, so the check refused exactly the captures
the feature exists for (a 12MP phone photo is routinely over 10 MB and scans to
well under it), and it made the dialog's own "the original is too large to keep"
path unreachable outside its unit test -- two suites asserting opposite
behaviours, both green. Before copying an admission check, ask which artefact
the limit describes.

The other half of that fix is the same rule pointing the other way: once such a
photo can reach the dialog, "Keep original only" would upload a file the server
answers **413** to, so it is disabled there. A control offering an action the
server will refuse is worse than an absent one.

## An attachment is opened in `AttachmentPreviewDialog`, never downloaded from a row

Clicking an attachment previews it; Download is a footer action of the preview.
A warranty's documents are `AttachmentsSection` with a warranty parent (`{ warrantyId }`, wrapped by `WarrantyDocumentsSection`), never a second uploader; a new warranty's are its staged mode with `stagedFor="warranty"`, which `WarrantyForm` uploads once the warranty exists.
When a staged uploader sits beside an existing shared-document list, its
`pendingHint` describes the upload step even with no pending files; an empty
selection does not mean the group has no saved attachments. The shared-expense
file journey checks that distinction after saving and reloading a document.
Four rules the viewer holds, each with a test:

- **Bytes come through `attachmentsApi.fetchBytes`**, never a bare `<img src>`
  or `fetch`: the axios client's 401-refresh interceptor is the only thing that
  can renew an expired token, and an `<img>` whose request 401s simply fails to
  load. The row's thumbnail still uses `attachmentDownloadUrl` directly, and
  that is why the preview's request is answered from the HTTP cache it primed.
  `useAttachmentBytes` keys the payload to its source, so switching Enhanced to
  Original and back cannot paint the slower answer over the newer one, and a
  failed read is `error`, never an empty result.
- **One failure is told apart from the rest: a storage backend this deployment
  cannot reach.** The server answers a 503 naming it
  (`AttachmentStorageRegistry.require`, for a row whose bytes a provider switch
  has not relocated yet), `isStoreUnreachable` recognises it and the viewer says
  the file is intact and cannot be served from here. The generic message ends
  "you can still download the file", which for this state is false: the download
  is the same request. `attachments.preview.storeUnavailable` is that message.
- **pdf.js is reached from one module behind a dynamic import.**
  `lib/attachment-preview/pdf-engine.ts` is the only file naming `pdfjs-dist`
  or `/vendor/pdfjs/`, and `PdfPages` is the only place it is `import()`ed, so
  no page pays for a PDF renderer until somebody previews a PDF (the module
  also touches `DOMMatrix` at load, which a server render must never reach).
  `lib/attachment-preview/attachment-preview.guard.test.ts` scans for both.
- **The worker is vendored and version-pinned.** pdf.js constructs its own
  Web Worker from `GlobalWorkerOptions.workerSrc`; the script must match the
  bundled API exactly, so `frontend/scripts/copy-vendor.mjs` copies it out of the
  installed package on `predev`/`prebuild`/`pretest` (beside the OpenCV build,
  same script) and the engine appends `?v=<pdfjs.version>` so a stale copy in
  the HTTP cache cannot answer for a newer API. `public/sw.js` deliberately
  does not cache `.mjs`.
- **A PDF page is drawn when the reader can see it.** A canvas costs its
  pixels whether or not anyone is looking, and at the dialog's width a full
  page clamps to `MAX_PAGE_PIXELS`, which is 16 MB: drawing all of a 20-page
  statement up front asks for hundreds of megabytes and loses the tab on a
  phone. `PdfPages` observes each page and releases the backing store of one
  scrolled away, keeping the box it measured so nothing jumps. What bounds the
  cost is what is on screen, never the length of the document.
- **What the reader chose belongs to the attachment, not to the prop object.**
  The dialog keys its Enhanced/Original and Fit/Actual state on the subject
  being previewed (`previewSourceKey`), because a caller that composes `target`
  in its JSX rebuilds it on every one of its own renders -- and keyed on
  identity that threw the reader back to the enhanced image mid-read, and
  re-fetched it. The saved list also holds the whole target in state, as the
  staged list already did. Which controls the toolbar offers likewise comes
  from the metadata, not from the bytes in flight, or they appear late and
  shift the picture underneath.
- **A phone gets the whole viewport through `Modal`'s `fullScreenOnPhone`**,
  spelled with `max-sm:` variants so the base classes every other dialog
  relies on are untouched. The layout is a CSS question, so it is not
  `useIsMobile` (see the next section). A scan pair's Enhanced / Original
  switch is the same two-button pattern `DocumentScanDialog` draws, and the
  original's Download carries no filename because the list does not know it --
  the server names it through Content-Disposition.

## A platform capability is not decided by the window's width -- `isTouchDevice`

`useIsMobile` is a 639px media query; `isTouchDevice` (`lib/touch-device.ts`) is
`(pointer: coarse)`, and they answer different questions. The viewport hook is
right for choosing a *layout* (the register's card rows show the same figures
either way) and wrong for anything that changes what a control can do:
`capture="environment"` on the scan input replaces the OS file picker with the
camera on a browser that honours it, so keyed off the width it took "choose an
existing photo" away from anyone with a narrow desktop window and handed it back
when they widened it. The media query lives in that one helper -- `DateInput`
held the only other copy -- and `ui-conventions.test.ts` fails a `capture` in a
file that imports `useIsMobile`, and a second hand-rolled `pointer: coarse`.

## Contextual help is `InfoTooltip`, and a touch reader can open it

If a figure or a setting carries an explanation on a desktop, the same explanation opens on a phone. `InfoTooltip` (`components/ui/InfoTooltip.tsx`) is the one help popover: a mouse hovers it, a keyboard focuses it, and a click, a tap or Enter pins it open until the reader presses outside it, taps it again, moves focus to another control, or presses Escape. It takes one `text`, which is the popover body and the trigger's `aria-label` at once, so desktop, phone and screen reader read one translated string and there is no second copy to drift.

Help that holds controls is not a tooltip. The transaction search's syntax help (`components/transactions/SearchSyntaxHelp.tsx`) lists examples a reader can choose to fill the search box, so it is a click-opened `role="dialog"` through a portal, placed with `InfoTooltip`'s own `placePopover` and re-measured on scroll and resize; opening moves focus to its first example, because Tab from the trigger never reaches a panel portalled to the end of the document; an outside press closes it through `useClickOutside`; it claims Escape only while open, and takes a `popoverRef` so a parent with its own outside-press handler (the header search) can count a press inside the portal as inside.

The trigger used to be `hidden md:inline-flex`, because its popover opened only on `:hover`, and so every metric explanation on the investments screens (TWR, MWR, CAGR, simple return, investment result, net flows, cost basis, incomplete valuation) was missing on a phone. What the fix rests on:

- **Never hide the trigger at a breakpoint.** Its hit area is extended with a `before:` inset so a finger finds the 16px icon.
- **Hover belongs to a mouse.** A phone emulates `mouseenter` on a tap, and a hover state that opened then would be toggled shut by the tap's own click; the handlers read `pointerType`. For the same reason the inline popover shows on `group-focus-visible`, never `group-focus` (Android focuses a tapped button).
- **A tap opens the portal.** A tap-opened popover goes through the fixed, viewport-clamped portal whatever the call site chose: the inline `absolute w-64` box is placed for a desktop column and runs off a phone's edge. `placePopover` (tested pure) clamps both axes and flips to the side that fits, and the popover re-measures on scroll and resize rather than closing, the rule for a portalled menu above.
- **A pinned popover takes its own tap.** It drops `pointer-events-none` so a tap on it closes it instead of landing on the row beneath, and the trigger stops `click`, `mousedown`, `touchstart` and `contextmenu`, the events `useLongPress` listens to, so a tap on the icon neither opens its row nor arms the long press.

`ui-conventions.test.ts` fails a `role="tooltip"` outside `InfoTooltip` (two hover-only exceptions, listed with their reasons); `InfoTooltip.touch.test.tsx` holds the tap, the outside press, the keyboard path and the one-text rule.

## A random value is `crypto.randomUUID()`, never `Math.random()`

Every client-side use so far has been an id -- a list key, a removal handle, a temporary split row -- and those want uniqueness, which `crypto.randomUUID()` gives (`lib/ai-attachments.ts` is the pattern). `Math.random()` is not a security primitive, and Bearer flags it as CWE-330; `SplitEditor` carried that as a dated exception rather than a fix until issue #1323. `ui-conventions.test.ts` fails on `Math.random` in any production source.

## The demo login is `lib/demo-credentials.ts`, and it matches the server's

The login page pre-fills `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` from that module; the seed that creates the account reads its own copy in `backend/src/database/demo-credentials.ts`, and `demo-credentials.contract.test.ts` fails when the two drift or a second spelling appears under `src/`. Public by design, so not a secret -- but a form that pre-fills a password the seed no longer sets is a demo nobody can enter.

## A link from a report to Transactions is `buildTransactionsHref`

`buildTransactionsHref` (`frontend/src/lib/transactions-href.ts`) writes the parameters `useTransactionFilters` reads (`categoryId` including the `SPECIAL_CATEGORY_FILTER_IDS` pseudo-ids, `categoryType`, `accountIds`, `startDate`, `endDate`) through `URLSearchParams`. The Cash Flow Sankey uses it; the other reports still build their own URLs and migrate onto it in a separate cleanup (follow-up M1 in `docs/specs/sankey-cash-flow.md` section 14).

## A clickable table row -- `useLongPress({ onClick })`

`useLongPress` takes `onClick` alongside `onLongPress`: a plain click runs the row's primary action, a 750ms press (or right-click) opens the mobile action sheet, and a click following a long-press is suppressed. Spread `getRowHandlers(item)` on the `<tr>` and add `cursor-pointer` (accounts, payees, tags, categories, securities lists all do). Do not put the click on a button around the name instead -- the rest of the row becomes dead area. Controls *inside* the row (a favourite star, `RowActions`) must `stopPropagation`.

## A detail page returns to its list above the title, and switches with the caret beside it

Every detail page carries the same two controls: a chevron and "Back to <List>" on the line *above* the title, and `EntitySwitcher`'s caret immediately after the title. The way back is not an action on the thing being viewed, so it does not belong among the buttons on the right. For reports the pair is `BackToReportsLink` and `ReportDetailHeader` (`components/reports/`), and a settings sub-page uses `BackToSettingsLink` (`components/settings/`); `ReportSwitcher` builds the route itself so no call site spells it out. `ui-conventions.test.ts` scans for a hand-rolled back-chevron-to-`/reports`.

**Two switchers on one line means at least one says its name.** `EntitySwitcher` takes `triggerText` (the GEM report's scenario picker reads "Scenario ⌄"); the bare caret stays the default when it is the only one.

**A detail page's actions sit on the title row, not in a row above the body.** `AccountDetailShell` takes `headerActions` for type-specific actions beside the standard set; a signal they need to send the body travels down as a prop (`refreshKey`) rather than keeping the button in the body. A `size="sm"` button in a report toolbar takes `size="md"` in that header.

A switcher list too long to scan takes `group` on its items (`ReportSwitcher` groups in `REPORT_CATEGORIES` order); sections follow the order their first item appears in, so ordering happens in the caller. An item with no `group` renders ungrouped, so a menu whose sections would be a lone heading over everything is better emitted with none at all -- and whether that heading has anything under it is decided by the items the switcher will actually OFFER, since it drops the entity already on screen (the Transactions account widget sections only when a starred account other than the current one exists).

**Which accounts a picker offers, and in what order, is `orderAccountsForPicker`** (`lib/account-utils.ts`): the starred accounts by `favouriteSortOrder` -- the order the user dragged them into -- then everything else by name. It hands back the two halves rather than one list, because each caller needs the boundary as well as the order (`buildAccountDropdownOptions` rules a separator across it; the two account switchers put a section heading above each side), and a flat list would have each of them re-deriving where favourites stop.

Two details it decides so no caller has to. **The favourites are alphabetical within the arrangement**, because `favourite_sort_order` defaults to 0 -- a user who has starred three accounts and never dragged them has three ties, and a stable sort leaves those in whatever order the API answered in, so the same accounts read differently on two screens. And **the name it sorts on is the one the picker DISPLAYS**, which is why `orderForPicker` takes a reader rather than only accepting `Account`: the detail page's switcher shows a linked brokerage/cash pair under one stripped `displayName`, and ordering that list on the stored name reads as unsorted. A pair's star is the *primary's*, because that is the row the accounts list draws and stars.

Four surfaces order account favourites, and they all go through this: both switchers, `buildAccountDropdownOptions`, the Transactions filter's favourite chips (which sit on the same page as one of the switchers, so a second arrangement there is visible drift) and the CSV transfer-rule picker, which held a hand-copied version of the whole rule. The dashboard's `FavouriteAccounts` deliberately does not -- it is the drag-to-arrange surface itself, and its order is the thing being edited.

## A category picker lists every category in tree order as "Parent: Child"

However a surface selects a category, the option list is one shape: built from `buildCategoryTree` (each parent followed by its children), a child labelled `Parent: Child`, a top-level category by its bare name, and **every row selectable, parents included**. `CategorySwitcher` carries the regression tests.

**A picker the user types into creates through `createCategoryFromInput` (`lib/category-create.ts`), never inline.** It owns title casing and the `Parent: Child` shorthand (create or reuse the parent, then the child), and returns every row it created so the caller can append all of them. The guard in `src/test/ui-conventions.test.ts` fails on a second `categoriesApi.create` call site outside the helper and the Categories page's own full create form.

Whether a picker *offers* to create is a property of the surface, not the field: a form that can create passes the creator to **every** category picker it renders, split lines included (`SplitEditor`'s lines silently discarded unmatched text while the Category field offered "+ Create" -- issue #1187). An asynchronous create addresses the row it came from **by id** (rows can move while the request is in flight), and the new category's `isIncome` comes from what the creator returned.

**A filter list's group boundary is a flag on the option, never a divider the caller draws.** `MultiSelectOption.separatorAfter` rules the row *below* the boundary, so a `MultiSelect` marked this way cannot leave a stray line behind when a search stops rendering the rows on one side of it. `buildCategoryFilterOptions` sets it on the last of `SPECIAL_CATEGORY_FILTER_IDS`, which is what separates the four filters for what a record *is* (no category, a transfer, a whole type) from the categories underneath; every panel built from that list gets the same boundary. The rule is dropped while a search is flattening the hierarchy, and when the marked option is the last row left.

**A picker that applies tags to a transaction takes its options from `useTagPickerOptions`** (`frontend/src/hooks/useTagPickerOptions.ts`, over `buildTagOptions` in `frontend/src/lib/tag-options.ts`), fed by `GET /tags/usage`: the `RECENT_TAG_COUNT` tags used most recently (latest non-void transaction dated on or before today, then number of uses, then name) lead the list above a `separatorAfter` rule, and every other tag follows A-Z. Nothing is hidden, so a finished project's tag ("Holiday 2008") still turns up when searched for; it just stops sitting at the top (discussion #708). A transfer counts once, not once per leg, and an acting delegate's order comes only from their READ-granted accounts. The transaction form, its split lines (the form hands `SplitEditor` its `tagUsage`, so the editor does not fetch again), the scheduled-transaction form and bulk update use it; filters, reports, the Tags page and the security form stay A-Z. Usage is fetched on its own effect, never inside a form's `Promise.all`, so it cannot hold up the other dropdowns; it is not cached (it follows transaction writes, and `tags:` is classified as reference data); and a failed lookup is logged and leaves the picker A-Z rather than failing the form.

## An account balance is coloured by its sign -- `balanceColor`, never by account type

`balanceColor` (`lib/format.ts`) is the one rule: negative is red, everything else neutral. Do not add `|| isLiability` (or any `accountType` test) -- a credit card at a credit balance is not in the red, and the sign already carries the meaning. `gainLossColor` is the sibling for a *change* in value (green when up), not for a balance.

**A colour that means something comes from one place.** An amount is coloured by `balanceColor` or `gainLossColor`, which use green and red; never emerald, rose or another hue for the same meaning. A status pill is `Badge`. A warning is amber, not yellow.

## A header panel is `fixed` inside a transformed ancestor -- give it a height, never a bottom anchor

The sliding `AppHeader` always carries a `transform` (`useHideOnScroll`), which makes the header -- not the viewport -- the containing block for every `position: fixed` descendant. A panel mounted in the header (the notifications dropdown, `ActionHistoryPanel`) that anchors with `bottom-0`/`inset-0` is therefore capped at the header's own ~56px box: the full-screen notifications panel only *looked* full while rows overflowed it, and collapsed when empty. Size such a panel with an explicit height (`h-dvh` for the mobile full-screen treatment) and edge offsets that grow past the containing block; `NotificationList.test.tsx` pins the class shape.

## A menu anchored to a caret is portalled and clamped, never an `absolute` box

`EntitySwitcher` renders its menu through `createPortal` at a fixed position measured from the caret and clamped to the viewport (`placeMenu`, tested pure), the way `MultiSelect`, `CalendarPopover` and the portal `InfoTooltip` place theirs. The `absolute left-0 w-72` box it replaced was fine beside a page title at the left edge and wrong the first time the caret sat anywhere else: in the Transactions page's Account Info widget it followed a long account name off the right of a phone, and on a desktop the widget column is `overflow-hidden` and translated -- which clips an absolute child *and* makes the column the containing block of a fixed one (the header rule above, again). A popover that can be opened from inside a card, a column or a table cell goes through a portal with a viewport clamp, and on scroll and resize it **re-measures the anchor, never closes**: opening is itself a scroll and a resize (focusing the filter scrolls its container into view; a phone's keyboard shrinks the viewport), so the first cut, which closed on both like `MultiSelect`, flashed open and shut. Focus the filter with `preventScroll`, not `autoFocus`, and only for a mouse: on a touch device focus raises the keyboard over the list the reader opened the menu to see, so the filter waits to be tapped -- decided by `isTouchDevice`, never the viewport, per the rule above. `EntitySwitcher.test.tsx` holds the clamp, the portal, the flip, the menu surviving its own opening, and the keyboard staying down.

## A control is not offered when nothing can answer it -- and which question to ask depends on the control

Two hooks, because two different prerequisites. A control whose one possible outcome is "configure something first" is worse than an absent one: it costs a click to learn nothing.

- **A payee contact lookup asks `hooks/useContactLookupAvailable.ts`.** Google Places can answer that lookup as well as an AI provider, so the question is "can a lookup run", never "is there a model". Gated on the AI hook instead, the button disappears for a user who configured Places and no AI -- exactly the configuration the feature exists for. The surfaces are the payee form's and detail card's lookup buttons, the transaction page's quick-create confirmation, and the automatic-lookup toggle in Settings. The guard in `src/test/ui-conventions.test.ts` fails any file that reaches a lookup API and imports `useAiConfigured`.

  **A control the user is looking AT is disabled, not hidden.** The buttons on the payee form and detail card are withheld when nothing can answer, because their surface says nothing about why. The automatic-lookup toggle sits directly under the two source rows that cause the state, so switching the last source off makes it read off and disabled (with copy naming the repair) rather than vanish -- a control that disappears under the change you just made reads as a bug. It shows off without WRITING false: switching a source back on restores the setting the user chose.

  **The hook is read once on mount, so the one surface that changes the answer re-reads it.** `refresh()` exists for `PayeeLookupSection` alone: it writes the switches that decide `available`, and `payeeLookupApi.updateSettings` dropping the cache does nothing for a hook already holding its value. It is awaited inside the save, while the card is still in its saving state, so the toggle never renders live against a source that was just switched off. Re-deriving availability from the settings row on the client instead is the thing not to do -- the server's answer already folds in the spent cap and a key it cannot decrypt.
- **The assistant asks `hooks/useAiConfigured.ts`**, because a chat genuinely needs a model: the floating bubble and its own settings toggle.

**A preference outlives the provider that justified it.** `aiBubbleEnabled` stays true after the last provider is deleted, so the floating chat bubble gates on the provider as well as on the opt-in; without that it sits on every page and opens a chat that can only fail. Any future preference guarding provider-backed work inherits the same pair.

The hook answers `configured: false` until the status settles **and** for a status read that failed -- deliberately, because "we could not ask" is not "there is a provider", and it is also what keeps a control from flashing in and vanishing. Read the cached `aiApi.getStatus` through the hook rather than fetching status again: one request serves every mounted surface, and a provider added or removed in Settings drops that cache.

## A report toolbar wraps, and nothing in it sizes itself past the screen

A report's controls sit in one card above the figures, and on a phone that card
is about 311px wide (`px-4` on the page, `p-4` on the card, at 375px). Three
mistakes put a control off the right of it, and all three were reported by a
human reading the app on a phone rather than by a test:

- **A row that does not wrap.** `flex gap-2 items-center` holding a picker, a
  view switch and an export has no way to fold, so the last control leaves the
  card. Every toolbar row is `flex-wrap`, and a group that deserves its own line
  on a phone takes `w-full sm:w-auto` rather than relying on the wrap landing
  where you hoped.
- **`ml-auto` on a wrapped row.** Pushing the trailing group right is correct on
  one line and ragged on three: the group lands alone against the right edge
  under two left-aligned rows. Write it `sm:ml-auto`.
- **An intrinsic width no ancestor can shrink.** A flex item cannot go below its
  content's min-content width, so anything inside a control that refuses to wrap
  sets a floor for the whole toolbar. `MultiSelect`'s `sizeToLongestOption`
  sizer is the case: invisible `whitespace-nowrap` copies of the longest option
  labels give the trigger its width, and an uncapped copy made the *minimum*
  width of the Security Performance picker the longest security name -- wider
  than the screen. Each copy is capped with `max-w-[calc(100vw-12rem)]`, a
  definite length (a percentage would resolve against the width being computed
  and clamp nothing), and 12rem clears the widest page and card padding in the
  app. Below the cap the control is still as wide as its longest option; above
  it the trigger shrinks and the selected label truncates.

**The refresh and export buttons are `ReportToolbarActions`, never laid out by
the report.** Render it as the LAST child of the toolbar's wrapping row and give
it the handlers; it is a full-width row below every selector on a phone (two
equal halves when the report also refreshes prices) and the toolbar's trailing
group from `sm` up. Every report wrote that layout for itself once, and a dozen
wrote it wrong. `ui-conventions.test.ts` fails a report that renders
`ExportDropdown` or `RefreshPricesButton` itself -- exporting a single format
is not a reason to hand-roll a button, because the row takes CSV alone too.

What the shared row encodes, for the two places that still compose by hand:

- **The export's box is not always its button.** `ExportDropdown` draws three
  shapes from the handlers it is given: a dropdown for CSV and PDF together,
  and a single button for either alone (a view that is a matrix of figures
  exports CSV and nothing else; its type refuses both handlers missing). The
  dropdown wraps its button in a `relative inline-block` box, the single-button
  forms are the box. So sizing the export for a phone (`w-full sm:w-auto`)
  means sizing the wrapper through `containerClassName` and the button through
  `className`; where the shape depends on state (a table view that gains a CSV
  export), pass both. A grid cell stretches that wrapper where a flex row would
  not, which is why the actions row is a grid. `whitespace-nowrap` on the
  button keeps the label on one line.
- **A button beside a field is the height of the field.** A `py-1.5` button
  against a `py-2` picker reads as a mistake. Put the row in `items-stretch`
  (or give the export's box `self-stretch`) and pass `h-full`; where the field
  carries a label above it, reserve the label's own space over the button with
  `LabelSpacer` (`components/ui/LabelSpacer.tsx`) so what stretches is exactly
  the input's height, and hide that spacer below `sm`, where the button has no
  field beside it. Never match the padding by hand -- the figure drifts the
  next time either control's type scale changes. A `DateRangeSelector` in such
  a row takes `fillRowHeight`, which makes its presets flex items of the row so
  they stretch with everything else (the Cash Flow Sankey toolbar).

`ChartLegend` is the same trade-off answered per caller: it is one column on a
phone by default, and `phoneColumns={2}` halves the scroll for a legend of short
names (the spending-by-category legend). A name that has to truncate at half
width loses its end silently, so check the longest one before asking for two.

## A control alone on a phone line fills it

On a phone a list page's toolbar wraps: the search takes the first line and
each filter after it lands on a line of its own. A control that keeps its
desktop width there leaves most of its line empty and reads as left-aligned
debris, so **whatever ends up alone on a line below `sm` is `w-full sm:w-auto`**:
the search input, a `Select`, a filter's segmented control (Payees, Categories,
Securities, Currencies, Warranties, Insights) and a disclosure button standing
alone under a list (Payroll Deductions' "Show year-to-date" and "Show previous
periods").

- **A segmented control in a list toolbar is `SEGMENTED_TOOLBAR_GROUP_CLASS`
  with `toolbarSegmentClass`** (`components/ui/segmented-control.ts`), not
  `w-full` appended to `SEGMENTED_GROUP_CLASS` at the call site. The pill alone
  stretching leaves its segments bunched at the left of a wide grey bar; the
  segments `grow` to share the line and stop growing from `sm` up, where the
  pill is its own width again. The pill is a flex item of the toolbar's
  `flex-wrap` row, which is what lets `w-full` take the line.
- **Not a control that shares its line.** The plain `SEGMENTED_GROUP_CLASS`
  stays for a switch beside other controls on one row (the Investments toolbar's
  view switches, a report's view toggle, a dialog's mode switch): stretching it
  there pushes its neighbour onto a new line.

## A `<details>` disclosure is controlled, because jsdom half-implements it

`<details>`/`<summary>` is the disclosure this codebase uses (`PushDiagnostics`, and the foldable Browser push block beside it): native keyboard operation, and the expanded state announced without an `aria-expanded` of our own. But React does not manage `open` the way it manages an input's `value` -- it writes the attribute and stops -- so a component that renders anything off "is this open" must hold that in state, pass `open={state}`, and move it itself. **`onToggle` cannot be the only mover**: jsdom flips `open` on a summary click and fires no `toggle` event at all, so the behaviour is untestable through it and a browser that misses the event leaves the summary describing the wrong state. Handle the summary's `onClick`, `preventDefault()` to cancel the element's own activation behaviour, and toggle state there (Enter and Space on a focused summary dispatch a click, so the keyboard comes with it); keep `onToggle` wired for the toggles no click produces, such as Chrome expanding a `<details>` to reveal a find-in-page match.

**What a collapsed summary stands in for is not the same text the open block shows.** It replaces the block, so it answers the question the block would have -- Browser push collapses to how many devices can be *delivered to*, retired rows named separately rather than summed in, and "Device list unavailable" where the read failed, never the `0` an empty `devices` array would give (the failed-lookup rule, one more time). And a block whose whole content is one sentence explaining why a feature is unavailable does not get a disclosure: hiding the reason behind a click is worse than not folding.

**Which Settings sections are folded is remembered by one store, `settingsSectionStore`** (`monize-settings-sections`), read through `useSettingsSectionCollapsed(section)`. Browser-local for the reason row density is: whether a panel is worth its height is a fact about the screen in front of the reader, not about the account. The store is the density store's lesson applied before it can be relearned -- a second foldable section adds a member to `SettingsSectionId` and a default to `SETTINGS_SECTION_DEFAULT_COLLAPSED` (a `Record` over the union, so the compiler asks for that default), never a second store and never a second line in `persisted-storage.guard.test.ts`. Every default is `false` and that is the rule, not today's coincidence: a section that folds itself before the reader asked has to be found before it can be read. A stored value that is not a boolean, and a key naming a section that no longer exists, both fall back to the default rather than hiding a panel behind a corrupted entry.

**A persisted fold outlives a test, so a suite that drives one resets the store.** `setup.ts` clears `localStorage` between tests and cannot reach a store that has already read it, so the first test to collapse a section leaves it collapsed for the rest of the file -- reset it in `beforeEach`, where nothing is mounted and the write needs no `act()`. And assert the fold on `details.open`, not on the content having gone: jsdom applies no user-agent stylesheet, so the children stay in the document whatever `open` says, and "the button is not there" would pass in a browser and fail here for a reason that is nothing to do with the component.

## A settings screen has one save contract, and it is save-on-change

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

## A password field declares what may be autofilled into it

Every `<Input type="password">` carries an `autoComplete`: `current-password` when it really is this account's password, `new-password` when one is being set here, `off` when it is not a credential of this site at all. Omitting it is not neutral -- a password manager fills a bare box with the saved credential, and the form submits it as typed: the AI provider's API key field silently replaced the stored key ("Saved" on screen, provider dead, row shows `****` either way), and the backup export password is the same shape and worse. `ui-conventions.test.ts` fails on a password input with no `autoComplete`, and on a value outside those three.

## A view that graduates to its own page -- delete the modal, do not flag it

Remove the modal mode instead of keeping it behind a prop: an `onClose?` nobody passes and an `embedded` flag whose only caller always sets it leave every `!embedded` branch compiling, tested and unreachable, still fetching data they no longer show. Delete the props, those branches, the orphaned catalog strings in every locale, and whatever in a shared component only that modal used.

## Copy -- `--` is comment style, never UI text

The repo writes `--` in code comments, and the habit leaks into catalog strings, where it renders literally. In copy use an em dash, or recast the sentence. `messages.punctuation.test.ts` fails the build on a new one (shrink-only baseline for existing). The same applies to anything else that is punctuation rather than words: compose it in the catalog, not in JSX -- `"{units} ({share})"` is one string a translator can reorder; `{value}{' ('}{share}{')'}` is three fragments they cannot reach.

## A transfer's direction comes from the row's own amount -- `transferDirection`

Money leaving an account went **to** the counterpart; money arriving came **from** it. The two legs of one transfer are labelled differently and both are right, and a split line pointing at another account is asked with *its* own amount, not the parent's. `transferDirection` (`lib/transfer-label.ts`) is the only place that decision is made; `transferCsvLabel` is the export's rendering, and the register renders the same decision as its arrow chip. A `ui-conventions.test.ts` guard fails on a new `? 'to' : 'from'` outside the helper.

Coerce before comparing: `'-67.9900' < 0` is false, and a decimal string is what the API sends.

## A transaction's payee display is `usePayeeDisplay`, never a bare `payeeName` read

A transfer created with a blank payee is PERSISTED blank (issue #1214); migration 161 blanked the legacy-stamped rows. The label is resolved at render time: `usePayeeDisplay()` (`hooks/usePayeeDisplay.ts`) returns the stored payee when there is one, otherwise for a transfer leg the localized `common.transferPayee` string built from `linkedTransaction.account.name` -- the counterpart's CURRENT name, so renames and language switches reach every historical row. A surface reading `tx.payeeName || tx.payee?.name` directly shows those transfers as unnamed. English CSV exports use `transferPayeeCsvLabel` (`lib/transfer-label.ts`), byte-identical twin of the backend's `transferPayeeLabel`.

## A description is plain text that RENDERS as a link -- `LinkifiedText`

A transaction's description is where a ticket, receipt or order page ends up, so
the address in it is clickable. What makes that safe is that nothing about the
storage changed: the field is still plain text, `@SanitizeHtml()` still strips
`<` and `>` on write, and `dangerouslySetInnerHTML` still appears **nowhere** in
this tree. `linkifySegments` (`lib/linkify.ts`) splits the stored string into
prose and addresses, and `LinkifiedText` (`components/ui/LinkifiedText.tsx`)
draws the anchors -- around text it hands back verbatim. An `href` is only ever
built through `toSafeExternalUrl`, and only from an explicit `http`/`https`
scheme -- a bare `www.example.com` stays text, because a guessed host is a link
to somewhere the writer did not name.

**A label has to be honest to a reader, not only to `===`.** Three properties
carry that, and each is a test rather than prose: the segments concatenate back
to the input exactly; the label and the `href` are one string, because
`NoteLink` takes no children and so has no second value to disagree; and that
string contains no character that changes how it renders. The third is the one
that was missing. `https://evil.test/<U+202E>moc.knab//:sptth` READS as
`https://evil.test/https://bank.com` and navigates to `evil.test` -- label and
`href` equal as strings, different on screen -- and `@SanitizeHtml()` strips
none of it, since its job is `<` and `>`. So an address ENDS at the first bidi
control, zero-width or C0/C1 character (`INVISIBLE_CHARS` in `lib/linkify.ts`;
none is legitimate in an RFC 3986 address, and the remainder stays in the prose
where it can mislead nobody about where a click goes), and the anchor carries
`dir="ltr"` with `unicode-bidi: isolate` so an override elsewhere in the note --
or an RTL locale around it -- cannot reorder the label either. A homograph host
(Cyrillic `a` in `bank.com`) is deliberately NOT claimed: that is the browser's
punycode job, and asserting it here would be a worse promise than the one this
replaced.

This matters more than it looks: a description is visible to joint owners and
delegates, so the field is a cross-tenant surface. Storing markup there and
rendering it would be stored XSS with an audience.

**An anchor in the register is a control inside a clickable row**, so it stops
the event the way the favourite star and `RowActions` do -- `click`, `mousedown`,
`touchstart` and `contextmenu`, or a tap opens the ticket page *and* the edit
modal behind it. Stopping no more than that keeps the rest of the cell opening
the transaction, which is the dead-area mistake the row-click rule warns about.

**A note being EDITED gets the same affordance a different way.** A `<textarea>`
renders no elements, so the address in a draft cannot be anchored in place --
before this, reaching a link meant saving, finding the row in the register and
clicking it there. `NoteLinks` (same file) lists the addresses beneath the field
instead, live as the text is typed, and renders nothing when there are none.
It shares `LinkifiedText`'s single `NoteLink` anchor, so `target`, `rel` and the
event-stopping cannot drift between reading a note and writing one; the guard
fails a second `<a>` in that file. Its label is the address for the same reason
as everywhere else -- there is no `children` to pass.

**Which surfaces linkify is a decision recorded in both directions.**
`src/test/linkified-description.guard.test.ts` names the four that draw links in
place (the register row and the three report tables) and every other place a
`.description` or `.memo` reaches the screen as text, each with the reason it
stays inert -- a different entity's field, a row not saved yet, or text inside a
`<button>`. It does the same for the note editors: the two that make up the
New/Edit Transaction modal offer `NoteLinks` (both, because the modal swaps the
plain description for `SplitTransactionFields` in split mode, and covering one
leaves the link unreachable for half the transactions a user creates), and the
other six say why they do not. The two lists must between them account for every
form the length guard names, so a new note field cannot ship with no way to
reach the address in it.

## An email's HTML is drawn in `EmailHtmlFrame`, never injected

The receipts dialog shows the mail's own HTML (`bodyHtml`, detail only) in
`EmailHtmlFrame` (`components/email-receipts/EmailHtmlFrame.tsx`), chosen with
the Text view by `EmailBodyView`. The frame is an `<iframe sandbox="">` (no
scripts, no same-origin, no forms, no popups) whose `srcDoc` starts with a CSP
meta (`default-src 'none'`, inline styles and `data:` images only, so remote images, fonts and
frames are not loaded) and `<base target="_blank">`; the dialog says "Remote
images are not loaded." `dangerouslySetInnerHTML` stays out of this tree. A
stored `body_text` that is really HTML is drawn the same way (`looksLikeHtml`). The dialog's third view, "Lines" (`EmailLinesView`), shows the numbered lines a parser matches against, per source, as plain text: the server derives them from the HTML (`lines` on the detail), and the page never parses the HTML itself.

## Nothing interactive goes inside a `<button>` or an `<a>`

The parser closes the outer element at the inner tag, so the click target ends where the nested control begins and the server's HTML stops matching React's -- a hydration mismatch. Fix it at the call site by making the two **siblings**: a wrapper carrying the border and hover, with the navigation button and the nested control side by side. Do not demote the inner control to a focusable `<span>` -- its implicit role is generic, screen readers drop its `aria-label`, and the result is a tab stop announcing nothing. `ui-conventions.test.ts` scans for this; changing a shared component's trigger element is a change to every call site, and the guard tells you which.

A link that looks like a button -- a back or cancel link -- is a `Link` styled with `buttonClassName(...)` (`components/ui/Button.tsx`), never `<Link><Button>`.

## An icon is a heroicon from the outline set

Icons come from `@heroicons/react/24/outline`. The `24/solid` set is only for a filled state, such as the favourite star in `SecurityDetailHeader.tsx`. Never an inline `<svg>` that copies a heroicon path.

Size: `h-4 w-4` in a button or a row (`h-3.5 w-3.5` in a dense row, as `RowActions` does), `h-5 w-5` in a header. The icon sits to the left of its text, and the gap is the container's (`inline-flex items-center gap-1`), not `mr-*` on the icon.

## Figures are tabular app-wide

`body { font-variant-numeric: tabular-nums }` in `app/globals.css` already makes every digit fixed-width, so do not add `tabular-nums` to a cell. Amount, rate and quantity columns are `text-right`. The class survives on existing elements, and two tests pin it (`ColumnChooserMenu.test.tsx` on the hidden-column count, `TransactionsCalendarView.test.tsx` on a calendar chip's amount); a change that removes a redundant class updates the assertion that pins it rather than leaving a test that checks for a no-op.

## `title` is not an information channel

A `title` attribute shows only on a mouse hover, so a phone, a keyboard and most screen readers never get it. An icon-only button has an `aria-label`. Information a user needs (a full amount, what a rate means, a warning) is visible or in an `InfoTooltip`. The one use left for `title` is repeating text the screen already shows in full elsewhere or has cut short (below).

**A truncated name carries its full text.** Put `title` with the full name on the element that is cut, and on a phone wrap (`break-words`) or clamp (`line-clamp-2`) rather than cutting to one line with `truncate`, as `SecurityList.tsx` does.

## A date a person reads goes through `useDateFormat()`

Format a date with `useDateFormat()` (`useChartDateFormat` on a chart axis) and a relative time ("3 hours ago") with `useRelativeTime()`. Never `toLocaleDateString`, `toLocaleString`, `Intl.DateTimeFormat` or a date-fns `format` with a fixed English pattern: each ignores the user's date format preference (`forms-and-formatting.md`).

## Bank Sync provider default

The Bank Sync settings page defaults to SimpleFIN when at least one active connection has an account linked to an open Monize account and every such connection uses SimpleFIN. Pending, expired, revoked, failed, unlinked and closed-account-only connections do not decide the default. Automatic sync selects the cadence and is not an enablement test. Empty, loading and failed reads retain Enable Banking; a manual provider selection wins over subsequent reads for the current visit. Regression coverage is in `frontend/src/app/settings/bank-sync/page.test.tsx`.

## Shared-expense forms and stacked dialogs

`components/shared-expenses/useSharedEntryPreview.ts` requests a server preview
after a typing pause. Save reads only the response whose group, entry and draft
key match the current inputs; preview failures retain the same key and expose
retry. Keep the accepted fingerprint on a failed save so a lost response can be
retried with the original command. The entry-editor tests exercise both response
orders and the save retry. The split editor offers remainder helpers only for
a positive remainder and keeps extras behind an explicit disclosure.

The entry, split and private-booking forms use `Modal` with `fixedHeight` and
`fullScreenOnPhone` so the title and footer stay visible while their body scrolls.
The browser journeys assert that the title and acceptance action remain in the
viewport after scrolling to the proposal on desktop and a 360px phone.

A repeated money field uses a `useId()` identity, not its translated label:
`components/shared-expenses/SharedPrimitives.tsx` supplies one to `CurrencyInput`.
Several payments can have the same caption while their labels still target their
own fields. `components/shared-expenses/SharedBooking.test.tsx` exercises the
separate payment parts.

`Modal` owns its history entry through effect replay. Its unmount cleanup waits
for a microtask and checks the mounted lifetime token before calling
`history.back()`, so React Strict Mode does not consume the page behind a new
modal. Nested review leaves the parent modal open until the review finishes.
`components/ui/Modal.test.tsx` covers the replay; the shared-expense Playwright
journeys cover cancelling a document-created entry and retrying staged uploads.

A portalled `Combobox` follows its anchor with `placePopover` before paint and on
scroll/resize. A delayed scroll event from focusing a low field must not close
its options before selection. Its resize handler checks that an event target is
a `Node` before asking whether the list contains it; a window resize targets the
window. `components/ui/Combobox.test.tsx` covers both events and option selection.

Shared entry attachments stay in the expense form through `useSharedEntrySave`.
Save closes after the entry and selected uploads succeed. A partial failure keeps
the saved entry and failed file operation IDs, so Retry does not write a second
expense. `components/shared-expenses/useSharedEntrySave.test.tsx` covers lost
responses and partial uploads.
The group-only delivery offers no personal booking controls; compatibility reads
and unlink remain in `SharedPrivateFinances`.

Shared overview and entry rows use `SharedGroupTable` and `SharedEntryTable`,
with `Th`/`Td`, `CellLabel` with `CAPTION_CLASS`, CSS-wrapped phone rows and
`useLongPress` plus `activateOnKey` and `INTERACTIVE_ROW_FOCUS_CLASS` from
`components/ui/interactive-row.ts`. `FilterPanelHeader` is shared with Transactions; filter state and
request keys stay in each page. `components/shared-expenses/SharedTables.test.tsx` holds stale-row refusal
and collapsed-filter state. Money uses the square `CurrencyPickerButton` beside
`CurrencyInput` through `SharedMoneyInput`; dependent portions have a bound currency.
