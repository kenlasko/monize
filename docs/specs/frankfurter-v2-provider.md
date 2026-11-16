# Frankfurter v2 exchange rate provider

Status: shipped, and the only Frankfurter adapter. `frankfurter_v2` reads
Frankfurter's v2 API, which blends the published rates of about a hundred
central banks, where the v1 adapter it replaced served the ECB's reference
rates alone. It was built opt-in beside v1, tested against real data, and then
cut over (section 8, 2026-11-16): the v1 adapter and `FX_PROVIDERS` were
removed, and the chain is fixed at Frankfurter v2, then Yahoo, then the crypto
pair provider. The chain, the contract and the status table it plugs into are
`docs/specs/exchange-rate-providers.md`; this document records only what
differs.

## 1. Why

- The `frankfurter` adapter calls `https://api.frankfurter.dev/v1`, which is
  ECB-only. The ECB's series begins 1999-01-04, so no pair has a rate before
  that date. A ledger that opens in 1996 has three years of transactions that
  convert at no rate. Yahoo, second on the chain, starts `USDCAD=X` in
  December 2003, so it cannot fill the gap.
- Frankfurter's v2 API answers USD/CAD from 1953-05-11
  (`GET /v2/coverage?base=USD&quotes=CAD`). The "since 1948" on its home page
  is the start of the Bundesbank series, not of every pair.
