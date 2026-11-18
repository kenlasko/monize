# KMyMoney data file format: an importer's reference

> Adopted as the format reference for the KMyMoney importer (`docs/specs/kmymoney-import.md`,
> `docs/future-plans/kmymoney-import.md`). Written 2026-11-18 from the KMyMoney and libalkimia sources
> at the commits named below. The upstream sample files it inventories in section 17 are **not** in this
> repository (licence unclear, two contain personal-looking data); fetch them from upstream at the pinned
> commit when a local robustness run needs them. The synthetic file in section 18 was written for this
> document and is free to use.

Derived from the KMyMoney source at `https://github.com/KDE/kmymoney`, commit
`d3943e0de789efede86b56c4246e7f4338fcc664` (HEAD on 2026-11-18, development branch, app version 5.2.70+).
The number type comes from the separate library **libalkimia** (`https://github.com/KDE/alkimia`, HEAD on
2026-11-18, `src/alkvalue.cpp`, `src/alkvalue.h.in`).

Every statement below cites where it comes from. Anything not confirmed in source is marked
**[not from source]** or listed under §19 Open questions.

## Citation key

| Tag | File (relative to repo root) |
|---|---|
| **RD** | `kmymoney/plugins/xml/mymoneyxmlreader.cpp` (the reader; the definitive answer for "what is read") |
| **WR** | `kmymoney/plugins/xml/mymoneyxmlwriter.cpp` (the writer; element/attribute order and what is written) |
| **NM** | `kmymoney/plugins/xml/mymoneystoragenames.cpp` (tag/attribute name tables) |
| **XS** | `kmymoney/plugins/xml/xmlstorage.cpp` (container: open/save, gzip, GPG, sniffing) |
| **BIN** | `kmymoney/plugins/xml/mymoneystoragebin.h` (legacy binary magic) |
| **ANON** | `kmymoney/plugins/xml/mymoneyanonwriter.cpp` |
| **XH** | `kmymoney/mymoney/xmlhelper/xmlstoragehelper.cpp` (attribute parsing helpers, REPORT, BUDGET) |
| **EN** | `kmymoney/mymoney/mymoneyenums.h` (all enums) |
| **MF** | `kmymoney/mymoney/mymoneyfile.cpp` / `.h` (engine, file fixes, opening balances, prices) |
| **ACC** | `kmymoney/mymoney/mymoneyaccount.cpp` |
| **LOAN** | `kmymoney/mymoney/mymoneyaccountloan.cpp` |
| **SPL** | `kmymoney/mymoney/mymoneysplit.cpp` |
| **TX** | `kmymoney/mymoney/mymoneytransaction.cpp`, `mymoneytransaction_p.h` |
| **SCH** | `kmymoney/mymoney/mymoneyschedule.cpp` |
| **SEC** | `kmymoney/mymoney/mymoneysecurity.cpp`, `mymoneysecurity_p.h` |
| **PR** | `kmymoney/mymoney/mymoneyprice.cpp` |
| **PAY** | `kmymoney/mymoney/mymoneypayee.cpp` |
| **KVP** | `kmymoney/mymoney/mymoneykeyvaluecontainer.cpp` / `.h` |
| **MM** | `kmymoney/mymoney/mymoneymoney.cpp` |
| **MU** | `kmymoney/mymoney/mymoneyutils.cpp` |
| **JM** | `kmymoney/mymoney/storage/journalmodel.cpp` (balance computation) |
| **AM** | `kmymoney/mymoney/storage/accountsmodel.cpp` |
| **IDS** | `kmymoney/mymoney/storage/*model.cpp/.h` (id prefixes and widths) |
| **KU** | `kmymoney/kmymoneyutils.cpp` |
| **IA** | `kmymoney/views/investactivities.cpp` |
| **ITE** | `kmymoney/views/investtransactioneditor.cpp` |
| **TM** | `kmymoney/dialogs/transactionmatcher.cpp` |
| **NAD** | `kmymoney/dialogs/knewaccountdlg.cpp` |
| **REC** | `kmymoney/views/reconciliationledgerviewpage.cpp` |
| **STR** | `kmymoney/converter/mymoneystatementreader.cpp` (OFX/QIF/CSV statement import into the engine) |
| **PV** | `kmymoney/views/kpayeesview_p.h` (payee view: match-type labels, default-category choices, merging payees) |
| **SQL** | `kmymoney/plugins/sql/*` (SQL backend) |
| **ALK** | alkimia `src/alkvalue.cpp`, `src/alkvalue.h.in` |

---

## Contents

1. Containers: how to detect each on-disk form
2. Document skeleton, ordering rules, FILEINFO, fix versions, legacy layouts
3. Primitive encodings: numbers, dates, booleans, ids, strings, key/value pairs
4. Section-by-section element reference
5. Accounts
6. Transactions and splits
7. Investments
8. Securities and currencies
9. Prices
10. Payees, tags, cost centers, institutions
11. Schedules
12. Budgets
13. Key/value pair catalogue
14. Reconciliation
15. Balances and holdings: verifying an import
16. Pitfalls
17. Sample files in the repository (inventory and licence)
18. Synthetic annotated example file
19. Open questions

---

## 1. Containers: how to detect each on-disk form

KMyMoney decides what a file is by its **content**, not its extension (XS `XMLStorage::open`). Algorithm
(XS `open`, lines ~376–472):

1. Read the first **2 bytes** (fewer than 2 means the file is rejected as too short).
   * `1F 8B` (`"\037\213"`) → **gzip**. Decompress with gzip (`KCompressionDevice::GZip`) and continue with
     the decompressed stream.
   * `2D 2D` (`"--"`) → **PGP ASCII-armored** (`-----BEGIN PGP MESSAGE-----`).
   * `85 01` or `85 02` → **PGP binary**.
     For both PGP cases KMyMoney decrypts via GnuPG (`KGPGFile`) if built with GPG; otherwise it throws
     "GPG is not available for decryption of file". The decrypted payload is plain (uncompressed) XML:
     when saving encrypted, the writer goes straight into `KGPGFile` with no gzip layer (XS
     `saveToLocalFile`).
   * Anything else → treat as **plain XML**.
2. From the (possibly decompressed) stream read 8 bytes as two big-endian `qint32`. If they are
   `0x4B4D794D 0x6F6E6579` (ASCII `KMyMoney`), or the first int32 is `< 30` (signed), the file is
   rejected as the **legacy binary format (KMyMoney 0.8 and earlier)** (XS; BIN `MAGIC_0_50`,
   `MAGIC_0_51`).
3. Read the first **70 bytes**. If they do not contain the literal text `<!DOCTYPE KMYMONEY-FILE>`, the
   file is "not a KMyMoney data file" (XS, `kmyexp`).
4. Parse as XML (§2).

What an importer should do:

| Form | Typical name | Detection | Action |
|---|---|---|---|
| gzip XML | `*.kmy` | bytes `1F 8B` | gunzip, then parse as XML. Default save format: anything not ending `.xml` is gzip-compressed (XS `save`: `plaintext = filename ends with ".xml"`; `COMPRESSION_TYPE = GZip`). |
| plain XML | `*.xml` | starts with `<?xml` (or `<!DOCTYPE`) | parse. |
| anonymized | `*.anon.xml` | same as plain XML | parse, but the data is deliberately altered (§16.12). Written by `MyMoneyAnonWriter` when the name ends `.anon.xml`, always uncompressed and never encrypted (XS `save`, `saveAs`). |
| GPG-encrypted | usually `*.kmy` | `2D 2D` or `85 01` / `85 02` (KMyMoney's own test) | refuse with "file is GPG-encrypted; decrypt it with `gpg -d file.kmy > file.xml` (or save it unencrypted from KMyMoney) and import the result". **[not from source]** OpenPGP binary packets can also start with other bytes (for example `84 xx` or new-format `C1`). A tolerant detector: first byte has bit 7 set and is not `1F`, combined with "not XML, not gzip, not SQLite" → treat as probably OpenPGP and refuse. |
| SQL / SQLite | user-chosen, dialog filter `*.db *.sql` (SQL `sqlstorage.cpp fileExtension`) | **[not from source]** an unencrypted SQLite 3 database starts with the 16 bytes `"SQLite format 3\0"` | refuse with "KMyMoney SQL database: in KMyMoney use File → Save As… to save it as a .kmy/.xml file". KMyMoney opens these only through a `sql://` URL (XS `open` returns false for scheme `sql`; SQL `sqlstorage.cpp open`), never by sniffing. |
| SQLCipher | as above | **[not from source]** an SQLCipher-encrypted database has no plaintext header (the first 16 bytes are a random salt) and looks like random data | refuse. See the SQLCipher notes below. |
| legacy binary 0.x | `*.kmy` | after decompression, first 8 bytes `KMyMoney`, or first int32 < 30 | refuse ("KMyMoney 0.8 binary format"). |

**SQLCipher.** When KMyMoney is built with `ENABLE_SQLCIPHER`, the plain `QSQLITE` driver is removed from the
driver list and every SQLite URL is rewritten to `QSQLCIPHER` (SQL `mymoneydbdriver.cpp
MyMoneyDbDriver::driverMap`; `sqlstorage.cpp` "QSQLCIPHER can read QSQLITE"). A database is actually
encrypted only when a password was given: `PRAGMA key = '<passphrase>'` is issued (SQL
`mymoneystoragesql.cpp` lines ~119–178). So a KMyMoney SQLite file may be plain SQLite (readable header) or
SQLCipher (no header). The SQL schema has tables `kmmFileInfo, kmmInstitutions, kmmPayees,
kmmPayeesPayeeIdentifier, kmmTags, kmmTagSplits, kmmAccounts, kmmAccountsPayeeIdentifier,
kmmTransactions, kmmSplits, kmmKeyValuePairs, kmmSchedules, kmmSchedulePaymentHistory, kmmSecurities,
kmmPrices, kmmCurrencies, kmmReportConfig, kmmOnlineJobs, kmmPayeeIdentifier, kmmPluginInfo,
kmmBudgetConfig, kmmCostCenter`, at DB layout version `availableFixVersion() + 5` = 17 (SQL
`mymoneydbdef.cpp`). This document does not cover reading it.

**Byte-order mark.** A UTF-8 BOM (`EF BB BF`) makes the first int32 negative, so KMyMoney rejects such a
file as "old binary" (XS step 2). An importer can simply strip a BOM. KMyMoney itself never writes one.

**Lock file.** When KMyMoney has a file open it creates `<file>.lck` next to it (XS `lock`). Ignore it.

---

## 2. Document skeleton, ordering rules, FILEINFO, fix versions, legacy layouts

### 2.1 Encoding and pre-parse sanitising (important)

* The writer uses `QXmlStreamWriter`: `<?xml version="1.0" encoding="UTF-8"?>`, then
  `<!DOCTYPE KMYMONEY-FILE>`, then the root `<KMYMONEY-FILE>`, auto-formatted with 2-space indent (WR
  `MyMoneyXmlWriterPrivate::write`). Older 5.0/5.1-era files (QDom writer) have `encoding="utf-8"`,
  1-space indent, and attributes in arbitrary order (see the sample `test-385993.xml`). **Never rely on
  attribute order or formatting.**
* **The reader does not feed raw bytes to the XML parser.** It wraps the device in
  `QIOXmlDeviceProxy::validateUtf8AndXML` (RD, top of file), which filters bytes on the fly:
  * ASCII bytes `< 0x20` are dropped, except TAB `09`, LF `0A`, CR `0D`.
  * A UTF-8 lead byte (`11xxxxxx`) that is followed by an ASCII byte or by another lead byte is dropped.
  * A continuation byte (`10xxxxxx`) that does not follow a lead or continuation byte is dropped.
  * (The number of continuation bytes is not validated.)
  Real files therefore can contain raw control characters (for example from bank imports) that make a
  strict XML 1.0 parser fail. **Replicate this filter before parsing** (it is stateful across buffer
  boundaries).
* Strings are XML-escaped by the writer. **[not from source; Qt behaviour]** `QXmlStreamWriter::writeAttribute`
  writes `&`, `<`, `>`, `"` as entities and newline/CR/TAB in attribute values as `&#10;`, `&#13;`, `&#9;`.
  Multi-line memos and notes are therefore attribute values containing `&#10;`. A conformant parser
  decodes them correctly. Literal newlines in attributes would be normalised to spaces by XML rules.

### 2.2 Root and section order

The writer emits these children of `KMYMONEY-FILE`, in this order (WR `writeKMyMoney`):

```
FILEINFO, USER, INSTITUTIONS, PAYEES, COSTCENTERS, TAGS, ACCOUNTS, TRANSACTIONS,
KEYVALUEPAIRS, SCHEDULES, SECURITIES, CURRENCIES, PRICES, REPORTS, BUDGETS, ONLINEJOBS
```

The reader accepts any order and skips unknown elements (RD `readKMyMoney`). One ordering dependency
matters: **ACCOUNTS must come before TRANSACTIONS and SCHEDULES**, because every SPLIT's `account` is
checked against the set of account ids read so far. An unknown id (or one of the five `AStd::` root ids)
throws `Corrupted data: transaction '%1', split '%2' references unknown account id '%3'` and the whole load
fails (RD `readSplit`, `m_validAccountIds`). Sections may be missing (older files have no COSTCENTERS,
TAGS or ONLINEJOBS) and may be self-closing (`<PAYEES/>`).

Older writers put a `count="N"` attribute on every section container (for example
`<ACCOUNTS count="53">`, sample `test-385993.xml`). The current reader ignores it and the current writer
does not emit it.

### 2.3 FILEINFO

```xml
<FILEINFO>
  <CREATION_DATE date="2024-01-01"/>                         <!-- ISO date, may be "" -->
  <LAST_MODIFIED_DATE date="2026-08-29T22:51:23+02:00"/>     <!-- ISO datetime; old files: date only -->
  <VERSION id="1"/>                                          <!-- always "1"; parsed as hex uint -->
  <FIXVERSION id="12"/>                                      <!-- see below -->
  <APPVERSION id="5.2.70-94cd76bbb"/>                        <!-- writer's VERSION; ignored by reader -->
</FILEINFO>
```

(WR `writeFileInformation`; RD `readFileInfo`.) `VERSION` is read with base 16 but always written as `1`.
It never changed, so do not branch on it.

**FIXVERSION decoding** (RD `readFileInfo`). Follow this exactly, because old files differ:

1. Read the `date` attribute as an unsigned integer (older versions stored the fix version there).
2. If that yields 0 (missing or empty): if the `id` attribute is missing or empty, fixVersion = **5**;
   otherwise fixVersion = `id`.
3. If fixVersion == 2, use 3.
4. If the FIXVERSION element is absent altogether, KMyMoney treats the file as current
   (`MyMoneyFile::fileFixVersion` returns `availableFixVersion()` = 12 when the key is empty; MF).

Samples in the wild include `<FIXVERSION date=""/>` (5.1.80/5.1.90 files) → treated as 5, and
`<FIXVERSION id=""/>` → 5.

The current maximum is **12** (`MyMoneyFile::availableFixVersion`, MF header). After loading, the app
runs `applyFileFixes` (MF, `fixFile_0` … `fixFile_11`), one step per level, until the level is 12. An
importer does not run these fixes, but must compensate for what they would have repaired:

| From level | Fix | Effect on data an importer reads |
|---|---|---|
| 0 → 1 | `fixFile_0`, `fixSchedule_0`, `fixTransactions_0` | (a) Loan accounts lacking loan KVPs make the fix **throw** ("Fix LoanAccount0 not supported anymore"). (b) Equity accounts not under `AStd::Equity` are reparented. (c) Schedule templates (`fixSchedule_0`): missing `commodity` is set to the first split account's currency. Splits referencing non-existent accounts are removed. Reconcile flags are reset to 0. `shares` is set to `value` when shares is 0 and value is not. (d) Transactions (`fixTransactions_0`): missing `commodity` is set to the base currency. If split account currency == transaction commodity and `shares != value`, then `shares := value` (not only when shares is 0). Then, for a split not on a stock account (`isInvest`) whose `shares` is not at the account fraction (the currency's saf, scf for a cash account), `shares` and `value` are converted to it with `RoundRound`. The `Interest` action is normalised. These run only for a file at level 0 (`applyFileFixes` steps one level at a time; MF `fixTransactions_0`). **Compensate** only at level 0, with exactly these rules (the importer's `applyKmyFileFixes`); at levels 1 to 11 the shares are what KMyMoney sums, even when 0. |
| 1 → 2 | `fixFile_1` | reports only |
| 2 → 3 | `fixFile_2` | two-split account+category transactions: the category split memo is set to the account split memo (cosmetic). The reader also maps 2 → 3 directly. |
| 3 → 4 | `fixFile_3` | creates `kmm-id` (file UUID) |
| 4 → 5 | `fixFile_4` | currencies XAU, XPD, XPT, XAG: `saf := scf` |
| 5 → 6 | `fixFile_5` | single-split `Add` (add/remove shares) transactions with non-zero `price` → price set to 0. **Compensate:** ignore `price` on `Add` splits. |
| 6 → 9 | `fixFile_6/7/8` | reports only |
| 9 → 10 | `fixFile_9` | schedules containing an auto-calc split (§3.1) get type 5 (LoanPayment). **Compensate:** treat a schedule with an auto-calc split as a loan payment. |
| 10 → 12 | `fixFile_10/11` | reports only |

After the fixes, `createMissingObjects` (MF) **creates placeholder payees** named `Unknown payee '<id>'`
for every payee id referenced by a split, schedule or report that does not exist, and placeholder
institutions for referenced but missing institution ids. A comment says such files come from Skrooge
exports. **Compensate:** expect dangling payee/institution references.

### 2.4 Legacy layout differences a real-world reader must handle

All of these are handled by the current reader, so you must handle them too:

| Legacy form | Current form | Source |
|---|---|---|
| `ADDRESS` with `county` / `country` instead of `state`; `zipcode` / `postcode` instead of `zip` | `state`, `zip`; the writer still also writes `country`, `county`, `zipcode`, `postcode` duplicates "for 5.1 compatibility" | RD `readAddress`; WR `writeAddress` |
| account KVP `IBAN` (≤ 4.6.6) | KVP `iban` (if both exist, `iban` wins and `IBAN` is dropped) | RD `readAccount` |
| account KVP `lastStatementDate` | dropped on read (obsolete) | RD `readAccount` |
| reconciliation history in account KVP `reconciliationHistory` | `<RECONCILIATIONS>` child element (both are still written) | RD `readAccount`; ACC `reconciliationHistory` |
| `FIXVERSION date="n"` | `FIXVERSION id="n"` | RD `readFileInfo` |
| `ONLINEBANKING provider="KMyMoney OFX"` or `"Weboob"` | `ofximporter` / `woob` | RD `readOnlineBanking` |
| Payee `matchkey` keys separated by `;` (4.8.0) | separated by `\n` (`&#10;`) | PAY `setMatchData(QString)` |
| Scheduled TRANSACTION carrying a non-empty `entrydate` | `entrydate=""`. If entrydate is valid, the reader **clears postdate**, and the next due date is recomputed (§11.4). | RD `readSchedule` |
| Schedules without a next due date | computed from `startDate` / `lastPayment` (§11.4) | RD `readSchedule` |
| Compound occurrence codes (8, 16, 20, 30, 64, 126, 128, 256, 1024, 2048, 4096, 8192) | base occurrence + multiplier | SCH `simpleToCompoundOccurrence` |
| `CURRENCY` attribute `ppu` | ignored (not read) | RD `readSecurity` |
| SECURITY without `pp` or `rounding-method` | `pp` 0 or > 10 → 4; `rounding-method` missing → 0 (RoundNever) | RD `readSecurity` |
| SPLIT without `price` attribute | price = 0 | RD `readSplit` (empty string → MyMoneyMoney 0) |
| LAST_MODIFIED_DATE with a date only (`2017-10-20`) | ISO datetime with offset | sample `test-385993.xml` |

---

## 3. Primitive encodings

### 3.1 Numbers: MyMoneyMoney / AlkValue

* **Type.** `MyMoneyMoney` derives from `AlkValue`, an arbitrary-precision GMP rational (`mpq_class`)
  (MM; ALK). There is **no float anywhere in storage**.
* **Written form.** `AlkValue::toString()` → `mpqToString`: `gmp_asprintf("%Qd")`, then `"/1"` is appended
  if there is no `/` (ALK). GMP rationals are kept canonical (lowest terms, positive denominator). So:
  * `100.50` is written as `201/2`, not `10050/100`. `-120.50` is `-241/2`. `0` is `0/1`. `5000` is
    `5000/1`.
  * Denominators are **not** necessarily powers of ten: for example `shares="-218677/25"` (= −8747.08),
    `price="253075/218677"` (sample `test-transactions-multi-currency.xml`).
  * The sign is on the numerator only.
  * Numerator and denominator can exceed 2^53. The auto-calc sentinel is `-9223372036854775807/100`
    (= (INT64_MIN+1)/100, MM `MyMoneyMoney::autoCalc`). Prices and exchange rates can be arbitrary
    rationals.
* **Parsing** (ALK `AlkValue::AlkValue(const QString&, QChar decimalSymbol)`):
  1. Empty string → 0.
  2. If it matches `^((\d+)\s+|-)?(\d+/\d+)` (not end-anchored): parse group 3 as a rational,
     canonicalise; if group 1 is `-` negate; if group 1 is an integer `N` followed by whitespace, add N
     (mixed fraction `5 8/16`).
  3. Otherwise decimal fallback: strip every character that is not a digit, the locale decimal separator,
     `-`, `(` or `)`. Any of `-()` makes it negative. Keep only the right-most decimal separator. Build
     `digits/10^fractionDigits`. (Files always use the rational form; the decimal fallback depends on the
     **locale decimal separator** of the running app, so do not depend on it.)
* **Exact conversion in TypeScript (recommended).** Parse with
  `/^(-)?(\d+)\/(\d+)$/` into `BigInt` numerator and denominator. Reject a zero denominator. Keep the value
  as a rational, or convert to a fixed scale with explicit rounding:
  `scaled = num * 10n**BigInt(scale) / den` plus a rounding rule. Never use `Number(num)/Number(den)`.
  Detect the auto-calc sentinel **before** any conversion: `num === ±9223372036854775807n && den === 100n`
  (MM `isAutoCalc` checks both signs).
* **Special values** (MM): `maxValue = INT64_MAX/100`, `minValue = INT64_MIN/100`,
  `autoCalc = (INT64_MIN+1)/100`. autoCalc appears only in **schedule templates** (loan payment splits whose
  amount is computed at entry time; sample `test-refinance-loan.xml`), never in posted transactions
  (`SPL isAutoCalc`; `TX hasAutoCalcSplit`).
* **Rounding** applied when KMyMoney stores a transaction (not on read). `MyMoneyFile::fixSplitPrecision`
  (MF) rounds `shares` to the split account's fraction and `value` to the transaction commodity's
  `saf`, except for `Split` (stock split) splits. The account fraction is the currency's or security's
  `saf`, but `scf` for Cash accounts (type 3) (ACC `fraction`). Older data may carry finer precision;
  accept any rational.

**Rounding-method enum** (SECURITY / CURRENCY `rounding-method`; ALK `alkvalue.h.in` `RoundingMethod`):
`0 RoundNever, 1 RoundFloor, 2 RoundCeil, 3 RoundTruncate, 4 RoundPromote, 5 RoundHalfDown,
6 RoundHalfUp, 7 RoundRound`. Default 7 (SEC `MyMoneySecurityPrivate`). Where code rounds with a
security's method, RoundNever is replaced by RoundRound (JM `stockSplit`; ITE `saveTransaction`).

### 3.2 Dates

* Dates are written by `MyMoneyUtils::dateToIsoString` as `Qt::ISODate` (`YYYY-MM-DD`), or **`""` for a
  null/invalid date** (MU). They are read by `readDateAttribute`: an empty or unparsable value gives a null
  `QDate` (XH).
* Datetimes (`LAST_MODIFIED_DATE`, `LastModificationDate` KVP) are ISO 8601 with offset, for example
  `2026-08-29T22:51:23+02:00` (MU `dateTimeToIsoString`).
* Meaning of empty: "not set". Specific cases:
  * `TRANSACTION entrydate=""`: the reader **substitutes today's date** for normal transactions (RD
    `readTransaction`, `assignEntryDateIfEmpty`). An importer should store null.
  * `TRANSACTION postdate=""`: the engine refuses to add such a transaction ("invalid postdate", MF
    `addTransaction`). In a schedule template it means "no next due date" (§11).
  * SPLIT `reconciledate=""`: never reconciled.
  * ACCOUNT `opened=""`, `lastreconciled=""`, `lastmodified=""`: unknown or never.
