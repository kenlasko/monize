# Monize Backend -- Full Code Review

**Date:** 2026-02-27
**Scope:** Full backend review -- all ~50K lines across 170+ source files (25 controllers, 43 services, 30 entities, 70+ DTOs)
**Reviewer:** Claude Opus 4.6

## Executive Summary

| Severity | Count | Primary Themes |
|----------|-------|----------------|
| **Critical** | 9 | Missing transaction wrapping on writes (4), floating-point money math (1), SSE resource leak (1), SSRF bypass (1), data integrity (1), auth race (1) |
| **High** | 18 | More missing atomicity (4), auth vulnerabilities (4), financial logic bugs (3), external API issues (2), MCP (1), email injection (1), category integrity (1), timezone (1), no-op code (1) |
| **Medium** | 30 | DTO validation gaps, IDOR, LIKE injection, timezone issues, N+1 patterns, non-atomic operations |
| **Low** | 25+ | N+1 queries, code duplication, naming, precision inconsistencies, error codes |

**Systemic pattern:** `create()` and `createTransfer()` correctly use QueryRunner transactions, but virtually every other write operation -- `update()`, `remove()`, splits, bulk ops, scheduled post, budget period close, category reassign -- does not. This is the single most important class of bug.

---

## CRITICAL Findings (9)

### C1: Transaction `update()` Has No Database Transaction Wrapping

- **File:** `backend/src/transactions/transactions.service.ts`, lines ~551-682
- **Severity:** CRITICAL

The `update()` method performs a read-modify-write cycle across multiple balance updates without a QueryRunner. It reads `oldAmount`, performs the update, then performs balance adjustments -- all without a transaction. If two concurrent requests update the same transaction, both read the same `oldAmount` and the second write applies a stale delta, **corrupting the account balance**.

Contrast with `create()` at line 146 which correctly uses a QueryRunner.

**Fix:** Wrap the entire update method (from `transactionsRepository.update` through all `updateBalance` and `recalculateCurrentBalance` calls) in a `queryRunner.startTransaction()` / `commitTransaction()` block, passing the queryRunner to every balance update call.

---

### C2: Transaction `remove()` Has No Database Transaction Wrapping

- **File:** `backend/src/transactions/transactions.service.ts`, lines ~684-783
- **Severity:** CRITICAL

Balance reversal and deletion are not atomic. `removeParentTransaction()` performs many individual balance updates and transaction removals with no QueryRunner at all, creating multiple points of partial failure.

**Fix:** Wrap the entire remove operation in a QueryRunner transaction. Pass the queryRunner to all `updateBalance`, `recalculateCurrentBalance`, and `remove` calls.

---

### C3: `deleteTransferSplitLinkedTransactions` Operates Outside Any Transaction

- **File:** `backend/src/transactions/transaction-split.service.ts`, lines ~230-265
- **Severity:** CRITICAL

Balance reversals and linked transaction removals happen one by one with no atomicity. Called from `update()` (which also has no transaction) and `updateSplits()`. If the process crashes mid-loop, some linked transactions will have been deleted with their balances reversed while others remain.

**Fix:** Accept an optional QueryRunner parameter, use it for all operations, and ensure callers always pass one from within a transaction boundary.

---

### C4: Floating-Point Accumulation in Split Sum Validation

- **File:** `backend/src/transactions/transaction-split.service.ts`, lines ~55-58
- **Severity:** CRITICAL

```typescript
const splitsSum = splits.reduce((sum, split) => sum + Number(split.amount), 0);
```

JavaScript float arithmetic can produce `99.99999999999999` instead of `100.0000`. The `toFixed(4)` rounding is fragile and magnitude-dependent.

**Fix:** Perform all money arithmetic in integer ten-thousandths:

```typescript
const splitsSum = splits.reduce(
  (sum, split) => sum + Math.round(Number(split.amount) * 10000), 0
);
const expectedSum = Math.round(Number(transactionAmount) * 10000);
if (splitsSum !== expectedSum) { /* reject */ }
```

