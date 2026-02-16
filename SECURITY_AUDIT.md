# Monize Security Audit Report

**Date:** 2026-02-16
**Target:** Monize v1.1.8 (local Docker deployment)
**Scope:** Backend API (NestJS), Frontend (Next.js), Docker infrastructure
**Method:** Automated + manual black-box penetration testing

---

## Executive Summary

Monize demonstrates a **strong security posture** overall. Authentication, authorization, CSRF protection, and injection defenses are all well-implemented. Out of 50+ individual tests, **8 findings** were identified, none critical. The application follows OWASP best practices for session management, input validation, and access control.

### Findings Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Pagination limit not enforced (100K records returned) | **HIGH** | Fixed |
| 2 | Swagger/OpenAPI docs exposed in development mode | **MEDIUM** | By Design |
| 3 | Stored XSS payloads accepted in database | **MEDIUM** | Fixed |
| 4 | Invalid date/accountIds parameters cause HTTP 500 | **LOW** | Fixed |
| 5 | X-Frame-Options is SAMEORIGIN instead of DENY | **LOW** | Fixed |
| 6 | JSON object coercion in string fields | **LOW** | Fixed |
| 7 | Negative page numbers accepted without validation | **LOW** | Fixed |
| 8 | JWT remains valid for 15 min after logout | **INFO** | By Design |

---

## Finding Details

### FINDING 1: Pagination Limit Not Enforced (HIGH)

**Endpoint:** `GET /api/v1/transactions?limit=N`
**Expected behavior:** Max limit of 200 per request (per code documentation)
**Actual behavior:** `limit=1000000` returns `limit=100000` with all 35,355 transactions in a single response

```
Request:  GET /api/v1/transactions?limit=1000000
Response: {"pagination":{"page":1,"limit":100000,"total":35355,"totalPages":1,"hasMore":false}}
```

Additionally, `limit=0` and `limit=-1` are silently converted to `limit=1` rather than returning a validation error.

**Risk:** An attacker (or misconfigured client) could extract the entire transaction history in a single request. With many users, this becomes a DoS vector as the server serializes and transmits unbounded result sets.

**Recommendation:** Enforce the documented max of 200 in the service layer. Reject `limit <= 0` with a 400 error.

---

### FINDING 2: Swagger/OpenAPI Docs Exposed (MEDIUM)

**Endpoint:** `GET /api/docs` and `GET /api/docs-json`
**Response:** HTTP 200 with full interactive Swagger UI and raw OpenAPI JSON

The OpenAPI spec exposes all endpoints, parameters, DTOs, and schema definitions. While this is expected in development, the `NODE_ENV` check should be verified in production deployments.

**Recommendation:** Confirm Swagger is disabled when `NODE_ENV=production`. Consider adding IP allowlisting if Swagger is needed in staging environments.

---

### FINDING 3: Stored XSS Payloads Accepted (MEDIUM)

**Endpoint:** `POST /api/v1/payees`, `POST /api/v1/categories`
**Payload stored:** `<img src=x onerror=alert(1)>` as a payee name, `<script>alert(document.cookie)</script>` as a category name

```
Request:  POST /api/v1/payees {"name":"<img src=x onerror=alert(1)>"}
Response: 201 Created (stored verbatim)

Request:  GET /api/v1/payees
Response: "name":"<img src=x onerror=alert(1)>"  (returned verbatim)
```

**Current mitigation:** React auto-escapes all JSX output, preventing execution in the browser. The backend CSP blocks inline scripts. These are effective defenses.

**Risk:** If any future rendering path bypasses React's escaping (email notifications, PDF exports, admin dashboards, third-party integrations), the stored payloads would execute. This is a defense-in-depth concern.

**Recommendation:** Sanitize HTML entities on input at the API layer (e.g., strip or encode `<`, `>`, `"`, `'` in user-facing text fields). This provides server-side protection independent of the rendering framework.

---

### FINDING 4: Invalid Date/AccountIds Parameters Cause HTTP 500 (LOW)

**Endpoints:** `GET /api/v1/transactions?startDate=notadate`, `GET /api/v1/transactions?accountIds=<injection>`
**Response:** `{"statusCode":500,"message":"Internal server error"}`

```
Request:  GET /api/v1/transactions?startDate=notadate
Response: HTTP 500 {"statusCode":500,"message":"Internal server error"}
Backend log: DateTimeParseError (PostgreSQL date parsing failure)

Request:  GET /api/v1/transactions?accountIds=00000000-0000-0000-0000-000000000001' OR '1'='1
Response: HTTP 500 {"statusCode":500,"message":"Internal server error"}
```

