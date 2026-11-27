# Microsoft Money (`.mny`) import

Native TypeScript pipeline for importing complete Microsoft Money files. Design and task list:
`docs/specs/mny-import.md`.

```
.mny upload -> msisam/msisam-decrypt.ts -> mdb-reader -> msisam/open-mny.ts
  -> tables/*.ts (tolerant row readers) -> map/*.ts (pure functions)
  -> writer (withScopedDb) -> verification report
```

Implemented so far: the whole pipeline through Phase 3 -- decrypt, readers, mappers, writers, the
background job and the wizard. Banking data, investments, scheduled bills and inferred loan terms
all import; what remains is Phase 4 hardening (see the design's task list).

## Coded values

`model/mny-model.ts` holds every Money code and its Monize equivalent -- account types, cleared
status and the `grftt` flag bits, investment actions, category classification, recurrence
frequencies. Each constant is labelled **confirmed** (asserted against the fixtures in
`mny-model.spec.ts`) or **unconfirmed** (carried from the format reference). An unconfirmed code
that turns up in a real file must become a warning in the verification report, never a silent
mapping: `mapAccountType`, `mapInvestmentAction` and `mapFrequency` all return null for codes they
do not know, and `MNY_UNCONFIRMED_ACTIONS` names the ones whose meaning is inferred.

### Where the file can answer for itself, do not ask the code table

`BILL.frq` had eight entries carried from the format reference and no fixture to
check them against. The one entry a bug report could check was wrong, and yearly
bills imported recurring every two months for every user with one (issue #1150).
`BILL` holds one row per occurrence, so the spacing between a series' `dt`
values *is* its recurrence: `map/bill-cadence.ts` reads it and `map/map-bills.ts`
prefers that to `frq`, which now maps only the codes there is evidence for (0, 1,
2, 3, 5) and reports the rest. Before adding an unconfirmed constant, look for
the column that already carries the same fact as data.

### A bit mask cannot warn you, so measure it before you trust it

That null-and-warn rule protects lookups over a *value* -- an unknown `at` or `act` has no entry,
so it is visibly unknown. A **bit mask** has no such failure mode: a wrong mask silently matches
some other flag and the import completes clean. `MNY_TRANSACTION_FLAG.VOID` was 0x80 for four
phases; 0x80 is the bit every loan and mortgage row carries, so every loan payment imported VOID,
`computeExpectedBalances` skipped them, and each debt account sat at its opening balance under a
full register. Nothing warned, because nothing could.

So a `grftt` bit is only allowed here once it has been **measured on a real file**, by
cross-tabbing it against something the file already settles -- which account the row is in,
whether it appears in `TRN_SPLIT` or `TRN_XFER`, whether it carries `hsec`. Each mask in
`MNY_TRANSACTION_FLAG` records that measurement in its comment, and
`docs/ms-money-data-model.md` carries the full table. Do not copy a new mask out of the format
reference and ship it; the fixtures are far too small to contradict one.

## Reading tables

`readMnyTables(db)` (`tables/read-mny-tables.ts`) is the last layer that knows about Jet; mappers
take its `MnyTables` and never touch `mdb-reader`. Each reader is a declarative spec: a field
names the Money column (or columns, newest-first) it comes from plus a converter from
`model/mny-values.ts`. Field names are descriptive and `model/mny-rows.ts` documents the Money
column behind each one, so it doubles as the translation table for the format reference.

A missing table yields zero rows; a missing column yields the converter's default. Both are
reported in `TableAvailability` (`missingTables` / `missingFields`) so the wizard can say "this
file has no scheduled bills" instead of failing.

### A row in `CAT` is not necessarily a category

`CAT` holds the items of Money's two user-named classifications beside the
categories, told apart only by `hct` (`CT.hct`; 0 is the category tree). A
classification's top-level item is `nLevel` 0 with a null parent, exactly like
the INCOME and EXPENSE roots, so the level filter alone hides it -- but a nested
item is `nLevel` 1 under it and would import as a top-level category named after
it. `mapCategories` filters on `isClassificationItem` first, and
`map/map-classifications.ts` turns the items a row references into tags named
`<classification>:<item path>` (`Properties:20 Spring Apartment`), the
`key:value` shape `tag-key-value.util.ts` already groups by. `TRN.lHcls1` /
`lHcls2` name the item per row, so each side of a transfer and each split leg is
tagged on its own; a trade's cash leg takes the investment row's item, plus the item
on Money's own sleeve-side cash row it replaces (`adoptCashLegTags`), when this
writer creates the leg, and keeps the banking row's own when it adopts one.

## Inspecting a real file

```bash
npm run mny:inspect -- path/to/file.mny [--password secret] [--table TRN] [--rows 5]
```

Prints the encryption scheme, whether a password was needed, every table with its row and column
counts, and a summary of what the readers made of the file -- base currency, entity counts, and
any table or field this Money version could not supply. Run it against a real Money Plus Sunset
file before trusting anything downstream; a table that fails to read is reported inline rather
than aborting the report.

It also ends with a `performance:` block -- stage timings and peak RSS as a multiple of file
size. That, and the `.mny import timing:` line a real import logs, are where the design's
acceptance numbers come from: they can only be measured on a 200 MB file that will never be
committed here, so the pipeline measures itself and the run is what gets recorded.

## Memory

An upload is buffered whole and decrypted in place, and the reader works on its own copy of
those bytes (see the `mdb-reader` trap below), so peak usage is roughly **twice the file
size** above baseline. `MNY_IMPORT_LIMIT_MB` (default 300) bounds it; the pod needs at least
`2x` that plus headroom, which the default Helm limit of `150Mi` is nowhere near. A pod that hits
its limit mid-import is OOM-killed and the wizard reports a *stalled job*, naming the symptom and
not the cause -- see `helm/README.md` for the sizing table.

## Layering rules

- **Mappers never touch the database; the writer never parses.** Only the layers in `msisam/`
  need real `.mny` bytes -- everything above them is unit-tested against plain objects, which is
  what keeps the backend coverage gates reachable.
- **Never call `mdb-reader` directly.** `openMnyFile` is the only door. Money's table and column
  set changed across releases (Money 2001 has no `BILL` table at all), so reads go through
  `getTableOrNull` and `MnyTable.rows(columns)`, which drop absent tables and columns instead of
  throwing.
- **Every failure is an `MnyImportError` with a stable `code`** (`mny-errors.ts`). The controller
  maps the code to an i18n key; nothing below the controller formats user-facing text, and no
  message ever contains the file password. An untyped error escaping this layer is a defect
  twice over: the wizard gets a 500 with nothing to branch on, and a running job records the
  failure as *retryable*, offering Try again on a file that can never import.
- **Progress goes through `throttleProgress`, never straight from a chunk loop.** Each report
  escapes the import transaction by design, so it costs a second pool connection while the long
  transaction is open -- and the wizard only polls every 1500 ms, so a report per 500-row chunk
  writes a hundred-odd updates nobody reads.

### A trade is stored in the security's currency

`TRN.amt` is in the account's currency, but Monize reads an investment row's `price` and `total_amount`
as the security's currency and `exchange_rate` as security -> cash account. For a security quoted in
another currency than its account, `mapInvestments` converts at import with the file's own rate
(`resolveExchangeRates` rows through `resolveFxRate`, rate 1 only for equal codes). The cash leg stays
in the account's currency. Where the file has no rate near the trade date, `MnyMarketRateService`
looks one up -- Monize's stored history through `resolveStoredRate`, then one provider window per pair
through `fillRateWindow`, persisted -- and the file is parsed again with it; each trade converted that
way carries a `crossCurrencyTradeMarketRate` warning. The parser itself never touches the database: it
reports what it could not convert as `investments.rateGaps`. Both the preview and the job parse through
that service, and the job finds stored what the preview fetched. With no rate from either, the figures
stay in the account's currency at rate 1 and a `crossCurrencyTradeUnconverted` warning says so, naming
`provider_unanswered` when the provider did not answer rather than had nothing. Money 97-99 keep one
rate per pair, so on those files this is most cross-currency trades. `mny:inspect` reads the file
alone, so it still reports them unconverted. In the same way a synthesized sleeve
row takes the far row's own amount across currencies, and `transferAmountMismatch` compares each
synthesized row with Money's far row, which the expected-balance check (a sum of the mapped rows)
cannot do.

### A row Money does not store may still be one Monize has to write

Money's model and Monize's are not the same shape, and the gaps are silent. A transfer from a
bank account into an investment account is one Money row on each side, and the investment side is
*both* the arriving cash and the trade. Monize splits those: originally the trade's cash leg always
came out of the brokerage's cash sleeve, so something had to pay into it, and Money has no row for
that -- `buildCashCounterparts` synthesizes one.

The failure mode when it does not is that money leaves an account and arrives nowhere, and no
warning can fire because every row the file *has* was imported correctly. On the maintainer's file
3,255 transfers were affected and the sleeves silently absorbed $553,225.57.

(The premise that a trade's cash leg always comes out of the sleeve turned out to be wrong -- see
"Three shapes" below -- so most of those pairings now keep the row Money wrote instead. What is
left for `buildCashCounterparts` is the pairing whose far side carries a security but is not a
trade this import writes, or is one that moves no cash. The rule the section states still holds
for those.)

So when a mapper is about to warn that it cannot represent something, check first whether the
right answer is to *create* the row Monize needs rather than to report the mismatch. A warning
about 3,255 rows the user cannot act on is a sign the mapping is wrong, not that the file is.

### A row Monize writes itself has to say why it exists

Because Monize writes the trade's cash leg rather than importing Money's, the columns on that row
are Monize's to fill -- and `payee` was left empty. Money records no payee on a trade, so every
imported cash leg rendered as a bare `-` in the register: the one column that could say why the
money moved, on rows that exist only to say a trade settled (issue #1204).

The leg now carries the same activity label a natively entered and a QIF-imported trade already
store (`Buy: VOO 10 @ $100.00`), built by `backend/src/securities/investment-cash-payee.util.ts` --
the one implementation of that label, quoted in the currency the price and total are in (`securityCurrencyCode`). Money's payee still wins
when the file recorded one; the label is the fallback, never an override, so nothing the user
entered is replaced by generated text.

The general rule: when the importer synthesizes a row Money has no copy of, ask what each column
would have held had a person entered it. An empty column on a row nobody wrote reads as missing
data rather than as a row that never had any.

### And the same gap read the other way: a row Money *does* store may be one Monize writes anyway

The mirror of the rule above, and the way it goes wrong. When a trade is funded from the
brokerage's **own** cash companion, Money already has the cash-side row -- an ordinary `TRN` in
the companion account, paired to the trade through `TRN_XFER`. Monize writes that row itself, from
the investment transaction's `cashAmount`, so importing Money's copy as well is one payment
recorded twice.

It presented as three rows in the cash register where Money shows one (issue #1175): the purchase,
a transfer in and a transfer out. The two extras are Money's row plus the counterpart
`buildCashCounterparts` synthesized for it, which for this shape lands in that row's *own*
account -- so they cancelled, every balance reconciled, and nothing in the verification report
could see it. `classifyTradeCashSides` (`map/map-transactions.ts`) names those rows and they are not
imported; because membership in that set is exactly "its synthesized counterpart mirrored it into
its own account", dropping the pair cannot move a balance.

Two things generalize. **A counterpart that lands in the account it came from is not a
counterpart**, whatever the code that built it thinks. And **a pair of rows that cancel is
invisible to every check that reconciles a total** -- the row count is the assertion that catches
it, which is why `map/trade-cash-legs.spec.ts` asserts the count and the balance together.

### Three shapes, one question: where does this trade's cash already sit

The rule above was first written as "top-level rows in the trade's own sleeve", with everything
else falling through to the synthesized counterpart. That left two shapes wrong in the same way
the sleeve one had been, and for the same reason -- a `TRN_XFER` pairing whose far side is a trade
is never an ordinary transfer, wherever the near side lives:

| Money's near side | Monize's model | Issue |
|---|---|---|
| A row in the trade's own cash sleeve | Drop it; `writeInvestments` writes the leg from `cashAmount` | #1175 |
| A top-level row in another account | That row **is** the cash leg; the trade names it as its `funding_account_id` | #1212 |
| A leg of a split transaction | The trade is embedded in the leg (`transaction_split_id`), and no cash row exists at all | #1211 |

`classifyTradeCashSides` (`map/map-transactions.ts`) answers all three at once, and
`map/investment-cash.ts` feeds the answer back to the trades. Two consequences worth stating:

- **`mapInvestments` now runs before `mapTransactions`.** A banking row can only be read as a
  trade's cash side if that trade is going to exist, so the transaction mapper is handed
  `tradesByHandle`. A security-carrying row the investment mapper skipped -- an unknown `act`, a
  currency pseudo-security -- is not a trade, and its Money row stays exactly as written.
- **`investmentWritesOwnCashRow` is one predicate, not three copies of `cashAmount !== 0`.** The
  writer, `computeExpectedBalances` and the per-account row count all have to agree about which
  trades produce a sleeve row; when they disagree a balance is short or long by the trade and the
  verification report flags every brokerage cash account.

The general shape of both defects is worth keeping: **the same movement of money recorded twice
sums correctly**. #1212 put a transfer into the sleeve and took it straight back out; #1211 did the
same inside a split. Every balance reconciled in both, which is why the row count is the assertion
that catches them -- `map/trade-cash-legs.spec.ts` asserts the register's contents and the balance
together, per account.

## Traps

- **Page 0 is obfuscated.** Jet XORs bytes `0x18..0x95` of the header page with a fixed mask. The
  crypto salt at `0x72` is inside that window. Reading it from the raw file produces a key that
  decrypts everything to garbage with no error until the reader reports a wrong page type. Use
  `demaskHeaderPage`/`readMnyFileHeader` (`msisam/jet-header.ts`); never index raw page-0 bytes.
- **Non-blank crypt-check bytes do not mean the file has a password.** Money Plus writes them for
  unprotected files too, and they verify against the blank password. "Protected" means the blank
  password fails.
- **`decryptMsisamInPlace` takes ownership of its buffer.** It mutates and returns the same
  buffer, deliberately (ADR-6). Tests must read a fresh fixture per assertion --
  `readMnyFixture` does that.
- **`mdb-reader` writes into the bytes it reads, and the corruption is silent and specific.**
  A second read of the same buffer returns every currency value with its sign stripped
  (`-20.0000` reads back as `20.0000`) while row counts, dates and text stay correct, so
  nothing looks wrong until a ledger of pure credits arrives. The wizard reads a buffer twice
  by design -- `POST /parse` reads the upload and stages *those same bytes*, and the job reads
  them again -- so this made every imported transaction a credit, both sides of every transfer
  positive, and account opening balances absolute (they share `toAmount`). `openDatabase` hands
  the reader its own copy, which is what makes `openMnyFile` a door you may walk through twice.
  Do not "optimise" that copy away.
- **Decrypt each buffer exactly once; RC4 is symmetric.** A second pass re-encrypts pages
  1..0xE, and the only symptom is `MnyUnreadableDatabaseError` from a layer that looks
  unrelated. Staged bytes are stored *decrypted* so the password is spent on the parse request
  and never persisted (ADR-2, ADR-7), so anything re-reading them uses `openDecryptedMnyFile`
  (or `parse({ alreadyDecrypted: true })`), never `openMnyFile`. This shipped broken through
  three phases because **every test staged raw fixture bytes** -- making the job's decrypt the
  only decrypt -- while the wizard's real upload-then-import path decrypted twice. A test that
  stages anything other than what `POST /parse` stages is not testing the import.
- **Money 2001 files use a different key derivation** ("old" scheme, flags bit `0x6` clear) that
  uses no password at all. Both schemes must keep working; the fixtures cover each.
- **Money 97-99 is a different code space, not an older vintage of the same one.**
  The file is plain Jet 3 (`format: "jet3"`, nothing to decrypt), and its `grftt`
  bits and `act` codes collide with Money Plus's: its void bit is Money Plus's
  loan-account bit, its loan-template bit is Money Plus's VOID, its `act` 1 is a
  sale. Read through the Money Plus tables, voided rows import live, pending
  scheduled instances import as posted, and sales import as purchases -- and every
  balance still reconciles against the mapper's own output. `readTransactionData`
  rebuilds the flags in the Money Plus layout (`tables/money99-transactions.ts`) and
  the mappers look actions up by format (`model/mny-actions.ts`,
  `model/mny-money99.ts`); `sample-money99.mny` asserts Money 99's own balances.
  It has no `BILL` table either: `tables/money99-bills.ts` turns each `TRN`
  template that names a pending instance (`htrnSrc`) into the `BILL` row
  `mapBills` expects, which is also what keeps a scheduled transfer to one bill.
  Recording a split in Money 99 rewrites the trades before it (quantities and
  prices), so its `SEC_SPLIT` rows are not even reported; and a CD is bought by
  amount, with no units, so it imports as units of 1 the way Money Plus stores it.
- **`TRN` holds the payee in `lHpay` on Money Plus and `hpay` before it.** Reading one name only
  drops every payee on the other vintage. Column aliases belong in the reader spec, never in a
  mapper.
- **`SEC_SPLIT` has no security column.** Resolve it through `MnyInvestmentData.splitSecurities`,
  which is built from `SP.hss` -> `SP.hsec`.
- **A trade the investment mapper skips still has its cash.** Its cash row in
  the trade's own sleeve imports on its own (`unwrittenTradeCashRows`); a
  synthesized counterpart for it would land in the same sleeve and net it to
  zero, which no balance check can see because both rows are the mapper's.
- **Never apply a `SEC_SPLIT` ratio to a position.** Money does not adjust its own share counts
  for those rows, so an importer that does disagrees with the file it read: seven positions
  across two files (the maintainer's VTI, VWO, XIC and XIU, `sample.mny`'s MSFT, LEH and ADM)
  match `LOT` exactly when the split is ignored and are wrong by the ratio when it is applied.
  The rows are quote-feed metadata -- the split's `SP` row is a `dPrice = 0`, `src = 0` marker
  with continuous prices either side -- and they appear for securities the user never held and
  for the annual 1:1 entries Canadian ETFs record against a reinvested distribution. Ratios
  other than 1 are surfaced as `securitySplitNotApplied`, never acted on.
- **"No date" is year 10000, not a two-digit-year pivot.** `toDate` returns null outside
  1900–2199; never parse Money dates by hand.
- **`grftt & 0x60000` marks a scheduled instance Money never posted.** Neither the register nor
  the balance shows it. Importing them put four of the maintainer's accounts out by exactly their
  total -- $7,671.79 on a chequing account whose Money balance is $0.00, -$156.55 on a credit
  card, $91.00 on a plan sleeve and $350.00 on a mortgage -- and accounted for two of the three
  holdings mismatches. All 67 are unreconciled in a file that is 74% reconciled, all fall in one
  eleven-month window, and every one also carries `0x200000`. `ACCT.amtEndRec` could not settle
  it on its own (a *reconciled* balance excludes unreconciled rows either way); the maintainer
  confirmed against Money that the rows are absent from the register. Dropped silently, like the
  loan-payment family: Money does not show them, so there is nothing to fix.
- **`act` 12 credits units that no cash pays for.** It opens lots with a value and a quantity,
  like a buy, but never has a `TRN_XFER` cash counterpart -- 0 times in 92, where `act` 1 has one
  2,015 times in 2,029 and `act` 3 1,090 times in 1,090. Mapping it to BUY charged the sleeve and
  left an employer-matched RRSP $18,457.22 overdrawn against Money's own $91.00. REINVEST is the
  action that has a value and a position but no cash leg.
- **`act` 16 removes shares; it is not a sale.** Mapping it to SELL closes lots against a
  fabricated price and corrupts average cost. Direction always comes from `act` -- `TRN_INV.qty`
  is stored positive, so a quantity sign proves nothing.
- **Read `act` off `LOT`, never off a format reference.** `LOT.htrnBuy` and `LOT.htrnSell` name
  the transactions that opened and closed each tax lot, so whatever `act` those rows carry
  acquires and disposes *by definition*. PR #192's reference had `act` 1 as SELL; in both Money
  Plus files available (the maintainer's, 4,616 lots, and the `sample.mny` shipped with Money
  Plus) `act` 1 opens lots and closes none. Every purchase imported as a sale, so no cash ever
  left a brokerage sleeve and holdings replayed negative. Money Plus uses
  1/2/3/4/9/12/13/32/33; codes 0, 5, 14, 15 and 16 appear only in the older fixtures.
- **Investment `TRN.amt` is signed the opposite way to a banking row.** A buy is positive and a
  sale negative -- it is what you paid, not the effect on the sleeve. Take the magnitude from
  `amt` and the direction from `act`, which is what `totalAmountOf`/`cashAmountOf` do.
- **Money qualifies a symbol with its market**: `US:VTI`, and `$US:INDU` for an index, where
  `$` is Money's index marker rather than part of the prefix. `stripMarketPrefix` removes only
  the market segment. Left on, `writeSecurities` matches existing holdings by symbol, so
  `US:VTI` creates a second security beside the user's own `VTI` and every quote lookup 404s.
- **`act` 3 and `act` 4 (cash distributions) have no `TRN_INV` row.** Drive the investment mapper from `TRN`;
  iterating `TRN_INV` drops every dividend.
- **No `SEC.sct` code means anything portable, so none is read.** The codes shift between
  releases (the same index securities are `sct` 6 in Money 2001/2002 and `sct` 7 in Money Plus),
  and `sct = 4` -- long assumed to mark a currency pseudo-security -- is Money's **money-market
  fund**, which in a brokerage account is the sweep the cash moves through. Excluding it cost
  829 investment transactions and left five cash sleeves thousands of dollars out. A currency is
  recognised by the `/GBPUS` symbol shape alone (`isCurrencyPseudoSecurity`), and currencies
  live in `CRNC`, not `SEC`.
- **`CAT.lType` says income or expense directly** -- `{2, 3}` income, `{0, 1}` expense, `-1` the
  two roots. Use `isIncomeCategoryType` and fall back to the root ancestor only for the roots.
- **A `.mny` is a snapshot, so bill activity is measured from the file, not the clock.**
  `billActivityAnchor` anchors the horizon to the newest `BILL` instance the file holds,
  falling back to `asOf` for a file still in use. Judging against `todayIsoDate()` meant the
  same file imported differently depending on the day it was run, and a file a quarter old
  lost *every* bill -- 292 series reduced to one candidate.
- **A series is judged against its own cadence.** The window is
  `max(BILL_FUTURE_HORIZON_DAYS, one cycle + BILL_PAST_HORIZON_DAYS)`. A flat quarter declared
  a yearly bill dead 100 days after its last occurrence, on a current file. Detection erring
  generous is recoverable -- the wizard's checkbox list unticks it -- while erring strict drops
  the series with no UI that ever mentions it.
- **Money's newest instance is where the series stood when the file was last used**, which is
  in the past for any real import. `rollForward` advances it through its own cadence to the
  next occurrence at or after `asOf`, so a bill arrives due next month rather than a year
  overdue. Rolling is step-bounded; a stale daily series would otherwise iterate for ever.
- **`BILL` is an accumulation of instances, not a list of bills.** One row per occurrence, so a
  long history holds thousands (1,844 in the maintainer's file for ~20 real bills). Group by
  `hbillHead` and reduce each series to one representative before doing anything else.
- **Nothing filters on `BILL.st`.** No fixture has ever contained a `BILL` row, so no value of it
  has been observed. `mapBills` carries the raw value on every candidate and `mny:inspect` prints
  its distribution; adding an `st` filter needs a real file first, not a plausible constant.
- **An absent `options.bills` means "every candidate"; an empty list means "none".** They are
  different requests, and the wizard always sends the field explicitly so unticking every bill
  does not read as saying nothing.
- **An unticked bill is never written, not written inactive.** PR #192 created all 1,844 and
  bulk-deactivated the rest, which left the user a list to clean by hand.
- **A loan's interest category is only inferred when the payments name exactly one non-principal
  category.** Interest and escrow are both category legs and the file does not distinguish them,
  so two or more legs means the field stays null with a warning. Putting escrow into
  `interest_category_id` would make `RateChangeInferenceService` infer every rate from the wrong
  leg.