---

### C5: SSE Stream Never Aborted on Client Disconnect -- Resource Leak

- **File:** `backend/src/ai/query/ai-query.controller.ts`, lines ~41-71
- **Severity:** CRITICAL

The `streamQuery` method sets up an SSE response and iterates over an async generator, but never listens for `res.on('close', ...)`. If a client disconnects mid-stream, the AI provider keeps generating tokens, tool calls keep executing against the database, and tokens/cost keep accruing -- all sent to a dead socket. A single abandoned Ollama request (10-minute timeout, 5 tool iterations) could hold resources indefinitely.

**Fix:**

```typescript
const abortController = new AbortController();
res.on('close', () => abortController.abort());

for await (const event of this.queryService.executeQueryStream(...)) {
  if (abortController.signal.aborted) break;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

---

### C6: SSRF Validator Vulnerable to DNS Rebinding (TOCTOU)

- **File:** `backend/src/ai/validators/safe-url.validator.ts`, lines ~153-167
- **Severity:** CRITICAL

DNS resolution is checked at DTO validation time, but the actual HTTP request happens later when the provider connects. An attacker can resolve to a public IP during validation, then rebind to `169.254.169.254` (cloud metadata) or `127.0.0.1` before the connection.

Additionally, line 161 uses `allAddrs.every(ip => isPrivateIp(ip))` -- if ANY address resolves to a public IP and others to private, validation passes.

**Fix:** Change `every` to `some` (reject if *any* address is private). Add a second layer: custom HTTP agent that re-resolves DNS and checks the resolved IP before connecting, or configure an egress proxy/firewall.

---

### C7: Selling More Shares Than Held Produces Negative Holdings With Corrupt Average Cost

- **File:** `backend/src/securities/holdings.service.ts`, lines ~118-136
- **Severity:** CRITICAL

No validation prevents selling more shares than held. Negative quantity holdings corrupt the cost basis calculation on subsequent buys:

```
totalCostBefore = (-5) * avgCost  // NEGATIVE
newAvgCost = (negativeCost + buyCost) / newQuantity  // garbage
```

This corrupts the holding permanently.

**Fix:** Guard in `createOrUpdate()`:

```typescript
if (newQuantity < -0.00000001) {
  throw new BadRequestException(
    `Insufficient shares: cannot reduce by ${Math.abs(quantityChange)}, only ${currentQuantity} held`
  );
}
```

---

### C8: `removeAll` Deletes Investment Transactions Without Reversing Cash Effects

- **File:** `backend/src/securities/investment-transactions.service.ts`, lines ~798-822
- **Severity:** CRITICAL

Bulk-deletes all investment transactions and holdings, resets brokerage balances, but does NOT delete the linked cash `Transaction` records or reverse their balance impacts. Cash account balances are left incorrect. Also not wrapped in a database transaction.

**Fix:** Before deleting investment transactions, reverse cash transaction effects (or delete the linked Transaction records and reverse their balance impacts). Wrap the entire operation in a QueryRunner transaction.

---

### C9: Race Condition in First-User Admin Promotion

- **File:** `backend/src/auth/auth.service.ts`, lines ~78-81, 391-394
- **Severity:** CRITICAL

`register()` checks `userCount === 0` to assign admin role without any transaction or locking. Two concurrent registrations could both see `userCount === 0` and both become admin. Same race exists in `findOrCreateOidcUser()`.

**Fix:** Wrap the check-and-create in a serializable transaction or use a database-level advisory lock.

---

## HIGH Findings (18)

### H1: Split Replacement in `update()` Not Atomic

- **File:** `backend/src/transactions/transactions.service.ts`, lines ~582-605
- **Severity:** HIGH

Old splits deleted, then new splits created with separate QueryRunners. If step 2 fails, splits are gone forever and the parent transaction has `isSplit = true` with zero splits.

**Fix:** Wrap entire update in a single QueryRunner.

---

### H2: `addSplit`, `removeSplit`, `updateSplits` All Lack Transaction Wrapping

- **File:** `backend/src/transactions/transaction-split.service.ts`, lines ~275-482
- **Severity:** HIGH

Each method performs multiple DB operations (create/delete splits, update balances, handle linked transactions) without atomicity. Same class of bug as C1-C3.

**Fix:** Wrap each method in a QueryRunner transaction.

---

### H3: Bulk Status Update Balance Changes Not Atomic

- **File:** `backend/src/transactions/transaction-bulk-update.service.ts`, lines ~71-82
- **Severity:** HIGH

`handleStatusBalanceChanges()` performs per-account `updateBalance` calls, followed by a batch UPDATE. Balance changes are committed before the batch UPDATE. If the batch fails, balances are wrong.

**Fix:** Wrap in a single QueryRunner transaction.

---

### H4: Bulk Update IDOR on categoryId/payeeId

- **File:** `backend/src/transactions/transaction-bulk-update.service.ts`, lines ~96-116
- **Severity:** HIGH

When `bulkUpdate` applies `categoryId` or `payeeId`, it never validates that those IDs belong to the requesting user. Cross-user data reference is possible.

**Fix:** Validate ownership of `dto.categoryId` and `dto.payeeId` before applying the update.

---

### H5: 2FA Secret Overwritten Before Confirmation

- **File:** `backend/src/auth/auth.service.ts`, lines ~231-232
- **Severity:** HIGH

`setup2FA()` writes the encrypted TOTP secret to the user entity immediately, before the user confirms with a valid code. An attacker with a session can call `setup2FA()` repeatedly to overwrite the secret, locking a user out if 2FA is already enabled.

**Fix:** Store in a `pendingTwoFactorSecret` field. Only commit to `twoFactorSecret` after successful `confirmSetup2FA()`.

---

### H6: TOTP Codes Accept Non-Numeric Characters

- **Files:** `backend/src/auth/dto/setup-2fa.dto.ts`, `backend/src/auth/dto/verify-totp.dto.ts`
- **Severity:** HIGH

`@IsString()` + `@Length(6, 6)` without `@Matches(/^\d{6}$/)`. Non-numeric codes reach the cryptographic comparison.

**Fix:** Add `@Matches(/^\d{6}$/, { message: 'Code must be exactly 6 digits' })`.

---

### H7: Email Not Normalized Before Lookups

- **File:** `backend/src/auth/auth.service.ts`, lines ~55, 98
- **Severity:** HIGH

Email addresses are not trimmed or lowercased before database lookups. `User@Example.com` and `user@example.com` could be treated as different accounts if DB collation is case-sensitive, leading to duplicate accounts.

**Fix:** Add `@Transform(({ value }) => value?.toLowerCase().trim())` to all email DTO fields.

---

### H8: CSRF Token Not Bound to Session

- **Files:** `backend/src/common/guards/csrf.guard.ts`, `backend/src/common/csrf.util.ts`
- **Severity:** HIGH

Double-submit cookie is a random value not cryptographically bound to the user's session. If a subdomain can set cookies (cookie tossing), an attacker could plant their own CSRF cookie and header.

**Fix:** HMAC-sign the CSRF token with the JWT secret and session ID. Verify the HMAC server-side.

---

### H9: Category Circular Reference Not Detected

- **File:** `backend/src/categories/categories.service.ts`, lines ~230-268
- **Severity:** HIGH

Only checks `parentId === id` (direct self-reference). Deeper cycles (A->B->C->A) are not detected, which would cause infinite recursion in tree rendering.

**Fix:** Walk the parent chain from the proposed parentId to root, checking for the current ID.

---

### H10: Timezone-Dependent Budget Date Calculations

- **File:** `backend/src/budgets/budget-date.utils.ts`, lines ~15-17
- **Severity:** HIGH

`getCurrentMonthPeriodDates()` uses `new Date()` in server local time. Users in different timezones get wrong period boundaries, wrong spending calculations, and wrong alerts. Propagates to `budgets.service.ts`, `budget-alert.service.ts`, `budget-period.service.ts`, and health reports.

**Fix:** Use UTC consistently or accept user timezone from preferences.

---

### H11: Scheduled Transaction `post()` Atomicity Gap

- **File:** `backend/src/scheduled-transactions/scheduled-transactions.service.ts`, lines ~603-620
- **Severity:** HIGH

Financial transaction created and committed BEFORE the QueryRunner that handles bookkeeping (override removal, nextDueDate advancement). If bookkeeping fails, money moves but the schedule doesn't advance -- next cron duplicates the transaction.

**Fix:** Wrap the entire operation in a single QueryRunner. Pass it to `transactionsService.create()`.

---

### H12: SEMIMONTHLY Next-Date Calculation Is Non-Standard

- **File:** `backend/src/scheduled-transactions/scheduled-transactions.service.ts`, lines ~717-722
- **Severity:** HIGH

Jan 15 -> Jan 31 (16 days), Jan 31 -> Feb 15 (15 days), Feb 15 -> Feb 28 (13 days). Intervals are irregular and may not match user expectations for semimonthly billing.

**Fix:** Clarify the business requirement and document the behavior. Standard semimonthly is 1st+15th or 15th+last-day of each month.

---

### H13: Stock SPLIT Action Is a No-Op

- **File:** `backend/src/securities/investment-transactions.service.ts`, line ~374
- **Severity:** HIGH

The `SPLIT` case in `processTransactionEffectsInTransaction` is an empty `break`. Stock splits have zero effect on holdings or cost basis. The rebuild logic also ignores SPLIT.

**Fix:** Implement split logic (multiply quantity, divide average cost by split ratio).

---

### H14: Yahoo Finance `regularMarketOpen` Always Returns `undefined`

- **File:** `backend/src/securities/yahoo-finance.service.ts`, line ~70
- **Severity:** HIGH

```typescript
regularMarketOpen: meta.regularMarketDayHigh ? undefined : undefined,
```

Ternary always returns `undefined` regardless of condition. Should be `meta.regularMarketOpen`.

**Fix:** `regularMarketOpen: meta.regularMarketOpen,`

---

### H15: No Request Timeout on Yahoo Finance HTTP Calls

- **File:** `backend/src/securities/yahoo-finance.service.ts`, lines ~49, 116, 173
- **Severity:** HIGH

All three `fetch()` calls have no timeout. Unresponsive Yahoo Finance hangs the entire price refresh cron indefinitely.

**Fix:** Add `signal: AbortSignal.timeout(15000)` to each fetch call.

---

### H16: Ollama Provider Timeout Cleared Prematurely

- **File:** `backend/src/ai/providers/ollama.provider.ts`, lines ~49-69
- **Severity:** HIGH

AbortController timeout cleared when headers arrive, but body reading has no timeout protection. If the Ollama server stalls during streaming, the connection hangs indefinitely. Same pattern in `stream()` and `completeWithTools()`.

**Fix:** Move `clearTimeout(timeout)` to after body consumption, not after headers.

---

### H17: MCP SSE Endpoint Skips Rate Limiting

- **File:** `backend/src/mcp/mcp-http.controller.ts`, line ~184
- **Severity:** HIGH

`@SkipThrottle()` on GET allows unlimited concurrent SSE connections. Combined with in-memory session storage (no global cap beyond 10 per user), this is a memory exhaustion vector.

**Fix:** Remove `@SkipThrottle()` or replace with a permissive limit. Add a global maximum session count with LRU eviction.

---

### H18: Password Reset URL Not Escaped in Email Template

- **File:** `backend/src/notifications/email-templates.ts`, line ~368
- **Severity:** HIGH

`<a href="${resetUrl}">` -- if the URL contains `"` characters, an attacker could break out of the href attribute and inject HTML.

