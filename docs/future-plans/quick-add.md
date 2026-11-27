# Quick Add

A one-line entry for a new transaction on the Transactions page. The reader types a sentence such as `84.37 loblaws groceries` and Monize reads it as a set of fields shown as chips. Any chip can be clicked to change it. The reader saves the entry as shown, or opens the full New Transaction form with the fields filled in. The reading is programmatic: no model, no provider, nothing leaves the server.

The task list is `docs/future-plans/quick-add-tasks.md`.

## Assumptions

These were agreed with the maintainer before the plan was written.

- **The dialog lives on the Transactions page.** It opens from three places:
  - a secondary "Quick Add" button beside New Transaction in the page header;
  - the phone's + button while the Transactions page is showing;
  - the command palette, from any page. Typing a line with an amount in it offers a "Quick add" row that reads the line the way the dialog will; choosing it goes to the Transactions page and opens Quick Add with the line already typed.

  The dashboard and every other page's + button are unchanged in this version.
- **On a phone the + button opens Quick Add by default**, and the dialog's "Full Form" button opens the New Transaction form. So Quick Add costs no extra tap and the full form costs one.
- **The reader chooses what the + opens.** Settings, Preferences, Mobile Navigation offers "The + button opens" with Quick Add (the default) or the New Transaction form. It governs the + wherever it starts a new transaction: on the Transactions page, and on a page whose + has no action of its own, which goes to the Transactions page and opens the chosen one there. A page whose + does something else (a new bill) is unchanged.
- **Payments, deposits and transfers.** A split, an investment transaction, an entry in a foreign currency, a cross-currency transfer and a transfer to another owner's account are made in the full form; Quick Add reads the line, says why it cannot save it, and hands it to the full form.
- **Every supported language.** The reader can type in the language of their Monize locale; English words are always understood as well.
- **Voice is the phone keyboard's dictation.** Nothing is built for speech; the text box accepts what the keyboard's microphone types.
- **Not while acting for someone else.** The button is hidden while acting as a delegate and the endpoint does not allow delegates. Accounts the reader can reach only through a joint grant are not offered. Both go to the full form, which already handles them.

## Design

### Where the reading happens

The server reads the text, and the client only displays the result. This is the same split as the advanced search (`SearchInterpretationLine`, `docs/specs/advanced-search.md` decision 7). The server holds the payee aliases, usage ranking and per-payee history that the reading needs, and loads them through `withScopedDb`.

`POST /transactions/quick-add/interpret` is read-only. The text goes in the body, not the query string, so it never reaches an access log. Nothing is written, and the endpoint is safe to call on every pause in typing.

The save does not use a new path. The client sends the fields it shows to the existing `POST /transactions` or `POST /transactions/transfer`, with the same body the full form sends. Every validation, the currency taken from the account, rule application, the balance update and the cache invalidation stay on the one existing door.

### Request

```ts
// backend/src/transactions/quick-add/dto/quick-add-interpret.dto.ts
class QuickAddInterpretDto {
  text: string;                 // @IsString, @MaxLength(200); may be empty
  today: string;                // YYYY-MM-DD, the client's useFinancialToday(); isCalendarDate
  contextAccountId?: string;    // @IsUUID: the register's single filtered account, if any
  pins?: QuickAddPinsDto;       // fields the reader set by hand on a chip
}
class QuickAddPinsDto {         // every field optional; @ValidateIf for null/""
  kind?: 'payment' | 'deposit' | 'transfer';   // @IsIn
  amount?: number;              // magnitude, > 0, bounded like CreateTransactionDto.amount
  date?: string;                // YYYY-MM-DD, isCalendarDate
  accountId?: string;           // @IsUUID
  toAccountId?: string;         // @IsUUID
  payeeId?: string;             // @IsUUID
  payeeName?: string;           // @MaxLength like CreateTransactionDto.payeeName; a new payee
  categoryId?: string;          // @IsUUID
  /** Fields the reader cleared on a chip: answered as none and never guessed again. */
  clear?: ('payee' | 'category')[];   // @IsIn each, @ArrayMaxSize(2)
}
```