Invalid values are passed directly to the database query without validation, causing unhandled PostgreSQL exceptions. The error is caught by NestJS's global exception filter (no stack trace exposed to client), but they should return 400. While no data was exfiltrated, the unhandled exceptions reaching the database layer indicate insufficient input validation on query parameters.

**Recommendation:** Add date format validation (`@IsDateString()` or `@IsISO8601()`) and UUID array validation for `accountIds` in the DTO or via custom pipes. All query parameters that reach database queries should be validated before execution.

---

### FINDING 5: X-Frame-Options is SAMEORIGIN (LOW)

**Header:** `X-Frame-Options: SAMEORIGIN`
**Expected:** `DENY`

SAMEORIGIN allows the application to be embedded in iframes on the same origin. Since Monize has no iframe-based features, DENY would be more restrictive.

**Recommendation:** Change Helmet's `frameguard` to `{ action: 'deny' }`.

---

### FINDING 6: JSON Object Coercion in String Fields (LOW)

**Endpoint:** `POST /api/v1/payees`
**Payload:** `{"name":{"$gt":""}}`
**Response:** `201 Created` with `"name":"[object Object]"`

When a JSON object is passed where a string is expected, the API coerces it to `"[object Object]"` instead of rejecting it with a 400 validation error. While the NoSQL `$gt` operator was not executed (this is a SQL database), the lack of type validation means arbitrary objects are accepted in string fields.

**Recommendation:** Add `@IsString()` decorator to all string DTO fields to enforce type checking.

---

### FINDING 7: Negative Page Numbers Accepted (LOW)

**Endpoint:** `GET /api/v1/transactions?page=-1`
**Response:** `200 OK` with transaction data returned

Negative page numbers are accepted without validation. While this doesn't cause data leakage (TypeORM treats it like page 1), it should return a 400 error.

**Recommendation:** Add `@Min(1)` validation to the `page` query parameter.

---

### FINDING 8: JWT Valid After Logout (INFO)

**Scenario:** After calling `POST /api/v1/auth/logout`, the access token JWT remains usable until its natural expiry (15 minutes).

```
1. Login  → auth_token issued (15 min expiry)
2. Logout → refresh_token revoked, cookies cleared
3. Use old auth_token → 200 OK (still works)
4. Use old refresh_token → 401 "Refresh token reuse detected" (correctly blocked)
```

This is a known trade-off of stateless JWTs. The refresh token is correctly revoked, so the attacker window is limited to the remaining JWT lifetime (max 15 minutes). The short JWT expiry mitigates this.

**Recommendation:** Acceptable as-is given the 15-minute window. For higher-security requirements, consider a Redis-backed token blacklist or reducing JWT TTL to 5 minutes.

---

## Passed Tests (No Vulnerabilities Found)

### Authentication (9/9 Passed)

| Test | Result | Details |
|------|--------|---------|
| Brute force protection | **PASS** | Rate limited at 5 attempts/15min. All 6 attempts returned 429. |
| Account enumeration (login) | **PASS** | Same "Invalid credentials" for valid and invalid emails |
| Account enumeration (registration) | **PASS** | Generic "Unable to complete registration" for existing email |
| Account enumeration (forgot-password) | **PASS** | Identical response for existing and non-existing emails |
| Password reset token brute force | **PASS** | Invalid token returns 400 "Invalid or expired reset token" |
| JWT tampering (invalid signature) | **PASS** | Returns 401 Unauthorized |
| JWT alg:none attack | **PASS** | Returns 401 Unauthorized |
| Weak password registration | **PASS** | Rejects with specific validation errors (min 8 chars + complexity) |
| Invalid refresh token | **PASS** | Returns 401 "Invalid refresh token" |

### Authorization (5/5 Passed)

| Test | Result | Details |
|------|--------|---------|
| Unauthenticated access | **PASS** | All protected endpoints return 401 |
| IDOR (cross-user data) | **PASS** | User2 gets 403 "Access denied to this account" for User1's data |
| Privilege escalation | **PASS** | Non-admin user gets 403 "Forbidden resource" on admin endpoints |
| Path traversal | **PASS** | ParseUUIDPipe rejects with 400 "uuid is expected" |
| Non-UUID path params | **PASS** | Same ParseUUIDPipe protection |

### CSRF Protection (2/2 Passed)

| Test | Result | Details |
|------|--------|---------|
| Missing CSRF token | **PASS** | Returns 403 "Missing CSRF token" |
| Wrong CSRF token | **PASS** | Returns 403 "Invalid CSRF token" |

### Injection (4/4 Passed)

| Test | Result | Details |
|------|--------|---------|
| SQL injection (search) | **PASS** | Returns empty results (parameterized queries) |
| SQL injection (UNION) | **PASS** | Returns empty results |
| Prototype pollution | **PASS** | Extra properties stripped by `forbidNonWhitelisted` validation |
| Command injection (QIF import) | **PASS** | Input treated as literal text, not executed |