**Fix:** `<a href="${escapeHtml(resetUrl)}">`. Apply same treatment to `appUrl` in all templates.

---

## MEDIUM Findings (30)

### Transactions Module

| # | Issue | File | Fix |
|---|-------|------|-----|
| M1 | `CreateTransferDto` allows negative/zero amount (no `@Min`) | `dto/create-transfer.dto.ts` | Add `@Min(0.0001)` and `@Max(999999999999)` |
| M2 | `UpdateTransferDto` allows zero amount/exchangeRate via `@Min(0)` | `dto/update-transfer.dto.ts` | Change to `@Min(0.0001)` or `@IsPositive()` |
| M3 | `CreateTransactionDto` allows `exchangeRate: 0`; `\|\|` fallback is fragile | `dto/create-transaction.dto.ts` | Change to `@Min(0.000001)` |
| M4 | `removeParentTransaction` no userId filter on linked lookups | `transactions.service.ts` | Add userId to all `findOne` queries |
| M5 | `bulkReconcile` can reconcile VOID transactions | `transaction-reconciliation.service.ts` | Filter out or reject VOID transactions |
| M6 | Split DTO has no `@Min`/`@Max` on amount | `dto/create-transaction-split.dto.ts` | Add `@Min(-999999999999)` `@Max(999999999999)` |
| M7 | LIKE wildcard injection in search (`%`, `_` unescaped) | `transactions.service.ts` | Escape LIKE metacharacters before wrapping with `%...%` |