A pinned id the caller does not own is refused with 404, the way `previewCreate` refuses a category.

### Response

```ts
// Shared shape; the frontend copy lives in frontend/src/types/quick-add.ts.
type QuickAddKind = 'payment' | 'deposit' | 'transfer';
/** How a value was arrived at; decides the chip's tier. */
type QuickAddSource = 'typed' | 'pinned' | 'inferred' | 'default' | 'none';

interface QuickAddField<T> {
  value: T | null;
  source: QuickAddSource;
  /** Two or more candidates matched equally well; `value` is the most used. */
  ambiguous: boolean;
  /** Other candidates, most likely first, at most 5. */
  alternatives: T[];
}
interface QuickAddAccountRef { id: string; name: string; currencyCode: string }
interface QuickAddPayeeRef { id: string | null; name: string }   // id null: a new payee
interface QuickAddCategoryRef { id: string; name: string }        // name is the "Parent: Child" path

interface QuickAddInterpretation {
  kind: QuickAddField<QuickAddKind>;
  amount: QuickAddField<number>;           // magnitude, rounded at the account currency's places
  date: QuickAddField<string>;             // YYYY-MM-DD
  account: QuickAddField<QuickAddAccountRef>;    // the FROM account of a transfer
  toAccount: QuickAddField<QuickAddAccountRef>;  // transfers only; value null otherwise
  payee: QuickAddField<QuickAddPayeeRef>;
  category: QuickAddField<QuickAddCategoryRef>;  // payments and deposits only
  memo: string | null;                     // words nothing else used
  /** Why Save is refused; empty means the entry can be saved as shown. */
  blockers: QuickAddBlocker[];
  /** The account's balance before and after the save, or null without an account and amount. */
  balance: {
    accountId: string;
    currencyCode: string;
    current: number;
    /** Null when the save does not move the current balance today (a future date). */
    after: number | null;
    /** The date the balance moves when `after` is null. */
    movesOn: string | null;
  } | null;
  /**
   * The figure as typed in a currency: set when `foreignCurrency` blocks, and when a currency
   * was typed but no account is known yet to compare it with.
   * `currencyCode` is the ISO code when the typed symbol or code names one currency, else null.
   */
  foreignAmount: { currencyCode: string | null; amount: number } | null;
  /** What the reader's transaction rules will change on save (the planner the commit runs). */
  ruleEffects?: RuleEffectsPreview;
}
type QuickAddBlocker =
  | 'missingAmount' | 'zeroAmount' | 'amountPrecision'
  | 'missingAccount' | 'ambiguousAccount'
  | 'missingToAccount' | 'sameAccount'
  | 'amountTooLarge'           // above the create DTO's TRANSACTION_AMOUNT_MAX_MAGNITUDE
  | 'foreignCurrency'          // a currency was typed that is not the account's
  | 'crossCurrencyTransfer';   // the two accounts hold different currencies
```

The client signs the amount from the kind when it saves: a payment is negative and a deposit positive (`docs/financial-semantics.md`). A transfer sends the magnitude as `amount` from `account` to `toAccount`.

### Reading the text

The pure reader is `backend/src/transactions/quick-add/quick-add-parse.util.ts`. It takes the text, the vocabulary and the candidate lists, does no I/O, and runs in this order. Every step works on what the steps before it left unused.

