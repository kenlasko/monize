# Spec: fetching a bond series from its official source

Status: approved by the owner on 2026-10-11 (WMP/monize#24), built with
`polish-retail-bonds.md`. Design discussion kenlasko/monize#1650,
sections 5, 19, 21, 25, 35 and 37.

## 1. Goal

A person who holds a series that Monize does not know yet (a new monthly
series, or an older one still held) gets it into the catalog by typing its
code. Monize fetches the terms from the issuer's official source, checks them,
and stores them as an immutable terms version. The person supplies only the
code, never a rate, a margin, a fee or a date, so a person cannot put wrong
terms into the catalog that every user of the deployment shares.

When the official source cannot be read (its format changed, the letter's text
cannot be extracted), an administrator may enter the per-series values by
hand. The structure of the product still comes from the adapter's template.

In scope: the adapter contract, the Polish implementation, the API, the AI
assistant and MCP tool, the purchase form's series picker, the Refresh of a
linked security, a daily check of the current offer for the programs a person
follows, the manual path for an administrator.

Out of scope: any country but Poland; a series whose product is not one of the
eight Polish products; parsing an arbitrary prospectus (discussion section 38).

## 2. Invariants

- **INV-BOND-006.** Terms enter the catalog only from the adapter's fetch of
  its official source or from an administrator's manual entry built on the
  adapter's product template (an adapter ships no series, INV-BOND-008). A
  request from a person who is not an administrator carries only a country and
  a series code. Every stored version names its origin in `source.provider`
  (the official host, or `manual`).
- **INV-BOND-001 holds unchanged.** A fetched version is inserted once and
  never changed: the same tables, the same immutability trigger, the same
  deterministic instrument id. A second fetch of a stored series writes
  nothing. A fetch whose content differs from the stored version 1 is refused
  and logged; it never replaces it.
- **Refuse before writing.** Every check (code format, source host, each
  parsed field, the cross-checks of section 4.3, the strict terms parser) runs
  before the insert; a refused fetch leaves no row.

## 3. Adapter contract

`BondAdapter` (`backend/src/bonds/bond-adapter.ts`) has these optional members
for series (every member is described in `docs/backend/bond-adapters.md`):

```text
fetchSeries?(seriesCode: string, fetch: BondFetch): Promise<FetchedSeries>
manualSeries?(seriesCode: string, values: ManualSeriesValues): CatalogEntry
seriesProviderId?   the TrackedProviderId the fetches are gated and reported under
currentSeries?(fetch: BondFetch): Promise<string[]>   the codes on sale now
backfillCodes?(today: string): string[]               every code from seriesValidFrom
programOf?(seriesCode: string): string | null          the program of a code
seriesValidFrom?    the earliest sale month (YYYY-MM) the templates are validated for

FetchedSeries   { entry: CatalogEntry, sources: SourceRef[] }
SourceRef       { provider, url, retrievedAt }          (discussion section 37)
ManualSeriesValues  the per-series values of the adapter's template, as
                    decimal strings and dates (Polish: section 5.2)
```

An adapter without `fetchSeries` answers `SERIES_FETCH_UNSUPPORTED`. The
adapter alone knows the host, the page layout, the document format and the
product templates; the service knows none of them (the country-agnostic guard
covers the service). The request a person can make carries only a country (two
upper-case letters) and a series code (letters and digits, at most 16).

## 4. Polish implementation

### 4.1 Series code

`^(OTS|ROR|DOR|TOS|COI|EDO|ROS|ROD)(MM)(YY)$`, upper-cased before the check.
`MM YY` is the maturity month and year. The sale month is the maturity month
minus the product's tenor (OTS 3 months, ROR 12, DOR 24, TOS 36, COI 48,
ROS 72, EDO 120, ROD 144). A code whose month is not 01..12 is refused
(`SERIES_CODE_INVALID`).

### 4.2 Sources