### Auth Module

| # | Issue | File | Fix |
|---|-------|------|-----|
| M8 | PAT `expiresAt` accepts past dates | `dto/create-pat.dto.ts` | Add custom `@IsFutureDate` validator |
| M9 | `RolesGuard` no null check on `user` | `guards/roles.guard.ts` | Add `if (!user) return false;` |
| M10 | OIDC callback uses `process.env` instead of ConfigService | `auth.controller.ts` | Replace with `this.configService.get(...)` |
| M11 | Password reset token not invalidated atomically (TOCTOU) | `auth.service.ts` | Use atomic `UPDATE ... WHERE resetToken = :token` |
| M12 | `LoginDto` no `@MinLength` on password | `dto/login.dto.ts` | Add `@IsNotEmpty()` |

### Securities Module

| # | Issue | File | Fix |
|---|-------|------|-----|
| M13 | Floating point in `calculateTotalAmount` (quantity * price) | `investment-transactions.service.ts` | `Math.round(result * 10000) / 10000` |
| M14 | Rebuild ignores standalone (non-brokerage) investment accounts | `holdings.service.ts` | Include accounts where `accountSubType` is null |
| M15 | `action` query param not validated against enum | `investment-transactions.controller.ts` | Validate against `InvestmentAction` enum values |
| M16 | TWR computation N+1: separate DB call per security | `portfolio-calculation.service.ts` | Call `getLatestPrices` once with all security IDs |
| M17 | `getTradingDate` uses local timezone, not UTC | `yahoo-finance.service.ts` | Use `setUTCHours(0,0,0,0)` consistently |
| M18 | `updateDto.action` change doesn't re-validate security requirement | `investment-transactions.service.ts` | Add action-requires-security validation in `update()` |

