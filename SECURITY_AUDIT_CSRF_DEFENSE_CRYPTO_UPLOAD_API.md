# Security Audit Report: CSRF, Defensive Programming, Cryptography, File Uploads, API Security

**Audit Date:** 2026-02-28
**Scope:** Cross-Site Request Forgery, Defensive Programming & Error Handling, Cryptography & Randomness, File Upload Security, API Security
**Codebase:** Monize (NestJS backend, Next.js frontend, PostgreSQL)

---

## 1. Cross-Site Request Forgery (CSRF)

### 1.1 CSRF Guard Implementation

- **Status:** Present -- Well-Implemented
- **Location:** `backend/src/common/guards/csrf.guard.ts`
- **Confidence Level:** High

The application uses a double-submit cookie pattern with timing-safe comparison. The global `CsrfGuard` is registered as an `APP_GUARD` in `backend/src/app.module.ts:107`, ensuring all endpoints are covered by default. Safe HTTP methods (GET, HEAD, OPTIONS) are bypassed at lines 24-26. The guard validates that `csrf_token` cookie and `X-CSRF-Token` header match using `crypto.timingSafeEqual()` at line 52, preventing timing-based token extraction. An optional HMAC-SHA256 session binding is available at lines 61-68 via `verifyCsrfToken()`.

### 1.2 CSRF Token Not Session-Bound in Production Calls

- **Status:** Present
- **Location:** `backend/src/auth/auth.controller.ts:111, 305`
- **Attack Vector:** The `generateCsrfToken()` function accepts optional `sessionId` and `secret` parameters to produce an HMAC-bound token (`nonce:hmac`). However, all production call sites invoke `generateCsrfToken()` with zero arguments (lines 111 and 305), producing a plain random nonce. This means the CSRF token is not cryptographically bound to the user's session. An attacker who obtains any valid CSRF nonce (e.g., via a subdomain cookie injection) could use it for any user's session.
- **Impact:** Reduced defense-in-depth. The double-submit pattern still provides baseline protection, but session-binding would prevent token fixation attacks via subdomain cookie injection.
- **Confidence Level:** High

### 1.3 Cookie Attributes

- **Status:** Not Detected (no issues)
- **Location:** `backend/src/auth/auth.controller.ts:83-98`, `backend/src/common/csrf.util.ts:37-45`
- **Confidence Level:** High

All cookie attributes are correctly configured:

| Cookie | httpOnly | secure | sameSite | maxAge |
|--------|----------|--------|----------|--------|
| `auth_token` | true | isProduction | lax | 15 min |
| `refresh_token` | true | isProduction | strict | 7 days |
| `csrf_token` | false (intentional) | isProduction | lax | 7 days |

The CSRF cookie's `httpOnly: false` is correct for the double-submit pattern, as JavaScript must read it to attach to request headers.

### 1.4 @SkipCsrf() Usage

- **Status:** Not Detected (no issues)
- **Location:** `backend/src/auth/auth.controller.ts` (lines 137, 159, 327, 368, 378, 505, 525), `backend/src/mcp/mcp-http.controller.ts:27`
- **Confidence Level:** High

All `@SkipCsrf()` usages are appropriate. Auth endpoints (register, login, forgot-password, reset-password, 2fa/verify, refresh, logout) are unauthenticated flows without existing CSRF cookies. The MCP controller uses PAT bearer token authentication (not cookies), making CSRF protection inapplicable.

### 1.5 State-Changing Endpoint Coverage

- **Status:** Not Detected (no gaps)
- **Confidence Level:** High

All POST/PUT/PATCH/DELETE endpoints on authenticated controllers are covered by the global `CsrfGuard`. No state-changing endpoints bypass CSRF protection without a justified `@SkipCsrf()` decorator.

---

## 2. Defensive Programming & Error Handling

### 2.1 No Global Exception Filter

