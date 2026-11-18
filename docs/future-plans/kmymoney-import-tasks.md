# KMyMoney (.kmy) import: work packages

> Companion to [`kmymoney-import.md`](./kmymoney-import.md) (the plan: assumptions, phases, ground
> truth, reviewed decisions). "The spec" is `docs/specs/kmymoney-import.md`; "the reference" is
> `docs/kmymoney-data-model.md`. Each work package (WP) is one implementer session. The spec's tables
> are the authority on every rule, code and message; a WP that finds the spec wrong stops and reports
> rather than improvising, and the spec is amended first in its own commit.

## How to use this list

- **Phases are a safety property.** WP0 creates every type the parallel packages compile against, so
  WP1, WP2, WP3a and WP5 can run in separate worktrees at once; WP3b and WP4 start only when their inputs
  are merged into the branch. Packages in one phase never edit the same file.
- **Expected numbers come from the plan's ground-truth table** (the reference's section 18 file), never
  from the importer's own output.
- **Commands.** Run from the layer directory. While developing run only the specs of files you changed
  plus the guard specs your WP names: backend `npm run test:unit -- <pattern>` (and
  `npm run test:integration -- <pattern>` where named), frontend `npm run test -- <pattern>`. Before each
  commit: backend `npm run lint && npx tsc --noEmit && npm run typecheck`; frontend
  `npm run lint && npm run type-check && npm run i18n:check`. After editing an `en` catalog:
  `npm run i18n:pseudo`. After editing docs: from the repository root `node scripts/check-docs-manifests.mjs`,
  and in `backend/` `npm run test:unit -- doc-paths instruction-files source-comment-paths`. **Stage new
  files (`git add -N`) before running any guard**; the tree-walking guards cannot see untracked files.
- **Never** `prettier --write` a directory under `backend/src/import/` (it re-aligns READMEs); pass
  `.ts` paths. The pre-commit hook runs eslint with `--max-warnings=0`.
- **Commits.** Conventional Commits, imperative subject, no trailing period, no emojis, one logical
  change with its tests, ending with the session's `Co-Authored-By` trailer (the orchestrator's brief
  names `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`). Do not push.
- **Expected red.** Only the two i18n parity specs, from the first new English key until WP7. Anything
  else red is a defect of the WP that caused it.
- **Deployment classes.** none: docs or tests only. inert: code no upload can reach (no route yet).
  live: changes what an upload does.

## Task graph

| ID | Package | Depends on | Class | Status |
|---|---|---|---|---|
| WP0 | Contract: shared types, raw model, rationals, errors, ignore rules | spec | inert | [ ] |
| WP1 | Reader and XML fixtures | WP0 | inert | [ ] |
| WP2 | Mappers, file-computed expectations, raw builders | WP0 | inert | [ ] |
| WP3a | Shared-pipeline generalisation | WP0 | inert (Money behaviour unchanged) | [ ] |
| WP5 | Website page, docs links, READMEs, invariant wording | WP0 | none | [ ] |
| WP3b | KMyMoney parser service, controller, module, guards, messages, integration spec, corpus run | WP1, WP2, WP3a | live (backend) | [ ] |
| WP4 | Frontend | WP0, WP5 | live | [ ] |
| WP6 | e2e | WP3b, WP4 | none | [ ] |
| WP7 | Translations | WP3b, WP4 | none | [ ] |
| WP8 | Screenshots (deferrable) | WP6 | none | [ ] |

---

## WP0: contract

**Goal.** Every type and small pure module the parallel packages share, so they compile independently.
No behaviour change anywhere.

**Create** (backend):

- `backend/src/import/mny/model/import-source.ts`: exactly the first block of spec 8.1
  (`ImportSourceFormat`, `KmyFileSummary`, `ImportSourceParseInput`, `ImportSourceParser`,
  `KMY_SOURCE_PARSER`).
- `backend/src/import/kmy/model/kmy-rational.ts` and `kmy-rational.spec.ts`: the API below,
  implemented with `bigint` only.
- `backend/src/import/kmy/model/kmy-raw.ts`: the raw model below, types only.
- `backend/src/import/kmy/model/kmy-errors.ts` and `kmy-errors.spec.ts`: the second block of spec 8.1;
  each subclass's message is English for logs only (never shown; the controller maps the code).
- `backend/src/import/kmy/model/kmy-warnings.ts`: `KMY_WARNING_CODES`, the list below, typed as
  `readonly MnyWarningCode[]`, and a spec asserting each is in `MNY_WARNING_CODES`.

**Modify** (types only, plus one `export`):

- `backend/src/import/mny/model/mny-import-model.ts`: the five optional fields of spec 4.9, each with a
  doc comment saying absent means the writer's previous behaviour.
- `backend/src/import/mny/model/mny-warnings.ts`: append to `MNY_WARNING_CODES`, in this order and after
  every existing code, each with a one-line comment: unsupportedCurrencyCode, singleSplitTransaction,
  unbalancedTransaction, duplicateTransactionId, unknownPayeeReference, equitySplitAsCategory,
  accountHierarchyFlattened, assetLoanAsAsset, currencyTradingAccount, brokerageAccountNotFound,
  brokerageCurrencyMismatch, stockAccountWithoutInvestment, securityNotImported,
  investmentImportedAsCash, investmentExtraAssetSplit, investmentSharesOnIncomeAction,
  multipleStockSplits, splitActionInMultiSplit, tradeFundedFromEquity, sharesAddedWithoutCost,
  stockSplitRatioRounded, stockSplitRoundingDiffers, stockSplitRatioSuspicious, priceCurrencyMismatch,
  unusedCurrencyRatesSkipped, loanInterestRateNotImported, loanScheduleSimplified,
  investmentScheduleNotImported, scheduleAutoEnterNotImported, scheduleWeekendRuleDropped,
  scheduleOverdue, costCentersNotImported, budgetsNotImported, reportsNotImported,
  onlineJobsNotImported, onlineBankingNotImported, accountNumbersNotImported, payeeDetailsNotImported,
  unparsableNumber, autoCalcInPostedSplit, mappedBalanceDiffers, holdingsReplayDiffers.
- `backend/src/import/mny/model/mny-import-job.ts`: `MnyAccountVerification.mappedBalance?: number`;
  update the `MnyHoldingCheck`/`MnyHoldingVerification` doc comments: `lotQuantity` is "the file's own
  share count: Money's open lots, or KMyMoney's replay".
- `backend/src/import/mny/mny-parser.service.ts`: `MnyParsedFile` gains `sourceFormat?`,
  `fileBalances?`, `kmyFile?` (spec 4.9). The `parse` body is not touched.