### Accounts Module

| # | Issue | File | Fix |
|---|-------|------|-----|
| M19 | Race condition between balance check and account close (no lock) | `accounts.service.ts` | Use `pessimistic_write` lock in QueryRunner |
| M20 | `updateBalance` with queryRunner returns stale balance object | `accounts.service.ts` | Re-query within transaction after atomic update |
| M21 | Mortgage rate months-elapsed uses 30-day approximation | `loan-mortgage-account.service.ts` | Use `(year2-year1)*12 + (month2-month1)` |

### Categories & Payees

| # | Issue | File | Fix |
|---|-------|------|-----|
| M22 | `reassignTransactions` not wrapped in a transaction | `categories.service.ts` | Wrap 4 UPDATE operations in QueryRunner |
| M23 | Category deletion doesn't check for referencing transactions | `categories.service.ts` | Check transaction count before deletion |
| M24 | `applyCategorySuggestions` doesn't validate categoryId ownership | `payees.service.ts` | Batch-verify categoryIds belong to user |

### Budgets Module

| # | Issue | File | Fix |
|---|-------|------|-----|
| M25 | Alert dedup suppresses severity escalation (WARNING blocks CRITICAL) | `budget-alert.service.ts` | Allow escalation by checking severity rank |
| M26 | `closePeriod` not atomic -- partial failure leaves inconsistent state | `budget-period.service.ts` | Wrap in QueryRunner transaction |
| M27 | Generator doesn't validate user ownership of categoryIds | `budget-generator.service.ts` | Validate categoryIds belong to user |

