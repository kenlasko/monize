# Native KMyMoney (.kmy) Import: design record

> Status: approved design, not yet built. Written 2026-11-18. The plan and the task list that build it
> are `docs/future-plans/kmymoney-import.md` and `docs/future-plans/kmymoney-import-tasks.md`. The format
> reference every rule below cites is `docs/kmymoney-data-model.md` ("the reference", sections written
> as R5.6 and so on). The existing Money importer this reuses is `docs/specs/mny-import.md` and
> `backend/src/import/mny/README.md`.
>
> Paths of files that do not exist yet are written without backticks, or inside fenced blocks, so the
> doc-path guard (`backend/src/common/doc-paths.spec.ts`) keeps checking every path that does exist.

## 1. Summary

KMyMoney (KDE's personal finance manager) saves a whole profile as one XML document, gzip-compressed by
default (`*.kmy`), or plain (`*.xml`). The file holds accounts, an income/expense category tree, payees,
tags, every transaction as a set of splits, securities, price and exchange-rate history, and schedules.
Amounts are exact rationals (`-241/2`).

This design adds a KMyMoney import to the Import wizard with the same flow as the Microsoft Money
import: upload, review, background import, verification report. It reuses everything behind the Money
parser unchanged in behaviour: staging, the job table and its fencing, the writers, post-processing,
the verification report and the review/progress/report components. KMyMoney gets its own reader and its
own mappers, which produce the same intermediate model (`MappedAccount`, `MappedTransaction`,
`MappedInvestmentTransaction`, ... in `backend/src/import/mny/model/mny-import-model.ts`) the Money
mappers produce.

```
.kmy/.xml upload -> container sniff (gzip | xml | refuse GPG/SQLite/anon/legacy) -> bounded gunzip
  -> KMyMoney's pre-parse byte filter -> streaming XML tokenizer (htmlparser2, xmlMode)
  -> typed raw model (exact BigInt rationals, numbered handles) -> KMyMoney mappers
  -> the shared Mapped* model (MnyParsedFile) -> shared staging/job/writers/post-processing
  -> verification against figures computed straight from the raw file
```

The one thing the Money verification cannot do, this one does: the "expected" balance of every account
and the share count of every holding are computed from the raw file the way KMyMoney computes them
(R15.2), independently of the mapped rows, so a mapper defect shows up as a difference.

## 2. Goals and non-goals

### Goals

Import a KMyMoney file end to end, preserving:

- complete banking and investment transaction history, every split, every transfer pair exactly linked;
- split transactions, including transactions that mix transfers and categories;
- the category tree at its full depth (Monize categories nest to any depth);
- investment purchases, sales, dividends, interest, reinvestments, added and removed shares and stock
  splits, with the executed total as the fact and the price derived from it (INV-TRADE-001);
- securities moved between brokerage accounts as linked TRANSFER_OUT / TRANSFER_IN pairs, carrying their
  cost basis;
- original acquisition costs (commission included) and the security price history;
- historical exchange rates, and each cross-currency transfer's own rate;
- closed accounts (closed after their history is written) and every split's reconciliation state and
  date;
- a post-import verification of every account balance and every holding against figures computed
  independently from the file.

Also: active schedules as scheduled transactions the user ticks in the review step; tags; payees, with
their KMyMoney matching rules as payee aliases wherever the rule translates exactly, their default
categories and their contact details (section 5.5); institutions as the account's institution name; loan payment structure (principal transfer plus interest
category) and the loan's inferred terms through the existing `backend/src/import/mny/map/map-loans.ts`.

### Non-goals (v1, said in the review step's notes, the user guide and the verification report)

- GPG-encrypted files, KMyMoney SQL/SQLite/SQLCipher databases, anonymized `.anon.xml` files and the
  KMyMoney 0.8 binary format: each is refused with its own actionable message (section 4.3).
- Budgets, saved reports, online jobs, online-banking settings, payee reference numbers, payee bank
  identifiers (IBAN/BIC, national account numbers) and link patterns, the KMyMoney matching keys that
  fall outside the translatable subset of section 5.5.1 (each is named in a warning), account numbers
  and IBANs, cost centers, VAT settings, the asset-account hierarchy (Monize accounts are flat),
  schedule weekend rules and auto-enter.
- Merging into a populated profile with transaction-level dedupe (same as Money: entity-level
  find-or-create by name, file-level duplicate refusal by content hash, optional start-fresh wipe).
- A password dialog. KMyMoney's only encryption is GPG over the whole file, which Monize does not
  decrypt.
- Writing KMyMoney files.

## 3. Format facts the design relies on

All from the reference; the ones that drive a decision are restated so this document stands alone.

| Fact | Reference | Consequence here |
|---|---|---|
| A file is detected by content: `1F 8B` gzip, `--` or `85 01/02` PGP, else plain XML; after inflation a first byte below `0x20` or the text `KMyMoney` is the 0.8 binary format | R1 | Container sniffing (4.3); the extension is never trusted |
| The reader filters bytes before parsing: control characters other than TAB/LF/CR are dropped, and so are orphaned UTF-8 lead and continuation bytes | R2.1 | Ported byte for byte (4.4) |
| Amounts are canonical GMP rationals `num/den`, any denominator, may exceed 2^53; auto-calc sentinel `-9223372036854775807/100` | R3.1 | BigInt rationals (4.5) |
| `shares` is in the split account's commodity and is what balances sum; `value` is in the transaction commodity | R6.3, R15.2 | Row amounts come from `shares`; leg conversion from `value` |
| Every account id is an opaque string; split ids repeat per transaction and are renumbered on load | R3.4 | Numbered handles (4.6) |
| Categories are accounts of type 12/13, nested by `parentaccount` to any depth | R5.3 | Full tree (5.4) |
| Opening balances are ordinary transactions against an equity account | R5.6 | Folded into `opening_balance` (5.3) |
| A stock account (type 15) per security under an investment account (type 7); the brokerage cash account is a sibling linked only by the name `<name> (<localized "Brokerage">)` | R7.1 | Pair detection (5.2.2) |
| An investment activity is classified from the stock split's action and the sign of its shares; other splits are fees (expense), income (income) or the asset split | R7.3 | Activity table (5.7) |
| A stock split is a single-split transaction whose `shares` is the multiplier, applied to the running balance and rounded to the security's `saf` | R7.4, R15.2; KMyMoney's user manual: "in a 3:2 split, enter 1.5" | SPLIT with quantity = shares (5.7.5) |
| A price `from -> to` means 1 `from` is worth `price` units of `to` | R9 | Rate orientation (5.9) |
| Schedules carry an occurrence code and multiplier; the template transaction's post date is the next due date | R11 | Cadence table (5.10) |
| A payee's matching rule is its own name (contained or exact) or a list of PCRE2 regular expressions searched anywhere in an imported payee text, case-insensitive per payee; the longest match among all payees wins | R10.1 | Translated to Monize payee aliases where exactly equivalent, otherwise named in a warning and skipped (5.5.1) |

## 4. Architecture decisions

**K1. Reuse the pipeline after the parser; replace the parser.** The writers
(`backend/src/import/mny/writers/`), `MnyImportService`, `MnyImportJobService`, `MnyStagingService`,
the preview builder and the job/result/warning types are written against the intermediate model, not
against Money's tables. KMyMoney gets a reader (container, filter, tokenizer, raw model) and mappers
(raw model to `MnyParsedFile`), in a new directory `backend/src/import/kmy/`. Nothing is renamed: the
`mny` identifiers, tables, routes and i18n namespaces stay as they are, and a rename is a separate
proposal. Where shared code is hard-wired to Money, section 4.9 lists the smallest change that keeps the
Money path's behaviour identical.

**K2. Transport and staging.** `POST /api/v1/import/kmy/parse`, multipart `file`, the same multer
memory storage and the same ceiling (`MNY_IMPORT_LIMIT_MB`, default 300). The **uploaded bytes** are
staged as they arrived (gzip or plain), in `import_staged_files` with `source_format = 'kmy'`. The job
re-reads and re-parses them (deterministic, ADR-2 of the Money spec). The `content_sha256` duplicate
refusal is over those bytes: re-saving an unchanged file in KMyMoney writes new gzip bytes and is not
recognised as a duplicate, exactly as a re-saved `.mny` is not.

**K3. No new environment variable, no migration.** The inflated XML has its own, much smaller bound,
a constant (`KMY_MAX_XML_BYTES`, 100 MiB, in `backend/src/import/kmy/reader/kmy-limits.ts`, 4.2), not
the shared `MNY_IMPORT_LIMIT_MB`: a repetitive document compresses about 300 to 1, so the upload limit
says nothing about what the document costs. No new variable reaches `.env.example` or Helm. `import_jobs.source_format` and `import_staged_files.source_format` are
`VARCHAR(20)` with no CHECK constraint (migration `117_mny_import_staging_and_jobs.sql` is the only
migration naming the column), and `security_prices.source` / `exchange_rates.source` are free
`VARCHAR(50)`. Nothing new is stored, so no table, column, RLS policy or backup classification changes.
The payee matching rules, default categories and contact details of section 5.5 land in a table and
columns that already exist (`payee_aliases`, and `payees.default_category_id`, `notes`, `email`,
`phone`, `address`), under the unique index `idx_payee_aliases_user_alias` that already exists, so they
need no migration either; the start-fresh wipe already deletes `payee_aliases`
(`UsersService.deleteData`).

**K4. XML parsing: `htmlparser2` in XML mode, already a direct dependency.** Evidence and the
alternatives are in section 14.1. In short: `htmlparser2` 12.0.0 is in `backend/package.json`
`dependencies`, MIT, ESM-only but already loaded under Jest (it is in `transformIgnorePatterns`) and
already imported by `backend/src/securities/html-table-reader.ts` and
`backend/src/email-receipts/imap/html-lines.util.ts`. Its `Parser` with `{ xmlMode: true }` is a
streaming SAX-style tokenizer (`write(chunk)` / `end()`), decodes only the five predefined entities and
numeric character references, and never processes a DTD: an internal subset's `<!ENTITY>` declarations
are reported as declarations and never expanded, so entity-expansion attacks have nothing to run on.
Measured on this machine: a 59 MB synthetic KMyMoney document (120,000 two-split transactions) tokenized
in 1.6 s in 64 KB chunks. It is lenient about well-formedness, so the reader enforces nesting itself
(4.4). **No package is added, so `package.json` and `package-lock.json` do not change.**

**K5. Exact arithmetic.** A rational is two `bigint`s, canonical (positive denominator, lowest terms).
Every sum the reader or the verification does is exact. A rational becomes a JavaScript `number` exactly
once, at the edge of the intermediate model, through a decimal string rounded at the precision the
target column needs (4.5): `Number("1234.5678")` is the nearest double to that decimal, the same as every
other importer's amounts. Never `Number(num) / Number(den)`.

**K6. Numbered handles.** The intermediate model, the options DTO and the frontend key every entity on
a number (`handle`). KMyMoney ids are strings. Each entity gets a surrogate handle: its 1-based ordinal
among the elements of its section, in document order, counted **before** any filtering (the five
standard accounts are ordinals 1-5 of `ACCOUNTS` in a KMyMoney-written file, and keep a number though
they never import). Safety argument: the preview's parse and the job's parse read the same staged bytes
with the same code, so the same element gets the same number; the options reference only handles the
preview returned; nothing persists a handle beyond the job (the `import_jobs.options` jsonb holds them
only for that job). Widening the model to `string | number` was rejected (section 14.3).

**K7. Same review/progress/report components, parameterised by format.** The `Mny*` components and
`useMnyImport` take an optional format descriptor defaulting to Money, so every Money test keeps passing
unchanged. KMyMoney-specific copy lives in new `kmy*` i18n namespaces; format-neutral Money keys are
reused (section 7).

**K8. Independent verification.** Section 6. The mapped model's own sums still drive the balance write
(`writeAccountBalances`), as they must mirror `ImportPostProcessingService`; the file-computed figures
drive the report.

**K9. Errors are typed.** Every reader failure is a `KmyImportError`, a subclass of the existing
`MnyImportError` (made generic over its code type), so `MnyImportJobService.runClaimed` treats it as a
non-retryable parse failure with no change, and the controller maps its code to a localized 400. A
failure of the mapper on a file the reader accepted is Monize's own defect: `parseKmyBytes` wraps it in
`KmyMappingFailedError` (`kmyMappingFailed`), which the controller answers with a localized 500 and the
job records as its error key, not retryable (the same bytes fail the same way).

**K10. The parser stays DB-free; it yields to the event loop; one async wrapper loads what it needs.**
The pure functions are `readKmyFile` (bytes to raw model) and `mapKmyFile` (raw model to
`MnyParsedFile`). The reader streams the document (inflate, byte filter, decode, tokenize, chunk by
chunk) and hands the event loop back every `KMY_YIELD_EVERY_BYTES`; the mapper is written as steps
(`kmy-steps.ts`) that `mapKmyFile` runs straight through and `mapKmyFileYielding`, which the parser
service uses in the preview request and the job alike, runs handing the event loop back every 20 ms. The
injectable `KmyParserService` reads two things from the database before calling them, the user's
default currency and the CRYPTO currency codes with their decimal places, so the preview and the job
parse with identical inputs. It uses `withScopedDb` only (no new `WITH_CONTEXT_ALLOWLIST` entry).

**K11. Parser selection without a module cycle.** `MnyImportService` does not import the KMyMoney
directory. A shared interface `ImportSourceParser` and an injection token `KMY_SOURCE_PARSER` live in a
new shared model file under `backend/src/import/mny/model/`; `KmyParserService` implements it and
`ImportModule` provides it under that token; `MnyImportService` takes it as an `@Optional()` constructor
parameter.

**K12. Stock-split ratios are applied.** Unlike Money (whose `SEC_SPLIT` rows are quote-feed metadata),
a KMyMoney stock split is the share movement itself (R7.4): KMyMoney's own balance multiplies by it.
Each becomes a SPLIT row with the multiplier as its quantity.

**K13. Payee matching becomes payee aliases, written after the rule pass.** A KMyMoney matching rule and
a Monize payee alias say the same thing ("an imported payee text like this belongs to this payee"), so
each rule becomes aliases where the translation is exactly equivalent (section 5.5.1) and is otherwise
named in a warning and skipped; nothing that would match differently is imported silently. The aliases,
the default categories and the contact details are written by one shared writer inside the import's
single `withScopedDb` transaction, **after** `applyImportRules`, so nothing in the same import reads
them: the import's own rows keep the payee KMyMoney assigned, and the new aliases act only on later
imports and bank syncs, exactly as a hand-made alias does. Transaction rules were the other candidate
receiver and were rejected (section 14.6).

### 4.1 Layering

```
backend/src/import/kmy/
  reader/        container sniffing, bounded gunzip, byte filter, tokenizer, raw model builders
  map/           pure functions raw model -> Mapped* model, file-computed expectations, warnings
  model/         kmy-raw (types), kmy-rational, kmy-errors
  kmy-parse      readKmyFile + mapKmyFile composition used by the service
  kmy-parser.service, kmy-import.controller, kmy-upload-error (exception factory)
  __fixtures__/  XML builders, raw-model builders, two committed synthetic files, README
```

Rules carried from the Money README: mappers never touch the database; the writer never parses; every
failure is a typed error with a stable code (an untyped error escaping the parser is a defect: a 500 and
a retryable job over a file that can never import); synthesized rows get payees or descriptions; the
same movement recorded twice must sum correctly, so specs assert row counts as well as balances.

### 4.2 Limits

| Limit | Value | Enforced by |
|---|---|---|
| Upload size | `MNY_IMPORT_LIMIT_MB` MB (default 300) | multer `limits.fileSize`, re-asserted on the buffer |
| Document (inflated, or a plain XML upload) | `KMY_MAX_XML_BYTES`, 100 MiB (1.7 times the 59 MB of the largest real file measured, 120,000 transactions) | the gzip is inflated as a stream and counted chunk by chunk; the first chunk past the bound is `kmyXmlTooLarge`, nothing past it is inflated. A plain upload over it is refused before reading |
| Records kept | `KMY_MAX_RECORDS`, 600,000 (about 1.5 times the 120,000-transaction file, and the same 200,000 transactions as the byte bound) | counted as each kept element opens; past it is `kmyTooManyRecords` |
| Elements of any kind | `KMY_MAX_ELEMENTS`, 2,000,000 | counted as each element opens; `kmyTooManyRecords` |
| Splits in one transaction or template | `KMY_MAX_SPLITS_PER_TRANSACTION`, 10,000 | `kmyTooManyRecords` |
| One attribute value | `KMY_MAX_ATTRIBUTE_CHARS`, 1 Mi characters | counted as the value's characters arrive; `kmyTooManyRecords` |
| Event loop | handed back every 256 KiB of document and every 20 ms of mapping | `readKmyFile`, `mapKmyFileYielding` |
| Entity expansion | none possible | the tokenizer never processes a DTD |
| Nesting depth | 64 elements | the reader's element stack; deeper is `kmyCorruptFile` (a KMyMoney file is at most 8 deep) |
| Preview payload | summaries only | the shared `buildPreview` and `summarizeWarnings` (50 rows per code) |

### 4.3 Container detection and refusals

Applied in this order to the uploaded bytes, then to the inflated bytes where noted.