- **Status:** Present
- **Location:** `backend/src/app.module.ts` (no `APP_FILTER` provider), `backend/src/main.ts`
- **Attack Vector:** Without a centralized exception filter, unexpected errors (e.g., TypeORM `QueryFailedError`, malformed JWT errors) may propagate NestJS default error messages. While NestJS defaults are generally safe, they could potentially leak internal class names, column names, or constraint names in certain edge cases.
- **Impact:** Low risk of information disclosure. Database constraint violation messages could reveal table/column structure.
- **Confidence Level:** Medium

### 2.2 Error Logging May Expose Sensitive Context

- **Status:** Present
- **Location:** `backend/src/securities/yahoo-finance.service.ts:84`, `backend/src/auth/auth.controller.ts:266`
- **Attack Vector:** Not directly exploitable (server-side logs only). However, logging raw `error.message` from external API calls (Yahoo Finance) could capture sensitive URL patterns, API keys in error responses, or internal service details. The OIDC callback logs `error.stack`, which records full internal file paths.
- **Impact:** Information disclosure in log aggregation systems. No direct client exposure.
- **Confidence Level:** Medium

### 2.3 Input Validation Coverage

- **Status:** Not Detected (no gaps in core endpoints)
- **Location:** `backend/src/main.ts:82-88` (global ValidationPipe)
- **Confidence Level:** High

The global `ValidationPipe` is configured with `whitelist: true`, `forbidNonWhitelisted: true`, and `transform: true`. All DTOs reviewed use appropriate `@IsUUID()`, `@MaxLength()`, `@Min()/@Max()`, `@IsNumber({ maxDecimalPlaces: 4 })`, and `@SanitizeHtml()` decorators. ParseUUIDPipe is consistently applied to all `:id` route parameters across all controllers.

### 2.4 No Dynamic Code Execution

- **Status:** Not Detected
- **Confidence Level:** High

No `eval()`, `new Function()`, or `vm` module usage detected. The frontend implements a safe recursive-descent expression parser at `frontend/src/lib/format.ts:114-225` with an explicit comment: "Eliminates the need for new Function() / eval()."

### 2.5 Generic Error Messages to Clients

- **Status:** Not Detected (properly handled)
- **Location:** `backend/src/ai/query/ai-query.controller.ts:65-73`, `backend/src/auth/auth.controller.ts:264-269`
- **Confidence Level:** High

AI query stream errors return a generic message ("An unexpected error occurred while processing your query.") while logging details server-side. OIDC callback errors redirect with a generic `?error=authentication_failed` parameter.

---

## 3. Cryptography & Randomness

### 3.1 Token Generation

- **Status:** Not Detected (no issues)
- **Location:** Multiple files in `backend/src/auth/`
- **Confidence Level:** High

All security tokens use `crypto.randomBytes()` or `crypto.randomUUID()`:

| Token | Size | Source | File:Line |
|-------|------|--------|-----------|
| Refresh token | 64 bytes | `crypto.randomBytes(64)` | `auth.service.ts:483` |
| Password reset | 32 bytes | `crypto.randomBytes(32)` | `auth.service.ts:633` |
| Trusted device | 64 bytes | `crypto.randomBytes(64)` | `auth.service.ts:706` |
| PAT | 32 bytes | `crypto.randomBytes(32)` | `pat.service.ts:43` |
| CSRF nonce | 32 bytes | `crypto.randomBytes(32)` | `csrf.util.ts:4` |
| Token family ID | UUID v4 | `crypto.randomUUID()` | `auth.service.ts:485` |
| OIDC state/nonce | Library | `openid-client` | `oidc.service.ts:143-151` |

No `Math.random()` usage detected in production security code.

### 3.2 AES-256-GCM Encryption Implementation

- **Status:** Not Detected (no issues)
- **Location:** `backend/src/auth/crypto.util.ts`
- **Confidence Level:** High

