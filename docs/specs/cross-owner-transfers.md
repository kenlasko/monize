# Plan: Cross-Owner Transfers (delegate's own account <-> account shared with them)

This design shipped: every task of its task list was completed on branch
`claude/cross-owner-transfers-5ig0bn` and the feature is in release 1.14.0
(`docs/release-notes/1.14.0.md`). The plan is retired and this document is
kept as the specification the code is held to.

## Goal

Let a delegate move money between an account they **own** and an account **shared with them** via Shared Access. Today: Person A grants Person B full access to Account A; Person B cannot transfer funds from their own Account B to Account A. This plan makes that possible, from either context (B acting as A, or B in their own context), gated on B holding the matching write grant (`can_create` / `can_edit` / `can_delete`) on the shared account.

It also defines what happens when A **unshares** (revokes B's access) -- each user keeps their own transfer leg, with no leak of the other user's live account details -- and when A **reshares** later: existing cross-owner transfers **re-connect automatically**, with zero migration or repair.

**Governing invariant: same-owner transfers behave byte-identically after this change.** Every new behavior is gated on "the two legs (or two accounts) have different owners."

---

## Why this is impossible today (current state)

| Fact | Source | Consequence |
|------|--------|-------------|
| Sharing is *delegation*: a delegate acts **as** the owner. An acting JWT resolves to `{ id: ownerUserId, realUserId: delegateId, isActing, delegationId }` | `backend/src/auth/strategies/jwt.strategy.ts:98-118` | While acting, every `where: { userId }` query is owner-scoped, so B's own accounts are invisible. |
| Per-account permissions are boolean grants `can_read` / `can_create` / `can_edit` / `can_delete` on `account_delegate_grants` (row exists only when READ is granted) | `database/schema.sql` (account_delegates block), `backend/src/delegation/delegation.service.ts` (`setGrants`, `hasAccountPermission`) | The permission model we need already exists; it just never applies to accounts the *delegate* owns. |
| A transfer is two paired `transactions` rows cross-linked via `linked_transaction_id` (mutual pointers, `ON DELETE SET NULL`); **both legs always share one `user_id`** | `database/schema.sql` (transactions), `backend/src/transactions/transaction-transfer.service.ts` (`createTransfer`) | No cross-owner concept exists in the data model. |
| Every transfer path validates both accounts with `accountsService.findOne(userId, ...)` (404 if not owned by the effective user) | `transaction-transfer.service.ts` (`createTransfer`, `updateTransfer`), `transaction-split.service.ts`, `scheduled-transactions.service.ts` | B in own context naming Account A as destination gets a 404. |
| The globally-registered delegate guard requires the delegate to hold the operation grant on **both** legs of a transfer | `backend/src/delegation/guards/account-delegate.guard.ts` (`DELEGATED_TRANSFER_BODY_KEY` / `DELEGATED_TRANSFER_PARAM_KEY` blocks) | B acting as A naming their own Account B gets a 403 (no grant row exists for an account the owner does not own). |
| Non-acting tokens bypass the delegate guard entirely (`return true` before any decorator check) | `account-delegate.guard.ts` (early return for tokens without `actingAsUserId`) | Own-context requests never reach the guard, so cross-owner authorization **cannot** live in the guard alone. |
| Transfer counterpart masking already exists for delegates: the interceptor rewrites the linked leg's account to `"Hidden account"` and fixes the auto payee tail | `backend/src/delegation/interceptors/delegate-transfer-mask.interceptor.ts`; frontend `TransferTransactionFields.tsx` (`hiddenAccountOption`) | The exact UX we need for the "unshared" state is already built -- it just only runs for acting delegates today. |
| Revoke hard-deletes the delegation row (FK cascades remove grants + delegation-scoped refresh tokens) and *may* delete the delegate user entirely -- but only when the delegate owns zero accounts | `delegation.service.ts` (`revokeDelegate`) | Safe for this plan: a cross-owner transfer requires the delegate to own an account, so a delegate with cross-owner legs is never hard-deleted by revoke. Regression test, no code change. |

---

## Design: four pillars

### 1. Per-leg ownership

Each leg's `user_id` = **its account's owner** (the leg in Account A carries `user_id = A`; the leg in Account B carries `user_id = B`), still cross-linked via the existing `linked_transaction_id`. Each user's ledger stays self-contained: balances, net worth, reports, and exports all keep aggregating only rows the user owns. Unshare requires no data surgery.

**No new columns.** Connected/frozen state is computed per-request from *current* grants -- that is precisely what makes reshare free -- and the counterpart's owner is already stored on the linked row (`transactions.user_id`). A denormalized `counterpart_user_id` / `is_external` marker was considered and rejected: it duplicates what the linked row states and would need maintenance on the (blocked, see below) account-move path.

### 2. Authorization keyed by the REAL user, uniformly

The rule for any create/edit/delete touching a transfer: for **each** leg's account, the real user (`req.user.realUserId`) must either **own** the account or hold an **active delegation from that account's owner with the matching grant** (`can_create` / `can_edit` / `can_delete`; read implied). One rule, three situations:

- Normal user: `realUserId === userId`, reduces to today's ownership check. Foreign account -> 404. **No behavior change.**
- B in own context with a foreign `toAccountId`: the new path.
- B acting as A with B's own account as one leg: ownership of the leg satisfies the rule.

Because own-context requests bypass the delegate guard, the **authoritative check lives in the service layer** (a new `CrossOwnerAccessService`); the guard is retained as defense-in-depth for acting tokens and is only *relaxed* (an account owned by the real user passes without a grant row) -- and only in the transfer/scheduled-transfer decorator blocks. `@DelegatedAccountParam` / `@DelegatedTransactionParam` must **not** be relaxed: a plain `POST /transactions` while acting writes `userId = owner`, so letting a delegate target their own account there would create A-owned rows inside B's account.

### 3. Unshare = frozen link, never severed

`linked_transaction_id` stays intact on revoke. All protection is:

- **Read-time masking** (existing "Hidden account" pattern) whenever the real user lacks READ on the counterpart leg's account.
- **Write-time gating** computed from current grants (see behavior spec below).

Reshare then reconnects automatically: `createDelegate` re-activates a pre-existing delegation row and `setGrants` re-inserts grant rows; the moment the grant exists again, the same per-request checks that froze the transfer now pass. Zero migration, zero repair job, and the integration suite must prove it: after unshare -> reshare **with no writes in between**, a full cross-leg edit works again.

### 4. Same-owner behavior is untouched

Every branch added by this plan is entered only when the two accounts (or two legs) have different owners. The existing single-owner code path -- including its transaction shape, balance math, action history, and tag sync -- stays byte-identical.

---

## Sync semantics while connected (cross-owner legs only)

| Field | Same-owner (unchanged) | Cross-owner |
|---|---|---|
| date, amount / toAmount / exchangeRate | mirrored | mirrored |
| description, referenceNumber | mirrored | mirrored |
| auto payeeName ("Transfer to/from X") | resolved at read time from the linked leg's account (issue #1214); a legacy stamped value is cleared on edit, never regenerated | same -- the mask already rewrites the linked account's name for a reader without READ, so the resolved label masks with it |
| categoryId | mirrored | **effective-user legs only** -- categories are per-user reference data; writing A's category id onto B's row is an ownership violation |
| payeeId | mirrored | **effective-user legs only** (payees are per-user) |
| tagIds | mirrored (service wrappers) | **effective-user legs only** -- the wrappers in `transactions.service.ts` and the bulk path currently write tag ids onto both legs; on a foreign leg that attaches one user's tag ids to another user's transaction |
| status / reconciled | mirrored | **not mirrored** -- reconciliation is per-ledger; mirroring would let B flip A's reconciliation state |

## Frozen-link behavior spec (real user lacks READ on the counterpart account)

- **Reads**: counterpart masked -- `linkedTransaction.account` replaced with the `{ id, name: "Hidden account" }` stub, auto payee tail rewritten. Applies to list reads, `findOne`, `GET /transactions/:id/linked`, CSV export, and AI/MCP reads.
- **`PATCH /transactions/:id/transfer`**: presentational own-leg fields allowed (description, reference, status, category, payee, tags -- no mirroring); amount / date / account-move rejected with new i18n error `errors.transactions.crossOwnerTransferLocked` (modeled on the split-leg lock). Rationale: unmirrored amount/date edits would silently break the two-ledger agreement that makes the pair a transfer.
- **`DELETE /transactions/:id/transfer`** (and `removeAny`, which the generic `DELETE /transactions/:id` now calls, so that route behaves as this one: same grants, no history entry, INV-TRANSFER-001): deletes the **own leg only**, reverses only the own account's balance; the FK `SET NULL` detaches the counterpart, which survives as a one-sided transfer (the same shape today's account-delete orphans have). A deleted leg correctly does not reconnect on reshare.
- Connected but missing the required op grant (e.g. read but not edit): 403 via the existing `errors.delegation.accountOperationNotGranted`. Accounts with no read grant get 404-shaped behavior -- never confirm existence.
- **Account moves on cross-owner transfers are rejected in v1** (like split-transfer legs): moving a leg between owners changes `user_id` semantics and is not worth the complexity.