| # | Test | Result |
|---|---|---|
| 1 | fewer than 2 bytes | `kmyNotAKmyMoneyFile` |
| 2 | starts with the 16 bytes `SQLite format 3\0` | `kmySqliteDatabase` |
| 3 | starts `1F 8B` | gzip: inflate with the bound; a zlib error is `kmyCorruptFile`; continue at 6 with the inflated bytes |
| 4 | starts `-----BEGIN PGP` , or `85 01`, `85 02`, or the first byte has bit 7 set and is not `EF` (a UTF-8 BOM) | `kmyEncryptedFile` |
| 5 | otherwise | plain XML; continue at 6 |
| 6 | strip a UTF-8 BOM; first byte below `0x20` (not TAB/LF/CR), or the first 8 bytes are `KMyMoney` | `kmyLegacyBinaryFile` |
| 7 | the first 4,096 bytes contain no `<KMYMONEY-FILE` | `kmyNotAKmyMoneyFile` (a `KMYMONEY-TEMPLATE` category template, a random XML file, an SQLCipher database whose random first byte fell through test 4) |
| 8 | the filename ends `.anon.xml` (case-insensitive), or after reading, every non-standard account's `name` equals its `id` and every payee's `name` equals its `id` (at least one account) | `kmyAnonymizedFile` |
| 9 | the root element is not `KMYMONEY-FILE`, an element is not closed, a close tag does not match, nesting exceeds 64, an attribute is repeated, a character reference names a character XML 1.0 forbids (`&#1;`), a split references an account id not read before it (an empty id included; checked as the split arrives, as KMyMoney's `readSplit` does against `m_validAccountIds`), a split references a standard account, or a split's `shares` and `value` have opposite non-zero signs | `kmyCorruptFile` (the account and sign checks are what makes KMyMoney itself refuse the file, R2.2 and R6.2; QXmlStreamReader refuses the repeated attribute and the forbidden character) |

### 4.4 Byte filter and tokenizer

The filter is KMyMoney's `validateUtf8AndXML` (R2.1), run as a stream filter (`KmyByteFilter`) that
gives exactly the result of one pass over the whole document: a lead byte is held back until the next
byte decides whether it is dropped, replaced or emitted, so its three states never lose a byte at a
chunk boundary (KMyMoney's own copy runs per read and cannot remove a lead byte that ended the previous
chunk; Monize's result can only be cleaner). Truth table, state
`F` = FirstChar, `L` = LeadInCharSeen, `S` = SequenceCharSeen, initial `F`:

| Byte class | State in | Output | State out |
|---|---|---|---|
| ASCII `>= 0x20`, or TAB/LF/CR | `L` | drop the previous (lead) output byte, then emit | `F` |
| ASCII `>= 0x20`, or TAB/LF/CR | `F`, `S` | emit | `F` |
| other ASCII control (`0x00-0x1F`) | `L` | drop the previous output byte, emit nothing | `F` |
| other ASCII control | `F`, `S` | nothing | `F` |
| lead `11xxxxxx` | `F`, `S` | emit | `L` |
| lead `11xxxxxx` | `L` | replace the previous output byte with this one | `L` |
| continuation `10xxxxxx` | `L`, `S` | emit | `S` |
| continuation `10xxxxxx` | `F` | nothing | `F` |

The filtered bytes are decoded with `TextDecoder("utf-8", { fatal: false })` in 64 KB slices
(`stream: true`) and written to an `htmlparser2` `Parser` with `{ xmlMode: true, decodeEntities: true,
recognizeSelfClosing: true }`. Well-formedness the tokenizer does not enforce, the reader does: it keeps
its own element stack, records `parser.endIndex` at each open tag, and treats a close event whose
`isImplied` flag is true and whose `endIndex` differs from the open tag's as an unclosed element (a
self-closing tag closes at its own open tag's end index; measured). Duplicate attributes keep the first
value (the tokenizer's behaviour; KMyMoney never writes one). Unknown named entities stay literal.

Elements are dispatched by **path**, never by name alone, because `ACCOUNT`, `PAYEE` and `TAG` recur
inside `REPORT` and `BUDGET` with other meanings (R4.12, R12): `KMYMONEY-FILE/ACCOUNTS/ACCOUNT`,
`KMYMONEY-FILE/TRANSACTIONS/TRANSACTION/SPLITS/SPLIT`, `.../SPLIT/TAG`, `.../SPLIT/KEYVALUEPAIRS/PAIR`,
`KMYMONEY-FILE/SCHEDULES/SCHEDULED_TX/TRANSACTION/SPLITS/SPLIT`, and so on (the reader spec lists every
path). `ONLINEBANKING` is skipped without storing a single attribute; the reader keeps only a count. A
split's `kmm-matched-tx` value is an attribute string and is never parsed (R6.8); the reader keeps only
a count.

### 4.5 Numbers

| Input | Rule |
|---|---|
| `""` | 0 |
| `^((\d+)\s+|-)?(\d+)/(\d+)` (not end-anchored, as KMyMoney's) | rational; leading `-` negates; a leading integer and whitespace adds a whole part (`5 8/16`); a zero denominator is `kmyCorruptFile` |
| `^-?\d+(\.\d+)?$` | decimal, `.` only (KMyMoney's locale-dependent fallback is not reproduced) |
| anything else | 0, with the reader warning `unparsableNumber` naming the element and attribute |
| `-9223372036854775807/100` or `9223372036854775807/100` | the auto-calc sentinel; legal only on a schedule template split; on a posted split it is 0 with `autoCalcInPostedSplit` |

Conversion to the intermediate model's `number` fields, always from the exact rational:

| Field | Places | Rounding |
|---|---|---|
| amounts (`amount`, `openingBalance`, split `amount`, `totalAmount`, `commission`, `cashAmount`, bill `amount`) | `moneyDecimalsFor` of the currency's places: 4 for every fiat, the coin's places (up to 8) for a CRYPTO code | half away from zero (AlkValue `RoundHalfUp`) |
| `quantity` (shares, and the SPLIT ratio) | 8 (`NUMERIC(20,8)`) | half away from zero |
| `price` | 10 (`INVESTMENT_PRICE_DECIMALS`) | through `derivePriceFromTotal`, or half away from zero where that returns null |
| `exchangeRate`, price-history and rate-history values | 10, then `roundFxRate` | half away from zero |

The file-computed verification figures (section 6) are summed exactly and rounded once.

### 4.6 Handles and keys

| Entity | Handle | Model key |
|---|---|---|
| account (any type, standard roots included) | ordinal in `ACCOUNTS` | `acct-<handle>`; an investment pair with no brokerage account adds `acct-<handle>-cash` |
| category (income, expense and equity accounts) | the account's handle | n/a |
| payee | ordinal in `PAYEES` | n/a |
| tag | ordinal in `TAGS` | n/a |
| security | ordinal in `SECURITIES` | n/a |
| currency (for the rate writer's handle map only) | 1-based position in the sorted list of codes the written rates use | n/a |
| transaction | ordinal in `TRANSACTIONS` | every row it produces carries it as `handle` (rows of one transfer share it) |
| price row | ordinal of the `PRICE` element across the whole `PRICES` section | n/a (later rows win the `(security, date)` dedupe) |
| schedule | ordinal in `SCHEDULES` | the bill `handle`, the wizard's selection key |

A payee id that no `PAYEE` defines (Skrooge exports, R2.3) maps to no payee with `unknownPayeeReference`.

### 4.6.1 Account selection and the investment pair

`options.accounts[].handle` is an account handle. An investment pair is included, excluded and
re-currencied by the **investment account's** handle; the preview's cash row shows the brokerage
account's handle (or null for a synthesized cash side) exactly as the Money preview shows its companion,
and a choice sent for that handle is ignored, as in Money.

### 4.7 Where amounts come from

A row's amount is the `shares` of the split that the row represents, in that split's account currency.
A split leg's amount is the other split's `value` converted into the parent row's currency at the parent
split's own ratio, `-other.value * (parent.shares / parent.value)` (exactly `-other.value` when the
parent's account currency is the transaction commodity), so legs carry the parent's sign convention and
add up to it (section 5.6.3).

### 4.8 Cash-account association for investment accounts

Section 5.2.2. No review-step control in v1; the alternative (a per-account dropdown plus a re-preview
endpoint) is in section 14.4.

### 4.9 Shared (Money-path) files that change

Each change is behaviour-neutral for Money; the Money specs that cover each file stay green unchanged
and each change gets its own new spec case.

| File | Change |
|---|---|
| `backend/src/import/mny/model/mny-import-model.ts` | optional fields: `MappedAccount.institutionName?: string \| null`; `MappedTransaction.exchangeRate: number | null` (required: the Money mapper writes 1 as it always did, a KMyMoney row carries its own rate or null, never a defaulted 1), `MappedTransaction.reconciledDate?: string \| null`; `MappedSecurity.securityType?: SecurityType \| null`; `MappedBill.customRecurrence?: CustomRecurrence \| null` |
| `backend/src/import/mny/model/mny-warnings.ts` | KMyMoney codes appended to `MNY_WARNING_CODES` (order = display order; Money's order unchanged) |
| `backend/src/import/mny/model/mny-import-job.ts` | `MnyAccountVerification.mappedBalance?: number` |
| `backend/src/import/mny/mny-parser.service.ts` | `MnyParsedFile` gains optional `sourceFormat?: ImportSourceFormat`, `fileBalances?: ReadonlyMap<string, number>`, `kmyFile?: KmyFileSummary` (types only; Money's `parse` body untouched) |
| `backend/src/import/mny/mny-preview.ts` | `MnyPreview` gains optional `sourceFormat?: "kmy"` and `kmyFile?: KmyFileSummary`, set only when the parsed file carries them; `finalBalance` reads `fileBalances` when present, else `expectedBalances` |
| `backend/src/import/mny/mny-errors.ts` | `class MnyImportError<C extends string = MnyErrorCode>`; every existing subclass unchanged |
| `backend/src/import/mny/mny-upload-error.interceptor.ts` | constructor takes an optional exception factory, default `mnyFileTooLargeException` |
| `backend/src/import/mny/mny-import-job.service.ts` | `create(userId, stagedFileId, options, sourceFormat = "mny")` writes it to `source_format` |
| `backend/src/import/mny/mny-staging.service.ts` | the 409 "in use" and 404 messages pick the `kmy` key when the staged row's `source_format` is `kmy` |
| `backend/src/import/mny/mny-import.service.ts` | `start` takes `sourceFormat` (default `mny`) and refuses (404, that format's "file is gone" message) a staged file of another format; `runImport` takes a trailing `source = { format: "mny", filename: "" }` and parses `kmy` bytes through `KMY_SOURCE_PARSER`; `writeAll` passes the format's price source to both price writers; `verify` reports `fileBalances` as `expectedBalance` and adds `mappedBalance` when the parsed file has them; the timing log names the format |
| `backend/src/import/mny/writers/write-transactions.ts` | `exchangeRate: transaction.exchangeRate` (the column is nullable; `Transaction.exchangeRate` is `number | null`), `reconciledDate: transaction.reconciledDate ?? null` |
| `backend/src/import/mny/writers/write-reference.ts` | `writeAccounts` writes `institution: account.institutionName ?? null` and takes an optional `sourceFormat` (default `mny`) that picks the two "existing account" message keys |
| `backend/src/import/mny/writers/write-investments.ts` | `securityType: security.securityType ?? null` |
| `backend/src/import/mny/writers/write-bills.ts` | `customRecurrence: bill.customRecurrence ?? null` |
| `backend/src/import/mny/writers/write-prices.ts` | `KMY_PRICE_SOURCE = "kmy_import"`; `writeSecurityPrices` and `writeExchangeRates` take an optional trailing `source` (default `MNY_PRICE_SOURCE`) |
| `backend/src/import/mny/map/map-investments.ts` | `pairShareTransfers` is exported (no body change) |
| `backend/src/import/import.module.ts` | the KMyMoney controller and providers, and `{ provide: KMY_SOURCE_PARSER, useExisting: KmyParserService }` |

New shared file (no Money behaviour): a model file under `backend/src/import/mny/model/` holding
`ImportSourceFormat = "mny" | "kmy"`, `KmyFileSummary`, `ImportSourceParser`, `ImportSourceParseInput`
and `KMY_SOURCE_PARSER` (section 8.1).

Deliberately **not** changed: `write-prices.ts` keeps taking `MnySecurityPrice[]` / `MnyExchangeRate[]`
and a currency-handle map. The KMyMoney mapper emits rows of those two shapes (four and five plain
fields, no Money semantics) with its own handles; a writer refactor to neutral row types would touch the
Money path for no gain. `UsersService.deleteData`'s initiator literal `"mny-import"` is used by the
KMyMoney start too (it names "the import path that already holds the user's import lock"); renaming it
is part of the separate rename proposal. `computeExpectedBalances`, `investmentWritesOwnCashRow`,
`mapLoans`, `selectedBills`, `placeholderSymbol` and `MAX_SECURITY_SYMBOL_LENGTH` are imported and reused
as they are.

**Added by the payee amendment** (section 5.5; work package WP3c, which runs after WP3a, WP3b and WP4,
so it owns these files alone). Each is an optional field, an appended code or a writer that does nothing
for a payee without the new fields, so the Money path stays behaviour-identical:

| File | Change |
|---|---|
| `backend/src/import/mny/model/mny-import-model.ts` | `MappedPayee` gains optional `aliases?`, `defaultCategoryHandle?`, `contact?`, and the `MappedPayeeContact` interface (8.1) |
| `backend/src/import/mny/model/mny-warnings.ts` | seven codes appended after `holdingsReplayDiffers` (5.12) |
| `backend/src/import/mny/model/mny-import-job.ts` | `MnyImportResult` gains optional `payeeAliasesCreated?`, `payeeDefaultCategoriesSet?`, `payeeContactDetailsSet?` |
| `backend/src/import/mny/mny-preview.ts` | `MnyPreviewCounts` gains optional `payeeAliasesToCreate?`, `payeeDefaultCategoriesToSet?`, set only when `parsed.sourceFormat` is `kmy` |
| `backend/src/import/mny/mny-import.service.ts` | `writeAll` calls the payee-extras writer right after `applyImportRules`, in the same transaction; `runImport` appends the writer's warnings to the result's warning list before `summarizeWarnings` and sets the three result counts only for a KMyMoney file |
| new shared writer write-payee-extras.ts in `backend/src/import/mny/writers/` | section 5.5.4; returns at once, with no query, when no payee carries a new field |
| new pure module alias-overlap.util.ts in `backend/src/payees/` | `aliasesConflict` (exactly the refusal `PayeesService.createAlias` applies) and `aliasesCanOverlap` (5.5.1), beside `matchesAliasPattern`, used by the mapper and the writer |

## 5. Data-mapping specification

### 5.1 File-level

| KMyMoney | Monize | Rule |
|---|---|---|
| `KEYVALUEPAIRS/PAIR[kmm-baseCurrency]` | base currency | the file's; else the user's `preferredCurrency`. Never a literal |
| `FILEINFO/FIXVERSION` | review summary | decoded per R2.3 (`date` attr, then `id`, empty means 5, 2 means 3, absent means 12) |
| fix version 0 | KMyMoney's own repair, applied to the raw model before mapping and verification (`applyKmyFileFixes`, `kmy-file-fixes.ts`) | exactly what `fixFile_0` does (`kmymoney/mymoney/mymoneyfile.cpp`, `fixTransactions_0` and `fixSchedule_0`), and nothing at any other level, because `applyFileFixes` steps one level at a time and only `fixFile_0` changes an amount: a transaction's empty `commodity` becomes the base currency; then, per split, when the account's currency is the commodity and `value != shares`, `shares := value`; then a split not on a stock account whose `shares` is not at the account fraction (the currency's or security's saf, its scf for a cash account) has `shares` and `value` converted to it with RoundRound (half to even). A schedule template with no commodity takes its first split's account currency, and a template split with zero shares and a non-zero value gets `shares := value`. A file at fix version 1 to 11 is read as written: KMyMoney's balance is the sum of `shares` and its XML reader repairs nothing (R2.3) |
| fix version below 12 | none for amounts | `price` on `Add` splits is ignored at every level (ADD_SHARES carries no price; `fixFile_5`) |
| `FILEINFO/APPVERSION`, `LAST_MODIFIED_DATE` | review summary | display only |
| `USER`, `ONLINEJOBS`, `REPORTS`, `BUDGETS` | none | counted; `onlineJobsNotImported`, `reportsNotImported`, `budgetsNotImported` |

### 5.2 Accounts

#### 5.2.1 Type map (every value of R5.2)

| `type` | KMyMoney | Monize | Notes |
|---|---|---|---|
| 0 | Unknown | not imported | `unknownAccountType`; its splits import as legs of other rows where possible, else the transaction is `unusableTransaction` |
| 1 | Checkings | CHEQUING | |
| 2 | Savings | SAVINGS | |
| 3 | Cash | CASH | |
| 4 | CreditCard | CREDIT_CARD | credit limit = absolute value of `maxCreditAbsolute` (R13.2, sign unresolved in R19.2) |
| 5 | Loan | LOAN | money owed; loan terms per 5.11 |
| 6 | CertificateDep | SAVINGS | Monize has no deposit type |
| 7 | Investment | INVESTMENT, `INVESTMENT_BROKERAGE` side of a pair | 5.2.2 |
| 8 | MoneyMarket | SAVINGS | |
| 9 | Asset | ASSET | |
| 10 | Liability | LOAN | the generic liability; no terms |
| 11 | Currency | ASSET | `currencyTradingAccount` |
| 12 | Income | category (`isIncome` true) | 5.4 |
| 13 | Expense | category (`isIncome` false) | 5.4 |
| 14 | AssetLoan | ASSET | `assetLoanAsAsset`: Monize has no "money owed to you" loan |
| 15 | Stock | no account; a holding of its parent investment account | 5.7 |
| 16 | Equity | no account | opening balances (5.3), otherwise a category (5.4) |
| any type, currency is a CRYPTO code | CRYPTO | INV-CRYPTO-001: a coin is the currency of a CRYPTO account only; the writer would refuse anything else and roll the import back |
| standard roots `AStd::*` | none | never imported; a missing `parentaccount` reparents to the root of the type's group (R5.3); an account unreachable from a root is `unknownAccountType` with detail `unreachable` |

| Field | Source | Rule |
|---|---|---|
| `name` | `name`, trimmed | unique within the import case-insensitively by ` (2)`, ` (3)` suffixes, `duplicateAccountName`; empty means `Account` |
| `moneyName` | `name` as written | the review table shows "named X in KMyMoney" when it differs |
| `currencyCode` | `currency` | an id not matching `^[A-Z]{3}$` cannot be a Monize code: the account is not imported, `unsupportedCurrencyCode`; an id defined nowhere in `CURRENCIES` but three letters is used as it is (Monize creates it as this user's own currency); an empty id is the base currency |
| `openingBalance` | 5.3 | |
| `closed`, `closedDate` | KVP `mm-closed` = `yes`, `mm-closed-date` | applied after every row (the shared `applyDeferredClosures`) |
| `favourite` | KVP `PreferredAccount` = `yes` | |
| `description` | `description` attribute (the account notes) | null when empty |
| `institutionName` | the `INSTITUTION` named by the `institution` attribute | its `name`, written to the account's free-text `institution` column (the legacy column every surface still falls back to); no `institutions` row is created |
| `excludeFromNetWorth` | none | false |
| `creditLimit` | `maxCreditAbsolute` | CREDIT_CARD only |
| account number, IBAN | `number`, KVP `iban` | not imported (`accountNumbersNotImported`, one warning, count of accounts) |
| hierarchy | `parentaccount` between asset/liability accounts | flattened (`accountHierarchyFlattened`, count) |
| online banking | `ONLINEBANKING` | never read (`onlineBankingNotImported`, count) |

#### 5.2.2 Investment accounts and the brokerage cash account

Monize models an investment account as a linked pair, `INVESTMENT_CASH` plus `INVESTMENT_BROKERAGE`,
both type INVESTMENT, the brokerage side's balance always 0 (the Money pair, built the same way by
`backend/src/import/mny/map/map-reference.ts`, named with `cashSuffix()` / `brokerageSuffix()` from
`backend/src/accounts/account-name.util.ts`).

For each type-7 account `I`, its cash account is the first of:

1. the account named by `I`'s KVP `kmm-brokerage-account`, if that is a non-standard asset or liability
   account of type 1, 2, 3, 8 or 9;
2. an account of those types whose name equals `"<I.name> (<suffix>)"` for a suffix in
   `KMY_BROKERAGE_SUFFIXES`, compared case-insensitively, with at least one match: the English
   `Brokerage` plus every translation KMyMoney ships for `i18nc("Brokerage (suffix for account names)")`
   (from its `po/*/kmymoney.po` at the pinned commit): Brokerage, Verrechnung, Courtage, Corretaje,
   Corretagem, Corretaxe, Intermediazione, Makler, Makléř, Maklérstvo, Børsmægler, Kurtasje, Kontantdepå,
   Afsluitprovisie, Maksunvälittäjä, Vahendustehingute konto, Artekaritza, Valors, Posredništvo,
   Kurtado, Bróicéireacht, Brokeraj, Komisyon, Куртаж, Брокерский счёт, Делдал ақысы, Μεσιτεία,
   سمسرة, ბროკერული ანგარიში, ນາຍໜ້າ, 증권, 托管, 傭金. An account matched by two investment accounts
   goes to the first by handle. A matched account whose currency differs from `I`'s stays a standalone
   account, `brokerageCurrencyMismatch`.
3. none: the pair gets a synthesized, empty cash side `acct-<I>-cash` (handle null), as Money does for
   an investment account with no companion, and `brokerageAccountNotFound` names `I`.

The pair's currency is `I`'s; its opening balance is the cash account's (5.3); closed if either half is;
favourite if either is. The cash account no longer appears as a standalone account. A trade whose asset
split is in any other account is funded from there (5.7.3), which is correct without the association.

### 5.3 Opening balances

A KMyMoney opening balance is a transaction (R5.6). For each Monize account key `K` (an ordinary
account, or a pair's cash side, which collects both the brokerage account and the type-7 account
itself):

1. Candidates: transactions with exactly two splits, one on a type-16 account and one on an account that
   maps to `K`, post date on or before `asOf`.
2. The earliest candidate by (post date, transaction handle) is folded iff no other transaction touching
   `K` is dated before it. Folding: `openingBalance(K) += that split's shares` (in `K`'s currency), and
   the transaction produces no row.
3. Every other candidate imports as an ordinary transaction whose equity split is a category leg (5.4).

| Example | Splits | Result |
|---|---|---|
| Checking opened 2024-01-01 with 5000 | Checking +5000, Opening Balances -5000 | `openingBalance` 5000, no row |
| Credit card opened owing 500 | Card -500, Opening Balances +500 | `openingBalance` -500 (Monize stores a liability negative, as KMyMoney does) |
| Second "balance adjustment" on 2024-06-01 against Opening Balances | Checking +12.34, Opening Balances -12.34 | a row of +12.34, category "Opening Balances" (income-type, see 5.4) |
| Investment opened with 1000 cash (KMyMoney puts it on the brokerage account) | Brokerage +1000, Opening Balances (USD) -1000 | the pair's cash side `openingBalance` 1000 |
| Opening balance dated after a purchase in the same account | | not folded: imported as a row, so the running balance before it stays what KMyMoney showed |

### 5.4 Categories

| KMyMoney | Monize | Rule |
|---|---|---|
| type 12/13 account | category | `name` per level; `isIncome` = type 12; parent = the nearest ancestor that is itself a type 12/13 account (the `AStd::Income`/`AStd::Expense` roots become top level). Depth is preserved |
| type 16 account used outside a folded opening balance | top-level category named after the equity account, `isIncome` true (equity is credit-normal, like income) | `equitySplitAsCategory` (count of splits) |
| `referencedOnlyCategories` (default true) | | only categories a written row, leg, trade or selected bill references, **plus all their ancestors** |

`MappedCategory.parentName` is the parent's `fullName` and `fullName` is the chain of KMyMoney account
handles joined by `/` (for example `11/12`). The shared `writeCategories` already looks a parent up by
`idByFullName.get(category.parentName)` and creates by `(name, parent id)`, so this gives the full tree
with no writer change, provided parents come first (the mapper orders by depth, then handle). `fullName`
is an import-local identity the writer never displays; using handles keeps a name containing `:` from
colliding with a path. A 3-level tree is in the integration spec (section 11).

Category KVPs `Tax`, `VatRate`, `VatAccount`, `CostCenter` are not imported.

### 5.5 Payees, tags, cost centers

| KMyMoney | Monize | Rule |
|---|---|---|
| `PAYEE` | payee | `name` trimmed; find-or-create by name (shared writer); referenced-only by default |
| payee matching: `matchingenabled`, `usingmatchkey`, `matchignorecase`, `matchkey` | payee aliases (`payee_aliases`) | 5.5.1 |
| payee `defaultaccountid` | the payee's default category (`payees.default_category_id`) | 5.5.2 |
| payee `notes`, `email`, `ADDRESS` (`street`, `city`, `state`, `zip`, `telephone`) | the payee's `notes`, `email`, `address`, `phone` | 5.5.3 |
| payee `reference`, `payeeIdentifier` children, `idpattern` / `urltemplate` | none: Monize has no field for any of them | `payeeDetailsNotImported`, one per payee, `detail` naming the fields |
| a split's payee | the row's or leg's payee | a row takes its own split's payee, else the first non-empty payee among the transaction's other splits in document order (R6.6) |
| `TAG` | tag | `name` (100 characters); referenced only; `tagcolor`, `notes`, `closed` dropped |
| split `TAG` children | tags of the row or leg the split becomes | a plain two-split row carries the union of both splits' tags; a transfer row its own split's; a split parent its own split's and each leg its split's |
| `COSTCENTER`, split `costcenter` | none | `costCentersNotImported` (count of splits) |

Everything in 5.5.1 to 5.5.3 applies to **written** payees only: under `referencedOnlyPayees` (the
default) an unused payee is not created, and its rules, default category and details go with it.

#### 5.5.1 Payee matching rules

**What KMyMoney stores** (R10.1). `matchingenabled`, `usingmatchkey` and `matchignorecase` are read as
unsigned integers (empty or unparsable is 0, any other value true; `"true"` is 0). Four modes:
Disabled (`matchingenabled` 0; the rest is not written); **Name** (`usingmatchkey` 0): match on the
payee's own name, contained anywhere ("Match Payees name (partial)" in KMyMoney's payee view);
**NameExact** (`usingmatchkey` 0 and `matchkey` exactly `^$`): the whole text is the name ("Match Payees
name (exact)"); **Key** (`usingmatchkey` 1): "Match on a name listed below", the keys in `matchkey`,
separated by a line feed (`&#10;`; a single key carries a trailing one), or by `;` when the value holds
no line feed (KMyMoney 4.8). Empty keys and keys made only of spaces are dropped; keys are **not**
trimmed. `matchignorecase` absent is 0 (case-sensitive).

**How KMyMoney applies a rule** (STR, during an OFX, QIF, CSV or online-banking statement import, for a
non-empty imported payee text T). Every payee with matching enabled contributes regular expressions:
Name `QRegularExpression::escape(name)`, NameExact `^` + that + `$`, Key each key as written. Each is a
PCRE2 pattern (Qt's `QRegularExpression`, case-insensitive option when `matchignorecase` is set, no
other option) **searched** in T, so an unanchored key matches when it occurs anywhere. Among all payees
that match, the one with the longest matched length wins; equal lengths go to the payee met later in
KMyMoney's own payee order. When nothing matches, KMyMoney creates a payee named T with the single key
`^` + escape(T) + `$`, case-insensitive, which is why most real keys look like
`^THE\ AMERICAN\ CHE\ CONS\ PAY$` (Qt escapes every character outside `[A-Za-z0-9_]`, spaces included;
upstream sample `test-441023.xml`). A payee created by hand starts as NameExact, case-insensitive (KU),
and merging payees appends the merged names to the target's keys **unescaped** (PV), so a key
`AMAZON.COM` is a regular expression whose `.` matches any character.

**What Monize has.** `payee_aliases` (`backend/src/payees/entities/payee-alias.entity.ts`), described in
`database/schema.sql` as "for mapping imported payee names to canonical payees". The matcher is
`matchesAliasPattern` (`backend/src/payees/alias-match.util.ts`): the **whole** text, case-insensitive
(`toLowerCase` on both sides), `*` stands for any run of characters including none, no other
metacharacter and no escape, and a pattern or text over 500 characters never matches. Uniqueness:
`idx_payee_aliases_user_alias` on `(user_id, LOWER(alias))`. Bounds: `alias VARCHAR(255)`; the API
(`backend/src/payees/dto/create-payee-alias.dto.ts`) caps it at 255 and strips `<` and `>`;
`PayeesService.createAlias` trims it and refuses one that overlaps any existing alias in either direction
(`matchesAliasPattern(new, old) || matchesAliasPattern(old, new)`). Aliases are read when a new row's
payee is resolved: the file import (`resolvePayee` in
`backend/src/import/import-regular-processor.service.ts`: exact name, case-sensitive, then the first
matching alias), bank sync (`findExistingPayee` in `backend/src/bank-sync/bank-sync-payee-lookup.ts`, the
same two tiers) and `PayeesService.resolveByName` (assistant, MCP, a rule's `set_payee_from_text`). No
Monize path applies an alias to rows already written.

Three structural differences follow, each handled below: KMyMoney's keys are regular expressions searched
anywhere, Monize's aliases are globs over the whole text; a KMyMoney key can be case-sensitive, an alias
never is; KMyMoney settles a text two payees match by the longer match, Monize takes an exact payee name
first, then whichever alias it reads first, and refuses overlapping aliases when they are created.

**The translatable subset.** A key translates only when the whole key is, in this grammar:

```
key      := [ "^" ] item* [ "$" ]
item     := literal | escaped | anyrun
literal  := any character other than  \ ^ $ . | ? * + ( ) [ ] { }
escaped  := "\" c   where c is not an ASCII letter or digit (c is then literal; this is what Qt's escape writes)
anyrun   := ".*" | ".*?"
```

Its glob is: `*` unless the key starts with `^`; then each literal or escaped character as itself and
each anyrun as `*`; then `*` unless the key ends with an unescaped `$`; runs of `*` collapse to one.
Equivalence: for every payee text without a line break, the glob matches T ignoring case exactly when the
key, compiled case-insensitively, finds a match in T (a search for `x` is a text of the form `*x*`; an
anchor removes the star on its side; `.*` and `.*?` cover any run without a line break; PCRE2 reads a
backslash before any character that is not an ASCII letter or digit as that character). A text with a
line break is the one accepted difference (`.` and `$` treat it specially in PCRE2, `*` does not); no
file import, bank sync or statement payee text Monize writes contains one. Everything else is outside the
subset even where a translation exists in theory: `.` on its own, `+`, `?`, `|`, groups, classes,
counted repetition, every backslash-letter or backslash-digit escape (`\d`, `\b`, `\s`, `\w`, `\0`),
`\Q...\E`, inline options, and `^` or `$` anywhere but the ends. A key KMyMoney itself could not compile
is outside it too (it never matched there).

**Truth table.** N is the payee name as written in the file (not trimmed: KMyMoney builds the pattern
from it), "ic" is `matchignorecase`.

| Mode | Key shape | Monize | Warning |
|---|---|---|---|
| Disabled | none | no alias | `payeeMatchingDisabled`: Monize's exact-name tier cannot be turned off, so a later import whose payee text is exactly N still links to the payee |
| Name | escape(N), searched | glob `*N*`, then the checks below | per the checks |
| NameExact, ic, N has a cased letter | `^escape(N)$` | glob `N`, then the checks | per the checks |
| NameExact, not ic, or N has no cased letter | `^escape(N)$` | no alias: Monize's exact-name tier (whole text, case-sensitive) is the same rule | none |
| Key | inside the subset | its glob, then the checks | per the checks |
| Key | `^$` | nothing: KMyMoney never matches an empty payee text | none |
| Key | outside the subset | not imported | `payeeMatchKeyNotImported`, detail `untranslatable` |

The checks, in order, on the glob g of payee P (the first that applies decides):

| # | Condition | Result | Detail |
|---|---|---|---|
| 1 | the key or N holds a literal `*` | not imported, `payeeMatchKeyNotImported` (a Monize glob has no escape) | `literalStar` |
| 2 | g is only `*` | not imported, `payeeMatchKeyNotImported` (it would be every payee text's alias) | `matchesEverything` |
| 3 | g holds `<` or `>` | not imported, `payeeMatchKeyNotImported` (the API strips them, so no such alias can exist) | `angleBracket` |
| 4 | g starts or ends with a whitespace character | not imported, `payeeMatchKeyNotImported` (Monize trims an alias) | `edgeWhitespace` |
| 5 | g is longer than 255 characters | not imported, `payeeMatchKeyNotImported` | `tooLong` |
| 6 | g holds a character whose `toLowerCase()` has a different length (`İ`) | not imported, `payeeMatchKeyNotImported` (Monize's lowercasing and PCRE2's caseless match disagree on it) | `caseFolding` |
| 7 | g has no `*`, equals P's trimmed name, and the key is case-sensitive or g has no cased letter | not written, no warning: the exact-name tier already is this rule | |
| 8 | the key is case-sensitive and g has a cased letter (`c.toLowerCase() !== c.toUpperCase()`) | imported, `payeeMatchCaseWidened`: it now also matches other capitalizations | |
| 9 | otherwise | imported | |

A `payeeMatchKeyNotImported` or `payeeMatchCaseWidened` warning has `subject` = `<payee name>: <key as written>`
(the samples the review shows) and `detail` = the reason in the table. One warning per key.

**Collisions** (between different Monize payees; deterministic order: payee handle, then key order):

| Collision | Result | Warning |
|---|---|---|
| g equals, ignoring case, an alias already accepted for another payee, or `matchesAliasPattern` holds in either direction (exactly `createAlias`'s refusal) | the later g is not imported | `payeeMatchKeyConflict`, subject `<payee>: <g>`, detail `<other payee>: <other alias>` |
| g has no `*` and equals, ignoring case, the name of another written or existing payee | not imported (the other payee's name would win for that exact text anyway, and the two disagree on case) | `payeeMatchKeyConflict`, detail `<other payee> (name)` |
| no conflict, but some text matches g and an alias of another payee (`aliasesCanOverlap`) | both imported | `payeeMatchKeyOverlap` on the later one: KMyMoney gives such a text to the longer match, Monize to either |
| two KMyMoney payees land on one Monize payee (`writePayees` reuses a name ignoring case) | their aliases are one set: no collision | |

Within one Monize payee, duplicates ignoring case collapse, and an alias another alias of the same payee
subsumes (`matchesAliasPattern(narrow, broad)`) is not written: the payee is the same either way. This
runs after the collision pass, so a narrow alias survives when its broad sibling was refused.

The mapper applies the table among the file's own payees (so the preview shows it); the writer applies
the same functions at commit against the user's existing aliases and payee names (5.5.4), which only the
commit can see (the wipe option runs after the preview). `aliasesCanOverlap(a, b)` is exact: compare in
lowercase with `*` runs collapsed; two literals overlap when equal; a literal and a glob when the glob
matches the literal; two globs (both holding `*`) exactly when one literal prefix (before the first `*`)
is a prefix of the other and one literal suffix (after the last `*`) is a suffix of the other. Proof of
the last case: the text "longer prefix + a's middle segments + b's middle segments + longer suffix"
matches both; without compatible prefixes (or suffixes) no text can start (or end) with both. Its cost
is linear per pair; the mapper and writer test each alias holding a `*` against all others, so a file of
n aliases with w wildcard ones costs O(w x n) pair tests.

#### 5.5.2 Default category

| `defaultaccountid` names | Monize | Warning |
|---|---|---|
| nothing (attribute absent or empty) | none | |
| a type 12 or 13 account (income or expense category) | `defaultCategoryHandle` = that account's handle; the category and its ancestors are written even under `referencedOnlyCategories`, because a written payee references it | |
| a type 16 account (equity) | the equity category of 5.4, created for the same reason | |
| an asset, liability or stock account (KMyMoney's payee view offers them), or an id the file does not define | none: Monize's default category is a category only | `payeeDefaultCategoryNotImported`, subject the payee, detail the account name or the id |
| a payee already carrying another default category from an earlier payee of the same name, ignoring case | the first by handle kept | `payeeDefaultCategoryNotImported`, detail `sameName` |

Monize applies a payee's default category when a later imported or synced row resolves to that payee
without a category, and in the transaction form, which is what KMyMoney does with it (STR uses it when
an imported transaction has no split of its own). The import's own rows already carry their categories;
no writer and no rule reads a payee's default category while the import runs (the file import's rule
pass does not either, see `.trail/learnings/2026-10-30-bank-sync-rule-chosen-payee-s-node.md`).

#### 5.5.3 Contact details

Each field is validated against the payee DTO bounds (`backend/src/payees/dto/create-payee.dto.ts`), so a
payee the import writes can be saved again from its edit form unchanged:

| KMyMoney | Monize | Rule | Not imported when (`payeeDetailsNotImported`, detail names the field) |
|---|---|---|---|
| `notes` | `notes` | `sanitizeHtmlString` (`backend/src/common/decorators/sanitize-html.decorator.ts`), trimmed; empty is none | longer than 500 characters |
| `email` | `email` | trimmed; empty is none | not an address by class-validator's `isEmail` (the DTO's own check), or longer than 255 |
| `ADDRESS telephone` | `phone` | `normalizePhoneNumber(raw, phoneRegion)` (`backend/src/common/phone-number.util.ts`), stored form | refused by it: invalid, or a national number when the user's preferences name no region (never a guessed region) |
| `ADDRESS street`, `city`, `state` (else `country`, else `county`), `zip` (else `zipcode`, else `postcode`) (R2.4) | `address` | the street's lines, then city, state and postcode, each trimmed, empty ones dropped, joined with `, `, then sanitized | longer than 500 characters |
| `reference`, `payeeIdentifier`, `idpattern` / `urltemplate` | none | no field | always |

`phoneRegion` is `phoneRegionFromPreferences` of the user's preference row, which the parser service
reads in the same query as the default currency, so the preview and the job normalize alike. One
`payeeDetailsNotImported` per payee, `subject` the payee name, `detail` the fields joined with `, `.

#### 5.5.4 Where it is written

The shared writer write-payee-extras runs inside `writeAll`'s one `withScopedDb` transaction, right
after `applyImportRules` (`backend/src/import/mny/writers/apply-import-rules.ts`) and before
`writeSecurities`; nothing after it in the import reads aliases (the rule pass's `set_payee_from_text`
resolves names through `PayeesService.resolveByName`, which reads aliases, and has already run). Its
input is the mapped payees, `WrittenPayees.idByName` and the category id by handle. For each payee that
carries a new field, in handle order:

1. Default category and contact details: one statement that only fills what is empty and leaves the
   user's own values alone, `UPDATE payees SET default_category_id = COALESCE(default_category_id, $3),
   notes = COALESCE(NULLIF(notes, ''), $4), email = COALESCE(NULLIF(email, ''), $5), phone =
   COALESCE(NULLIF(phone, ''), $6), address = COALESCE(NULLIF(address, ''), $7) WHERE id = $1 AND
   user_id = $2 RETURNING` those five columns. A returned value that differs from the one supplied
   means the payee already had its own: `payeeDetailsKept` (post-import, subject the payee, detail the
   fields). A payee the import created has none, so every field lands.
2. Aliases: the user's aliases and payee names are loaded once; each alias goes through the collision
   table of 5.5.1 against them (`payeeMatchKeyConflict` / `payeeMatchKeyOverlap`, post-import), then
   `insertPayeeAliasIgnoringDuplicate` (`backend/src/payees/insert-payee-alias.util.ts`), whose savepoint
   turns a unique-index race with a concurrent alias edit into a skip (`payeeMatchKeyConflict`) instead
   of aborting the import.

Every write shares the import transaction: a rollback drops them with the rows, and
`markDataCommitted` stays the last statement. The writer inserts no transaction, so the rule-application
guard is not involved. It returns `{ aliasesCreated, defaultCategoriesSet, contactDetailsSet, warnings }`;
for a payee list without any new field (every Money file) it returns zeros and no warnings without a
query.

#### 5.5.5 Worked examples

| Payee in the file | Matching attributes | Monize | Warning |
|---|---|---|---|
| Big Org (sample `test-441023.xml`) | Key, ic, `^THE\ AMERICAN\ CHE\ CONS\ PAY$` | alias `THE AMERICAN CHE CONS PAY` | |
| City Power (reference section 18) | Key, ic, `CITY POWER` + line feed | alias `*CITY POWER*`; default category Electricity | |
| Corner Market (reference section 18) | Disabled | no alias | `payeeMatchingDisabled` |
| bank (sample `test-general-information.xml`) | NameExact, ic | alias `bank` | |
| 7/11 | NameExact, ic | none (no cased letter: the exact-name tier is the rule) | |
| Netflix | Name, ic | alias `*Netflix*` | |
| Amazon | Key, ic, `^AMZN.*MKTP$` | alias `AMZN*MKTP` | |
| Amazon | Key, ic, `AMAZON.COM` (from a KMyMoney merge) | not imported | `payeeMatchKeyNotImported`, `Amazon: AMAZON.COM`, `untranslatable` |
| Gym | Key, not ic, `^GYM CLUB` | alias `GYM CLUB*` | `payeeMatchCaseWidened` |
| Fuel | Key, ic, `^(SHELL\|ESSO)` | not imported | `payeeMatchKeyNotImported` |
| Payroll | Key, ic, `\d{4} PAYROLL` | not imported | `payeeMatchKeyNotImported` |
| Misc | Key, ic, `.*` | not imported | `payeeMatchKeyNotImported`, `matchesEverything` |
| Sale | Key, ic, `SALE \*50%` | not imported | `payeeMatchKeyNotImported`, `literalStar` |
| Amazon | Key, not ic, `^Amazon$` | none (check 7) | |
| Coffee (handle 3), then Starbucks Reserve (handle 4) | Key, ic, `STARBUCKS`; Key, ic, `^STARBUCKS RESERVE` | `*STARBUCKS*` on Coffee; `STARBUCKS RESERVE*` refused (`*starbucks*` matches its text) | `payeeMatchKeyConflict`, `Starbucks Reserve: STARBUCKS RESERVE*`, `Coffee: *STARBUCKS*` |
| Amazon (handle 5), then Prime Video (handle 6) | Name, ic; Key, ic, `PRIME` | `*Amazon*` and `*PRIME*`, both kept | `payeeMatchKeyOverlap` on `*PRIME*`: "AMAZON PRIME" goes to Amazon in KMyMoney (6 characters against 5) and to either in Monize |

### 5.6 Transactions (non-investment)

#### 5.6.1 Classification

A split with an empty `account` refuses the file, as KMyMoney's reader does (4.3 row 9, R6.2). Let `A` be the splits on asset/liability accounts
(types 1-11, 14, and 7 itself), `C` the splits on income/expense accounts, `E` on equity accounts,
`S` on stock accounts. A transaction with any `S` split goes to 5.7.

| `A` | `C`+`E` | Monize shape | Example |
|---|---|---|---|
| 0 | any | not imported, `unusableTransaction` | a reclassification between two categories |
| 1 | 0 | one row, no category, `singleSplitTransaction` | KMyMoney's "uncategorized" one-split row |
| 1 | 1 | one row with that category | groceries |
| 1 | 2+ | one split row: parent in the `A` account, one category leg per split | grocery + fee |
| 2 | 0 | a transfer pair: one row per side, cross-linked through `linkedTransactionId` | savings to checking |
| 2+ | 1+, or 3+ and 0 | one split row in the parent account (5.6.2); a transfer leg per other `A` split, each with its counterpart row; a category leg per `C`/`E` split | a paycheque, a loan payment, a three-way transfer |

The post date is the transaction date. A transaction with an empty or invalid post date is
`unusableTransaction`. Two transactions with the same post date and id collapse to the later one, as in
KMyMoney (R6.1), `duplicateTransactionId`. A split on a type-0 or unimported account (unsupported
currency) is treated like a split on an account the user excluded (5.6.6). A split on an account in
no class (a type KMyMoney does not write) is left out of every shape, and so of the balance that decides
between a plain row and a split row: its value appears as the uncategorized leg of 5.6.3 with
`unbalancedTransaction`, never inside a category's amount. Two `A` splits that map to one Monize account
are not a transfer from the account to itself: in the two-split shape each becomes its own unlinked row
(as KMyMoney's ledger lists them), and in a split row the split on the parent's own account becomes its
own row with an uncategorized leg balancing it; both raise `sameAccountTransferUnlinked`.

#### 5.6.2 Parent of a split row

The `A` split with the largest absolute `value`; ties go to document order. In every shape the KMyMoney
editor writes, that is the account the money is drawn from or lands in (the payment account of a loan
payment, the chequing account of a paycheque).

#### 5.6.3 Legs

For each other split `o` of the transaction, a leg of amount
`round(-o.value * parent.shares / parent.value)` in the parent's currency (exactly `-o.value` when the
parent's account currency is the commodity; when `parent.value` is 0 the leg is `-o.shares` if `o` is in
the parent's currency, else the transaction is `unbalancedTransaction` with the legs at 0 and one
uncategorized leg of the parent's amount). Legs sum to the parent exactly:

1. If the exact sum of all splits' `value` is not 0, KMyMoney flags the transaction "erroneous" (R6.3):
   an uncategorized leg (category null) of `parent.amount - sum(legs)` is added and
   `unbalancedTransaction` is raised with the residual as detail.
2. Otherwise any rounding residual from the conversion (at most one unit of the last place per leg) is
   added to the leg with the largest absolute amount, without a warning.

A transfer leg names the counterpart account and the counterpart row's pre-generated id; the
counterpart row is in that split's account, amount = its `shares`, `isTransfer` true, `linkedTransactionId`
= the parent row (financial-semantics section 2: the counterpart of a split transfer points at the
parent).

#### 5.6.4 Cross-currency transfers

A transfer row and a transfer counterpart each keep their own split's `shares`, in their own account's
currency. The positive (receiving) row carries `exchangeRate = roundFxRate(|positive.amount| /
|negative.amount|)`, the receiving currency per unit of the sending currency, as Monize's own
`createTransfer` stores the implied rate on the destination leg; the sending row carries 1. Same
currency: 1 on both. Zero on both sides: 1. Zero on one side only: the file's own price for the pair (`KmyRateLookup`, under the same `resolveFxRate` rule and 45-day bound as 5.7.3), else the receiving row carries no rate (null), never 1, and the transfer is named in `crossCurrencyTransferRateMissing` (the date, the two accounts as KMyMoney names them and the currency pair in the detail; the same for the counterpart of a split row).

Worked example (the reference's section 18, T5): commodity USD; Checking `shares = value = -1100`, EUR
Savings `value = 1100` (USD), `shares = 1000` (EUR). Rows: Checking -1100.0000 USD, rate 1; EUR Savings
+1000.0000 EUR, rate `roundFxRate(1000 / 1100)` = 0.9090909091. Balances: Checking -1100 USD, EUR
Savings +1000 EUR, exactly the two `shares`.

A category split in a foreign currency (R6.3, T013) needs nothing extra: the leg is converted through the
parent's ratio (4.7).

#### 5.6.5 Status, dates, numbers, memos

| KMyMoney (per split) | Monize (per row or counterpart) |
|---|---|
| `reconcileflag` 0 | UNRECONCILED |
| 1 | CLEARED |
| 2 | RECONCILED |
| 3 (Frozen) | RECONCILED |
| `reconciledate` | `reconciled_date` (null when empty) |
| `number` | `reference_number`, trimmed to 100 characters |
| `memo` of the row's own split, else the transaction `memo` | `description`; a leg's memo is its split's `memo` |
| `bankid`, `entrydate`, transaction KVP `Imported`, split action strings other than investment actions | not imported |

There is no VOID in KMyMoney, so no row is VOID. Each row takes its own split's state, so the two sides of
a transfer may differ (as in Money); FIN-001 concerns writes that change a status, not imported states.

#### 5.6.6 Excluded accounts

When the user excludes an account (or it cannot import), a transfer pair to it becomes one ordinary row
with no category (`transferAcrossExcludedAccount`); a transfer leg to it becomes an uncategorized
category leg. Balances of the included side are unchanged.

#### 5.6.7 Worked examples

| KMyMoney splits (shares; commodity = account currency) | Monize |
|---|---|
| Checking -120.50, Groceries +100.50 (tag household, memo Food), Bank Fees +20.00 | split row Checking -120.5000: legs Groceries -100.5000 (tag household, memo Food), Bank Fees -20.0000 |
| Checking -500, Loan +400 (`Amortization`), Interest +100 | split row Checking -500: transfer leg to Loan -400 (counterpart Loan +400, `isTransfer`, linked to the parent), category leg Interest -100 |
| Checking +2000, Salary -2500, Tax +400, Savings +100 | split row Checking +2000: Salary +2500, Tax -400, transfer leg to Savings -100 (counterpart Savings +100) |
| Checking -300, Savings +100, Brokerage cash +200 | split row Checking -300: transfer legs -100 and -200, two counterparts |
| Checking -50, Groceries +40 (sum of values -10) | split row Checking -50: Groceries -40, uncategorized -10, `unbalancedTransaction` detail `-10` |

### 5.7 Investments

#### 5.7.1 Dissection (KMyMoney's own, R7.3)

For a transaction with at least one split on a stock account:

- `S` = the first split on a stock account. The security is `S.account.currency` (a security id); the
  holding account is the nearest type-7 ancestor of `S.account`. No type-7 ancestor:
  `stockAccountWithoutInvestment`, and the transaction imports as cash only (5.7.6).
- Every other split: expense account means fee (`F`); income account means income (`I`); the first
  asset/liability/equity split is the asset split `A`; any further asset/liability split is an extra
  asset split `X` (5.7.6). A second split on a stock account is `multipleStockSplits` (5.7.6).
- Activity from `S.action` and the sign of `S.shares`: `Buy` with shares >= 0 BuyShares, < 0
  SellShares; `Add` >= 0 AddShares, < 0 RemoveShares; `Dividend`, `Yield`, `IntIncome`, `Reinvest`,
  `Split` as named. A stock split with any other action, including empty, makes the transaction one
  KMyMoney does not classify as an investment activity (5.7.7); only its editor defaults it to a buy.

#### 5.7.2 Activity table

All amounts in the transaction commodity (the security's trading currency) unless named; `sumF` = sum of
`F.value`; `gross` = `-sum(I.value)`. "Cash" is `A.shares` in `A`'s account currency.

| KMyMoney activity | Monize action | quantity | totalAmount (fact) | commission | price (derived) | cash | category |
|---|---|---|---|---|---|---|---|
| BuyShares | BUY | `S.shares` | `S.value + sumF` | `sumF` | `derivePriceFromTotal` = `S.value / S.shares` | `A.shares` | null |
| SellShares | SELL | `-S.shares` | `-S.value - sumF` | `sumF` | `(total + commission) / quantity` = `-S.value / -S.shares` | `A.shares` | null |
| Dividend, Yield | DIVIDEND | null | `gross` (when no `I` split: `A.value + sumF`) | `sumF` | total | `A.shares` | first `I`'s category |
| IntIncome | INTEREST | null | as DIVIDEND | `sumF` | total | `A.shares` | first `I`'s category |
| ReinvestDividend | REINVEST | `S.shares` (positive) | `S.value + sumF` | `sumF` | `S.value / S.shares` at 10 places | none when an `A` split pays cash out (that part is a DIVIDEND row of `A.value` with the cash and the same category, so the income recorded is all of it); `A.shares` for any other `A` split, else none | first `I`'s category |
| AddShares | ADD_SHARES, or TRANSFER_IN when paired (5.7.4) | `S.shares` | 0 | 0 | null | none | null |
| RemoveShares | REMOVE_SHARES, or TRANSFER_OUT when paired | `-S.shares` | 0 | 0 | null | none | null |
| SplitShares, transaction of exactly one split | SPLIT | `S.shares` (the multiplier) | 0 | 0 | null | none | null |
| `Split` action in a transaction of several splits | ADD_SHARES / REMOVE_SHARES of `S.shares` | | | | | | `splitActionInMultiSplit` (KMyMoney sums such shares as ordinary shares, R7.4) |

A share count finer than the column's 8 places is rounded, `sharesRounded` (the split ratio of SPLIT has
its own `stockSplitRatioRounded`). A BUY or SELL with no `A` split imports as recorded, with no cash, and
raises `unbalancedTransaction`, as KMyMoney marks it. An amount whose integer part has more than the 16
digits the columns store refuses the file (`kmyCorruptFile`).

Common fields: `transactionDate` = post date; `status` from `A`'s reconcile flag, else `S`'s (5.6.5);
`payeeHandle` = first non-empty payee of `S`, `A`, then the rest; `description` = `S.memo`, else
`A.memo`, else the transaction memo; `accountKey` = the pair's brokerage key; `currencyCode` = cash
account currency; `securityCurrencyCode` = the security's trading currency; `fundingAccountKey`,
`cashTransactionId`, `transactionSplitId` null and `accruedInterest` 0 unless 5.7.3 says otherwise;
`linkedInvestmentId` null unless paired or a companion; `tagHandles` from `S` and `A`.

Income splits on a buy or a sale (`I` on BuyShares/SellShares): each `I` with `-I.value > 0` becomes a
linked INTEREST companion row (quantity null, total `-I.value`, price = total, no cash, category = that
`I`'s, `linkedInvestmentId` both ways), the same shape as the Money importer's accrued-interest companion;
an `I` with `-I.value <= 0` adds `I.value` to the commission. The main row's cash stays `A.shares`, so the
cash account still receives exactly what KMyMoney recorded.

A trade whose computed total is below 0 (a sale whose fees exceed its proceeds), or a BUY/SELL with zero
shares, imports as cash only (5.7.6) with `investmentImportedAsCash`.

#### 5.7.3 Where the cash moves

| `A` split | `cashAccountKey` | `fundingAccountKey` | `exchangeRate` (security to cash) |
|---|---|---|---|
| none | null | null | 1 |
| on the pair's cash account (or the type-7 account itself) | the cash key | null | `|A.shares| / |A.value|`, 1 when equal currencies |
| on any other imported asset/liability account | that account's key | the same key | as above |
| on an equity account | null (no Monize account) | null | 1, `tradeFundedFromEquity`: the position and its cost basis import, the cash side does not exist in Monize |

`investmentWritesOwnCashRow` is then true exactly when `A` is on an imported account and `A.shares` is not
0, so the shared writer writes one cash row of `A.shares` in that account, `computeExpectedBalances`
counts it there, and the per-account row count includes it.

Cross-currency trade example: EXC trades in USD, the brokerage cash account is EUR. Buy 10 at 50 USD with
a 5 USD fee: `S.value 500`, `S.shares 10`, `F.value 5`, `A.value -505` (USD), `A.shares -459.09` (EUR).
Row: BUY, quantity 10, totalAmount 505.0000 (USD), commission 5.0000, price 50.0000000000, cashAmount
-459.0900 (EUR), exchangeRate `roundFxRate(459.09 / 505)` = 0.9090891089. The cash account moves by
exactly -459.09 EUR.

When the transaction commodity is not the security's trading currency (a trading currency changed after
the fact), the amounts are converted to the trading currency at the file's own price for that pair on the
date, chosen by Monize's rule for a rate for a date (INV-FX-001): `resolveFxRate`
(`backend/src/common/time-series/fx-rate-resolver.ts`) over the file's currency prices, the newest
observation on or before the date within `FX_MAX_RATE_AGE_DAYS` (45 days), either direction, a tie to the
direct pair, never one struck after the date (`buildRateLookup` in `kmy-map-prices.ts`; the resolver picks
the observation, the exact rational stored for it is the rate). KMyMoney's own `MyMoneyFile::price` takes
the newest price on or before the date at any age; the importer deliberately does not, because a
nine-year-old rate would set a cost basis wrong by nine years of currency moves with nothing saying so.
With no admissible price the amounts stay in the commodity with `securityCurrencyCode` set to it and
`crossCurrencyTradeUnconverted`, as the Money mapper does; the detail names the pair, and the date of the
file's newest rate when one exists but is too old (`EUR->USD (2015-03-01)`).

#### 5.7.4 Securities moved between brokerage accounts

Every pair below is an inference from date, security and quantity alone and moves the giver's cost to
the receiver, so each raises `securityTransferInferred` naming both brokerage accounts, letting the user
tell a transfer from an unrelated sale and gift.

KMyMoney has no transfer activity: a move is a RemoveShares in the source account and an AddShares in
the destination (R7.5). After all rows are mapped, the exported `pairShareTransfers` from
`backend/src/import/mny/map/map-investments.ts` pairs an ADD_SHARES with a REMOVE_SHARES of the same
date, security and quantity in a different account, turning them into TRANSFER_IN / TRANSFER_OUT linked
through `linkedInvestmentId`; the count is `transfersPaired`. The holdings fold
(`HoldingsService.computeHoldingsMap`) then carries the basis: the IN leg takes exactly what its paired
OUT leg relieved (financial-semantics section 6, A26-M22).

Example: Broker A bought 10 EXC for 505 (commission included). On 2024-06-01 Remove 10 from A, Add 10 to
B. Rows: TRANSFER_OUT 10 (A), TRANSFER_IN 10 (B), linked. Holdings: A 0, B 10 with total cost 505
(50.50 per share).

Unpaired (a transfer in from a broker outside the file, or a different date or quantity): the rows stay
ADD_SHARES / REMOVE_SHARES with no cost, exactly what KMyMoney records (value 0). Every unpaired
ADD_SHARES raises `sharesAddedWithoutCost`, because Monize then reports every later sale drawn on those
shares with an unknown gain, which the user should know before trusting a realised-gain report.

#### 5.7.5 Stock splits

SPLIT rows use `S.shares` as the ratio: `2/1` is a 2-for-1, `1/10` a 1-for-10 reverse split (KMyMoney's
balance multiplies by it, R15.2; its manual says "in a 3:2 split, enter 1.5"). Two known divergences,
each reported per split so a holdings difference arrives explained:

| Case | KMyMoney | Monize | Warning |
|---|---|---|---|
| ratio not exact at 8 places, 300 shares, ratio `1/3` | 100 | 300 x 0.33333333 = 99.99999900 | `stockSplitRatioRounded` (detail: ratio, stored ratio) |
| result not a multiple of the security's `saf`, 7 shares, ratio `3/2`, `saf` 1, rounding method 7 | round(10.5) to even = 10 | 10.5 | `stockSplitRoundingDiffers` (detail: KMyMoney's and Monize's count) |
| price history around the split suggests the inverse ratio | | | `stockSplitRatioSuspicious` (below) |

`stockSplitRatioSuspicious`: when the file holds a price for the security within 31 days before the
split and within 31 days after it, `observed = before / after`; the warning fires when
`|observed / ratio - 1| > 0.25` and `|observed * ratio - 1| <= 0.25` (the prices move as if the ratio
were inverted). The ratio is never changed; the user checks it (reference R19.1).

#### 5.7.6 Shapes that import as cash, and leftovers

- **Cash only** (`investmentImportedAsCash`): the security cannot be imported (5.8), the stock account
  has no investment parent, a BUY/SELL has zero shares, or a dividend's or reinvestment's total is
  negative. (A sale whose fees exceed its proceeds pays cash out, so it is 5.7.7's shape, not cash only.) The `A` split
  becomes an ordinary row in its account (amount `A.shares`, no category, description as 5.7.2) and the
  `F`/`I` splits are not imported. Account balances still reconcile; the holding does not exist.
- **Extra asset splits** `X` (`investmentExtraAssetSplit`): each becomes an ordinary row in its account,
  amount `X.shares`, no category, so that account still moves by what KMyMoney recorded.
- **Shares on an income action** (`investmentSharesOnIncomeAction`): a Dividend/Yield/IntIncome whose
  `S.shares` is not 0 also gets an ADD_SHARES / REMOVE_SHARES row for those shares.
- **Further stock splits** (`multipleStockSplits`): each becomes an ADD_SHARES / REMOVE_SHARES row in its
  own holding account, so share counts reconcile; cost basis does not move with them.

#### 5.7.7 Transactions that fit no investment activity

A transaction with a stock split is an investment activity only when KMyMoney itself classifies it as one,
and only when its cash moves the way that activity moves cash. Otherwise it is never coerced into a trade:

- **Unclassified:** no split on a stock account carries an action KMyMoney recognises (`Buy`, `Add`,
  `Split`, `Dividend`, `Yield`, `Reinvest`, `IntIncome`; `MyMoneyFile::isInvestmentTransaction` in
  `kmymoney/mymoney/mymoneyfile.cpp`, `MyMoneySplit::investmentTransactionType` returning
  `UnknownTransactionType`). KMyMoney then does not treat it as an investment transaction; only its
  editor's dissection defaults it to a buy, which the importer does not follow.
- **Cash against the activity:** a `BuyShares` whose asset split pays cash in (value > 0), or a
  `SellShares` whose asset split pays cash out (value < 0). Read as a trade, a paycheque that also buys
  shares would turn the salary into investment income, the taxes into commission and the net pay into a
  positive cash leg on a buy.

Such a transaction (`investmentTransactionUnclassified`, one per transaction, detail the stock split's
action, row the transaction) imports as:

1. **An ordinary split row** in the imported asset or liability account with the largest absolute value
   (5.6.2), its category and transfer legs exactly as 5.6.2 to 5.6.4 build them, so the account moves by
   its `shares` and each category by its own amount.
2. **One INVESTMENT leg per priced stock split** in that row, of the stock split's value through the
   parent's ratio (`-value * parent.shares / parent.value`), with `investmentHandle` the transaction.
3. **One investment row per stock split**: BUY for positive shares, SELL for negative, quantity `|shares|`,
   total `|value|` converted to the security's currency as 5.7.3 does (bounded rate, else unconverted and
   warned), commission 0, price derived from the total (INV-TRADE-001), no category, embedded in its leg
   (`transactionSplitId`, `cashAccountKey` the row's account, no funding account, no cash row of its own:
   `investmentWritesOwnCashRow` is false). A stock split with zero value becomes ADD_SHARES or
   REMOVE_SHARES with no cost and no leg.

When the transaction has no imported asset or liability split to hold the row, or a stock split cannot
become such a row (its holding cannot import, or it has a value without shares), the warning is still
raised and the transaction falls back to 5.7.2 and 5.7.6.

| KMyMoney transaction | Before | Now |
|---|---|---|
| Salary -5000, Taxes +1000, Checking +3500, stock `Buy` +10 shares / 500 | BUY total 1500, commission 1000, cash +3500, INTEREST 5000 | Checking +3500 with legs Salary +5000, Taxes -1000, INVESTMENT -500; BUY 10 at 500, commission 0, embedded |
| Brokerage +100, stock `Buy` +10 / 500, Salary -600 | BUY with cash +100, INTEREST 600 | Brokerage cash +100 with legs INVESTMENT -500, Salary +600; BUY 10 at 500 |
| Brokerage -3, stock `Buy` -1 / -2, Fees +5 | cash only, the share lost | Brokerage cash -3 with legs INVESTMENT +2, Fees -5; SELL 1 at 2 |
| Checking -500, stock action `Transfer` +10 / 500 | BUY 500 funded from Checking | Checking -500 with leg INVESTMENT -500; BUY 10 at 500 |
| Brokerage -505, stock `Buy` +10 / 500, Fees +5 | BUY 505, commission 5 | unchanged |

Balances, holdings, trade values (6.1) and category amounts all reconcile in each row
(`kmy-map-investment-shapes.spec.ts`).

#### 5.7.8 Same-day order

Every row an import writes shares `created_at` (one transaction), so the canonical replay
(`INVESTMENT_REPLAY_ORDER` in `backend/src/securities/investment-replay.util.ts`: date, `created_at`, id)
breaks a same-day tie on the row id, and a same-day stock split and buy fold to different positions in
the two orders (100 shares, a 2:1 split and a buy of 10: 210 or 220). The investment mapper therefore
reads the transactions in KMyMoney's journal order (post date, then transaction id as a string,
`MyMoneyTransaction::uniqueSortKey`; `journalOrder`) and gives each investment row a UUIDv7 from
`sortableRowIds` (`kmy-row-ids.ts`), which sorts in the order handed out. The canonical replay is then
KMyMoney's own order, with no second ordering scheme beside it, whatever the order of the file
(`kmy-import-order.integration.spec.ts`). The file-side replay (6.1) and the mapped replay before the
import use the same order.

#### 5.7.9 Worked example (the reference's section 18)

| KMyMoney | Monize row | Holding after (EXC in "Brokerage Account - Brokerage") |
|---|---|---|
| T8: Brokerage cash -505, Example Corp `Buy` +10 shares / 500 value, Bank Fees +5 | BUY qty 10, total 505, commission 5, price 50, cash -505 in "Brokerage Account - Cash" | 10, cost 505 |
| T9: cash +7.50, `Dividend` 0/0, Dividends -7.50 | DIVIDEND total 7.50, price 7.5, cash +7.50, category Dividends | 10, cost 505 |
| T10: `Split` shares 2 (one split) | SPLIT qty 2 | 20, cost 505 |
| T11: cash +145, `Buy` -5 shares / -150 value, Bank Fees +5 | SELL qty 5, total 145, commission 5, price 30, cash +145 | 15, cost 378.75 |

Cash side: transfer in 1000 - 505 + 7.50 + 145 = 647.50 USD, the reference's expected balance.

### 5.8 Securities

| KMyMoney | Monize | Rule |
|---|---|---|
| `SECURITY` referenced by an imported holding | security | others are not imported (counted); KMyMoney's `CURRENCIES` are never securities |
| `symbol` | `symbol` | trimmed; unique within the import by `-2` suffixes within 20 characters (`duplicateSecuritySymbol`); empty gets `placeholderSymbol(name)` with `skipPriceUpdates` (`generatedSecuritySymbol`); find-or-create by symbol (shared writer) |
| `name` | `name` | |
| `type` 0 / 1 / 2 / 4 | `securityType` STOCK / MUTUAL_FUND / BOND / null | |
| `trading-currency` | `currencyCode` | empty: the base currency, `unknownCurrency`; a CRYPTO code: the security is not imported (INV-CRYPTO-001), `securityNotImported`, its trades import as cash only |
| `saf`, `pp`, `rounding-method` | none | used by the file-computed holdings replay only (`saf` 0 means 100; method 0 means 7, R3.1) |
| KVPs `kmm-security-id`, `kmm-online-source`, `trading-market` | none | not imported |

### 5.9 Prices and exchange rates

`PRICEPAIR from=F to=T` with `PRICE date price` means one `F` is worth `price` `T` (R9). At most one per
pair and date; a later duplicate wins.

| Pair | Monize | Rule |
|---|---|---|
| security to its trading currency | `security_prices` (security, date, close) | only for imported securities; source `kmy_import`; the shared writer's `(security, date)` upsert (the file wins, as for Money) |
| security to another currency | none | `priceCurrencyMismatch` (count) |
| currency to currency, both used by an imported account or security or the base currency | `exchange_rates` | source `kmy_import`; the shared `writeExchangeRates`, which stores each pair in its one orientation through `canonicalRateRow` (INV-FX-003, guarded by `backend/src/currencies/exchange-rate-orientation.guard.spec.ts`) and inserts with `ON CONFLICT DO NOTHING` (INV-FX-004) |
| currency to currency otherwise (old files list about 185 currencies with fixed legacy rates) | none | `unusedCurrencyRatesSkipped` (count), so the import does not create currencies nobody uses |
| currency to security, unknown ids | none | KMyMoney's writer never writes them (R9) |

Orientation: the mapper emits `(from = F, to = T, rate = price)`; `canonicalRateRow` inverts it when
Monize stores the pair the other way round. Example: `EUR -> USD 11573/10000` becomes the stored row
`(EUR, USD, 1.1573000000)`, and `resolveFxRate` answers 1.1573 for EUR to USD and 0.8640802... for USD to
EUR. A `USD -> EUR` price on another date is stored as `(EUR, USD, 1/price)`.

### 5.10 Schedules

#### 5.10.1 Which schedules are offered

Every `SCHEDULED_TX` that is not finished (R11.3: `lastPayment` set and either occurrence Once, or an
end date passed). All offered schedules start ticked; an unticked one is not written (the shared rule).
Offered but not writable: a template with a split on a stock account (`investmentScheduleNotImported`),
no asset/liability split, or an unknown occurrence (`unusableBill`).

#### 5.10.2 Cadence (occurrence normalized per R11.2, then multiplier `m`)

`d` = the next due date; `CUSTOM` rules are canonical per `normalizeCustomRecurrence`
(`backend/src/common/custom-recurrence.ts`). "Approximate" means the frequency with the largest cycle not
longer than the true interval (so no occurrence is missed), `approximate` true and
`billFrequencyApproximated`, the Money convention.

| Base | `m` | Monize |
|---|---|---|
| Once (1) | any | ONCE |
| Daily (2) | 1 | DAILY |
| Daily | 7, 14, 28 | WEEKLY, BIWEEKLY, EVERY4WEEKS |
| Daily | other multiple of 7 up to 84 | CUSTOM `{unit: WEEK, interval: m/7, weekdays: [ISO weekday of d], weekStartsOn: 1}` |
| Daily | anything else (30 = EveryThirtyDays included) | approximate by days (30 gives EVERY4WEEKS) |
| Weekly (4) | 1, 2, 4 | WEEKLY, BIWEEKLY, EVERY4WEEKS |
| Weekly | 3, 5-12 (3 = EveryThreeWeeks, 8 = EveryEightWeeks) | CUSTOM `{WEEK, interval m, weekdays [ISO weekday of d], weekStartsOn 1}` |
| Weekly | over 12 | approximate |
| EveryHalfMonth (18) | 1 | SEMIMONTHLY |
| EveryHalfMonth | even | as Monthly with `m/2` |
| EveryHalfMonth | odd over 1 | approximate (SEMIMONTHLY) |
| Monthly (32) | 1, 2, 3, 4, 6, 12, 24 | MONTHLY, EVERY2MONTHS, QUARTERLY, EVERY4MONTHS, SEMIANNUAL, YEARLY, EVERY2YEARS |
| Monthly | 5, 7-11 | CUSTOM `{MONTH, interval m, monthDays [day of d]}` |
| Monthly | multiple of 12 from 36 to 144 | CUSTOM `{YEAR, interval m/12, dates [MM-DD of d]}` |
| Monthly | other over 12 | approximate |
| Monthly, `lastDayInMonth` 1 | `m` up to 12 | CUSTOM `{MONTH, interval m, monthDays [-1]}` |
| Yearly (16384) | 1, 2 | YEARLY, EVERY2YEARS |
| Yearly | 3-12 | CUSTOM `{YEAR, interval m, dates [MM-DD of d]}` |
| Yearly | over 12 | approximate (EVERY2YEARS) |
| 0 or unknown code | | not offered, `unusableBill` |

#### 5.10.3 Fields

| Field | Rule |
|---|---|
| `nextDueDate` | the template's `postdate`; with `lastDayInMonth`, the last day of that month; if empty or not after `lastPayment`, the first occurrence after `lastPayment` stepped from `startDate` by R11.4's rules (Monthly `addMonths(m)` then restore the start day where the month has it). Weekend adjustment is not applied (KMyMoney's processing days come from app settings, R11.3); a `weekendOption` other than MoveNothing raises `scheduleWeekendRuleDropped` (count). A next due date more than one cycle before `asOf` raises `scheduleOverdue`: KMyMoney shows it overdue, and so will Monize |
| `endDate` | `endDate`, null when empty |
| `accountKey`, `amount`, `currencyCode` | the first asset/liability split (R11.1); its `shares` |
| `isTransfer`, `transferAccountKey` | type 4 (Transfer) or any two-asset-split template: the second asset/liability split's account |
| `categoryHandle` | the other split of a two-split template |
| `splits` | templates of three or more splits: legs as 5.6.3 |
| `payeeHandle` | as 5.5 |
| `name` | `name` |
| `handle`, `seriesKey` | the schedule handle |
| `status` (raw, review diagnostics only) | the schedule `type` (1 Bill, 2 Deposit, 4 Transfer, 5 LoanPayment) |
| auto-enter, fixed/estimate, `paymentType`, recorded `PAYMENTS` | not imported; `autoEnter` 1 raises `scheduleAutoEnterNotImported` (count). Monize writes every imported schedule with `auto_post` false, so an overdue schedule never posts by itself the moment it lands |

Loan payments (type 5, or any template with an auto-calc split, R2.3 fix 9): the amortization and
interest amounts are computed by KMyMoney at entry time and are not in the file. The schedule becomes a
transfer of the payment account split's fixed amount to the loan account, with no legs
(`loanScheduleSimplified`). If the payment split is itself auto-calc, the amount is the loan account's
KVP `periodic-payment`; with neither, `unusableBill`.

Example (the reference's section 18): `SCH000001` "Electricity", Bill, Monthly x1, template postdate
2024-03-01, Checking -75 to Electricity, payee City Power: one offered bill, handle 1, MONTHLY, next due
2024-03-01, amount -75.0000, category Electricity; `scheduleWeekendRuleDropped` (MoveAfter) and, on any
`asOf` after 2024-04-01, `scheduleOverdue`.

### 5.11 Loans

KMyMoney stores loan terms as account KVPs (R5.9); Monize's model for an imported loan is
`MappedLoanTerms`, inferred from payments and bills. The shared `mapLoans` is called over the KMyMoney
model exactly as the Money parser calls it (accounts, transactions, selected bills), so loan payments
booked as a transfer leg plus an interest leg give the interest category, the SPLIT booking mode, the
source account and, from a selected loan schedule, the payment amount, frequency and start date. The
interest rate (`ir-YYYY-MM-DD`), original principal, term and final payment have no field in
`MappedLoanTerms`: `loanInterestRateNotImported` names the loan and its latest rate so the user enters it
(adding the field is a follow-up, section 13). The "Loan payout" transaction imports as an ordinary
transfer.

### 5.12 Warning catalogue

Every code is appended to `MNY_WARNING_CODES` unless marked "existing"; the seven `payeeMatching*`,
`payeeMatch*`, `payeeDefaultCategoryNotImported` and `payeeDetailsKept` codes of the payee amendment are
appended after `holdingsReplayDiffers`, in the order of this table, followed by `crossCurrencyTransferRateMissing` and then the codes of the review fixes in this order: `tradeAmountsDiffer`, `investmentTransactionUnclassified`, `sameAccountTransferUnlinked`, `reconciliationHistoryNotImported`, `securityTransferInferred`, `sharesRounded`. A warning carries no English;
the frontend renders `import.kmyWarnings.<code>` with the count (ICU plural). `row` is set when the
warning is about one transaction (the review step lists the rows). The en sentences below are the copy
WP4 writes; they avoid `--` (frontend rule).

| Code | Raised when | Row | User-facing sentence (en) |
|---|---|---|---|
| unknownAccountType (existing) | type 0, unknown, or unreachable | | {count} accounts have a type Monize does not recognize, or are not reachable from KMyMoney's account tree, and were skipped. |
| duplicateAccountName (existing) | name collision | | {count} accounts shared a name with another and were renamed. |
| unknownCurrency (existing) | empty trading currency, or an account currency not defined in the file | | {count} items named a currency the file does not define and use the base currency. |
| unsupportedCurrencyCode | currency id is not three letters | | {count} accounts use a currency code that is not three letters, which Monize cannot store, and were not imported. |
| unusableTransaction (existing) | no post date, or no asset or liability split | yes | {count} transactions had no usable date or did not touch any account, and were skipped. |
| singleSplitTransaction | one split, not investment | yes | {count} transactions have only one split (KMyMoney shows them uncategorized) and were imported without a category. |
| unbalancedTransaction | sum of values not 0 | yes | {count} transactions do not balance (KMyMoney marks them as erroneous); the difference was imported as an uncategorized split so the account balance stays as KMyMoney shows it. |
| duplicateTransactionId | same post date and id | yes | {count} transactions appeared twice in the file; as in KMyMoney, only the last copy was imported. |
| transferAcrossExcludedAccount (existing) | other side excluded | yes | {count} transfers pointed at an account you left out and were imported as ordinary transactions. |
| unknownPayeeReference | payee id not defined | yes | {count} transactions named a payee the file does not define and were imported without a payee. |
| equitySplitAsCategory | equity split outside an opening balance | yes | {count} transactions moved money to or from an equity account; each was imported with that equity account as a category. |
| accountHierarchyFlattened | asset/liability account under another | | {count} accounts were nested under other accounts in KMyMoney; Monize lists accounts side by side. |
| assetLoanAsAsset | type 14 | | {count} loans you made to others were imported as asset accounts. |
| currencyTradingAccount | type 11 | | {count} currency trading accounts were imported as asset accounts. |
| brokerageAccountNotFound | no cash account found for an investment account | | {count} investment accounts have no brokerage account in the file, so an empty cash account was created for each. Trades paid from other accounts still move those accounts. |
| brokerageCurrencyMismatch | name-matched cash account in another currency | | {count} brokerage accounts use a different currency from their investment account and were kept as separate accounts. |
| stockAccountWithoutInvestment | stock account with no investment ancestor | yes | {count} investment transactions belong to a holding outside any investment account and were imported for their cash only. |
| securityNotImported | crypto trading currency | | {count} securities are priced in a cryptocurrency, which Monize does not support for securities; their trades were imported for their cash only. |
| investmentImportedAsCash | 5.7.6 | yes | {count} investment transactions could not be imported as trades and were imported for their cash only. |
| investmentExtraAssetSplit | extra asset split | yes | {count} investment transactions also moved money in a further account; that movement was imported as its own transaction. |
| investmentSharesOnIncomeAction | dividend/interest with shares | yes | {count} dividend or interest transactions also changed the number of shares; the change was imported as added or removed shares. |
| multipleStockSplits | two stock splits in one transaction | yes | {count} investment transactions moved more than one security; the extra securities were imported as added or removed shares, without cost. |
| splitActionInMultiSplit | `Split` inside a multi-split | yes | {count} stock splits were recorded inside another transaction; as in KMyMoney, they were imported as added or removed shares. |
| tradeFundedFromEquity | `A` on equity | yes | {count} trades were paid from an equity account; the shares and their cost were imported, without a cash movement. |
| sharesAddedWithoutCost | unpaired ADD_SHARES | yes | {count} share additions have no cost in KMyMoney, so gains on selling those shares cannot be calculated. Edit them in Monize to add the cost if you know it. |
| stockSplitRatioRounded | ratio not exact at 8 places | yes | {count} stock split ratios have more decimal places than Monize stores; share counts after them may differ from KMyMoney by a tiny fraction. |
| stockSplitRoundingDiffers | KMyMoney rounded the result | yes | {count} stock splits left a fraction of a share that KMyMoney rounded away and Monize keeps. Check the holding against your statement. |
| stockSplitRatioSuspicious | price history disagrees | yes | {count} stock splits look inverted compared with the prices around them. Check the split ratio against your statement. |
| priceCurrencyMismatch | security price in another currency | | {count} prices were recorded in a currency other than the security's and were not imported. |
| unusedCurrencyRatesSkipped | rate for an unused currency | | {count} exchange rates are for currencies none of your accounts or securities use and were not imported. |
| crossCurrencyTransferRateMissing | 5.6.4, a transfer's receiving leg left with no rate | yes | {count} transfers between accounts in different currencies have no exchange rate, neither in their amounts nor in the file's prices, and were imported without one. Open the receiving side of each and enter the rate. |
| crossCurrencyTradeUnconverted (existing) | commodity not convertible | yes | {count} trades were recorded in a currency other than the security's and the file has no rate to convert them; their amounts were imported unconverted. Check the price of each. |
| duplicateSecuritySymbol (existing) | | | {count} securities share a symbol with another; the later ones were renamed so they stay separate. |
| generatedSecuritySymbol (existing) | | | {count} securities have no symbol in KMyMoney, so a placeholder was generated and price updates left off. |
| loanInterestRateNotImported | loan with `ir-` KVPs | | {count} loans have an interest rate in KMyMoney that was not imported. Enter it on the loan account in Monize. |
| loanInterestCategoryUnclear (existing) | from `mapLoans` | | as Money's copy, with KMyMoney named |
| loanScheduleSimplified | loan schedule | | {count} loan payment schedules split each payment into principal and interest when it is entered; they were imported as one transfer of the payment amount. |
| investmentScheduleNotImported | template on a stock account | | {count} scheduled investment transactions were not imported. |
| unusableBill (existing) | | | {count} schedules had no account, no usable date or an unrecognized recurrence, and were skipped. |
| billFrequencyApproximated (existing) | | | {count} schedules repeat at an interval Monize cannot express exactly, so the closest shorter one was used. |
| scheduleAutoEnterNotImported | `autoEnter` 1 | | {count} schedules are entered automatically in KMyMoney; in Monize they wait for you to post them. |
| scheduleWeekendRuleDropped | weekend option set | | {count} schedules move their due date off weekends in KMyMoney; Monize keeps the date as scheduled. |
| scheduleOverdue | next due over a cycle ago | | {count} schedules are overdue in KMyMoney and arrive overdue in Monize. Post or skip the missed occurrences. |
| costCentersNotImported | | | {count} splits have a cost center; Monize has no cost centers, so they were not imported. |
| budgetsNotImported | | | {count} budgets were not imported. Monize creates budgets from your history instead. |
| reportsNotImported | | | {count} saved reports were not imported. |
| onlineJobsNotImported | | | {count} online transfer orders were not imported. |
| onlineBankingNotImported | | | {count} accounts have online banking settings in KMyMoney; they were not read, and you can set up bank sync in Monize. |
| accountNumbersNotImported | | | {count} accounts have an account number or IBAN, which was not imported. |
| payeeDetailsNotImported | 5.5, 5.5.3 | | {count} payees have details Monize has no place for (a reference number, bank account identifiers, a link pattern), or contact details Monize could not read; those details were not imported. |
| payeeMatchingDisabled | 5.5.1, Disabled | | {count} payees have matching turned off in KMyMoney. Monize has no such setting: a later import or bank sync whose payee is exactly one of these names still links to it. |
| payeeMatchKeyNotImported | 5.5.1, outside the subset or checks 1 to 6 | | {count} payee matching rules use a pattern Monize cannot reproduce exactly and were not imported. Add an alias to the payee in Monize if you still want one. |
| payeeMatchCaseWidened | 5.5.1, check 8 | | {count} payee matching rules are case-sensitive in KMyMoney. Monize aliases ignore case, so these also match the same name in other capitals. |
| payeeMatchKeyConflict | 5.5.1 collisions; also post-import (5.5.4) | | {count} payee matching rules clash with an alias or the name of another payee, which Monize does not allow, and were not imported. |
| payeeMatchKeyOverlap | 5.5.1 collisions; also post-import (5.5.4) | | {count} payee aliases can match the same payee name as an alias of another payee. KMyMoney picks the payee with the longer match; Monize may pick either. Check these aliases in Monize. |
| payeeDefaultCategoryNotImported | 5.5.2 | | {count} payees have a default category Monize cannot use (an account rather than a category, one missing from the file, or a different one from another payee of the same name), so they were imported without it. |
| payeeDetailsKept (post-import) | 5.5.4 | | {count} payees already existed in Monize with their own default category or contact details, which were kept; the KMyMoney values were not used. |
| unparsableNumber | reader | | {count} numbers in the file could not be read and were taken as zero. |
| autoCalcInPostedSplit | reader | yes | {count} posted transactions carried a placeholder amount meant only for schedules; it was taken as zero. |
| mappedBalanceDiffers | 6.3, preview time | | {count} accounts would end with a balance that differs from the one computed from the file. Do not import until this is explained. |
| holdingsReplayDiffers | 6.3, preview time | | {count} holdings would end with a share count that differs from the one computed from the file. |
| investmentTransactionUnclassified | 5.7.7 | yes | {count, plural, one {# transaction with a share movement fits} other {# transactions with a share movement fit}} no investment activity. {count, plural, one {Its cash and categories were} other {Their cash and categories were}} imported as a split transaction and the shares as a purchase or sale at the value the file records. Check each.|
| sameAccountTransferUnlinked | 5.6.2/5.6.4, two splits of one transaction on one Monize account | yes | {count, plural, one {# transaction moves} other {# transactions move}} money from an account to itself. Each side was imported as its own entry rather than as a transfer. |
| reconciliationHistoryNotImported | 5.2, an account with `lastreconciled` or reconciliation history (detail: the latest statement date) | | {count, plural, one {# account has} other {# accounts have}} a reconciliation history in KMyMoney. Each entry keeps its reconciled state and date, but the statement dates and balances were not imported. |
| securityTransferInferred | 5.7.4, every paired removal and addition (detail: the two brokerage accounts) | yes | {count, plural, one {# removal and addition of the same shares on the same day was} other {# removals and additions of the same shares on the same day were}} imported as a transfer between brokerage accounts, carrying the cost. Check that each was a transfer and not a sale and a gift. |
| sharesRounded | 5.7.2, a share count finer than 8 places (detail: the file's figure) | yes | {count, plural, one {# share count has} other {# share counts have}} more than eight decimal places and {count, plural, one {was} other {were}} rounded to eight. |
| tradeAmountsDiffer | 6.1, preview time, one per (holding, transaction); detail `transaction N: file X, mapped Y CUR` | | {count, plural, one {# trade was} other {# trades were}} mapped with a total and commission that do not add up to the share value the file records. Do not import until this is explained. |
| balanceMismatch (existing, post-import) | | | {count} accounts ended with a balance that differs from the one computed from the KMyMoney file. |
| holdingsMismatch (existing, post-import) | | | {count} holdings do not match the shares computed from your KMyMoney file. |

## 6. Verification

### 6.1 Expectations computed from the raw file

Computed by `kmy-file-expectations.ts` from the **raw model** (after KMyMoney's own level-0 repair,
5.1) and the account and security identity only (which Monize account a KMyMoney account becomes, its
currency, which holding a stock account is), never from mapped rows and never through the mapper's
amount logic: no `sharesOf`, no sign helper, no split classification, no opening-balance fold, no row
builder. `kmy-file-expectations.guard.spec.ts` holds its imports to that list. The point is that a
defect in the mapper's amount logic makes the two sides differ instead of agreeing by construction (the
review's mutations -- a split's value booked instead of its shares, every amount negated, twice the
commission taken off each trade -- are each caught: `kmy-file-summary.spec.ts`).

- **Account balance**, per mapped account key `K`, at `K`'s currency places (`moneyDecimalsFor`: 4 for a
  fiat, the coin's own up to 8): the sum of the raw `shares` of every split, in every transaction with a
  valid post date on or before `asOf` (the same `asOf` the mapper and post-processing use, pinned by the
  preview and in the job, 6.4), on every KMyMoney account that maps to `K`: the account itself; for a pair's cash key,
  the brokerage account and the type-7 account; for a brokerage key, nothing (expected 0). Template
  (schedule) transactions are not in `TRANSACTIONS`, so they are not summed. This is KMyMoney's own
  balance (`AccountBalances::operator+=`, R15.2), including its opening balance transactions. Two figures
  come out of it: `fileBalances`, the exact sum rounded once (what KMyMoney shows), and `rowBalances`,
  each split rounded at the places first and then summed (what one row per split adds up to exactly, the
  figure a correct mapping reproduces). Their difference is the exact rounding allowance
  (`balancePrecision.tolerance`; 0 whenever every amount is already at the column's places).
- **Holding**, per (brokerage key, security handle): KMyMoney's replay over the stock accounts under the
  pair's type-7 account whose currency is that security, ordered by (post date, transaction id as a
  string), then split order: a transaction of exactly one split with action `Split` multiplies the
  running balance by `shares` and rounds the product to the security's `saf` with its rounding method
  (RoundNever read as RoundRound, R3.1; the rounding methods are ported from AlkValue's
  `convertDenominator` exactly); any other split adds `shares`. Cut off at `asOf`, as
  `HoldingsService.rebuildAccountsFromTransactions` cuts off at today.
- **Amount invested per trade**, per (holding, transaction): the signed sum of the stock splits' `value`
  for every action except `Add` and `Split` (buys and reinvestments positive, sales negative), in the
  security's currency at its places, for transactions whose commodity is the security's trading
  currency. The mapped side is each BUY or REINVEST row's `totalAmount - commission` and each SELL row's
  `-(totalAmount + commission)` for the same transaction; they must agree within one minor unit per stock
  split (`totalAmount` and `commission` are each rounded once). Compared per transaction, because a net
  over the holding lets an error on a buy cancel one on a sale. Differences raise `tradeAmountsDiffer`.
- **What is not verified: cost basis.** A KMyMoney file stores no cost basis to compare with. The amount
  invested above is not Monize's cost basis and is never compared with it: a sale removes basis at average
  cost, not at its proceeds; a stock split and an added-shares row change the basis without a value; a
  trade converted at the file's rate (5.7.3) has its value in another currency. So the check proves the
  trade rows' totals and commissions are what the file recorded, and the canonical holdings rebuild is
  what turns them into a basis; neither the review step nor the report claims the basis itself is
  verified.

### 6.4 The date the file's figures are for

`asOf` is `todayYMD()` (`backend/src/common/date-utils.ts`) when the parse runs, the same function
post-processing cuts `current_balance` off with, so in the job the file's figures and the database's
are computed for one day. The preview's figures are for the day of the upload and the report's for the
day the import ran; both carry their date (`kmyFile.asOf` in the preview, `fileAsOf` in the result) so
a difference between them, which only rows dated between the two days can cause, is labelled rather
than silent. The preview's date is deliberately not reused by the job: post-processing computes the
balances the report compares as of the commit's day, so a pinned earlier date would report every row
dated after it as a discrepancy.

### 6.2 How they feed the existing report shape

| Field | Money | KMyMoney |
|---|---|---|
| `MnyParsedFile.expectedBalances` | mapper sums | mapper sums (`computeExpectedBalances` at each account's own places through its optional `placesByKey`): still what `writeAccountBalances` writes |
| `MnyParsedFile.balancePrecision` | absent | per account: its places and the exact rounding allowance of 6.1 |
| `MnyParsedFile.moneyPlaces` | absent | per currency: the places the writers round amounts at (a coin keeps 8) |
| `MnyParsedFile.fileBalances` | absent | 6.1 account balances |
| `MnyAccountVerification.expectedBalance` | `expectedBalances` | `fileBalances` |
| `MnyAccountVerification.mappedBalance` | absent | `expectedBalances` |
| `MnyHoldingCheck.lotQuantity` | open `LOT` quantity | 6.1 holding |
| `MnyHoldingCheck.replayQuantity` | replay of mapped rows | replay of mapped rows (`applyActionToQuantity`) |
| `MnyHoldingVerification.importedQuantity` | `holdings.quantity` | `holdings.quantity` |
| preview `finalBalance` | `expectedBalances` | `fileBalances` |

Money compares within the shared `BALANCE_TOLERANCE` (0.005) at four places. KMyMoney compares a balance at the account's own places (a coin's eighth, a fiat's fourth), within exactly the rounding allowance of 6.1, and before the import the mapped rows are held to `rowBalances` with no tolerance at all. Holdings use `QUANTITY_TOLERANCE` (1e-8) for both.

### 6.3 Explaining a difference

Three readings localise a defect: file versus mapped is a mapping problem, mapped versus imported a
write or post-processing problem. The mapper compares file and mapped before the import starts and
raises `mappedBalanceDiffers` / `holdingsReplayDiffers` / `tradeAmountsDiffer` in the preview, so the user sees it in the
review step; the report shows the mapped figure under the file figure for any row where the two differ.
Every difference the design knowingly leaves has a warning that names it:

| Difference | Explained by |
|---|---|
| share count after a reverse split with a non-terminating ratio | `stockSplitRatioRounded` |
| fraction KMyMoney rounded away after a split | `stockSplitRoundingDiffers` |
| holding missing because the security could not import | `securityNotImported`, `investmentImportedAsCash` |
| holding off by a multi-security transaction's cost basis (count matches) | `multipleStockSplits` |
| amounts with more places than the account's currency keeps | none needed: `rowBalances` is held exactly and the report allows exactly the rounding (6.1) |

Balances need no row in this table: every mapping rule in section 5 preserves each imported account's
sum of `shares` exactly (each split either is a row's or counterpart's amount, folds into the opening
balance, is a cash leg of exactly its `shares`, or is a leg inside a row whose amount is the parent's
`shares`). A non-zero balance difference is therefore always a defect, which is what makes the check
worth having.

Payee aliases, default categories and contact details move no balance and no share, so they are outside
both checks. The report counts what was written (`payeeAliasesCreated`, `payeeDefaultCategoriesSet`,
`payeeContactDetailsSet`) and lists the writer's commit-time refusals among its warnings
(`payeeMatchKeyConflict`, `payeeMatchKeyOverlap`, `payeeDetailsKept`), which the review step cannot show
because only the commit sees the user's existing aliases after the optional wipe.

## 7. Wizard UX

| Step / panel (Money) | KMyMoney | Detail |
|---|---|---|
| Upload accept list `.qif,.qmtf,.ofx,.qfx,.csv,.mny` | change | adds `.kmy,.xml`; the four format strings in every locale name "KMyMoney (.kmy, .xml)" (forced by `frontend/src/i18n/messages.import-formats.test.ts`) |
| File routing (`detectFileType`) | change | extension `kmy` or `xml` routes to the KMyMoney path before anything reads the file; the backend decides by content (4.3) |
| One file at a time toast | keep, new key | `toasts.kmySingleFileOnly` |
| Upload error panel | change | heading `upload.kmyFailedHeading`, docs link `importKmyTroubleshooting` |
| Password dialog | remove | never opens: no KMyMoney code asks for a password |
| Review heading and file summary | change | "Review your KMyMoney file"; summary names the file, "KMyMoney file, format version N", the base currency, and says the balances are computed from the file. No era |
| "What this version could not supply" (missing tables) | remove | always empty for KMyMoney |
| Counts tiles | keep, one more | the tags tile reads "Tags"; the bills tile reads "Scheduled transactions, active of N schedules"; a "Payee aliases" tile (value `payeeAliasesToCreate`, detail "N payees get a default category"), shown when either count is above zero, in the same `SummaryTile` form as the others. The rules that were not translated appear in Notes, like every other warning; no new section |
| Accounts table | keep | "named X in KMyMoney" when renamed; the pair shows as two rows, as for Money |
| Bills panel | keep, copy | heading "Scheduled transactions to create", KMyMoney explainer; the unsupported note never shows |
| Options card (six toggles) | keep | KMyMoney hints for unused payees and categories (KMyMoney seeds its category tree from a template), price history and start fresh |
| Wipe confirmation dialog | keep | neutral copy |
| Notes (warnings panel) | keep | `kmyWarnings.*`, "Review in KMyMoney" footer; out-of-scope items (budgets, reports, ...) appear here as warnings |
| Progress | keep | heading "Importing your KMyMoney file"; same phases ("Scheduled bills" phase label reused) |
| Verification report | keep, copy | "From KMyMoney file", "Shares in KMyMoney", holdings explainer saying the figures are KMyMoney's own balance computation; a secondary "import rows sum to X" line under the expected figure when `mappedBalance` differs; download name strips `.kmy` / `.xml`; "Payee aliases" and "Default categories" count tiles when `payeeAliasesCreated` / `payeeDefaultCategoriesSet` are above zero, like the conditional tag and securities tiles |

**Parameterisation.** A format descriptor (a frontend lib module) per format, `mny` and `kmy`, holding:
the API client, the copy keys for every slot above, the warning and error key resolvers (KMyMoney:
`kmyWarnings.<code>` for every code KMyMoney emits; `kmyErrors.<code>` for `kmy*` codes and for
`mnyStagedFileMissing`, `mnyErrors.<code>` otherwise), the error docs link resolver and the report file
extension pattern. `MnyReviewStep`, `MnyBillsPanel`, `MnyWarningsPanel`, `MnyImportProgress`,
`MnyVerificationReport` and `UploadStep` take an optional `format` prop defaulting to the Money
descriptor; `useMnyImport` takes an optional client defaulting to `mnyImportApi`. `useImportWizard`
holds one hook per format and an active-format state, and exposes the active one as `binary` with
`binaryFormat`; the steps `mnyReview` / `mnyImporting` serve both. No component is copied. Thin sibling
wrappers were rejected: they would duplicate about 2,000 lines of components and their tests.

## 8. API contract

All routes under `/api/v1`, class guard `AuthGuard("jwt")`, `@AllowPat()` on the class, `@NoPat()` on
`start`, exactly as `MnyImportController`.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `POST /import/kmy/parse` | multipart: one `file` part (memory storage, `limits.fileSize` = `MNY_IMPORT_LIMIT_BYTES`, `files: 1`); no other field is read | 201 `KmyPreview` | 400 `{ message, errorCode }`: `kmyNoFile` (no or empty part) and every `KmyErrorCode`; 413 `{ message, errorCode: "kmyFileTooLarge" }` |
| `POST /import/kmy/start` | JSON `StartMnyImportDto` (unchanged class: `stagedFileId`, `options?: MnyImportOptionsDto`, `wipePassword?`, `wipeOidcIdToken?`) | 201 `MnyImportJobDto` | 404 `kmyStagedFileMissing` (gone, another user's, or a Money staged file); 409 `mnyImportAlreadyRunning`, `mnyAlreadyImported`, `errors.maintenance.inProgress`; 400 validation |
| `GET /import/kmy/jobs/:id` | `ParseUUIDPipe` | 200 `MnyImportJobDto` | 404 `mnyJobNotFound` (also a job whose `source_format` is not `kmy`) |
| `DELETE /import/kmy/staged/:id` | `ParseUUIDPipe` | 204 | 404 `kmyStagedFileMissing` (also a non-`kmy` staged file); 409 `kmyStagedFileInUse` |

Frontend: `frontend/src/app/api/v1/import/kmy/parse/` gets a `route.ts` that is the Money one verbatim
(`forwardLargeUpload`); `LARGE_UPLOAD_ROUTES` in `frontend/src/lib/proxy-body-limit.ts` gains
`/^\/api\/v1\/import\/kmy\/parse\/?$/` with `mnyImportLimitBytes()`; both matcher alternations in
`frontend/src/proxy.ts` become `import/(?:mny|kmy)/parse`. Only `parse` is a large-upload route. Client
timeouts as Money: parse 300 s, start 120 s, poll 10 s; poll every 1.5 s; `getJob` clears all caches on a
terminal status.

### 8.1 Shapes

```ts
// backend, new shared model file next to mny-import-model (types and one token; no logic)
export type ImportSourceFormat = "mny" | "kmy";

export interface KmyFileSummary {
  readonly container: "gzip" | "xml";
  /** Decoded FIXVERSION (R2.3); 12 is current. */
  readonly fixVersion: number;
  /** FILEINFO/APPVERSION id, e.g. "5.2.70-94cd76bbb"; null when absent. */
  readonly appVersion: string | null;
  /** FILEINFO/LAST_MODIFIED_DATE as written; null when absent. */
  readonly lastModified: string | null;
}

export interface ImportSourceParseInput {
  readonly userId: string;
  /** Staged or uploaded bytes, as they arrived. Not mutated. */
  readonly buffer: Buffer;
  /** Original filename; the anonymized-file test reads its suffix. */
  readonly filename: string;
  readonly options?: Partial<MnyImportOptions>;
  /** When absent the parser reads the user's preference itself. */
  readonly userDefaultCurrency?: string;
  /** YYYY-MM-DD; default today (todayIsoDate). */
  readonly asOf?: string;
}

export interface ImportSourceParser {
  readonly sourceFormat: Exclude<ImportSourceFormat, "mny">;
  /** @throws MnyImportError subclasses (KmyImportError) for every unreadable file. */
  parse(input: ImportSourceParseInput): Promise<MnyParsedFile>;
}

export const KMY_SOURCE_PARSER = Symbol("KMY_SOURCE_PARSER");
```

```ts
// backend kmy errors
export type KmyErrorCode =
  | "kmyNotAKmyMoneyFile"
  | "kmyEncryptedFile"
  | "kmySqliteDatabase"
  | "kmyAnonymizedFile"
  | "kmyLegacyBinaryFile"
  | "kmyCorruptFile"
  | "kmyXmlTooLarge"
  | "kmyTooManyRecords"
  | "kmyMappingFailed";

export class KmyImportError extends MnyImportError<KmyErrorCode> {}
// one subclass per code: KmyNotAKmyMoneyFileError, KmyEncryptedFileError, KmySqliteDatabaseError,
// KmyAnonymizedFileError, KmyLegacyBinaryFileError, KmyCorruptFileError(detail), KmyXmlTooLargeError(limitMb)
```

```ts
// preview: the shared MnyPreview with two optional fields; a Money preview never has them
export interface MnyPreview {
  // ... every existing field unchanged ...
  readonly sourceFormat?: "kmy";
  readonly kmyFile?: KmyFileSummary;
}
// For KMyMoney: era "unknown", passwordProtected false, missingTables [], missingFields [].
// accounts[].handle / bills[].handle are KMyMoney ordinals (4.6). finalBalance is the file balance.
export type KmyPreview = MnyPreview & { readonly sourceFormat: "kmy"; readonly kmyFile: KmyFileSummary };

// result: one optional field
export interface MnyAccountVerification {
  // ... accountName, accountType, accountId, expectedBalance, importedBalance, delta,
  //     transactionCount, matches (unchanged) ...
  /** KMyMoney only: what the import's own rows sum to; expectedBalance is then the file's figure. */
  readonly mappedBalance?: number;
}
```

```ts
// frontend client (new lib module beside import-mny): the same interface as mnyImportApi
export interface BinaryImportClient {
  parse(file: File, password?: string): Promise<MnyPreview>; // kmy ignores password
  start(stagedFileId: string, options?: MnyImportOptionsInput,
        wipeCredentials?: { password?: string; oidcIdToken?: string }): Promise<MnyImportJob>;
  getJob(jobId: string): Promise<MnyImportJob>;
  discardStagedFile(stagedFileId: string): Promise<void>;
}
export const kmyImportApi: BinaryImportClient; // URLs /import/kmy/parse|start|jobs/:id|staged/:id
```

```ts
// payee amendment (section 5.5; WP3c). Shared model, all optional: a Money payee never carries them.
export interface MappedPayeeContact {
  readonly notes: string | null;   // sanitized, at most 500 characters
  readonly email: string | null;   // passes isEmail, at most 255
  readonly phone: string | null;   // normalizePhoneNumber's stored form
  readonly address: string | null; // 5.5.3 parts joined with ", ", sanitized, at most 500
}
export interface MappedPayee {
  readonly handle: number;
  readonly name: string;
  /** Monize alias globs, translated and collision-checked within the file (5.5.1). Absent: none. */
  readonly aliases?: readonly string[];
  /** Handle in MappedCategories.byHandle of the default category (5.5.2). Absent or null: none. */
  readonly defaultCategoryHandle?: number | null;
  /** Absent: none. */
  readonly contact?: MappedPayeeContact;
}
// MnyPreviewCounts: set only for a KMyMoney preview
  readonly payeeAliasesToCreate?: number;
  readonly payeeDefaultCategoriesToSet?: number;
// MnyImportResult: set only when the parsed file is a KMyMoney one
  readonly payeeAliasesCreated?: number;
  readonly payeeDefaultCategoriesSet?: number;
  readonly payeeContactDetailsSet?: number;

// raw model: KmyPayee loses hasDetails and gains
  readonly match: { readonly kind: "disabled" | "name" | "nameExact" | "key";
                    readonly ignoreCase: boolean;
                    readonly keys: readonly string[] };   // "key" only; split, empty and all-space keys dropped, not trimmed
  readonly defaultAccountId: string | null;
  readonly notes: string; readonly email: string; readonly reference: string;
  readonly address: { readonly street: string; readonly city: string; readonly state: string;
                      readonly postcode: string; readonly telephone: string };  // legacy fallbacks applied (R2.4)
  readonly hasIdentifiers: boolean;   // any payeeIdentifier child
  readonly hasLinkPattern: boolean;   // non-empty idpattern or urltemplate
// KmyMapInput gains
  readonly phoneRegion: CountryCode | null; // phoneRegionFromPreferences, read by the parser service

// pure, next to matchesAliasPattern
export function aliasesConflict(a: string, b: string): boolean;   // createAlias's refusal, either direction
export function aliasesCanOverlap(a: string, b: string): boolean; // some text matches both (5.5.1)

// shared writer
export interface WrittenPayeeExtras {
  readonly aliasesCreated: number;
  readonly defaultCategoriesSet: number;
  readonly contactDetailsSet: number;          // payees that received at least one contact field
  readonly warnings: readonly MnyWarning[];    // post-import: conflict, overlap, kept
}
export function writePayeeExtras(manager: EntityManager, userId: string, input: {
  readonly payees: readonly MappedPayee[];
  readonly payeeIdByName: ReadonlyMap<string, string>;      // WrittenPayees.idByName
  readonly categoryIdByHandle: ReadonlyMap<number, string>;
}): Promise<WrittenPayeeExtras>;
```

The frontend mirrors the three optional fields in `frontend/src/lib/import-mny.ts`
(`MnyPreview.sourceFormat?`, `MnyPreview.kmyFile?`, `MnyAccountVerification.mappedBalance?`), and the
payee amendment's two preview counts and three result counts.

### 8.2 Error messages (backend `errors.import.*`, en)

| Key | Message |
|---|---|
| kmyNoFile | No KMyMoney file was uploaded. |
| kmyFileTooLarge | That KMyMoney file is larger than the {{ limit }} MB import limit. |
| kmyXmlTooLarge | That KMyMoney file is larger than the {{ limit }} MB import limit once uncompressed. |
| kmyTooManyRecords | That KMyMoney file holds more records than Monize imports from one file. |
| kmyMappingFailed | Monize could not convert this KMyMoney file. This is a fault in Monize, not in your file, and nothing was saved. Please report it. |
| kmyNotAKmyMoneyFile | That file is not a KMyMoney file. Choose the .kmy or .xml file KMyMoney saves. If your KMyMoney data is in an SQL database, open it in KMyMoney and use File, Save As to save it as a .kmy file first. |
| kmyEncryptedFile | That KMyMoney file is encrypted with GPG, which Monize cannot open. In KMyMoney, turn off encryption (Settings, Configure KMyMoney, Encryption) and save the file again, or decrypt a copy with gpg --decrypt, then import that. |
| kmySqliteDatabase | That is a KMyMoney SQL database. Open it in KMyMoney, choose File, Save As, pick the KMyMoney (.kmy) format, and import the saved file. |
| kmyAnonymizedFile | That is an anonymized KMyMoney file: KMyMoney scrambles every amount and replaces the names when it writes one, so it cannot be imported. Import your original .kmy file instead. |
| kmyLegacyBinaryFile | That file uses the binary format of KMyMoney 0.8 or earlier. Open it in a current KMyMoney and save it again, then import the result. |
| kmyCorruptFile | That KMyMoney file is damaged or incomplete and could not be read. If it was copied or downloaded, try the original file again. |
| kmyStagedFileMissing | The uploaded KMyMoney file is no longer available. Please upload it again. |
| kmyStagedFileInUse | This KMyMoney file is being imported. Wait for the import to finish before discarding it. |
| kmyExistingAccountClosed | The existing account "{{ name }}" is closed, so the KMyMoney file cannot be merged into it. Reopen it or rename it, then import again. |
| kmyExistingAccountCurrency | The existing account "{{ name }}" uses {{ existing }}, but the KMyMoney file account uses {{ file }}. Rename one of them, then import again. |

Reused unchanged (format-neutral): `mnyJobNotFound`, `mnyImportAlreadyRunning`, `mnyAlreadyImported`,
`errors.maintenance.inProgress`.

## 9. Missing-data policy

| Situation | Answer | Why |
|---|---|---|
| no base currency in the file | the user's preference, read by the parser service at both parses | a literal would differ between users; reading it once per parse keeps preview and job equal |
| account with no opening-balance transaction | `openingBalance` 0 | an empty account holds zero |
| trade with no cash split | no cash row | nothing moved |
| price absent on a trade | derived from the total | INV-TRADE-001 |
| ADD_SHARES cost | none (price null, total 0) | KMyMoney recorded none; Monize reports gains drawn on them as unknown, never as free shares |
| exchange rate a transfer implies | stored on the receiving leg | a rate the file holds is not looked up |
| a cross-currency transfer whose amounts imply no rate and whose pair the file does not price within `FX_MAX_RATE_AGE_DAYS` before its date | null on the receiving leg, `crossCurrencyTransferRateMissing` | never 1 (FIN-002); the receiving leg is where Monize stores a transfer's rate (5.6.4), so the user enters it there |
| rate needed for a trade in a commodity other than the trading currency | the file's own price for the pair through `resolveFxRate` (on or before the date, at most `FX_MAX_RATE_AGE_DAYS` old), else unconverted with a warning | never 1, never a silent relabel (FIN-002) |
| security price history before the first trade | imported | it is the user's file |
| exchange rate for an unused currency | not imported | it would create currencies nobody uses |
| a schedule's next due date in the past | kept | it is what KMyMoney shows |
| reconcile date empty | null | never reconciled |
| entry date | not imported | Monize has no field; KMyMoney substitutes today for an empty one, which is not data |
| a payee's default "category" is an account, or an id the file does not define | none, `payeeDefaultCategoryNotImported` | a Monize default category is a category |
| a payee phone number without a country code, and no region in the user's preferences | not imported, `payeeDetailsNotImported` | a guessed region stores a plausible wrong number (`backend/src/common/phone-number.util.ts`) |
| an existing Monize payee already has a default category or a contact field | kept, `payeeDetailsKept` | it is the user's own data; the import only fills what is empty |
| a matching key Monize cannot express exactly | not imported, named in `payeeMatchKeyNotImported` | an alias that matches differently would assign later rows to the wrong payee without anyone noticing |

## 10. Invariants touched

INV-IMPORT-001 (one active job per user, shared across formats; its wording widens from "MNY import" to
"MNY or KMY import"), INV-IMPORT-002 (a retry never double-imports: unchanged mechanism), INV-IMPORT-003
(category collision: shared writer), INV-FX-003 and INV-FX-004 (rate orientation and additive insert:
shared writer), INV-FX-002 (a transfer's own rate), INV-TRADE-001, INV-CRYPTO-001 (5.2.1, 5.8),
INV-HOLDING-001 (holdings only from the canonical rebuild), FIN-003 (SPLIT multiplies).

## 11. Test matrix

| Layer | Spec | Data | Asserts |
|---|---|---|---|
| rationals | kmy-rational spec | literal strings | parse forms of 4.5; canonical form; add/sub/mul/div; every AlkValue rounding method on positive, negative, tie and non-tie inputs (table-driven from AlkValue's own test cases); `toDecimalString` at 0, 4, 8, 10 places; the auto-calc sentinel both signs; numerators above 2^53 |
| container | reader container spec | bytes built in the spec | every row of 4.3, including BOM, SQLite header, PGP armour and binary packet bytes, legacy binary, gzip bomb over the bound, corrupt gzip, template DOCTYPE |
| filter | reader filter spec | byte arrays | every row of the 4.4 truth table; a sequence spanning the 64 KB decode slice boundary |
| tokenizer and raw model | reader spec | XML from the builders, plus both committed synthetic files | every element path, defaults of R2.4 legacy forms (`count=`, `FIXVERSION date=""`, missing `price`), REPORT/BUDGET elements not read as accounts or payees, ONLINEBANKING never stored, matched-transaction KVP counted not parsed, malformed nesting, depth limit, unknown account reference, sign mismatch, duplicate (postdate, id), ordinals counted before filtering |
| accounts | map-accounts spec | raw builders | every type of 5.2.1; CRYPTO; unsupported code; closed; institution; credit limit; favourite; pair detection by KVP, by each of three suffixes (English, German, Japanese-empty falls through), by none, currency mismatch, one cash account claimed twice; selection by the investment handle |
| opening balances | map-opening-balances spec | raw builders | every row of the 5.3 example table |
| categories | map-categories spec | raw builders | three levels; income and expense; equity as category; referenced-only keeps ancestors; a name with `:` |
| transactions | map-transactions spec | raw builders | every row of 5.6.1 and 5.6.7; parent tie-break; cross-currency example 5.6.4 (exact rate); leg conversion and residual; unbalanced; excluded accounts; status and reconcile date per row; payee fallback; tags per shape |
| investments | map-investments spec | raw builders | every row of 5.7.2 and 5.7.3; the cross-currency trade example; INTEREST companions; cash-only shapes; transfer pairing and unpaired; split ratio; splits inside multi-split; the 5.7.9 walk; the 5.7.7 shapes that fit no activity (map-investment-shapes spec) |
| stock-split checks | map-stock-splits spec | raw builders | the three rows of 5.7.5 |
| securities and prices | map-securities / map-prices specs | raw builders | symbols, types, crypto skip, price filter, rate filter, orientation of both directions |
| schedules | map-schedules spec | raw builders | every row of 5.10.2; next-due recomputation (31 Jan, 28/29 Feb, 31 Mar); loan schedule; auto-calc payment; finished; overdue |
| file expectations | file-expectations spec | raw builders | balances of the reference's section 18 (Checking 2804.50, EUR Savings 1000.00, cash 647.50, holding 15); split rounding per method; cut-off at `asOf` |
| whole mapping | map-kmy-file spec | the committed synthetic XML | the full section 5.7.9 and 5.10.3 outcome, the warning set, every `fileBalances` equal to `expectedBalances` |
| shared generalisation | the existing specs of each file in 4.9, plus one new case each | | Money behaviour unchanged (existing cases green, untouched); each optional field honoured when set |
| payee matching (amendment) | kmy payee-match spec | literal keys and raw builders | every row of the 5.5.1 truth table and check table, every row of 5.5.5; the `;` legacy split, a single key with its trailing line feed, all-space keys, `.*?`, `\ ` and `\é` escapes, an escaped `$` against an anchor, `^` or `$` in the middle, a key that does not compile; `matchingenabled="true"` read as 0 |
| alias overlap (amendment) | alias-overlap util spec | pattern pairs | `aliasesConflict` agrees with `createAlias` on the pairs `payees.service.spec.ts` uses; `aliasesCanOverlap` for two literals, a literal and a glob, compatible and incompatible prefixes and suffixes, the 5.5.5 pairs; equal to a brute force over every text up to 12 characters on the alphabet {a, b} for every glob up to 6 characters over {a, b, *} |
| payees mapping (amendment) | kmy map-payees spec | raw builders | modes, the disabled warning, collisions in handle order, overlaps, same-name payees merged, referenced-only drops a rule, default category of each kind of 5.5.2, every contact row of 5.5.3 (each bound, an invalid email, a phone with and without a region, legacy address attributes) |
| payee extras writer (amendment) | write-payee-extras spec | mocked manager | a payee list with no new field issues no query; fill-only-empty and `payeeDetailsKept`; a conflict with an existing alias and with an existing payee name; an overlap with an existing alias; a unique violation skipped through the savepoint; the counts |
| shared generalisation (amendment) | mny-import.service and mny-preview specs | | the writer is called after `applyImportRules` and before `writeSecurities`, on the same manager; its warnings reach the result; the new counts only for KMyMoney; a Money preview and result unchanged |
| controller | kmy controller spec | mocked parser/staging | multer limit, error-code mapping, staging with `kmy`, format refusals on jobs and staged ids, PAT decorators |
| parser service | kmy parser service spec | mocked manager | reads preference and coins, passes them through, identical output on a second parse of the same bytes (handles equal) |
| integration | `backend/test/integration/` KMyMoney spec | committed fixtures and builder XML, real PostgreSQL | section 18 file end to end through `start`: verification all match with delta 0, holding 15 and cost 378.75, prices source `kmy_import`, rate `(EUR, USD, 1.1)`, receiving leg rate, reconciled dates, closed account closed after its rows, staged and job `source_format = 'kmy'`, staged bytes removed, re-upload refused, wipe lets the same bytes in, a Money staged id refused by the KMyMoney start; a builder file with a 3-level category tree, a loan payment and a cross-currency trade; payee amendment: the section 18 file gives City Power the alias `*CITY POWER*` and the default category Electricity and gives Corner Market no alias; an import into a profile holding a conflicting alias (skipped, post-import warning) and a payee with its own default category (kept, `payeeDetailsKept`); **not retroactive**: with an import rule on Corner Market's rows whose `set_payee_from_text` renders "CITY POWER X" (`createIfMissing` false), the rows keep Corner Market, which they would not if the aliases were written before the rule pass; after a start-fresh wipe the same aliases are written again |
| frontend | component, hook, lib specs | mocked API | each component with the kmy descriptor (copy keys, no era, no missing tables, mapped-balance line, download name), Money cases unchanged; the hook with the kmy client; wizard routing of `.kmy` and `.xml`; proxy route tables; currency source label; the "Payee aliases" review tile and the two report tiles shown only when their counts are above zero, and absent for Money |
| e2e | an e2e spec beside `e2e/tests/import-mny.spec.ts` | committed synthetic `.kmy`; in-test buffers | upload copy names KMyMoney; end to end through verification; refusals: plain text, PGP armour, SQLite header, `.anon.xml` |

Acceptance for the feature: the throwaway corpus run (plan, WP3b) over the 46 upstream samples reports no
untyped error and no `mappedBalanceDiffers`/`holdingsReplayDiffers`, and every refusal it reports is one
of section 4.3.

## 12. Risks

| Risk | Mitigation |
|---|---|
| A real file uses a shape the samples lack (none contains a stock split or a matched transaction, R17.2) | the corpus run plus the independent verification: a mapping gap shows as `mappedBalanceDiffers` in the review step before anything is written |
| Stock-split ratio meaning (R19.1) | KMyMoney's manual and its balance code agree on "multiplier"; `stockSplitRatioSuspicious` checks every split against its own price history; the holdings check compares against KMyMoney's own replay |
| `htmlparser2` leniency hides a truncated file | the reader's own nesting check and the root-close check (4.4); gzip truncation fails in zlib first |
| Memory on a very large file (raw model plus mapped model) | the XML bound; the per-import timing log reports peak RSS per format; measured on a 50,000-transaction builder file in WP3b and written into the importer README |
| A brokerage account renamed by the user is not found | the trades still fund from it correctly (5.7.3); `brokerageAccountNotFound` says so; the dropdown is the follow-up (14.4) |
| An upstream rename of the localized suffix | the suffix list is a constant with its provenance commit; KVP `kmm-brokerage-account` is tried first |
| Loan interest rate not imported | warning naming the rate; follow-up to add the field (13) |
| The parity tests (`frontend/src/i18n/messages.parity.test.ts`, `backend/src/i18n/locales.parity.spec.ts`) are red on the branch between the first English strings and the translation commit | expected; the translation work package is their gate, and the branch is not pushed for review before it |
| Many real keys are plain names typed or merged into KMyMoney's key list with a `.`, `(` or `+` in them, which are regular expressions outside the subset | each is named in `payeeMatchKeyNotImported` (payee and key in the samples, the full count in the sentence); the website page shows how to add the alias by hand |
| A file with many contains-style rules (`*X*`) raises many overlap warnings, since any two of them can match one text | counted per alias, not per pair; five samples; the sentence says what differs |
| The collision order (payee handle) keeps a broad alias and refuses a narrower one KMyMoney would have preferred | the warning names both; open question 7 |
| Alias inserts with a savepoint each on a large file | three statements per alias, small beside the transaction rows; the WP3b memory and time measurement is repeated in WP3c with 2,000 aliases |
| A shared-file change alters Money behaviour | every change in 4.9 is an optional field or a defaulted parameter; the Money specs of each changed file run unchanged in the work package that changes it, plus the Money integration specs once |

## 13. Open questions

1. **Loan terms.** Add `interestRate` (and optionally original amount and term) to `MappedLoanTerms` and
   `writeLoans`? Deferred: it is a Money-path writer change with no Money source. Owner: maintainer.
2. **Brokerage association control.** Is the per-investment-account dropdown (14.4) wanted in v1 after
   real files are tried? Owner: maintainer, after the first real import.
3. **Yield.** Mapped to DIVIDEND because KMyMoney's manual calls Dividend, Yield and Interest Income
   "interchangeable" cash distributions; a user who records bond coupons as Yield may prefer INTEREST.
   Revisit with a real file.
4. **Credit-limit sign for liabilities** (R19.2): the absolute value is used, so either sign gives the
   same limit.
5. **Helm memory guidance** (`helm/README.md` is an ask-first path): whether to add a KMyMoney line after
   WP3b's measurement. Owner: maintainer.
6. **Payee default categories.** Resolved by the payee amendment: section 5.5.2.
7. **Collision order for payee aliases.** Handle order keeps the first of two clashing aliases. Keeping
   the more specific one (the longer literal content) would follow KMyMoney's "longer match wins" more
   often, at the cost of a rule that is harder to predict. Revisit with a real file. Owner: maintainer.

## 14. Alternatives considered

### 14.1 The XML parser

| Option | Evidence | Verdict |
|---|---|---|
| **`htmlparser2` 12.0.0, `xmlMode`** | direct dependency in `backend/package.json`; MIT; ESM-only (`"type": "module"`), already in Jest's `transformIgnorePatterns` and already imported from `src/`; streaming `write`/`end`; no DTD processing (an internal subset's entities are reported, never expanded; probed); decodes the predefined and numeric entities (`&#10;` in an attribute becomes a newline; `&amp;#60;` becomes `&#60;`, which is what a matched-transaction KVP needs to stay unparsed); 59 MB in 1.6 s | **chosen**: no dependency change; the reader adds the well-formedness checks the tokenizer lacks |
| `fast-xml-parser` 5.12.0 | in `backend/package-lock.json` only as a transitive dependency of `mdb-reader` (and `html-to-text` does not use it); MIT; dual CJS/ESM | rejected: it builds the whole document as one object tree (no streaming), so a 100 MB file costs several times that in objects; it has a DOCTYPE entity feature with a history of expansion advisories (bounded by options in v5, but it is surface we do not need); using a transitive package directly is an undeclared dependency |
| `saxes` | not in the lockfile; ISC; CJS; strict XML 1.0 well-formedness; streaming; rejects undeclared entities | the best strict parser, but adding it is a new dependency (ask first) for well-formedness checks the reader can do in about 30 lines |
| `sax` | not in the lockfile; ISC; CJS; streaming; older and slower; strict mode | rejected for `saxes` and `htmlparser2` |
| a hand-written tokenizer for KMyMoney's subset | no dependency; KMyMoney writes elements, attributes, comments, the XML declaration and a DOCTYPE, never text or CDATA | rejected: about 300 lines plus specs to own entity decoding, attribute quoting and whitespace rules that `htmlparser2` already gets right in this repository's other readers |

### 14.2 Staging inflated XML

Rejected: staging the XML instead of the uploaded bytes would make `sha256` independent of gzip noise,
but multiplies the bytea row by 8-15 and makes the staged bytes something the user never uploaded.

### 14.3 String handles

Widening `handle` to `string | number` across the model (about 40 uses), the DTO validators (`@IsInt`)
and the frontend sets would touch Money code everywhere for no behaviour. Ordinals are safe (K6).

### 14.4 A per-investment-account cash-account choice

A dropdown per investment account in the review step (detected account, other same-currency asset
accounts, or "a new empty cash account"), sent as `options.investmentCash`, needs a new DTO array with
`@ArrayMaxSize`, and a re-preview endpoint (`POST /import/kmy/staged/:id/preview`) so the accounts table
shows the changed pairing. Deferred until a real file shows the name and KVP detection failing (open
question 2).

### 14.5 Equity as accounts

Monize has no equity account type. Equity splits outside opening balances become an income-type
category, which keeps every asset and liability balance exact and shows the movement in reports.

### 14.6 Payee matching as transaction rules

A transaction rule with an `import` trigger, a `payeeText` condition (`contains`, `startsWith`, `eq` or
the `matches` glob) and a `set_payee` action could express a KMyMoney Name or Key rule too. Rejected: an
alias is the construct Monize already has for "this imported name is that payee" and is read by every
path that resolves an imported payee (file import, bank sync, assistant, MCP); a rule is a heavier
object the user manages in a separate list (priority, trigger, actions), runs after payee resolution,
and does not bring the chosen payee's default category on the file import
(`.trail/learnings/2026-10-30-bank-sync-rule-chosen-payee-s-node.md`). Importing hundreds of rules
would also run inside every later import's write transaction. The rules' operators are no closer to
PCRE2 than the alias glob (`normalize` lowercases them too), so they would not widen the translatable
subset.

### 14.7 Approximating the keys Monize cannot express

Importing `AMAZON.COM` as the literal alias `*AMAZON.COM*`, or a case-sensitive key as is, matches a
different set of texts than KMyMoney did, and the difference shows up months later as rows assigned to
the wrong payee. Rejected for the untranslatable keys (skipped, named in a warning). Kept, with its own
warning, for the one widening that only adds matches of the same name in other capitals (check 8).

## 15. References

- `docs/kmymoney-data-model.md` (the reference, from KMyMoney at
  `d3943e0de789efede86b56c4246e7f4338fcc664` and libalkimia HEAD of 2026-11-18).
- KMyMoney user manual, "Investment Transactions" (`doc/details-investments.docbook` in the KMyMoney
  repository): split ratio, Dividend/Yield/Interest Income.
- `docs/specs/mny-import.md`, `backend/src/import/mny/README.md`, `docs/financial-semantics.md`,
  `docs/financial-calculation-contract.md`.