* `ONLINEJOB send` / `bankAnswerDate` are written as dates but read as datetimes (WR `writeOnlineJob`; RD
  `readOnlineJob`).

### 3.3 Booleans

* **XML attributes** are written `"1"`/`"0"` (WR `attrValue(bool)`). `readBoolAttribute` accepts,
  case-insensitively, `1/0`, `on/off`, `true/false`, `yes/no`; anything else gives the default (XH). Some
  boolean-ish attributes are read as uint (`lastDayInMonth`, payee `matchingenabled`, `usingmatchkey`,
  `matchignorecase`) (RD).
* **KVP booleans** are written `"yes"`/`"no"`, and **the pair is deleted when the value equals the
  default** (KVP `setValue(key,bool,default)`, `toString(bool)`). They are read as
  `value.toLower() == "yes"` (KVP `value(key,bool)`). Exceptions (literal strings, case matters):
  * `OpeningBalanceAccount`: written `"Yes"` by `createOpeningBalanceAccount` (MF) and `"yes"` by the
    account dialog (NAD `storeKVP(QCheckBox)`). `openingBalanceAccount_internal` compares `== "Yes"`
    case-sensitively (MF), but the dialog reads it case-insensitively (NAD line ~588). **Accept both.**
  * `Imported`: `"true"`, compared case-insensitively (TX `isImported`).
  * `fixed-interest`: `"yes"` or `"no"` (LOAN).

### 3.4 Ids

Ids are opaque strings, `<prefix><zero-padded decimal>` (IDS: `MyMoneyModelBase::nextId` formats
`"%1%2".arg(prefix).arg(n, width, 10, '0')`):

| Object | Prefix | Width | Example | Source |
|---|---|---|---|---|
| Account | `A` | 6 | `A000001` | `accountsmodel.cpp/.h` |
| Standard root accounts | fixed | n/a | `AStd::Asset`, `AStd::Liability`, `AStd::Expense`, `AStd::Income`, `AStd::Equity` | ACC `stdAccName` |
| Institution | `I` | 6 | `I000001` | `institutionsmodel` |
| Payee | `P` | 6 | `P000001` | `payeesmodel` |
| Tag | `G` | 6 | `G000001` | `tagsmodel` |
| Cost center | `C` | 6 | `C000001` | `costcentermodel` |
| Transaction | `T` | 18 | `T000000000000000001` | `journalmodel` |
| Split | `S` | 4 | `S0001` (unique only **within** its transaction) | TX `nextSplitID`, `SPLIT_ID_SIZE` |
| Schedule | `SCH` | 6 | `SCH000001` | `schedulesmodel` |
| Security (non-currency) | `E` | 6 | `E000001` | `securitiesmodel` |
| Currency | ISO 4217 code (or user code) | n/a | `EUR`, `BTC` | currencies model (id prefix cleared) |
| Report | `R` | 6 | `R000001` | `reportsmodel` |
| Budget | `B` | 6 | `B000001` | `budgetsmodel` |
| Online job | `O` | 6 | `O000001` | `onlinejobsmodel` |
| User (file owner) | fixed | n/a | `P000001` (internal key only, not in file) | MF `fixedKey(UserID)` |
| `AStd::Favorite` | internal only, never written | | | ACC; AM |

Notes:
* **Split `id`s are not preserved on load.** The reader ignores the SPLIT `id` attribute and
  `addSplit` renumbers `S0001…` in document order (RD `readSplit`/`readSplits`; TX `addSplit`).
  The ids are deterministic for an unmodified file (same order), so `kmm-match-split` (§6.8) stays
  consistent.
* Test data shows that ids need not follow the pattern (`testfile3.xml` uses `1-bank`, `2-account`).
  Treat ids as opaque strings.
* The schedule template TRANSACTION has `id=""` (RD reads it with `IdRequirement::Optional`; SCH
  `setTransaction` clears the id).

### 3.5 Key/value containers

Any object can carry:

```xml
<KEYVALUEPAIRS>
  <PAIR key="..." value="..."/>
</KEYVALUEPAIRS>
```

(RD `readKeyValueContainer`; WR `writeKeyValueContainer`, written only when non-empty and sorted by key
because the container is a `QMap`.) A duplicate key keeps the last value. Containers exist on: the file
(top-level `KEYVALUEPAIRS`), INSTITUTION, ACCOUNT, TRANSACTION, SPLIT, SCHEDULED_TX, SECURITY, CURRENCY.
Payees, tags and cost centers have none in XML. See §13 for the key catalogue.

---

## 4. Section-by-section element reference

Attribute lists follow WR (write order) and RD (what is read, plus defaults). "req" means the reader raises
an XML error when it is missing or empty (`readRequiredStringAttribute`, used for every `id` except the
schedule template and matched transaction; XH `readId`).

### 4.1 USER

```xml
<USER name="" email="">
  <ADDRESS street="" city="" state="" zip="" telephone="" country="" county="" zipcode="" postcode=""/>
</USER>
```

The file owner's details (WR `writeUserInformation`; RD `readUser`). Not needed for an import.

### 4.2 INSTITUTIONS / INSTITUTION

```xml
<INSTITUTION id="I000001" name="…" manager="…" sortcode="…">   <!-- sortcode = bank code -->
  <ADDRESS street="" city="" state="" zip="" telephone="" …/>  <!-- state always written empty -->
  <ACCOUNTIDS><ACCOUNTID id="A000001"/>…</ACCOUNTIDS>
  <KEYVALUEPAIRS>…</KEYVALUEPAIRS>                              <!-- bic, url, iconUrl, icon -->
</INSTITUTION>
```

(WR `writeInstitution`; RD `readInstitution`; KVP keys from `kmymoney/dialogs/knewinstitutiondlg.cpp`.)
`ACCOUNTIDS` duplicates the ACCOUNT `institution` attribute. KMyMoney's institutions view is built from
`ACCOUNTIDS` (`institutionsmodel.cpp InstitutionsModel::load` → `loadAccounts(item.accountList())`). The
account attribute is what `createMissingObjects` checks (MF), and accounts with an empty attribute are
listed under "no institution" (`slotLoadAccountsWithoutInstitutions`). Use the account attribute as the
relation and cross-check against `ACCOUNTIDS`. Stock accounts normally have no institution.

### 4.3 PAYEES / PAYEE: see §10.1

### 4.4 COSTCENTERS / COSTCENTER

`<COSTCENTER id="C000001" name="…"/>` (WR `writeCostCenter`; RD `readCostCenter`). Referenced from
SPLIT `costcenter`. The account KVP `CostCenter` = `yes` means "this category requires a cost center" (ACC
`isCostCenterRequired`).

### 4.5 TAGS / TAG

