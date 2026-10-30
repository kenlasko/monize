# Frontend: screens and dialogs

How a list page, a register, a detail page, a report, a settings screen and a dialog are put together, so a new feature looks like the screens users already know. Read this before adding a page, a dialog or a toolbar. `ui-conventions.md` says which component to use for a single control; this document says how the controls are arranged and how they are worded.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved.

## Copy the established screen, never the most recent one

The reference screens are the ones users spend their time on: **Transactions, Investments, Securities, Currencies, Accounts** and the New/Edit Transaction dialog. Before building a screen, open the reference screen of the same kind and put the two side by side.

Do not take the pattern from the most recently merged feature. A recent screen is not yet reviewed against the rest of the app, and an agent that searches recent commits for "how this repo does it" spreads its drift to the next feature. This rule came from PR #1890: the shared-expenses screens copied the `Modal` header and the AI-review/email-receipt layouts, which had themselves drifted from the reference screens. If a recent screen and a reference screen disagree, the reference screen wins, and the recent screen is a defect to report.

**Where a reference screen and a rule in this document disagree, the rule wins.** Each such gap was decided one by one (issue #1914) and is listed under [Known debt](#known-debt) at the end. Do not copy a listed gap into a new screen, and do not cite the reference screen to justify it; fix it when you are already in that file, or leave it to its tracking issue.

Rules that describe the majority of today's code bind new and changed code. Where the minority has not been converted yet, that is debt too, not a second accepted pattern.

## A dialog looks like New Transaction

| Do | Do not |
|---|---|
| Large bold title (`text-2xl font-bold`) at the top of the content padding | A small title in a header strip |
| Close with Cancel / Close in the button row, Escape and backdrop | An X button in the corner as well as Cancel |
| Spacing between header, body and buttons | A full-width line under the header or above the buttons |
| A divider, when one is needed (under form tabs), inside the content padding | A divider that runs edge to edge of the panel |
| Explanation in an `InfoTooltip` beside the label or title | A paragraph under the title or above the buttons that every user must read again on each open |
| One primary button: the action that saves or confirms | A second primary button (a link to another page styled as primary) |

**The title goes through `Modal`'s `title` prop**, which wires `aria-labelledby`, so the dialog has an accessible name. `Modal` draws that title as the New Transaction heading above: no `border-b` strip, no close button beside it, and no `border-t` strip around `footer`. Its `description` is an `InfoTooltip` beside the title, never a paragraph under it. With `padding="none"` the heading sits inside the padding the caller gives the panel through `className`; with `padding="md"` or `fixedHeight`, `Modal` pads it. Because there is no X, every titled dialog draws its own Cancel or Close in every state, a loading or error state included. A dialog that draws its own `h2` instead of passing `title` has no name and is a defect, whatever it looks like.

**Layout of a form dialog** (the New Transaction dialog in `app/transactions/page.tsx` and `TransactionForm.tsx`):

- **Panel.** `Modal` keeps `padding="none"`; the panel's `p-6` comes through `className`. The title is `mb-4` above the form, and the form body is `space-y-4`. A host of `TransactionForm` passes `maxWidth="6xl" className="p-6 !max-w-[69rem]"`, as Transactions, Reconcile, Bills and the foreign-currency fees surfaces do, so the dialog has one size wherever it opens. Not every host does yet (see [Known debt](#known-debt)).
- **Fields.** One column on a phone, two or three from `md:` (`grid grid-cols-1 md:grid-cols-2 gap-4`). The whole panel scrolls (`max-h-[90vh]`); no inner scroll box.
- **Button row.** `FormActions`: right-aligned, `pt-4` above it, not sticky. Cancel (`outline`, disabled while submitting) first, the primary last. A secondary save mode uses `SplitSubmitButton`, as New Transaction does, with the plain create first and "... & New" second; do not add a separate button or flow for it.
- **Open and close.** A form dialog uses `useFormModal` (`pushHistory` + `onBeforeClose`) and renders `UnsavedChangesDialog` beside the `Modal`; the form takes `onDirtyChange` and `submitRef`.
- **A warning before a save** is `ConfirmDialog variant="warning"`, as `TransactionForm.tsx` does before saving a change to a reconciled transaction.
- **A destructive action inside a form section** ("Cancel split") is red text in that section's header row, never a danger or primary button.
- **A toggle pair is the segmented control.** `variant="primary"` is never the selected state of two buttons that switch between options.

### A confirmation is its own kind of dialog

`ConfirmDialog` and `UnsavedChangesDialog` are the one exemption from the table above. A confirmation keeps its coloured icon, a smaller title and one paragraph that asks the question: the paragraph is the question, not help text, so "no paragraph under the title" does not apply. Everything else does:

- **Title**: a Title Case phrase naming the action ("Delete Transaction") or, where the user is choosing between actions, the situation ("Unsaved Changes"). Not a question. The question goes in the body ("Delete this transaction? This cannot be undone.").
- **Buttons**: `<Button variant="outline">` for Cancel, then `<Button variant="danger">` for a destructive confirm or `variant="primary"` otherwise. Never a raw `<button>` with hand-written colour classes.
- **Every delete or remove asks first with `ConfirmDialog`**, never `window.confirm`. An irreversible account-level action (delete the account, restore a backup, disable two-factor sign-in) uses the inline typed or password confirm of `DangerZoneSection.tsx` instead.

## Field labels

- **Title Case nouns**, as in the rest of the app: "Account Name", "Funds From (optional)", "Price per Share".
  - Articles, conjunctions and prepositions of **three letters or fewer** stay lower case: "a", "an", "the", "and", "or", "of", "per", "by", "to", "in", "on", "for". A preposition of four letters or more is capitalised: "From", "With", "Into", "Over".
  - A word that belongs to the verb (a phrasal particle) is capitalised whatever its length: "Group By", "Sort By", "Set Up".
  - The first and last word are always capitalised ("Share a Private Document", not "Share A Private Document").
- **A label names the field; it is not a question.** "Description", not "What was it for?".
- **No trailing colon.** "Amount", not "Amount:".
- **Optional fields** end with "(optional)". **Required fields have no marker**: neither "*" nor "(required)".
- **The amount's currency is shown once**, by the `CurrencyInput` symbol; do not repeat it as "({currency})" in the label.
- **A field whose meaning is not obvious gets an `InfoTooltip`.** Test it with a real case: "I am on holiday in Germany. Do I pick PLN or EUR?" If the label alone does not answer that, rename the field ("Settlement Currency") or add the tooltip.

Today about a third of the app's field labels are sentence case, in whole feature areas rather than scattered. They are debt to be converted area by area (see [Known debt](#known-debt)); a new or edited label is Title Case even when its neighbours are not yet.

## Wording

- **Button text is Title Case**, by the same rule as field labels: "Add Shares", "New Transaction", "New Rule", "Try Again".
- **Save**: a plain save button reads "Save" for a new record and "Save Changes" for an edit. Not "Update", not "Save changes". A form whose primary is a `SplitSubmitButton` names the action and the record instead, as New Transaction does: "Create Transaction", then "Create Transaction & New", and "Update Transaction" on an edit.
- **Retry** is "Try Again", never "Retry".
- **A placeholder example** is "e.g. 12.50", not "e.g., 12.50".
- **An ellipsis is three full stops** ("..."), as the app writes it: "Search by symbol or name...". Not the single character.
- **A failure message** starts "Failed to ..." and has no closing period: "Failed to load currencies".
- **`--` is never UI text** (`ui-conventions.md`, "Copy").

## Money entry

The currency of an amount is chosen with `CurrencyPickerButton` beside the amount field, as in New Transaction. Do not add a separate Currency select next to the amount. The amount field shows the currency symbol from `CurrencyInput` (`zł 400.00`); do not show the ISO code as a prefix.

## A list page looks like Currencies and Securities

The page is `<main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">` at full width (a settings page is `max-w-4xl mx-auto` instead). Top to bottom:

1. **`PageHeader`**: title, help icon (every list page passes `helpUrl`), one-line subtitle. The actions on the right: secondary actions (Refresh, Refresh Rates) as bordered buttons, then the one primary "New ..." button last.
2. **Summary row**: `SummaryCard`s with an icon each (`SummaryIcons`), laid out by `SummaryCardGrid` / `summaryGridClass`, the grid the detail pages use, so the gap is the same everywhere. Do not use a free-form card with a `<dl>` inside, and do not write a grid gap of your own.
3. **Toolbar row**: the search field first, then the filter segments, wrapping on a phone (`flex flex-wrap`, `w-full sm:w-auto`, `sm:ml-auto`; see `ui-conventions.md`). A `flex-col sm:flex-row` row without `flex-wrap` does not wrap between the two.
4. **The list**, in `${CARD_CLASS} overflow-hidden`. While it loads, `<LoadingSpinner text>` renders inside that card; an empty list renders `EmptyState` from inside the list component, not from the page.
5. **Below the list**: `ListBottomPager` with its `totalLabel` ("9 currencies"), which also carries `Pagination` when the list pages. Not a free-standing centred "N items" line.

### The table

- **A table, not cards** (`CurrencyList`, `SecurityList` are the models for everything except their header cells). Cards in a grid are for a dashboard, not for a list of records the user scans, sorts and compares.
- **Header cells are `Th` / `TH_CLASS`** (`components/ui/Table.tsx`), never a hand-copied class string or a local `HEADER_CLASS`.
- **A sortable header** carries `aria-sort` and is reached and activated from the keyboard. In a list it is a `<th aria-sort>` in `TH_CLASS` holding a `<button>` with `SortIcon`. Report tables keep `SortableHeader`, which makes the `<th>` itself focusable (`tabIndex={0}`, Enter and Space through `onKeyDown`) and stays off `TH_CLASS` (`ui-conventions.md`, "table chrome"). A `<th onClick>` with neither is not reachable from the keyboard.
- **Sort is remembered**: `useLocalStorage('monize-<list>-sort-field')` and `'monize-<list>-sort-dir'`. A sort, filter or search change resets to page 1. A status filter starts at `'active'`.
- **A clickable row** goes through `useLongPress({ onClick })`; **row actions** are `RowActions`, at the right.
- **Number, rate, amount, quantity and action columns are right-aligned** (`text-right`).
- **Density**: `useDensityPreference(view)`, with `DensityToggleBar` above a table (`CurrencyList`) or `DensityToggle` in `ListTopToolbar` for a register.
- **Phone layout**: `wrapped = isMobile && density === 'normal'` renders one card cell per row under a slim sort header (Currency, Security, Account, Payee, Institution and Warranty lists); a register uses `useRegisterPhoneCard`.
- **A column chooser** (`useHiddenColumns` + `ColumnChooserMenu`) belongs to a register only (Transactions, Investment Transactions, grouped holdings). A list of records does not gain one.

### Behaviour

- **Reload after undo/redo and AI actions**: `useOnUndoRedo(load)` and `useOnAiAction(load)`.
- **Create and edit a record** with `useFormModal` + `Modal` + `UnsavedChangesDialog` (see the dialog rules above). A deep link to one row uses `useHighlightParam`.
- **A back or cancel link** is a `Link` styled with `buttonClassName(...)`, never `<Link><Button>` (`ui-conventions.md`, "Nothing interactive goes inside a `<button>` or an `<a>`").

### Search

- **No label above the search field.** The placeholder says what is searched: "Search by symbol or name...", "Search by code or name...".
- **The list filters while the user types.** Do not add a "Search" button. A search that needs a server round trip is debounced, not submitted.
- Search syntax help, when there is any, is the `SearchSyntaxHelp` pattern beside the field (Transactions).

### Filters

- **A filter of one list is the segmented control** (`SEGMENTED_TOOLBAR_GROUP_CLASS` + `toolbarSegmentClass` in a list toolbar), next to the search, **with counts**: "All (9)", "Active (3)", "Inactive (6)".
- **A control alone on its line on a phone fills the line.** The search, a filter's segmented control, a `Select` and a disclosure button below a list all take `w-full sm:w-auto`; see `ui-conventions.md`, "A control alone on a phone line fills it".
- **Filters are always visible.** Do not fold People / From date / To date behind a `<details>` "Filter by ..." disclosure. A filter the user cannot see is a filter the user forgets is applied. The one exception is a register's many-field filter panel (below).

### Refresh and export

- **Refresh** is a bordered button with an icon in the `PageHeader` actions, as on Investments. When the data has an age, the button shows it ("Refresh (3 hours ago)"). It is never loose text at the end of a row, and never in the toolbar row.
- **Export is optional on a list.** Where a list has one, it is a text button passed through `ListTopToolbar`'s `actions` (Transactions), which styles it with `LIST_TOOLBAR_BUTTON_CLASS`; in a report it is `ReportToolbarActions`. `ListTopToolbar` has no export control of its own. Export is never a text button in the filter row.

## A register is a list page with more filters

Transactions and Investments are registers: long, dated lists of entries with many filter fields. They follow the list page above, with these differences:

- **The summary row may be a chart** instead of `SummaryCard`s (Transactions).
- **The filter panel may fold away**, because it holds more fields than fit above the list (accounts, categories, payees, dates, amounts). The folded header must still show how many filters are applied and a Clear button, as `TransactionFilterPanel` does, and its fold toggle is a `<button aria-expanded>` that the keyboard reaches, not a clickable `<div>`. A filter that fits in a segmented control stays visible.
- **The search field** still follows the search rules: no label, first in its row.
- **One primary "New" button**, the one in `PageHeader` (`NewTransactionButton`). No second blue "New" button in the list or below it.
- **Density and columns** live in `ListTopToolbar` (`DensityToggle`, `ColumnChooserMenu`).

## Navigation between views is `Tabs`; a segmented control filters one list

| The control switches ... | Use |
|---|---|
| between different views or sections of a page (Groups / People; Expenses / Balances / Files / Settings; Brokerage / Cash registers) | `Tabs` (`components/ui/Tabs.tsx`), as on the security, payee and category detail pages |
| the subset of one list (Active / Archived, All / Pending / Applied) | the segmented control, with counts |
| the shape of one view (Table / Calendar) | `ViewModeToggle` |

The two look different on purpose: `Tabs` says "you are now somewhere else", the segmented control says "the same list, filtered". Using the pill for navigation makes a section look like a filter.

## A detail page looks like the security detail page

- Chevron + "Back to <List>" **above** the title, and `EntitySwitcher`'s caret after the title (`ui-conventions.md`, "A detail page returns to its list above the title"). Not "All <Things>".
- Actions on the title row, primary last.
- Then, top to bottom: the `SummaryCard` row (`SummaryCardGrid`), an optional grid of charts, then `Tabs`, then the tab's own toolbar and list as on a list page.

## A report keeps its toolbar while it reloads

- **The toolbar stays mounted.** Loading, error and empty states render inside the chart card, below the toolbar, as `SpendingByCategoryReport.tsx` does, so focus in a `DateInput` survives a reload. Never return early with a skeleton for the whole report (`forms-and-formatting.md`, "A screen hosting a date field does not answer a load with a second tree").
- **Loading** inside a report is `Skeleton` (`components/ui/LoadingSkeleton.tsx`).
- **An error** is `ReportError` with `useReportData().reload` as its retry.
- **The date range** is `DateRangeSelector` with `showCustom`. Its `ranges` presets are not standardised yet (a dozen different sets today); pass a set an existing report already uses rather than a new one.
- **A chart / table switch** is `ChartViewToggle`.
- **Legends**: a pie or donut chart uses `ChartLegend`; every other chart uses the recharts default `<Legend />` at the bottom, at the same font size.
- **The toolbar wraps** (`ui-conventions.md`, "A report toolbar wraps").

## A settings section is one card

- One card per section with an `h2 text-lg font-semibold mb-4`; a sub-group inside it is headed `h3 text-sm font-semibold mb-1` (`ProfileSection.tsx`, `BackupRestoreSection.tsx`).
- The danger zone is the red-bordered card, last on the page (`DangerZoneSection.tsx`).
- The page is `max-w-4xl mx-auto`, and saves on change (`ui-conventions.md`, "A settings screen has one save contract"). The Settings page itself carries the section sidebar, so it is `max-w-6xl` and its content column keeps the `4xl` width; its loading state and `app/settings/loading.tsx` take the same frame.
- A settings sub-page (AI, bank sync, shared access, emergency access, tours) returns to Settings with `BackToSettingsLink` above its `PageHeader`, never a `&larr; Back` text link.

## Loading, errors and feedback

- **Loading**: a route has a `loading.tsx` built from the `*Skeleton` components in `components/ui/LoadingSkeleton.tsx`; a report uses `Skeleton`; a component uses `LoadingSpinner`. Never plain "Loading..." text.
- **A load error outside a report** is `EmptyState` with `ExclamationTriangleIcon` and a "Try Again" `Button`, inside `role="alert"` (`RuleEditor.tsx`). There is no shared inline error banner yet; do not hand-roll a new one, use this pattern.
- **A button that saves shows progress with `<Button isLoading>`**, not a label ternary such as `isSaving ? t('saving') : t('save')`.
- **Feedback after a write** is `react-hot-toast` (default import `toast`): `toast.success(...)` on success, `toast.error(getErrorMessage(err, t('...Failed')))` on failure, plain `toast(...)` only for information.

## Repeated sections use the existing layout

When a section already exists on a reference screen, the new screen uses the same component and the same layout, even when it shows other data:

- **Attachments**: `AttachmentsSection` as in New Transaction. "Attachments" label on the left, the buttons on the right, "No attachments yet" below. No extra card around it, no `EmptyState` with an icon inside a form. An extra action (share a document) goes into the same button row.
- **Warranties**: the same row layout as Attachments.

## Buttons with the same label do the same thing

- Two buttons on one screen with the same label do the same action and have the same style. If one of them does something else (records a payment that is not in the list), it gets its own label ("Record Other Repayment").
- A row action repeated on every row is an outline button or a `RowActions` entry. A screen-level action is in the header or the toolbar, not below the last row.

## Switches have labels

`ToggleSwitch` always has its visible label beside it. A switch with no text next to it, or with a button attached where its label should be, cannot be understood without trying it. A navigation link next to a switch goes on its own line.

## Known debt

Each line is a reference screen or shared component that does not yet follow a rule above. They were decided in issue #1914 and are tracked in the code issues it links (#1915 to #1919). The rule is the target; the code listed here is not a pattern.

| Rule | Where the code still differs |
|---|---|
| `Th` / `TH_CLASS`, sortable header holds a `<button>` | `AccountList`, `TransactionList`, `HoldingsList` and `InvestmentTransactionList` hand-copy the header class. `CurrencyList` and `SecurityList` use `SortableTh` (`components/ui/Table.tsx`). |
| Toolbar above the list | Accounts keeps its search and filters inside the list card, with no toolbar above the list. |
| Navigation is `Tabs` | Investments switches Brokerage / Cash registers with a segmented control (`InvestmentViewToggle`); the switch sits in each register's header, so moving to `Tabs` means a `tabpanel` around each register in both hosts. |
| Count line is `ListBottomPager` `totalLabel` | Currencies and Securities draw a centred "N items" line. |
| One summary grid | List-page summary rows write their own gaps instead of `SummaryCardGrid`. |
| A report keeps its toolbar mounted | Most reports return early with a skeleton card. |
| Title Case labels and buttons | Whole feature areas use sentence case (auth, import, email receipts, rules, GEM, warranties, Monte Carlo, loan detail), and button labels are split about evenly. |
| `<Button isLoading>` | Several save buttons swap their label with `isSaving ? ... : ...`. |
| One size for the `TransactionForm` dialog | `PayeeTransactionsTab` and `CategoryTransactionsTab` open it at `maxWidth="2xl"`. |
| Wording | Save buttons read "Save", "Save changes", "Save Changes" and "Update"; retry reads "Try again", "Retry" and "Try Again"; placeholders mix "e.g." and "e.g.,"; about half the confirmation titles are questions. |

## Before you open the PR

Put the new screen next to its reference screen at the same width and check:

- [ ] dialog: `title` passed to `Modal`, title size, no X, no full-width lines, one primary button, `FormActions` with Cancel first, help in tooltips
- [ ] confirmation: `ConfirmDialog`, Title Case action title, question in the body, `Button` variants
- [ ] labels: Title Case nouns, "(optional)", no marker on required fields, no questions, no colons
- [ ] wording: "Save" / "Save Changes", "Try Again", "e.g.", "...", "Failed to ..." without a period
- [ ] money: currency picker beside the amount, currency shown once
- [ ] list page: `PageHeader` with `helpUrl` and actions, `SummaryCardGrid`, search with placeholder and live filter, segments with counts, table with `Th` and sortable `<button>` headers, `ListBottomPager`
- [ ] navigation with `Tabs`, filters with the segmented control
- [ ] filters always visible (a register's folded panel shows its count and Clear); refresh and export in their standard places
- [ ] report: toolbar stays mounted, `ReportError`, `DateRangeSelector`, `ChartViewToggle`
- [ ] states: skeleton or spinner by place, `EmptyState` error with "Try Again", `isLoading` on save, toast on write
- [ ] existing sections (attachments, warranties) use their component and layout
- [ ] no two buttons with the same label and different behaviour
- [ ] nothing in [Known debt](#known-debt) copied into the new screen
- [ ] at 375 px nothing leaves the screen

## Shared expense review and list chrome

The dashboard greeting keeps its Customize action. Feature entry points belong
in the existing app navigation, not permanent shortcuts beside that greeting.
Shared expenses is under Tools on desktop and in the navigation drawer on a
phone. The dashboard regression checks that removing the duplicate shortcut
does not remove Customize; the navigation registry tests retain the Tools entry.

The shared-expenses walkthrough anchors group selection to the loaded list.
The phone sheet uses the existing tooltip placement resolver to flip above a low
anchor: scrolling alone cannot uncover a short page's last row. An anchorless
selection step cannot supply that geometry. The desktop, phone and
empty-group journeys in `e2e/tests/shared-expenses-tour.spec.ts` exercise this
interaction and completion persistence.

Shared activity uses Notifications; render private review state only on its explicit
page, and a known-zero result as a plain empty state, never an app-wide notice.
`SharedReviewContent.test.tsx` covers actionable, revoked, failed and stale-identity
responses. Tab panels and expense attachments own their top spacing; browser
geometry tests cover the rendered gap, since component fragments cannot carry it.
Shared group and expense cards use ListTopToolbar with the complete paging state
and ListBottomPager outside the card, including a filtered one-page result.