---

## Implementation phases

### Phase 1 -- Access foundation (delegation module)

New **`backend/src/delegation/cross-owner-access.service.ts`** (`delegation.service.ts` is at the line-count cap; the new service uses `withScopedDb`, with cross-tenant owner lookups -- reading another owner's `accounts` row to learn its owner -- wrapped in `withSystemContext` from `backend/src/common/db/with-context.ts`, documented as authorization-decision reads; importing `with-context` requires adding the file to `WITH_CONTEXT_ALLOWLIST` in `backend/eslint.config.mjs` in the same PR, per RLS lint ban L1):

- `accountAccessFor(realUserId, accountId, op)` -> `{ account, ownerUserId, via: 'own' | 'delegation' }`; throws NotFound (no read / nonexistent) or Forbidden (read but not op).
- `readableAccountIdSetFor(realUserId)` -> own account ids + `can_read`-granted ids across **all** active delegations. One definition serves masking in both contexts (acting-as-A, B still legitimately sees B's own counterpart).
- `isAccountOwnedBy(accountId, userId)`.
- `transferCandidatesFor(realUserId, effectiveUserId)` (Phase 4).

**Guard relaxation** (`account-delegate.guard.ts`): in the transfer-body, transfer-param, and scheduled-write blocks **only**, skip `assertPermission` for an account owned by `payload.sub` (the real user).

**Actor plumbing**: the four transfer endpoints in `transactions.controller.ts` pass an actor `{ effectiveUserId: req.user.id, realUserId: req.user.realUserId }` through the `TransactionsService` wrappers into `TransactionTransferService`. Non-HTTP callers (scheduled posting, AI prep) pass both = `userId` -- identical to today. The actor parameter is optional-with-default so same-owner call sites are untouched.

### Phase 2 -- Transfer service core (`transaction-transfer.service.ts`)

- `createTransfer`: replace the two `accountsService.findOne(userId, ...)` calls with `accountAccessFor(realUserId, ..., 'create')`; create each leg with `userId: account.userId`. When owners differ: run the atomic block under `withSystemContext(() => withScopedDb(...))` (no-op at `RLS_MODE=off`; correct under enforce since the WITH CHECK stays owner-only, Phase 5); apply categoryId/payeeId/tags to effective-user legs only; `triggerNetWorthRecalc` per leg with **that leg's owner id**; **action history per owner** -- one record for each leg owner, and the *counterpart owner's* entry uses an i18n "Shared account" label instead of the foreign account name (A must not learn B's account name from history; the actor's own entry may name both, since the actor could read both at that moment). Same-owner path keeps producing exactly today's single record.
- **Counterpart loading**: `updateTransfer` / `removeTransfer` / `getLinkedTransaction` / `previewUpdateTransfer` load the linked leg via the bound `findOne(userId, id)`, which 404s cross-owner. Add a second callback `loadLegById(id)` provided by `TransactionsService` -- loads by id without a user filter under `withSystemContext`, relations `["account"]` -- used **only** when the scoped `findOne` misses; the service then decides access via `accountAccessFor(realUserId, linked.accountId, op)` and routes to connected / frozen / forbidden behavior per the spec above.
- Wrappers (`transactions.service.ts` createTransfer/updateTransfer): skip `setTransactionTags` for any leg whose `userId !== effectiveUserId`.
- **Bulk update** (`transaction-bulk-update.service.ts`): `syncLinkedTransfers` is already user-filtered and silently skips foreign counterparts -- good; `syncTransferTags` passes counterpart ids to `setTransactionTagsBulk` with no user filter -- filter linked ids to same-user legs in `classifyTransferLegs`.
- **AI/MCP** (`backend/src/transactions/transaction-tool-prep.service.ts`): creation already 404s on foreign accounts -- stays blocked. Add explicit detection in preview-update/delete of an existing cross-owner transfer -> clear i18n error ("cross-owner transfers can't be edited by the assistant yet"). One change in the shared prep service covers both the AI executor and MCP, per the shared-AI-tools rule in `CLAUDE.md`.
- **Scope cuts** (assert with tests, don't build): cross-owner split transfers, cross-owner scheduled transfers, and imports all naturally 404 via owner-scoped `findOne`; bulk edits skip cross-owner legs.

### Phase 3 -- Read-path masking (the leak audit)

Extract the mask logic from `delegate-transfer-mask.interceptor.ts` into a shared helper `backend/src/delegation/transfer-mask.util.ts` (`maskTransactionsAgainst(readableSet, payload)`), then cover:

1. **Interceptor generalized**: runs for any authenticated user, not just `isActing`. The fast path is load-bearing: scan the payload first; hit `readableAccountIdSetFor(realUserId)` only when acting OR some row has `isTransfer && linkedTransaction && linkedTransaction.userId !== row.userId`. This covers `findOne` (whose eager `linkedTransaction.account` relation is a full Account load including **balance** -- the worst leak) and `findAll`, since the interceptor is class-wide on `TransactionsController`.
2. **`GET /transactions/:id/linked`**: a connected cross-owner counterpart is returned via `loadLegById` (today it 404s -> null); unreadable -> `null`; the interceptor masks the body.
3. **CSV export** (`backend/src/accounts/account-export.service.ts`): the `linkedTransaction.account` join is unfiltered, so `transferAccountName` would leak post-unshare; apply the mask helper in the service (the response shape bypasses the interceptor) and rewrite exported auto payee names.
4. **AI/MCP reads**: apply the mask helper in the shared read/prep path (MCP responses bypass the HTTP interceptor).
5. **Verified non-issues**: balance / net-worth endpoints aggregate own accounts only (per-leg ownership makes this correct by construction); `accountIdsForTransfer` is an unscoped guard helper by design and keeps working cross-owner.
6. **Accepted non-goal** (state in the PR): strings captured *while shared* -- stored auto payee names on the actor's own legs, action-history text in the actor's own history -- are point-in-time data the user legitimately saw, like a received email. Masking protects **live** details (renames, balance, institution). Reports grouping by stored `payee_name` may therefore still show the old name post-unshare.

### Phase 4 -- Transfer-candidates endpoint + frontend

- **`GET /accounts/transfer-candidates`** (`@AllowDelegate`, on `AccountsController`): own context -> accounts shared **to** the real user (active delegations, `can_read`) as `{ id, name, currencyCode, accountType, accountSubType, isClosed, ownerLabel, canCreate, canEdit, canDelete }`; acting context -> the real user's **own** accounts (flags all true). This is the first time per-account write-grant info reaches the frontend -- deliberately scoped to this endpoint, not a fix of the wider read-only-delegate-sees-write-affordances gap.
- Frontend: API + types in `frontend/src/lib/accounts.ts`; `TransactionForm.tsx` fetches the candidates alongside `accountsApi.getAll(true)`; `TransferTransactionFields.tsx` appends to both Selects a disabled `__separator__` row (existing pattern in `buildAccountDropdownOptions`, `frontend/src/lib/account-utils.ts`) + a disabled group label ("Shared with you" / "Your accounts") + candidates filtered by `canCreate` (create) / `canEdit` (edit), labeled `name (CUR) -- ownerLabel`. When the counterpart resolves to the existing `hiddenAccountOption`, disable From/To/Amount/Date so the frozen lock is visible before the backend rejects. All strings via `useTranslations`, English catalogs only during development, then `npm run i18n:pseudo`.

### Phase 5 -- Migration (delegate-read policy arm on `transactions`)

No table/column changes. RLS is fully implemented: every policy ships enabled (`123_rls_enable.sql` on migrated databases, the dynamic enable loop at the bottom of `schema.sql` on fresh installs), and `transactions` currently carries the uniform owner-only policy from the direct-ownership `DO` loop. Under `RLS_MODE=enforce` that policy makes the delegate's eager `linkedTransaction` join on a connected transfer silently return null, and every counterpart read this plan adds would see zero rows -- so the delegate-read arm below is a hard dependency of Phases 2-3, not optional prep (next free migration number; `123_rls_enable.sql` was the max when this was written -- **verify with `ls database/migrations` and renumber**, keeping the numeric prefix unique):

- Move `transactions` out of the direct-ownership policy loop in `database/schema.sql` into a dedicated policy:

```sql
DROP POLICY IF EXISTS transactions_isolation ON transactions;
CREATE POLICY transactions_isolation ON transactions
  USING (user_id = (SELECT app_current_user_id())
      OR (SELECT app_bypass_rls())
      OR EXISTS (SELECT 1 FROM account_delegate_grants g
                 JOIN account_delegates d ON d.id = g.delegation_id
                 WHERE g.account_id = transactions.account_id
                   AND g.can_read AND d.status = 'active'
                   AND d.delegate_user_id = (SELECT app_real_user_id())))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
```

  **WITH CHECK stays owner-only**: cross-owner *writes* (inserting the foreign leg, updating the foreign balance) run under the narrow `withSystemContext` after in-code authorization -- safer than write-widening policies on `accounts` / `transactions`.
- `CREATE INDEX IF NOT EXISTS idx_adg_account ON account_delegate_grants(account_id);` (only `delegation_id` is indexed today; the policy arm and the access service probe by account).
- **Ship an (idempotent, no-op) `ALTER TABLE transactions ENABLE ROW LEVEL SECURITY`**: `transactions` is already enabled everywhere (see above), but the post-`123` "ship your own ENABLE" convention applies to *every* post-`123` policy migration, and the T1 harness (`rls-harness.integration.spec.ts`) enforces it mechanically by deriving the expectation from the migration files on disk.
- **Deploy impact**: behavior-neutral at `RLS_MODE=off`/`shadow` (the app connects as the table owner, so policies are not consulted); on an enforcing deployment the read arm is live on deploy. That is read-only widening gated on an active `can_read` grant -- exactly the access the delegation feature already grants at the app layer -- and it also fixes the pre-existing enforce-mode gap where an acting delegate's `linkedTransaction` join returned null.
- **Update `backend/test/integration/rls-enforcement.integration.spec.ts` in the same PR**: its per-table sweep asserts exact per-user visibility and its delegation-semantics block asserts the delegate's own session sees none of the owner's data -- both must learn the new arm (positive case: an active `can_read` grant exposes the granted account's transactions to the delegate's own session; negative case: an absent or revoked grant hides them). The integration harness itself needs no registration: T1's content-based selector picks up any migration referencing the policy helper functions.
- Idempotent per the CI gates; mirror into `database/schema.sql` in the same PR (moving `transactions` out of the direct-ownership `DO` loop there); verify with `npm run migration:lint` and `scripts/verify-schema.sh`.

### Phase 6 -- Tests & i18n

The per-task test matrix lived in the retired task list. Highlights:

- Integration must prove the reshare-reconnect is **stateless**: share -> transfer -> unshare -> verify masking + frozen lock -> reshare -> full cross-leg edit works with no writes in between.
- Guard spec must prove the own-account bypass applies to transfer decorators only (`@DelegatedAccountParam` still blocks).
- Frontend unit + one e2e journey in `e2e/tests/delegation.spec.ts`.
- i18n: English catalogs during development; full-locale pass as the final acceptance commit.

---

## Hairy parts (implementer beware)

1. **The mask interceptor now sits in every transactions response.** The no-DB-hit fast path is load-bearing; without it every list request pays a grants query.
2. **The `withSystemContext` bypass windows in mutations.** Authorization must be fully decided *before* entering; nothing user-controlled may select rows inside beyond the already-validated leg ids.
3. **Guard relaxation scope creep** -- transfer decorators only, or acting delegates can write owner-attributed rows into their own accounts.
4. **Foreign-leg reference-data writes** exist in three places (create wrapper, update wrapper, bulk tags) -- each missed one is a cross-tenant leak.
5. **Actor-signature ripple** through scheduled posting, AI prep, MCP is wide but mechanical; optional-with-default keeps same-owner call sites untouched.
6. Verify during implementation that plain `PATCH /transactions/:id` does no linked-leg sync (the frontend routes transfer edits to `/transfer`; AI previews block transfers) -- if any sync exists, it needs the same cross-owner gating.

## Verification (end-to-end)

1. `cd backend && npm run lint && TZ=UTC npm run test:unit` (lint bans `@InjectRepository` / `createQueryRunner` outright and restricts `common/db/with-context` imports to `WITH_CONTEXT_ALLOWLIST` -- the new service uses `withScopedDb` and its allowlist entry lands in the same PR).
2. `npm run migration:lint` + `scripts/verify-schema.sh`.
3. `TZ=UTC npm run test:e2e` (backend integration suite).
4. Frontend: `npm run test` (Vitest incl. the ui-conventions guard), `npm run i18n:check`.
5. Playwright: `npx playwright test e2e/tests/delegation.spec.ts` (single spec file is safe without `--workers=1`).
6. Manual, two users in dev compose: A shares with B (create+edit grants); B transfers B -> A from their own context; both balances correct, A sees their leg; A revokes; B sees "Hidden account" and the frozen lock; A re-shares; B edits the amount and both legs update.

## Critical files

- `backend/src/transactions/transaction-transfer.service.ts` (core)
- `backend/src/transactions/transactions.service.ts`, `transactions.controller.ts`, `transaction-bulk-update.service.ts`
- `backend/src/delegation/cross-owner-access.service.ts` (new), `guards/account-delegate.guard.ts`, `interceptors/delegate-transfer-mask.interceptor.ts`, `transfer-mask.util.ts` (new)
- `backend/src/accounts/accounts.controller.ts`, `account-export.service.ts`
- `backend/src/transactions/transaction-tool-prep.service.ts`
- `frontend/src/components/transactions/TransferTransactionFields.tsx`, `TransactionForm.tsx`, `frontend/src/lib/accounts.ts`
- `database/migrations/` (next free number), `database/schema.sql`

## Follow-ups

None.
