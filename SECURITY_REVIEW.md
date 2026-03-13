# OWASP Top 10 Security Code Review

**Date:** 2026-03-13
**Scope:** Full codebase review (backend, frontend, infrastructure)
**Framework:** OWASP Top 10:2021

---

## Executive Summary

The Monize codebase demonstrates **strong security fundamentals** across most OWASP categories. Authentication, access control, injection prevention, and cryptographic implementations are well-designed. The most significant gaps are in **audit logging** (critical for a financial application) and a few **configuration hardening** items.

### Findings by Severity

| Severity | Count |
|----------|-------|
| High | 3 |
| Medium | 10 |
| Low | 18 |
| **Total** | **31** |

### Findings by OWASP Category

| Category | High | Medium | Low |
|----------|------|--------|-----|
| A01 - Broken Access Control | 0 | 1 | 0 |
| A02 - Cryptographic Failures | 0 | 1 | 3 |
| A03 - Injection | 0 | 1 | 6 |
| A04 - Insecure Design | 0 | 3 | 2 |
| A05 - Security Misconfiguration | 0 | 2 | 7 |
| A06 - Vulnerable Components | 0 | 0 | 0 |
| A07 - Authentication Failures | 0 | 2 | 4 |
| A08 - Data Integrity Failures | 0 | 1 | 3 |
| A09 - Logging/Monitoring Failures | 2 | 2 | 1 |
| A10 - SSRF | 1 | 0 | 1 |

---

## Stage 1: High Severity (Fix First)

### H1. No Audit Trail for Financial Transactions
- **OWASP:** A09 - Security Logging and Monitoring Failures
- **File:** `backend/src/transactions/transactions.service.ts`
- **Description:** The `create()`, `update()`, and `remove()` methods do not log when transactions are created, modified, or deleted. There is no audit log anywhere in the codebase (grep for "audit" returns zero results). For a financial application, this means fraud detection is impossible, regulatory compliance is weakened, dispute resolution has no evidentiary basis, and unauthorized modifications leave no trace.
- **Recommendation:** Implement an immutable audit log table recording who changed what, when, and before/after values. At minimum, add Logger calls for all financial mutations. Consider a dedicated `AuditService` that writes to an append-only audit_log table.

### H2. Admin Operations Have No Logging
- **OWASP:** A09 - Security Logging and Monitoring Failures
- **File:** `backend/src/admin/admin.service.ts`, lines 1-195
- **Description:** The admin service performs high-privilege operations (changing user roles, deactivating users, deleting users, resetting passwords) but has no `Logger` instance and generates zero log entries. An admin could elevate privileges, deactivate legitimate users, delete accounts, or reset passwords with no trace.
- **Recommendation:** Add a `Logger` instance and log every admin operation with the admin's userId, target userId, action type, and timestamp. These are the most sensitive operations in the application.

### H3. AI_DEFAULT_BASE_URL Bypasses SSRF Validation
- **OWASP:** A10 - Server-Side Request Forgery
- **File:** `backend/src/ai/ai.service.ts`, lines 288-289
- **Description:** The `AI_DEFAULT_BASE_URL` environment variable is used directly as the base URL for Ollama/OpenAI-compatible providers without passing through the `IsSafeUrl` validator. User-submitted base URLs are properly validated via `@IsSafeUrl()` in DTOs, but the env var is trusted implicitly. In containerized deployments where env vars might be sourced from config files, a misconfiguration could cause the backend to make requests to internal services (e.g., cloud metadata endpoints).
- **Recommendation:** Apply the same `IsSafeUrl` validation logic to `AI_DEFAULT_BASE_URL` at startup, or at minimum validate it does not resolve to private/internal IPs.

---

## Stage 2: Medium Severity (Fix Soon)

