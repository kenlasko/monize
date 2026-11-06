# Exchange rate providers

Shipped (S1, B1 to B6, F1, R1 and the acceptance task Q are merged;
`backend/src/currencies/providers/`, `FX_PROVIDERS` in `.env.example`). Kept
as the specification: an ordered chain of FX providers behind one interface,
configured per deployment, with Frankfurter (the ECB reference rates, no key,
no request cap, history from 1999) first and Yahoo Finance second. This
document carries its own contracts, truth tables and recorded fixtures
(sections 4 to 7) because there is no other spec for it; the operator view is
`docs/backend/securities-and-providers.md`.

## 1. Goal

- Exchange rates keep arriving when Yahoo stops answering. Yahoo has said
  (issue #1585) that API-level access to its quotes is being withdrawn, and
  every FX read in Monize goes through it today.
- An operator chooses the providers and their order with one environment
  variable, and a new provider is one file, one constant and one line of
  documentation: no caller changes.
- Frankfurter ships as the first alternative. It carries 30 currencies, 28 of
  Monize's 44 (section 6.5), with daily history back to 1999-01-04, which is
  longer than Yahoo's FX history (`USDCAD=X` starts in December 2003).
- Nothing a reader is told changes shape: a rate is still a dated observation
  in one stored orientation, resolved through `resolveFxRate`, and an
  unavailable rate is still `null` (INV-FX-001, INV-FX-003).

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
| --- | --- | --- |
| The FX reads and writes | `ExchangeRateService` (`backend/src/currencies/exchange-rate.service.ts`) | Every provider call is one of three private methods building `${from}${to}=X` and calling `YahooFinanceService`; the `source` literal `'yahoo_finance'` is hard-coded in `upsertCanonicalRate` and `persistRateSeries`. B2 replaces the three methods with the chain. |
| The window door | `ExchangeRateService.fillRateWindow` (direct symbol, then reverse, `{ stored, answered }`) | Public for `ExchangeRateHistoryService`; keeps its signature. The reverse-symbol rule moves into the Yahoo adapter. |
| Gap fill | `ExchangeRateHistoryService` (`backend/src/currencies/exchange-rate-history.service.ts`), `backend/src/currencies/rate-gap-plan.ts` | Unchanged: it calls `fillRateWindow` and reads `answered`. |
| The resolver | `resolveFxRate` (`backend/src/common/time-series/fx-rate-resolver.ts`) | Unchanged. Providers never resolve; they observe. |
| The one orientation | `canonicalRateRow` (`backend/src/currencies/canonical-rate.util.ts`) | Unchanged. A provider returns observations in whichever orientation it answered; the writer orients them. |
| The Yahoo client | `YahooFinanceService` (`backend/src/securities/yahoo-finance.service.ts`): `fetchQuote`, `fetchHistoricalWindow` | Wrapped by the Yahoo FX adapter; its throttle, retry and breaker stay. |
| The breaker | `ProviderHealthService` (`backend/src/provider-health/provider-health.service.ts`), `TRACKED_PROVIDERS` (`backend/src/provider-health/providers.ts`), `backend/src/provider-health/provider-call.guard.spec.ts` | Frankfurter joins the tracked ids; the guard's scanned directories widen to the FX clients. |
| The provider-selection precedent | `QUOTE_PROVIDER_NAMES` and `QuoteProviderRegistry` (`backend/src/securities/providers/quote-provider.interface.ts`, `backend/src/securities/providers/quote-provider.registry.ts`) | The names-array-as-single-source-of-truth pattern is copied. The per-security and per-user selection is not: exchange rates are deployment-wide reference data. |
| The env-selected provider precedent | `ATTACHMENT_STORAGE_PROVIDER` factory in `backend/src/attachments/attachments.module.ts` | The chain is built the same way, from `ConfigService`, in `backend/src/currencies/currencies.module.ts`. |
| Currency lookup and verification | `CurrenciesService.lookupCurrency`, `verifyAndReturnCurrency` (`backend/src/currencies/currencies.service.ts`) | Two bare `fetch` calls to Yahoo, outside the breaker. B5 routes them through the chain. |
| The refresh surfaces | `POST /currencies/exchange-rates/refresh`, `GET /currencies/exchange-rates/status` (`backend/src/currencies/currencies.controller.ts`); the Currencies page (route /currencies) and `frontend/src/components/currencies/RateHistoryCoverage.tsx` | B6 and F1 add which providers are configured and which one each stored rate came from. |
| Env documentation guards | `scripts/check-env-docs.mjs`, `.env.example` | Every new `configService.get` is documented in the same PR. |

## 3. Decisions

1. **An ordered chain, configured for the deployment, not per user.**
   `exchange_rates` is shared reference data with no owner column (INV-FX-004),
   so the choice of source belongs to the operator: `FX_PROVIDERS`, a
   comma-separated ordered list, read once at boot. Rejected: a per-user
   provider as `default_quote_provider` is for securities, because two users
   would then write different rates into the one table for the same date.
2. **The default order becomes `frankfurter,yahoo`, in its own PR (R1).** Until
   R1 the default is `yahoo` alone, so every task before it is
   behaviour-preserving and an operator can opt in early by setting the
   variable. Rejected: `yahoo,frankfurter` as the default, because the issue
   exists precisely because Yahoo is going away, and the maintainer named
   Frankfurter the best option on the issue.
3. **A provider answers three questions and nothing else:** the latest rate of
   one base against many quotes, a daily series over a date window, and
   optionally a live quote (section 4). `null` means "did not answer"; an
   empty result means "answered, nothing there". Observations carry their own
   orientation and date. Rejected: a per-pair `fetchRate(from, to)` as the
   batch unit, because Frankfurter answers every quote of a base in one call
   and the refresh asks for every pair of the currencies in use.
4. **A provider is asked only for pairs it carries.** `carries(code)` is
   answered from a currency list (Frankfurter: its own list, cached a day;
   Yahoo: always true, it cannot enumerate). So RUB or TWD never costs a
   Frankfurter call and goes straight to the next provider. The chain's
   `answered` is "every provider that carries the pair answered", which is
   the rule `fillRateWindow` holds today for its two symbols (section 5).
5. **The provider dates the observation.** Frankfurter's `date` is the ECB
   reference date; on a Saturday `latest` is Friday's rate dated Friday, and
   no Saturday row is written. The Yahoo adapter keeps dating a quote
   `todayYMD()`, as the refresh does now, so B2 changes no Yahoo row.
6. **`source` comes from the provider.** `exchange_rates.source` gains the
   value `frankfurter` beside `yahoo_finance` and `mny_import`; no schema
   change, the column is already `varchar(50)`. A guard spec bans a source
   literal anywhere in `backend/src/currencies/` outside the provider classes
   (INV-FX-005).
7. **Frankfurter calls go through the breaker** under the tracked id
   `frankfurter`, and `provider-call.guard.spec.ts` scans the new directory,
   so a later FX client cannot reach `fetch` without it.
8. **"Live" degrades honestly.** `getLiveRate` asks the providers that
   implement `fetchLive` first (Yahoo, while it answers), then the chain's
   latest daily observation, then the stored rate in `live` mode. The intraday
   FX series behind the portfolio chart (`fetchIntradayFxSeries` in
   `backend/src/securities/portfolio.service.ts`) stays Yahoo-direct and out of
   scope; it already falls back to a flat stored rate.
9. **Currency lookup and verification use the chain** (B5): a code is
   verified when any configured provider carries it; the free-text Yahoo
   search moves behind `YahooFinanceService`'s throttled door. Rejected:
   leaving the two bare `fetch` calls, because they are the last FX callers
   outside the breaker and the guard cannot cover `currencies/` while they
   exist.
10. **The Yahoo adapter cross-checks a placeholder quote** (B4): the reporter
    on #1585 saw Yahoo answer `0.01` with HTTP 200 for a pair whose base is
    thinly quoted. A direct quote equal to the placeholder is checked against
    the reverse symbol, and the reverse orientation is used and remembered for
    the process when they disagree (section 7.3). This is the maintainer's
    "look at the inverse pair and use it from then on".
11. **Unknown provider names refuse the boot.** The module factory throws
    naming the valid names, so a typo in `FX_PROVIDERS` is a failed start
    with one clear line, not a deployment quietly calling a provider the
    operator meant to exclude. Rejected: fall back to the default list, which
    is what `resolvePositiveInt` does for a numeric knob, because here the
    default may be the thing the operator was turning off.
12. **No new columns, no cron variable, no manual-rate UI** (section 13). The
    issue's items 3 and 4 are partly met already (a stored rate within
    `FX_MAX_RATE_AGE_DAYS` is what a failed refresh falls back to; a tracked
    provider's outage raises the existing system alert) and the rest is a
    separate feature.
13. **Addendum, 2026-11-05: a pair provider claims the coins**
    (`docs/specs/crypto-accounts.md` decision 5, INV-CRYPTO-002). The crypto
    adapter (`CryptoFxProvider`, a `PairProviderName`, appended by the module
    factory after whatever `FX_PROVIDERS` names and never accepted as a token)
    answers an optional `claims(code)`: a pair with a claimed code on either
    side is asked only of a provider that claims one of its codes, and an
    unclaimed pair only of a provider that claims nothing; a `claims` or
    `carries` that throws is "could not say", so the pair is asked of nobody
    and reported unanswered (the last rows of section 5), never handed to a
    provider that claims nothing.

## 4. Provider contract

`backend/src/currencies/providers/fx-provider.interface.ts`:

```ts
export const FX_PROVIDER_NAMES = ["frankfurter", "yahoo"] as const;
export type FxProviderName = (typeof FX_PROVIDER_NAMES)[number];

/** One dated observation: multiply an amount in `from` by `rate` to get `to`. */
export interface FxObservation {
  from: string;
  to: string;
  /** YYYY-MM-DD, the day the provider says the rate was struck. */
  date: string;
  rate: number;
}

export interface FxRateProvider {
  readonly name: FxProviderName;
  /** The `exchange_rates.source` slug this provider's rows carry. Stable: it is read back by the UI. */
  readonly source: string;
  /** Whether the provider quotes this code at all. Answered from a cached list, never one call per pair. */
  carries(code: string): Promise<boolean>;
  /**
   * The latest published rate of `base` against each of `quotes`.
   * `null`: no answer. A quote absent from the map: answered, no rate for it.
   * Observations may come back in either orientation.
   */
  fetchLatest(base: string, quotes: readonly string[]): Promise<ReadonlyMap<string, FxObservation> | null>;
  /**
   * Daily observations dated within [start, end] inclusive, either orientation.
   * `null`: no answer. `[]`: answered, nothing in the window.
   */
  fetchDailySeries(from: string, to: string, start: string, end: string): Promise<FxObservation[] | null>;
  /** Optional: an intraday quote. Only a provider with a live market feed implements it. */
  fetchLive?(from: string, to: string): Promise<FxObservation | null>;
  /** Optional: whether the provider knows this code (a lookup aid, B5). `null`: no answer. */
  verifyCurrency?(code: string): Promise<boolean | null>;
  /** Optional: a free-text search resolving to a code (a lookup aid, B5). */
  searchCurrency?(query: string): Promise<string | null>;
}
```

`FxProviderChain` (`backend/src/currencies/providers/fx-provider-chain.ts`)
holds the configured providers in order and answers:

- `latest(base, quotes)`: `{ found: Map<quote, FxObservation & { source }>, unanswered: string[] }`.
  Each quote goes to the first provider that carries both codes; a quote the
  provider answered without a rate, or did not answer, is passed to the next.
  `unanswered` lists the quotes no carrying provider answered at all.
- `dailySeries(from, to, start, end)`: `{ points: FxObservation[], answered: boolean, source: string | null }`
  by the table in section 5.
- `live(from, to)`: the first `fetchLive` answer, else the first `latest`
  observation for the pair, else `null`.
- `carriesAny(code)` and `describe()` (name and source per provider, for the
  status endpoint).

`ExchangeRateService` keeps its public surface. Inside, `saveRate` and
`persistRateSeries` take the observations and the `source` the chain reports,
and `canonicalRateRow` orients each one as it does now. The refresh groups the
canonical pairs by their first code and asks `latest(base, quotes)` once per
base: for the currencies USD, CAD, EUR, SGD that is three Frankfurter calls
instead of six Yahoo calls. The backfill asks `dailySeries(from, to,
earliestTransactionDate, today)` instead of Yahoo's `range=max` and a filter;
the bars kept are the same.

## 5. Chain semantics, as a truth table

For one window and two configured providers P1 then P2. "carries" is
`carries(from) && carries(to)`. `carried` is whether any provider that may be
asked carries the pair; a provider that could not say counts as carrying.

| P1 carries | P1 answer | P2 carries | P2 answer | points | answered | carried | source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no | not asked | yes | series | P2's | true | true | P2 |
| yes | series | not asked | not asked | P1's | true | true | P1 |
| yes | `[]` | yes | series | P2's | true | true | P2 |
| yes | `[]` | yes | `[]` | `[]` | true | true | null |
| yes | `null` | yes | series | P2's | true | true | P2 |
| yes | `null` | yes | `[]` | `[]` | **false** | true | null |
| yes | `null` | yes | `null` | `[]` | false | true | null |
| no | not asked | no | not asked | `[]` | true | **false** | null |
| not asked (claim unknown), `dailySeries` | not asked | `claims` threw | not asked | `[]` | **false** | true | null |
| not asked (claim unknown), `latest` | not asked | `claims` threw | not asked | none, the quote is `unanswered` | false | -- | null |
| not asked (claim unknown), `live` | not asked | `claims` threw | not asked | `null` | false | -- | null |
| not asked (claimed pair), `dailySeries` | not asked | `carries` threw | not asked | `[]` | false | true | null |
| not asked (claimed pair), `dailySeries` | not asked | claims, does not carry (no `quote_symbol`) | not asked | `[]` | true | **false** | null |
| not asked (claimed pair), `latest` | not asked | claims, does not carry (no `quote_symbol`) | not asked | none, the quote is `uncarried` | -- | false | null |

The sixth row is the one that matters: P1 may hold history for the window
that P2 does not (Frankfurter reaches 1999, Yahoo's `USDCAD=X` 2003), so a
window P1 never answered may not be remembered as empty. This is the rule
`fillRateWindow` already applies to its direct and reverse symbols, now per
provider. The eighth row is a pair no configured provider quotes: a fact, not
an outage, so it is `answered`, and the refresh reports the pair as failed
with "no configured provider carries X/Y". It is also `carried: false`, and
an uncarried window is never remembered as empty nor written to
`exchange_rate_coverage`: nobody was asked, so it says nothing about any
provider's history, and forgetting it costs no provider call.

For `latest`, the same per quote: a quote moves to the next provider on
`null` or on absence from the map; it is `unanswered` only when every
carrying provider returned `null`.

The six rows after the eighth are a chain whose P2 claims codes (the crypto
adapter, decision 13) and whose P1 claims nothing (Yahoo, whose `carries` is
always true). When P2's `claims` throws (its read of `currencies` failed),
the chain cannot tell whether the pair has a coin side, so it asks nobody:
`dailySeries` is not `answered`, the `latest` quote is `unanswered` (the
refresh's "No provider answered", retried next tick) and `live` is `null`.
When the pair is claimed and P2's `carries` throws, P2 is the only provider
that may be asked, so the pair is likewise unanswered. Reading either throw
as `false` would hand a coin pair to Yahoo's `=X` grammar and store a coin
rate under `yahoo_finance`. The crypto adapter rejects both for a code its
read of `currencies` does not hold, too, whether a re-read is throttled or
already happened: every code in use has a `currencies` row, so absence means
the read is stale, not that the code is fiat.

The last two rows are a coin without a `quote_symbol`: claimed by P2, carried
by nobody, so nobody is asked. The quote is `uncarried` (the refresh's "<code>
has no price symbol; map one on the Currencies page") and the window is
`carried: false`. Recording that window, as `ensureRatesForDate` and the
gap fill otherwise record an answered empty one, would outlive the symbol the
reader maps next: `exchange_rate_coverage` is scoped to the provider
fingerprint, which a symbol does not change, so every past window would be
skipped and the gap fill would claim the provider's history starts today.
The gap fill refuses the pair with that message and records nothing, and
setting or re-pointing a coin's ticker deletes the code's coverage rows in
the same transaction and forgets the process's empty windows for it
(`CurrenciesService.kindUpdates`). `fx-provider-chain.spec.ts` holds these
rows in "FxProviderChain and a provider that claims coins".

## 6. Frankfurter, as observed on 2026-10-07

All responses below were recorded from the public instance on 2026-10-07 and
are the fixtures for `frankfurter-fx.provider.spec.ts`. Base URL
`FX_FRANKFURTER_BASE_URL`, default `https://api.frankfurter.dev/v1`; a
self-hosted instance sets the variable (its path may not include `/v1`).

### 6.1 Endpoints

```text
GET {base}/latest?base=USD&symbols=CAD,EUR,SGD
{"amount":1.0,"base":"USD","date":"2026-10-07","rates":{"CAD":1.4253,"EUR":0.89469,"SGD":1.2804}}

GET {base}/2024-01-01..2024-01-05?base=USD&symbols=CAD
{"amount":1.0,"base":"USD","start_date":"2023-12-29","end_date":"2024-01-05",
 "rates":{"2023-12-29":{"CAD":1.3251},"2024-01-02":{"CAD":1.3294},"2024-01-03":{"CAD":1.3347},
          "2024-01-04":{"CAD":1.3332},"2024-01-05":{"CAD":1.3369}}}

GET {base}/currencies
{"AUD":"Australian Dollar","BRL":"Brazilian Real", ... 30 entries ...}

GET {base}/latest?base=USD&symbols=TWD          -> HTTP 404 {"message":"not found"}
GET {base}/latest?base=TWD&symbols=USD          -> HTTP 404 {"message":"not found"}
GET {base}/latest?base=USD&symbols=CAD,TWD      -> HTTP 200, rates has CAD only
GET {base}/2026-10-04?base=USD&symbols=CAD      -> date "2026-10-02" (a Sunday answers with Friday)
GET {base}/1998-01-01..1999-01-08?base=USD&symbols=CAD -> start_date "1999-01-04", five rows
```

Response headers: `cache-control: public, max-age=86400`, served through
Cloudflare. No rate-limit header; the project states no request cap.

### 6.2 Facts the adapter is built on

- `rates[Q]` under `base=B` is "Q per 1 B", so it is `FxObservation { from: B, to: Q }`
  with no inversion. `base=USD`, `CAD: 1.4253` means 1 USD = 1.4253 CAD.
- Cross rates are computed by Frankfurter through EUR and are symmetric:
  USD to SGD asked directly is 1.2804; `1.4311 / 1.1177` from the EUR table is
  1.2804. The adapter never needs the reverse pair.
- A range or a date falling on a non-business day is moved **back** to the
  previous business day, and the start of a range is too. `fetchDailySeries`
  drops observations dated before `start`, so the window contract holds.
- A date range of any length answers daily: 773 rows for 2020 to 2022, 2,560
  for 2010 to 2019, in one response. `GAP_WINDOW_MAX_DAYS` stays, for Yahoo.
- History begins 1999-01-04. Asking before it answers from that date; a window
  wholly before it was recorded here as answering `rates: {}`, but on
  2026-10-12 it answered 404 `{"message":"not found"}` (B3's dated fixture).
  Both are "answered, nothing" to the adapter, so a 404 is not only the
  uncarried-symbol case below.
- A symbol the instance does not carry is silently dropped from `rates`; a
  base it does not carry, or a request whose every symbol is unknown, is a
  404 `{"message":"not found"}`. `carries` keeps both cases from being asked.
- Rates are published to about five significant figures (0.89469, 17871).
  The column is `decimal(20,10)`; nothing rounds further.
- `amount` scales the whole answer; the adapter never sends it.

### 6.3 Status handling

| Response | Adapter result | Breaker |
| --- | --- | --- |
| 200, body parsed | observations (possibly none) | `recordSuccess` |
| 404 | `[]` for a series, empty map for latest (answered, nothing) with one `warn` naming the request, because `carries` should have prevented it | `recordSuccess` (the host answered) |
| 429, 5xx, other non-2xx | `null` | `recordSuccess` (an answer about availability), logged once through `logFailure` |
| transport failure, timeout (15 s latest, 60 s series) | `null` | `recordFailure` via `logFailure` |
| 200 with a body that does not parse | `null` | counted as a failure by `logFailure` |

Two `recordSuccess` sites, the same split as Google Places: the non-2xx branch
and the point the body finished arriving.

### 6.4 The currency list

`carries(code)` reads `GET {base}/currencies` once, cached for 24 hours in the
process (the response's own `max-age`), through the breaker. When the list
cannot be fetched, the compiled-in set recorded here stands in, so a
Frankfurter outage at boot does not make the adapter claim it carries
nothing:

AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR
NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR (30).

### 6.5 Coverage of Monize's currencies

Of the 44 codes in `backend/src/currencies/currency-metadata.ts`, Frankfurter
carries 28. The 16 it does not, which the chain sends to the next provider:

RUB TWD CLP SAR AED COP PEN ARS NGN EGP VND PKR BDT KWD BHD OMR.

A third provider that carries these (ExchangeRate-API's open endpoint carries
about 160 codes, no key) is the natural next adapter and is out of scope
here; the chain makes it one file, one entry in `FX_PROVIDER_NAMES` and one
line in `.env.example`.

## 7. Worked examples

### 7.1 One refresh observation, stored

Frankfurter, `base=USD`, `CAD: 1.4253`, `date: 2026-10-07` becomes
`{ from: "USD", to: "CAD", date: "2026-10-07", rate: 1.4253 }`.
`canonicalRateRow` orders CAD before USD, so the row written is
`(CAD, USD, 2026-10-07, 0.7016066793, 'frankfurter')`, and
`resolveFxRate("USD", "CAD", "2026-10-07")` answers 1.4253 through the
inverse direction, as it does for every pair stored the other way today.

### 7.2 A Saturday

On Saturday 2026-10-10 the cron does not run (weekdays only). A startup
refresh that day asks `latest` and gets `date: "2026-10-09"`; the upsert
touches Friday's row and writes nothing new. `getRateForDate` for the
Saturday carries Friday forward (`historical` mode, 1 day old, within
`FX_MAX_RATE_AGE_DAYS`). Today's Yahoo path writes a Saturday row holding
Friday's close; the figure a reader sees is the same.

### 7.3 The Yahoo placeholder (B4)

Direct `IDRUSD=X` answers `regularMarketPrice: 0.01` (the placeholder the
reporter saw). The adapter fetches `USDIDR=X`, which answers 17871; the
implied direct rate is `1 / 17871 = 0.0000559566`, which disagrees with 0.01
by far more than the 1 % tolerance, so the reverse observation
`{ from: "USD", to: "IDR", rate: 17871 }` is returned, and the pair is
remembered as "ask reverse first" for the life of the process. Had the two
agreed within tolerance, the direct quote would have been returned: a real
rate can be 0.01.

### 7.4 A window Frankfurter has and Yahoo does not

`fillRateWindow("USD", "CAD", "2001-03-01", "2001-03-31")` with the default
chain: Frankfurter carries both, answers 22 observations, `answered: true`,
source `frankfurter`; Yahoo is not asked. With `FX_PROVIDERS=yahoo` the same
call is what it is today: Yahoo's 400 "Data doesn't exist" is read as an
answer about the symbol, `[]`, `answered: true`, and the month is remembered
as empty.

## 8. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FX_PROVIDERS` | `yahoo` until R1, then `frankfurter,yahoo` | Ordered, comma-separated, case-insensitive, duplicates dropped. Any name outside `FX_PROVIDER_NAMES` refuses the boot with a line naming the valid names. |
| `FX_FRANKFURTER_BASE_URL` | `https://api.frankfurter.dev/v1` | A self-hosted Frankfurter or a proxy. Trailing slash tolerated. |

Both are read through `ConfigService` in the module factory and documented in
`.env.example` in the PR that reads them (`node scripts/check-env-docs.mjs`).
A later keyed provider reads `FX_<PROVIDER>_API_KEY` by the same route; the
issue's `FX_API_KEY` and `FX_FALLBACK_PROVIDER` are not adopted, because the
order already says what falls back to what and a key belongs to one provider.

## 9. Where each rule is held

| Rule | Mechanism | Task |
| --- | --- | --- |
| One source of truth for provider names | `FX_PROVIDER_NAMES`; the config parser and the UI label list derive from it | B1, F1 |
| A pair is asked of providers in the configured order | `FxProviderChain`, built once by the module factory from `FX_PROVIDERS` | B1 |
| "Answered nothing" and "did not answer" kept apart per provider | the section 5 table as `fx-provider-chain.spec.ts` cases; adapters return `null` only for a non-answer | B1, B3 |
| A stored rate names its provider | `source` taken from the chain's answer; `fx-provider-source.guard.spec.ts` bans a source literal in `backend/src/currencies/` outside `backend/src/currencies/providers/` and bans an import of `YahooFinanceService` there outside the Yahoo adapter | B2 |
| Every FX client calls through the breaker | `provider-call.guard.spec.ts` scans `currencies/providers` (B3) and `currencies` (B5); `frankfurter` in `TRACKED_PROVIDERS` | B3, B5 |
| One stored orientation | `canonicalRateRow`, unchanged | exists |
| A bad `FX_PROVIDERS` is a failed boot, not a silent default | the factory throws `FxProviderConfigError` | B1 |
| The provider dates the observation | `FxObservation.date`; the refresh passes it to `saveRate` instead of `today` | B2 |
| A provider is not asked for a code it does not carry | `carries` before every call in the chain | B1, B3 |
| Which provider is configured is visible | `GET /currencies/exchange-rates/status` lists them; the Currencies page shows them | B6, F1 |

## 10. Order of work

| Phase | Tasks | What ships | Behaviour change |
| --- | --- | --- | --- |
| 0 | S1 | This plan; INV-FX-005 registered unenforced | none |
| 1 | B1 | The contract, the config parser, the chain, the Yahoo adapter; nothing calls them | none |
| 2 | B2, B3, B4 | `ExchangeRateService` on the chain (default `yahoo`); the Frankfurter adapter, selectable by env; the placeholder cross-check | B2: the refresh tries the reverse Yahoo symbol when the direct one has no quote (today it reports the pair failed). B4: a placeholder quote is replaced by the reverse pair's. |
| 3 | B5, B6 | Currency lookup through the chain and the breaker; the status endpoint lists the providers | none |
| 4 | F1 | The Currencies page and the rate-history dialog name the providers; an all-failed refresh is an error toast | none |
| 5 | R1 | Default `frankfurter,yahoo`; docs; release note | New rows for the 28 ECB-covered currencies come from Frankfurter: the ECB 16:00 CET reference rate dated by the ECB, not Yahoo's quote dated today. Stored history is not rewritten. |
| 6 | Q | Every locale; INV-FX-005 enforced | none |

B3 is inert because `yahoo` is the whole default list until R1. B2 is the
only rewrite of a live path before R1, and its gate is the existing
`exchange-rate.service.spec.ts` green with the chain behind a typed fake
whose answers are the ones the real Yahoo adapter produces.

## 11. What a reader sees when something is missing

Unchanged in every case; listed so the tasks can check against it.

- A pair no configured provider carries: the refresh counts it failed; the
  gap fill reports `providerHasNothingBefore` from the remembered empty
  windows; every conversion answers `null` (INV-FX-001).
- A provider outage: the refresh counts its pairs failed, the breaker opens
  after five transport failures, the existing provider-outage alert reaches
  the administrators under the label `Frankfurter` or `Yahoo Finance`, and the
  gap fill answers 503 "the exchange rate provider did not answer" only when
  **no** carrying provider answered.
- A stale stored rate: `resolveFxRate` carries it forward up to
  `FX_MAX_RATE_AGE_DAYS` and answers `unknown` with `stale_observation`
  after. No provider change touches this.
- A weekend or ECB holiday: no Frankfurter row for that day; the previous
  business day is carried forward (section 7.2).

## 12. Frontend

- The Currencies page (route /currencies) shows one line under the header,
  from `GET /currencies/exchange-rates/status`: "Rates from Frankfurter (ECB
  reference rates), then Yahoo Finance". Labels are frontend translations
  keyed by provider name; the list of names is mirrored in
  `frontend/src/lib/exchange-rates.ts` and held to the backend's by a
  contract test, the way `frontend/src/lib/ai-query-budgets.contract.test.ts`
  holds the budget copy.
- The refresh toast: `updated === 0 && failed > 0` becomes an error toast,
  "No exchange rates could be fetched; the provider did not answer", instead
  of today's success toast with counts (issue #1585 item 3).
- `RateHistoryCoverage.tsx`'s `sourceKey` learns `frankfurter`; the stored
  rates list shows "Frankfurter (ECB)" beside those rows.
- No new control an E2E spec drives is renamed; `e2e/tests/currencies.spec.ts`
  is grepped for the refresh button's name before F1 merges.

## 13. Scope cuts

- `FX_REFRESH_CRON`: `@Cron` is static, and the 5:05 PM ET weekday schedule
  already falls after the ECB's 16:00 CET publication. A configurable
  schedule means `SchedulerRegistry` and a `docs/cron-jobs.md` row of its own;
  a separate issue if an operator needs it.
- A keyed provider (ExchangeRate-API, CurrencyFreaks): the contract and the
  env convention are ready; no adapter is built here.
- Manual rate entry and editing in the UI (issue item 4): a different write
  path with its own ownership and INV-FX-004 questions; a separate issue.
- `exchange_rates.source NOT NULL`: no migration in this feature; rows
  without a source may exist on old deployments and the UI shows them
  unlabelled, as today.
- The intraday FX series (portfolio chart) stays Yahoo-direct (decision 8).
- An admin UI for choosing providers: env only.

## 14. Assumptions, restated for a fresh session

- The section 6 responses are the fixtures; they were recorded, not
  invented, and the spec files copy them verbatim with the date.
- `rates[Q]` under `base=B` is B to Q. Verified against the direct and the
  EUR-cross answers in section 6.2.
- `exchange_rates.source` is `varchar(50) NULL` with no CHECK; `frankfurter`
  needs no migration.
- `YahooFinanceService.fetchQuote` and `fetchHistoricalWindow` keep their
  signatures; the adapter is the only FX caller of them after B2.
- `provider-call.guard.spec.ts` asserts the exact list of client files it
  finds, so adding a client means editing that list in the same PR.
- Locales: English first in each task, `npm run i18n:pseudo` after editing
  `en/*`; the full-locale pass is Q.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| ECB reference rates and Yahoo closes differ by a few tenths of a percent, so a pair's series changes character at R1 | Named in the release note; history is not rewritten; `source` says which rows are which; an operator who wants Yahoo first sets `FX_PROVIDERS=yahoo,frankfurter` |
| Yahoo stops answering entirely before a third provider exists | The 28 ECB currencies keep refreshing; the 16 others fail visibly (counts, alert, F1's toast); the next adapter is one file |
| Frankfurter's public instance is unreachable from a deployment | Breaker and alert as for Yahoo; Yahoo stays second; `FX_FRANKFURTER_BASE_URL` points at a self-hosted copy |
| A placeholder detection that fires on a real 0.01 rate | The reverse symbol is consulted and must disagree beyond tolerance before the direct quote is dropped (7.3); tolerance is a named constant with its own cases |
| `carries` wrongly false for a code Frankfurter later adds | The list refreshes daily from the instance; the compiled-in set is only the outage fallback |
| A deployment with `FX_PROVIDERS` misspelt fails to boot | The message names the valid names; decision 11 chose this over a silent default |

## 16. Open questions

1. Default order (decision 2): confirm `frankfurter,yahoo` at R1, or keep
   `yahoo` first and let operators opt in. **Answered**: `frankfurter,yahoo`
   shipped at R1 (#1681); `FX_PROVIDERS=yahoo,frankfurter` restores the
   previous order.
2. Boot refusal on a bad `FX_PROVIDERS` (decision 11), or log and fall back
   to the default as the numeric knobs do. **Answered**: boot refusal, via
   `FxProviderConfigError` (B1, #1674).
3. The placeholder value and tolerance in 7.3 rest on the reporter's account
   of Yahoo returning `0.01`; a captured response for one such pair would
   make the fixture evidence rather than a reconstruction. **Not resolved**:
   no captured response was obtained; B4 (#1677) implemented the
   cross-check against the reconstructed fixture from the reporter's
   account, which is what shipped.
4. Whether the provider line belongs on the Currencies page header or only in
   the rate-history dialog. **Answered**: the header (F1, #1680); the
   rate-history dialog separately labels each stored rate's source.
5. Whether `verifyCurrency` should consult Frankfurter even when it is not in
   `FX_PROVIDERS` (B5 uses the configured chain only). **Answered**: no,
   `verifyCurrency` and the rest of currency lookup ask only the configured
   chain (B5, #1678).
