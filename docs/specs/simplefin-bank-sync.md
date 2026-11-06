# SimpleFIN Bridge bank-sync integration

Scope approved in [discussion #1796](https://github.com/kenlasko/monize/discussions/1796), including use of the existing bank-sync framework. Investment holdings and trades are excluded.

## 1. Outcome and scope

Add `simplefin` as a second bank-sync provider, retaining Enable Banking. A US user connects institutions in SimpleFIN Bridge, pastes a setup token into Monize, maps discovered accounts to Monize accounts, previews booked transactions, and enables daily imports.

Release 1 supports checking, savings, and credit-card transaction imports and balance comparison in supported ISO currencies. USD is the primary acceptance case. Payment initiation, pending ledger entries, investment trades/holdings, automatic transfer pairing, foreign-exchange conversion, arbitrary SimpleFIN servers, and bank-login credential collection are excluded. Existing transfer behavior remains in effect; importing two sides must not introduce a new automatic matching policy.

No public inbound port or bank callback is required. All SimpleFIN traffic originates in the backend over HTTPS. Existing application authentication remains unchanged.

## 2. Verified baseline

The existing implementation already provides account linking, initial preview, import rules, an import ledger, currency refusal, notifications, daily scheduling, job claims, and scoped database access.

Relevant existing files, relative to the repository:

| Surface | Existing location |
|---|---|
| Provider contract and registry | `backend/src/bank-sync/providers/bank-sync-provider.interface.ts`, `bank-sync-provider.registry.ts` |
| Closed provider list | `backend/src/bank-sync/bank-sync.constants.ts` |
| Credentials and connection lifecycle | `backend/src/bank-sync/bank-sync-credentials.service.ts`, `bank-sync-connections.service.ts` |
| Read/preview/write pipeline | `backend/src/bank-sync/bank-sync.service.ts`, `bank-sync-preview.service.ts`, `bank-sync-writer.service.ts` |
| Deduplication planner | `backend/src/bank-sync/bank-transaction-planner.ts` |
| Scheduler | `backend/src/bank-sync/bank-sync-cron.service.ts` |
| Settings | `frontend/src/components/settings/bank-sync/`, `frontend/src/app/settings/bank-sync/` |
| API client and types | `frontend/src/lib/bank-sync.ts`, `frontend/src/types/bank-sync.ts` |
| Schema and original contract | `database/schema.sql`, `docs/specs/bank-sync.md` |

The generic provider interface still assumes RSA credentials and a redirect/session authorization flow. Credential and connection services also select `BANK_SYNC_DEFAULT_PROVIDER`. Adding only a new adapter cannot implement SimpleFIN correctly.

## 3. User experience

1. Settings → Bank sync offers Enable Banking and SimpleFIN Bridge.
2. SimpleFIN explains read-only access and links to the Bridge setup page. Bank selection and bank authentication happen there.
3. User pastes a setup token into a masked input and selects Connect. The input is cleared after submission and is never persisted in browser storage or URLs.
4. Backend claims the token, stores the encrypted access URL, and discovers institutions/accounts. UI shows institution, account name, currency, reported balance, balance timestamp, and actionable provider errors.
5. User explicitly selects account type when metadata is insufficient, links each account, and chooses a cutoff date. Do not infer account numbers or credit-card type from an ambiguous name.
6. First import requires the existing preview and confirmation. Show the proposed balance and any difference from the provider balance; never silently insert an opening-balance adjustment.
7. Daily syncing remains opt-in through existing account/connection controls after a successful initial preview/import. New accounts stay unlinked and are not automatically imported.
8. Reconnect accepts a newly generated setup token. Confirm before replacing an existing SimpleFIN credential; retain the old credential until the new access URL is encrypted and committed.
9. Distinguish “Stop syncing this institution” from “Remove SimpleFIN connection for all institutions.” Removing a local connection does not claim to revoke remote access. Show instructions to revoke the app token in Bridge.

All new user-facing strings use existing translation catalogs. Other locale translations and regenerated pseudo-locales are part of release completion.

### Manual account linking and type selection

SimpleFIN accounts must be linked to an existing Monize account or created by the
user. Automatic identifier matching is intentionally hidden: Bridge's opaque
account id is not a Monize account number, and the standard defines no reliable
account-type or masked-number field. Names and optional provider-defined `extra`
fields are not inferred into either value. The bank's display name and currency
prefill a new account; its editable type defaults to chequing. The user must
choose the correct type because provider-reported type mismatch warnings are
unavailable. Ownership, currency, account closure, brokerage and existing-link
checks still apply. The SimpleFIN source notes disclose these limitations.

## 4. Provider architecture

Add `providers/simplefin/simplefin.client.ts`, `simplefin.mapper.ts`, and their tests. Register through `BankSyncProviderRegistry` and the existing module.

Use a discriminated credentials union:

```ts
type BankSyncCredentials =
  | { provider: 'enable_banking'; applicationId: string; privateKeyPem: string }
  | { provider: 'simplefin'; accessUrl: string };
```

Expose provider capabilities: `setupFlow: 'bank_redirect' | 'setup_token'`, `hasConsentExpiry`, and `supportsRemoteSessionRevocation`. UI and orchestration select a flow by capability. Do not implement fake institution lists, fake OAuth codes, or no-op methods that report remote revocation success.

Separate redirect authorization from setup-token claiming; preserve existing Enable Banking routes as compatibility wrappers. SimpleFIN creates active institution connections directly from discovery, with `validUntil = null`, no OAuth state, and no fabricated consent expiry. Existing consent reminders skip those connections.

Introduce a provider read-batch operation used by preview and sync. Enable Banking can implement it using its existing methods. SimpleFIN returns transactions, balance, metadata, and errors from one Account Set response. A run context shares each result across account processing without storing raw payloads beyond that operation.

## 5. Persistence and migration

Create a new timestamped migration and update `database/schema.sql` in the same change. Do not modify shipped migrations.

| Change | Contract |
|---|---|
| Provider checks | Add `simplefin` to credential and connection CHECK constraints and the source constant. |
| Credential fields | Keep existing Enable Banking columns; make `application_id` and `private_key_enc` nullable and add nullable `access_url_enc TEXT`. |
| Credential shape CHECK | Enable Banking requires its existing two fields and null access URL; SimpleFIN requires non-null access URL and null RSA/application fields. |
| Uniqueness | Preserve one credential per `(user_id, provider)`. |
| Provider request events | Add `bank_sync_provider_requests(id, user_id, credential_id, requested_at)` with an index on `(credential_id, requested_at)` and FK cleanup on credential deletion. This stores quota reservations, never URLs or payloads. |
| Existing institution/account tables | Reuse them. `external_session_id` stores the non-secret SimpleFIN `conn_id` for SimpleFIN only. `institution_country` is left empty when the provider does not report it; currency must not be used to infer geography. |

All new user-owned rows receive existing direct RLS policies in the migration. Database access uses `withScopedDb` and existing request/system/user contexts. Credential ciphertext and request-event tables are excluded from portable backups; add explicit tests for both. Restores require reconnecting SimpleFIN and must not fabricate a working credential.

The migration preserves every existing Enable Banking row and import-ledger key. Down migration must refuse while SimpleFIN credentials/connections exist rather than delete them. Rollback in production is normally an application rollback leaving the additive migration in place.

## 6. HTTP/API contract

Paths below are under `/api/v1/bank-sync`; existing authentication, owner checks, DTO bounds, CSRF protection, and throttling apply.

| Endpoint | Request/result |
|---|---|
| `GET /status?provider=simplefin` | Provider capabilities, `credentialSet`, connection counts, quota remaining/next eligible time, sanitized errors. No secret, username, password, or claim URL. Omitted provider retains existing Enable Banking behavior. |
| `POST /simplefin/connect` | `{ setupToken: string, replaceExisting?: boolean }`; maximum 16 KiB. Returns `201` with connected status and discovered connection/account views. Return `409` if replacement was not explicitly confirmed. |
| `POST /simplefin/discover` | Refresh institution/account metadata using `balances-only=1`; counts toward the same request budget. Never changes user account mappings automatically. |
| `DELETE /simplefin/credentials` | Requires explicit UI confirmation describing all affected institutions. Remove local credential and disable its connections; preserve transactions and import ledger. Return `204`; no claim of remote revocation. |
| Existing preview/link/sync routes | Resolve provider from the owned connection; reuse import semantics and response shapes with additive error/freshness fields. |

Connect is a single-use external side effect. Serialize claim operations per user using a short durable claim lease, without holding a database transaction open during network I/O. Reserve it before POSTing; release after completion; expiry allows a new attempt, not replay of the token.

After a successful claim, persist the access URL before discovery. If discovery fails, return a documented connected-but-discovery-failed result with a safe error; retry discovery without re-claiming. If persistence fails after a successful claim, disclose that the token was consumed and instruct the user to revoke it in Bridge and generate another. Never automatically replay a claim after an ambiguous timeout.

## 7. Credentials and outbound requests

Initial support is restricted to exact hosts `bridge.simplefin.org` and `beta-bridge.simplefin.org`, HTTPS, port 443, and documented `/simplefin/claim/...` and `/simplefin...` paths. No wildcard hosts, arbitrary ports, fragments, or claim-URL userinfo. Validate both the decoded claim URL and returned access URL. Restrict resolved destinations to public addresses and pin the validated destination for the connection to prevent DNS rebinding; preserve TLS hostname verification. Reject redirects rather than forwarding credentials across them.

Use Node URL parsing to extract/decode the access credentials into an Authorization header and remove userinfo from the request URL before fetch. Encrypt the complete access URL with `EncryptionService` immediately; never return or log it. Claim tokens, Authorization headers, and provider response bodies must also be excluded from logs and telemetry, including `BANK_SYNC_LOG_RAW` for this adapter.

Use the existing provider-health gate and sanitized failure helpers. Each request has a 30-second deadline and a 10 MiB decoded-body limit; exceeding either fails the operation without truncation/import. A response with more than 50,000 transaction rows fails explicitly. Keep payloads only in operation memory. No new dependency is required unless the outbound-IP pinning cannot be implemented safely with installed HTTP tooling; that dependency decision needs separate review.

## 8. Identity and data mapping

Use explicit protocol `version=2`; reject an unexpected top-level shape. Current v2 is documented as draft, so pin fixtures to the reviewed format and handle unknown error subcodes by their documented prefix.

Canonical account identity is `(SimpleFIN server origin, conn_id, account.id)`. Encode it as `sf2:` plus a SHA-256 hex digest of a JSON tuple; this fits existing 255-character fields. Do not use account name, Monize connection UUID, access credentials, or setup token in identity.

| SimpleFIN field | Monize interpretation |
|---|---|
| `connections[].conn_id` | Provider institution-connection identity; preserve local mappings on repeated discovery. |
| Account `id`, `conn_id`, `name` | Scoped external identity and display name; missing required identity refuses the account. |
| `currency` | Valid supported ISO code. Custom currency URLs are unsupported and reported; never fetched or replaced with USD. |
| `balance`, `balance-date` | Signed decimal and source timestamp. Display the actual timestamp; derive the existing date field using the resolved financial timezone. Available balance is not substituted for ledger balance. |
| Transaction `id` | Required booked-row identity within the canonical account. |
| Signed `amount` | Preserve decimal text; positive → credit, negative → debit, amount → absolute decimal text. Reject malformed/overflow/excess precision using Monize's supported money rules. |
| `posted` | Required positive epoch timestamp for booked rows; convert to a calendar date in the resolved financial timezone for `bookingDate`. Zero/invalid timestamp is refused, not changed to today. |
| `transacted_at` | Optional transaction date using the resolved financial timezone; unknown stays null. |
| `pending` | `true` is excluded from imports; booked identity is established only when it posts. |
| `description` | Bounded description/remittance; absent counterparty stays null. Provider-specific payee/extra fields require separate validated mappings. |

Keep operation type unknown unless supported metadata explicitly identifies it. Never derive an operation type that affects deduplication from free text.

For SimpleFIN use a dedicated stable external key `simplefin:v1:` plus SHA-256 of `[serverOrigin, connId, accountId, transactionId]`; retain the existing unique `(Monize account_id, external_key)` database mechanism. Do not route SimpleFIN through Enable Banking-specific reference-discriminator rules.

Token replacement with identical provider identities preserves mappings and keys. If Bridge changes an identity after institution reconnection, require explicit account remapping and cutoff review; do not promise deduplication across changed source IDs or auto-match by name/balance. Previously imported rows remain protected when their original identity returns.

### Numerical examples

| Input | Expected result |
|---|---|
| Checking opening balance 100.00; transaction `-12.34` | Preview/import debit 12.34; resulting balance 87.66. |
| Checking 100.00; transaction `25.00` | Credit 25.00; resulting balance 125.00. |
| Same transaction ID on two remote accounts | Different keys; each can import once into its linked Monize account. |
| Same booked row fetched twice | Second import writes zero transactions and leaves balance unchanged. |
| Pending `-12.34`, later booked | Pending run writes nothing; booked run imports once. |
| USD source linked to CAD Monize account | Refused with currency mismatch; no conversion or balance mutation. |
| Credit-card purchase `-20`, payment `+50` | Preserve source signs; assert outcomes against Monize's existing liability-account balance rules in integration tests. |

## 9. Windows, quota, and freshness

Use one scheduled SimpleFIN batch per user per day, within the existing daily job-claim framework. Share reads across all that user's SimpleFIN institution connections; preserve current per-user job-claim semantics and user-context isolation. No polling, browser heartbeat requests, or webhooks.

Each manual or scheduled operation takes the earliest required linked-account cutoff for its batch. Incremental windows overlap the last successful date by seven days, bounded by each account's cutoff. Convert inclusive financial-local day ranges to epoch intervals `[start midnight, midnight after end day)`. Use conservative UTC bounds padded to cover financial-local days, filter rows by their local booking date, and split into intervals no longer than 45 × 86,400 seconds. Process longer histories in separately reviewed complete batches, retaining committed progress when quota is exhausted. Default first preview is at most the latest 89 days, with an explicit older-history option.

Before any `/accounts` request, acquire a row lock on the credential inside a short transaction, count request reservations in the preceding rolling 24 hours, and reserve all windows of the complete read only if they fit within 24. Commit before network I/O. Count failed attempts as spent; concurrent workers cannot each spend the last slot. Treat this conservative local cap as a ceiling, not a guarantee the provider has quota. Observe provider throttling and do not automatically retry within an operation. Replenishment time is derived from the oldest relevant reservation.

Reuse one Account Set result for transaction and balance reads within an operation. Prefer a single all-account read per time window; never send one transactions call and one balance call for every account. Preview confirmation may fetch again and consumes another reservation; compare the existing plan fingerprint and require a renewed preview if it changed. Do not import a partial multi-window preview. A large backfill may be divided into explicitly reviewed complete batches, each with its own preview/fingerprint/cursor; advance only after commit.

Show `last fetched` separately from source `balance-date` and last successful import. A new fetch does not imply the bank refreshed. Never infer coverage before the earliest returned transaction: an empty history is not proof that older history exists or does not exist. Explain institution-dependent history limits.

### Countryless SimpleFIN profiles

SimpleFIN Bridge supplies an institution name but no country. Match its profiles
by source and the normalized institution name (NFC, trimmed, collapsed spaces,
case ignored); never infer a country. A bank profile uses `simplefin/<bank>`
and omits `institution.country`. Unknown banks use `simplefin/default` before
the global `default`. The source default documents API-wide limits; a future
bank profile must retain those notes alongside any verified bank-specific notes.
Only the API-wide default ships until sanitized captures support bank profiles.
Enable Banking continues to match source, country and normalized bank name.

## 10. Failure truth table

| Condition | Required behavior |
|---|---|
| Malformed token or rejected URL | Local validation error; no outbound request. |
| Claim HTTP 403 | Token invalid/used; explain it may have been claimed elsewhere, advise disabling it in Bridge and generating a new token. |
| `/accounts` HTTP 402 | Payment action required; retain mappings/credential; stop retrying until user action. |
| `/accounts` HTTP 403 or `gen.auth` | Access invalid/revoked; disable SimpleFIN automatic reads and request reconnect; preserve data. |
| HTTP 429/local budget exhausted | Report retry time; no import and no last-success advancement. |
| Timeout/5xx/unreadable/oversized response | Failed fetch; no partial account import or empty-success message. |
| `con.auth` | Mark only the named institution as requiring attention; link to Bridge to repair; unrelated clean accounts may sync. |
| `act.failed` or `act.missingdata` | No writes or last-success advancement for the affected account/window, even when some rows are returned. |
| Unknown error subcode | Treat by `gen`, `con`, or `act` prefix; unknown/unscoped error conservatively blocks the batch. |
| Deprecated `errors` strings alongside v2 | Surface sanitized warnings; absent scoping/completeness means block the batch rather than guess. |
| Account absent from discovery | Mark unavailable; retain mapping/history, do not delete or zero it. |
| Missing/invalid amount, currency, timestamp, or ID | Existing preview refusal counts; never default money/rates/date/identity. |
| Valid empty transaction list, no blocking error | Successful fetch with zero new rows. Missing transaction field on a transactions read is incomplete response, not an empty list. |
| Balance unavailable but transactions complete | Import may proceed with balance unknown and a visible warning; previous balance retains its old source timestamp. |

Error text is sanitized, bounded, translated where app-authored, and redacted before storage or display. Scope errors before permitting unaffected accounts; a top-level error cannot be attributed optimistically.

## 11. Write and security invariants

Preserve INV-BANKSYNC-001/002/003, INV-BALANCE-001, and INV-CACHE-001. Extend the credential invariant wording to cover access URLs as well as private keys.

- Ledger reservation and transaction/balance writes share the existing `withScopedDb` transaction; unique conflict means no duplicate write.
- Provider balance is comparison data and never overwrites `accounts.current_balance`.
- Rules use the existing import trigger. Invalidate derived balance caches after a committed mutation.
- Deleting a transaction retains its import-ledger tombstone; reconnect does not resurrect it.
- No cross-user mapping, credential access, request budget, preview, or import; test this under actual RLS enforcement.
- Disconnect, failed connection, and credential replacement preserve existing transactions and ledger keys.

## 12. Acceptance and tests

Required tests must fail against the old implementation and pass with the change.

| Layer | Required cases |
|---|---|
| Pure mapper | Signed decimals, zero, precision limits, card signs, local midnight/leap-day and DST boundaries, pending → booked, missing fields, custom currencies, scoped ID collisions, same ID with changed description. |
| HTTP client | Claim once, Basic Auth extraction, v2 requests, all HTTP/error-table cases, 90-day splits and exclusive end, malformed/oversized payload, deadline, redaction, host/port/redirect/DNS protections. |
| Services | Persist-before-discover, ambiguous claim failure, credential replacement failure preserving old access, unchanged identities preserving mappings, changed identities requiring review, no fake revocation/consent expiry. |
| Real PostgreSQL | Additive migration retaining Enable Banking, credential shape checks, RLS owner isolation, concurrent quota reservations at slot 24, duplicate concurrent imports, rollback on writer failure, tombstones and reconnect. |
| Preview | First import gate, fingerprint change refusal, partial-window refusal, mismatch refusal, unknown balance, no opening-balance adjustment, meaningful error/freshness display. |
| Browser | Token entry → multiple institutions → link → preview → confirm; reconnect; quota/payment/reauth screens; token cleared and never stored in URL/localStorage; Enable Banking unchanged. |
| Provider boundary | Use published demo data for claim/read contract testing. Real-bank validation is a separate owner-driven test; no credentials in fixtures or CI. |

Run repository-required backend/frontend lint, type checking, focused/changed tests, builds, migration lint, schema replay, documentation/environment guards, and relevant integration/browser suites. Inspect current working-tree changes before running broad tooling; preserve existing authentication and deployment settings. Record unrelated baseline failures without weakening guards.

Release acceptance: user can import a USD checking and credit-card account, repeat sync without duplicates, view truthful balance/freshness/errors, reconnect safely, and use daily sync; Enable Banking regression checks pass; no sensitive payload appears in logs/backups/client state.

## 13. Delivery and rollback

Use `docs/specs/simplefin-bank-sync.md` for the approved contract and paired `docs/future-plans/simplefin-bank-sync.md` / `simplefin-bank-sync-tasks.md` for execution. Record approval before implementation and follow repository contribution rules before any upstream PR.

Build and test on an isolated branch/test stack. Back up PostgreSQL and deployment configuration before production migration. Preserve current `ENCRYPTION_KEY`, `JWT_SECRET`, volumes, host ports, proxy routing, and authentication settings.

Deploy migration and compatible backend/frontend together. Verify existing SSO and health first, then demo flow, then owner-driven real-bank initial preview. Enable daily syncing only after a successful reviewed import. Avoid rebuilding an unrelated moving `latest` release.

If rollback is required, disable SimpleFIN scheduling, roll application images/source back to recorded versions, and retain additive schema/data. Never delete imported transactions as an automatic rollback step. Revocation of the Bridge token is a separate user-controlled action.

## 14. External contracts and bounded uncertainties

- [SimpleFIN protocol v2 draft](https://www.simplefin.org/protocol.html): token claim/access URL, account/transaction/error models, timestamps, Basic Auth, endpoint parameters.
- [Bridge developer guide](https://beta-bridge.simplefin.org/info/developers): one-time claim, explicit v2 usage, daily request expectation, 90-day windows, overlapping fetches, variable bank history.
- [Supported institutions](https://beta-bridge.simplefin.org/search-institutions): owner verifies intended banks before paid setup.

The spec's schema, APIs, quotas, limits, keys, and UI decisions are proposed Monize implementation choices, not claims that SimpleFIN requires that exact architecture. Before build completion, capture sanitized demo fixtures confirming current v2 fields and errors. Identity survival after deleting/recreating a Bridge bank connection is not guaranteed; use the explicit remapping policy above. Investments and bank-specific account-type/sign metadata require separate contracts before extension.

## Implementation note: Enable Banking compatibility

The internal credential union accepts an omitted enable_banking discriminant only for existing Enable Banking callers. New SimpleFIN credentials have an explicit simplefin discriminant and an internal credentialId for request reservations. RSA and Access URL decryption share BankSyncCredentialsService.resolveCredentials; setup-token persistence accepts only an already-claimed URL. The registry advertises only fully registered adapters.

Institution identity and metadata: SimpleFIN institution external_session_id is an opaque sf2 SHA-256 of [server origin, conn_id], preventing cross-server reconnects from inheriting mappings. Existing non-null country/PSU columns use an empty country (unspecified) and the legacy personal placeholder; SimpleFIN UI must not present those as provider-reported facts. Discovery returns balance timestamps, persisted per account in bank_balance_at and returned through the account view.

Money precision and read contexts: the existing number-based planner/writer cannot preserve every `NUMERIC(24,8)` value. The SimpleFIN read boundary refuses values that cannot retain their four-decimal representation safely, instead of silently converting them. Operation-scoped batch results are not a cross-request cache. Legacy redirect/session registry operations remain separate from the registered SimpleFIN data-reader lookup.

## Provider request-window limit

The public v2 demo returns unscoped gen.api for requests longer than 45 days: “Requested date range exceeds recommended range of 45 days. In the future, this may be capped.” Request windows are therefore capped at 45 inclusive calendar days (exclusive-end timestamps). This retains the original complete-history requirement and stays within the original 90-day maximum. Every complete read reserves its windows together against rolling quota and must complete before any import plan is returned. Global errors remain blocking; no warning text is allowlisted or silently ignored.


## Review corrections: lifecycle, complete batches and dates

Discovery preserves explicit revoked status through refresh and credential replacement.
Transient read failures pause execution through connection status, without changing the
user's desired auto-sync preference. A linked account retains its accepted currency
until explicit unlink/review; repeated discovery cannot accept a changed currency.
Unapproved currency metadata withholds the reported balance.

A historical import is reviewed in complete calendar batches of at most 45 days.
Each preview states its bounds and remaining history; confirmation fingerprints the
bounds, refusal counts and new ledger rows. A cursor advances only with the ledger
commit, and incomplete history continues to require preview (including in daily jobs).
Quota admission reserves every HTTP window of a read under the credential lock before
any HTTP call; no failed admission spends part of an unfinished read. Expired budget
entries are pruned under that lock; informational status does not lock it.

A definitely unsent claim (validation or breaker admission) may be retried. The durable
attempt fence still precedes HTTP; only a holder of the unexpired setup lease can remove
its attempt marker after a typed pre-dispatch refusal. Ambiguous network failures retain
it. The read adapter contract is shared by both providers, independently of authorization.

Individually unreadable booked transactions are counted and shown as refusals alongside
valid rows. Blank descriptions are allowed. Missing arrays, provider-declared incomplete
responses, conflicting identities and unknown account currency still block the read.
Booking dates and API range coverage use the same resolved financial timezone, including
DST and exclusive end bounds. Scheduled reads resolve the explicit preference or last
known client timezone. Existing imported transactions are not rewritten.

Dated refused rows count only inside the account's reviewed window; an undatable
refusal remains visible. Independent balance failures remain nonfatal and log
the local bank-link identifier and the existing safe provider failure description;
the internal failure object never appears in a client response.

Canonical setup-token and stored connection-identifier comparisons use the shared
length-checked `simplefinEqual` helper (`timingSafeEqual` over UTF-8 bytes).

SimpleFIN profile notes include `en-US`, `en-CA`, `fr-CA` and `es-ES`, plus the
required English source and the app's `fr` and `es` base translations. Regional
note translations fall back to their supported base language, then English.
These note-only variants do not add app-wide language options.
