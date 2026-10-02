# Bank sync (Open Banking / PSD2)

Plan for importing bank transactions automatically through a regulated
aggregator. The first provider is Enable Banking. The specification is
[`docs/specs/bank-sync.md`](../specs/bank-sync.md); the task list is
[`bank-sync-tasks.md`](./bank-sync-tasks.md).

Status: **approved to build** (kenlasko/monize#1326, label
`approved-to-build`).

## 1. Goal

- A user who banks in the EEA connects Monize to their bank once, maps each
  bank account to a Monize account, and stops exporting CSV files.
- Booked transactions arrive daily and on request, each exactly once, with the
  user's `import` rules applied.
- Nothing about one provider leaks into the rest of the code: a second
  aggregator (GoCardless Bank Account Data, a Nordigen-style API, a
  region-specific one) is a new directory under `providers/` and one registry
  line.

## 2. Assumptions (restated so a fresh session can execute this)

1. **Each user registers their own Enable Banking application** and enters its
   application id and RSA private key in Monize. Enable Banking's restricted
   production mode (free, personal use) only reads accounts the application
   owner linked, which fits a self-hosted, one-person-per-login instance. An
   instance-wide application (environment variables) is not in this plan.
2. **Only booked rows are imported.** A pending row changes amount and
   identifier when it books, so importing it would produce duplicates.
3. **The Enable Banking wire format** used by the adapter is the one in the
   provider's public samples (`github.com/enablebanking/enablebanking-api-samples`):
   JWT RS256 with `kid` = application id, `iss = "enablebanking.com"`,
   `aud = "api.enablebanking.com"`, `exp - iat <= 86400`; `GET /aspsps`,
   `POST /auth`, `POST /sessions`, `GET /sessions/{id}`,
   `DELETE /sessions/{id}`, `GET /accounts/{uid}/balances`,
   `GET /accounts/{uid}/transactions` with `date_from`, `date_to` and
   `continuation_key`. Field names were checked in BS10 against the provider's API
   reference, its OpenAPI file (`/docs/api/reference/enablebanking-api.yaml`)
   and its FAQ, not yet against a live session. Corrections: the error body
   is `{ message, code (the HTTP status), error (the error code), detail }`,
   and gateway refusals carry no `error`; `entry_reference` is unique per
   account (identification hash), not globally, and some banks repeat it;
   an account's `name` is the holder's name (`details` and `product` label
   the account); `GET /aspsps` takes `service=AIS`; `date_from` is read in
   UTC; `maximum_consent_validity` is in seconds; a background read is
   limited to about four a day. The adapter tolerates every field being
   absent.
4. **The provider host is fixed** (`https://api.enablebanking.com`), so no SSRF
   guard is needed; the client goes through `ProviderHealthService` like every
   other third-party call.
5. **No inbound access.** The consent redirect goes through the user's
   browser, never from the provider to Monize; the only network need is
   outbound HTTPS from the backend to `api.enablebanking.com`. The Helm chart
   and the compose files do not restrict egress, so they are unchanged.
6. **No new dependency.** RS256 signing is `node:crypto` (`createSign`).

## 3. Backend (`backend/src/bank-sync/`)

```text
bank-sync.module.ts
bank-sync.controller.ts            thin; every route in spec section 9
bank-sync-credentials.service.ts   encrypt, validate PEM, view without the key
bank-sync-connections.service.ts   start/complete/re-authorize/disconnect, state CAS
bank-sync.service.ts               link, sync one account (spec section 7)
bank-sync-writer.service.ts        the write transaction (ledger, payee, transaction, rules, balance)
bank-sync-cron.service.ts          the daily fan-out (spec section 8)
bank-transaction-planner.ts        pure mapping and keys (spec section 6)
providers/bank-sync-provider.interface.ts
providers/bank-sync-provider.registry.ts
providers/enable-banking/enable-banking-jwt.ts
providers/enable-banking/enable-banking.client.ts   wire calls, ProviderHealthService
providers/enable-banking/enable-banking.mapper.ts   wire row -> BankTransaction
entities/*.entity.ts, dto/*.dto.ts
```

Shared edits, each one line or one entry:

- `app.module.ts`: import `BankSyncModule`.
- `common/jobs/job-claim.service.ts`: `JobClaimType.BankSyncAccount`,
  `JobClaimType.BankSyncDaily`.