### M1. Exchange Rate Refresh Missing Admin Guard
- **OWASP:** A01 - Broken Access Control
- **File:** `backend/src/currencies/currencies.controller.ts`, lines 135-142
- **Description:** `POST /currencies/exchange-rates/refresh` allows any authenticated user to trigger a global exchange rate refresh from Yahoo Finance. Compare with `POST /currencies/exchange-rates/backfill` (line 144) which correctly requires `@Roles('admin')`. Any authenticated user can trigger unlimited external API calls and write to shared tables.
- **Recommendation:** Add `@Roles('admin')` decorator to match the backfill endpoint pattern.

### M2. TOTP Secret Returned in Plaintext During 2FA Setup
- **OWASP:** A02 - Cryptographic Failures
- **File:** `backend/src/auth/two-factor.service.ts`, line 301
- **Description:** The `setup2FA()` method returns `{ secret, qrCodeDataUrl, otpauthUrl }`, exposing the raw TOTP secret. If the response is logged, cached by a proxy, or stored in browser history, the secret is exposed. The `otpauthUrl` also contains the secret.
- **Recommendation:** Only return the QR code data URL. If manual entry is needed, consider a separate endpoint that requires re-authentication.

### M3. Missing @SanitizeHtml() on BulkUpdateDto Text Fields
- **OWASP:** A03 - Injection (Stored XSS)
- **File:** `backend/src/transactions/dto/bulk-update.dto.ts`, lines 87-88, 97-99
- **Description:** `payeeName` and `description` fields have `@IsString()` and `@MaxLength()` but lack `@SanitizeHtml()`. The corresponding fields on `CreateTransactionDto` do have `@SanitizeHtml()`. These are stored fields rendered in the UI.
- **Recommendation:** Add `@SanitizeHtml()` to both fields.