### AI & Reports

| # | Issue | File | Fix |
|---|-------|------|-----|
| M28 | `buildDefaultConfig` re-encrypts API key (scryptSync) on every call | `ai.service.ts` | Cache the default config |
| M29 | Report execution loads ALL matching transactions into memory (no limit) | `reports.service.ts` | Add `.take(50000)` safety limit |
| M30 | Silent currency fallback returns unconverted amount with no warning | `report-currency.service.ts` | Log warning when exchange rate is missing |

---

## LOW Findings (25+)

### Transactions

| # | Issue | File |
|---|-------|------|
| L1 | N+1 category validation per-split (up to 100 queries) | `transaction-split.service.ts` |
| L2 | `console.error` instead of `this.logger` | `transactions.service.ts:444` |
| L3 | `getAllCategoryIdsWithChildren` duplicated in 3 files | transactions module (3 services) |
| L4 | `BulkUpdateFilterDto.startDate/endDate` not `@IsDateString()` | `dto/bulk-update.dto.ts` |
| L5 | `parseIds` in controller doesn't validate UUIDs | `transactions.controller.ts` |

### Auth

| # | Issue | File |
|---|-------|------|
| L6 | bcrypt salt rounds = 10 (OWASP recommends 12+) | `auth.service.ts` |
| L7 | `purgeExpiredRefreshTokens` doesn't purge revoked-but-unexpired tokens | `auth.service.ts` |
| L8 | Unused `generateToken` method creates JWTs without explicit expiry | `auth.service.ts` |
| L9 | `register()` throws 401 for duplicate email (should be 400/409) | `auth.service.ts` |
| L10 | PAT limit exceeded throws plain `Error` (500) instead of `BadRequestException` | `pat.service.ts` |

### Securities

| # | Issue | File |
|---|-------|------|
| L11 | `getSummary` hardcodes 10K limit; inaccurate for large portfolios | `investment-transactions.service.ts` |
| L12 | Zero-cost-basis holdings return `null` gain/loss instead of computing from market value | `portfolio-calculation.service.ts` |
| L13 | `formatCashTransactionPayeeName` hardcodes USD currency format | `investment-transactions.service.ts` |
| L14 | Concurrent price refresh corrupts shared counters (`updated`/`failed`) via `Promise.all` | `security-price.service.ts` |

### Accounts & Categories

| # | Issue | File |
|---|-------|------|
| L15 | Decimal precision inconsistency: DB schema = 4dp, SQL ROUND = 2dp, JS rounding = 2dp | `accounts.service.ts` |
| L16 | TypeORM decimal columns return strings; no transformer on Account entity | `entities/account.entity.ts` |
| L17 | Loan amortization caps at 1000 iterations (weekly 20yr loan = 1040) | `loan-amortization.util.ts` |
| L18 | `importDefaults` saves categories one-by-one (50-80 INSERTs, not atomic) | `categories.service.ts` |

### Payees & Budgets