- `provider-health/providers.ts`: `enable_banking`; the guard's
  `GUARDED_DIRS` gains `bank-sync/providers/enable-banking`.
- `eslint.config.mjs`: `WITH_CONTEXT_ALLOWLIST` gains the cron service (the
  one new `withSystemContext` / `withUserContext` call site).
- `transaction-rules/rule-application-sites.guard.spec.ts`: the writer joins
  `APPLYING_SITES` (it calls `applyToNew` with the `import` trigger).
- `backup/export-table-queries.ts`: the four tables in
  `INTENTIONALLY_EXCLUDED_TABLES`, with the reasons in spec section 4.
- `i18n/locales/*/errors.json`: `errors.bankSync.*`.

## 4. Database

One migration, `database/migrations/<UTC stamp>_bank_sync.sql`, and the same
DDL in `database/schema.sql`: the four tables of spec section 4, their
indexes, the direct RLS policy and `ENABLE ROW LEVEL SECURITY` for each.

## 5. Frontend

```text
src/types/bank-sync.ts
src/lib/bank-sync.ts                            API client, cache prefix 'bank-sync:'
src/app/settings/bank-sync/page.tsx             the settings sub-page
src/app/settings/bank-sync/callback/page.tsx    receives ?code&state (or ?error)
src/components/settings/bank-sync/BankSyncCredentialsCard.tsx + Modal
src/components/settings/bank-sync/BankSyncConnectDialog.tsx    country + bank picker
src/components/settings/bank-sync/BankSyncConnectionCard.tsx   accounts, link select, sync
src/i18n/messages/en/settings.json              settings.bankSync.*
```

Shared edits: the settings index (`SETTINGS_SECTION_IDS` and its link block),
`settings.nav.bankSync`, `BALANCE_WRITING_ROUTES` in
`src/lib/balance-cache.guard.test.ts` (the two sync routes write transaction
rows), `cache-prefix-classification.guard.test.ts` (`bank-sync:` is
reference data).

## 6. What to run, and what to observe

| Step | Run | Observe |
|---|---|---|
| Migration | `npm run migration:lint`, `scripts/verify-schema.sh` | no finding; migrations replay as a no-op on `schema.sql` |
| Backend | the backend gate in `AGENTS.md`, `npm run test:integration -- bank-sync` | green; the integration spec proves a second sync imports nothing |
| Frontend | the frontend gate in `AGENTS.md` | green; bundle size within budget |
| By hand, sandbox | an Enable Banking sandbox application, the mock ASPSP | connect, link, sync twice: the second sync reports every row as skipped |

## 7. Other providers

Compared on 2026-10-01 from the Firefly III data importer documentation
(`docs.firefly-iii.org`, "Data providers"), which supports several of them.
A second provider is a new directory under `providers/`.

| Provider | Region | Cost for personal use | Credential | Notes |
|---|---|---|---|---|
| Enable Banking | EEA, PSD2 | free in restricted mode (own linked accounts only) | application ID + RSA private key | the first provider here |
| GoCardless Bank Account Data (formerly Nordigen) | EU, UK | was free, now paid | secret ID + key | the vendor is moving away from this product; not a good next provider |
| Lunch Flow | many, through its own aggregations | paid | one API key | an aggregator of aggregators |
| SimpleFIN | mostly US | low fee | one token per bank connection | the simplest protocol |
| Sophtron | US, Canada, Mexico | free for personal, non-commercial use | user ID + access key | bank linked through the vendor's widget |
| FinTS / HBCI | Germany | free, bank-native | bank login | no aggregator; a direct bank protocol |
| teller.io, basiq.io | US / Australia | various | API keys | not yet integrated by Firefly III either |

## 8. Rejected alternatives

- **A `import_key` column on `transactions`.** It would put the provider's
  identity on the core table and on every transaction path. A side table keyed
  on the Monize account gives the same guarantee and is dropped with the
  feature.
- **`TransactionsService.create` per row.** It applies rules with the `create`
  trigger, dispatches its recalculation per row, and cannot see the ledger
  insert; the writer composes the same helpers in one transaction instead.
- **Pending rows as `UNRECONCILED`, replaced when booked.** Banks change the
  identifier when a row books, so the replacement needs a fuzzy match that can
  merge two real transactions. Deferred (task BS13).