The encryption implementation is robust:
- Algorithm: `aes-256-gcm` (authenticated encryption)
- Per-encryption random salt: `crypto.randomBytes(16)` at line 21
- Per-encryption random IV: `crypto.randomBytes(16)` at line 23
- Key derivation: `crypto.scryptSync()` with 32-byte output at line 8
- GCM authentication tags properly set (line 29) and verified (line 63)
- Output format: `salt:iv:authTag:ciphertext`
- Backwards-compatible decryption for legacy 3-part format with static salt

### 3.3 Inconsistent Bcrypt Salt Rounds

- **Status:** Present
- **Location:** `backend/src/users/users.service.ts:185`, `backend/src/admin/admin.service.ts:176`
- **Attack Vector:** Password hashes created via user profile password change (10 rounds) and admin password reset (10 rounds) are weaker than those from registration and forgot-password flow (12 rounds). An attacker with a database dump would find passwords changed via the profile/admin path computationally cheaper to brute-force (~4x faster).
- **Impact:** Passwords hashed with 10 rounds provide less resistance to offline brute-force attacks. OWASP recommends minimum 12 rounds.
- **Confidence Level:** High

Specific locations:
- `auth.service.ts:68` -- registration: **12 rounds**
- `auth.service.ts:648` -- password reset: **12 rounds**
- `users.service.ts:185` -- profile change password: **10 rounds**
- `admin.service.ts:176` -- admin reset password: **10 rounds**
- `database/seed.service.ts:83` -- seed data: **10 rounds**
- `database/demo-reset.service.ts:112` -- demo reset: **10 rounds**

### 3.4 Legacy Static Salt for TOTP Key Derivation

- **Status:** Present
- **Location:** `backend/src/auth/crypto.util.ts:16`
- **Attack Vector:** The legacy key derivation uses a hardcoded salt string `"totp-encryption-salt"` for scrypt. If an attacker obtains the JWT_SECRET, all legacy-format TOTP secrets share the same derived key. With the new format (random per-encryption salt), each ciphertext uses a unique derived key.
- **Impact:** Low. This is a backwards-compatibility path for existing encrypted TOTP secrets. New encryptions use random salts. The primary protection remains the JWT_SECRET itself.
- **Confidence Level:** High

### 3.5 JWT Configuration

- **Status:** Not Detected (no issues)
- **Location:** `backend/src/auth/strategies/jwt.strategy.ts:32-41`
- **Confidence Level:** High

JWT_SECRET enforces minimum 32 characters at startup with a hard failure. The application will not start with a weak or missing secret. Algorithm is HS256 (appropriate for single-service deployments).

### 3.6 TOTP DTO Validation

- **Status:** Not Detected (properly implemented)
- **Location:** `backend/src/auth/dto/verify-totp.dto.ts:20`, `backend/src/auth/dto/setup-2fa.dto.ts:8`
- **Confidence Level:** High

Both DTOs include `@Matches(/^\d{6}$/, { message: "Code must be exactly 6 digits" })`, correctly restricting TOTP codes to exactly 6 numeric digits.

### 3.7 Deprecated or Weak Algorithms

- **Status:** Not Detected
- **Confidence Level:** High

No MD5, SHA-1, DES, RC4, or ECB mode usage detected. SHA-256 is used for token hashing (password reset, refresh tokens). All encryption uses authenticated mode (GCM).

---

## 4. File Upload Security

### 4.1 No Traditional File Upload Endpoints

- **Status:** Not Detected
- **Location:** `backend/src/import/import.controller.ts`
- **Confidence Level:** High

The application does not use multer, `FileInterceptor`, or any multipart form-data file upload mechanism. File import functionality (QIF format) accepts file content as a string in a JSON request body. No files are written to disk.

### 4.2 File Size Limits

- **Status:** Not Detected (properly configured)
- **Location:** `backend/src/main.ts:22-23`, `backend/src/import/dto/import.dto.ts:23,179`
- **Confidence Level:** High