1. **Normalize.** NFKC, then case-fold in the reader's locale. Latin, Greek and Cyrillic diacritics are folded for comparison only (`cafe` finds `Café`). Combining marks are never stripped from kana, Hangul or Han text. Candidate names are normalized the same way.
2. **Names.** Account names, payee names, payee aliases (`matchesAliasPattern`, the importer's glob matching) and category names (the leaf, and the `Parent: Child` path) are found as normalized substrings. In a script that separates words with spaces, a match must start and end on a word boundary. In Han, kana or Hangul text it may start anywhere, so `ローソンで500円` finds `ローソン`. The longest match wins, and matches never overlap. This step runs before the amount so `7-Eleven` is a payee, not 7.
   - **A span that names both an account and a payee** is the account when a connector word (vocabulary `on`, `to`, `from`) comes right before it, and otherwise the payee. The account is then listed among the account alternatives.
   - **A partial match** is a typed word of three characters or more that starts a payee name. It gives `source: 'inferred'`, ranked by how many transactions use the payee; a tie on that count is `ambiguous`.
3. **Date.**
   - **Absolute dates:** ISO `YYYY-MM-DD`, and a complete date in the reader's `dateFormat`, via the date parser `parseSearchTerm` already uses (exported for this).
   - **Day and month without a year:** `3 nov`, `nov 3`, or `3/11` in the `dateFormat`'s order. The date is the most recent one on or before `today`; a date that would be more than 7 days ahead is taken to be last year's.
   - **Relative words and weekdays:** a weekday name means the most recent such day on or before `today`. The vocabulary's yesterday, today and tomorrow words mean those days.
   - **Names come from `Intl`.** Month and weekday names, long and short, come from `Intl.DateTimeFormat(locale)`. The relative words come from `Intl.RelativeTimeFormat(locale, { numeric: 'auto' })`. So every locale has them without a catalog.
4. **Amount.** The first remaining number, read by the locale-aware amount parser `parseSearchTerm` already uses, under the reader's `numberFormat` (exported for this), so `12,50` is 12.5 for a German reader.
   - **Sign:** a leading `+` marks a deposit and a leading `-` a payment.
   - **Currency next to the number:** a symbol or ISO code that is the account's currency is dropped. Any other currency adds `foreignCurrency`.
   - **Places:** more places than the account currency's `decimal_places` (the entry places `CurrencyInput` rounds to, so a typed value carries no hidden units) adds `amountPrecision`. More than the create DTO's maximum magnitude adds `amountTooLarge`.
   - **A month-name date with a year is a date.** `loblaws nov 3, 2025` is dated 2025-11-03 with no amount; the day beside a month and a year is never taken as the amount.
   - **The month-name date and the amount are read together.** In `20 nov 3 coffee` both the number before and the number after the month could be its day. Each side is tried on its own; when both give a real date, the reader's date order decides, and the line's other number stays the amount.
5. **Keywords.** Words of the vocabulary set the kind (`deposit`, `payment`, `transfer`) and the direction (`to`, `from`); connector and filler words are dropped.
6. **Leftover words.**
   - **No payee found:** the leftover words, in the order typed and joined by single spaces, become a new payee name (`source: 'typed'`, `id: null`). For a payment or deposit the save creates that payee first (a transfer keeps the name as text, as the full form does), as the full form's `handlePayeeCreate` does (offering to reactivate an inactive payee of that name), so the next line finds it.
   - **A pinned payee replaces the words that produced the text's payee**; those words do not become the memo.
   - **A payee was found:** the leftover words are the memo.

### Filling what was not typed

`QuickAddInterpretService` (`backend/src/transactions/quick-add/quick-add-interpret.service.ts`) loads the candidates and fills each field the text did not give, in this order. A pinned field always wins and is never re-read from the text.

| Field | When the text does not give it | Source |
|---|---|---|
| kind | `transfer` when two accounts were named, or one account with `to` or `from`. Otherwise `deposit` when the category is an income category, or when most of the payee's last 10 transactions are deposits. Otherwise `payment`. | `inferred`, or `default` for the final payment |
| account | `contextAccountId` when it is an eligible account. Otherwise the payee's most frequent eligible account over its last 10 non-void, non-transfer transactions, the most recent winning a tie (its other recent accounts are the next alternatives). Otherwise the account of the reader's most recently created transaction. | `default`, `inferred`, `default` |
| toAccount, for a transfer with one account named | That named account is the side `to` or `from` says. The other side is the default account above. | `default` |
| category | Not filled for a transfer. Otherwise the payee's most frequent category over its last 10 non-void, unsplit, non-transfer transactions, the most recent winning a tie. Otherwise the payee's default category. | `inferred` |
| date | `today` | `default` |
| category, cleared by the reader | The payee's default category when the payee has one, because the save adopts it (`create()` fills a missing category from the payee); otherwise none | `default`, or `pinned` with no value |

Because the category and account come from the payee's own history, a correction saved today is tomorrow's answer, with no new table.

- **A payment or deposit word never outranks the accounts' directions.** `paid 500 to visa` moves money into Visa, so it is a transfer; two named accounts, a `to` account on a payment or a `from` account on a deposit make the kind a transfer unless the kind is pinned. A pinned payment or deposit with two named accounts adds `ambiguousAccount`.
- **Eligible accounts:** accounts the reader owns that are open and are not `INVESTMENT_BROKERAGE` or a shared-expense settlement account, the set `NormalTransactionFields` offers.
- **Payees:** payees that are active.
- **Categories:** every category the reader owns.

**The balance line** uses the predicate `create()` uses. Without `isTransactionInFuture(date)` it is `after = roundMoney(current + signedAmount, places)`. With it, `after` is null and `movesOn` is the date. For a transfer the line is the FROM account's.

**Rule effects** come from `TransactionsService.previewCreate` or `previewCreateTransfer` once an account and an amount are known and there are no blockers. They are the same planner the commit runs, over the same facts: Quick Add passes the payee id it will save (null for a new name), and the preview does not resolve the name again. A preview that throws becomes no `ruleEffects`; the interpretation itself never fails because a preview did.

### Bounds

One request's work is bounded whatever the reader has stored, because the reading runs on the event loop that serves every user:

- **Length after normalizing.** The 200-character cap applies to the text after NFKC (one character can expand to 18), and the reader stops at a fixed number of words. The dialog counts the same way and does not send a longer line.
- **Folding names.** Each candidate name is folded once per request, by whole-string operations, whatever its script.
- **Matching work.** Alias matching has a fixed budget of glob evaluations per request. Every name (account, payee, plain or wildcard alias, category) contributes at most a few non-overlapping occurrences, and one reading collects a fixed total of spans, after which further names are not read.
- **Not yet bounded:** folding grows with the number of stored payees, aliases and categories (linear, around 100 ms at 20,000 payees with two non-ASCII aliases each). A per-user cache of folded names is the follow-up.
- **The transaction is short.** Candidates are loaded in one scoped read, the text is read outside any transaction, and usage and history are a second short scoped read over a capped list of ids.
- **Rate.** The route carries its own `@Throttle`.

### Vocabulary

`backend/src/transactions/quick-add/quick-add-vocabulary.ts` holds one entry per base language of `SUPPORTED_LOCALE_CODES`: `en`, `de`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `ru`, `tr`, `uk`, `vi` and `zh`. A regional code reads its base language, and `zh-CN` and `zh-TW` have their own scripts. Each entry lists the words for these roles:

- `deposit` (refund, deposit, received, income, ...)
- `payment` (paid, spent, bought, ...)
- `transfer` (transfer, moved, ...)
- `to`
- `from`
- `on` (on, at, with, via, using, ...)
- `filler` (for, the, a, ...)

The reader's locale is the one `tr()` reads for the request; its words come first and the English words are added after them. The vocabulary is grammar, not display copy, so it is a constant checked by a spec, not a translation catalog. The spec fails a supported locale with no entry, an empty role, or a word listed in two roles of one language.

### The dialog

`frontend/src/components/transactions/quick-add/`:

- **The dialog.** `QuickAddDialog` is a `Modal` titled "Quick Add", opened through `useFormModal` with an `UnsavedChangesDialog` beside it. It holds one large text input (`enterKeyHint="done"`, `autoComplete="off"`), a "Read as" row of chips, the balance line, any blocker messages, and `FormActions`: Cancel, Full Form (outline) and Save. Save is a `SplitSubmitButton` with Save & New, as in New Transaction.
- **When the server is asked.** `useQuickAddInterpretation` calls the endpoint 200 ms after typing pauses, and again whenever a pin changes. It keeps each response with the request that produced it and drops a stale one (`docs/frontend/api-and-cache.md`). A failed request is shown as one, never as an empty reading.
- **Chips.** One for each of kind, amount, date, account, to-account (transfers), payee and category (not transfers), plus the memo when there is one. Each chip is a button, and clicking it opens the control the full form uses for that field (segmented control, `CurrencyInput`, `DateInput`, the account select, the payee combobox, the category picker). The alternatives are listed first. A chip set by hand is pinned.

  | Tier | Sources | Look |
  |---|---|---|
  | Typed | `typed`, `pinned` | Solid primary-tinted chip |
  | Guessed | `inferred` | Outline chip, amber dot, "guessed" in its accessible name |
  | Assumed | `default` | Dashed grey border, "not typed" in its accessible name |
  | Needs you | `none`, `ambiguous`, a new payee | Amber border and a short badge ("New", "2 matches", "Missing") |

  The tier is carried by the border style and a word as well as by colour. Colours are theme tokens, as the existing `Badge` uses them.
- **Keyboard.** Enter saves when there are no blockers. Shift+Enter saves and clears the line for the next entry. Tab moves through the chips. Escape closes.
- **Saving.** Save calls `transactionsApi.create` or `transactionsApi.createTransfer` with the body the full form builds for the same fields, then `invalidateBalanceCaches()`, remembers the date as the form does, refreshes the register and shows the success toast the form shows. Enter or Full Form pressed while a reading is pending acts on that reading when it arrives; Full Form with no reading hands the typed line over as the description, so the reader's words are never lost. A foreign amount is handed to Full Form in its own currency when `foreignAmount.currencyCode` is known, and without an amount otherwise. An ambiguous account is not preselected.
- **A refused pin** (a 4xx because a pinned account, payee or category is gone) is reported apart from a failed request, with a way to clear the changes.
- **Full Form.** It closes Quick Add and opens New Transaction through the page's existing `openCreate` with a new `draft` prop on `TransactionForm`, which seeds a new entry's mode, accounts, amount (signed), date, payee, category and description. A blocked entry is handed over too: that is how a split or a foreign amount gets finished.
- **Entry points.** A `Button variant="outline"` in `PageHeader`'s `actions` slot. Below `xl`, `useMobileAddAction` on the Transactions page runs Quick Add instead of New Transaction. All entry points, the palette row included, are hidden while acting as a delegate.

### The + button setting

- **Stored as a view default.** `mobileAddOpens: ['quickAdd', 'fullForm']` joins `VIEW_DEFAULT_FIELDS` in `backend/src/users/view-defaults.ts` and `frontend/src/lib/view-defaults.ts` (the contract spec pins the two equal), with `quickAdd` as the built-in default. Like `accountOpenTarget` it has no browser copy and is read from the account preference alone. The validator's refusal message names the new key. `viewDefaults` is a JSON column, so nothing in the schema changes.
- **The control.** `MobileTabsGroup` (Settings, Preferences, Mobile Navigation) gains a select under the tab places, saved through the same optimistic `commit` the tab selects use.
- **The + button.** `useMobileAddAction` on the Transactions page runs Quick Add or New Transaction by the setting. The fallback `startNewTransaction` path of the phone + carries the choice, and the Transactions page opens Quick Add or New Transaction to match. The command palette's "New transaction" still opens the form, and its "Quick add" row still opens Quick Add.

### The command palette row

- **When it asks.** `useCommandPaletteSearch` (`components/command-palette/useCommandPaletteData.ts`) adds the interpret call to the search it already debounces, but only when the rested query holds a digit, the reader can reach `/transactions`, and is not acting as a delegate. The call carries the query as `text`, `today` from `useFinancialToday()`, and no `contextAccountId` and no pins. Its answer is kept with the query that produced it, like the transaction results.
- **When the row shows.** `useCommandItems` adds the row only when the answer for the current query has an amount. A query with no amount in it ("2024 report") gets no row.
- **What the row says.**
  - A payment or deposit reads "Quick add: {amount} {payee}, {category}", omitting a part that is null.
  - A transfer reads "Quick add: {amount} {from} to {to}".
  - The amount is formatted with `useNumberFormat()` in the account's currency.
- **Where it sits.** The row is the first item in the actions group. Enter runs it when nothing in an earlier group matched; otherwise the arrow keys or Tab reach it.
- **An overtaken navigation clears it.** Wherever `newTransactionRequest` is cleared because another navigation overtook it, `quickAddRequest` is cleared too.
- **Its own request.** The interpret call runs beside the transaction and help searches, not inside their `Promise.allSettled`, so a slow reading never delays them.
- **What choosing it does.** Running it calls `startQuickAdd(text, pathname, push)` in `store/commandPaletteStore.ts`, beside `startNewTransaction`. That stores a one-shot `quickAddRequest: { text }` and goes to `/transactions` when not already there. The Transactions page consumes the request the way it consumes `newTransactionRequest` and opens Quick Add with the text in the box. The dialog then reads the line again in the page's own context (the filtered account) and carries no pins from the palette.
- **Failure.** A failed interpret call adds no row and does not mark the palette's search as failed. The plain "New transaction" action is still there.

Strings live in `frontend/src/i18n/messages/{locale}/transactions.json` under `quickAdd`, English first and then every locale.

## What to run

- `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run test:unit -- quick-add`, then `npm run test:changed`.
- `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test -- quick-add`, `npm run test -- TransactionForm`, `npm run test -- app/transactions`, `npm run test -- command-palette`, then `npm run test:changed` and `npm run build`.
- Root: `node scripts/check-docs-manifests.mjs`.

## What should be observed

- **Basic reading.** Typing `84.37 loblaws groceries` shows the following, and Enter saves a payment of -84.37 to that account:
  - Payment (Guessed or Assumed);
  - $84.37 (Typed);
  - Loblaws and Food: Groceries (Typed);
  - the last-used account and today (Assumed, dashed).
- **Category from history.** Typing `84.37 loblaws` fills the category from Loblaws' history as Guessed.
- **Transfer.** Typing `500 chequing to savings` shows a transfer between the two accounts, and Save writes both legs.
- **Blocked entry.** Typing `20 € cafe` against a CAD account refuses Save, says the amount is in another currency, and Full Form opens New Transaction with the entry filled in.
- **Another language.** A German reader typing `12,50 bäckerei gestern` gets 12.50 dated yesterday.
- **Phone.** On a phone the + button on the Transactions page opens Quick Add. With "The + button opens" set to the New Transaction form, it opens the form there and from the dashboard.
- **Command palette.** On the dashboard, typing `84.37 loblaws` in the palette shows "Quick add: $84.37 Loblaws, Food: Groceries" as the first action. Enter goes to Transactions with Quick Add open on that line.

## Invariants touched

- **INV-CACHE-001:** the save invalidates balance caches.
- **INV-MONEY-001:** the amount is refused at more places than the account carries, before the save.
- **Rule-effects preview and save planner:** both run on the same planner (transaction rules design I3).
- **Preview equals commit:** the balance line uses the predicate `create()` uses.
