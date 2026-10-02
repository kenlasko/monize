# Spec: bank sync (Open Banking / PSD2 via Enable Banking)

Status: **approved to build.** Scope from discussion kenlasko/monize#1326
("Open Banking / PSD2 Integration via Enable Banking", label
`approved-to-build`, maintainer reply 2026-09-08: "I'm in favour of adding
it. People can choose to use it or not."). The product decisions below
(per-user credentials, booked rows only) were confirmed with the feature's
requester. The plan and the task list are
[`docs/future-plans/bank-sync.md`](../future-plans/bank-sync.md) and
[`docs/future-plans/bank-sync-tasks.md`](../future-plans/bank-sync-tasks.md).

Owner: bank-sync. Related: INV-BANKSYNC-001, INV-BANKSYNC-002,
INV-BANKSYNC-003 (this spec), INV-BALANCE-001, INV-CACHE-001,
`docs/external-side-effects.md` section 6, `docs/cron-jobs.md`,
`docs/future-plans/csv-source-profiles.md` (P2 and P4, the duplicate key and
the cut-off date this spec implements for its own source),
`docs/future-plans/transaction-rules.md` section 6.3 (rules run on the
`import` trigger).

---

## 1. What this adds

A user connects Monize to a bank through a regulated aggregator (an AISP).
The first provider is Enable Banking. After the user authorizes access at
their bank, Monize reads the list of bank accounts, the user maps each bank
account to one Monize account, and Monize imports the **booked** transactions
of that bank account into the Monize account: on request ("Sync now") and once
a day.

The feature is a generic *bank sync provider* concept. Enable Banking is the
first implementation of `BankSyncProvider`; nothing outside
`backend/src/bank-sync/providers/enable-banking/` knows its wire format.

Out of scope for the first release (tasks in the task list): pending rows,
transfers between two synced accounts, splits, the ledger in the backup, MCP and AI tools, payment
initiation. Notifications (consent reminders and sync outcomes) are specified
in [`bank-sync-notifications.md`](./bank-sync-notifications.md).

## 2. Terms

| Term | Meaning |
|---|---|
| Provider | An aggregator Monize talks to (`enable_banking`). |
| Credentials | The provider application a user registered: an application id and an RSA private key (PEM). One row per user and provider. |
| Institution | A bank the provider can connect to (Enable Banking: an ASPSP, identified by name and country). |
| Connection | One authorization of one user at one institution. It carries the provider session and its consent expiry. |
| Bank account | One account the connection can read. It is mapped to at most one Monize account. |
| Ledger row | One row of `bank_sync_imported_transactions`: "this provider transaction was imported into this Monize account". |
| Cut-off date | `sync_from_date`: rows booked before it are never imported. |

## 3. Invariants

```text
INV-BANKSYNC-001  A bank transaction is imported into a Monize account at most once.
INV-BANKSYNC-002  A provider private key never leaves the server.
INV-BANKSYNC-003  A synced row is written in the Monize account's currency or not at all.
```

Full entries are in `docs/system-invariants.md`. The mechanisms:

- **001**: the unique index `(account_id, external_key)` on
  `bank_sync_imported_transactions`. The ledger row is inserted with
  `INSERT ... ON CONFLICT DO NOTHING RETURNING id` **before** the transaction
  row, in the same `withScopedDb` transaction; a row that returns nothing is a
  duplicate and nothing else is written for it. Two concurrent syncs of the
  same account therefore converge (the second insert waits on the first one's
  index entry and returns nothing once it commits). The ledger is keyed on the
  **Monize** account, not the connection, so disconnecting and reconnecting a
  bank does not re-import the history.
- **002**: the key is encrypted with `EncryptionService` (AES-256-GCM) into
  `bank_sync_credentials.private_key_enc`. No response type has a field for it;
  the view carries `privateKeySet: boolean`. The column is not named
  `api_key_enc`, so the backup key transport does not pick it up, and the table
  is excluded from the backup.
- **003**: the currency of a synced row is the Monize account's currency
  (`assertTransactionCurrencyMatchesAccount`). A provider row whose currency
  differs from the account's is refused and counted (`currency_mismatch`), never
  converted and never written in the account's currency with the foreign
  amount.

## 4. Data model

One migration creates four user-owned tables. Each has `user_id` and the
direct RLS policy, enabled in the same file.

| Table | Key columns | Notes |
|---|---|---|
| `bank_sync_credentials` | `id`, `user_id`, `provider`, `application_id`, `private_key_enc` | `UNIQUE (user_id, provider)`. |
| `bank_sync_connections` | `id`, `user_id`, `provider`, `institution_name`, `institution_country`, `psu_type`, `status`, `auth_state_hash`, `auth_started_at`, `external_session_id`, `valid_until`, `auto_sync`, `notify_success`, `tag_operation_type`, `last_error` | `status IN ('pending','active','expired','revoked','failed')`. Partial unique index on `auth_state_hash`. |
| `bank_sync_accounts` | `id`, `user_id`, `connection_id`, `external_account_id`, `identification_hash`, `display_name`, `identifier_masked`, `account_identifier`, `cash_account_type`, `currency_code`, `account_id`, `sync_from_date`, `last_synced_at`, `last_success_at`, `last_sync_status`, `last_sync_error`, `last_imported_count`, `last_skipped_count`, `last_refused_count`, `bank_balance`, `bank_balance_currency`, `bank_balance_date` | `UNIQUE (connection_id, external_account_id)`; partial unique index on `account_id`; `CHECK (account_id IS NULL OR sync_from_date IS NOT NULL)`; `account_id` is `ON DELETE SET NULL`. |
| `bank_sync_imported_transactions` | `id`, `user_id`, `account_id`, `external_key`, `transaction_id`, `booking_date`, `excluded_at`, `created_at` | `UNIQUE (account_id, external_key)`; `account_id` is `ON DELETE CASCADE`; `transaction_id` is `ON DELETE SET NULL`. |

A deleted Monize transaction keeps its ledger row (with `transaction_id`
NULL). A deleted row therefore stays deleted: the next sync does not bring it
back. This is the intended behaviour, and the UI says so.

`bank_balance` is `NUMERIC(20,4)`, the money precision. It is what the bank
reported, shown beside the Monize balance for reconciliation. It never writes
`current_balance`.

**Backup.** All four tables are in `INTENTIONALLY_EXCLUDED_TABLES`:
credentials and connections are secrets and sessions under this instance's
key; bank accounts are re-created by a new connection. The ledger is excluded
in the first release (task BS11 exports it). The consequence, and its guard: after a
restore into a fresh instance the ledger is empty, so the link form defaults
the cut-off date to the day after the newest transaction in the Monize
account (section 7), and the form says that a date earlier than the newest
transaction in the account may import rows that are already there.

## 5. Authorization flow

```text
user            Monize API                     provider            bank
 |  connect(bank) |                               |                  |
 |--------------->| row: pending, state hash      |                  |
 |                |------ start authorization --->|                  |
 |<--- redirect --|<------------ url -------------|                  |
 |------------------------------------------------------ SCA -------->|
 |<------------------- redirect_url ?code&state -----------------------|
 | callback(code, state)                          |                  |
 |--------------->| CAS pending -> (claimed)      |                  |
 |                |------ create session -------->|                  |
 |                |<----- session, accounts ------|                  |
 |                | row: active, accounts upserted|                  |
```

- **State.** 32 random bytes, base64url. Only its SHA-256 hex is stored. The
  callback finds the connection by `(user_id, auth_state_hash)` with
  `status = 'pending'` and `auth_started_at` no older than
  the constant `AUTH_STATE_TTL_MS` (30 minutes). A state from another user, an old
  state or a used state is refused with the same 400. The row's
  `auth_state_hash` is cleared in the same transaction that claims it, so a
  replayed callback finds nothing (the clear is the claim).
- **Redirect URL.** `${PUBLIC_APP_URL}/settings/bank-sync/callback`. The user
  registers this exact URL in the provider's control panel; the status
  endpoint returns it so the settings page can show it.
- **Consent validity.** The server reads the institution's
  `maximum_consent_validity` from the provider and asks for
  `min(maximum, 180 days)`. The client never supplies a validity.
- **No linked accounts.** A session that returns no accounts is revoked and
  the callback fails with `no_accounts_linked`: a Production application in
  restricted mode returns an empty list for an account that is not linked to
  it in the control panel ("Activate by linking accounts").
- **Error at the bank.** The callback with `error` (and no `code`) records the
  provider's description (bounded to 500 characters) in `last_error` and
  clears the state. A first-time connection (`pending`) becomes `failed`; a
  connection that was already `active` or `expired` keeps its status, so a
  failed renewal never disables a working session.
- **Re-authorization.** `POST /bank-sync/connections/:id/reauthorize` starts a
  new flow on the same row: it writes a new state hash and `auth_started_at`
  and leaves `status` unchanged, so the current session keeps syncing until
  the new one replaces it; the callback claims by the state hash alone. A
  provider failure while starting it also leaves `status` unchanged. After a
  successful re-authorization the previous provider session is revoked (best
  effort, outside any transaction). The new session's accounts are matched
  to the existing `bank_sync_accounts` rows by `identification_hash` (stable
  across sessions), so every mapping and cut-off survives; unmatched accounts
  are added unmapped.
- **Network access.** The redirect is a browser redirect: the bank sends the
  user's browser to the redirect URL, and the frontend posts `code` and
  `state` to the backend. No Enable Banking server connects to Monize, so the
  instance needs no inbound rule, no public address and no allowlist of
  provider IP addresses; the redirect URL only has to open in the browser the
  user authorizes with. The backend needs outbound HTTPS to
  `api.enablebanking.com` (port 443). Neither `docker-compose*.yml` nor the
  Helm chart restricts egress, so the default deployment needs no change; an
  operator who adds an egress policy allows that host. The provider can
  still refuse the address the backend calls from: it answers
  `UNAUTHORIZED_IP` ("Used IP address is not authorized to access the
  resource"), which Monize reports as `ip_not_allowed`. The published
  documentation does not describe an application-level IP restriction, so
  the repair is to ask Enable Banking support.
- **Disconnect.** Deletes the connection (and its bank accounts, by cascade)
  after asking the provider to delete the session. A provider failure on that
  call is logged and does not block the local delete: the consent expires at
  the bank by itself.

## 5a. Matching and creating Monize accounts

The provider returns each bank account's full identifier (IBAN, else the
BBAN or another scheme), its currency and its cash account type (`CACC`,
`CARD`, `SVGS`, ...). Monize stores the identifier in
`bank_sync_accounts.account_identifier`, normalized (spaces and dashes
removed, upper case), and the type in `cash_account_type`. The identifier has
the same sensitivity as `accounts.account_number`, which Monize already
stores; `identifier_masked` stays the value shown in lists.

**Automatic link.** After a callback or a re-authorization, every unlinked
bank account with an identifier is compared with the user's own Monize
accounts that are open, not investment brokerage, not linked to another bank
account and in the same currency (or the bank account's currency is
unknown). An account number matches when, normalized the same way, it equals
the identifier, or equals the identifier without its two-letter country
prefix (a Polish NRB is the IBAN without `PL`). Exactly one match links the
pair through the ordinary link path, with the default cut-off (section 7);
two or more matches link nothing and are returned as suggestions. The
callback answer lists what was linked, so the page can say so.

**Match on request.** `POST /bank-sync/connections/:id/match` runs the same
matching for a connection made before identifiers were stored: for each
unlinked bank account without an identifier, it reads the account details
from the provider first (`GET /accounts/{uid}/details`, outside any
transaction), stores the identifier, then matches. Both the callback and this
route answer `{ connection, linked: [{ bankAccountId, accountId }],
suggestions: [{ bankAccountId, accountIds }] }`; two bank accounts that would
take the same Monize account both become suggestions. The account view
returns `accountIdentifier` to its owner (the accounts API already returns
`account_number`), so the new-account form can prefill it.

**Create from the bank account.** The account picker offers "Create a new
account". It opens Monize's own account form, prefilled from the bank
account: the name (the bank's account label, else the masked identifier), the
currency, the account number (the identifier) and the type (`CARD` a credit
card, `SVGS` a savings account, `LOAN` a loan, otherwise a chequing account).
The opening balance is left for the user to enter. When the form saves, the
new account is linked with the default cut-off for an empty account. Nothing
is created until the user saves the form.

## 6. Mapping a provider row

The provider adapter turns a wire row into `BankTransaction` (provider
neutral). `planBankImport` (pure) turns a list of those into planned rows and
refusals. Truth table (the first matching line wins):

| Input | Result |
|---|---|
| `status` is not booked | not planned, counted as `pending` (not an error) |
| no valid date (`booking_date`, then `value_date`, then `transaction_date`, each `YYYY-MM-DD`) | refused `missing_date` |
| date before `sync_from_date` | not planned, counted as `before_cutoff` |
| date after today (server date) + 1 day | refused `future_date` |
| amount not matching `^\d{1,16}(\.\d{1,8})?$` after trimming | refused `invalid_amount` |
| direction neither credit nor debit | refused `unknown_direction` |
| currency differs from the Monize account's | refused `currency_mismatch` |
| otherwise | planned |

For a planned row:

- **Amount.** `roundMoney(Number(abs))` (four decimals, the column's
  precision), negated for a debit. Example: debit `"12.34565"` gives
  `-12.3457`; credit `"1000"` gives `1000`; a zero debit gives `0`, not `-0`.
- **Date.** The first valid of `booking_date`, `value_date`,
  `transaction_date`.
- **Payee text.** Debit: the creditor's name; credit: the debtor's name;
  otherwise the first remittance line. Trimmed, bounded to 100 characters
  (the create DTO's bound). Empty gives no payee.
- **Description.** The remittance lines joined with a space, trimmed, bounded
  to `TRANSACTION_NOTE_MAX_LENGTH`.
- **Reference number.** The bank's own reference (`reference_number`),
  bounded to 100 characters, or null. It is display data only; the duplicate
  key is not stored there (csv-source-profiles C2).
- **Status.** `CLEARED`: the bank has booked it.
- **External key** (INV-BANKSYNC-001), the first that applies:
  1. `ref:` + the provider's entry reference. Enable Banking documents
     `entry_reference` as unique and immutable for accounts with the same
     identification hashes, and not globally unique; its FAQ adds that some
     banks repeat values. When one fetch carries the same reference on rows
     that differ in content, each of those rows is keyed
     `ref:<reference>#<SHA-256 hex of its content>`, so none is lost and the
     key does not depend on the listing order;
  2. `hash:` + SHA-256 hex over `date|amount|currency|direction|payee|description`,
     then `:` + the occurrence number of that hash among the rows of this
     fetch, counted from 0 in the order the provider returned them.
  A key longer than 255 characters is replaced by its prefix and the SHA-256
  hex of the whole value. The hash form is stable because every fetch
  requests whole days (section 7), so two identical coffees on one day are
  always `:0` and `:1`.

  The provider's `transaction_id` is never part of the key: Enable Banking
  documents it as a handle for fetching details that may change when the list
  is fetched again. A booked row that repeats both the entry reference and
  the content of an earlier booked row of the same fetch (a pagination
  overlap) is planned once. The content is the three dates, the amount, the
  currency, the direction, the counterparty, the remittance lines and the
  bank reference.

## 7. Syncing one bank account

Window: `date_from = max(sync_from_date, last_success_at::date - 7 days)`
(`sync_from_date` alone before the first success), `date_to = today`. The
overlap re-reads a week so a row the bank booked late is not missed; the
ledger makes the re-read free. `date_from` is sent as at most today in UTC:
the provider reads dates in UTC and refuses a later `date_from` with
`DATE_FROM_IN_FUTURE`.

Default cut-off when a bank account is linked (`readLinkDefaults`, also
served to the link dialog by `GET /bank-sync/accounts/:id/link-defaults` as
`{ newestTransactionDate, defaultSyncFromDate }`, so the dialog and the link
use one definition): the day after the newest
non-VOID transaction in the Monize account, or today minus 89 days for an
empty account (one day inside the 90 days many banks serve after the first
hour of a consent; Enable Banking FAQ). The user may choose another date.

Steps:

1. **Read** the link, the connection and the credentials (one
   `withScopedDb`). Refuse when the bank account is not linked, the connection
   is not `active`, or `valid_until` has passed (the connection is then marked
   `expired` in the same transaction and the refusal says to renew it).
2. **Lease.** `JobClaimService.claimLease(JobClaimType.BankSyncAccount, userId,
   bankAccountId, 30 min)`; 30 minutes covers the worst fetch, 100 pages at a
   15 second timeout each, plus the balances. A refused lease is a 409 ("a sync of this account
   is already running"). The lease saves the provider quota; the ledger is
   what makes a race correct.
3. **Fetch** outside any transaction: every page of booked transactions in the
   window (bounded to 100 pages), then the balances (a balance failure is
   logged and leaves the stored balance unchanged). A user-present sync passes
   the PSU IP address and user agent, so the bank does not count it against the
   unattended-access limit (Enable Banking FAQ: many banks allow four
   background fetches a day, and it recommends continuing after six hours;
   online or background is decided by the presence of the PSU headers, and a
   bank that lists required PSU headers must receive all of them or none).
4. **Plan** with `planBankImport` (section 6).
5. **Write**, one `withScopedDb` transaction:
   - lock the `bank_sync_accounts` row `FOR UPDATE` and re-check it is still
     linked to the same Monize account with the same cut-off date (a re-link or
     a new cut-off during the fetch refuses the whole write with 409: nothing
     is written and `last_success_at` does not move);
   - lock the Monize account for a balance write, re-read it, refuse when it is
     closed, is an investment brokerage account, or its currency changed since
     the rows were planned;
   - load the `import` rules once;
   - per planned row: insert the ledger row (`ON CONFLICT DO NOTHING
     RETURNING id`); nothing returned means `skipped`; otherwise resolve the
     payee by name, then by alias, else insert it with
     `ON CONFLICT (user_id, name) DO UPDATE ... RETURNING` (two syncs meeting
     the same new counterparty converge), create the transaction, point the
     ledger row at it;
   - apply the `import` rules to the created ids, with the raw payee text;
   - recompute the balance from the ledger with
     `AccountsService.recalculateCurrentBalance`, which joins this
     transaction under the lock already held (INV-BALANCE-001; the writer never
     writes `current_balance` itself);
   - write the sync outcome on the `bank_sync_accounts` row.
6. **After the commit**: `triggerDebouncedRecalc` for the account when
   anything was created (INV-CACHE-001), release the lease.
7. **On failure** at any step after 2: write `last_sync_status = 'failed'` and
   a bounded, sanitized message in its own transaction, release the lease,
   return the mapped error. The provider's `error` code decides, before the
   HTTP status: `EXPIRED_SESSION`, `REVOKED_SESSION`, `CLOSED_SESSION` and
   `SESSION_DOES_NOT_EXIST` mark the connection `expired`; `UNAUTHORIZED_IP`
   is `ip_not_allowed`; `NO_ACCOUNTS_ADDED` is `no_accounts_linked`;
   `WRONG_TRANSACTIONS_PERIOD` is `period_unavailable` (set a later cut-off);
   `ASPSP_RATE_LIMIT_EXCEEDED` and 429 are `rate_limited`; `ASPSP_ERROR`,
   `ASPSP_TIMEOUT`, 408 and 5xx are `unavailable`. Every other 401 or 403,
   including "Application does not exist", which carries no error code, is a
   credentials refusal and leaves the connection alone.

The result: `{ imported, skipped, refused: { reason: count }, pending,
beforeCutoff, bankBalance }`. `imported > 0` is what makes the client
invalidate its balance caches. A sync whose outcome the client could not
learn (a timeout, a network error, a 5xx) invalidates them too and says the
result is not known yet: the server may have committed.

## 7a. Preview before import

`POST /bank-sync/accounts/:id/preview` runs steps 1 to 4 of section 7 and the
read-only half of step 5, through the same functions, and writes nothing. It
answers one row per provider row:

| Field | Meaning |
|---|---|
| `outcome` | `new`, `duplicate` (the ledger already has its key), `refused` (with the reason), `pending`, `before_cutoff` |
| `transactionDate`, `amount`, `currencyCode`, `payeeText`, `description`, `referenceNumber` | as the planner produced them |
| `payeeName`, `categoryName`, `tagNames` | what the payee lookup and the `import` rules would give (`previewForRow`) |

and a summary: the counts per outcome, the Monize account's current balance,
the balance after the import (current balance plus the sum of the `new` rows,
in scaled integers), and the bank's reported balance with the difference when
both are known and in the same currency. The answer also carries
`planFingerprint`: the SHA-256 of the `new` rows' keys and amounts, in key
order.

`POST /bank-sync/accounts/:id/sync` accepts an optional `planFingerprint`.
With it, the write transaction recomputes the plan under the row lock and
refuses with 409 when the fingerprint differs ("the bank's data changed since
the preview; preview again"), so what is written is exactly what was shown.

**When the preview is shown.** A bank account needs its preview while it is
linked and `last_success_at` is NULL: after it is linked, or after its Monize
account or cut-off date changed (the link clears `last_success_at`). The view
carries this as `needsPreview`. Then "Sync now" opens the preview, and the
import runs only when the user confirms it. **Nothing imports a bank account
that needs its preview without that confirmation:** the daily sync and
`POST /bank-sync/connections/:id/sync` skip it and report it as
`needs_preview`. Later, "Sync now" imports directly and offers the preview as
a second button; the daily sync never previews.

The fingerprint is the SHA-256 of `JSON([[key, amount to 4 decimals], ...])`
over the planned rows the ledger does not hold yet, sorted by key. A preview
takes the sync lease and records nothing on the bank account; a sync refused
for a changed fingerprint records no failure, since nothing was attempted.

A preview is a user-present provider read (PSU headers), so the bank does not
count it against the background limit; it still costs a request, so the route
is throttled like sync.

## 7b. Preview details: selection, exceptions, operation types, payees, rules

Requested by the feature's requester on 2026-10-02 after the first real
preview (146 rows from PKO BP).

**Operation type.** The adapter reads the bank's operation type without
touching the description, because the description is part of the `hash:`
key (section 6) and a changed description would re-import rows:

- from `bank_transaction_code` (`description`, `code`, `sub_code`, bounded),
  when the bank sends it;
- else from a remittance line, or the last word of one, shaped like an
  upper-case hyphenated code (`^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$`, for example
  `CARD-PAYMENT`, `TRANSFER-IN`, `MOBILE-PAYMENT-POS-NO-CARD-TX-CODE`).

Monize has no transaction type column; its only structural type is the
transfer. So:

- a transfer between two of the user's own synced accounts becoming a
  Monize transfer stays task BS14 (it needs both legs matched);
- every other operation type becomes a **tag**, when the connection's
  `tag_operation_type` setting is on (default on). The label comes from the
  **source profile** chosen by the connection's provider, country and
  institution name (`docs/future-plans/source-profiles.md`, task SP2):
  `backend/src/bank-sync/profiles/pl/pko-bp.json` for PKO Bank Polski
  (card payments, BLIK purchases, refunds and cash withdrawals, transfers by
  direction, standing orders, cashback, loan and card repayments),
  `profiles/default.json` for every other bank (`TRANSFER-IN` and
  `TRANSFER-OUT` only). A code the profile does not name is its own tag
  name. The tag is resolved by name case-insensitively and created in the
  recipient's language when missing, and it is attached **before** the
  `import` rules run, so a rule can use it ("tags has any Card payment").
- **The description** leaves out the remittance line that is exactly the
  operation code (PKO BP sends it as the second line); the duplicate key
  still hashes the raw remittance text, so this changes no key.

**Selection.** Every `new` row has a checkbox, checked by default, with
"select all" and "select none" for the visible tab. A row that is not
checked is either:

- **skipped now** (the default): nothing is written; the next sync shows it
  again;
- **added to the exceptions**: a ledger row is written with `excluded_at`
  set and no transaction, so no later sync imports it. The preview lists
  exceptions in their own tab (`excluded`, apart from `duplicate`) with
  "Remove from exceptions", which deletes that ledger row.

The sync body carries `{ planFingerprint, importKeys, excludeKeys }`. The
fingerprint stays the whole plan's, so the write still refuses a changed
bank answer; the write also refuses (400) a key that is not a `new` row of
that plan. Exceptions and imports are written in the same transaction.

**Payee mapping.** Each row reports how its payee resolves: `name` (an
existing payee of that exact name), `alias` (with the matched pattern and
the payee), `new` (a payee will be created), `rule` (a rule sets it), or
`none`. The row shows the resolved payee; hovering or focusing it shows the
bank's original text, the payee it maps to and how. The expanded row links
to the payee's aliases.

**Rules.** The preview loads the `import` rules once and returns each row's
trace: every rule that matched, by name (linked to the rule), what each
action changed (before and after, for category, payee, description and
tags) and the actions it skipped with their reason.

**Raw bank data** goes to the backend log, not to the screen, and only when
the operator sets `BANK_SYNC_LOG_RAW=true` (the application's logger prints
debug lines unconditionally, so the variable is the gate). The Enable Banking
client then logs each raw answer (transaction pages, balances, session and
account details) with every account identifier masked to its country code and
last four characters, the session id to its last four characters, and never
the JWT or a header; a line is bounded to 64 KB. Turn it on to diagnose,
then off: the log then holds counterparty names, remittance text and amounts.

**The window after a partial import.** When new rows were skipped (not
imported and not excepted), `last_success_at` does not move and the account
still needs its preview, so the skipped rows stay inside the window and the
next preview shows them again.

**Source-neutral parts.** The payee-resolution report, the rule-trace mapping
and the selection state live in `backend/src/import-preview/` and
`frontend/src/components/import-preview/`, without bank types, for the
unified import preview (`docs/future-plans/unified-import-preview.md`).

## 8. The daily sync

`BankSyncCronService` runs once a day (`17 5 * * *`, UTC). The fan-out lists
the users with at least one `active`, `auto_sync` connection that has a linked
bank account (`withSystemContext`). Per user, under `withUserContext`:
`claimOnce(JobClaimType.BankSyncDaily, userId, <UTC date>)`, then every linked
bank account of that user in turn; one account's failure is recorded on that
account and the loop continues. Two replicas therefore sync each user once a
day.

It skips a bank account that needs its preview (section 7a) and, after each
user's run, writes the outcome notifications of
[`bank-sync-notifications.md`](./bank-sync-notifications.md) section 5.

## 9. API

All routes: `@Controller("bank-sync")`, `AuthGuard("jwt")`, owner only (no
`@AllowDelegate`), `ParseUUIDPipe` on every `:id`, `@DemoRestricted()` on
every write, DTOs with `whitelist` + `forbidNonWhitelisted` and bounded
fields.

| Method and path | Body | Answer |
|---|---|---|
| `GET /bank-sync/status` | | `{ encryptionAvailable, providers, credentials: { provider, applicationId, privateKeySet } \| null, redirectUrl }` |
| `PUT /bank-sync/credentials` | `{ applicationId, privateKey? }` | the status. `privateKey` omitted keeps the stored key; it is required when none is stored. The PEM must parse as an RSA private key. |
| `DELETE /bank-sync/credentials` | | 204 |
| `POST /bank-sync/credentials/test` | | `{ ok, applicationName, redirectUrls }` |
| `GET /bank-sync/institutions?country=PL` | | `[{ name, country, logoUrl, psuTypes, maximumConsentValidityDays }]` |
| `GET /bank-sync/connections` | | connections with their bank accounts |
| `POST /bank-sync/connections` | `{ institutionName, country, psuType }` | `{ connectionId, authorizationUrl }` |
| `POST /bank-sync/connections/:id/reauthorize` | | `{ connectionId, authorizationUrl }` |
| `POST /bank-sync/callback` | `{ state, code?, error?, errorDescription? }` | `{ connection, linked, suggestions }` (section 5a) |
| `PATCH /bank-sync/connections/:id` | `{ autoSync?, notifySuccess?, tagOperationType? }` | the connection; an omitted field keeps its value |
| `DELETE /bank-sync/connections/:id` | | 204 |
| `POST /bank-sync/connections/:id/match` | | the connection, with `{ linked, suggestions }` (section 5a) |
| `PATCH /bank-sync/accounts/:id` | `{ accountId: uuid \| null, syncFromDate? }` | the bank account |
| `GET /bank-sync/accounts/:id/link-defaults?accountId=` | | `{ newestTransactionDate, defaultSyncFromDate }` (section 7) |
| `POST /bank-sync/accounts/:id/preview` | | the preview (section 7a) |
| `POST /bank-sync/accounts/:id/sync` | `{ planFingerprint?, importKeys?, excludeKeys? }` | the result (section 7); 409 when the fingerprint no longer matches; 400 for a key that is not a new row of the plan |
| `POST /bank-sync/accounts/:id/exceptions/remove` | `{ keys }` | the bank account; deletes only excepted ledger rows |
| `POST /bank-sync/connections/:id/sync` | | one entry per linked account: a result, or `{ bankAccountId, error: { code, message } }` for an account that failed |

Linking refuses (400) an account the user does not own, a closed account, an
investment brokerage account, an account already linked to another bank
account, and an account whose currency differs from the bank account's known
currency.

## 10. Missing-data policy

- A bank account without a currency from the provider can be linked; each row
  is then checked on its own (section 6).
- A balance the provider did not return is `null` and shown as "not reported
  by the bank", never `0`.
- The Monize-versus-bank difference is shown only when both balances are known
  and in the same currency.
- A provider that did not answer is reported as unavailable (the breaker in
  `ProviderHealthService`), never as "no new transactions".

## 11. Test matrix

| Claim | Test |
|---|---|
| Mapping truth table, each line | unit, `bank-transaction-planner.spec.ts` |
| Key: ref, id, hash, occurrence counter, 255 bound | unit, same file |
| JWT: RS256, `kid` = application id, `iss`/`aud`/`iat`/`exp`, verifies with the public key | unit, `enable-banking-jwt.spec.ts` |
| Adapter: pagination, booked filter, error mapping, PSU headers, breaker calls | unit, `enable-banking.client.spec.ts` with a typed `fetch` double |
| State: one use, TTL, other user's state refused | unit, service spec; integration for the claim CAS |
| A second sync of the same rows imports nothing (INV-BANKSYNC-001) | integration, real PostgreSQL |
| Two concurrent syncs import each row once | integration, two connections |
| Currency mismatch refused, nothing written (INV-BANKSYNC-003) | unit and integration |
| Key never in a response (INV-BANKSYNC-002) | unit, response type and serializer spec |
| Balance moved once by the created sum (INV-BALANCE-001) | integration |
| Matcher: IBAN vs NRB, separators, several matches, currency, closed and linked accounts | unit, `bank-account-matcher.spec.ts` |
| Preview writes nothing; preview then sync imports exactly the new rows; a changed provider answer refuses the sync | unit and integration |
| Cron: once per user per day, failure of one user isolated | unit with the real `withScopedDb` over a mock `DataSource` (`rls-context-smoke` pattern) |
