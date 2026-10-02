# Bank sync: agent task list

> Companion to [`bank-sync.md`](./bank-sync.md) and
> [`docs/specs/bank-sync.md`](../specs/bank-sync.md). Tasks in dependency
> order.

## How to use this list

- **The governing invariants apply to every task**: INV-BANKSYNC-001 (at most
  once), INV-BANKSYNC-002 (the key never leaves the server), INV-BANKSYNC-003
  (the account's currency or nothing).
- **Definition of done**: the layer gates of `AGENTS.md`; the migration with
  `migration:lint`, `scripts/verify-schema.sh` and
  `node scripts/check-migration-prefixes.mjs`; strings in every locale; the PR
  body per `.github/pull_request_template.md`.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| BS1 | Spec, plan and invariants merged | -- | none | [x] |
| BS2 | Migration and `schema.sql`: four tables, indexes, RLS; entities; backup classification | BS1 | inert | [x] |
| BS3 | Provider interface, registry, Enable Banking JWT, client and mapper; provider-health adoption | BS1 | inert | [x] |
| BS4 | Credentials service and routes | BS2 | additive | [x] |
| BS5 | Connections: start, callback with the state CAS, re-authorize, disconnect | BS3, BS4 | additive | [x] |
| BS6 | Planner, writer and sync of one account; link routes; integration spec | BS5 | additive | [x] |
| BS7 | Daily cron, `docs/cron-jobs.md` row | BS6 | additive | [x] |
| BS8 | Settings pages, callback page, API client, English strings | BS6 | additive | [x] |
| BS9 | Every other locale | BS8 | none | [x] |
| BS10 | Verify the wire format against an Enable Banking sandbox application; correct the mapper and the plan's assumption 3 | BS6 | none | [ ] |
| BS11 | Export and restore the ledger in the backup (id remap on `account_id`, `transaction_id`) | BS6 | neutral | [ ] |
| BS12 | Notifications: consent reminders at 30, 14, 7, 3, 2, 1, 0 days and on expiry; daily sync outcomes (`docs/specs/bank-sync-notifications.md`) | BS7 | additive | [x] |
| BS13 | Pending rows: import as `UNRECONCILED`, replace when booked (needs its own spec for the match) | BS10 | additive | [ ] |
| BS14 | A row whose counterparty account is one of the user's Monize accounts (by account number) becomes a transfer: own-account `TRANSFER`, `STANDING-ORDER`, `CREDIT-CARD-AUTO-REPAYMENT` | BS10, BS16 | additive | [ ] |
| BS15 | MCP and AI tools: list connections, sync now (with confirmation) | BS6 | additive | [ ] |
| BS16 | Match bank accounts to Monize accounts by account number; create a Monize account prefilled from a bank account (spec section 5a) | BS6 | additive | [x] |
| BS17 | Offer to set a new account's opening balance so that its balance after the first sync equals the bank's | BS16 | additive | [ ] |
| BS18 | Preview before import, the first sync after a link change confirmed from the preview, commit refused on a changed plan fingerprint (spec section 7a) | BS6 | additive | [x] |
| BS19 | Show the provider's account type beside the account and warn when it does not match the Monize account's type (a card linked to a chequing account) | BS16 | additive | [x] |
| BS20 | Preview details: row selection with skip now or add to exceptions, operation type to tag, payee mapping with hover, rule traces, raw bank data (spec section 7b) | BS18 | additive | [x] |
| BS21 | A loan repayment row (PKO `LOAN-PAYOFF`, remittance "KAPITAŁ: x ODSETKI: y") becomes a split: principal as a transfer to the loan account, interest as an expense; the split must sum to the amount or the row is refused (needs its own spec) | BS14 | additive | [ ] |

## Notes per task

- **BS10** is the only task that needs a real provider account. Record the
  observed field names in the plan; never paste a real account number, IBAN
  or name into the repository (use synthetic fixtures).
- **BS10, observed so far (control panel, "Add a new application" form):**
  - The environment is chosen per application: Sandbox (activated
    automatically, connected to a limited set of bank sandboxes and a
    "Mock ASPSP") or Production.
  - The RSA key is either generated in the browser, with the private key saved
    as a file on "Register", or generated outside the browser, with the public
    certificate imported. The default is the browser.
  - Redirect URLs are entered in "Allowed redirect URLs (one per line)".
  - The settings card's steps follow this form.
  - The downloaded key file is named `<application id>.pem` (observed).
  - A new Production application shows "Inactive" with two buttons:
    "Activate by linking accounts" (restricted mode: "Only linked accounts
    can be accessed") and "Request activation" (general availability, not
    needed for personal use).
  - Production redirect URLs must be https; Sandbox accepts http; the
    redirect URL does not have to be public; restricted mode does not check
    the privacy and terms URLs (Firefly III data importer tutorial, secondary
    source).
  - Verified from the official docs: the JWT (RS256, `kid` = application
    ID, `iss`/`aud`, a lifetime of at most 86400 s) and the wire format in
    the plan's assumption 3.
  - Control panel: `https://enablebanking.com/cp/applications` ("API
    applications").
  - Activation: "Activate by linking accounts" makes the application active
    in restricted mode ("Using restricted applications you can only fetch
    data from accounts linked to the application"). The authorization through
    the API is still needed afterwards, also for the same account; an
    unlinked account gives an empty account list.
  - Terms: Production use is limited to linked accounts, "solely for
    evaluation purposes or for the personal use of private individuals",
    which matches assumption 1.
  - Not documented: an application-level IP allowlist (only the
    `UNAUTHORIZED_IP` code exists), and the HTTP status of most error codes.
  - Follow-ups: send every PSU header a bank lists in `required_psu_headers`;
    show `GET /application`'s `active` flag in the credentials test.
  - Observed from a live PKO BP session (2026-10-02, 146 booked rows;
    shapes only, no data copied): `bank_transaction_code` and
    `merchant_category_code` are always null; `remittance_information` always
    has two lines, the second being the operation code (`CARD-PAYMENT`,
    `MOBILE-PAYMENT-POS-NO-CARD-TX-CODE`, `TRANSFER`, `TRANSFER-IN`,
    `MOBILE-PAYMENT-ATM-TX-CODE`, `STANDING-ORDER`, `CASHBACK`,
    `MOBILE-PAYMENT-POS-RETURN`, `LOAN-PAYOFF`,
    `CREDIT-CARD-AUTO-REPAYMENT`); every row has `entry_reference` shaped
    `O;<digits>`; `creditor`/`debtor` names appear only on transfers; every
    row carries `balance_after_transaction`.
  - Still to check: one real import against a live session. Mark BS10 done
    after it.
- **BS11** replaces the cut-off-date mitigation in spec section 4, not the
  cut-off date itself.
