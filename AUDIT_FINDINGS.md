# Monize Code Audit Findings

**Date:** 2026-02-26
**Scope:** Full backend + frontend audit (25 controllers, 43 services, 30 entities, 70+ DTOs)

## Executive Summary

| Severity | Count | Areas |
|----------|-------|-------|
| **Critical** | 5 | Race conditions in financial operations, cross-user data leak |
| **High** | 5 | More race conditions in transactions/holdings |
| **Medium** | 8 | N+1 queries, missing indexes |
| **Low** | 18+ | Missing ORM relations, minor N+1s, client-side validation gap |

---

## CRITICAL Findings

### 1. Cross-User Data Leakage in Split Counting

- **File:** `backend/src/categories/categories.service.ts`, line 305
- **Severity:** CRITICAL

The split count query does **not** filter by `userId`:

```typescript
// Line 305 - BUG: counts splits from ALL users
this.splitsRepository.count({ where: { categoryId } }),

// Compared to line 304 - CORRECT: filtered by userId
this.transactionsRepository.count({ where: { userId, categoryId } }),
```

The `transaction_splits` table has no `userId` column, so this counts every user's splits for that category. If default categories share IDs across users, one user sees inflated counts from other users' data.

**Fix:** Join through the transaction table:
```typescript
this.splitsRepository
  .createQueryBuilder('split')
  .innerJoin('split.transaction', 'transaction')
  .where('split.categoryId = :categoryId', { categoryId })
  .andWhere('transaction.userId = :userId', { userId })
  .getCount()
```

---

### 2. Race Condition: Transfer Create (6 unwrapped DB writes)

- **File:** `backend/src/transactions/transaction-transfer.service.ts`, lines 41-143
- **Severity:** CRITICAL

Creates two linked transactions, cross-links them via `linkedTransactionId`, then updates both account balances -- six database operations with no transaction wrapper. If the process fails after debiting the source but before crediting the destination, the user has a one-sided transfer with money "lost."

**Fix:** Wrap in a `QueryRunner` transaction. All 6 operations must succeed or none should.

---

### 3. Race Condition: Transfer Update (reverse-then-apply without transaction)

- **File:** `backend/src/transactions/transaction-transfer.service.ts`, lines 312-453
- **Severity:** CRITICAL

Reverses old balance effects on both accounts, updates both transactions, applies new effects. A crash between reversal and re-application leaves both account balances incorrect.

**Fix:** Wrap in `QueryRunner` transaction.

---

### 4. Race Condition: Investment Transaction Create (4+ tables)

- **File:** `backend/src/securities/investment-transactions.service.ts`, lines 193-258
- **Severity:** CRITICAL

Creates an investment transaction, updates/creates holdings, creates a cash-side transaction, updates funding account balance -- all without a transaction. Partial failure leaves phantom holdings with no corresponding cash movement.

**Fix:** Wrap in `QueryRunner` transaction.

---

### 5. Race Condition: Investment Transaction Update (reverse + re-apply)

- **File:** `backend/src/securities/investment-transactions.service.ts`, lines 554-604
- **Severity:** CRITICAL

Reverses old effects then applies new effects across holdings, cash transactions, and balances. The non-atomic reverse-then-apply pattern can leave the database with reversed-but-not-reapplied data.

**Fix:** Wrap in `QueryRunner` transaction.

---

## HIGH Findings

### 6. Race Condition: Investment Transaction Delete

- **File:** `backend/src/securities/investment-transactions.service.ts`, lines 727-739
- **Severity:** HIGH

Reverses effects then deletes the record. If delete fails after reversal, no record exists but effects are already undone.

**Fix:** Wrap in `QueryRunner` transaction.

---

### 7. Race Condition: Transfer Delete

- **File:** `backend/src/transactions/transaction-transfer.service.ts`, lines 164-231
- **Severity:** HIGH

Reverses balances on both accounts then removes both transactions. Partial failure leaves one account corrected and the other wrong.

**Fix:** Wrap in `QueryRunner` transaction.

---

### 8. Race Condition: Holdings Rebuild

- **File:** `backend/src/securities/holdings.service.ts`, lines 212-353
- **Severity:** HIGH

Deletes ALL holdings then rebuilds from history. If rebuild fails midway, all holdings data is gone until retry.

