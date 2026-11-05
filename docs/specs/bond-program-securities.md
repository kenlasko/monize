# Spec: one security per bond program

Status: requested by the owner on 2026-10-11 (WMP/monize#24): "one security =
the bond type (EDO)", the treasury bonds view under Securities. Supersedes the
one-security-per-series link of `polish-retail-bonds.md` section 12.1 before
it ships.

## 1. Goal

A person who buys EDO every month holds one security, "EDO", not one per
series. Adding the security is choosing the program (the product, e.g. EDO);
recording a purchase is choosing the series (prefilled from the date). The
security page summarises the whole program, with the series the person holds
first and most prominent. An optional switch on the security asks Monize to
fetch every new series of the program automatically.

## 2. Model

### 2.1 Program

`bond_programs` (global reference data, RLS-exempt, immutable like
`bond_instruments`): `id` (UUIDv5 of `issuerCountryCode|issuerCode|programCode`,
deterministic like the instrument id), `issuer_country_code`, `issuer_code`,
`program_code`, `currency_code`. `bond_instruments.bond_program_id` references
it (NOT NULL). The boot seed inserts each installed adapter's programs, and no
series (`INSERT ... ON CONFLICT DO NOTHING`, one transaction per program); a
series store inserts the program, when it is not there, in the same transaction
as the series' instrument. The program's `infoUrl` (the issuer's page for the
product) is the adapter's (`BondProgramDefinition`), not a column.

### 2.2 Security

`securities.bond_program_id` (nullable, `ON DELETE RESTRICT`) replaces
`securities.bond_instrument_id`. `securities.bond_auto_fetch BOOLEAN NOT NULL
DEFAULT false`. The link is checked in the write's transaction exactly as the
series link was (`assertBondLink`): the program exists, the security's type is
`BOND`, its currency equals the program's currency, and, when the link is
being set, every priced acquisition of the security (`BUY`, `REINVEST` and its
variants, not void; a `SELL` or `REDEEM` is not read, because a long-held bond
may be worth more than twice its face value and a removal counted in currency
units is refused by the lot derivation) is within [0.5, 2] x the face value of
the series it is read as (`LINK_QUANTITY_NOT_BONDS`, `BOND_UNIT_PRICE_BAND`); for a marketable coupon series, whose price is a cash price, the band is (0, 5] x the face value (`BOND_CASH_PRICE_BAND`, `docs/specs/bond-marketable-primitives.md` section 3).

A quantity of a linked security is a count of bonds on every write, not only
when the link is made (INV-BOND-005). The face value a row is read against is
its series' own terms (`instrument.faceValue`, the newest version) when the row
stores, or can be inferred, a series of the program; otherwise the program's
face value from the adapter's product template (`BondProgramDefinition.faceValue`,
`templateFaceValueOf`), so a program with no stored series is never a way past
the band (an empty catalog dropped every row once). A program no installed
adapter declares has no face value, and such a row is not read. After every
write path (create, update, transfer, an embedded split row, the file imports,
undo and redo, a split parent's void and replacement) `BondWriteGuard.verify`
reads the stored price and series of the rows just written, inside the write's
own transaction, and refuses one outside the band with `QUANTITY_NOT_BONDS`
(400) before anything commits; a row that was already outside the band when the
guard began never blocks an unrelated edit or a delete, but an edit that writes
it again is a write.

### 2.3 Transaction series

`investment_transactions.bond_instrument_id` (nullable, `ON DELETE RESTRICT`):
the series a share-moving row of a program-linked security acts on.

- **Acquisition with a purchase date of its own** (`BUY`, `REINVEST`): the
  series is the one given, or, when none is given, the program's one series
  whose newest terms' `saleWindow` contains the transaction date
  (`inferSeriesForDate`; none, or more than one, is not inferred). The server
  stores the resolved id.
- **Acquisition without one** (`ADD_SHARES`, an unpaired `TRANSFER_IN`): the
  date is the transfer's or the grant's, not a purchase date, so the series is
  never inferred from it. It must be named (`SERIES_REQUIRED`).
- A given series must belong to the security's program
  (`SERIES_NOT_IN_PROGRAM`); no stored series covering the date of a BUY or
  REINVEST is `SERIES_NOT_DETERMINED` with the date and program, and the
  message says to fetch the series. These refusals run in the write's own
  transaction, before anything is written.
- **Removal** (`SELL`, `REDEEM`, `REMOVE_SHARES`, an unpaired `TRANSFER_OUT`):
  the series is optional. Given, the quantity leaves that series' lots of the
  row's account first-in first-out; absent, it leaves the account's lots
  first-in first-out across series. A removal the account does not cover (of the
  named series: `REMOVAL_EXCEEDS_SERIES`; at all: `OVER_REMOVAL`) is refused
  at write time: after the mutation, in the write's transaction, the lots are
  derived over the security's whole ledger and the write is rolled back when the
  derivation is refused now and was derivable before the write, or the refusal
  names a written row. A refusal that already existed about another row does
  not block an unrelated edit (`BondWriteGuard`).
- **An edit keeps what it does not change.** A form resends every field, so on
  update the series is resolved only when a different one is requested or the
  action, date or security changed; otherwise the stored value, NULL included,
  stays. Undo and redo put the snapshot's series back exactly, never inferred
  (a series outside the security's current program is stored as NULL). A split
  parent's edit recreates its embedded investment rows: a recreated row that
  names no series keeps its predecessor's, matched on security, action,
  quantity and date because a split stores no position among its siblings.
- **Imports** (QIF/OFX, Money) name no series. A BUY or REINVEST takes the
  series on sale on its date; any other acquisition, or one with none on sale,
  is stored with NULL and counted (`bondRowsWithoutSeries` in the result, absent
  when zero), and the lots refuse with `SERIES_NOT_DETERMINED` naming the row
  rather than the import dropping it. A removal the file leaves uncovered
  refuses the import as a whole (the guard runs once per file, which is not in
  date order). The program of a security is looked up once per import run.
  The series on sale for a date is inferred once per (program, date) per import
  run.
- **Scheduled transactions** cannot name a series. A scheduled BUY or REINVEST of
  a linked security takes the series on sale on its posting date when it posts;
  a due occurrence whose series is not stored yet (the 1st of a month, before the
  new series is fetched) is not failed: the post refuses with
  `SERIES_NOT_DETERMINED` inside its one transaction, so nothing is written and
  `next_due_date` stays, and the next hourly auto-post run retries it (the
  schedule row lock and the occurrence's claim row keep it to one post across
  replicas). No `SCHEDULED_POST_FAILED` alert is raised until the occurrence is 3
  days past due; then one alert (keyed by schedule and due date) names the
  missing series month and that the series must be fetched (Refresh on the
  security page, or auto-fetch). A scheduled ADD_SHARES or TRANSFER_IN of a
  linked security, whose series must be named, is refused when the schedule is
  created or updated (`SERIES_REQUIRED`).
- **Paired transfers** move lots with their series and purchase dates.
- Every write path sets it the same way: the UI service, bulk, AI action, MCP,
  import, undo/redo (the snapshot carries the column), and every one runs the
  write guard.

A security that is not program-linked never has the column set (refused).

### 2.4 Lots, valuation, prices

A lot is `{ accountId, instrumentId, purchaseDate, quantity, purchaseDateAssumed }`.
The valuation loads the reference data of every series the lots name (once
each) and values each lot by its own series' terms; totals are summed as
today. The daily `bond_engine` price is the blend over all lots of all series,
as today over accounts. Scenarios assume a benchmark for every series that
reads it; a series that does not read it is unchanged.

**A holding's current value is its own lots' value, not quantity times the
blend** (amended 2026-10-13 after the audit of PR #24, finding H2). One
security now spans a whole program, so two accounts can hold lots years apart:
10 bonds of a 2022 EDO series (gross 135.40 each) in an IKE and 10 of the newest
series (100.08 each) in a regular account blend to 117.74, and `quantity x
price` showed both accounts at 1177.40 (correct: 1354.00 and 1000.80) with a
gain of 17.7 % on bonds bought a week ago. So:

- The current market value of a bond-linked holding (one account, one
  security) is the sum of the engine's `grossValue` of that account's open lots
  on the person's financial today (`BondValuationService`), never
  `quantity x security price`. Its gain is that value less its cost basis.
- When any of those lots has no `grossValue` (rate unknown, lots refused, a lot
  outside its sale window), the holding is unpriced: `marketValue` null, the
  security in `unpricedSecurityIds`, `pricesComplete` false, exactly as a
  security with no price. Never the blend, never the last stored close.
- The portfolio total is unchanged in value (the per-account values sum to
  `quantity x blend` on the same day) and is computed from the same
  per-account values.
- Historical per-account series (net worth by account, an account's value
  chart) still read the daily blend: their per-account split is approximate for
  a security held in several accounts; their total is exact. This is recorded
  as a known limitation (`docs/system-invariants.md`, INV-BOND-010, partial)
  and is a separate change (per-account engine prices need storage).

### 2.5 Auto-fetch

`bond_auto_fetch` is per security, off by default, on a switch on the security
page and in the form. The daily series cron fetches the current offer and runs
the backfill only for the programs that at least one security has switched
on (read in the cron's system context; it reads program ids, never anything
else of the user). Without it, a series enters the catalog by a fetch from
the purchase form, or through the security's Refresh (user-initiated).

The cron's filter is by design: the owner asked for an opt-in, so a program
nobody switched on is never fetched in the background. Without any opt-in the
offer and history views show only the series already stored, and the purchase
form offers the fetch when no stored series covers the date.

After any series is stored (a fetch, the offer fetch, the cron, the backfill,
an administrator's entry) the engine prices of the securities linked to its
program are recomputed after the commit (INV-CACHE-001), because a BUY or
REINVEST recorded before the series existed is read as the series on sale on
its date and only now resolves to a lot.

The "Refresh" of a linked security (the list's or the detail page's, through
`POST /securities/prices/refresh/selected`, and the refresh the list starts
after a security is created with auto-fetch on, or edited so that auto-fetch is
switched on or its program changed with it on) fetches the current
offer of its program first (`BondSeriesService.fetchProgramOffer`: only that
program's series on sale now that are not stored), once per distinct program,
and then recomputes the engine prices. It is a person's action under
INV-BOND-008. A country with no fetch is skipped silently; a failed fetch does
not stop the recompute and is reported as that security's failed row.

The same refresh then fetches up to `PROGRAM_BACKFILL_CHUNK` (8) missing series
of the program's history, newest sale month first, at the backfill's pace (3 s
before each request): about 30-40 s under the button's spinner, never work in
the background. A few refreshes, or the daily check while auto-fetch is on,
complete the history; once it is complete a refresh asks for nothing more. The
refresh has no throttle of its own, so the service bounds it in a row every
replica sees: a pass takes the program's lease in `fetch_sync`
(`bond-program-refresh:<country>|<program>`) for `PROGRAM_REFRESH_INTERVAL_MS`
(90 s) and never hands it back, so one program is refreshed at most once per
interval however often, and on however many replicas, a person presses
Refresh. A refresh inside the interval fetches nothing and still recomputes
prices. Each series a bounded pass asks for takes its own lease
(`bond-series-attempt:<country>|<code>`) for `BACKFILL_ATTEMPT_INTERVAL_MS`
(24 hours), so a series the source refused is asked for at most once a day on
any replica, and the next pass moves on to other months. The unbounded daily
pass takes no attempt lease.

While the refresh runs it reports its progress in the same `fetch_sync` row
(`progress JSONB`, written by `FetchSyncService.reportProgress` only under the
lease token, so a holder that lost its lease writes nothing, and outside any
store transaction): `{ startedAt, phase: "offer" | "series" | "done", done,
total, seriesCode, finishedAt }`. `phase` is `offer` during the current-offer
check, `series` during the history pass (`total` is the planned count, at most
the chunk and at most the series missing, read before any attempt lease is
claimed, so `done` can stop short of it when another replica asked for a series
meanwhile; `done` counts each attempt, stored, refused or failed, and
`seriesCode` is the last one) and `done` at the end, also when the pass threw.
A failed progress write is logged and never fails the refresh.
`GET /bonds/programs/:programId/refresh-progress` returns that object (404 for
an unknown program; all fields empty, `phase` null, `done` and `total` 0, when
the program was never refreshed) for the client to poll.

### 2.6 Nothing country-specific without a user

Requested by the owner on 2026-10-11: not every deployment wants Polish bonds,
so none acts on them until a person does.

- An adapter carries **product templates**, not series: the structure of each
  product (schedule, accrual, principal rule, rate rule type and observation,
  capitalization, redemption window, blackouts, floor, rounding), without any
  per-series value (first-period rate, margin or spread, fee, sale window,
  series code, source). The October 2026 series are test fixtures
  (`backend/src/bonds/adapters/pl/fixtures/series/`); the series fetch and the
  manual entry fill a template.
- The boot seed stores the adapters' **programs** only (no series, no network),
  so the security form can offer them. A program's currency is created
  inactive.
- The benchmark refresh (NBP, GUS) runs, at boot and on its cron, only for the
  benchmarks a **stored series** reads; with no stored Polish series nothing is
  fetched. When a series is stored and a benchmark it reads has never been
  fetched, that benchmark is refreshed after the commit, so the first valuation
  has its observations.
- A deployment where nobody adds a Polish bond therefore sends no request to
  obligacjeskarbowe.pl, NBP or GUS.

## 3. Views

### 3.1 Treasury bonds view

There is no standalone bonds page: the on-sale and history views live on the
bond security's detail page (3.4), and the data comes through the security's
Refresh. There is no `/securities/bonds` route and no "fetch the current offer
now" button.

### 3.2 Security form

Type `BOND` shows a Country select (the countries of the catalog's programs, and
"Other"). A country shows the bond-kind picker for that country (the catalog's
programs, by translated name, e.g. "EDO: 10-year inflation-indexed savings
bonds"); choosing one fills symbol (`EDO`), name and currency of a new security
and shows the auto-fetch switch. "Other" is a bond no program supports: it
works as a plain security (no link, a quote provider) and says where support for
another country can be requested. The wording on screen is "bond kind" for a
program.

### 3.3 Transaction form

For a program-linked security, a share-moving action shows a series picker:
for an acquisition it is prefilled with the series on sale on the transaction
date and offers the program's stored series; if none covers the date it offers
"fetch the series from the official source" (the existing fetch). For a
removal it lists the series the account holds, with "oldest first" as the
default.

### 3.4 Security page

For a program-linked security (`frontend/src/app/securities/[id]/page.tsx`,
detail in `polish-retail-bonds.md` section 13):

- **Overview**, from the top: **Your series** (most prominent: one row per held
  series with quantity, purchase dates, current value, accrued interest, early
  redemption value, current rate, next rate change and maturity, and the total
  row; a row expands to the per-lot detail, rate schedule with its indexation
  notice and interest chart; the scenario panel sits under the table);
  **The bond kind** (rate rule in words, length, capitalization, fee and floor
  of the newest series, the auto-fetch switch); **On sale now** for this
  program (from `GET /bonds/offer`), with the comparison figures.
- The **Terms history** tab, in place of Price history: the program's terms
  from `GET /bonds/history`, the series held marked on the chart and
  highlighted in the table.
- The **Breakdown** card, in place of the sector, country and asset-class
  splits: the holding by series and by maturity year, and the kind's issuer
  country, rate, interest and term.
- **Key information** links the issuer's page for the product (`infoUrl`);
  **Documents** lists the issue letters of the series held and on sale.
- **Refresh** shows a progress bar from
  `GET /bonds/programs/:programId/refresh-progress` while it runs.

## 4. API changes

- `GET /bonds/programs`: the catalog's programs (id, country, issuer, program
  code, currency, series count, newest series, `infoUrl`: the issuer's https
  page for the product from the adapter, or null).
- Valuation response: each lot carries `instrumentId` and `seriesCode`;
  `termsSource` and `redemptionTerms` move per series
  (`series: [{ instrumentId, seriesCode, termsSource, redemptionTerms }]`).
- Investment transaction DTOs gain optional `bondInstrumentId` (UUID,
  `ParseUUIDPipe` semantics); responses carry it.
- Security DTOs: `bondProgramId` and `bondAutoFetch` replace `bondInstrumentId`.
- `GET /bonds/securities/:securityId/series-on-sale?date=YYYY-MM-DD` answers
  `{ instrumentId, seriesCode }`, or the JSON literal `null` when no single stored
  series was on sale that day: the series the server would infer for a BUY or
  REINVEST on that date (the same `seriesOnSaleSql` as the write). 404 for
  another user's or an unlinked security.
- `GET /bonds/securities/:securityId/expected-series?date=YYYY-MM-DD` answers
  `{ seriesCode: string | null, countryCode: string, fetchable: boolean }`: the
  code of the series a purchase on `date` would carry, by the grammar of the
  adapter of the security's program's country (`BondAdapter.seriesCodeFor`, e.g.
  `EDO1036` for an EDO bought in October 2026), and whether that country can
  fetch a series (the adapter has `fetchSeries` and `seriesProviderId`). The
  purchase form offers "Fetch <code>" from it and holds no code grammar of its
  own. `seriesCode` is null when the adapter has no `seriesCodeFor` or does not
  know the program; a country with no adapter answers `seriesCode` null and
  `fetchable` false. `countryCode` is the program's issuer country. `date` is a
  calendar date (`ParseCalendarDatePipe`, 400 otherwise); 404 for another
  user's, a missing or an unlinked security. Nothing is fetched or stored.
- `GET /bonds/securities/:securityId/series-holdings?accountId=<uuid>&date=YYYY-MM-DD[&excludeTransactionId=<uuid>]`
  answers `{ holdings: [{ instrumentId, seriesCode, quantity }] }`: the series
  `accountId` holds on that date (the lot derivation over the rows up to and
  including it, without `excludeTransactionId`, the row being edited), oldest lot
  first, quantity above zero only. Lots that cannot be derived are a 422 whose
  `errorCode` is the refusal code. 404 as above.
- Error codes of a transaction write: `SERIES_NOT_IN_PROGRAM`,
  `SERIES_NOT_DETERMINED`, `SERIES_NOT_ALLOWED`, `SERIES_REQUIRED`,
  `REMOVAL_EXCEEDS_SERIES`, `OVER_REMOVAL` (400, `errorCode`, translated under
  `errors.bonds`).
- The import result carries `bondRowsWithoutSeries` when above zero.
- `GET /bonds/securities/:securityId/redemption-split` answers what redeeming
  bonds of a series pays, split into principal and interest
  (`bond-redemption-interest.md` 2.2).

## 5. Invariants

- INV-BOND-005 unchanged in meaning (engine price per security, now blended
  over series).
- INV-BOND-007 (refined): every share-moving row of a program-linked security
  names a series of that program, or the ledger says which does not. A BUY or
  REINVEST is inferred from its date; `TRANSFER_IN` (unpaired) and `ADD_SHARES`
  name the series; a removal is checked at write time; an import may store NULL
  and the lots name such a row. The server resolves and stores the series, never
  trusted from a client without the program check.

## 6. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Migration | schema | `verify-schema.sh` no-op; programs and both columns present; FKs RESTRICT; immutability trigger on programs |
| Link | unit, integration | program link checks (exists, BOND, currency, price range across series); auto-fetch default false |
| Series on write | unit, integration | BUY/REINVEST inferred from the date, explicit accepted, foreign program refused, no series refused before writing; ADD_SHARES and unpaired TRANSFER_IN refused without one; removal with and without series, refused when uncovered (rolled back); an edit keeps the stored series; undo restores it exactly; a split parent edit keeps the embedded rows' series; every entry point (UI service, bulk, AI, MCP, import, undo) |
| Series endpoints | unit, integration | series-on-sale (found, none, foreign security 404); expected-series (a code, a program the grammar does not know, no adapter, foreign or unlinked 404); series-holdings (per account, date, excluded row, refused 422) |
| Lots | unit | two series in one account; removal by series; FIFO across series; paired transfer keeps series; over-removal of a series |
| Valuation, prices | unit, integration | two series valued by their own terms; blend; scenarios per series; recompute after a write |
| Auto-fetch | unit | cron fetches only programs switched on; off by default |
| Views | unit | Country select and program picker; series picker prefill and fetch; security page cards, tabs and highlight; no standalone route |
