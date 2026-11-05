# Plan: Joint Accounts (native visibility of shared accounts)

This design shipped: the spec and task list landed in PR #1027, every task of
the task list is done, and the feature is in release 1.14.0
(`docs/release-notes/1.14.0.md`). The plan is retired and this document is
kept as the specification the code is held to.

## Goal

Let an account owner mark any of their accounts as a **joint account** for one or more other
Monize users. A joint account appears in each grantee's **own** account list, register and net
worth as if it were native -- no context switching -- while the owner keeps per-user
read / create / edit / delete control through the existing Shared Access grants. Both sides can
always see that the account is joint: the grantee sees who shares it, the owner sees how many
people it is shared with.

This builds directly on the merged cross-owner-transfers work (`cross-owner-transfers.md`):
`CrossOwnerAccessService`, per-leg transfer ownership, frozen-link revoke semantics and the
"Hidden account" masking are all reused, not rebuilt.

## Data model

One new column and one new table; everything else derives from current grant state.

- `account_delegate_grants.is_joint BOOLEAN NOT NULL DEFAULT false` -- the opt-in flag. A grant
  row with `can_read AND is_joint` (under an `active` delegation) makes the account natively
  visible to that delegate. Plain grants (`is_joint = false`) behave exactly as before: visible
  only while acting in the owner's context.
- `delegate_net_worth_exclusions (delegate_user_id, account_id)` -- row presence means "this
  grantee excludes this joint account from *their* net worth". Modeled on
  `delegate_account_favourites`; the owner's `accounts.exclude_from_net_worth` is never consulted
  for the grantee view and never modified by the grantee.

## Invariants (govern every task)

1. **Per-row ownership.** `transactions.user_id` = the account owner's id, always -- including
   rows the grantee writes. Grantee ids never appear on owner rows. Owner reference-data ids
   (category, payee) appear only on owner rows; grantee reference-data ids never do.
2. **Authorization precedes the bypass window.** Grantee writes run under
   `withSystemContext(() => withScopedDb(...))` only after the joint grant, the operation flag and
   the type policy have all been checked; every check that can refuse runs inside the mutation's
   transaction (financial contract section 7). Nothing user-controlled selects rows inside the
   window beyond the already-validated ids.
3. **Everything derives from current grant presence.** Native visibility, register access,
   net-worth inclusion, transfer connectivity and masking are all computed per request from the
   live `account_delegate_grants` rows. Revoke therefore needs no data surgery, and re-granting
   restores everything with zero migration -- the same principle that makes frozen-link reshare
   free for cross-owner transfers.
4. **Non-joint behavior is untouched.** Plain delegation (context switching), non-delegate users
   and acting-context requests behave byte-identically. Every new branch is entered only when a
   joint grant exists for the requesting user.

## V1 account-type truth table

| Account type | Shareable as joint | Grantee writes (per grant flags) |
|---|---|---|
| CHEQUING, SAVINGS, CASH, CREDIT_CARD, LINE_OF_CREDIT | yes | create / edit / delete as granted |
| INVESTMENT, LOAN, MORTGAGE, ASSET, CRYPTO, OTHER | yes | **none** -- read-only in v1 regardless of grant flags |

The writable set is defined once as `JOINT_WRITABLE_ACCOUNT_TYPES` in
`backend/src/delegation/joint-accounts.service.ts`; effective permissions returned to the client
are the grant flags AND-ed with this policy, so the UI and the service can never disagree.

## Reference-data policy (grantee writes on the owner's ledger)

1. A transaction row in a joint account belongs to the owner and may only carry the **owner's**
   `categoryId` / `payeeId`. Submitted ids are validated against the owner's ledger inside the
   mutation's transaction.
2. The grantee picks category and payee from the owner's lists, served by
   `GET /delegation/joint-accounts/:accountId/reference-data` (gated on the joint read grant).
3. Free-text `payeeName` auto-creates a payee on the owner's ledger only when the delegation has
   `payees_can_create`; otherwise 403. Category creation is the same rule on its own capability:
   `POST /categories/joint/:accountId` (`backend/src/categories/joint-categories.service.ts`)
   creates on the owner's ledger only when the delegation has `categories_can_create`, otherwise
   403. It gates the account on READ, like the reference data it feeds -- the capability is what
   authorizes the write, exactly as it is on the acting-as `POST /categories`, which consults no
   account grant at all. Until that endpoint existed the flag drove nothing from the native
   context: the client's only create wrote to the caller's own ledger, so the form withheld the
   option whatever the owner had granted.