| # | Issue | File |
|---|-------|------|
| L19 | LIKE wildcard injection in payee search (`%`, `_` unescaped) | `payees.service.ts` |
| L20 | `applyCategorySuggestions` N+1 (up to 1000 queries for 500 items) | `payees.service.ts` |
| L21 | Budget velocity returns NaN when budget total is zero | `budgets.service.ts` |
| L22 | Period category creation saves individually in a loop | `budget-period.service.ts` |

### Infrastructure

| # | Issue | File |
|---|-------|------|
| L23 | QIF parser returns 0 for unparseable amounts silently | `import/qif-parser.ts` |
| L24 | `enableImplicitConversion: true` in global ValidationPipe can mask type validation | `main.ts` |
| L25 | Demo reset re-seeds outside transaction boundary | `database/demo-reset.service.ts` |
| L26 | Duplicate transaction detection is O(n^2) | `built-in-reports/data-quality-reports.service.ts` |

### AI Module

| # | Issue | File |
|---|-------|------|
| L27 | AI insight cron processes only first 50 users, no pagination | `ai/insights/ai-insights.service.ts` |
| L28 | `toResponseDto` decrypts API key (scryptSync) just to mask last 4 chars | `ai/ai.service.ts` |
| L29 | Anthropic provider stream has no timeout protection | `ai/providers/anthropic.provider.ts` |
| L30 | Tool executor `searchText` from LLM not length-limited | `ai/query/tool-executor.service.ts` |

---

## Previously Fixed (from prior audits -- retained for reference)

All items below were identified and fixed in earlier audit rounds (documented in CLAUDE.md).

### Critical (Fixed)

- [x] C-PREV-1: Cross-user data leakage in split counting -- join through transaction table with userId filter
- [x] C-PREV-2: Race condition in transfer create -- wrapped in QueryRunner transaction
- [x] C-PREV-3: Race condition in transfer update -- wrapped in QueryRunner transaction
- [x] C-PREV-4: Race condition in investment transaction create -- wrapped in QueryRunner transaction
- [x] C-PREV-5: Race condition in investment transaction update -- wrapped in QueryRunner transaction
- [x] C-PREV-6: Hash password reset tokens with SHA-256 before storing in DB
- [x] C-PREV-7: Use unique per-user salt for TOTP encryption

### High (Fixed)

- [x] H-PREV-1: Pessimistic write lock on transaction balance updates
- [x] H-PREV-2: OIDC callback error leakage
- [x] H-PREV-3: Global ThrottlerGuard
- [x] H-PREV-4: Security headers (CSP, HSTS, X-Content-Type-Options, etc.)
- [x] H-PREV-5: Race condition in investment transaction delete -- QueryRunner
- [x] H-PREV-6: Race condition in transfer delete -- QueryRunner
- [x] H-PREV-7: Race condition in holdings rebuild -- QueryRunner
- [x] H-PREV-8: Race condition in transaction create with splits -- QueryRunner
- [x] H-PREV-9: Race condition in split creation loop -- QueryRunner

### Medium (Fixed)

- [x] M-PREV-1: JWT type check (reject 2FA pending tokens on normal endpoints)
- [x] M-PREV-2: Trust proxy configuration
- [x] M-PREV-3: ParseUUIDPipe on all controller ID params
- [x] M-PREV-4: N+1 holdings rebuild individual saves -- batch save
- [x] M-PREV-5: N+1 split creation -- batch save
- [x] M-PREV-6: N+1 investment transaction account resolution -- batch findByIds
- [x] M-PREV-7: N+1 import validation -- batch find(In())
- [x] M-PREV-8: N+1 delete transfer split linked transactions -- batch find
- [x] M-PREV-9: Missing index on investment_transactions.transaction_id
- [x] M-PREV-10: Missing index on scheduled_transaction_overrides composite
- [x] M-PREV-11: Investment account pair creation -- QueryRunner transaction

### Low (Fixed)