### Session Management (4/4 Passed)

| Test | Result | Details |
|------|--------|---------|
| Refresh token rotation | **PASS** | New token issued on each refresh |
| Refresh token replay detection | **PASS** | Reusing old token returns "Refresh token reuse detected" |
| Post-logout token invalidation | **PASS** | Refresh tokens revoked; old JWT rejected after expiry |
| Cookie flags | **PASS** | HttpOnly on auth/refresh tokens, SameSite=Strict on refresh |

### CORS (1/1 Passed)

| Test | Result | Details |
|------|--------|---------|
| Evil origin rejected | **PASS** | No CORS headers returned for `http://evil.com`. Only `localhost:3001` whitelisted. |

### API Abuse Prevention (5/5 Passed)

| Test | Result | Details |
|------|--------|---------|
| Mass assignment | **PASS** | Extra fields (`role`, `isActive`, `mustChangePassword`) rejected with 400 |
| Large payload (1MB) | **PASS** | Rejected by field validation: "name must be shorter than or equal to 100 characters" |
| Large payload (10MB) | **PASS** | Rejected at transport: 413 Payload Too Large |
| Rate limiting (general) | **PASS** | 100 req/min enforced. Request 101+ returns 429 with `Retry-After` header |
| HTTP method fuzzing | **PASS** | TRACE returns 404, unsupported methods rejected |

### Information Disclosure (3/3 Passed)

| Test | Result | Details |
|------|--------|---------|
| Health endpoint | **PASS** | Returns only `{"status":"ok","timestamp":"...","checks":{"database":"healthy"}}` |
| Error messages | **PASS** | No stack traces, internal paths, or database details exposed |
| Security headers | **PASS** | CSP, HSTS, X-Content-Type-Options, COOP, CORP all present |

---

## Security Architecture Assessment

### Strengths

1. **Defense in depth**: Multiple layers (validation pipes, guards, CSRF, rate limiting, Helmet)
2. **Token security**: Refresh token rotation with family-based replay detection and pessimistic DB locks
3. **Input validation**: Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` blocks mass assignment
4. **CSRF protection**: Double-submit cookie pattern with timing-safe comparison
5. **Password security**: bcrypt hashing, minimum complexity requirements, reset token hashing (SHA-256)
6. **User isolation**: All data queries filter by `userId` from the JWT, not user-supplied values
7. **OIDC security**: Email verification required before account linking
8. **2FA implementation**: TOTP with encrypted secrets, trusted device management, force-2FA option
9. **Admin protection**: Last-admin deletion prevention, role changes require admin guard

### Cookie Configuration

| Cookie | HttpOnly | Secure (prod) | SameSite | MaxAge |
|--------|----------|---------------|----------|--------|
| auth_token | Yes | Yes | Lax | 15min |
| refresh_token | Yes | Yes | Strict | 7 days |
| csrf_token | No (by design) | Yes | Lax | 7 days |
| trusted_device | Yes | Yes | Lax | 30 days |

### Security Headers Present

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ...
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
```

---

## Recommendations (Priority Order)

### High Priority
1. **Fix pagination limits** - Enforce max 200 records per request in the transactions service. Add `@Min(1)` and `@Max(200)` to the `limit` DTO field. Reject `limit <= 0` with a 400.

### Medium Priority
2. **Sanitize stored text** - Strip or encode HTML entities in payee names, category names, transaction descriptions, and other user-facing text fields at the API input layer. Consider `sanitize-html` or escaping `<`, `>`, `"`, `'` characters.
3. **Validate all query parameters** - Add `@IsDateString()` or `@IsISO8601()` for date params, UUID array validation for `accountIds`, `@Min(1)` for `page`, and `@IsString()` for all string DTO fields. No unvalidated query parameter should reach the database layer.

### Low Priority
4. **Change X-Frame-Options to DENY** - Update Helmet configuration: `frameguard: { action: 'deny' }`.
5. **Verify Swagger disabled in production** - Add an integration test or CI check that confirms `/api/docs` returns 404 when `NODE_ENV=production`.

---

## Test Environment

- **Backend**: NestJS running in Docker (monize-backend), Node.js 20
- **Database**: PostgreSQL 16 (monize-postgres)
- **Frontend**: Next.js running in Docker (monize-frontend)
- **openid-client**: v6.8.2
- **Test data**: 35,355 transactions, 1 admin user
- **Tools**: curl, manual JWT crafting, Docker exec

---

## Cleanup

All test artifacts were removed after testing:
- Pentest user account (pentest@test.com) deleted
- XSS test payees and categories deleted
- 2FA re-enabled for admin account
- Temporary cookie/JSON files removed