### M4. ILIKE Search Pattern Not Sanitized in Bulk Update Service
- **OWASP:** A04 - Insecure Design
- **File:** `backend/src/transactions/transaction-bulk-update.service.ts`, line 552
- **Description:** The `applyFilters` method uses `%${filters.search.trim()}%` without escaping SQL LIKE wildcards (`%`, `_`, `\`). Compare with `transactions.service.ts` (line 287-291) which properly escapes these characters. Attackers can craft expensive pattern-match queries.
- **Recommendation:** Apply the same LIKE wildcard escaping used in `transactions.service.ts`.

### M5. No Array Size Limit on Bulk Transaction IDs
- **OWASP:** A04 - Insecure Design
- **File:** `backend/src/transactions/dto/bulk-update.dto.ts`, lines 63-68
- **Description:** `transactionIds` array in `BulkUpdateDto` and `BulkDeleteDto` has no `@ArrayMaxSize()`. A user could submit tens of thousands of UUIDs causing memory exhaustion or slow `IN (...)` clauses. Compare with `bulk-reconcile.dto.ts` which correctly limits to 1000.
- **Recommendation:** Add `@ArrayMaxSize(1000)` (or similar) to match existing patterns.

### M6. No Rate Limiting on Import Endpoints
- **OWASP:** A04 - Insecure Design
- **File:** `backend/src/import/import.controller.ts`, lines 41-214
- **Description:** Import operations accept 10MB bodies and can process thousands of transactions per request with no specific `@Throttle()` decorator. The global throttle (100 req/min) is too generous for resource-intensive import operations.
- **Recommendation:** Add `@Throttle({ default: { limit: 5, ttl: 60000 } })` or similar to the import controller.

### M7. In-Memory 2FA Rate Limiting Lost on Restart
- **OWASP:** A07 - Authentication Failures
- **File:** `backend/src/auth/two-factor.service.ts`, lines 35-42
- **Description:** The `twoFactorAttempts`, `user2FAAttempts`, and `usedTotpCodes` Maps are in-memory. Server restarts clear all tracking. In multi-instance deployments, each instance has independent tracking, multiplying attacker attempts. The database-backed lockout provides a fallback, but in-memory limits can be circumvented.
- **Recommendation:** Use Redis or database-backed counters for 2FA rate limiting.

### M8. Refresh Token Rotation Ignores rememberMe
- **OWASP:** A07 - Authentication Failures
- **File:** `backend/src/auth/token.service.ts`, line 132
- **Description:** `refreshTokens()` always uses `REFRESH_TOKEN_EXPIRY_MS` (1 day) for rotated tokens, ignoring whether the original was created with `rememberMe` (30 days). Users who selected "remember me" are logged out after 1 day on token rotation.
- **Recommendation:** Store `rememberMe` preference on the refresh token entity and preserve it during rotation.

### M9. DISABLE_HTTPS_HEADERS Can Weaken Production
- **OWASP:** A05 - Security Misconfiguration
- **File:** `backend/src/main.ts`, lines 47-65; `frontend/next.config.js`, lines 15-29
- **Description:** Setting `DISABLE_HTTPS_HEADERS=true` disables HSTS and COOP on both backend and frontend. There is no warning when this is set in production (`NODE_ENV=production`).
- **Recommendation:** Log a prominent warning if `NODE_ENV=production` and `DISABLE_HTTPS_HEADERS=true`.

### M10. CI Pipeline Uses npm install Instead of npm ci
- **OWASP:** A08 - Software and Data Integrity Failures
- **File:** `.github/workflows/ci.yml`, lines 25, 40, 84, 97, 113, 129-130
- **Description:** All CI jobs use `npm install` instead of `npm ci`. The `npm ci` command installs from the lockfile exactly, preventing supply-chain attacks where a compromised registry could serve different versions than what was reviewed.
- **Recommendation:** Replace all `npm install` with `npm ci` in CI workflows.

### M11. Default Credentials in .env.example and Dev Compose
- **OWASP:** A05 - Security Misconfiguration
- **File:** `.env.example`, lines 15-16, 26; `docker-compose.dev.yml`, line 10
- **Description:** Placeholder credentials that could be used as-is. The default Postgres password `monize_password` is baked into `docker-compose.dev.yml`. Production compose does not set defaults (will fail if unset), which is good, but dev compose could be accidentally used in production.
- **Recommendation:** Add a startup check that warns or fails if default credentials are detected in non-development environments.

---

## Stage 3: Low Severity (Fix When Convenient)

### L1. HKDF Uses Empty Salt
- **OWASP:** A02
- **File:** `backend/src/auth/crypto.util.ts`, line 17
- **Description:** `derivePurposeKey` uses `""` as HKDF salt. Technically correct per RFC 5869 (purpose string provides domain separation), but a non-empty application-specific salt is a hardening best practice.

### L2. Legacy TOTP Encryption Still Supported
- **OWASP:** A02
- **File:** `backend/src/auth/crypto.util.ts`, lines 42-44, 84-92
- **Description:** `deriveLegacyKey` with hardcoded salt `"totp-encryption-salt"` still supported for backward compatibility. Migration path exists but no monitoring to verify completion.
- **Recommendation:** Add a startup check that logs a warning if any legacy-format encrypted values remain.

### L3. AI_ENCRYPTION_KEY Defaults to Empty String
- **OWASP:** A02
- **File:** `backend/src/ai/ai-encryption.service.ts`, line 11
- **Description:** Defaults to `""` if not set. The `isConfigured()` check prevents operations, but misconfiguration passes silently. Compare with JWT_SECRET which throws at startup.
- **Recommendation:** Log a warning at startup if AI features are enabled but key is missing/short.

### L4. Missing @Min/@Max on CreateScheduledTransactionDto.amount
- **OWASP:** A03
- **File:** `backend/src/scheduled-transactions/dto/create-scheduled-transaction.dto.ts`, line 53
- **Description:** Has `@IsNumber()` but no `@Min`/`@Max`, unlike `CreateTransactionDto`. Database column provides implicit bounds.

### L5. Missing @Min/@Max on CreateScheduledTransactionSplitDto.amount
- **OWASP:** A03
- **File:** `backend/src/scheduled-transactions/dto/create-scheduled-transaction-split.dto.ts`, line 31
- **Description:** Same issue as L4 for split amounts.

### L6. Missing @Min/@Max on CreateAccountDto.openingBalance
- **OWASP:** A03
- **File:** `backend/src/accounts/dto/create-account.dto.ts`, line 104
- **Description:** Has `@IsNumber({ maxDecimalPlaces: 4 })` but no bounds, while other financial fields in the same DTO do.

### L7. Missing @SanitizeHtml() on BulkUpdateFilterDto.search
- **OWASP:** A03
- **File:** `backend/src/transactions/dto/bulk-update.dto.ts`, line 49
- **Description:** Filter field, not stored, used in parameterized LIKE queries. Minimal risk.

### L8. Missing @IsUUID on BulkUpdateFilterDto.categoryIds
- **OWASP:** A03
- **File:** `backend/src/transactions/dto/bulk-update.dto.ts`, line 36
- **Description:** Uses `@IsString({ each: true })` instead of `@IsUUID("4", { each: true })`. May be intentional to allow "uncategorized" literal.

### L9. Missing @SanitizeHtml() on CreateTagDto.icon
- **OWASP:** A03
- **File:** `backend/src/tags/dto/create-tag.dto.ts`, line 24
- **Description:** Other DTOs with `icon` fields include `@SanitizeHtml()`. Low risk as icons are rendered as component props.

### L10. No Rate Limiting on Bulk Operations
- **OWASP:** A04
- **File:** `backend/src/transactions/transactions.controller.ts`
- **Description:** Bulk update/delete endpoints rely on global throttle only (100/min). Consider specific limits for resource-intensive operations.

### L11. Account Update Lacks QueryRunner Transaction
- **OWASP:** A04
- **File:** `backend/src/accounts/accounts.service.ts`, lines 363-497
- **Description:** Read-modify-write on balance without QueryRunner. Known issue documented in AUDIT_FINDINGS.md. Concurrent updates could lose data.

### L12. In-Memory Forgot-Password Rate Limiting
- **OWASP:** A07
- **File:** `backend/src/auth/auth-email.service.ts`, lines 17-22
- **Description:** Same restart/scaling issue as M7 but lower risk (nuisance vector, not auth bypass).

### L13. Account Lockout Counter Not Atomic
- **OWASP:** A07
- **File:** `backend/src/auth/auth.service.ts`, lines 148-183
- **Description:** Failed login counter uses read-increment-write pattern instead of atomic SQL `SET failed_login_attempts = failed_login_attempts + 1`. Race condition allows slightly more attempts than configured max. Mitigated by global rate limiter.

### L14. OIDC Callback Missing error Parameter Check
- **OWASP:** A07
- **File:** `backend/src/auth/auth.controller.ts`, line 242
- **Description:** Does not check `query.error` before processing. Catch block handles gracefully, but explicit check would provide clearer error handling.

### L15. OIDC clearCookie Missing Matching Options
- **OWASP:** A07
- **File:** `backend/src/auth/auth.controller.ts`, lines 259-260
- **Description:** `clearCookie("oidc_state")` and `clearCookie("oidc_nonce")` called without path/domain/secure/sameSite options. Cookies may not actually be cleared (10-minute maxAge expires naturally).

### L16. Yahoo Finance range Parameter Not URI-Encoded
- **OWASP:** A05
- **File:** `backend/src/securities/yahoo-finance.service.ts`, line 302
- **Description:** `range` is interpolated without `encodeURIComponent()` while `symbol` is properly encoded. Currently comes from internal code, but could enable query parameter injection if future code paths pass unsanitized input.

### L17. Bearer Security Scanner Skips Rules Globally
- **OWASP:** A08
- **File:** `.github/workflows/ci.yml`, lines 141-149
- **Description:** Skipping `javascript_lang_logger_leak` globally could mask legitimate sensitive data leakage introduced later. Consider file-level exclusions.

### L18. OIDC_ISSUER_URL Trusted Without URL Validation
- **OWASP:** A10
- **File:** `backend/src/auth/oidc/oidc.service.ts`, lines 42-46
- **Description:** Environment variable used directly with `openid-client` library. Admin-configured, limited blast radius since library only fetches well-known endpoints.

---

## Positive Security Observations

The review identified many well-implemented security controls:

### Access Control (A01)
- All controllers use class-level `@UseGuards(AuthGuard('jwt'))` (except health/auth)
- Every service derives `userId` from JWT, never from request params/body
- All `:id` params use `ParseUUIDPipe`
- All data queries include `userId` filtering (no IDOR)
- Admin endpoints use `RolesGuard` + `@Roles('admin')`

### Cryptography (A02)
- bcrypt with 12 salt rounds for passwords
- AES-256-GCM for API key encryption
- JWT algorithm pinned to HS256 in both sign and verify options
- 32-char minimum JWT secret enforced at startup
- All stored tokens (refresh, reset, PAT) are SHA-256 hashed
- Timing-safe comparisons for CSRF and HIBP

### Injection Prevention (A03)
- All SQL queries use parameterized queries (no string interpolation)
- All email templates escape user input with `escapeHtml()`
- No `dangerouslySetInnerHTML` in frontend
- `@SanitizeHtml()` applied consistently on user-facing text fields
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`
- AI prompt injection detection with sandwich defense pattern

### Authentication (A07)
- Exponential backoff lockout after 5 failed attempts with email notification
- 2FA temp tokens use JWT with 5-min expiry and type claim
- TOTP replay protection with 90-second window
- Backup code consumption uses pessimistic locking
- Refresh token rotation with family-based replay detection
- Password reset tokens are hashed with 1-hour expiry
- 12-char password minimum with HIBP breach checking
- Email enumeration prevention on registration and forgot-password
- CSRF double-submit cookie with HMAC session binding

### Infrastructure
- Production Docker: `read_only: true`, `no-new-privileges`, `cap_drop: ALL`, non-root users
- CORS: explicit allow-list, no wildcards
- Security headers: Helmet with HSTS, frameguard, CSP, CORP/COOP
- Rate limiting: global + endpoint-specific limits
- PostgreSQL port not exposed in production compose
- Swagger disabled in production
- `npm audit --audit-level=high` in CI pipeline

---

## Recommended Remediation Order

### Immediate (Stage 1) -- High severity, address within 1-2 sprints
1. **H1 + H2**: Implement audit logging service for financial transactions and admin operations
2. **H3**: Validate `AI_DEFAULT_BASE_URL` against private IPs at startup

### Short-term (Stage 2) -- Medium severity, address within 1-2 months
3. **M1**: Add `@Roles('admin')` to exchange rate refresh endpoint
4. **M3**: Add `@SanitizeHtml()` to `BulkUpdateDto.payeeName` and `.description`
5. **M4**: Escape LIKE wildcards in `transaction-bulk-update.service.ts`
6. **M5**: Add `@ArrayMaxSize(1000)` to bulk transaction ID arrays
7. **M6**: Add `@Throttle()` to import controller
8. **M10**: Replace `npm install` with `npm ci` in CI workflows
9. **M2**: Remove raw TOTP secret from 2FA setup response
10. **M7**: Move 2FA rate limiting to Redis/database
11. **M8**: Preserve `rememberMe` during refresh token rotation
12. **M9 + M11**: Add production environment warnings for dangerous configs

### Long-term (Stage 3) -- Low severity, address opportunistically
13. Fix remaining DTO validation gaps (L4-L9)
14. Harden remaining items (L1-L3, L10-L18)