4. Tags are per-user: the grantee cannot set `tagIds` on joint rows (400). The owner's existing
   tags on those rows display read-only.

## Net-worth truth table (grantee view)

| Case | Included in grantee net worth? |
|---|---|
| Joint account, no exclusion row | yes (default) |
| Joint account, grantee exclusion row present | no |
| Joint account with owner's `exclude_from_net_worth = true` | yes -- the owner flag governs the owner's view only |
| Plain (non-joint) granted account | no -- never natively aggregated |
| Joint account whose currency has no FX rate to the grantee's default | identical to an own account in that currency: the existing net-worth conversion (`convertWithRateLookup` with its documented raw-amount fallback) applies unchanged. Joint rows introduce no new missing-data path, and changing the shared fallback would alter same-owner behavior, which the governing invariant forbids |

Owner's net worth is unchanged in every case. `monthly_account_balances` rows for a joint account
are owner-maintained; when a grantee read finds the current month missing or stale the service
refreshes it under `withUserContext(ownerUserId)` so both users see the same series.

## Revoke / re-grant state machine

States per (account, grantee): `NOT_SHARED` -> `SHARED_PLAIN` (grant, `is_joint=false`) ->
`SHARED_JOINT` (grant, `is_joint=true`); revoke (delegation revoked or grant row deleted) returns
to `NOT_SHARED`.

On leaving `SHARED_JOINT`:
- The account disappears from the grantee's list, register, reports and net worth on the next
  read (no residue, no tombstones).
- Existing cross-owner transfer legs between the grantee's own accounts and the joint account are
  **frozen, never severed** -- exactly the merged cross-owner behavior: counterpart masked as
  "Hidden account", structural edits rejected with `errors.transactions.crossOwnerTransferLocked`,
  own-leg delete detaches the counterpart.
- Rows the grantee created in the joint account remain in the owner's ledger untouched (they are
  owner rows).

On re-entering `SHARED_JOINT` (re-grant with the joint flag re-ticked): everything above reverses
automatically with **no writes in between** -- transfers reconnect, masking lifts, the account
reappears. The joint flag itself is not auto-restored by a plain re-share; the owner re-ticks it.

## Adversarial test matrix (from `docs/testing-contract.md`)

- **Ownership:** grantee create writes `user_id = owner`; grantee submitting their own
  `categoryId` is refused with no partial write; account-object mutations (rename, close, delete)
  by the grantee 404; a plain (non-joint) grant never reaches the union list or register.
- **Concurrency:** revoke racing a grantee write -> the write is refused and no row or balance
  change lands; `setGrants` delete-and-recreate round-trips `is_joint`.
- **Money:** grantee create/delete moves the owner's balance atomically with the row; refused
  operations leave balances byte-identical; joint balances convert with `roundFxRate` rates, and a
  missing rate nulls the total rather than dropping the account.
- **Dates:** net-worth series boundaries computed under `TZ=UTC` fixtures.
- **Existence:** every joint-path failure for a non-granted account is 404-shaped -- never
  confirm existence.

## Explicit v1 scope cuts

Non-banking joint types read-only; no grantee tags/splits/attachments on joint rows; attachments,
scheduled transactions and holdings on joint accounts not natively visible; no native category
creation; built-in/custom reports and **all AI Assistant + MCP tools** exclude joint rows (the two
AI layers change together or not at all -- "not at all" in v1); investment breakdowns exclude
joint INVESTMENT accounts (the plain net-worth total includes them); grantee CSV/QIF export
deferred; the joint toggle is offered only for delegates who are full Monize accounts
(`isFullAccount`), never owner-managed credential identities.

The account-scoped transaction analytics -- `GET /transactions/summary`, `/grouped-totals` and
`/monthly-totals` -- were a v1 cut and are no longer: they take the same own-context joint scope
as the register (see B4), because a joint account's detail page draws its cash-flow, top-categories
and top-payees panels from them and rendered all three empty beside a populated balance chart.
`/transactions/tag-key-breakdown` stays owner-only on purpose -- tags are personal, and a joint row
never carries the grantee's.

## Follow-ups

None.