**Fix:** Wrap in `QueryRunner` transaction.

---

### 9. Race Condition: Transaction Create with Splits

- **File:** `backend/src/transactions/transactions.service.ts`, lines 104-186
- **Severity:** HIGH

Creates transaction, creates splits, updates balance -- not wrapped in a transaction.

**Fix:** Wrap in `QueryRunner` transaction.

---

### 10. Race Condition: Split Creation Loop

- **File:** `backend/src/transactions/transaction-split.service.ts`, lines 74-153
- **Severity:** HIGH

Each split saved individually in a loop. Transfer-type splits create linked transactions per iteration. Failure midway leaves orphaned splits and incorrect balances.

**Fix:** Wrap in `QueryRunner` transaction.

---

## MEDIUM Findings

### 11. ~~N+1: Holdings Rebuild -- Individual Saves~~ FIXED

- **File:** `backend/src/securities/holdings.service.ts`
- **Severity:** MEDIUM
- **Status:** FIXED -- Collected into array, single batch `holdingsRepo.save(holdingsToCreate)`.

---

### 12. ~~N+1: Split Creation -- Per-Split Saves~~ FIXED

- **File:** `backend/src/transactions/transaction-split.service.ts`
- **Severity:** MEDIUM
- **Status:** FIXED -- Regular (non-transfer) splits batch-saved in one call. Transfer splits remain individual (require linked transaction creation).

---

### 13. ~~N+1: Investment Transaction Account Resolution~~ FIXED

- **File:** `backend/src/securities/investment-transactions.service.ts`
- **Severity:** MEDIUM
- **Status:** FIXED -- Replaced per-account `findOne()` loop with batch `accountsService.findByIds(userId, accountIds)`.

---

### 14. ~~N+1: Import Validation -- Per-Entity Lookups~~ FIXED

- **File:** `backend/src/import/import.service.ts`
- **Severity:** MEDIUM
- **Status:** FIXED -- Replaced per-entity `findOne` with batch `find({ where: { id: In(ids) } })` for accounts, categories, and securities.

---

### 15. ~~N+1: Delete Transfer Split Linked Transactions~~ FIXED

- **File:** `backend/src/transactions/transaction-split.service.ts`
- **Severity:** MEDIUM
- **Status:** FIXED -- Replaced per-split `findOne` with batch `find({ where: { id: In(linkedTxIds) } })`.

---

### 16. ~~Missing Index: investment_transactions.transaction_id~~ FIXED

- **File:** `database/schema.sql`
- **Severity:** MEDIUM
- **Status:** FIXED -- Added `idx_investment_transactions_transaction` index. Migration: `019_add_missing_indexes.sql`.

---

### 17. ~~Missing Index: scheduled_transaction_overrides.original_date~~ FIXED

- **File:** `database/schema.sql`
- **Severity:** MEDIUM
- **Status:** FIXED -- Added composite `idx_sched_txn_overrides_orig(scheduled_transaction_id, original_date)` index. Migration: `019_add_missing_indexes.sql`.

---

### 18. ~~Race Condition: Investment Account Pair Creation~~ FIXED

- **File:** `backend/src/accounts/accounts.service.ts`
- **Severity:** MEDIUM
- **Status:** FIXED -- Wrapped in `QueryRunner` transaction with commit/rollback/release.

---

## LOW Findings

### 19. N+1: Brokerage Balance Reset

- **File:** `backend/src/accounts/accounts.service.ts`, lines 737-752
- **Severity:** LOW

Individual saves per account.

**Fix:** Single `UPDATE accounts SET balance = 0 WHERE account_type = 'INVESTMENT' AND account_sub_type = 'INVESTMENT_BROKERAGE' AND user_id = :userId`.

---

### 20. N+1: Scheduled Transaction Auto-Post

- **File:** `backend/src/scheduled-transactions/scheduled-transactions.service.ts`, lines 88-102
- **Severity:** LOW

Individual processing per due transaction. Hard to fully batch due to different accounts/amounts/splits per posting.

**Fix:** Wrap in a single `QueryRunner` transaction for atomicity. Individual inserts may remain.

---

### 21. N+1: Per-Account Balance Recalculation

- **File:** `backend/src/accounts/accounts.service.ts`, lines 857-876
- **Severity:** LOW

Individual aggregate query per account.