Express body parser limits are set to 10MB. The `content` field in both `ParseQifDto` and `ImportQifDto` enforces `@MaxLength(10_000_000)` matching the Express limit. Array sizes are bounded with `@ArrayMaxSize(500)` for mapping arrays.

### 4.3 Missing @SanitizeHtml() on Import DTOs

- **Status:** Present
- **Location:** `backend/src/import/dto/import.dto.ts` (lines 30-31, 40-42, 66-67, 88-89, 98-100, 129-131, 140-142, 147-148)
- **Attack Vector:** The import DTOs accept user-controlled strings (`originalName`, `createNew`, `createNewLoan`, `securityName`) without applying the `@SanitizeHtml()` decorator. These values flow into `import-entity-creator.service.ts` and are stored as category names, account names, and security names in the database. Unlike other entity-creation DTOs (accounts, categories, payees, transactions), the import DTOs skip HTML sanitization. A malicious QIF file could inject HTML/JavaScript into entity names that are later rendered in the UI.
- **Impact:** Stored XSS via imported data. An attacker crafting a malicious QIF file with payloads like `<img src=x onerror='...'>` in category or account names could have those stored and rendered. Mitigated partially by React's default escaping of JSX expressions, but any use of `dangerouslySetInnerHTML` or non-React rendering would be vulnerable.
- **Confidence Level:** High

### 4.4 QIF Parser Content Handling

- **Status:** Inconclusive
- **Location:** `backend/src/import/qif-parser.ts`
- **Confidence Level:** Medium

The QIF parser truncates field values to defined limits (`FIELD_LIMITS` at lines 78-89) but does not strip HTML tags from parsed content. The parsed payee names, memo fields, and category names from the QIF file itself (not just the mapping DTOs) are passed through to entity creation. The `@SanitizeHtml()` decorator is applied at the DTO level for normal CRUD operations, but QIF-parsed values bypass this layer since they originate from the file content string, not from individual DTO fields.

### 4.5 No File Download/Serve Endpoints

- **Status:** Not Detected
- **Confidence Level:** High

No file download, static file serving, or file retrieval endpoints exist. No path traversal risk on file retrieval.

---

## 5. API Security

### 5.1 Authentication Coverage

- **Status:** Not Detected (comprehensive)
- **Confidence Level:** High

All 25+ controllers were reviewed. Every controller except `HealthController` and select `AuthController` endpoints applies `@UseGuards(AuthGuard('jwt'))` at the class level. The health endpoints (GET-only liveness/readiness probes) are intentionally public. The MCP controller uses custom PAT (Personal Access Token) validation instead of JWT, which is appropriate for its non-browser API context.

All service methods derive `userId` from `req.user.id` (JWT payload). No controller accepts `userId` from request body or path parameters. All `:id` path parameters use `ParseUUIDPipe`.

### 5.2 CORS Configuration -- Null Origin Bypass

- **Status:** Present
- **Location:** `backend/src/main.ts:61`
- **Attack Vector:** The CORS callback allows requests with no `origin` header (`if (!origin) return callback(null, true)`). While intended for mobile apps and CLI tools, this means any request without an Origin header (e.g., from server-side scripts, certain browser extensions, or sandboxed iframes using `sandbox` attribute without `allow-same-origin`) will bypass CORS checks entirely.
- **Impact:** Low. CORS is not a primary security control -- authentication (JWT) and CSRF protection provide the actual defense. However, in combination with other vulnerabilities (e.g., if CSRF were bypassed), this could widen the attack surface.
- **Confidence Level:** Medium

### 5.3 Rate Limiting

- **Status:** Not Detected (well-implemented)
- **Location:** `backend/src/app.module.ts:68-75,106`
- **Confidence Level:** High