`<TAG id="G000001" name="…" closed="0|1" tagcolor="#rrggbb" notes="…"/>`. `tagcolor` and `notes` are
written only when set (WR `writeTag`; RD `readTag`). Splits reference tags with child `<TAG id="G…"/>`
elements (§6.2). The same element name `TAG` is used in both places.

### 4.6 ACCOUNTS / ACCOUNT: see §5

### 4.7 TRANSACTIONS / TRANSACTION / SPLITS / SPLIT: see §6

### 4.8 KEYVALUEPAIRS (file level): see §13.1

### 4.9 SCHEDULES / SCHEDULED_TX: see §11

### 4.10 SECURITIES / SECURITY and CURRENCIES / CURRENCY: see §8

### 4.11 PRICES / PRICEPAIR / PRICE: see §9

### 4.12 REPORTS / REPORT

Saved report definitions (`XH readReport`/`writeReport`). Child elements `PAYEE, TAG, ACCOUNT, TEXT, TYPE,
STATE, NUMBER, AMOUNT, DATES, CATEGORY, ACCOUNTGROUP, VALIDITY` (XH `elementName(Element::Report)`).
**Not needed for a data migration.** Safe to skip. Note that REPORT children reuse the names `ACCOUNT`,
`PAYEE` and `TAG` with a different meaning (filters), so never search the whole document for these names;
walk the tree.

### 4.13 BUDGETS / BUDGET: see §12

### 4.14 ONLINEJOBS / ONLINEJOB

```xml
<ONLINEJOB id="O000001" send="YYYY-MM-DD" bankAnswerDate="YYYY-MM-DD"
           bankAnswerState="abortedByUser|acceptedByBank|rejectedByBank|sendingError">  <!-- absent = noBankAnswer -->
  <onlineTask iid="org.kmymoney.creditTransfer.sepa" …task-specific attributes/children…/>
</ONLINEJOB>
```

(WR `writeOnlineJob`; RD `readOnlineJob`.) These are pending or sent online credit transfers. **Not needed
for a migration.**

### 4.15 ONLINEBANKING (child of ACCOUNT)

A single element whose **attributes are arbitrary key/value pairs** (WR `writeAccount`; RD
`readOnlineBanking`). Examples: `provider="ofximporter"`, `url`, `fid`, `org`, `bankid`, `accountid`,
`username`, `kmmofx-*`, `kbanking-*`, `wb-*`. **Treat as sensitive and do not import.** The current OFX
setup deletes `password` before saving (`plugins/ofx/import/dialogs/konlinebankingsetupwizard.cpp`, the
password goes to the system keychain), but `username` is stored, and files from older versions may still
contain `password`.

---

## 5. Accounts

### 5.1 Element

```xml
<ACCOUNT id="A000001" parentaccount="AStd::Asset" lastreconciled="2024-01-31" lastmodified="2024-02-01"
         institution="I000001" opened="2024-01-01" number="123456" type="1" name="Checking"
         description="free-text notes" currency="USD">
  <SUBACCOUNTS><SUBACCOUNT id="A000002"/>…</SUBACCOUNTS>      <!-- only if it has children -->
  <ONLINEBANKING …/>                                           <!-- only if configured -->
  <RECONCILIATIONS>                                            <!-- only if history exists -->
    <RECONCILIATION date="2024-01-31" value="7759/2"/>
  </RECONCILIATIONS>
  <KEYVALUEPAIRS>…</KEYVALUEPAIRS>
</ACCOUNT>
```

(WR `writeAccount`; RD `readAccount`.)

| Attribute | Meaning / encoding |
|---|---|
| `id` | req. `A…` or `AStd::…` |
| `name` | display name of this level only (not the full path) |
| `type` | integer, §5.2. Invalid or missing: warning only, type stays Unknown (0) (RD) |
| `parentaccount` | parent id. **Authoritative** for the hierarchy (§5.3) |
| `institution` | institution id or `""` |
| `opened` | opening date (ISO) or `""`. Categories typically `1900-01-01` (samples) |
| `lastreconciled` | date of the last reconciliation or `""` |
| `lastmodified` | date, informational |
| `number` | account number (free text) |
| `description` | the account's **notes** field (plain text from `descriptionEdit->toPlainText()`, NAD) |
| `currency` | currency id (ISO code). For **Stock (type 15) accounts it is the security id** (`E000001`). Omitted when empty (standard accounts in old files) |
| `openingbalance`, `iban`, `bic` | names exist in NM but are **neither written nor read** as ACCOUNT attributes by current code. IBAN lives in KVP `iban` |

### 5.2 Account type enum (EN `eMyMoney::Account::Type`)

| Int | Name | Group (ACC `accountGroup`) | Notes |
|---|---|---|---|
| 0 | Unknown | n/a | error marker |
| 1 | Checkings | Asset | liquid (ACC `isLiquidAsset`) |
| 2 | Savings | Asset | liquid |
| 3 | Cash | Asset | liquid; fraction = currency `scf` (ACC `fraction`) |
| 4 | CreditCard | Liability | |
| 5 | Loan | Liability | money you owe; loan KVPs (§5.9) |
| 6 | CertificateDep | Asset | |
| 7 | Investment | Asset | container for Stock accounts (§7.1) |
| 8 | MoneyMarket | Asset | |
| 9 | Asset | Asset | generic asset; also `AStd::Asset` |
| 10 | Liability | Liability | generic liability; also `AStd::Liability` |
| 11 | Currency | Asset | "currency trading account" (rare) |
| 12 | Income | Income | **category**; also `AStd::Income` |
| 13 | Expense | Expense | **category**; also `AStd::Expense` |
| 14 | AssetLoan | Asset | loan you gave (money owed to you); loan KVPs. The account dialog turns a Loan under an Asset parent into AssetLoan (NAD) |
| 15 | Stock | Asset | one security holding; `currency` = security id (ACC `isInvest` ⇔ type 15) |
| 16 | Equity | Equity | opening-balance accounts; also `AStd::Equity` |

String names (budget `type` attribute only; XH `accountTypeAttributeLUT`): `unknown, checkings, savings,
cash, creditcard, loan, certificatedep, investment, moneymarket, asset, liability, currency, income,
expense, assetloan, stock, equity`.

### 5.3 Standard root accounts and hierarchy

* There are exactly five top-level accounts, with fixed ids (ACC `stdAccName`):
  `AStd::Asset` (type 9), `AStd::Liability` (10), `AStd::Expense` (13), `AStd::Income` (12),
  `AStd::Equity` (16). The writer always writes them first, in the order Asset, Liability, Expense,
  Income, Equity, then all other accounts **sorted by id** (WR `writeAccounts`). Their `parentaccount` is
  `""` and their names are localized UI strings ("Anlagen", "Asset accounts", …). **Do not import them
  as accounts; map them to your own roots.**
* Splits can never reference a standard account. The reader throws (RD `readSplit`, standard ids are
  excluded from `m_validAccountIds`) and the engine refuses (MF `addTransaction`).
* **Hierarchy repair on load** (AM `checkHierarchy`):
  1. Any SUBACCOUNT entry whose child does not exist, or whose child's `parentaccount` is a different
     account, is removed.
  2. Any non-standard account whose `parentaccount` does not exist is **reparented to the standard
     account of its type group** (`stdAccName(accountType)`).
  3. Any account missing from its parent's SUBACCOUNTS list is appended.
  So **`parentaccount` is the truth** and `SUBACCOUNTS` only gives display order. The tree is then built
  top-down from the five roots through SUBACCOUNTS (AM `loadSubAccounts`), so an account unreachable from
  a root (for example through a parent cycle) is silently not loaded.
* **Categories are accounts**: types 12 (Income) and 13 (Expense) under `AStd::Income` or
  `AStd::Expense`, nested to any depth with `parentaccount`. The full name shown in the UI is the path
  joined with `:` (MF `AccountSeparator`; `accountToCategory`). Category names may themselves contain
  `:` only if created outside the UI (the creation path splits on `:`, MF `createAccount`).
* Child accounts of an asset or liability may have any asset/liability type (for example a Savings under
  a Checking).

### 5.4 Currency of an account

`currency` holds the account's commodity. Every split's `shares` on that account is denominated in it (§6.3).
Asset, liability, income, expense and equity accounts use a currency id. Stock accounts use a security id.
The trading currency of a stock account is that security's `trading-currency` (ACC `tradingCurrencyId`:
"deep currency"). A foreign-currency account is one whose trading currency differs from
`kmm-baseCurrency` (ACC `isForeignCurrency`).

### 5.5 Closed accounts

KVP `mm-closed` = `yes` (boolean KVP; absent means open), and `mm-closed-date` = ISO date set when closing
(ACC `setClosed`, `isClosed`, `closingDate`). There is no XML attribute. Closed accounts still have
transactions, and splits may reference them (nothing prevents it; MF `referencesClosedAccount` is only a
UI check). Closed tags use the TAG `closed` attribute.

### 5.6 Opening balances

There is **no opening-balance field**. The balance is an ordinary transaction (MF
`createOpeningBalanceTransaction`):

* postdate = the account's `opened` date; commodity = the account's currency;
* split 1: the account, `shares = value = +balance`;
* split 2: the opening-balances equity account for that currency, `shares = value = -balance`;
* no payee, no memo, no action.

For a liability the stored balance is negative (§15.1), so the liability split is negative and the equity
split positive (sample `test-transactions-multi-currency.xml`, T…020/021).

**Opening-balances equity account.** It is chosen per currency (MF `openingBalanceAccount_internal`),
first match wins, among the descendants of `AStd::Equity`:
1. KVP `OpeningBalanceAccount == "Yes"` (case-sensitive) and `currency == <currency>`;
2. name starts with the localized `"Opening Balances"` (`i18n`, MF `openingBalancesPrefix`) and same
   currency;
3. any Equity account (type 16) with that currency.
When one is created, it gets the name `Opening Balances` (plus ` (XXX)` if not the base currency), type 16,
the currency, and `OpeningBalanceAccount=Yes` (MF `createOpeningBalanceAccount`).

**Recognising the opening-balance transaction of account A** (MF `openingBalanceTransaction`): the
first transaction on or after A's `opened` date that has a split on A **and** a split on A's
opening-balance account. Recommended importer heuristic: a transaction with exactly two splits, one on an
Equity (type 16) account flagged as above, the other on an asset/liability account → an opening balance
for that account.

Investment accounts: the opening balance goes to the **brokerage account**, not the investment account
(MF `createAccount`: `createOpeningBalanceTransaction(brokerageAccount, openingBal)`).

Loans: when created by the wizard, a "Loan payout" transaction (memo `Loan payout`) moves `loan-amount`
between the loan and `kmm-loan-payment-acc` on `kmm-loan-payment-date`. For type 5 (Loan) the loan split is
negative. An opening-balance transaction may follow (MF `createAccount`).

### 5.7 Account number, IBAN, notes

* `number` attribute = account number.
* KVP `iban` = IBAN (upper/lower case as entered). BIC comes from the institution's KVP `bic` (ACC
  `payeeIdentifiers`).
* KVP `StatementKey` = the account number found in an imported statement, used to map future statements
  (STR lines ~1492, ~1575).
* `description` attribute = notes. KVP `url` = account web page (NAD `storeKVP("url")`).

### 5.8 Investment accounts, stock accounts and brokerage

See §7.1.

### 5.9 Loan accounts (types 5 and 14): KVPs (LOAN)

| KVP | Format | Meaning |
|---|---|---|
| `loan-amount` | MyMoneyMoney | original principal |
| `ir-YYYY-MM-DD` | MyMoneyMoney | interest rate effective from that date. Several keys may exist; the rate for date D is the value of the latest key ≤ `ir-D` (LOAN `interestRate`). Value is the rate as entered in the wizard's interest-rate field (for example `4/5` = 0.8; **assumed to be % p.a.**, see §19) |
| `interest-calculation` | `paymentDue` or `paymentReceived` | when interest is calculated |
| `fixed-interest` | `yes` or `no` | `no` means variable |
| `interest-nextchange` | ISO date | next rate change (variable only) |
| `interest-changeFrequency` | `"<n>/<unit>"` | written with a capital F, **but read as `interest-changefrequency`** (LOAN `setInterestChangeFrequency` vs `interestChangeFrequency`, a source bug). Accept both |
| `term` | integer | number of payments |
| `periodic-payment` | MyMoneyMoney | payment amount |
| `final-payment` | MyMoneyMoney | last payment amount |
| `payee` | payee id | loan payee |
| `schedule` | schedule id | the loan-payment schedule (`SCH…`) |
| `compoundingFrequency` | integer occurrence code (§11.2) | for example `32` = monthly |
| `kmm-loan-payment-acc`, `kmm-loan-payment-date` | id, date | used only while the account is created, then deleted (MF `createAccount`) |

### 5.10 Other account KVPs worth importing

Listed in §13.2: credit limit (`maxCreditAbsolute`, `maxCreditEarly`), minimum balance
(`minBalanceAbsolute`, `minBalanceEarly`), `Tax`, `VatRate`, `VatAccount`, `VatAmount`, `NoVat`,
`PreferredAccount`, `lastNumberUsed`, `priceMode`, `PayeeCreation`, `CostCenter`.

---

## 6. Transactions and splits

### 6.1 TRANSACTION

```xml
<TRANSACTION id="T000000000000000001" postdate="2024-01-05" memo="" entrydate="2024-01-06" commodity="USD">
  <SPLITS> <SPLIT …/> … </SPLITS>
  <KEYVALUEPAIRS>…</KEYVALUEPAIRS>
</TRANSACTION>
```

(WR `writeTransaction`; RD `readTransaction`.)

| Attribute | Meaning |
|---|---|
| `id` | req. `T` + 18 digits |
| `postdate` | **the transaction date**. Required by the engine |
| `entrydate` | date the record was created; `""` → the reader uses today |
| `memo` | transaction-level memo, **usually empty**. The UI shows the split memo (see `fixFile_2`). Fall back to it only when split memos are empty |
| `commodity` | currency id in which **every split's `value`** is expressed (§6.3). Empty in very old files → base currency (MF `addTransaction`, `fixTransactions_0`) |
| `bankid` | name exists in NM; not written or read by current code |

TRANSACTION KVPs: `Imported` = `true` (created by statement import and not yet acknowledged; TX
`isImported`). In memory only, never persisted: `kmm-schedule-id`.

Transactions are held sorted by `uniqueSortKey = "YYYY-MM-DD-<id>"` (TX `uniqueSortKey`). The writer
emits them in that order (WR `writeTransactions` walks the journal). On read, two transactions with the
same postdate **and** id collapse to one (RD `readTransactions` map key).

### 6.2 SPLIT

```xml
<SPLIT id="S0001" payee="P000001" reconciledate="2024-01-31" action="" reconcileflag="2"
       value="-241/2" shares="-241/2" price="1/1" memo="Groceries" account="A000001"
       number="1234" bankid="FITID-XYZ" costcenter="C000001">
  <TAG id="G000001"/>                       <!-- zero or more -->
  <KEYVALUEPAIRS>…</KEYVALUEPAIRS>
</SPLIT>
```

(WR `writeSplit`; RD `readSplit`.)

| Attribute | Default if absent | Meaning |
|---|---|---|
| `id` | (ignored) | `S0001`… renumbered on load (§3.4) |
| `account` | n/a | account id. An id not among the accounts read so far makes the load fail, an empty one included: `readSplit` checks `m_validAccountIds` before `readSplits` could reach its "Dropped split" branch for an empty id, which is therefore unreachable (RD `readSplit`, `readSplits`). A standard id makes the load fail |
| `payee` | `""` | payee id. **Payees are per split**, and empty payee is normal (opening balances, many category splits) |
| `value` | 0 | amount in the **transaction commodity** |
| `shares` | 0 | amount in the **split account's commodity** (currency, or number of shares for Stock accounts). **This is what balances sum** (§15) |
| `price` | 0 | for Stock splits: price per share in the transaction commodity. For other splits: conversion rate, usually `1/1` or `0/1` when same currency. Unreliable; derive the rate as `value/shares` (SPL `possiblyCalculatedPrice`: price if non-zero, else value/shares if both non-zero, else 1) |
| `action` | `""` | action string (§6.5). Mostly empty for non-investment splits |
| `reconcileflag` | 0 | §14 |
| `reconciledate` | `""` | date reconciled |
| `memo` | `""` | the memo the user sees for this split |
| `number` | `""` | cheque number |
| `bankid` | `""` | unique id from an imported statement (for example the OFX FITID); used for duplicate detection |
| `costcenter` | `""` | cost center id (written only if set) |