**Fix:** Single SQL with `GROUP BY account_id`.

---

### 22. Missing FK Relations on 13 Entities

DB-level FK constraints exist, so this is a code consistency issue, not a security one.

| Entity | File | userId Line |
|--------|------|-------------|
| Transaction | `backend/src/transactions/entities/transaction.entity.ts` | 29 |
| Account | `backend/src/accounts/entities/account.entity.ts` | 217 |
| Category | `backend/src/categories/entities/category.entity.ts` | 17 |
| Payee | `backend/src/payees/entities/payee.entity.ts` | 22 |
| ScheduledTransaction | `backend/src/scheduled-transactions/entities/scheduled-transaction.entity.ts` | 33 |
| InvestmentTransaction | `backend/src/securities/entities/investment-transaction.entity.ts` | 37 |
| MonthlyAccountBalance | `backend/src/net-worth/entities/monthly-account-balance.entity.ts` | 20 |
| Budget | `backend/src/budgets/entities/budget.entity.ts` | 62 |
| BudgetAlert | `backend/src/budgets/entities/budget-alert.entity.ts` | 49 |
| CustomReport | `backend/src/reports/entities/custom-report.entity.ts` | 112 |
| AiProviderConfig | `backend/src/ai/entities/ai-provider-config.entity.ts` | 23 |
| AiUsageLog | `backend/src/ai/entities/ai-usage-log.entity.ts` | 14 |
| AiInsight | `backend/src/ai/entities/ai-insight.entity.ts` | 29 |

**Fix:** Add `@ManyToOne(() => User)` + `@JoinColumn({ name: 'user_id' })` to each entity.

---

### 23. @Exclude() Without ClassSerializerInterceptor

- **File:** `backend/src/users/entities/user.entity.ts`
- **Severity:** LOW

`@Exclude()` decorators exist on sensitive fields (`passwordHash`, `resetToken`, `resetTokenExpiry`, `twoFactorSecret`) but `ClassSerializerInterceptor` is not registered globally. Not a vulnerability because all code manually sanitizes User objects, but the decorators give a false sense of security.

**Fix:** Either register `ClassSerializerInterceptor` globally for defense-in-depth, or remove the `@Exclude()` decorators.

---

### 24. ProfileSection Missing Client-Side Validation

- **File:** `frontend/src/components/settings/ProfileSection.tsx`
- **Severity:** LOW

Uses `useState` instead of Zod/react-hook-form. No client-side email format or length validation. Backend DTOs catch everything, so this is a UX gap not a security issue.

**Fix:** Migrate to Zod + react-hook-form pattern consistent with other forms.

---

## Verified Clean Areas

| Area | Status | Notes |
|------|--------|-------|
| Auth Guards | All 25 controllers covered | Class-level `@UseGuards(AuthGuard('jwt'))` everywhere |
| IDOR Prevention | All services use `req.user.id` | No user-controlled ID for data access |
| SQL Injection | Zero vectors found | All 43 services use parameterized queries |
| XSS | Zero vectors | No `dangerouslySetInnerHTML`, no `eval()` |
| Token Storage | httpOnly cookies only | localStorage stores only `isAuthenticated` boolean |
| CSRF | Double-submit cookie pattern | Timing-safe comparison |
| Rate Limiting | Global + per-endpoint | Login: 5/15min, Register: 5/15min |
| Input Validation | 70+ DTOs with full coverage | `whitelist: true`, `forbidNonWhitelisted: true` |
| Security Headers | Helmet fully configured | CSP, HSTS, CORP, COOP, X-Frame-Options |
| Dependencies | 0 npm audit vulnerabilities | Both frontend and backend clean |
| Secrets | All externalized to env vars | No hardcoded secrets in source |

---

## Recommended Fix Priority

1. **Cross-user data leak** (#1) -- One-line fix, correctness bug
2. **Transfer race conditions** (#2, #3, #7) -- Highest real-world financial impact
3. **Investment transaction race conditions** (#4, #5, #6) -- Financial integrity across 4 tables
4. **Transaction/split race conditions** (#9, #10) -- Financial integrity
5. **Holdings rebuild** (#8) -- Data loss window during rebuild
6. **Missing indexes** (#16, #17) -- Performance on every page load
7. **N+1 queries** (#11-15) -- Performance under load
8. **Everything else** -- Code quality improvements