Comprehensive rate limiting via `@nestjs/throttler`:
- Global default: 100 requests per 60 seconds
- Auth endpoints (login, register, 2FA, reset-password): 5 per 15 minutes
- Forgot-password: 3 per 15 minutes
- AI endpoints: 3-5 per minute depending on endpoint
- MCP endpoints: 30 per minute
- PAT creation: 10 per minute
- Health endpoints: Excluded via `@SkipThrottle()` (appropriate)

### 5.4 Security Headers

- **Status:** Not Detected (well-configured)
- **Location:** `backend/src/main.ts:28-42`
- **Confidence Level:** High

Helmet is configured with: `X-Frame-Options: DENY`, HSTS (2 years, includeSubDomains, preload), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, CSP (`default-src: 'none'`, `frame-ancestors: 'none'`). Default helmet headers also set `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### 5.5 SQL Injection

- **Status:** Not Detected
- **Confidence Level:** High

All database queries use TypeORM QueryBuilder with parameterized bindings (`$1`, `$2`, `:paramName`) or TypeORM repository methods. ILIKE search parameters are properly escaped for PostgreSQL wildcards (`%`, `_`, `\`) at `transactions.service.ts:253-264`. No string interpolation into SQL detected.

### 5.6 Swagger/API Documentation Exposure

- **Status:** Not Detected (properly gated)
- **Location:** `backend/src/main.ts:94-103`
- **Confidence Level:** High

Swagger documentation is conditionally enabled only when `NODE_ENV !== "production"`. The MCP controller uses `@ApiExcludeController()` to hide from Swagger regardless.

### 5.7 Global DTO Whitelist Enforcement

- **Status:** Not Detected (properly configured)
- **Location:** `backend/src/main.ts:82-88`
- **Confidence Level:** High

The global `ValidationPipe` uses `whitelist: true` and `forbidNonWhitelisted: true`, preventing mass assignment attacks across all endpoints.

---

## Summary Table

| # | Finding | Area | Status | Confidence | Severity |
|---|---------|------|--------|------------|----------|
| 1.2 | CSRF token not session-bound | CSRF | Present | High | Medium |
| 2.1 | No global exception filter | Error Handling | Present | Medium | Low |
| 2.2 | Raw error messages in logs | Error Handling | Present | Medium | Low |
| 3.3 | Inconsistent bcrypt salt rounds (10 vs 12) | Cryptography | Present | High | Medium |
| 3.4 | Legacy static salt for TOTP key derivation | Cryptography | Present | High | Low |
| 4.3 | Missing @SanitizeHtml() on import DTOs | File Upload | Present | High | Medium |
| 4.4 | QIF-parsed values bypass HTML sanitization | File Upload | Inconclusive | Medium | Medium |
| 5.2 | CORS allows null-origin requests | API Security | Present | Medium | Low |

### Areas with No Issues Detected

- CSRF double-submit cookie pattern with timing-safe comparison
- Cookie attributes (SameSite, Secure, HttpOnly) correctly set
- @SkipCsrf() usage justified on all exempted endpoints
- All state-changing endpoints covered by CSRF guard
- All tokens use crypto.randomBytes() (no Math.random())
- AES-256-GCM encryption with per-encryption random salt and IV
- JWT secret minimum 32 characters enforced at startup
- TOTP DTOs properly validate 6-digit numeric codes
- No deprecated crypto algorithms (no MD5, SHA-1, DES, ECB)
- Token expiry and rotation (refresh token families, replay detection)
- No file upload to disk; in-memory processing only
- File size limits enforced at multiple layers
- No file download/serve endpoints
- Authentication guards on all non-public controllers
- userId derived from JWT on all service methods
- ParseUUIDPipe on all :id route parameters
- Parameterized SQL queries throughout
- Rate limiting on all sensitive endpoints
- Security headers properly configured via Helmet
- No eval(), new Function(), or dynamic code execution
- No dangerouslySetInnerHTML in reviewed frontend code
- Global ValidationPipe with whitelist enforcement