Invariant enforced on load: **`shares` and `value` must have the same sign, or one of them must be zero**.
Otherwise `addSplit` throws "Cannot add split where sign of shares differs from sign of value" and the load
fails (TX `addSplit` → SPL `signsValid`). The engine also flips `value`'s sign to match `shares` when
storing (MF `adjustSplitSign`).

### 6.3 value vs shares, commodity, multi-currency

* `value` is in `TRANSACTION@commodity`. `shares` is in `ACCOUNT@currency` of the split's account (SPL
  `value(transactionCurrencyId, splitCurrencyId)` returns value if the ids are equal, else shares).
* **Same currency** (account currency == commodity): `shares == value` (enforced by `fixTransactions_0`,
  MF). `price` is `1/1`.
* **Balanced transaction**: Σ `value` over all splits = 0. Not enforced. A transaction whose split values
  do not sum to zero is flagged "erroneous" in the UI (JM `TransactionErroneousRole`:
  `!splitSum().isZero()`). Single-split "uncategorized" transactions exist
  (`kmymoney/mymoney/fixuncategroziedtransactions.cpp`). **Import them, don't drop them**, and flag them.
* **Cross-currency transfer** (sample `test-transactions-multi-currency.xml`, T…011): commodity EUR;
  EUR-account split `value=-30224 shares=-30224`; USD-account split `value=30224` (EUR),
  `shares=3497823/100` (= 34978.23 USD), `price=3022400/3497823` (= value/shares = EUR per USD). The rate
  is implicit in `value/shares` of the foreign split: **1 unit of the split account's currency =
  value/shares units of the transaction commodity**. The editor usually also records a PRICE entry for the
  pair on that date (ITE stores `assetPrice` with source `"KMyMoney"`; the cross-currency sample has
  `PRICEPAIR EUR→USD`).
* **Category in a foreign currency** (same file, T…013): commodity USD; the EUR expense category split
  gets `value` in USD and `shares` in EUR.
* Which currency is the commodity: the editor uses the currency of the account the transaction was entered
  in. For investment transactions it is the security's trading currency (ITE `setSecurity`:
  `transaction.setCommodity(sec.tradingCurrency())`).

### 6.4 Transaction shapes

All are built from splits. Classification as done by `KMyMoneyUtils::transactionType` (KU):

1. If any split's account is a Stock account (type 15), or (fallback) any split's account is an
   Investment account (type 7): **InvestmentTransaction** (KU `stockSplit`).
2. else if splitCount < 2: **Unknown** (single-split; also stock splits and add/remove shares, but those were
   already caught in step 1).
3. else if splitCount > 2: **SplitTransaction** (multi-split).
4. else (exactly 2) if both accounts are in the Asset or Liability group: **Transfer**.
5. else: **Normal** (one asset/liability split + one category split).

`MyMoneyFile::isTransfer` differs slightly (MF): true unless it has exactly two splits and one of them is a
category. So multi-split transactions count as transfers there. Use KU's version.

Examples:
* **Simple expense**: checking `shares=value=-X`, expense category `+X`.
* **Income**: checking `+X`, income category `-X`.
* **Transfer**: source asset `-X`, destination asset `+X`. A loan payment to a Loan account is `+X` on the
  loan (reduces the negative balance). The engine rewrites the `Transfer` action to `Amortization` on
  asset/liability splits of transactions touching a loan (MF `addTransaction`).
* **Multi-split**: one asset/liability split and n ≥ 2 category (or other account) splits whose values
  sum to the negated asset split. Each split has its own memo, payee and tags.
* **Loan payment** (posted from a type-5 schedule): payment-account split `-P`, `Amortization` split on
  the loan account (principal, `+`), `Interest` split on an expense category (`+`), optional fee splits
  (sample `test-refinance-loan.xml`).

### 6.5 Split action strings (SPL `actionNamesLUT`; EN `Split::Action`)

| `action` value | Enum | Used for |
|---|---|---|
| `""` | n/a | normal |
| `Check` | Check | cheque |
| `Deposit` | Deposit | |
| `Transfer` | Transfer | |
| `Withdrawal` | Withdrawal | |
| `ATM` | ATM | |
| `Amortization` | Amortization | loan principal split |
| `Interest` | Interest | loan interest split |
| `Buy` | BuyShares | **buy and sell** (sell = negative shares) |
| `Dividend` | Dividend | |
| `Reinvest` | ReinvestDividend | |
| `Yield` | Yield | |
| `Add` | AddShares | **add and remove shares** (remove = negative shares) |
| `Split` | SplitShares | stock split |
| `IntIncome` | InterestIncome | interest income in an investment account |

There is no `Sell` string: "SellShares is not present as action" (SPL comment). The current transaction
editor writes an empty action for non-investment splits (`kmymoney/views/newtransactioneditor.cpp`:
`split.setAction(QString())`). Do not rely on `Deposit`/`Withdrawal`; use signs.

### 6.6 Payee of a transaction

Payee is a split attribute. The UI shows the payee of the split belonging to the account being viewed.
Recommendation: take the payee of the asset/liability split. If it is empty, take the first non-empty
payee among the other splits. Dangling payee ids get placeholders in KMyMoney (§2.3).

### 6.7 Tags, cost centers, numbers

* Tags: `<TAG id="G…"/>` children of SPLIT, any number, in order (RD `readSplit`; WR `writeSplit`).
* `costcenter` attribute.
* `number` (cheque number). Account KVP `lastNumberUsed` holds the highest cheque number (MF
  `highestCheckNumberUsed`).

### 6.8 Matched transactions (KVP on a SPLIT)

When the user matches an imported transaction `ti` with a manually entered one `tm` (TM `match`):

* `tm` is kept and `ti` is **deleted** from the journal. A full copy of `ti` is stored inside the matching
  split of `tm` as KVP **`kmm-matched-tx`**: an XML string `<!DOCTYPE MATCH><CONTAINER><TRANSACTION …>…
  </TRANSACTION></CONTAINER>` in which every `<` is replaced by `&#60;` before being placed in the
  attribute (WR `writeSplit`). The XML writer then escapes `&`, so on disk it reads
  `value="&amp;#60;!DOCTYPE MATCH>…"`. Older files used `&lt;`. The reader replaces `&#60;` (or else `&lt;`)
  with `<` and parses the nested transaction (RD `readSplit`).
* Additional split KVPs: `kmm-match-split` (id of the matched split inside the embedded transaction),
  `kmm-orig-payee`, `kmm-orig-memo` (`"\xff\xff\xff\xff"` is used as a sentinel so that empty originals are
  still stored), `kmm-orig-postdate` (ISO date), `kmm-orig-not-reconciled` (`yes`), `kmm-orig-onesplit`
  (`yes`). These allow "unmatch".
* Side effects on `tm`: split marked Cleared if it was not reconciled; payee and postdate may be taken from
  `ti`; memos concatenated with `\n`; `bankid` copied from `ti`.
* **For import: ignore `kmm-matched-tx` and the `kmm-orig-*` keys.** The embedded transaction is not part
  of the ledger; it is a duplicate. Do keep `bankid` for de-duplication. Note that the embedded transaction's
  splits are also validated against known accounts on load (RD `readSplit` recursion), so a reference to a
  deleted account in there breaks KMyMoney's own load.

---

## 7. Investments

### 7.1 Account structure

* An **Investment** account (type 7) is a container. Its `currency` is a currency (for example `USD`).
* Each holding is a **Stock** account (type 15), `parentaccount` = the investment account, `currency` =
  the **security id** (`E000001`). There is one stock account per security per investment account (the
  move-transaction code looks up "the stock account in this investment account with currency = security
  id": `kmymoney/kmymoney.cpp moveInvestmentTransaction`).
* The **brokerage (cash) account** is a separate ordinary asset account (normally type 1 Checkings),
  usually a **sibling** under the same parent as the investment account (samples: `Shares` (7) and
  `Shares (Brokerage)` (1) both under `AStd::Asset`). The association is **by name only**:
  `MyMoneyAccount::brokerageName()` = `"<investment name> (Brokerage)"` with "Brokerage" localized
  (ACC). The statement importer also honours an investment-account KVP `kmm-brokerage-account` = account id
  (STR lines ~696, ~960; never written by core code). Per transaction, the cash side is whatever
  asset/liability split is in the transaction (§7.3), so you do not need the association to import
  transactions correctly. Use it only to present the brokerage account under the investment account.
* Stock account KVP `priceMode` (also possible on the investment account) is a UI hint for price entry:
  0 Price, 1 PricePerShare, 2 PricePerTransaction (EN `Invest::PriceMode`; ACC `priceMode`; IA
  `priceMode` walks up the parents).

### 7.2 How each activity is stored

Derived from the investment editor (IA activity classes; ITE `saveTransaction`) and confirmed against the
sample `test-investment.xml`. Notation: S = stock split (on the Stock account), A = asset/brokerage split,
F = fee split(s) on Expense categories, I = "interest" split(s) on Income categories. The transaction
commodity is the security's trading currency. Signs are of `shares`/`value`.

| Activity | S.action | S.shares | S.value | S.price | A | F | I |
|---|---|---|---|---|---|---|---|
| **Buy** | `Buy` | `+N` | `+N×p` (cost of shares) | `p` | `−(S.value + ΣF + ΣI)` = −total paid | `+fee` | `−amount` (rare, for example accrued interest) |
| **Sell** | `Buy` | `−N` | `−N×p` | `p` | `+(N×p − fees + …)` = +net proceeds | `+fee` | `−amount` (for example "capital gains" category if the user puts one) |
| **Dividend** | `Dividend` | `0` | `0` | 0 (samples show `1/1`; ignore) | `+net` | `+fee/withholding` | `−gross` on the dividend income category |
| **Yield** | `Yield` | `0` | `0` | 0 | `+net` | `+fee` | `−gross` |
| **Interest income** | `IntIncome` | `0` | `0` | 0 | `+net` | `+fee` | `−gross` |
| **Reinvest dividend** | `Reinvest` | `+N` (forced positive, IA `Reinvest::adjustStockSplit`) | `+N×p` | `p` | only if a cash remainder exists (asset account required only if the total ≠ 0, IA) | `+fee` | `−gross` (income category) |
| **Add shares** | `Add` | `+N` | `0` | `0` | none | none | none |
| **Remove shares** | `Add` | `−N` | `0` | `0` | none | none | none |
| **Stock split** | `Split` | **ratio** (see §7.4) | `0` | `0` | none | none | none |

Details and sources:
* The editor builds `t` as: A first (only when the activity's asset account is not "Unused"), then S, then
  fee splits, then interest splits (ITE `saveTransaction`). Order is not semantic.
* Total: `totalAmount = S.value + Σfee.value + Σinterest.value` and `A.value = −totalAmount` (IA
  `Activity::totalAmount`; ITE `updateTotalAmount`). Fee amounts are entered positive (factor +1); interest
  amounts are entered positive and stored negative (factor −1, IA `interestFactor`; ITE `amountChanged(…,
  MINUS_ONE)`).
* Sell uses `sharesFactor = −1` with action `"Buy"` (IA `Sell`). Remove uses `"Add"` with factor −1 (IA
  `Remove`).
* Dividend/Yield/IntIncome: when switching to these activities the editor sets
  `S.shares = S.value = S.price = 0` ("dividend payments don't affect the number of shares", ITE). S still
  exists so the transaction is tied to the security. Sample `test-investment.xml` T…002: A `+2715`, income
  `−2715`, S `Dividend 0/0 price=1/1`.
* Add/Remove/Split: `adjustStockSplit` zeroes value and price (IA). These are **single-split transactions**
  (sample: `<SPLIT action="Add" value="0/1" shares="5/1" price="0/1"/>` alone).
* Cross-currency brokerage: if the brokerage account's currency differs from the commodity, A has
  `value` in the trading currency and `shares = value / rate` in the brokerage currency (ITE
  `updateTotalAmount`, `assetPrice`).
* Rounding: S.shares to the security `saf`, all values to the commodity `saf`, other splits' shares to the
  commodity fraction, using the security's rounding method (RoundRound if RoundNever) (ITE
  `saveTransaction`).
* On save, for action `"Buy"` (so both buys **and sells**) a PRICE `security → trading currency` with
  source `"Transaction"` is added for the post date (ITE `storePrice`). The code also tests for
  `"Reinvestset"`, a typo, so reinvestments do not create prices.
* Statement import (OFX/QIF/CSV) produces the same shapes, with `Buy`/`Sell` → `Buy`, `Shrsin`/`Shrsout` →
  `Add` ±, `CashDividend` → `Dividend`, `ReinvestDividend` → `Reinvest`, `Interest` → `IntIncome` (STR lines
  ~830–955). Imported **stock splits are not supported** by the QIF reader (commented out,
  `plugins/qif/import/mymoneyqifreader.cpp` ~line 1607).

### 7.3 Reader-side classification algorithm (what KMyMoney does)

1. **Is it an investment transaction?** `MyMoneyFile::isInvestmentTransaction` (MF): some split has a
   recognised investment action (`investmentTransactionType() != Unknown`) **and** its account is a Stock
   account. (KU `transactionType` is looser: any split on a Stock account, else any split on an
   Investment account.)
2. **Find the stock split** S: the first split whose account is type 15 (KU `stockSplit`; ITE
   `adjustToSecuritySplitIdx`).
3. **Dissect** (MU `dissectTransaction`), for every other split:
   * account group Expense → fee split;
   * account group Income → interest/dividend split;
   * else (asset/liability/equity): the **first** such split is the asset (brokerage/cash) split; any
     further one goes to fees if its value is negative, or to interest if it is positive.
4. **Activity** = `S.investmentTransactionType()` (SPL):
   `Buy` → BuyShares if shares ≥ 0, else SellShares; `Add` → AddShares if shares ≥ 0, else RemoveShares;
   `Dividend`, `Yield`, `Reinvest`, `Split`, `IntIncome` → the obvious types; **anything else (including
   empty) → BuyShares** (MU `dissectTransaction` default).
   InvestmentTransactionType ints (EN): `-1 Unknown, 0 BuyShares, 1 SellShares, 2 Dividend,
   3 ReinvestDividend, 4 Yield, 5 AddShares, 6 RemoveShares, 7 SplitShares, 8 InterestIncome`.
5. The security is `S.account.currency`; the currency is `TRANSACTION@commodity`.

Recommended importer mapping:
`fees = Σ F.value`, `interest_or_income = −Σ I.value`, `cash = A.shares` (in the brokerage currency),
`quantity = |S.shares|`, `price = S.price` (or `S.value/S.shares`), `gross = |S.value|`.

### 7.4 Stock split ratio

* Single split, `action="Split"`, `value=0`, `price=0`, **`shares` = multiplication factor applied to the
  running share balance**: new balance = old balance × shares, rounded to the security's `saf` (JM
  `updateBalances` / `stockSplit`; ACC `adjustBalance`: `m_balance = m_balance * s.shares()`). A 2-for-1
  split is `shares="2/1"`; a 1-for-10 reverse split is `shares="1/10"`.