Host `www.obligacjeskarbowe.pl`, HTTPS only, the only host the adapter fetches
from; a redirect to another host is refused. The code of the series a purchase on a date would carry comes from the adapter (`seriesCodeFor`, section 4.1's grammar) through `GET /bonds/securities/:securityId/expected-series` (`bond-program-securities.md` 3.3), so a client never holds the grammar. Each fetch has a 30 s timeout and
a size cap (HTML 2 MB, PDF 5 MB), and runs through `ProviderHealthService`
(provider id `obligacjeskarbowe`) and `describeFetchFailure`.

- Series page: `/oferta-obligacji/<product slug>/<series code lower case>/`.
  The slugs: `obligacje-3-miesieczne-ots`, `obligacje-roczne-ror`,
  `obligacje-2-letnie-dor`, `obligacje-3-letnie-tos`,
  `obligacje-4-letnie-coi`, `obligacje-6-letnie-ros`,
  `obligacje-10-letnie-edo`, `obligacje-12-letnie-rod`. A page that does not
  name the requested series in its "Seria:" field is `SERIES_NOT_PUBLISHED`.
- Issue letter: the page's "Zobacz list emisyjny" link, which must be a path
  under `/media_files/` ending in `.pdf` on the same host. The text is read
  with `pdfjs-dist` (`isEvalSupported: false`).

### 4.3 Fields and cross-checks

| Field | Page | Letter | Check |
| --- | --- | --- | --- |
| series code | "Seria:" | the list of series the letter issues | equal to the request |
| first-period rate | "Oprocentowanie:" first percentage | "W pierwszym okresie odsetkowym stopa procentowa wynosi X% w skali roku" (FIXED: the only rate) | page = letter; 0 < rate <= 0.25 |
| margin or spread | "marża X%" / "NBP+X%" | the margin in the letter | page = letter; 0 <= value <= 0.05 (FIXED: none) |
| sale window | "Sprzedaż: dd.mm.yyyy - dd.mm.yyyy" | "oferowane do sprzedaży w dniach od ... do ..." | the letter's window is stored; the page's lies inside it (the EDO0734 page says 30.07.2024, its letter 31.07.2024); inside the sale month of 4.1 |
| early redemption fee | none | "nie wyższą niż X zł" or "w wysokości X zł" | 0 <= fee <= 10; OTS has none |
| letter number and date | none | "LIST EMISYJNY nr N/YYYY", "z dnia ..." | present; date before the sale window |
| face value | "Cena sprzedaży" 100,00 zł | "Nominał jednej obligacji wynosi 100 zł" | both 100 |

A live run on 2026-10-11 fetched 64 series (the eight products sold in
2024-01, 2024-07, 2025-01, 2025-07, 2026-01, 2026-06, 2026-09 and 2026-10):
all passed, the October 2026 ones equal to the terms fixtures under `backend/src/bonds/adapters/pl/fixtures/series/`. The letters
show the fee is a per-series value: TOS 0.70 to 1.00, COI and ROS 0.70 to 2.00,
EDO and ROD 2.00 to 3.00 from the September 2024 series, with the same wording;
the margins of COI, ROS, EDO and ROD rose and the DOR spread fell from June
2024. The backfill of all 272 series from 2024-01 to 2026-10 then completed;
two letters (ROS1030, ROD1036) write the fee without grosze ("2 zł").

Any field that cannot be parsed is `SOURCE_FORMAT_CHANGED` with the field's
name; any disagreement is `SOURCE_INCONSISTENT` with the field and both
values. Neither writes anything.

### 4.4 Product templates

The structure of each product (schedule, accrual, principal rule, rate rule
type and observation, capitalization, redemption window, blackouts, floor,
rounding) is a template in the adapter (data under `backend/src/bonds/adapters/pl/templates/`,
no per-series value), taken from the October 2026 letters. The fetched values fill the template; the result goes through the
strict terms parser (`parseBondTerms`). A template carries the earliest sale
month whose letter was checked to have the same structure (`validFrom`); an
older series is refused with `TEMPLATE_NOT_VALIDATED`, and its route is a new
template.

### 4.5 Stored version

`termsVersion` 1, `publishedAt` = the letter's date, `source` =
`{ provider: "obligacjeskarbowe.pl", url: <series page>, document: "List
emisyjny nr N/YYYY" }`, `retrieved_at` = the fetch time. Inserted through the
catalog's per-entry transaction (the path every stored series takes). Two concurrent
fetches of one series are serialized by an advisory lock keyed on the
instrument id; the second finds the row and writes nothing.

## 5. Entry points

### 5.1 Fetch

- `POST /bonds/instruments/fetch` `{ countryCode, seriesCode }`, any
  authenticated user, throttled to 10 requests a minute per user. Returns the
  `BondInstrumentSummary` (`created: true | false`). Errors are translated
  `errors.bonds.<code>`.
- The AI assistant and the MCP server share one tool, `fetch_bond_series`,
  implemented on the service. It writes only reference data from the official
  source, so it needs no confirmation beyond the tool call.
- The purchase form's series picker (`BondSeriesSelect`): when no stored series
  was on sale on the transaction date, it offers "Fetch {code} from the official
  source" for the code it expects for that date; on success the list refreshes
  and the new series is selected.
- The Refresh of a linked security fetches its program's current offer and a
  bounded piece of its history (`BondSeriesService.fetchProgramOffer`,
  `bond-program-securities.md` 2.5).
- A daily cron reads the current offer ("Sprawdź, co jest aktualnie w
  sprzedaży", the adapter's `currentSeries`) and fetches every listed series of
  the programs a security has switched `bond_auto_fetch` on for that is not
  stored, under a `FetchSyncService` lease, so a new month's series of a
  followed program exist without anyone asking; then the history backfill for
  the same programs (`bond-offer-and-history.md` 4).

### 5.2 Manual entry (administrator)

`POST /bonds/instruments/manual` `{ countryCode, seriesCode, values }`, behind
the administrator role, also as the MCP tool `enter_bond_series_manually`
(administrator only, with the MCP confirmation step). Polish `values`:
`firstPeriodRate`, `addend` (margin or spread; absent for FIXED), `fee`
(absent for OTS), `saleWindow { from, to }`, `letter { number, date }`. The
same template, bounds and parser apply; the sale window must match the code.
`source.provider` is `manual`, and the card shows "terms entered by hand".

## 6. Errors

`SERIES_CODE_INVALID`, `SERIES_FETCH_UNSUPPORTED`, `SERIES_NOT_PUBLISHED`,
`SOURCE_UNAVAILABLE` (network, timeout, breaker open, a 5xx or 429 answer: all
transient), `SOURCE_DOCUMENT_MISSING` (422: a document of this one series, its
page or its letter, answers a permanent 4xx other than the page's 404, which is
`SERIES_NOT_PUBLISHED`; params `document` and `status`), `SOURCE_FORMAT_CHANGED`,
`SOURCE_INCONSISTENT`, `TEMPLATE_NOT_VALIDATED`, `PRODUCT_NOT_SUPPORTED` (422: the official source
describes a product this version has no template for, param `product`; the US
TIPS and FRN until phase 4), `MANUAL_ENTRY_INVALID` (422: a
value of an administrator's manual entry is malformed; names the `field` the
administrator entered, never "the source changed its format"),
`SERIES_TERMS_CONFLICT` (a stored version 1 differs). Each has `params` and an
`errors.bonds.<code>` message in every locale.

Transient and permanent are told apart because the backfill pass ends on
`SOURCE_UNAVAILABLE` only (the source is down, the next run resumes): one series
whose letter is gone is `SOURCE_DOCUMENT_MISSING`, counted as failed, and the
pass goes on to the next series.

After a fetch that stored a series, the benchmark refresh and the engine-price
recompute of every linked security run after the commit and are not awaited by
the person's fetch (REST, AI, MCP): a failure is logged, never thrown to the
caller. The Refresh of a linked security, the passes and the manual entry still
await them, because their callers read the result straight after.

## 7. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Code | unit | each product; lower case accepted; month 00 and 13, unknown product, wrong length refused |
| Page parser | unit | saved pages of EDO0934, EDO1036, ROR1027, TOS1029, OTS0127; a page without "Seria:"; a page naming another series |
| Letter parser | unit | a saved letter text per product; fee missing; number missing |
| Cross-checks | unit | rate, margin, sale window disagreement each refused with both values |
| PDF | unit | one saved letter PDF read by `pdfjs-dist` gives the expected text markers |
| Host | unit | a letter link to another host, a redirect off host, a non-PDF link refused |
| Equivalence | unit | fetching EDO1036, ROR1027 and TOS1029 from saved sources gives terms equal to the terms fixtures (except `source`) |
| Write | integration | fetch inserts one instrument and version 1; a repeat writes nothing; a differing repeat is `SERIES_TERMS_CONFLICT`; a refused fetch leaves no row; two concurrent fetches insert once |
| Manual | integration | non-administrator refused (403); administrator entry stored with `provider: manual`; out-of-bounds values refused |
| Tools | unit | AI and MCP tool call the service; MCP manual tool requires the administrator role |
| Backfill | unit | a series whose letter answers 404 is refused as its own series and the pass stores the next; `SOURCE_UNAVAILABLE` still stops it |
| Fetch dispatch | unit | the fetch answers while the recompute never resolves; a failed recompute is logged, not thrown |
| Cron | unit | lease held; only the programs switched on; only missing series fetched; one failing series does not stop the others |