- `backend/src/import/mny/mny-preview.ts`: the `MnyPreview` interface gains `sourceFormat?: "kmy"` and
  `kmyFile?: KmyFileSummary` (the interface only; `buildPreview` is WP3a's).
- `backend/src/import/mny/mny-errors.ts`: `export class MnyImportError<C extends string = MnyErrorCode>
  extends Error { constructor(readonly code: C, message: string, readonly cause?: unknown) ... }`.
- `backend/src/import/mny/map/map-investments.ts`: `export` on `pairShareTransfers`. Nothing else.
- `frontend/src/lib/import-mny.ts`: mirror the three optional fields (`MnyPreview.sourceFormat?`,
  `MnyPreview.kmyFile?` with its interface, `MnyAccountVerification.mappedBalance?`).
- `.gitignore`: beside the `*.mny` rule, `*.kmy` and `!backend/src/import/kmy/__fixtures__/sample-*.kmy`;
  `.dockerignore`, `backend/.dockerignore`, `frontend/.dockerignore`: `**/*.kmy` beside `**/*.mny`.

The `KMY_WARNING_CODES` list (every code a KMyMoney import can raise; WP4 copies it into the frontend
descriptor verbatim): unknownAccountType, duplicateAccountName, unknownCurrency, unusableTransaction,
transferAcrossExcludedAccount, duplicateSecuritySymbol, generatedSecuritySymbol, balanceMismatch,
holdingsMismatch, unusableBill, billFrequencyApproximated, loanInterestCategoryUnclear,
crossCurrencyTradeUnconverted, then the 42 new codes above in the same order.

```ts
// kmy-rational
export interface Rational { readonly num: bigint; readonly den: bigint } // den > 0n, gcd(|num|, den) = 1
export const ZERO: Rational; export const ONE: Rational;
/** AlkValue::RoundingMethod (reference 3.1). */
export enum KmyRounding { Never = 0, Floor = 1, Ceil = 2, Truncate = 3, Promote = 4,
  HalfDown = 5, HalfUp = 6, Round = 7 }
export function rational(num: bigint, den?: bigint): Rational;          // canonicalises; RangeError on den 0n
export type ParsedKmyNumber =
  | { readonly kind: "value"; readonly value: Rational }
  | { readonly kind: "autoCalc" }
  | { readonly kind: "invalid" };
export function parseKmyNumber(text: string): ParsedKmyNumber;         // spec 4.5 table
export function add(a: Rational, b: Rational): Rational;               // also sub, mul, div (RangeError on 0), neg, abs
export function sign(a: Rational): -1 | 0 | 1;
export function isZero(a: Rational): boolean;
export function compare(a: Rational, b: Rational): -1 | 0 | 1;
export function sum(values: readonly Rational[]): Rational;
/** Port of AlkValue::convertDenominator for a positive denominator; Never behaves as Round (spec 6.1). */
export function roundToDenominator(a: Rational, den: bigint, method: KmyRounding): Rational;
/** Exact decimal at `places`, half away from zero; "-0" never produced. */
export function toDecimalString(a: Rational, places: number): string;
export function toNumber(a: Rational, places: number): number;        // Number(toDecimalString(a, places))
```

```ts
// kmy-raw (all readonly; every string attribute trimmed only where the spec says)
import type { Rational } from "./kmy-rational";
export type KmyAmount = Rational | "autoCalc";
export interface KmyFileInfo { container: "gzip" | "xml"; fixVersion: number; appVersion: string | null;
  creationDate: string | null; lastModified: string | null }
export interface KmyInstitution { ordinal: number; id: string; name: string; accountIds: readonly string[] }
export interface KmyPayee { ordinal: number; id: string; name: string;
  /** Non-empty email, reference, notes or address field, any payeeIdentifier, a defaultaccountid,
   *  or matchingenabled="1". */
  hasDetails: boolean }
export interface KmyTag { ordinal: number; id: string; name: string; closed: boolean }
export interface KmyCostCenter { ordinal: number; id: string; name: string }
export interface KmyReconciliation { date: string; value: Rational }
export interface KmyAccount {
  ordinal: number; id: string; isStandard: boolean;          // id starts "AStd::"
  parentId: string | null; name: string; type: number;       // missing or invalid type -> 0
  currency: string | null; institutionId: string | null;
  opened: string | null; lastReconciled: string | null;
  number: string; description: string;
  subaccountIds: readonly string[]; reconciliations: readonly KmyReconciliation[];
  /** Legacy IBAN folded into iban (iban wins); lastStatementDate dropped (reference 2.4). */
  kvp: ReadonlyMap<string, string>;
  hasOnlineBanking: boolean;                                  // no ONLINEBANKING attribute is stored
}
export interface KmySplit {
  ordinal: number;                    // 1-based within its transaction, after dropping empty-account splits
  account: string; payee: string | null;
  value: Rational; shares: Rational; price: Rational;
  action: string; reconcileFlag: number; reconcileDate: string | null;
  memo: string; number: string; bankId: string; costCenter: string | null;
  tags: readonly string[]; hasMatchedTransaction: boolean;
}
export interface KmyTemplateSplit extends Omit<KmySplit, "value" | "shares"> { value: KmyAmount; shares: KmyAmount }
export interface KmyTransaction { ordinal: number; id: string; postDate: string | null; memo: string;
  commodity: string | null; splits: readonly KmySplit[]; kvp: ReadonlyMap<string, string> }
export interface KmyTemplateTransaction { postDate: string | null; memo: string; commodity: string | null;
  splits: readonly KmyTemplateSplit[] }
export interface KmySchedule { ordinal: number; id: string; name: string; type: number;
  occurrence: number; multiplier: number;                     // raw; multiplier below 1 read as 1
  paymentType: number; startDate: string | null; endDate: string | null; lastPayment: string | null;
  fixed: boolean; autoEnter: boolean; lastDayInMonth: boolean; weekendOption: number;
  payments: readonly string[]; template: KmyTemplateTransaction | null }
export interface KmySecurity { ordinal: number; id: string; name: string; symbol: string; type: number;
  saf: bigint;                         // 0 or missing -> 100n
  pp: number;                          // 0 or above 10 -> 4
  roundingMethod: number;              // missing -> 0
  tradingCurrency: string | null; tradingMarket: string; kvp: ReadonlyMap<string, string> }
export interface KmyCurrency { ordinal: number; id: string; name: string; symbol: string;
  saf: bigint; scf: bigint; pp: number; roundingMethod: number }
export interface KmyPrice { ordinal: number; from: string; to: string; date: string; price: Rational; source: string }
export interface KmyCounts { reports: number; budgets: number; onlineJobs: number;
  matchedTransactions: number; onlineBankingAccounts: number }
export interface KmyReaderWarning {
  code: "unparsableNumber" | "autoCalcInPostedSplit" | "duplicateTransactionId";
  subject: string; transactionOrdinal: number | null }
export interface KmyRawFile {
  fileInfo: KmyFileInfo; baseCurrency: string | null;
  institutions: readonly KmyInstitution[]; payees: readonly KmyPayee[]; tags: readonly KmyTag[];
  costCenters: readonly KmyCostCenter[]; accounts: readonly KmyAccount[];
  transactions: readonly KmyTransaction[];   // after the (postdate, id) collapse; zero-split ones kept
  schedules: readonly KmySchedule[]; securities: readonly KmySecurity[];
  currencies: readonly KmyCurrency[]; prices: readonly KmyPrice[];
  counts: KmyCounts; readerWarnings: readonly KmyReaderWarning[];
}
```

**Tests.** `kmy-rational.spec.ts`: the rational rows of the spec's test matrix (section 11), including
every rounding method against the AlkValue truth (magnitude rounded, sign re-applied: Floor rounds a
negative away from zero, Ceil a positive; HalfDown ties toward zero; HalfUp ties away; Round ties to
even), numerators above 2^53, `toDecimalString(-241/2, 4)` = `-120.5000`, `toDecimalString(1/3, 8)` =
`0.33333333`, `toDecimalString(-1/200000, 4)` = `0.0000`. `kmy-errors.spec.ts`: each class carries its
code and is `instanceof MnyImportError`. The mny-warnings spec's existing uniqueness case covers the
append.

**Commands.** backend lint/tsc/typecheck; `npm run test:unit -- kmy-rational kmy-errors kmy-warnings
mny-warnings mny-import-job mny-preview mny-parser.service map-investments module-graph`; frontend
`npm run type-check` and `npm run test -- import-mny`.

**Commits.** `chore(git): ignore KMyMoney files outside the importer fixtures`;
`feat(import): add the shared contract for a KMyMoney import`.

**Acceptance.** Every existing Money spec named above green untouched; the new modules covered; no
runtime behaviour changed (a grep of the diff shows only types, one `export`, new files and ignore
rules).

---

## WP1: reader and XML fixtures

**Goal.** `readKmyFile`: uploaded bytes to `KmyRawFile`, or a `KmyImportError`. Spec 4.2 to 4.6.

**Create:**

```
backend/src/import/kmy/reader/kmy-container.ts         sniff + bounded gunzip (spec 4.3 rows 1-7)
backend/src/import/kmy/reader/kmy-byte-filter.ts       spec 4.4 truth table, whole buffer, returns a new Buffer
backend/src/import/kmy/reader/kmy-xml-tokenize.ts      htmlparser2 Parser, path stack, nesting/depth checks
backend/src/import/kmy/reader/kmy-raw-collector.ts     element-path handlers building KmyRawFile
backend/src/import/kmy/reader/kmy-read-file.ts         readKmyFile composition, anonymized test (4.3 row 8), row-9 checks
  (one .spec.ts beside each)
backend/src/import/kmy/__fixtures__/kmy-xml-builders.ts   TypeScript builders producing KMyMoney XML text, and gzip()
backend/src/import/kmy/__fixtures__/kmy-fixtures.ts       registry: KMY_FIXTURES, readKmyFixture(name) (fresh Buffer)
backend/src/import/kmy/__fixtures__/sample-synthetic.xml  the reference's section 18 XML, byte for byte
backend/src/import/kmy/__fixtures__/sample-synthetic.kmy  the same bytes, gzip (node zlib, default level)
backend/src/import/kmy/__fixtures__/README.md             provenance: synthetic, written for the reference; free to use
```

**Exposes:**

```ts
export interface KmyReadInput {
  readonly bytes: Buffer;        // not mutated
  readonly filename: string;
  readonly maxXmlBytes: number;  // WP3b passes MNY_IMPORT_LIMIT_BYTES
}
export function readKmyFile(input: KmyReadInput): KmyRawFile; // throws KmyImportError subclasses only
```

**Steps.**

1. Container: spec 4.3 in that order. Inflate with `zlib.gunzipSync(bytes, { maxOutputLength:
   maxXmlBytes })`; map `ERR_BUFFER_TOO_LARGE` to `KmyXmlTooLargeError` (limit in MB) and any other zlib
   error to `KmyCorruptFileError`. A plain document larger than `maxXmlBytes` is `KmyXmlTooLargeError`
   too.
2. Filter: port spec 4.4 exactly; a test per truth-table row.
3. Tokenize: decode in 64 KB slices with `TextDecoder("utf-8", { fatal: false })` and `stream: true`;
   `new Parser(handler, { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true })`; nesting
   check by `endIndex` (spec 4.4); depth limit 64; root must be `KMYMONEY-FILE`.
4. Collect by path (the paths in spec 4.4 and the reference's sections 4-11): FILEINFO (fix version
   rule, reference 2.3), file `KEYVALUEPAIRS` (`kmm-baseCurrency`), INSTITUTIONS, PAYEES, TAGS,
   COSTCENTERS, ACCOUNTS (with SUBACCOUNTS, RECONCILIATIONS, KEYVALUEPAIRS; ONLINEBANKING counted only),
   TRANSACTIONS (SPLITS, split TAG children, split and transaction KEYVALUEPAIRS; `kmm-matched-tx`
   counted, never parsed), SCHEDULES (template TRANSACTION with `id=""`, PAYMENTS), SECURITIES (only
   `SECURITY` children), CURRENCIES (only `CURRENCY` children), PRICES. REPORTS, BUDGETS, ONLINEJOBS:
   counted only. Unknown elements skipped. Sections may be missing or self-closing; old `count=`
   attributes ignored.
5. Ordinals counted per section in document order before any filtering (spec 4.6).
6. Numbers via `parseKmyNumber`; an invalid one is 0 plus a reader warning; auto-calc on a posted split
   is 0 plus `autoCalcInPostedSplit`. Dates: `YYYY-MM-DD` and a real calendar date, else null.
   Booleans per reference 3.3 (attributes `1/0/on/off/true/false/yes/no`; KVPs `yes`, and
   `OpeningBalanceAccount` `Yes` or `yes`).
7. Row-9 checks of spec 4.3 (unknown split account, sign mismatch) and the (postdate, id) collapse.

**Fixture builders.** `kmyFile({ ...sections })`, `kmyAccount(overrides)`, `kmyTransaction(splits,
overrides)`, `kmySplit(overrides)`, `kmySchedule(...)`, `kmySecurity(...)`, `kmyPrice(...)` returning XML
strings with defaults (the five standard roots added automatically), plus `toKmyBytes(xml, "gzip" |
"xml")`. Mind `.trail/learnings/2026-10-27-adding-a-mny-fixture-makes-every-ken.md`: the KMyMoney
registry is its own; nothing here is added to `MNY_FIXTURES`.

**Tests.** The container, filter and reader rows of the spec's test matrix. Both committed files read to
the counts: 17 accounts (5 standard), 11 transactions, 1 schedule, 1 security, 2 currencies, 3 prices,
1 budget; the Checking split values exact.

**Commands.** lint/tsc/typecheck; `npm run test:unit -- kmy/reader kmy/__fixtures__ jest-config
source-comment-paths`.

**Commits.** `feat(import): read KMyMoney containers and refuse the unsupported ones`;
`feat(import): tokenize KMyMoney XML into the raw model`; `test(import): add synthetic KMyMoney fixtures`.

**Acceptance.** `readKmyFile` on both committed files returns equal raw models (container aside); every
refusal of spec 4.3 has a spec; no `htmlparser2` import outside the tokenize module.

---

## WP2: mappers and file-computed expectations

**Goal.** `mapKmyFile`: raw model to a complete `MnyParsedFile`, every rule of spec section 5 and the
expectations of section 6.1.

**Create** (every module below 400 lines; split further if needed, keeping the `kmy-` prefix so no
basename collides with a Money file):

```
backend/src/import/kmy/map/kmy-account-tree.ts          hierarchy repair (reference 5.3), group of a type, descendants
backend/src/import/kmy/map/kmy-map-accounts.ts          spec 5.2 (type table, names, currency, CRYPTO, closed, institution)
backend/src/import/kmy/map/kmy-brokerage.ts             spec 5.2.2 and KMY_BROKERAGE_SUFFIXES (with the source commit in a comment)
backend/src/import/kmy/map/kmy-opening-balances.ts      spec 5.3
backend/src/import/kmy/map/kmy-map-categories.ts        spec 5.4 (and referenced-only with ancestors)
backend/src/import/kmy/map/kmy-map-payees-tags.ts       spec 5.5
backend/src/import/kmy/map/kmy-amounts.ts               rational -> number at a currency's places; leg conversion (spec 4.5, 4.7, 5.6.3)
backend/src/import/kmy/map/kmy-map-transactions.ts      spec 5.6
backend/src/import/kmy/map/kmy-dissect.ts               spec 5.7.1
backend/src/import/kmy/map/kmy-map-investments.ts       spec 5.7.2-5.7.6 (then pairShareTransfers)
backend/src/import/kmy/map/kmy-stock-splits.ts          spec 5.7.5 checks
backend/src/import/kmy/map/kmy-map-securities.ts        spec 5.8
backend/src/import/kmy/map/kmy-map-prices.ts            spec 5.9 (emits MnySecurityPrice[] / MnyExchangeRate[] + currency handle map)
backend/src/import/kmy/map/kmy-schedule-cadence.ts      spec 5.10.2 and R11.4 date stepping
backend/src/import/kmy/map/kmy-map-schedules.ts         spec 5.10.1, 5.10.3
backend/src/import/kmy/map/kmy-file-expectations.ts     spec 6.1 (balances and holdings from the raw model only)
backend/src/import/kmy/map/kmy-warning-row.ts           MnyWarningRow for a KMyMoney transaction
backend/src/import/kmy/map/kmy-map-file.ts              mapKmyFile: orchestration, counts, referenced-only, warnings, 6.3 comparisons
  (one .spec.ts beside each)
backend/src/import/kmy/__fixtures__/kmy-raw-builders.ts  plain-object KmyRawFile builders with defaults and overrides
```

**Consumes.** `kmy-raw`, `kmy-rational`, the shared model; `computeExpectedBalances` and `todayIsoDate`
from `backend/src/import/mny/mny-parser.service.ts`; `investmentWritesOwnCashRow`; `mapLoans`;
`selectedBills`; `pairShareTransfers`; `placeholderSymbol` and `MAX_SECURITY_SYMBOL_LENGTH`;
`cashSuffix` / `brokerageSuffix`; `derivePriceFromTotal`; `moneyDecimalsFor`; `roundFxRate`;
`normalizeCustomRecurrence`; `applyActionToQuantity` (replay of mapped rows for `replayQuantity`);
`resolveImportOptions` and `accountSelection`. It never imports from `backend/src/import/kmy/reader/`.

**Exposes:**

```ts
export interface KmyMapInput {
  readonly options?: Partial<MnyImportOptions>;
  readonly userDefaultCurrency: string;
  /** CRYPTO currency code -> its decimal places (currencies.kind = 'CRYPTO'). */
  readonly coinDecimals: ReadonlyMap<string, number>;
  readonly asOf: string; // YYYY-MM-DD
}
export function mapKmyFile(raw: KmyRawFile, input: KmyMapInput): MnyParsedFile;
```

The returned `MnyParsedFile` has `sourceFormat: "kmy"`, `kmyFile` from `raw.fileInfo`, `era: "unknown"`,
`passwordProtected: false`, `missingTables: []`, `missingFields: []`, `fileBalances` (spec 6.1),
`expectedBalances` from `computeExpectedBalances` (unchanged), `holdingChecks` with `lotQuantity` = the
file replay and `replayQuantity` = the mapped replay, `rawPrices` / `rawExchangeRates` /
`currencyByHandle` from `kmy-map-prices`, `fileCounts` (accounts = non-standard, non-category, non-stock,
non-equity accounts; payees; categories = type 12/13 accounts; securities in the file; `securityPrices`
and `exchangeRates` = the rows that will be written; `bills` = schedules in the file; `transactions` in
the file), the resolved options (with `bills` defaulting to every offered schedule, exactly as the Money
parser resolves it), and the warnings (reader warnings converted, then mapper warnings, then the two
spec 6.3 comparisons). Model fields KMyMoney never sets take the Money "nothing" value:
`collapsedTradeHandle` null, `investmentHandle` null, `cashTransactionId` / `transactionSplitId` /
`fundingAccountKey` per spec 5.7.3, `accruedInterest` 0, `tradeCashLegTagHandles` and
`investmentCashSources` empty, `deferredInvestments` and `tradeCashLegs` 0, `rateGaps` empty,
`MappedBills.supported` true.

**Determinism.** Same bytes, same options, same `asOf`: same handles, keys, names, amounts, warnings and
order (row UUIDs excepted, as in Money). A spec maps one raw model twice and compares with ids stripped.

**Tests.** The accounts-through-whole-mapping rows of the spec's test matrix, and every worked example of
spec section 5 as its own case (5.3 table, 5.6.4, 5.6.7 table, 5.7.3 cross-currency trade, 5.7.4, 5.7.5
table, 5.7.7, 5.10.3 example). `kmy-map-file.spec.ts` maps the committed synthetic XML through WP1's
reader **only if WP1 is merged**; otherwise it builds the same file with the raw builders, and WP3b adds
the reader-backed case.

**Commands.** lint/tsc/typecheck; `npm run test:unit -- kmy/map kmy-raw-builders`.

**Commits.** one per mapping area, in this order: `feat(import): map KMyMoney accounts and investment
pairs`; `feat(import): fold KMyMoney opening balances`; `feat(import): map the KMyMoney category tree,
payees and tags`; `feat(import): map KMyMoney transactions, splits and transfers`; `feat(import): map
KMyMoney investment activity`; `feat(import): map KMyMoney securities, prices and exchange rates`;
`feat(import): map KMyMoney schedules`; `feat(import): compute KMyMoney balances and holdings from the
file`; `feat(import): assemble the parsed KMyMoney file`.

**Acceptance.** For the synthetic file: every ground-truth row of the plan; `fileBalances` equal to
`expectedBalances` for every key; `holdingChecks` all matching; the warning set exactly
`accountNumbersNotImported` (Checking), `payeeDetailsNotImported` (City Power), `budgetsNotImported`,
`scheduleWeekendRuleDropped` and `scheduleOverdue` (with the default `asOf`).

---

## WP3a: shared-pipeline generalisation

**Goal.** The spec 4.9 changes outside the model files (WP0 did those), each behaviour-neutral for Money.

**Modify:** `backend/src/import/mny/mny-preview.ts` (`buildPreview` copies `sourceFormat`, `kmyFile`;
`finalBalance` from `fileBalances` when present), `backend/src/import/mny/mny-upload-error.interceptor.ts`,
`backend/src/import/mny/mny-import-job.service.ts`, `backend/src/import/mny/mny-staging.service.ts`,
`backend/src/import/mny/mny-import.service.ts`, `backend/src/import/mny/writers/write-transactions.ts`,
`backend/src/import/mny/writers/write-reference.ts`, `backend/src/import/mny/writers/write-investments.ts`,
`backend/src/import/mny/writers/write-bills.ts`, `backend/src/import/mny/writers/write-prices.ts`, the
spec beside each, `backend/test/integration/mny-import.integration.spec.ts` (new cases only),
`backend/src/i18n/locales/en/errors.json` (four keys: `import.kmyStagedFileMissing`,
`import.kmyStagedFileInUse`, `import.kmyExistingAccountClosed`, `import.kmyExistingAccountCurrency`,
text from spec 8.2) and the regenerated `backend/src/i18n/locales/xx/errors.json`.

**Steps.**

1. `MnyImportService`: constructor gains `@Optional() @Inject(KMY_SOURCE_PARSER) private readonly
   kmyParser?: ImportSourceParser` as its last parameter. `start(userId, input)`: `input.sourceFormat`
   (default `"mny"`); after `findInfo`, a staged file whose `sourceFormat` differs is the same 404 as a
   missing one, with that format's message; `jobs.create(..., sourceFormat)`; `runImport` is called with
   `{ format, filename: staged.filename }`. `runImport(userId, stagedFileId, options, context, source =
   { format: "mny", filename: "" })`: for `kmy`, `await this.kmyParser.parse({ userId, buffer: bytes,
   filename: source.filename, options, userDefaultCurrency })` (an absent parser is an `Error`, never
   reachable once WP3b registers it); for `mny`, today's call unchanged. `writeAll` passes
   `KMY_PRICE_SOURCE` or `MNY_PRICE_SOURCE` by `parsed.sourceFormat`. `verify`: `expectedBalance` =
   `(parsed.fileBalances ?? parsed.expectedBalances).get(key) ?? 0`, and `mappedBalance` =
   `parsed.expectedBalances.get(key) ?? 0` only when `fileBalances` is present. `writeAccounts` is
   called with the format. The timing log reads `.${format} import timing`. The staged-file-missing
   message in `start` picks the `kmy` key for `kmy`.
2. `MnyImportJobService.create`: fourth parameter `sourceFormat: ImportSourceFormat = "mny"`, written
   to the row. No other change.
3. `MnyStagingService.remove` (and any other path that throws the "in use" or "missing" message for a
   known row): the `kmy` key when the row's `sourceFormat` is `kmy`.
4. `MnyUploadErrorInterceptor`: `constructor(limitMb, factory = mnyFileTooLargeException)`.
5. Writers: the one-line changes of spec 4.9; `writeSecurityPrices(manager, prices, idByHandle,
   onProgress?, source = MNY_PRICE_SOURCE)` and `writeExchangeRates(manager, rates, currencyByHandle,
   source = MNY_PRICE_SOURCE)`; `export const KMY_PRICE_SOURCE = "kmy_import"` and `export type
   ImportPriceSource = typeof MNY_PRICE_SOURCE | typeof KMY_PRICE_SOURCE`.

**Tests.** In each changed file's existing spec, one new case per change (an optional field honoured when
set; a defaulted parameter honoured when passed; a cross-format staged id refused). Do not edit existing
cases. In the Money integration spec, one case writing a transaction with `exchangeRate` and
`reconciledDate`, an account with `institutionName`, a security with `securityType`, and a bill with a
`customRecurrence`, read back from PostgreSQL; one case that `create` with `"kmy"` stores
`source_format = 'kmy'`.