* Not rounded on save (MF `fixSplitPrecision` skips `Split`; ITE "Don't do any rounding on a split
  factor").
* The UI label is "Ratio 1/" and the ledger shows `"1 / <shares>"` (IA `Split::sharesLabelText`; JM
  `Quantity` column). This presentation is confusing; trust the balance math above. QIF `stksplit`
  quantity Q maps to factor Q/10 (for example 20 → 2), consistent with multiplication.
* KMyMoney recognises a stock-split *transaction* only if it has **exactly one split** with action
  `Split` (TX `isStockSplit`). A `Split` split inside a multi-split transaction is summed as ordinary
  shares (JM checks `transaction().isStockSplit()`).

### 7.5 Moving securities between brokerage accounts

There is no "transfer shares" activity. The editor permits one stock split per transaction. In practice
users record **Remove shares** (`Add`, −N) in the source investment account and **Add shares** (`Add`,
+N) in the destination, two independent single-split transactions with value 0, so the cost basis is
lost. (The app also offers "move transaction to another investment account", which rewrites the
transaction's stock split to a stock account in the other investment account, creating it if needed:
`kmymoney.cpp moveInvestmentTransaction`. That changes history rather than recording a transfer.) An
importer can pair `Add −N` / `Add +N` for the same security on the same date as a possible transfer. This
is a heuristic, **[not from source]**.

---

## 8. Securities and currencies

### 8.1 Elements

```xml
<SECURITIES>
  <SECURITY id="E000001" name="BHP Group Limited" symbol="BHPLF" type="0" rounding-method="7"
            saf="100" pp="2" trading-currency="AUD" trading-market="FRA">
    <KEYVALUEPAIRS>
      <PAIR key="kmm-security-id" value="AU000000BHP4"/>
      <PAIR key="kmm-online-source" value="Yahoo Finance"/>
    </KEYVALUEPAIRS>
  </SECURITY>
</SECURITIES>
<CURRENCIES>
  <CURRENCY id="AUD" name="Australian Dollar" symbol="$" type="3" rounding-method="7" saf="100" pp="4" scf="100"/>
</CURRENCIES>
```

(WR `writeSecurity`; RD `readSecurity`.)

| Attribute | Meaning | Default on read |
|---|---|---|
| `id` | `E…` for securities, ISO code for currencies | req. |
| `name` | full name | |
| `symbol` | trading symbol (ticker) for securities; currency **sign** (`€`, `$`) for currencies | |
| `type` | §8.2 | 0 |
| `rounding-method` | §3.1 enum | 0 (RoundNever) if missing |
| `saf` | **smallest account fraction**: denominator for amounts or shares held in accounts (100 → 0.01; 1000 → 0.001 shares; JPY = 1; BTC = 100000000) | 0 → **100** |
| `pp` | price precision (decimal places shown for prices) | 0 or > 10 → **4** |
| `scf` | currencies only: smallest **cash** fraction (used for Cash accounts) | 0 → 100 |
| `trading-currency` | securities only: currency id the security is priced/traded in | `""` |
| `trading-market` | securities only: exchange name (free text) | `""` |

The writer chooses `CURRENCY` vs `SECURITY` by `isCurrency()` (type == 3). The reader accepts only
`SECURITY` children inside SECURITIES and only `CURRENCY` children inside CURRENCIES. Others are skipped
(RD `readSecurities`, `readCurrencies`). For example `testfile3.xml` has a `<SECURITY>` inside
`<CURRENCIES>`, which is ignored. The `EQUITY` node name is accepted by `readSecurity` but never written.
For a CURRENCY, `scf` is read only if `type` is 3; otherwise `trading-currency` is read (RD).

### 8.2 Security type enum (EN `Security::Type`)

`0 Stock, 1 MutualFund, 2 Bond, 3 Currency, 4 None`. A **currency** is simply a security of type 3 stored in
CURRENCIES. Its id is the ISO code, it has `scf`, no trading currency, and its exchange rates are PRICEs.
Old files may list ~185 currencies including obsolete ones (ATS, DEM, …) with fixed conversion prices
(sample `test-385993.xml`: `PRICEPAIR from="ATS" to="EUR" price="10000/137603" source="KMyMoney"`).

### 8.3 Security KVPs

| Key | Meaning | Source |
|---|---|---|
| `kmm-security-id` | "investment identification": ISIN, WKN, CUSIP or other identifier as entered or imported (statement `m_strId`) | `wizards/newinvestmentwizard/knewinvestmentwizard.cpp`; STR ~619–633 |
| `kmm-online-source` | online quote source name (for example `Yahoo Finance`, `Yahoo.com [Stock]`) | same; `misc/onlinepriceupdater.cpp` |
| `kmm-online-quote-system` | `Finance::Quote` or absent (= native, profile `kmymoney5`) | `konlineupdatewizardpage.cpp` |
| `kmm-online-factor` | MyMoneyMoney factor applied to downloaded quotes | same; `onlinepriceupdater.cpp` |

When `kmm-online-quote-system` is in use, `kmm-security-id` may be the symbol sent to the quote source
(`onlinepriceupdater.cpp` ~line 180).

---

## 9. Prices

```xml
<PRICES>
  <PRICEPAIR from="E000001" to="AUD">
    <PRICE date="2022-01-10" price="449/10" source="Transaction"/>
  </PRICEPAIR>
  <PRICEPAIR from="EUR" to="USD">
    <PRICE date="2023-01-01" price="11573/10000" source="User"/>
  </PRICEPAIR>
</PRICES>
```

(WR `writePrices`; RD `readPricePair`.)

* **Semantics:** `price` = the value of **1 unit of `from`, expressed in units of `to`** on `date` (PR
  `rate(id)`: `rate(to) = m_rate`, `rate(from) = 1/m_rate`). The sample `EUR→USD 1.1573` means
  1 EUR = 1.1573 USD.
* Security prices: `from` = security id, `to` = its trading currency (ITE `storePrice`). Exchange rates:
  `from` = currency, `to` = currency. Either direction may exist. Lookup tries the exact pair, then the
  inverse, then the most recent on or before the date in either direction (MF `price`).
* The writer **omits** pairs where `from` is a currency and `to` is not a currency, and pairs with unknown
  ids (WR `writePrices`). Expect only security→currency and currency→currency.
* At most one price per (from, to, date): a later duplicate overwrites (RD `prices[pair][date] = price`).
* `source` is free text: `User`, `Transaction` (recorded when entering a buy/sell), `KMyMoney` (built-in
  or exchange rate from a transaction, ITE), `Finance::Quote`/online source names, `test`.

---

## 10. Payees, tags, cost centers, institutions

### 10.1 PAYEE

```xml
<PAYEE id="P000001" name="City Power" reference="CUST-42" email="billing@example.invalid"
       notes="…" matchingenabled="1" usingmatchkey="1" matchignorecase="1" matchkey="CITY POWER&#10;"
       defaultaccountid="A000008" idpattern="\d{2,4}\b" urltemplate="http://…/%1">
  <ADDRESS street="" city="" state="" zip="" telephone="" …/>
  <payeeIdentifier id="1" type="org.kmymoney.payeeIdentifier.ibanbic" iban="…" bic="…" ownerName="…"/>
  <payeeIdentifier id="2" type="org.kmymoney.payeeIdentifier.national" accountnumber="…" bankcode="…" ownername="…" country="…"/>
</PAYEE>
```

(WR `writePayee`; RD `readPayee`; PAY `matchData`/`setMatchData`.)

* `notes` is written only if non-empty, `defaultaccountid` only if set, `idpattern`/`urltemplate` only if
  set (WR).
* **Default category**: `defaultaccountid` (an account id, normally a category).
* **Matching** (how imported transactions are auto-assigned to this payee). The MatchType enum is
  `0 Disabled, 1 Name, 2 Key, 3 NameExact` (EN `Payee::MatchType`), stored as:
  * `matchingenabled="0"` → Disabled (other attributes not written);
  * `matchingenabled="1" usingmatchkey="0"` → Name (match on the payee name), except
    `matchkey="^$"` → NameExact;
  * `matchingenabled="1" usingmatchkey="1"` → Key: `matchkey` holds the keys separated by `\n` (written
    `&#10;`). A single key carries a trailing `\n`. Old 4.8 files separate keys with `;`. Empty entries are
    removed.
  * `matchignorecase` 0/1.
  * All three are read with `readUintAttribute` (XH): empty means the default 0, otherwise
    `QString::toUInt(base 0)`, so an unparsable value (`"true"`) is 0. `matchignorecase` absent is 0
    (case-sensitive).
  * Reading goes through `setMatchData(type, ignorecase, QString)`: split on `\n` when the value holds
    one, else on `;`; keep only keys containing a character other than a space; then `matchData`
    removes empty entries. Keys are **not** trimmed.
* **How a match is applied** (STR, statement import; the only place the engine uses these keys). For
  a non-empty imported payee text T, every payee with matching enabled contributes patterns: Name
  `QRegularExpression::escape(name)`; NameExact `^` + escape(name) + `$`; Key each key as written. Each
  is compiled as a `QRegularExpression` (PCRE2) with `CaseInsensitiveOption` when `matchignorecase` is
  set and no other option, and **searched** in T (`match`, unanchored unless the pattern says `^`/`$`).
  Every hit records `capturedLength`; the payee with the longest match wins (a `QMap` keyed by length,
  so on equal lengths the payee met later in the payee list wins). No match: a payee named T is created
  (per the account's `PayeeCreation` policy) with Key matching, case-insensitive, and the single key
  `^` + escape(T) + `$`. `QRegularExpression::escape` backslash-escapes every character outside
  `[A-Za-z0-9_]`, spaces included, so a statement-created key reads `^THE\ AMERICAN\ CHE\ CONS\ PAY$`
  (`test-441023.xml`). When T and the matched payee's name differ (ignoring case) KMyMoney may keep T in
  the memo (`keepOriginalPayeeInfo`).
* A payee created by hand starts as NameExact, case-insensitive (KU). The payee view labels the modes
  "No matching", "Match Payees name (partial)", "Match Payees name (exact)" and "Match on a name listed
  below" (PV). Merging payees with "add to matching list" appends the merged payees' names to the
  target's keys **unescaped** (`^name$` for an exact one), so such a key is a regular expression whose
  `.`, `(` or `+` are metacharacters (PV).
* The default category combo offers asset, liability, income, expense and equity accounts (PV), so
  `defaultaccountid` is not always a category. STR uses it only when an imported transaction has no
  split of its own: it adds a split to that account for the opposite amount.
* `payeeIdentifier` children: `ibanbic` (attributes `iban`, `bic`, `ownerName`) or `national`
  (`accountnumber`, `bankcode`, `ownername`, `country`). **An unknown `type` makes KMyMoney's reader raise
  an XML error** (RD `readPayeeIdentifier`). An importer should skip it.
* `reference`: free-text customer or reference number.

### 10.2 TAG, COSTCENTER, INSTITUTION

§4.5, §4.4, §4.2.

---

## 11. Schedules

### 11.1 Element

```xml
<SCHEDULED_TX id="SCH000001" name="Electricity" type="1" occurence="32" occurenceMultiplier="1"
              paymentType="1" startDate="2024-02-01" endDate="" fixed="0" lastDayInMonth="0"
              autoEnter="0" lastPayment="2024-02-01" weekendOption="1">
  <KEYVALUEPAIRS>…</KEYVALUEPAIRS>
  <PAYMENTS> <PAYMENT date="…"/> </PAYMENTS>
  <TRANSACTION id="" postdate="2024-03-01" memo="" entrydate="" commodity="USD">   <!-- template -->
    <SPLITS>…</SPLITS>
  </TRANSACTION>
</SCHEDULED_TX>
```

(WR `writeSchedule`; RD `readSchedule`. Note the attribute **spellings `occurence` and
`occurenceMultiplier`**, NM.)

| Attribute | Meaning | Read default |
|---|---|---|
| `name` | display name | |
| `type` | 1 Bill, 2 Deposit, 4 Transfer, 5 LoanPayment (0 Any = invalid) (EN `Schedule::Type`) | 0 |
| `occurence` | occurrence code §11.2 | 0 |
| `occurenceMultiplier` | every *n* periods (values < 1 become 1) | 1 |
| `paymentType` | 1 DirectDebit, 2 DirectDeposit, 4 ManualDeposit, 8 Other, 16 WriteCheque, 32 StandingOrder, 64 BankTransfer (0 Any = invalid) (EN `Schedule::PaymentType`) | 0 |
| `startDate` | first due date | |
| `endDate` | last date (`""` = open-ended) | |
| `lastPayment` | date of the last entered occurrence (`""` = never) | |
| `fixed` | 1 = fixed amount; 0 = estimate. The forecast assumes ±10% variation (SCH `variation`) | 0 |
| `autoEnter` | 1 = enter automatically when due | 0 |
| `lastDayInMonth` | 1 = always due on the last day of the month | 0 |
| `weekendOption` | 0 MoveBefore, 1 MoveAfter, 2 MoveNothing; invalid → 2 (EN; SCH `setWeekendOption`) | 0 (MoveBefore) |

The **template TRANSACTION** (id `""`) holds the splits that will be entered. **Its `postdate` is the next
due date** (SCH `nextDueDate`). `entrydate` should be `""` (§2.4). Template splits must have reconcileflag 0
(`fixSchedule_0`) and their `bankid` is cleared (SCH `setTransaction`). Loan-payment templates have
auto-calc amounts on the `Amortization` and `Interest` splits (§3.1).

`PAYMENTS`: the writer writes `<PAYMENTS><PAYMENT date="…"/>…</PAYMENTS>` (recorded out-of-sequence payments),
but **the reader reads a `date` attribute on `PAYMENTS` itself** and never descends into `PAYMENT` (RD
`readSchedule`, with a "check if this code is actually used" todo). In practice recorded payments do not
survive a load. Treat `PAYMENT` dates as "already paid" occurrences if present.

Which account a schedule belongs to: the first split whose account is an asset or liability (SCH
`account()`). For a Transfer the second such split is the counter account (`transferAccount`).

### 11.2 Occurrence codes (EN `Schedule::Occurrence`; SCH `simpleToCompoundOccurrence`)

Base codes, as stored by current versions:
`1 Once, 2 Daily, 4 Weekly, 18 EveryHalfMonth, 32 Monthly, 16384 Yearly`, each combined with
`occurenceMultiplier` *m*.

Legacy compound codes (normalised on read to base × multiplier; the stored multiplier is multiplied):

| Code | Name | Normalised |
|---|---|---|
| 8 | Fortnightly | Weekly ×2 |
| 16 | EveryOtherWeek | Weekly ×2 |
| 20 | EveryThreeWeeks | Weekly ×3 |
| 30 | EveryThirtyDays | Daily ×30 |
| 64 | EveryFourWeeks | Weekly ×4 |
| 126 | EveryEightWeeks | Weekly ×8 |
| 128 | EveryOtherMonth | Monthly ×2 |
| 256 | EveryThreeMonths | Monthly ×3 |
| 4096 | Quarterly | Monthly ×3 |
| 8192 | EveryFourMonths | Monthly ×4 |
| 1024 | TwiceYearly | Monthly ×6 |
| 2048 | EveryOtherYear | Yearly ×2 |
| other | unknown | Any (0): invalid schedule |

Algorithm (SCH): if code ∈ {1, 2, 4, 18, 32, 16384}, keep it with multiplier m; else map as in the table
with `multiplier = newMulti × m` (when newMulti ≠ 1). The writer then writes the base code and the
combined multiplier (WR writes `schedule.occurrence()` = base). "Every half month" ×1 = twice a month
(SCH `addHalfMonths`).

### 11.3 Next due date (what to import as "next due")

`nextDueDate = template.postdate`. If `lastDayInMonth` is set, use the last day of that month instead
(adjusted by the weekend option) (SCH `nextDueDate`). The weekend-adjusted date is
`adjustedDate(date, weekendOption)`: while the date is not a processing day, step −1 day (MoveBefore) or
+1 day (MoveAfter); MoveNothing leaves it (SCH `adjustedDate`). Processing days come from the user's app
settings plus an optional holiday region, not from the file (`kmymoney.cpp isProcessingDate`; default
without a calendar is Mon–Fri, SCH `isProcessingDate`). **Import the unadjusted `nextDueDate`** plus the
weekend option.

A schedule is **finished** (SCH `isFinished`) when `lastPayment` is set and either
(`endDate` set and (`lastPayment ≥ endDate` or no next due date or `nextDueDate > endDate`)) or
occurrence == Once.

### 11.4 How KMyMoney computes subsequent dates

`nextPaymentDate(adjust, refDate)` (SCH):
1. If `endDate` (adjusted) is valid and `< refDate`: no more payments.
2. `due = nextDueDate`, `pay = adjusted(due)`.
3. If `pay ≤ refDate` or `due` is in recorded payments, step forward until it isn't:
   Once → none (if `lastPayment` is set or `pay ≤ refDate`); Daily → +m days; Weekly → +7m days;
   EveryHalfMonth → `addHalfMonths(due, m)`; Monthly → `addMonths(m)` then `fixDate`; Yearly →
   `addYears(m)` then `fixDate`.
   `fixDate` restores the start date's day-of-month (or the last day of the month if `lastDayInMonth`)
   when that day exists in the target month, so 31 Jan → 28/29 Feb → 31 Mar, not 28 Mar.
4. A result after the adjusted `endDate` means none.

On **load** (RD `readSchedule`), when the template has no postdate:
* if `lastPayment` is also empty: `postdate := startDate` and the start date is cleared ("never used");
* if `nextDueDate ≤ lastPayment` (inconsistent old data): the postdate is cleared, then
  `postdate := nextPayment(lastPayment + 1 day)` computed from `startDate`.
An importer should replicate: if the template postdate is empty or ≤ `lastPayment`, compute the first
occurrence after `lastPayment` from `startDate` with the step rules above.

Mapping to a recurring bill/deposit/transfer: cadence = (base occurrence, multiplier); next due =
§11.3; amount = the template's asset-split `shares` (negative = outflow), or "variable/estimate" if
`fixed=0`; for type 5 the amount is the periodic payment with computed principal/interest. Category =
the template's category split(s); payee = the template's split payee.

---

## 12. Budgets

```xml
<BUDGET id="B000001" name="2024" start="2024-01-01" version="2">
  <ACCOUNT id="A000009" budgetlevel="monthly" budgetsubaccounts="0" type="expense">
    <PERIOD amount="400/1" start="2024-01-01"/>
  </ACCOUNT>
</BUDGET>
```

(XH `writeBudget`/`readBudget`.) Inside BUDGET, `ACCOUNT` means a budget line, not an account definition.

* `budgetlevel`: `none`, `monthly` (one PERIOD whose amount applies **to every month**; the yearly total
  is ×12, `mymoneybudget.cpp totalBalance`), `monthbymonth` (12 PERIODs, one per month start),
  `yearly` (one PERIOD = the whole-year amount). An unknown value maps to Max (invalid) (XH
  `stringToBudgetLevel`).
* `budgetsubaccounts` 0/1: the line also covers sub-categories.
* `type` (optional): account-type string (§5.2) for the line.
* PERIOD `amount` (MyMoneyMoney) and `start` (date). Zero periods are not written. Lines with zero total
  and no subaccount flag are not written (XH `writeBudget`).

---

## 13. Key/value pair catalogue

Value formats: **MM** = MyMoneyMoney rational string; **bool** = `yes`/`no`, absent = default; **date** =
ISO.

### 13.1 File level (top-level `<KEYVALUEPAIRS>`)

| Key | Format | Meaning / source |
|---|---|---|
| `kmm-baseCurrency` | currency id | **base currency** (MF `setBaseCurrency`, `price` default `to`). Required to interpret totals |
| `kmm-id` | `{uuid}` | file identity (MF `storageId`) |
| `LastModificationDate` | ISO datetime | duplicate of FILEINFO, written "for compatibility, bug 498419" (WR `writeKMyMoney`) |
| `kmm-encryption-key` | comma-separated GPG key ids | keys the file was encrypted for (XS) |
| `kmm-lastConsistencyFailed` | date | last failed consistency check (`kmymoney.cpp`) |
| `kmm-sort-*`, `kmm-iconpos`, view and sidebar keys | UI state | ignore |
| online price update last-run keys | date | ignore (`misc/onlinepriceupdater.cpp`) |

### 13.2 Account level

| Key | Format | Meaning | Source |
|---|---|---|---|
| `mm-closed` | bool | account closed | ACC `isClosed` |
| `mm-closed-date` | date | when closed | ACC `closingDate` |
| `OpeningBalanceAccount` | `Yes`/`yes` | equity account used for opening balances | MF; NAD |
| `iban` | text | IBAN | NAD; RD (`IBAN` legacy) |
| `url` | text | account web URL | NAD |
| `StatementKey` | text | account id from imported statements | STR |
| `lastImportedTransactionDate` | date | end date of the last imported statement | STR ~462; REC ~274 |
| `lastStatementBalance` | MM | closing balance of the last imported or reconciled statement | STR ~464; REC ~276 |
| `lastStatementDate` | date | **obsolete**, deleted on read | RD |
| `statementBalance`, `statementDate` | MM, date | transient: reconciliation in progress (deleted when finished or cancelled) | REC |
| `lastReconciledBalance` | MM | transient, deleted on reconcile start | REC |
| `reconciliationHistory` | `date:MM;date:MM;…` | legacy history (also written today in parallel to `<RECONCILIATIONS>`) | ACC `addReconciliation` |
| `lastNumberUsed` | text | last cheque number | MF; NAD |
| `PreferredAccount` | bool | marked favourite | AM; NAD |
| `Tax` | bool | include in tax reports | ACC `isInTaxReports` |
| `VatRate` | MM fraction | VAT rate as a **fraction** (19% → `19/100`; the UI shows ×100) | NAD ~449–454 |
| `VatAccount` | account id | the VAT account this category posts VAT to | NAD |
| `VatAmount` | `Net` or absent | category amounts are net (`Net`) or gross (absent) | NAD |
| `NoVat` | bool | exclude from VAT handling | NAD |
| `UnresolvedVatAccount` | n/a | temporary, used while loading account templates, then resolved | `kmymoney/templates/templateloader.cpp` |
| `CostCenter` | bool | cost center required for this category | ACC |
| `PayeeCreation` | int 0–3 | per-account payee-creation policy for imports: 0 ApplicationDefault, 1 NoCreation, 2 AskUser, 3 Automatic (EN `Account::PayeeCreation`) | ACC |
| `priceMode` | int 0–2 | §7.1 | ACC |
| `budgetAccountType` | int | override account type for budgets | ACC |
| `maxCreditAbsolute`, `maxCreditEarly` | MM | credit limit and early-warning level. **Stored with reversed sign relative to what the dialog shows** (NAD stores `value × −1`). Compared directly with the internal balance (`sepacredittransferedit.cpp`: `expectedBalance < maxCreditAbsolute`). Example: an asset account with a 1000 overdraft limit stores `-1000/1`. Liability semantics: §19 | NAD; `kbalancechartdlg.cpp` |
| `minBalanceAbsolute`, `minBalanceEarly` | MM | minimum balance and early-warning level (same sign as the balance) | NAD; `mymoneyforecast.cpp` |
| `minimumBalance` | MM | legacy minimum balance, migrated by the dialog | NAD |
| `kmm-brokerage-account` | account id | optional explicit brokerage link | STR |
| loan keys | | §5.9 | LOAN |
| `kbanking-*`, `kmmofx-*`, `wb-*` | | online-banking plugin state | plugins |

### 13.3 Transaction level

| Key | Format | Meaning |
|---|---|---|
| `Imported` | `true` | imported from a statement and not yet edited or reconciled (TX; REC clears it on reconcile) |

### 13.4 Split level

| Key | Format | Meaning |
|---|---|---|
| `kmm-matched-tx` | escaped XML | embedded matched (deleted) imported transaction (§6.8) |
| `kmm-match-split` | split id | which split of the embedded transaction matched |
| `kmm-orig-payee`, `kmm-orig-memo`, `kmm-orig-postdate`, `kmm-orig-not-reconciled`, `kmm-orig-onesplit` | | state before matching (TM) |

### 13.5 Security and schedule level

Security: §8.3. Schedule KVPs: none defined by core code (`kmm-variation` is compiled out, SCH
`variation`). `kmm-overdue-since`, `kmm-is-overdue` appear in source as UI or report computations, not
persisted.

---

## 14. Reconciliation

* `reconcileflag` (EN `Split::State`): **0 NotReconciled, 1 Cleared, 2 Reconciled, 3 Frozen** (`-1
  Unknown` is in-memory only). New splits are 0 (SPL constructor). "Frozen" is reserved "when the concept
  of books is introduced" (EN comment). Treat it as reconciled.
* Reconciling an account (REC `finishReconciliation`): every split in that account that is
  **Cleared** becomes **Reconciled** with `reconciledate = statement date`, and the transaction loses
  `Imported`. The account gets `lastreconciled = statement date` (if later),
  `<RECONCILIATION date value>` (statement date, statement ending balance, MM) and the legacy
  `reconciliationHistory` KVP. `lastStatementBalance` is updated unless a newer import exists.
* The "cleared balance" = Σ shares of splits with flag ≠ 0 (JM `clearedBalance`; AM `AccountBalances`
  counts Cleared, Reconciled and Frozen).
* Each RECONCILIATION records what the user typed as the statement balance (sign as the internal balance:
  negative for liabilities). It is not recomputed (REC `addReconciliation(statementDate, endingBalance)`).

---

## 15. Balances and holdings: verifying an import

### 15.1 Sign conventions (internal storage)

Assets and expenses increase with **positive** shares; liabilities, income and equity increase with
**negative** shares. The UI negates Liability, Income and Equity for display (AM `adjustedBalance`).
Examples: buying groceries = checking −, expense +; salary = checking +, income −; credit card purchase =
card −, expense +; card balance owed 500 = stored −500.

### 15.2 The algorithm KMyMoney uses (JM `updateBalances`, `balance`)

```
journal = all (transaction, split) pairs, ordered by (postdate, transaction id), then split order
balance[account] = 0
for (t, s) in journal:
    if t.splits.length == 1 and t.splits[0].action == "Split":        # TX isStockSplit
        balance[s.account] = round( balance[s.account] * s.shares,
                                    security(s.account.currency).saf,
                                    security.roundingMethod (RoundNever → RoundRound) )
    else:
        balance[s.account] += s.shares                                # never `value`
```

* **Use `shares`, never `value`.** For a currency account the balance is in the account's currency; for a
  Stock account it is the **number of shares**.
* Balance at date D: the same loop over postdate ≤ D (JM `balance(accountId, date)`).
* The parent investment account's own balance is normally 0. Its value is Σ(stock balances × latest
  price, converted).
* Ordering matters only around stock splits: a buy and a split on the same day are applied in transaction
  id order (sort key `date-id`).

### 15.3 Holdings check

For each Stock account: `holding = replay(§15.2)`. Expected after an import = Σ quantities your model
holds, with split ratios applied **multiplicatively at the split's position in date order** and rounded
to `saf`. Worked example: buy 10 → ×2 split → sell 5 gives 15 (§18).

For cash and brokerage: `Σ shares` of the account. Reconciled check:
`Σ shares where reconcileflag ∈ {2,3} and reconciledate ≤ D` should equal the RECONCILIATION value for D.
This is approximately true; it holds when nothing was edited after reconciliation.

---

## 16. Pitfalls

1. **Gzip by default.** `.kmy` is gzip-compressed XML. Sniff magic bytes; never trust the extension
   (§1).
2. **Raw control characters and broken UTF-8** occur in real files; KMyMoney silently filters them. Apply
   the same filter before parsing (§2.1).
3. **Attribute order and indentation differ** between writer generations. Use a real XML parser, and
   prefer a streaming one for large files.
4. **ACCOUNT, PAYEE and TAG element names are reused** inside REPORT and BUDGET with different meanings
   (§4.12, §12). Address elements by path: `KMYMONEY-FILE/ACCOUNTS/ACCOUNT`,
   `…/TRANSACTIONS/TRANSACTION/SPLITS/SPLIT`.
5. **Numbers are canonical rationals with non-decimal denominators** and may exceed 2^53 (auto-calc
   sentinel, prices). Use BigInt rationals (§3.1). `0/1` is zero; `price="0/1"` means "not set".
6. **`value` ≠ `shares`** for foreign-currency splits and all stock splits. Balances use `shares`;
   transaction balancing uses `value` (§6.3).
7. **Stock account `currency` is a security id**, not a currency. Look it up in SECURITIES first, then
   CURRENCIES.
8. **Split ids repeat across transactions** (`S0001` in every transaction) and are renumbered on load.
   Key splits by (transaction id, ordinal).
9. **Standard accounts** (`AStd::*`) have localized names and are not real accounts. Splits never
   reference them.
10. **Hierarchy**: `parentaccount` wins over SUBACCOUNTS. Missing parents mean reparent to the
    type-group root (§5.3).
11. **Opening balances are transactions** against an Equity account (one per currency), with no payee
    (§5.6). Do not double-import them as account opening balances.
12. **Anonymized files (`.anon.xml`) are not real data**: account, payee, tag and schedule names are
    replaced by their ids; memos become `<txid>/<splitid>`; transaction memos become the transaction id;
    strings become `xxxx`; **every split's value and shares are multiplied by one random factor**
    (msec/10, 0.1–99.9), **including stock-split ratios**, so split factors are garbage; loan numbers are
    replaced by an incrementing sequence; payee identifiers and online banking settings are removed;
    prices are not altered (ANON `fakeTransaction`, `hideNumber`, `hideString`, `writeAccount`). Never
    accept an anon file as a migration source. Detect it via the `.anon.xml` name or account
    `name == id`.
13. **Empty payee on splits** is normal. Dangling payee ids occur in Skrooge-produced files (§2.3).
14. **Transactions with one split, or unbalanced** (Σ value ≠ 0) exist. Single-split rows are also
    legitimate for Add/Remove shares and stock splits.
15. **Zero-split transactions**: a transaction whose splits were all dropped (empty `account`) is
    accepted by the reader (RD `readSplits` only skips the split). But the journal holds one row per split
    (JM `load` iterates `splits()`), so it vanishes from KMyMoney and is not written back. Skip such
    transactions.
16. **Splits on closed accounts** are legal (§5.5).
17. **Sign mismatch between shares and value** makes KMyMoney refuse the whole file (§6.2). Such a file
    cannot have been saved by KMyMoney, but a hand-edited one could contain it. Decide your own policy.
18. **`OpeningBalanceAccount` is `Yes` or `yes`**; `mm-closed`/`Tax`/… are `yes`, but `Imported` is
    `true` (§3.3).
19. **`interest-changeFrequency` vs `interest-changefrequency`**: write/read mismatch (§5.9).
20. **Entry date empty → today** in KMyMoney; store null instead.
21. **Duplicate (postdate, id) transactions collapse** in KMyMoney (§6.1). Ids are unique in a
    KMyMoney-written file, but do not dedupe by id alone without checking.
22. **Notes are plain text**, XML-escaped, with newlines as `&#10;`. No HTML is stored in memos, notes or
    descriptions (account notes come from `toPlainText`, NAD). The only double-escaped content is
    `kmm-matched-tx` (§6.8).
23. **Online-banking data is sensitive**: ONLINEBANKING attributes include usernames and possibly
    legacy passwords. Never import or log them (§4.15). (A repository sample contains a real-looking OFX
    username.)
24. **Brokerage association is by localized name** (`"<name> (Brokerage)"`, in German for example
    `(Depot)` or another translation; see `po/`). Do not hard-code English (§7.1).
25. **Prices may exist in either direction** (`USD→EUR` and/or `EUR→USD`). Normalise (§9).
26. **Deep currency precision**: currencies can have `saf` 1 (JPY) or 100000000 (BTC, sample
    `test-469195.xml`); securities often 100–1000000. Never assume 2 decimals.
27. **Cash accounts (type 3) round to `scf`**, not `saf` (ACC `fraction`).
28. **Recorded schedule PAYMENTS are not read back by KMyMoney** (§11.1).
29. **Stock-split recognition requires a single-split transaction** (§7.4).
30. **File size** **[not from source; estimate]**: a two-split transaction is ~450–550 bytes of XML
    (measured on the samples: TRANSACTION ≈ 120 B + 2 × SPLIT ≈ 190 B each). 50 000 transactions ≈ 25 MB
    of XML. gzip typically compresses this kind of XML 8–15×. KMyMoney itself loads the whole file into
    memory. Use a streaming (SAX) parser and stream gunzip.
31. **Locale-dependent strings**: root account names, "Opening Balances", "(Brokerage)", payee
    placeholders. Nothing in the XML structure depends on locale. Only these names do.
32. **XML DOCTYPE position**: if you write test fixtures, keep `<!DOCTYPE KMYMONEY-FILE>` within the first
    70 bytes, with no comment before it, or KMyMoney refuses them (§1).

---

## 17. Sample files in the repository

### 17.1 Licence

* The repository is REUSE-annotated (`REUSE.toml`, `LICENSES/`). Source files carry SPDX headers, mostly
  `GPL-2.0-or-later` (also `LicenseRef-KDE-Accepted-GPL`). `REUSE.toml` explicitly annotates only
  `kmymoney/templates/**/*.kmt` (GPL-2.0-or-later, © GnuCash project), `kmymoney/icons/**`
  (LGPL-3.0-only) and `.flatpak-manifest.json` (MIT).
* **The XML test data files carry no SPDX header and no `.license` sidecar, and REUSE.toml does not
  mention them.** They are distributed as part of a GPL-2.0-or-later project (the test code that uses them,
  for example `kmymoney/plugins/xml/tests/test-mymoneyxmlreader.cpp`, is GPL-2.0-or-later). **The
  conservative reading is GPL-2.0-or-later** (my inference, not a stated licence). Using them as fixtures
  in a GPL-incompatible project needs a legal decision. A clean alternative is the synthetic file in §18,
  written for this document.
* Some samples are derived from bug reports and contain personal-looking data (a person's name in
  `test-385993.xml`; an OFX `username` and `accountid` in `test-441023.xml`).
* libalkimia (`alkvalue.cpp`) is LGPL-2.1-or-later (file header).

### 17.2 Inventory

All complete `KMYMONEY-FILE` documents in the upstream repository (46 files) are listed here. They are
not copied into this repository; fetch them from upstream at the pinned commit for local robustness runs.
Repository paths: `kmymoney/plugins/views/reports/core/tests/data/<name>` unless noted. "fix" = FIXVERSION
as written; tx = transactions; sch = schedules; sec = securities; pp = price pairs. Account-type counts use
the §5.2 numbers.

| File | Size | fix / app | Covers |
|---|---|---|---|
| `kmymoney/mymoney/tests/test-payees.xml` | 9 KB | 9 / 5.2.1 | 5 payees with matching (`^$` exact name, `idpattern`/`urltemplate` link matching, default account), 8 tags, 7 tx, cleared/reconciled flags |
| `kmymoney/plugins/xml/tests/testfile1.xml` | 2 KB | `id=""` (→5) | minimal skeleton, empty fix version |
| `kmymoney/plugins/xml/tests/testfile2.xml` | 2 KB | 1 | minimal skeleton, fix 1 |
| `kmymoney/plugins/xml/tests/testfile3.xml` | 3 KB | 1 | non-standard ids (`1-bank`, `2-account`), credit card with `maxCreditAbsolute`, `lastStatementBalance`, `lastNumberUsed`; `SECURITY` element misplaced in CURRENCIES; standard accounts without `currency` |
| `test-382245.xml` | 12 KB | 4 (QDom era) | old format (`count=`, attribute order), 25 price pairs |
| `test-385993.xml`, `test-385993-without-totals.xml` | 122 KB | 4 (QDom era) | **largest realistic sample**: 53 accounts, 103 tx, 41 securities (mutual funds), 185 currencies, 64 price pairs, Buy/Reinvest/Dividend, old-format quirks (`ppu`, `lastStatementDate`, price attribute omitted) |
| `test-396301.xml` | 11 KB | 6 / 5.1.92 | investment in JPY and USD, Buy/Dividend/Reinvest |
| `test-403825.xml` | 4 KB | 11 / 5.2.2 | tiny checking + categories |
| `test-406403.xml` | 5 KB | `date=""` / 5.1.80 | EUR/RUB/USD accounts, cross-currency, `FIXVERSION date=""` quirk |
| `test-406525.xml` | 5 KB | 5 | old format, reports only |
| `test-416274.xml` | 9 KB | 5 | 3 investment accounts, 4 stocks, GBP |
| `test-423870.xml` | 12 KB | `date=""` | GBP/USD, 2 equity accounts |
| `test-424674.xml` | 4 KB | `date=""` | credit card + liability |
| `test-426241.xml`, `test-499180.xml` | 12 KB | 6 / 5.1.90 | **all investment activities**: Buy, Sell, Dividend, IntIncome, Reinvest, Yield, Add and Remove (`Add` ±) |
| `test-441023.xml` | 24 KB | `date="5"` | **RECONCILIATIONS** history, 16 reconciled splits, ONLINEBANKING (OFX), investment, USD (contains a real-looking OFX username) |
| `test-448788.xml` | 11 KB | 4 | old format, 26 price pairs |
| `test-452096.xml` | 4 KB | 11 | AED/EGP currencies, savings |
| `test-452692.xml` | 14 KB | `date=""` | many legacy currencies + investment |
| `test-453033.xml` | 7 KB | `date=""` | multi-currency with tags |
| `test-469195.xml` | 21 KB | `date=""` | **BTC currency (`saf=100000000`, `pp=8`)**, 44 expense categories (deep hierarchy), cash, credit card, 2 equity |
| `test-497935.xml` | 8 KB | `date=""` | investment Buy/Dividend |
| `test-498031.xml`, `test-498033.xml` | 12 KB | 11 / 5.2.70 | same activity set as 426241 in a newer format |
| `test-498054.xml` | 12 KB | `date=""` | same activity set |
| `test-511104.xml` | 5 KB | 10 | asset + equity + tags |
| `test-516585-convert-currency.xml` | 9 KB | 11 | EUR/USD with liabilities and equity per currency |
| `test-balance-forecast-report.xml` | 6 KB | 10 | checking/liability, cleared flags |
| `test-budget.xml` | 9 KB | 10 | 4 budgets |
| `test-budget-individual.xml`, `test-budget-months.xml`, `test-budget-years.xml` | 12–27 KB | 11 | budget levels (monthbymonth / monthly / yearly) |
| `test-cash-flow.xml` | 5 KB | `date=""` | basic, tags |
| `test-closed-account.xml` | 6 KB | 9 | **closed account** (`mm-closed`) |
| `test-general-information.xml` | 9 KB | 10 | **loan account + 2 schedules**, Amortization/Interest splits, 2 closed accounts |
| `test-income-and-expenses.xml` | 6 KB | `date=""` | basic income/expense |
| `test-investment.xml` | 15 KB | 12 / 5.2.70 | **canonical investment sample**: Buy with fee, Sell, Dividend ×2, IntIncome, Reinvest, Yield, Add, Remove, brokerage sibling account, price from Transaction |
| `test-investment-multi-currency.xml` | 16 KB | 12 | investments in USD/JPY/EUR with brokerage accounts per currency |
| `test-investment-no-sold.xml` | 8 KB | 10 | Buy + Reinvest only |
| `test-net-worth.xml` | 6 KB | `date=""` | net worth basics |
| `test-pivottable.xml` | 5 KB | `date=""` | minimal |
| `test-refinance-loan.xml` | 18 KB | `date=""` | **2 loans with full loan KVPs, 2 loan-payment schedules with auto-calc splits**, 15 loan payments |
| `test-split-account.xml` | 4 KB | 12 | asset/liability, payee |
| `test-transactions-multi-currency.xml` | 19 KB | 11 | **cross-currency transfers and foreign-currency categories, per-currency opening-balance accounts**, EUR→USD price |
| `test-transactions.xml` | 8 KB | `date=""` | basic, tags, cleared flags |

Not KMYMONEY-FILE documents (not copied): `kmymoney/templates/**/*.kmt` (530 account-hierarchy templates,
`<!DOCTYPE KMYMONEY-TEMPLATE>`, GPL-2.0-or-later © GnuCash), report expected-output CSVs and
`Investment Capital Gains by Account (Customized).xml` (report table output) in the same `data/` folder.
No `.kmy` (gzip), `.anon.xml`, GPG or SQLite samples exist in the repository.

**None of the samples contains a stock split (`action="Split"`) or a matched transaction
(`kmm-matched-tx`).**

---

## 18. Synthetic annotated example file

**SYNTHETIC: hand-written for this document strictly following the reader and writer code. It was not
produced by KMyMoney, has not been loaded into KMyMoney, and is free to use as a test fixture.** Base
currency USD. It contains: a checking account at an institution with a reconciliation, a category
hierarchy (Utilities:Electricity), a multi-split purchase, a transfer, a EUR savings account funded with a
USD→EUR transfer at 1.10, an investment account with brokerage, buy (with fee), dividend, 2-for-1 split
and sell, a monthly electricity bill schedule, a closed account, and a budget line. The comment after the
root element is allowed (the reader skips comments); a comment must not appear before the DOCTYPE (§16.32).

The importer's committed fixture is this XML, byte for byte (see the plan, work package WP1).
It was checked with a script for well-formedness, referential integrity (parents, SUBACCOUNTS, split
accounts), Σvalue = 0 per transaction, sign consistency, canonical rationals, and the balances below.

Expected balances (§15): Checking **2804.50 USD**; Old Savings **0** (closed); EUR Savings
**1000.00 EUR**; Brokerage **647.50 USD**; Example Corp holding **15 shares** (10 → ×2 = 20 → −5);
Opening Balances **−5100** (displayed as 5100); Groceries 100.50; Bank Fees 30.00; Electricity 75.00;
Dividends −7.50 (displayed 7.50).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE KMYMONEY-FILE>
<KMYMONEY-FILE>
  <!-- SYNTHETIC EXAMPLE - not produced by KMyMoney -->
  <FILEINFO>
    <CREATION_DATE date="2024-01-01"/>
    <LAST_MODIFIED_DATE date="2024-05-01T12:00:00+00:00"/>
    <VERSION id="1"/>
    <FIXVERSION id="12"/>                       <!-- current: no fixes needed -->
    <APPVERSION id="synthetic"/>
  </FILEINFO>
  <USER name="" email="">
    <ADDRESS street="" city="" state="" zip="" telephone="" country="" county="" zipcode="" postcode=""/>
  </USER>
  <INSTITUTIONS>
    <INSTITUTION id="I000001" name="Example Bank" manager="" sortcode="">
      <ADDRESS street="" city="" state="" zip="" telephone="" country="" county="" zipcode="" postcode=""/>
      <ACCOUNTIDS>
        <ACCOUNTID id="A000001"/>
        <ACCOUNTID id="A000013"/>
      </ACCOUNTIDS>
    </INSTITUTION>
  </INSTITUTIONS>
  <PAYEES>
    <PAYEE id="P000001" name="Corner Market" reference="" email="" matchingenabled="0">
      <ADDRESS street="" city="" state="" zip="" telephone="" country="" county="" zipcode="" postcode=""/>
    </PAYEE>
    <!-- match on key "CITY POWER" (single key => trailing newline), default category Electricity -->
    <PAYEE id="P000002" name="City Power" reference="" email="" matchingenabled="1" usingmatchkey="1"
           matchignorecase="1" matchkey="CITY POWER&#10;" defaultaccountid="A000008">
      <ADDRESS street="" city="" state="" zip="" telephone="" country="" county="" zipcode="" postcode=""/>
    </PAYEE>
  </PAYEES>
  <COSTCENTERS/>
  <TAGS>
    <TAG id="G000001" name="household" closed="0" tagcolor="#3366cc"/>
  </TAGS>
  <ACCOUNTS>
    <!-- the five standard roots, always first; names are localized UI strings -->
    <ACCOUNT id="AStd::Asset" parentaccount="" lastreconciled="" lastmodified="" institution="" opened="" number="" type="9" name="Asset" description="" currency="USD">
      <SUBACCOUNTS>
        <SUBACCOUNT id="A000001"/>
        <SUBACCOUNT id="A000003"/>
        <SUBACCOUNT id="A000004"/>
        <SUBACCOUNT id="A000005"/>
        <SUBACCOUNT id="A000013"/>
      </SUBACCOUNTS>
    </ACCOUNT>
    <ACCOUNT id="AStd::Liability" parentaccount="" lastreconciled="" lastmodified="" institution="" opened="" number="" type="10" name="Liability" description="" currency="USD"/>
    <ACCOUNT id="AStd::Expense" parentaccount="" lastreconciled="" lastmodified="" institution="" opened="" number="" type="13" name="Expense" description="" currency="USD">
      <SUBACCOUNTS>
        <SUBACCOUNT id="A000007"/>
        <SUBACCOUNT id="A000009"/>
        <SUBACCOUNT id="A000010"/>
      </SUBACCOUNTS>
    </ACCOUNT>
    <ACCOUNT id="AStd::Income" parentaccount="" lastreconciled="" lastmodified="" institution="" opened="" number="" type="12" name="Income" description="" currency="USD">
      <SUBACCOUNTS>
        <SUBACCOUNT id="A000011"/>
      </SUBACCOUNTS>
    </ACCOUNT>
    <ACCOUNT id="AStd::Equity" parentaccount="" lastreconciled="" lastmodified="" institution="" opened="" number="" type="16" name="Equity" description="" currency="USD">
      <SUBACCOUNTS>
        <SUBACCOUNT id="A000012"/>
      </SUBACCOUNTS>
    </ACCOUNT>
    <!-- then all other accounts sorted by id -->
    <!-- Checking (type 1) with IBAN, reconciliation history (element + legacy KVP) -->
    <ACCOUNT id="A000001" parentaccount="AStd::Asset" lastreconciled="2024-01-31" lastmodified="2024-02-05" institution="I000001" opened="2024-01-01" number="000123" type="1" name="Checking" description="Main account&#10;second line of notes" currency="USD">
      <RECONCILIATIONS>
        <RECONCILIATION date="2024-01-31" value="7759/2"/>                <!-- 3879.50 -->
      </RECONCILIATIONS>
      <KEYVALUEPAIRS>
        <PAIR key="iban" value="XX00EXAMPLE0000000000000"/>
        <PAIR key="reconciliationHistory" value="2024-01-31:7759/2"/>
      </KEYVALUEPAIRS>
    </ACCOUNT>
    <!-- Savings held in EUR -->
    <ACCOUNT id="A000003" parentaccount="AStd::Asset" lastreconciled="" lastmodified="" institution="" opened="2024-01-15" number="" type="2" name="EUR Savings" description="" currency="EUR"/>
    <!-- Investment container (type 7) and its stock account (type 15, currency = security id) -->
    <ACCOUNT id="A000004" parentaccount="AStd::Asset" lastreconciled="" lastmodified="" institution="" opened="2024-02-05" number="" type="7" name="Brokerage Account" description="" currency="USD">
      <SUBACCOUNTS>
        <SUBACCOUNT id="A000006"/>
      </SUBACCOUNTS>
    </ACCOUNT>
    <!-- cash side: a sibling Checkings account linked only by the name "<investment> (Brokerage)" -->
    <ACCOUNT id="A000005" parentaccount="AStd::Asset" lastreconciled="" lastmodified="" institution="" opened="2024-02-05" number="" type="1" name="Brokerage Account (Brokerage)" description="" currency="USD"/>
    <ACCOUNT id="A000006" parentaccount="A000004" lastreconciled="" lastmodified="" institution="" opened="2024-02-10" number="" type="15" name="Example Corp" description="" currency="E000001">
      <KEYVALUEPAIRS>
        <PAIR key="priceMode" value="1"/>
      </KEYVALUEPAIRS>
    </ACCOUNT>
    <!-- category hierarchy Utilities:Electricity -->
    <ACCOUNT id="A000007" parentaccount="AStd::Expense" lastreconciled="" lastmodified="" institution="" opened="1900-01-01" number="" type="13" name="Utilities" description="" currency="USD">
      <SUBACCOUNTS>
        <SUBACCOUNT id="A000008"/>
      </SUBACCOUNTS>
    </ACCOUNT>
    <ACCOUNT id="A000008" parentaccount="A000007" lastreconciled="" lastmodified="" institution="" opened="1900-01-01" number="" type="13" name="Electricity" description="" currency="USD"/>
    <ACCOUNT id="A000009" parentaccount="AStd::Expense" lastreconciled="" lastmodified="" institution="" opened="1900-01-01" number="" type="13" name="Groceries" description="" currency="USD">
      <KEYVALUEPAIRS>
        <PAIR key="Tax" value="yes"/>
      </KEYVALUEPAIRS>
    </ACCOUNT>
    <ACCOUNT id="A000010" parentaccount="AStd::Expense" lastreconciled="" lastmodified="" institution="" opened="1900-01-01" number="" type="13" name="Bank Fees" description="" currency="USD"/>
    <ACCOUNT id="A000011" parentaccount="AStd::Income" lastreconciled="" lastmodified="" institution="" opened="1900-01-01" number="" type="12" name="Dividends" description="" currency="USD"/>
    <!-- opening-balances equity account for the base currency -->
    <ACCOUNT id="A000012" parentaccount="AStd::Equity" lastreconciled="" lastmodified="" institution="" opened="2024-01-01" number="" type="16" name="Opening Balances" description="" currency="USD">
      <KEYVALUEPAIRS>
        <PAIR key="OpeningBalanceAccount" value="Yes"/>
      </KEYVALUEPAIRS>
    </ACCOUNT>
    <!-- closed account: mm-closed=yes plus closing date -->
    <ACCOUNT id="A000013" parentaccount="AStd::Asset" lastreconciled="" lastmodified="2024-01-10" institution="I000001" opened="2024-01-01" number="" type="2" name="Old Savings" description="" currency="USD">
      <KEYVALUEPAIRS>
        <PAIR key="mm-closed" value="yes"/>
        <PAIR key="mm-closed-date" value="2024-01-10"/>
      </KEYVALUEPAIRS>
    </ACCOUNT>
  </ACCOUNTS>
  <TRANSACTIONS>
    <!-- opening balance Checking 5000 (reconciled on 2024-01-31) -->
    <TRANSACTION id="T000000000000000001" postdate="2024-01-01" memo="" entrydate="2024-01-01" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="2024-01-31" action="" reconcileflag="2" value="5000/1" shares="5000/1" price="1/1" memo="" account="A000001" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="" reconcileflag="0" value="-5000/1" shares="-5000/1" price="1/1" memo="" account="A000012" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- opening balance Old Savings 100 -->
    <TRANSACTION id="T000000000000000002" postdate="2024-01-01" memo="" entrydate="2024-01-01" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="" reconcileflag="0" value="100/1" shares="100/1" price="1/1" memo="" account="A000013" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="" reconcileflag="0" value="-100/1" shares="-100/1" price="1/1" memo="" account="A000012" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- multi-split purchase: -120.50 = groceries 100.50 + fee 20.00; tag on one split -->
    <TRANSACTION id="T000000000000000003" postdate="2024-01-05" memo="" entrydate="2024-01-05" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="P000001" reconciledate="2024-01-31" action="" reconcileflag="2" value="-241/2" shares="-241/2" price="1/1" memo="Weekly shop" account="A000001" number="" bankid="FITID-0001"/>
        <SPLIT id="S0002" payee="P000001" reconciledate="" action="" reconcileflag="0" value="201/2" shares="201/2" price="1/1" memo="Food" account="A000009" number="" bankid="">
          <TAG id="G000001"/>
        </SPLIT>
        <SPLIT id="S0003" payee="P000001" reconciledate="" action="" reconcileflag="0" value="20/1" shares="20/1" price="1/1" memo="Card surcharge" account="A000010" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- transfer Old Savings -> Checking, empties the account that is then closed -->
    <TRANSACTION id="T000000000000000004" postdate="2024-01-10" memo="" entrydate="2024-01-10" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="" reconcileflag="0" value="-100/1" shares="-100/1" price="1/1" memo="Close account" account="A000013" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="2024-01-31" action="" reconcileflag="2" value="100/1" shares="100/1" price="1/1" memo="Close account" account="A000001" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- cross-currency transfer: commodity USD; EUR split value 1100 USD, shares 1000 EUR, price = value/shares = 1.10 USD per EUR -->
    <TRANSACTION id="T000000000000000005" postdate="2024-01-15" memo="" entrydate="2024-01-15" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="2024-01-31" action="" reconcileflag="2" value="-1100/1" shares="-1100/1" price="1/1" memo="To EUR savings" account="A000001" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="" reconcileflag="0" value="1100/1" shares="1000/1" price="11/10" memo="To EUR savings" account="A000003" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- electricity bill entered from schedule SCH000001 (cleared, not yet reconciled) -->
    <TRANSACTION id="T000000000000000006" postdate="2024-02-01" memo="" entrydate="2024-02-01" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="P000002" reconciledate="" action="" reconcileflag="1" value="-75/1" shares="-75/1" price="1/1" memo="February" account="A000001" number="" bankid=""/>
        <SPLIT id="S0002" payee="P000002" reconciledate="" action="" reconcileflag="0" value="75/1" shares="75/1" price="1/1" memo="February" account="A000008" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- fund the brokerage cash account -->
    <TRANSACTION id="T000000000000000007" postdate="2024-02-05" memo="" entrydate="2024-02-05" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="" reconcileflag="0" value="-1000/1" shares="-1000/1" price="1/1" memo="" account="A000001" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="" reconcileflag="0" value="1000/1" shares="1000/1" price="1/1" memo="" account="A000005" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- BUY 10 @ 50.00 + 5.00 fee: asset split, stock split, fee split (editor order) -->
    <TRANSACTION id="T000000000000000008" postdate="2024-02-10" memo="" entrydate="2024-02-10" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="" reconcileflag="0" value="-505/1" shares="-505/1" price="0/1" memo="Buy EXC" account="A000005" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="Buy" reconcileflag="0" value="500/1" shares="10/1" price="50/1" memo="Buy EXC" account="A000006" number="" bankid=""/>
        <SPLIT id="S0003" payee="" reconciledate="" action="" reconcileflag="0" value="5/1" shares="5/1" price="1/1" memo="" account="A000010" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- DIVIDEND 7.50 cash: stock split is a zero placeholder with action Dividend -->
    <TRANSACTION id="T000000000000000009" postdate="2024-03-15" memo="" entrydate="2024-03-15" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="" reconcileflag="0" value="15/2" shares="15/2" price="0/1" memo="Dividend" account="A000005" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="Dividend" reconcileflag="0" value="0/1" shares="0/1" price="0/1" memo="Dividend" account="A000006" number="" bankid=""/>
        <SPLIT id="S0003" payee="" reconciledate="" action="" reconcileflag="0" value="-15/2" shares="-15/2" price="1/1" memo="" account="A000011" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- 2-for-1 STOCK SPLIT: single split, shares = factor 2, value/price 0 -> holding 10 -> 20 -->
    <TRANSACTION id="T000000000000000010" postdate="2024-04-01" memo="" entrydate="2024-04-01" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="Split" reconcileflag="0" value="0/1" shares="2/1" price="0/1" memo="2:1 split" account="A000006" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
    <!-- SELL 5 @ 30.00, 5.00 fee: action is "Buy" with negative shares/value -->
    <TRANSACTION id="T000000000000000011" postdate="2024-05-01" memo="" entrydate="2024-05-01" commodity="USD">
      <SPLITS>
        <SPLIT id="S0001" payee="" reconciledate="" action="" reconcileflag="0" value="145/1" shares="145/1" price="0/1" memo="Sell EXC" account="A000005" number="" bankid=""/>
        <SPLIT id="S0002" payee="" reconciledate="" action="Buy" reconcileflag="0" value="-150/1" shares="-5/1" price="30/1" memo="Sell EXC" account="A000006" number="" bankid=""/>
        <SPLIT id="S0003" payee="" reconciledate="" action="" reconcileflag="0" value="5/1" shares="5/1" price="1/1" memo="" account="A000010" number="" bankid=""/>
      </SPLITS>
    </TRANSACTION>
  </TRANSACTIONS>
  <KEYVALUEPAIRS>
    <PAIR key="LastModificationDate" value="2024-05-01T12:00:00+00:00"/>
    <PAIR key="kmm-baseCurrency" value="USD"/>
    <PAIR key="kmm-id" value="{00000000-0000-4000-8000-000000000000}"/>
  </KEYVALUEPAIRS>
  <SCHEDULES>
    <!-- monthly Bill (type 1), direct debit (1), every 1 month (32), move after weekend (1),
         estimate (fixed=0); last entered 2024-02-01; next due = template postdate 2024-03-01 -->
    <SCHEDULED_TX id="SCH000001" name="Electricity" type="1" occurence="32" occurenceMultiplier="1" paymentType="1" startDate="2024-02-01" endDate="" fixed="0" lastDayInMonth="0" autoEnter="0" lastPayment="2024-02-01" weekendOption="1">
      <PAYMENTS/>
      <TRANSACTION id="" postdate="2024-03-01" memo="" entrydate="" commodity="USD">
        <SPLITS>
          <SPLIT id="S0001" payee="P000002" reconciledate="" action="" reconcileflag="0" value="-75/1" shares="-75/1" price="1/1" memo="" account="A000001" number="" bankid=""/>
          <SPLIT id="S0002" payee="P000002" reconciledate="" action="" reconcileflag="0" value="75/1" shares="75/1" price="1/1" memo="" account="A000008" number="" bankid=""/>
        </SPLITS>
      </TRANSACTION>
    </SCHEDULED_TX>
  </SCHEDULES>
  <SECURITIES>
    <SECURITY id="E000001" name="Example Corp" symbol="EXC" type="0" rounding-method="7" saf="1000" pp="4" trading-currency="USD" trading-market="">
      <KEYVALUEPAIRS>
        <PAIR key="kmm-security-id" value="XS0000000000"/>
      </KEYVALUEPAIRS>
    </SECURITY>
  </SECURITIES>
  <CURRENCIES>
    <CURRENCY id="EUR" name="Euro" symbol="€" type="3" rounding-method="7" saf="100" pp="4" scf="100"/>
    <CURRENCY id="USD" name="US Dollar" symbol="$" type="3" rounding-method="7" saf="100" pp="4" scf="100"/>
  </CURRENCIES>
  <PRICES>
    <!-- 1 EXC = price USD; recorded by the editor on buy AND sell (action "Buy") with source "Transaction" -->
    <PRICEPAIR from="E000001" to="USD">
      <PRICE date="2024-02-10" price="50/1" source="Transaction"/>
      <PRICE date="2024-05-01" price="30/1" source="Transaction"/>
    </PRICEPAIR>
    <!-- 1 EUR = 1.10 USD -->
    <PRICEPAIR from="EUR" to="USD">
      <PRICE date="2024-01-15" price="11/10" source="User"/>
    </PRICEPAIR>
  </PRICES>
  <REPORTS/>
  <BUDGETS>
    <BUDGET id="B000001" name="2024" start="2024-01-01" version="2">
      <ACCOUNT id="A000009" budgetlevel="monthly" budgetsubaccounts="0">
        <PERIOD amount="400/1" start="2024-01-01"/>        <!-- 400 per month -->
      </ACCOUNT>
    </BUDGET>
  </BUDGETS>
  <ONLINEJOBS/>
</KMYMONEY-FILE>
```

Notes on the example:
* The investment cash side is a separate account. A split with action `Buy` and negative shares is a sell.
* Opening balances are T…001/002 (two splits, one on the `OpeningBalanceAccount=Yes` equity account).
* The checking RECONCILIATION value 3879.50 = Σ shares of checking splits with flag 2 and date ≤ 2024-01-31
  (5000 − 120.50 + 100 − 1100).

---

## 19. Open questions (not confirmed from source)

1. **Stock-split ratio presentation.** The balance math multiplies by `shares` (definitive). The UI shows
   "Ratio 1/" and `1 / <shares>`, and a report test (`test-querytable.cpp testSplitShares`) computes
   `16/2 + 1` with factor 2. However, its helper (`kmymoney/tests/testutilities.cpp
   InvTransactionHelper`) never sets the `Split` action, so that test does not exercise the feature. I
   could not find a real file containing a stock split. Verify with a file from KMyMoney 5.2 before
   relying on it for reverse splits.
2. **Credit-limit sign for liability accounts.** For asset accounts `maxCreditAbsolute` is stored negative
   (dialog value × −1). `testfile3.xml` has a credit card with `maxCreditAbsolute="1000/1"` (positive),
   which suggests the sign may be inverted again for liabilities. Not resolved. Treat the absolute value as
   the limit.
3. **Loan interest-rate unit.** `ir-YYYY-MM-DD` holds what the wizard's interest-rate field contains
   (samples `1/1`, `4/5`). Presumed to be percent per annum, not verified in the financial calculator.
4. **Qt attribute escaping** of `\n`, `\r`, `\t` as character references is Qt `QXmlStreamWriter`
   behaviour, not visible in the KMyMoney source.
5. **GPG magic** beyond KMyMoney's three byte patterns, the **SQLite header**, and the **SQLCipher
   salt-only header** are general format knowledge, not KMyMoney source.
6. **PAYMENTS reading**: the reader appears unable to read back `PAYMENT` children (it reads
   `PAYMENTS@date`). The source carries a "check if this code is actually used" todo. Behaviour with real
   files containing `PAYMENT` entries is unconfirmed.
7. **The 4.x-era format** (KMyMoney 4.6–4.8) is assumed to equal the QDom-era samples (`count=`, `ppu`,
   `lastStatementDate`, `county`/`zipcode`). No 4.x sample is in the repository.
8. **File sizes and gzip ratio** in §16.30 are estimates.
9. **Brokerage name localisation**: the suffix is `i18nc("Brokerage (suffix for account names)",
   "Brokerage")`. I did not enumerate the translations in `po/`.
10. **Matched-transaction embedding**: the exact on-disk escaping (`&amp;#60;`) is derived from the writer
    logic plus XML escaping. No sample contains `kmm-matched-tx`.
11. **`openingbalance`, `iban`, `bic` ACCOUNT attributes and TRANSACTION `bankid`**: defined in NM but
    unused by the current reader and writer. Whether some historical writer emitted them is unknown. Read
    them if present.
12. **Investment account (type 7) splits**: KU's fallback handles splits that reference the investment
    account itself. When such splits occur in real files (for example old versions or imports) is
    unknown. Treat them as an asset split on the investment account.
