# Frontend: forms, numbers, dates and text

Date and money entry, number formatting in the reader's locale, phone numbers, text caps, CSV export and the form-modal hooks. Read this before adding an input, formatting a figure a person reads, or exporting data.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved. `frontend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Date entry -- `DateInput`, never a raw `<input type="date">`

`components/ui/DateInput.tsx` is the only place a raw date input is allowed; `ui-conventions.test.ts` fails the build if another appears. It carries lenient parsing of typed text, keyboard shortcuts, and `CalendarPopover`. Key behaviors:

- **On desktop it is a text box regardless of format preference** -- the pointer decides the mode, not the format (touch keeps the native picker). The native control's segment-jumping entry is issue #1201.
- **`browser` is not a pattern, and nothing below `useDateFormat` should see it.** `datePattern` off that hook is the concrete arrangement, resolved by `resolveDateFormatPattern` (`lib/date-parse.ts`). `parseFlexibleDate` takes the pattern (7/8 is ambiguous without it); `parseDateFromFormat` stays strict for canonical values.
- **A partial entry is completed, and an unreadable one changes nothing.** Day+month take the year from the field's current date (today when empty); a lone number is a day in the month on screen; unparseable text restores what was there -- clearing the box is the only way to mean "no date". None of this happens on the keystroke: the lenient reading waits for blur or Enter.
- **`setValue()` moves the form, not the box.** Registered with `register('date')`, `DateInput` is uncontrolled: it renders its own `displayValue`/`isoValue` state and only reads the DOM once on mount, so a react-hook-form `setValue` on that field changes what gets *submitted* while the date on screen stays put -- the two silently disagree. To move a date the user can see, pass `value` (the sync effect runs only when `externalValue !== undefined`) or drive it through `onDateChange`. A test asserting the visible input's value cannot see the difference; assert the submitted payload.
- **A screen hosting a date field does not answer a load with a second tree.** `if (isLoading) return <Skeleton/>` unmounts the field being typed into; render load/error states *inside* the one tree. Duplicating the controls block into the second `return` is not a fix (different child indexes still reconcile wrong -- `CashFlowReport` did this). `ui-conventions.test.ts` fails both shapes for any component pairing a date control with a `useReportData` loading flag; a one-shot prerequisite load (the report *forms*' `isLoadingData`) is deliberately not policed.

## Currency entry -- `CurrencyInput`, never a raw number input

`components/ui/CurrencyInput.tsx` is the only way to take a money amount: a `type="text"` field with `inputMode="decimal"` that filters as you type, formats with separators on blur, clears zero on focus, parses through `parseLocaleNumber` and rounds typed amounts to the selected precision (`roundToDecimals`, with two decimals by default, so a typed value does not carry fractional units hidden by the display), re-syncs on external value changes, and accepts inline calculator expressions (`100*1.13` + Enter/blur) plus a calculator modal. Props: `prefix`, `decimalPlaces` (default two), `allowNegative` (default true), `allowCalculator` (default true), `allowSignToggle`. For non-money numbers (share counts, rates, percentages, day-of-month) use `NumericInput`: same filtering, with `decimalPlaces`, `suffix`, `min`/`max`, `allowNegative` defaulting false, no calculator.

`ui-conventions.test.ts` fails the build on any `<input type="number">` or `<Input type="number">` -- resolving the tag each `type="number"` belongs to, because recharts' `<XAxis type="number">` is not an input and is left alone.

**Both components read and write in the user's number locale, and that is the only place a number is parsed from typed text.** A comma-decimal user (pl, de, fr, ...) types and pastes "1200,99", not "1200.99", and the field must round-trip it -- the two fields resolve the decimal/grouping separators from `useNumberFormat().numberSeparators` and go through `lib/number-parse.ts` (`parseLocaleNumber`, `filterNumberTyping`, `formatNumberForEdit`, `normalizeExpression`). Never hand-roll a `replace(/[^0-9.-]/g, '')` filter or a `parseFloat` on raw input text -- that is the dot-only assumption these helpers exist to remove, and it silently drops a comma decimal (turning 1200,99 into 120099); `src/lib/number-parse.guard.test.ts` scans `src/` for that filter fingerprint and fails on a new one outside the legacy `format.ts` helpers. For well-formed en-US input the result is unchanged, and `formatAmountWithCommas` stays the display seam `CurrencyInput` delegates to for the plain en locales; the shared `number-parse` helpers default to en-US separators so a partial mock or an older build never crashes.

**A single `.`/`,` separator is grouping only when its digit runs are valid thousands groups (1-3 digits, then exactly 3 per group); otherwise it is the decimal point.** This is symmetric and is what makes the DOT-GROUP locales (de/es/it/nl/pt-BR/tr) safe: `parseLocaleNumber` reads a typed or pasted `1200.99` / `5.5` as a decimal there, not as `120099` / `55` (the old "a `.` matching the locale group is always grouping" rule was a ~100x/10x silent money error), while `1.234` still reads as `1234`. `filterNumberTyping` therefore does **not** strip a `.`/`,` group separator while typing -- doing so destroyed the dot-decimal before `parseLocaleNumber` could disambiguate it -- and the read-only display of a plain amount goes through `useLocalizedAmount()` (the one bound `formatAmountLocalized` closure), never a hand-copied `seps ?? default` wrapper.

**An editable field works in the locale's Latin-digit form, and every entry point normalizes what the user pastes.** `Intl` renders `ar-EG` as `١٬٢٠٠٫٩٩` (Arabic-Indic digits, U+066B/U+066C separators), and the "Browser" number-format setting reaches such a locale through `getEffectiveLocale` returning `undefined`, so an ASCII-only filter turned an edit of that text into the one digit just typed and the calculator into `1200995`. `getNumberSeparators` therefore returns the `numberingSystem: 'latn'` separators (plus `nativeDecimal`/`nativeGroup` where they differ), `CurrencyInput.formatDisplay` passes `{ latnDigits: true }` so the field shows `1,200.99`, and `parseLocaleNumber` / `filterNumberTyping` / `normalizeExpression` / `stripGroupSeparator` all start with `normalizeNumeralText` (any Unicode `Nd` digit to ASCII, native symbols to latn, bidi marks dropped, U+2212 to `-`). Read-only surfaces stay native like `formatCurrency`; the round-trip test in `lib/number-parse.test.ts` holds "what the pipeline formats, it parses back" for en/pl/de/hi/ar-EG/fa-IR, negatives included.

`CurrencyInput.decimalPlaces` applies to typing, focus, the inline calculator and
the calculator dialog. `evaluateExpression` accepts that precision and defaults
to two decimals for existing callers. Shared expense money fields go through
`components/shared-expenses/SharedPrimitives.tsx` (`SharedMoneyInput`), including
exact shares, multiple payers and legacy private bank portions; percentages, weights
and ten-decimal rates remain `NumericInput`. The selected precision is retained
when opening a bank amount in the calculator. `SharedMoneyInput.test.tsx` exercises
the real currency control through blur, Enter and calculator Apply at zero, two,
three and four decimals.

For a foreign-currency shared expense, `SharedEntryConversion` reads the server's
`groupAmount`, `fxRate`, `fxSource` and `fxRateDate` in both preview and detail.
It never fetches today's rate or recomputes the accepted amount in the browser.
An unavailable conversion stays unknown, a known zero stays zero, and the group
summary names the currency used for balances and totals. Original amounts pass
the group's currency to `SharedAmount.relativeTo`, so `withCurrencyCode` labels
a USD receipt inside a CAD trip even when both currencies use the `$` symbol.
This extra group context does not remove the usual label for a currency that
differs from the reader's preference. Include it in the scrolled form header and
bank-payment figures as well as the expense list and saved detail.
Rates use `FX_RATE_DISPLAY_DECIMALS` for display while the server's stored
ten-decimal rate and already-converted amount remain unchanged.

Both components take a *number* (`value: number | undefined`, `onChange: (value: number | undefined) => void`):

- **`register()` does not fit.** Wrap in react-hook-form's `Controller` and pass `value`/`onChange`/`onBlur`/`ref` (plus `name={field.name}`, or `name`-based test selectors stop matching). Where the schema stores a string, bridge inside the render callback.
- **`min` clamps while typing; `max` only on blur.** Every prefix of a number is smaller than the number, so a ceiling must not fire mid-word -- and `min` is wrong for a multi-digit floor (`min={2}` eats the `1` of `14`): leave it off and let Zod report. Where an out-of-range value must be *discarded* rather than trimmed, keep the explicit range check in the component's `onChange` (`MortgageFields`, `BudgetWizardStrategy`).
- Give each field an explicit `id` when two on one screen share a label -- both components derive `id` from the label text, so a repeated "Years"/"Months" pair collides.

**A field that hands back its own value has not been edited.** Both components re-parse the on-screen text on blur, and for an untouched field that text *is* the parent's value formatted -- reporting it is destructive to parents that do more than store it (the FX panels derived a rate from the cents-rounded total and marked it user-overridden). Both notify only when the value actually moved (`notifyIfChanged`), and both carry a blurred-untouched regression test. A held value with more precision than the display is the same case: the server stores `decimal(20,4)` and writes sub-cent amounts itself (an FX conversion, a transfer's implied destination), a -3.3333 shows as -3.33, and that text re-parses to -3.33, so `CurrencyInput` treats a parse equal to the held value at cents as no edit (A26-M37). A form therefore loads an amount as stored, never `Math.round(x * 100) / 100` (`roundMoney` at most, which is the server's own four decimals), and compares a split set with its parent at four decimals, because the server requires them equal exactly (`backend/src/common/split-amount.util.ts`); a one-cent tolerance let through a set the server refuses. The residual is a user typing the rounded figure over a four-decimal value on purpose, which reads as no edit; currency-aware display precision is the full remedy. `CurrencyInput.test.tsx` and `TransactionForm.test.tsx` ("four-decimal amounts round-trip") hold it. The general rule: **an `onChange` that does more than store the number must also be idempotent** -- guard the side effect on the value having changed at the handler too (`handleConvertedTotalChange` returns early when the incoming total equals the derived one).

## A number a person reads is formatted by `useNumberFormat()`, never by `toFixed`, `toLocaleString()` or the raw `@/lib/format` helpers

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

**A file size is a number too, and its unit is localized with it.** `formatBytes`
off the hook renders through `Intl.NumberFormat`'s `style: 'unit'`, which
localizes the unit abbreviation as well as the digits (`1,5 ko`, `1,5 кБ`) -- so no
unit name is ever translated into a catalog. Picking the unit is pure and lives
in `scaleBytes` (`lib/bytes.ts`); only the rendering needs a locale, which is why
a pure validator takes the formatter as an argument (`validateSelection` in
`AttachmentsSection`) rather than importing one. Never hand-roll a
`(bytes / 1024).toFixed(1) + ' KB'` helper: four surfaces shared one, and it wrote
a `.` decimal beside a reader's own `1 234,56 zł`.

**The ISO code beside a foreign amount is not this rule.** `withCurrencyCode`
(`lib/format.ts`) appends it deliberately when an account's or a security's
currency is not the reader's; localize the number *before* the suffix
(`withCurrencyCode(formatCurrency(amount, code), code, defaultCurrency)`) and
leave the suffix alone.

**A component does not declare its own `formatCurrency`.** Destructure the
hook's and call it. Nine components had wrapped it under the same name to add
something the name no longer said (an `abs`, a dash for `null`, a bound currency,
a `|| 0`, a hand-rolled ISO suffix), so a reader could not tell the hook's
formatter from a local one with different rules. A wrapper that binds a currency
for a chart or renders `null` as a dash is named for what it does (`formatValue`,
`formatMoney`, `formatInAccountCurrency`).

**A small helper is imported, never re-declared.** Rounding is `roundToCents`
(2dp), `roundMoney` (4dp, the backend `roundMoney`'s strategy included, so a
preview rounds a midpoint the way the commit will), `roundToDecimals` and
`sumMoney` from `lib/format.ts`; a bound is `clamp` (`lib/clamp.ts`); an id check
is `isUuid` (`lib/uuid.ts`). `round2` had four copies and `roundMoney` three, at
two rounding strategies, beside helpers that already existed.
`src/test/shared-helpers.guard.test.ts` fails a second declaration of any of
them, a whole-string UUID regex outside `lib/uuid.ts`, and a `formatCurrency`
declared outside the two formatter modules.

`src/test/number-locale.guard.test.ts` scans for all four fingerprints with a
classified allowlist (a `new Date(...).toLocaleString()` is a date, which
`useDateFormat` governs; `lib/utils.ts`'s `sv-SE` timestamps are machine-shaped).
**Its percentage scan is keyed on the literal `%`, not on `toFixed`** -- written
from the diff it matched only the shapes the migration had just removed and
reported clean over fourteen survivors, because the shape that actually
dominates names no formatter at all. A scan written from a diff sees what was
fixed; write it from the rule.
**A readout inside a form is a figure too.** A split preview, a transfer's
source holding or a "shares at price" line renders through `formatShareQuantity`,
`formatPrice` and `formatCurrency(value, code, 4)`, and a catalog string takes
the formatted figure, never a `{currency}{amount}` pair. The same guard fails a
`.toFixed(` anywhere in components, app or hooks: machine-read sites are
classified with their reason, and the readouts not yet migrated sit in a
shrink-only baseline with an exact count per file. A relative time is
`useRelativeTime()`, the one relative-time formatter; the English-only
`formatRelativeTime` was removed from `lib/format.ts` and
`ui-conventions.test.ts` keeps it out.
A component test must not build its expectation with the same helper the
component uses -- `SecurityList.test.tsx` did, so it proved the component agreed
with a hardcoded formatter while the screen disagreed with the user. Set a real
preference row and assert the rendered string, including one case where the
preference deliberately differs from the host locale.

## A phone number is shown through `formatPhoneForDisplay`, never raw

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

## A note field stops the user at the cap -- `TRANSACTION_NOTE_MAX_LENGTH`

Every input that takes a transaction's description or a split's memo carries
`maxLength={TRANSACTION_NOTE_MAX_LENGTH}` (`lib/transaction-note.ts`), so the
limit is something the user runs into rather than something the save reports
afterwards. Eight forms take one of these fields and exactly one of them capped
anything, so typing past the limit in the main transaction form came back as a
bare 400 with nothing pointing at the field.

The number is the server's, mirrored (`backend/src/common/transaction-note.ts`),
and `backend/src/common/transaction-note.contract.spec.ts` fails when the two
layers disagree -- below it the form truncates text the user may legitimately
store, above it we are back to the rejected save.
`src/test/transaction-note.guard.test.ts` names the eight forms and fails one
that loses its cap, counts the inputs in the forms that render the field twice,
and refuses a literal written beside the constant. A description belonging to
another entity -- a budget's, a security's, a custom report's -- keeps its own
limit and is deliberately out of scope.

A calendar day note is the second field written to that pattern, against its
own constant: `CALENDAR_DAY_NOTE_MAX_LENGTH` (`lib/calendar-day-note.ts`,
mirrored by `backend/src/common/calendar-day-note.ts` and the
`ck_calendar_day_notes_body_length` CHECK, held equal by
`backend/src/common/calendar-day-note.contract.spec.ts`). The textarea in
`components/calendar/CalendarDayNote.tsx` carries it, saving is an explicit
Save rather than a blur, a blank body disables Save instead of being sent as a
delete, and Delete asks through `ConfirmDialog`. It is a separate number from
the transaction cap on purpose: the two fields are bounded by different tables,
and one constant serving both would move a limit nobody asked to move.

A note covers a RUN of consecutive days, so the editor carries two `DateInput`s
beside the body and the save sends the whole span. The anchor is the day the
panel was showing, not the span's first day: that is what lets a vacation be
edited from any day of it and what lets one request move either end. The three
rules the editor checks -- no backwards span, no span longer than
`CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1` days, no span that skips the day it is
being written from -- are the server's own (`resolveDayNoteSpan`), repeated here
so the reader is told at the field rather than by a 400 with nothing pointing at
one; they disable Save, they do not make it safe. Changing either end counts as
a draft to lose, so stepping the month asks first even with the body untouched.
`lib/day-note-span.ts` turns the range's notes into the by-day map every surface
reads: one entry per day covered, the same note object on each, clipped to the
grid so a year-long note does not put 365 entries in a map the grid reads 42 of.

The note surface is drawn only when `useCalendarDayNotes` reports `loaded`. The
save is a whole-body upsert, so offering "Add a note" over a list that failed or
has not arrived invites the reader to replace a stored note the client never
saw; "this day has none" is a claim only a loaded list can make. An empty map is
what a failed list and an empty range have in common, which is why it is not the
thing a caller reads -- the same reason an acting delegate, whose routes refuse,
gets no section rather than one that could only fail.

## A CSV file is written by `exportToCsv`, and a number in it is a number

`lib/csv-export.ts` is the only CSV writer: BOM, CRLF, RFC 4180 quoting, formula-injection guard, download. Multi-table exports take `exportCsvSections` (`MonteCarloReport` had a hand-rolled copy that quoted every field and guarded none). `ui-conventions.test.ts` fails on a second `text/csv` Blob or a second `replace(/"/g, '""')`.

The guard cannot key off the first character (`-` opens both a formula and every debit -- issue #1134: Excel refused to total 59 of 64 rows). It asks whether the value *is* a number (optional sign, digits, separators, whitespace, currency symbols, optional `%`), which is provably inert as a formula.

**The reason it reached the user is worth more than the fix.** A prior pass had exempted negative numbers, with a passing test -- but it tested `-100` the JS number, while the API sends the *string* `"-67.9900"` (`decimal(20,4)` crosses the wire as a string while `types/transaction.ts` declares `amount: number`). Two consequences:

- **A money value off the API is a string until you make it one.** `Number(...)` it at the boundary of anything that branches on its type -- an export, a `typeof` check, a `.toFixed`.
- **A test for a type-dependent branch uses the shape the API sends**, not the shape the interface claims (`page.test.tsx` exports a fixture whose `amount` is `'-67.9900'` for this reason).

## Form Patterns

`useFormModal<T>` (`hooks/useFormModal.ts`) manages create/edit modal state with browser-history integration (back button closes), unsaved-changes detection via `UnsavedChangesDialog`, and form submit exposed via ref. Returns `showForm`, `editingItem`, `openCreate()`, `openEdit(item)`, `close()`, `modalProps`, `unsavedChangesDialog`.

Supporting hooks: `useFormSubmitRef` (expose submit via ref), `useFormDirtyNotify` (track dirty state). Forms use react-hook-form + Zod.

**A form round-trips the row it opened: an unedited save sends back what was loaded.** The server cannot tell a figure the form loaded wrongly from a real edit, because the field it lands in is legitimately editable. A transfer is the worked example: its legs are opened from either account's register, and the form's "Transfer Amount" is the SOURCE amount, in the FROM account's currency, while "Amount Received" is the destination's. `TransactionForm.tsx` therefore loads the transfer amount from the FROM (negative) leg whichever leg it was given (`transferSourceAmount`), in the defaults and in `reconciledEditAffectsReconciliation` alike; loading the opened leg's own figure turned a USD 100 -> CAD 135 transfer opened from the CAD side into a 135 -> 135 one on a description edit, at a stored rate of 1 (A26-H13). `TransactionForm.test.tsx` ("a cross-currency transfer opened from its receiving leg") opens the receiving leg, saves unedited and asserts the payload, for edit, duplicate and a reconciled leg. The server half is the generic row update refusing a structural change to one leg (`docs/financial-semantics.md`, "Editing one row must not leave the pair describing two different events").

**An edit saved in the other family of modes converts the row in place, through its own route.** The transaction form's mode selector offers Transaction, Split and Transfer on a new entry and on an edit alike (issue #1937). A transfer is created by `createTransfer`, and calling it from an edit created a second, new transfer and left the edited row in place, under a button labelled "Update Transfer" (A26-H14); so an existing income, expense or split saved in Transfer mode calls `transactionsApi.convertToTransfer`, and an existing transfer leg saved in Transaction or Split mode calls `transactionsApi.convertToTransaction`, each one server transaction that keeps the row's id and creates or removes the counterpart (`docs/specs/transaction-transfer-conversion.md`). The button reads "Convert to {mode}" (`form.submitConvert`) when the save is a conversion. Leaving Transfer mode on an existing leg hands back the row's own account and signed amount (`handleModeChange`): the form had loaded the PAIR, source account and source amount, whichever leg was opened, and saving those on the receiving leg would have moved it into the other account. Converting a transfer away deletes its other leg, so a CLEARED or RECONCILED counterpart gets a `ConfirmDialog` (`form.counterpartConfirm`) before the save; the strict reconciled lock's refusal is the server's. A split-transfer leg and a leg whose counterpart is another owner's (`conversionLocked`) keep the badge and get no tabs, because the server refuses converting either. `TransactionForm.test.tsx` ("mode selector visibility") pins the three tabs on an expense, a split and a transfer, the two conversion calls and their payloads, the warning, and the locked legs.

**A quick-fill copies what a row says, never the context the user is entering in.** The transaction form's Recent (history) button lists recents deduped *across accounts*, so the chosen row usually belongs to somewhere other than the account the modal was opened on. `handleQuickFill` fills payee, category, amount, description, tags and split lines, and leaves three fields exactly as the form holds them:

- `accountId` -- moving the entry to the source's account silently changes which ledger the user is writing to.
- `currencyCode` -- it is derived from the selected account by the account effect in `TransactionForm.tsx`, and a copied code would denominate the amount in a currency the account does not hold (the same "currency comes from the account, not the request" rule the backend enforces with `assertTransactionCurrencyMatchesAccount`).
- `transactionDate` -- the date on screen is the user's, typed or carried over from the remembered last entry. Resetting it to today re-dates a back-dated batch one row at a time, and the source row's own date is when *that* transaction happened, not this one.

The date case is also the worked example of the `DateInput` `setValue` trap above: the old reset never moved the visible box, only the submitted value. `TransactionForm.test.tsx`'s quick-fill block pins all three, and asserts the *submitted payload* for the date and the currency.

## A number is localized too, and by its own preference

`user_preferences.numberFormat` decides separators, grouping and currency placement, and it is independent of `language` -- an explicit `numberFormat` wins, `"browser"` falls back to the UI language. Every figure addressed to a person goes through that resolution: `useNumberFormat()` on the client (`docs/frontend/forms-and-formatting.md` has the four banned fingerprints and the guard), `backend/src/common/number-locale.util.ts` on the server, where `"browser"` cannot be resolved and lands on `DEFAULT_LOCALE`. `backend/src/common/format-currency.util.ts`'s `en-US` helpers stay for output read by a MACHINE -- an LLM prompt, and the English `description`/`message` fallback stored on a row whose UI composes its own copy from the structured `data` -- and `number-locale.guard.spec.ts` holds that classification, caller by caller, with the reason each is exempt. A pre-formatted money string in a notification's params is neither: send `amountValue` + `amountCurrency` beside the English `amount` so the reader's client formats it.

Restore summaries use `translationKey` entries in `lib/restore-labels.ts` for new
count labels. `components/settings/BackupRestoreSection.tsx` translates these in
the settings namespace; the restore-label contract checks every backend count
key, and the component regression checks a shared-group label and its count.

### Shared split editor

`SharedSplitEditor` presents amount, percentage and relative shares together.
`shared-split-editor.ts` keeps explicit values pinned and delegates blank amounts
to `splitRemainderEqually`; it never replaces an unchanged equal split with locally
rounded amounts. Money readouts come from `useSharedEntryPreview`, bound to the
current operation/entry identity, while the parent expense previews its real
payers again before saving. Templates edit proportions without fictitious money.
An unedited money field waits for its pending automatic preview before accepting
input; a focused edit stays editable when cleared, so the preview cannot replace
text between selecting the old value and typing its replacement.
The numerical cases and missing-data policy are in
`docs/specs/shared-expenses-ui-consistency.md`.