- [x] L-PREV-1: N+1 brokerage balance reset -- single update query
- [x] L-PREV-2: N+1 scheduled transaction auto-post -- QueryRunner
- [x] L-PREV-3: N+1 per-account balance recalculation -- GROUP BY
- [x] L-PREV-4: Missing FK relations on 13 entities
- [x] L-PREV-5: @Exclude() without ClassSerializerInterceptor
- [x] L-PREV-6: ProfileSection missing client-side validation

---

## Verified Secure Areas

| Area | Status | Notes |
|------|--------|-------|
| Auth Guards | All 25 controllers covered | Class-level `@UseGuards(AuthGuard('jwt'))` everywhere except health + auth |
| User Identity | All services derive userId from JWT | Never from request params/body |
| SQL Injection | Zero vectors | All queries use parameterized TypeORM QueryBuilder |
| XSS | Zero vectors | No `dangerouslySetInnerHTML`, no `eval()`, `new Function()` replaced |
| Token Storage | httpOnly cookies only | localStorage stores only `isAuthenticated` boolean |
| Rate Limiting | Global + per-endpoint | Auth: 3-5/15min, AI: 10/min, Global: 100/min |
| Input Validation | 70+ DTOs | `whitelist: true`, `forbidNonWhitelisted: true` |
| Security Headers | Helmet + custom | CSP (nonce-based), HSTS, CORP, COOP, X-Frame-Options |
| Dependencies | 0 npm audit vulnerabilities | All three packages clean |
| Secrets | All externalized | JWT_SECRET min 32 chars enforced, AI_ENCRYPTION_KEY min 32 chars |
| API Key Encryption | AES-256-GCM | Per-encryption random salt, keys never returned to client |
| OIDC | Proper validation | State/nonce, email_verified check, no open redirects |
| Cookie Security | httpOnly, secure, sameSite | No tokens in localStorage |
| MCP Auth | PAT bearer tokens | Hash comparison, expiry, revocation, active user check |
| Tool Execution | Fixed allowlist | 6 tool names via switch/case, no dynamic dispatch |

---

## Recommended Fix Priority

### Phase 1: Data Integrity (Critical)

1. **C1, C2, C3:** Wrap `update()`, `remove()`, and `deleteTransferSplitLinkedTransactions` in QueryRunner transactions
2. **H1, H2, H3, H4:** Wrap split operations and bulk updates in QueryRunner transactions
3. **C4:** Fix floating-point split validation with integer arithmetic
4. **C7:** Add guard against negative holdings
5. **C8:** Reverse cash effects in `removeAll` and wrap in transaction

### Phase 2: Security (Critical + High)

6. **C9:** Fix admin registration race condition
7. **C5:** Add client disconnect handling to SSE stream
8. **C6:** Fix SSRF validator (change `every` to `some`, add connection-time check)
9. **H5:** Use pending 2FA secret field
10. **H7:** Normalize emails before lookups
11. **H18:** Escape URLs in email templates

### Phase 3: Correctness (High)

12. **H10:** Use UTC consistently for budget date calculations
13. **H11:** Fix scheduled transaction post atomicity
14. **H14:** Fix Yahoo Finance `regularMarketOpen` bug (one-line fix)
15. **H15, H16:** Add timeouts to external HTTP calls
16. **H13:** Implement stock split logic

### Phase 4: Validation & Defense-in-Depth (Medium)

17. **M1-M6:** Add missing DTO constraints (`@Min`, `@Max`, `@IsPositive`)
18. **H4, M24, M27:** Fix IDOR on categoryId/payeeId in bulk operations
19. **H9:** Detect category circular references
20. **M19, M22, M26:** Add missing transaction wrapping

### Phase 5: Performance & Quality (Low)

21. Fix N+1 patterns (L1, L20, M16)
22. Standardize decimal precision across the codebase (L15, L16)
23. Replace `console.error` with logger (L2)
24. Deduplicate `getAllCategoryIdsWithChildren` (L3)