- v2 carries all 44 codes in `backend/src/currencies/currency-metadata.ts`.
  v1 carries 28 of them, and the 16 it misses (`exchange-rate-providers.md`
  section 6.5) fall through to Yahoo, which has said it is withdrawing API
  access (#1585).
- v2 was already public when the v1 adapter was written (the upstream README
  gained "v2" on 2026-03-16). Nothing records v1 being chosen over it. v1 was
  the documented starting point and v2 was never evaluated.

## 2. Decisions

1. **A separate provider, not a version switch.** `frankfurter_v2` is its own
   `FX_PROVIDER_NAMES` token, adapter file, `source` slug, breaker id and base
   URL variable. The two serve different data (one bank's reference rate
   against a blend of many), and a stored row has to say which one it is.
   Because the coverage fingerprint is the ordered list of source slugs
   (`ExchangeRateHistoryService.providerFingerprint`), adding `frankfurter_v2`
   to the chain turns every `exchange_rate_coverage` row written under v1
   into an unestablished row. The 1999 floors v1 recorded are then not
   trusted, with no migration. The two adapters can also run side by side for
   comparison. Rejected: pointing `FX_FRANKFURTER_BASE_URL` at `/v2`, because
   the paths and the response shapes differ (section 3) and every v1 request
   would fail as unreadable. Rejected: a `FX_FRANKFURTER_API=v1|v2` switch
   inside the v1 adapter, because it would label two datasets with one slug
   and leave the coverage fingerprint unchanged, so the 1999 floors would
   survive the switch.
2. **The blended feed, no `providers` parameter.** v2 serves a blended
   daily range of any length in one response. Naming providers recomputes
   the blend per date and is refused (422) for a daily range longer than five
   years. A single named provider is exempt, but no single provider covers
   every pair. Rejected: pinning a provider per pair (FRED for USD crosses,
   say), because it moves the source choice into this adapter and changes the
   answer for a pair when its pinned provider's history ends.
3. **Weekend rows are dropped.** The blend publishes a row for every calendar
   day that any provider's latest observation reaches. A Saturday row is
   rebuilt from the Friday (and earlier) observations of other banks
   (`expand=providers` on 2026-11-07 shows this). It observes nothing new,
   and `resolveFxRate` already carries Friday forward. Keeping weekend rows
   would also put USD/CAD from 1953 at 23,453 rows, over
   `STORED_RATE_ROW_CAP` (20,000), so the currency detail page would truncate
   its oldest years. The 18,970 weekday rows fit under the cap. Dropping them
   also keeps the history's character close to v1's and Yahoo's, which are
   weekday-only. A weekday holiday row (2024-01-01) is kept, because the
   adapter cannot tell a holiday re-blend from a real observation without
   `expand=providers`, which has the five-year limit. Open question 2.
4. **`fetchLatest` on a weekend asks for the Friday.** When `latest` comes
   back dated Saturday or Sunday (a manual refresh on a weekend), the adapter
   asks once more with `date=` the Friday before that date. The answer is
   then Friday's rate dated Friday, which is what v1 returns. It never stores
   a weekend row (decision 3) and never answers "nothing" for a pair v2
   carries, which would send the pair on to Yahoo. The scheduled fiat refresh
   runs on weekdays (`docs/cron-jobs.md`), so the extra call happens only for
   a refresh someone starts on a weekend.
5. **The currency list is fiat only.** `carries` reads `GET /v2/currencies`
   and keeps the entries whose `type` is `currency` (161 on 2026-11-16).
   `crypto` (35) and `metal` (4) are dropped. A coin is priced only by the
   crypto provider (INV-CRYPTO-002), and the chain already never asks a fiat
   provider about a claimed code. Filtering here means a coin Monize has not
   mapped yet is not quietly priced from a blend either. The list is held for
   24 hours, as v1's is. The instance serves it with `max-age=3600`, but the
   catalogue only changes when a provider is added, so a day's lag costs
   nothing.
6. **422 is "did not answer".** v2 answers an unknown code with 422
   `{"status":422,"message":"invalid currency: XYZ"}` and fails the whole
   request, where v1 dropped the symbol. `carries` screens every code against
   the instance's own list, so a 422 means that list and `/rates` disagree.
   Returning `null` lets the chain ask the next provider. An empty answer
   would be remembered as an empty window (INV-FX-005), and a 422 is not a
   statement that the window is empty. The 422 is not a transport failure, so
   the breaker does not count it. It is logged once through `logFailure`.
7. **Own breaker id, own env variable.** The breaker id is `frankfurter_v2`
   (label "Frankfurter v2") and the base URL variable is
   `FX_FRANKFURTER_V2_BASE_URL`, default `https://api.frankfurter.dev/v2`. The
   breaker id is the key of the durable alert state, and an alert has to name
   the adapter that failed. When both adapters are configured and the shared
   host goes down, an operator gets two alerts. That is accepted while both
   exist.
8. **The series timeout is 120 s.** The full USD/CAD history in one request
   (1.48 MB, 23,453 rows) took 30.6 s uncached on 2026-11-16, half of v1's
   60 s timeout. `latest` and the currency list keep 15 s.
9. **Not the default, at first.** Superseded by section 8: v2 shipped opt-in
   (`FX_PROVIDERS=frankfurter_v2,yahoo`) and is now the fixed first provider.
   Stored rows are not rewritten. A refresh writes today's row under the first provider
   that answers, and a gap fill writes only the days that are missing, so v1
   rows stay where they are and v2 fills what v1 never had.
10. **The UI names it and files it with Frankfurter.** The source label is
    "Frankfurter (central banks)" and the provider label is "Frankfurter
    (central bank rates)". On the currency detail page, its rows count under
    the existing Frankfurter filter (`rateSourceGroup`), so the filter row
    does not grow a segment for an experiment. The Source column still tells
    the two apart.

## 3. v2, as observed on 2026-11-16

These responses come from the public instance on 2026-11-16 and are the
fixtures in `frankfurter-v2-fx.provider.spec.ts`. The base URL is
`FX_FRANKFURTER_V2_BASE_URL`. A self-hosted instance sets the variable, and
its path may not end in `/v2`.

### 3.1 Endpoints

```text
GET {base}/rates?base=USD&quotes=CAD,EUR,SGD
[{"date":"2026-11-16","base":"USD","quote":"CAD","rate":1.4262},{"date":"2026-11-16","base":"USD","quote":"EUR","rate":0.90573},{"date":"2026-11-16","base":"USD","quote":"SGD","rate":1.2878}]

GET {base}/rates?date=2026-11-13&base=USD&quotes=CAD,EUR
[{"date":"2026-11-13","base":"USD","quote":"CAD","rate":1.4242},{"date":"2026-11-13","base":"USD","quote":"EUR","rate":0.90271}]

GET {base}/rates?date=2026-11-14&base=USD&quotes=CAD          (a Saturday)
[{"date":"2026-11-14","base":"USD","quote":"CAD","rate":1.4243}]

GET {base}/rates?from=2026-11-13&to=2026-11-16&base=USD&quotes=CAD
[{"date":"2026-11-13","base":"USD","quote":"CAD","rate":1.4242},{"date":"2026-11-14","base":"USD","quote":"CAD","rate":1.4243},{"date":"2026-11-15","base":"USD","quote":"CAD","rate":1.4244},{"date":"2026-11-16","base":"USD","quote":"CAD","rate":1.4262}]

GET {base}/rates?from=2024-01-01&to=2024-01-05&base=USD&quotes=CAD
[{"date":"2024-01-01","base":"USD","quote":"CAD","rate":1.3225},{"date":"2024-01-02","base":"USD","quote":"CAD","rate":1.3258},{"date":"2024-01-03","base":"USD","quote":"CAD","rate":1.3318},{"date":"2024-01-04","base":"USD","quote":"CAD","rate":1.3331},{"date":"2024-01-05","base":"USD","quote":"CAD","rate":1.3344}]

GET {base}/rates?from=1985-01-01&to=1985-01-03&base=USD&quotes=CAD   (start moved back)
[{"date":"1984-12-31","base":"USD","quote":"CAD","rate":1.3194},{"date":"1985-01-02","base":"USD","quote":"CAD","rate":1.3216},{"date":"1985-01-03","base":"USD","quote":"CAD","rate":1.321}]

GET {base}/rates?from=1953-05-08&to=1953-05-14&base=USD&quotes=CAD
[{"date":"1953-05-11","base":"USD","quote":"CAD","rate":0.99408},{"date":"1953-05-12","base":"USD","quote":"CAD","rate":0.99455},{"date":"1953-05-13","base":"USD","quote":"CAD","rate":0.99526}]

GET {base}/rates?from=1950-01-01&to=1950-01-10&base=USD&quotes=CAD   -> 200 []
GET {base}/rates?from=2030-01-01&to=2030-01-05&base=USD&quotes=CAD   -> 200 []

GET {base}/rates?from=2024-01-02&to=2024-01-03&base=TWD&quotes=USD
[{"date":"2024-01-02","base":"TWD","quote":"USD","rate":0.032518},{"date":"2024-01-03","base":"TWD","quote":"USD","rate":0.032352}]

GET {base}/rates?base=USD&quotes=CAD,XYZ     -> 422 {"status":422,"message":"invalid currency: XYZ"}
GET {base}/rate/USD/CAD?date=1950-01-01      -> 404 {"status":404,"message":"not found"}

GET {base}/currencies
[{"iso_code":"AAVE","iso_numeric":null,"name":"Aave","symbol":"AAVE","type":"crypto","start_date":"2020-10-10","end_date":"2026-11-15"},
 {"iso_code":"AED","iso_numeric":"784","name":"United Arab Emirates Dirham","symbol":"د.إ","type":"currency","start_date":"1996-04-11","end_date":"2026-11-16"},
 ... 200 entries: 161 currency, 35 crypto, 4 metal]
```

Response headers: `cache-control: public, max-age=17561, stale-if-error=86400`
on `/rates` and `max-age=3600` on `/currencies`, served through Cloudflare. No
rate-limit header.

### 3.2 Facts the adapter is built on

- Each record is one pair: `{date, base, quote, rate}`, and `rate` is "quote
  per 1 base". That is `FxObservation { from: base, to: quote }` with no
  inversion, as in v1.
- The answer is a JSON array, both for `latest` and for a range. There is no
  `rates` map and no `amount`.
- Codes are case-insensitive in the request. The answer is upper-case.
- A range's start can be moved back to the previous published day
  (1984-12-31 for `from=1985-01-01`). The adapter drops records dated before
  `start` or after `end`, as v1's does.
- A window that the pair's history does not reach answers 200 `[]` on
  `/rates`. It is not a 404. Only `/rate/{base}/{quote}`, which the adapter
  does not call, answers 404 for that case.
- A record whose `quote` equals its `base` (the identity record v2 adds when
  the quotes filter allows it) is dropped.
- Rates carry about five significant figures (1.4262, 0.032518).

### 3.3 Status handling

| Response | Adapter result | Breaker |
| --- | --- | --- |
| 200, body parsed | observations (possibly none) | `recordSuccess` |
| 404 | `[]` for a series, empty map for latest, with one `warn` | `recordSuccess` (the host answered) |
| 422 | `null` (decision 6), logged once through `logFailure` | `recordSuccess` |
| 429, 503, other non-2xx | `null`, logged once through `logFailure` | `recordSuccess` |
| transport failure, timeout (15 s latest and list, 120 s series) | `null` | `recordFailure` |
| 200 with a body that is not an array of records | `null`, one unreadable-response line | not counted |

As in v1, there are two `recordSuccess` sites: the non-2xx branch, and the
point where the body has finished arriving.

### 3.4 The compiled-in currency list

When `/currencies` cannot be fetched, this list stands in for five minutes,
as v1's does. It holds the 161 `currency` codes the instance listed on
2026-11-16:

AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL
BSD BTN BWP BYN BZD CAD CDF CHF CLP CMD CNH CNY COP CRC CUP CVE CZK DJF DKK
DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL
HTG HUF IDR ILS IMP INR IQD IRR ISK JEP JMD JOD JPY KES KGS KHR KMF KPW KRW
KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR
MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR
RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL
THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF
XCD XCG XDR XOF XPF YER ZAR ZMW ZWG

### 3.5 History start of Monize's currencies

These are the `start_date` values from `/currencies` on 2026-11-16. They are
the catalogue's dates. `/coverage` gives the queryable start of a particular
pair, which can be later, because a pair needs both its codes (USD/CAD is
1953-05-11).

| Before 1960 | 1960 to 1989 | 1990 to 1999 |
| --- | --- | --- |
| USD 1948, GBP CHF DKK NOK SEK 1949, CAD 1953 | JPY 1969; AUD NZD MYR 1971; INR 1973; ZAR 1980; HKD KRW SGD TWD CNY THB 1981; CLP 1982; OMR SAR 1986 | CZK 1991, MXN 1991, IDR HUF 1993, KWD 1993, EGP 1994, BRL 1994, PLN 1995, TRY ILS AED 1996, RUB 1998, PHP COP BDT PEN BHD ARS VND PKR 1998, EUR NGN 1999 |

## 4. What is built

| Piece | File |
| --- | --- |
| The adapter | `backend/src/currencies/providers/frankfurter-v2-fx.provider.ts` |
| Its spec, on the section 3 fixtures | `backend/src/currencies/providers/frankfurter-v2-fx.provider.spec.ts` |
| The chain order | `FX_PROVIDER_NAMES` in `fx-provider.interface.ts` (`frankfurter_v2`, `yahoo`), and its frontend mirror in `frontend/src/lib/exchange-rates.ts` |
| The wiring | `CurrenciesModule` factory, built from `FX_FRANKFURTER_V2_BASE_URL` |
| The breaker id | `TRACKED_PROVIDERS.frankfurter_v2`, labelled "Frankfurter" |
| The guards | `provider-call.guard.spec.ts` (the client list, two `recordSuccess` sites) and `fx-provider-source.guard.spec.ts` (the slug, with the retired `frankfurter` kept on its list) |
| The labels | `currencies.page.providers.names.frankfurter_v2` and `currencyDetail.sources.frankfurterV2`, in every locale; `currencyDetail.sources.frankfurter` stays for the v1 rows; `rateSourceGroup` files both under the Frankfurter filter (`frontend/src/lib/currency-detail.ts`) |
| Operator docs | `.env.example` (`FX_FRANKFURTER_V2_BASE_URL`) |

Nothing changes in the chain, the history service, the gap planner or the
schema.

## 5. How to check it

1. The Currencies page reads "Rates from Frankfurter (central bank rates),
   then Yahoo Finance".
2. On a currency whose transactions predate 1999 (CAD, against a USD
   reporting currency), press Fill gaps, or import, restore or bank-sync rows
   that reach back that far. The stored history should start at the first
   transaction date, or 1953-05-11 if that is earlier. The new rows show
   "Frankfurter (central banks)" as their source.
3. Where a date already has a v1 row it is kept, labelled "Frankfurter (ECB)".
4. Weekends: no Saturday or Sunday row appears in the new history.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| A pair's series changes character at the 1999 boundary (blend before, ECB after) when v1 rows already exist | Open question 1 decides; a cutover can re-fill with v2 by deleting the v1 rows of a pair |
| The blend excludes outliers and mixes rate types (interbank middle, transfer, official), so a rate is not any one bank's | Named here and in the source label; the Source column says which feed wrote a row |
| Frankfurter adds a provider whose history changes an old blend | The rows are written once and not refreshed; the same is true of v1 |
| The public instance withdraws v2 or changes its shape | The adapter answers `null` on an unreadable body, so the chain falls through to the next provider |
| Two breaker alerts for one host outage | Accepted while both adapters exist (decision 7) |

## 7. Open questions

1. **Option or cutover.** Answered 2026-11-16: cutover, with no choice
   offered (section 8). The slug stays `frankfurter_v2`; nothing is
   relabelled.
2. **Weekend rows.** Decision 3 drops them. For a currency whose market week
   is Sunday to Thursday (SAR, KWD, BHD, OMR, AED, EGP), a Sunday blend may
   include a real local observation. If testing shows Sunday rows matter for
   those currencies, the rule can become "drop a weekend row only when the
   pair's two codes both keep a Monday-to-Friday week", at the cost of a
   per-currency table.
3. **The 1999 seam when both run.** Moot since the cutover: v1 is gone. A
   pair's history may still hold v1 rows from 1999 where they were stored
   before it, beside v2 rows for the years before and the days since.

## 8. The cutover (2026-11-16)

After testing, the maintainer chose to replace v1 rather than offer a choice.

1. **The v1 adapter and `FX_PROVIDERS` are removed.** `frankfurter-fx.provider.ts`,
   `fx-provider.config.ts` (`resolveFxProviders`, `DEFAULT_FX_PROVIDERS`,
   `FxProviderConfigError`) and `FX_FRANKFURTER_BASE_URL` are gone. The module
   factory builds the chain from `FX_PROVIDER_NAMES` in order. A deployment
   that still sets `FX_PROVIDERS` starts normally, and the variable is ignored.
2. **The slug stays `frankfurter_v2`.** Renaming it to `frankfurter` would
   attribute the blend to the rows v1 wrote. It would also make the coverage
   fingerprint equal v1's again (`frankfurter,yahoo_finance,yahoo_crypto`), so
   the 1999 floors v1 recorded would be trusted, and no fill would reach back
   before them. With the slug kept, the first fill under the new chain
   replaces those floors (`exchange_rate_coverage.providers`).
3. **The breaker id stays `frankfurter_v2`, labelled "Frankfurter".** A
   `provider_health` row left under the old id `frankfurter` is never written
   again. An alert for it reads the raw id.
4. **A bank sync now pulls rate history too.** An import (CSV, QIF, OFX, a
   Money file) and a backup restore already started
   `RateHistoryCatchUpService` after their commit (issues #2186, #2226). A
   bank sync did not, so a foreign-currency account whose sync start predated
   the stored rates converted those days at no rate until someone pressed
   Fill gaps. `BankSyncService` now starts the same catch-up after a write
   that imported, merged or replaced a row, for the synced account and every
   account a rule moved money into. It re-dispatches their net worth once
   rates land. `bank-sync.service.spec.ts` holds that order, the account
   list, and that nothing starts for a sync that wrote nothing or failed.