**Commands.** lint/tsc/typecheck; `npm run test:unit -- mny-preview mny-upload-error mny-import-job
mny-staging mny-import.service write-transactions write-reference write-investments write-bills
write-prices derived-state-writers rule-application-sites exchange-rate-orientation fx-provider-source
module-graph lint-bans`; `npm run i18n:pseudo && npm run i18n:check`; `npm run build && npm run
test:integration -- mny-import` (the three Money integration specs, run once each, never in parallel).

**Commits.** `refactor(import): let a staged import carry its source format`; `feat(import): let the
shared writers carry rates, reconcile dates, institutions, security types and custom recurrences`;
`feat(import): tag imported prices and rates by source format`; `feat(import): verify against
file-computed balances when the parser supplies them`.

**Acceptance.** Every Money spec named above green with no existing case changed; the Money integration
specs green; the new cases cover each new branch.

---

## WP5: docs

**Goal.** The user guide and every doc the feature changes, from the spec, before the frontend links to
them.

**Create / modify:**

- website page `website/docs/importing-from-kmymoney.md`, modelled on Part 1 of
  `website/docs/importing-from-microsoft-money.md`: Overview; Before You Start (save the file
  unencrypted; `.kmy` or `.xml`; SQL databases: File, Save As; anonymized files are not data; close
  nothing, the file is read not changed); Step by Step (upload, review, options, start, verification);
  Import Options; What Is Imported (the mapping tables of spec section 5 in user terms); What Is Not
  Imported (spec non-goals and the "not imported" warnings); Known Limitations (stock-split precision,
  added shares without cost, schedules' weekend rule and auto-enter, loan interest rate); After the
  Import (reading the verification report, "From KMyMoney file" versus "In Monize", the mapped line);
  **"Troubleshooting the KMyMoney Import"** (this exact heading: its anchor
  `troubleshooting-the-kmymoney-import` is what the error links point at) with one row per error code of
  spec 8.2 and the self-hosting note on `MNY_IMPORT_LIMIT_MB`. Screenshot references use the names WP8
  produces (`images/import-kmy-review.png` and so on); missing images render the "Screenshot pending"
  placeholder until WP8.
- `website/docs/nav.json` (an entry after the Microsoft Money page, with a `summary`),
  `website/docs/index.md` (feature bullet and "Migrate from" row), mentions in
  `website/docs/importing-transactions.md`, `website/docs/currency-management.md` (the "KMyMoney import"
  rate source) and `website/docs/investments.md` where the Money import is mentioned; then
  `npm run docs:build` in `frontend/` (regenerates the HTML, search index and sitemap; commit them).
- `website/assets/js/app.js`: add KMyMoney beside the `.mny` mentions in the format cards and step list.
- `frontend/src/lib/docs-links.ts`: `importKMyMoney: { page: 'importing-from-kmymoney' }`,
  `importKmyTroubleshooting: { page: 'importing-from-kmymoney', section:
  'troubleshooting-the-kmymoney-import' }`.
- `README.md`: a feature bullet after the Microsoft Money one, linking the website page.
- the importer README in `backend/src/import/kmy/` (a new README.md there): layering, the
  rules carried from the Money README (spec 4.1), the traps (path dispatch, ordinals before filtering,
  `shares` not `value`, the brokerage suffix list, stock splits applied unlike Money, no prettier on the
  directory), and a "Memory" section WP3b fills with its measurement.
- `docs/system-invariants.md`: INV-IMPORT-001's title and statement say "MNY or KMY import"; the
  sentence naming `mny_import` as a Money import's rate source also names `kmy_import`.

**Commands.** `npm run docs:build` and `npm run test -- docs-links website-docs` in `frontend/`;
`node scripts/check-docs-manifests.mjs`; backend `npm run test:unit -- doc-paths instruction-files`.

**Commits.** `docs(import): add the KMyMoney import guide`; `docs(import): link the KMyMoney guide from
the app and the feature lists`; `docs(import): describe the KMyMoney importer for maintainers`.

**Acceptance.** `docs-links.test.ts` resolves both new keys; `website-docs.test.ts` finds the committed
HTML current; the guards green.

---

## WP3b: KMyMoney wiring, integration spec, corpus run

**Goal.** The live backend path.

**Create:**

```
backend/src/import/kmy/kmy-parse.ts                 parseKmyBytes(input): readKmyFile then mapKmyFile
backend/src/import/kmy/kmy-parser.service.ts        KmyParserService implements ImportSourceParser
backend/src/import/kmy/kmy-upload-error.ts          kmyFileTooLargeException(limitMb), KMY_ERROR_MESSAGES
backend/src/import/kmy/kmy-import.controller.ts     KmyImportController, @Controller("import/kmy")
  (specs beside the three)
backend/test/integration/kmy-import.integration.spec.ts
```

**Modify:** `backend/src/import/import.module.ts` (controller, `KmyParserService`, the
`KMY_SOURCE_PARSER` provider with `useExisting`), `backend/src/auth/guards/pat-access.routes.guard.spec.ts`
(`PAT_CONTROLLERS` gains `"import/kmy/kmy-import.controller.ts"`; mirror any Money override),
`backend/src/i18n/locales/en/errors.json` (the remaining spec 8.2 keys) and its pseudo-locale, the
importer README's Memory section.

**Steps.**

1. `KmyParserService.parse(input)`: in one `withScopedDb` read, the user's preference
   (`preferredCurrency`) when `input.userDefaultCurrency` is absent, and `Currency` rows with `kind =
   'CRYPTO'` (`code`, `decimalPlaces`) as `coinDecimals`; then, outside that transaction,
   `parseKmyBytes({ bytes: input.buffer, filename: input.filename, maxXmlBytes:
   MNY_IMPORT_LIMIT_BYTES, options: input.options, userDefaultCurrency, coinDecimals, asOf: input.asOf ??
   todayIsoDate() })`. Any non-`MnyImportError` thrown by the reader or mapper is a defect: let it
   propagate (a test asserts the reader maps every zlib and tokenizer failure).
2. `KmyImportController`, mirroring `MnyImportController` route by route (spec section 8): parse (no
   extension check; `kmyNoFile`; the size re-assertion; parse first, stage second with `sourceFormat:
   "kmy"`; `buildPreview`), start (`@NoPat()`; `importService.start(userId, { ..., sourceFormat: "kmy"
   })`), jobs/:id (404 unless `job.sourceFormat === "kmy"`), staged/:id (404 unless the staged row is
   `kmy`). `MnyUploadErrorInterceptor` with `kmyFileTooLargeException`.
3. Integration spec (real PostgreSQL, one worker): the integration row of the spec's test matrix.
   Builder XML for the 3-level category tree, a loan payment, a cross-currency trade and a security
   transfer pair; assert row counts as well as balances.
4. Corpus run (not committed): fetch the KMyMoney repository at
   `d3943e0de789efede86b56c4246e7f4338fcc664` into a scratch directory outside this repository, copy
   every complete `KMYMONEY-FILE` document (reference 17.2), and run a throwaway TypeScript script
   (`npx ts-node -r tsconfig-paths/register <script>` from `backend/`, the script also outside the
   repository) that calls `parseKmyBytes` on each with a fixed `asOf` and prints: file, refusal code or
   counts, every warning code with its count, and any untyped error with its stack. Then build a
   50,000-transaction file with the WP1 builders, parse it, and record wall time and peak RSS. Write the
   corpus summary into the PR notes and the memory figures into the importer README.

**Commands.** lint/tsc/typecheck; `npm run test:unit -- kmy pat-access module-graph array-bound-dto
lint-bans jest-config source-comment-paths`; `npm run i18n:pseudo && npm run i18n:check`; `npm run build
&& npm run test:integration -- kmy-import`.

**Commits.** `feat(import): parse KMyMoney files through the shared import parser seam`;
`feat(import): add the KMyMoney import endpoints`; `test(import): import a KMyMoney file end to end
against PostgreSQL`; `docs(import): record KMyMoney import memory use`.

**Acceptance.** The integration spec reproduces the plan's ground truth with every verification delta 0;
the corpus run has no untyped error, no `mappedBalanceDiffers` and no `holdingsReplayDiffers`; the PAT
guard lists the new controller.

---

## WP4: frontend

**Goal.** The wizard imports a KMyMoney file through the existing components.

**Create:**

```
frontend/src/lib/import-kmy.ts                  kmyImportApi (BinaryImportClient, spec 8.1)
frontend/src/lib/import-kmy-error-docs.ts       kmyErrorDocsLink(code): every kmy* code and the reused job keys -> importKmyTroubleshooting
frontend/src/lib/binary-import-format.ts        BinaryImportFormat descriptor, MNY_FORMAT, KMY_FORMAT, KMY_WARNING_CODES
frontend/src/app/api/v1/import/kmy/parse/route.ts   the Money route verbatim
  (a .test.ts beside each lib module)
```

**Modify:** `frontend/src/lib/import-mny.ts` (export `BinaryImportClient`; `mnyImportApi` typed as it),
`frontend/src/hooks/useMnyImport.ts` (optional `client` parameter, default `mnyImportApi`),
`frontend/src/hooks/useImportWizard.ts` (`detectFileType` returns `'kmy'` for `kmy` and `xml`; a second
`useMnyImport(kmyImportApi)`; `binaryFormat` state; `binary` = the active hook; the `mny*` handlers act on
the active one; `toasts.kmySingleFileOnly`), `frontend/src/app/import/import-utils.ts` (`'kmy'` in
`ImportFileType`), `frontend/src/app/import/page.tsx` (render with `wizard.binary` and pass
`format={...}`; the password dialog only for Money), `frontend/src/components/import/UploadStep.tsx`
(accept gains `.kmy,.xml`; optional `binaryErrorFormat`), the five `Mny*` components (optional `format`
prop, default `MNY_FORMAT`; KMyMoney: no era, no missing-tables block, the mapped-balance line, the
report download name), `frontend/src/lib/proxy-body-limit.ts`, `frontend/src/proxy.ts`,
`frontend/src/lib/currency-detail.ts` (`kmy_import` -> `kmyImport`), the tests beside each of those,
`frontend/src/test/sw-share-target.test.ts` (a `.kmy` is refused like a `.mny`),
`frontend/src/i18n/messages/en/import.json`, `frontend/src/i18n/messages/en/currencyDetail.json`, the
four format strings (`page.subtitle`, `upload.instructions`, `upload.acceptedFormats`,
`upload.unsupportedDrop`) in **every** locale (insert "KMyMoney (.kmy, .xml)" beside "Microsoft Money
(.mny)"; a product name and extensions, not a translation, forced by
`frontend/src/i18n/messages.import-formats.test.ts`), the pseudo-locale, `e2e/tests/import.spec.ts` (the
accept-string assertion), `docs/frontend/api-and-cache.md` (the large-upload route list names the
KMyMoney import).

**Descriptor.**

```ts
export type BinaryImportFormatId = 'mny' | 'kmy';
export interface BinaryImportFormat {
  readonly id: BinaryImportFormatId;
  readonly client: BinaryImportClient;
  readonly reportExtension: RegExp;               // /\.mny$/i ; /\.(kmy|xml)$/i
  readonly showEra: boolean;                      // true ; false
  readonly showMissingTables: boolean;            // true ; false
  readonly passwordPrompt: boolean;               // true ; false
  readonly copy: {                                // i18n keys in the `import` namespace
    readonly reviewHeading: string; readonly fileSummary: string; readonly renamedFrom: string;
    readonly referencedOnlyPayeesHint: string; readonly referencedOnlyCategoriesHint: string;
    readonly importPricesHint: string; readonly wipeExistingDataHint: string;
    readonly countsTags: string; readonly countsBills: string; readonly countsBillsOfRows: string;
    readonly billsHeading: string; readonly billsExplainer: string; readonly billsSkipped: string;
    readonly importingHeading: string; readonly uploadFailedHeading: string;
    readonly allMatch: string; readonly someDiffer: string; readonly someHoldingsDiffer: string;
    readonly holdingsExplainer: string; readonly tableExpected: string; readonly tableLotShares: string;
    readonly reviewInSource: string; readonly reviewInSourceTruncated: string;
    readonly singleFileOnly: string;
  };
  readonly warningKey: (code: string) => string;  // mny: `mnyWarnings.${code}` ; kmy: `kmyWarnings.${code}`
  readonly errorKey: (code: string) => string;    // kmy: kmy* -> `kmyErrors.${code}`, mnyStagedFileMissing -> 'kmyErrors.kmyStagedFileMissing', else `mnyErrors.${code}`
  readonly errorDocsLink: (code: string | null | undefined) => DocsLink;
}
```

`MNY_FORMAT.copy` holds today's keys exactly, so every Money component renders what it renders now.

**English copy** (`import.json`; new namespaces, plus `upload.kmyFailedHeading`,
`toasts.kmySingleFileOnly`; no `--` anywhere):

- `kmyReview`: `heading` "Review your KMyMoney file"; `fileSummary` "{filename}: KMyMoney file, format
  version {fixVersion}, base currency {currency}. Balances below are computed from the file itself, so
  you can check them against KMyMoney before importing."; `renamedFrom` "named \"{name}\" in KMyMoney";
  `referencedOnlyPayeesHint` "KMyMoney keeps payees after their last transaction. Leave this on to skip
  the unused ones."; `referencedOnlyCategoriesHint` "KMyMoney creates its category tree from a template
  whether you use every category or not. Leave this on to skip the categories you never used.";
  `importPricesHint` "KMyMoney's own record of what each security was worth, day by day. Turn this off
  if you would rather start from live quotes."; `wipeExistingDataHint` "Runs the same Delete My Data
  operation as Settings before importing. You will be asked to confirm. Leave this off to add the
  KMyMoney file to what you already have."; `counts.tags` "Tags"; `counts.bills` "Scheduled
  transactions"; `counts.billsOfRows` "active of {rows} schedules".
- `kmyBills`: `heading` "Scheduled transactions to create ({count})"; `explainer` "These are the
  schedules KMyMoney still has active. Untick any you do not want; unticked schedules are not created at
  all."; `skipped` "{count, plural, one {# schedule} other {# schedules}} could not be imported."
- `kmyImporting.heading` "Importing your KMyMoney file".
- `kmyComplete`: `allMatch` "All {count} accounts reconcile: every balance matches the one computed from
  your KMyMoney file."; `someDiffer` "{count} accounts do not match the balance computed from your
  KMyMoney file. The rows marked below show the difference."; `someHoldingsDiffer` "Every balance
  reconciles, but {count, plural, one {# holding does} other {# holdings do}} not match the shares
  computed from your KMyMoney file. The rows marked below show the difference."; `holdingsExplainer`
  "Shares Monize now holds, against the share balance KMyMoney computes from the same file, stock splits
  included."; `table.expected` "From KMyMoney file"; `table.lotShares` "Shares in KMyMoney";
  `table.mappedDiffers` "Import rows sum to {amount}".
- `kmyErrors`: one key per `KmyErrorCode` and `kmyStagedFileMissing`, the spec 8.2 sentences (without
  the `{{ }}` limit where the frontend has no number: "That KMyMoney file is larger than the import
  limit once uncompressed.").
- `kmyWarnings`: one key per `KMY_WARNING_CODES` entry, the spec 5.12 sentences as ICU plurals
  (`{count, plural, one {# account has} other {# accounts have}} ...`), plus `reviewInKmy` "Open these in
  KMyMoney to check or correct them, then save and import again." and `reviewInKmyTruncated` "Showing the
  first {shown} of {total}. Open these in KMyMoney to check or correct them, then save and import
  again.". The table, show/hide, reference and no-value keys stay `mnyWarnings.*`.
- `upload.kmyFailedHeading` "That KMyMoney file could not be opened"; `toasts.kmySingleFileOnly` "Import
  one KMyMoney file at a time: a .kmy file holds a whole profile."
- `currencyDetail.json`: `sources.kmyImport` "KMyMoney import".

**Tests.** For each modified component, the existing Money cases untouched plus cases rendering with
`KMY_FORMAT` (heading, no era, no missing tables, KMyMoney warning keys, mapped-balance line, report
file name `budget-import-report.json` from `budget.kmy`); `useMnyImport` with a fake client;
`useImportWizard` routing `.kmy` and `.xml` (and `.anon.xml`) to the KMyMoney hook, one-file toast;
`page.test.tsx` mocks provide `binary` and `binaryFormat`; the descriptor test asserts every
`KMY_WARNING_CODES` code and every `KmyErrorCode` has an `en` key; proxy route tables; currency source
label.

**Commands.** `npm run lint && npm run type-check && npm run i18n:pseudo && npm run i18n:check`;
`npm run test -- import-kmy binary-import-format useMnyImport useImportWizard UploadStep MnyReviewStep
MnyBillsPanel MnyWarningsPanel MnyImportProgress MnyVerificationReport app/import proxy large-upload
currency-detail sw-share-target share-handoff messages intl-harness linkified-description ui-conventions
balance-cache docs-links`; `npm run build`.

**Commits.** `feat(import): describe binary import formats in one descriptor`; `feat(import): add the
KMyMoney import client and proxy route`; `feat(import): route KMyMoney files through the import wizard`;
`feat(import): show KMyMoney copy in the review, progress and report steps`.

**Acceptance.** Every Money test green unchanged except where a mock must now provide `binary`; only the
parity spec red (new keys await WP7); `npm run build` passes the bundle-size check.

---

## WP6: e2e

**Create:** `e2e/tests/import-kmy.spec.ts`, modelled on `e2e/tests/import-mny.spec.ts` (read
`e2e/CLAUDE.md` first). Fixtures path `backend/src/import/kmy/__fixtures__`.

1. The upload page names "KMyMoney (.kmy" in its copy.
2. `sample-synthetic.kmy` end to end: set the file input; heading "Review your KMyMoney file"; text
   "Brokerage Account - Cash"; "Start import"; heading "Import finished"; "accounts reconcile"; "Done";
   back on the upload step; `/accounts` lists "Checking".
3. Refusals from in-test buffers: 8,192 bytes of `A` named `not-really.kmy` ("not a KMyMoney file"),
   `-----BEGIN PGP MESSAGE-----` named `secret.kmy` ("encrypted"), `SQLite format 3` plus a NUL and
   padding named `data.kmy` ("Save As"), the synthetic XML named `test.anon.xml` ("anonymized").

**Commands.** With the e2e stack up (`docker compose -f docker-compose.e2e.yml up -d --wait`):
`npx playwright test tests/import-kmy.spec.ts tests/import.spec.ts tests/import-mny.spec.ts`.

**Commit.** `test(e2e): import a KMyMoney file through the wizard`.

---

## WP7: translations

**Goal.** Every non-`en` locale (frontend: de, en-GB, en-US, es, fr, hi, id, it, ja, ko, nl, pl, pt,
pt-BR, ru, tr, uk, vi, zh-CN, zh-TW; backend: the same list) carries every new key; the regional
variants (en-GB, en-US) only where the text differs.

**Keys.** Frontend `import.json`: `kmyReview.*`, `kmyBills.*`, `kmyImporting.heading`, `kmyComplete.*`,
`kmyErrors.*`, `kmyWarnings.*`, `upload.kmyFailedHeading`, `toasts.kmySingleFileOnly`; review the
format strings WP4 edited; `currencyDetail.json`: `sources.kmyImport`. Backend `errors.json`: every
`import.kmy*` key of spec 8.2. "KMyMoney", "GPG", "SQL", ".kmy", ".xml" and "gpg --decrypt" are not
translated; KMyMoney menu names (File, Save As; Settings, Configure KMyMoney, Encryption) use KMyMoney's
own translation of that menu in the target language where it is known, else English.

**Commands.** frontend `npm run i18n:check && npm run test -- messages`; backend `npm run i18n:check &&
npm run test:unit -- locales pseudo-locale`.

**Commit.** `feat(i18n): translate the KMyMoney import`. This is the last commit before review.

**Acceptance.** Both parity specs green; the duplicate-key and punctuation tests green with no exemption
added.

---

## WP8: screenshots (deferrable)

**Create:** `e2e/docs-screenshots/importing-from-kmymoney.spec.ts` modelled on
`e2e/docs-screenshots/importing-from-microsoft-money.spec.ts`; the fixture path in
`e2e/docs-screenshots/import-files.ts`. Shots: `import-kmy-review`, `import-kmy-accounts`,
`import-kmy-bills`, `import-kmy-options`, `import-kmy-notes`, from `sample-synthetic.kmy`, leaving before
"Start import". Run `npm run docs:screenshots` against a demo-data stack, then `npm run docs:build` in
`frontend/`; commit the PNGs (dark and `.light`) and the regenerated HTML.

**Commit.** `docs(import): add KMyMoney import screenshots`.
