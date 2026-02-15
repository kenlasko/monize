# monize Project CLAUDE.md

## Project Overview
This is a comprehensive web-based personal finance management application designed as a modern replacement for Microsoft Money. Built with cutting-edge technologies, it provides all the features needed to manage personal finances, investments, budgets, and financial reporting.

## Critical Rules

### 1. Code Organization

- Many small files over few large files
- High cohesion, low coupling
- 200-400 lines typical, 800 max per file
- Organize by feature/domain, not by type
- Always make sure to update schema.sql with any database modifications
- The development environment is running in Docker

### 2. Code Style

- No emojis in code, comments, or documentation
- Immutability always - never mutate objects or arrays
- No console.log in production code
- Proper error handling with try/catch
- Input validation with Zod or similar
- Reuse code where possible. Use common code for things like currency display, drop-downs, styles etc
- use proxy not middleware because middleware is deprecated

### 3. Testing

- TDD: Write tests first
- 80% minimum coverage
- Unit tests for utilities
- Integration tests for APIs
- E2E tests for critical flows

### 4. Security

- No hardcoded secrets
- Environment variables for sensitive data
- Validate all user inputs
- Parameterized queries only
- CSRF protection enabled
- Ensure we don't undo any security-related improvements when making changes

## Completed Work

### Security Audit & Fixes (Feb 2026)

#### Critical
- [x] C1: Hash password reset tokens with SHA-256 before storing in DB
- [x] C2: Use unique per-user salt for TOTP encryption (not shared JWT_SECRET)

#### High
- [x] H1: Pessimistic write lock on transaction balance updates to prevent race conditions
- [x] H2: OIDC callback catch block — don't leak internal errors to client
- [x] H3: Global ThrottlerGuard (rate limiting on all endpoints)
- [x] H4: Security headers — CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy

#### Medium
- [x] M1: JWT type check — reject 2FA pending tokens on normal endpoints
- [x] M3: Trust proxy configuration for correct client IP behind Docker/nginx
- [x] M4: ParseUUIDPipe on all controller ID params (transactions, scheduled-transactions, categories, accounts, reports)
- [x] M5-M7: DTO validation already solid (whitelist + forbidNonWhitelisted)

#### Additional
- [x] Demo password removed from startup logs
- [x] MaxLength(5000) on QIF import DTO memo/payee fields

### Refresh Token Flow (Feb 2026)
- [x] Short-lived access tokens (15 min) + rotatable refresh tokens (7 days in DB)
- [x] Token family tracking with replay detection (revokes entire family on reuse)
- [x] Transparent frontend refresh with request queuing (no user-visible interruption)
- [x] Refresh token revocation on logout and password reset
- [x] Cron job to purge expired refresh tokens daily
- [x] SSR proxy updated to check for refresh_token cookie alongside auth_token

### Performance Optimizations (Feb 2026)

#### Backend
- [x] Scheduled Transactions N+1 query: ~40 queries per screen load reduced to 3 (batched overrides)
- [x] Category counting: 4 sequential queries parallelized with Promise.all
- [x] Payee getMostUsed/getRecentlyUsed: 2 queries each reduced to 1 (joined defaultCategory in aggregate)
- [x] Report execute: conditional category/payee fetch based on groupBy (avoids over-fetching both)
- [x] Portfolio account batch loading: N individual findOne calls replaced with batch In() query
- [x] Account findAll: canDelete computed via batch GROUP BY queries (eliminated N per-account API calls)

#### Frontend
- [x] HoldingRow memoized with React.memo in GroupedHoldingsList
- [x] Dynamic imports for TransactionForm, PayeeForm, AccountForm (reduced initial bundle)
- [x] Account deletability: removed N sequential API calls, uses canDelete from account list response
- [x] Consolidated 7 localStorage persistence effects into 2 in transactions page

### ZAP Security Scan Fixes (Feb 2026)
- [x] Removed X-Powered-By header (poweredByHeader: false)
- [x] Removed unsafe-eval from CSP script-src
- [x] Added Cross-Origin-Opener-Policy: same-origin
- [x] Added Cross-Origin-Resource-Policy: same-origin
- [ ] CSP unsafe-inline: Required by Next.js for hydration (nonce-based CSP is the only fix, complex)
- [ ] Proxy disclosure: Infrastructure-level fix (reverse proxy config, not app code)

### Security Audit Round 2 (Feb 2026)

#### Fixed
- [x] HTML injection in email templates: User-controlled data (firstName, payee, currencyCode) now escaped via escapeHtml() before interpolation into HTML email bodies
- [x] JWT_SECRET minimum length enforced: Startup now rejects secrets shorter than 32 characters (previously only checked for existence)
- [x] Replaced `new Function()` calculator eval with recursive-descent parser: Eliminates code execution primitive from frontend, CSP-compatible

#### Verified Secure (no action needed)
- SQL injection: All queries use parameterized TypeORM QueryBuilder or parameterized raw queries
- IDOR: All service methods verify userId ownership before returning/modifying data
- Mass assignment: Explicit property mapping used (not Object.assign), forbidNonWhitelisted DTO validation
- Error leakage: Internal errors logged server-side, generic messages returned to clients
- SSRF: External HTTP requests use hardcoded base URLs with encodeURIComponent() on parameters
- XSS: No dangerouslySetInnerHTML usage found in React components
- Authorization: All controllers use @UseGuards(AuthGuard("jwt")), admin routes use @Roles("admin")
- Rate limiting: Global 100 req/min default, stricter limits on auth endpoints (3-5 per 15 min)
- CORS: Properly restricts origins, localhost only allowed in non-production

#### Informational (acceptable risk or design notes)
- [ ] Demo user (demo@monize.com / Demo123!) in seed.service.ts: Known credential in source, seed-only
- [ ] console.log in db-init.ts and seed.service.ts: Logs file paths during startup
- [ ] Refresh token cookie uses path "/": Needed by frontend proxy auth check, restricting would break SSR auth detection
- [ ] Swagger docs exposed in non-production: Intentional for development

### Auth & Accounts Audit (Feb 2026)

#### Fixed
- [x] changePassword did not revoke refresh tokens: Old sessions remained active after password change, allowing continued access from compromised devices
- [x] Admin resetUserPassword did not revoke refresh tokens: Users kept active sessions even after admin-forced password reset
- [x] Admin updateUserStatus (deactivate) did not revoke refresh tokens: Deactivated users could continue using existing sessions until access token expired
- [x] mustChangePassword flag not enforced server-side: Users with admin-assigned temporary passwords could access all endpoints without changing password. Added MustChangePasswordGuard as global guard with @SkipPasswordCheck() on auth, profile, and change-password endpoints
- [x] Self-deletion of last admin account: Users could delete their own account via DELETE /users/account even as the last admin, leaving the system with no administrator
- [x] Email change without password confirmation: updateProfile allowed email changes without verifying current password, enabling account takeover via compromised sessions. Now requires currentPassword when email is being changed
- [x] Missing MaxLength on ChangePasswordDto.currentPassword: Could accept unlimited length input (added @MaxLength(128))
- [x] Missing MaxLength on VerifyTotpDto.tempToken: Could accept arbitrarily large strings (added @MaxLength(2048))
- [x] Missing MaxLength on ForgotPasswordDto.email: No length constraint on email field (added @MaxLength(254) per RFC 5321)

#### Verified Secure (no action needed)
- Authentication guards: All 19 controllers audited; 17 use class-level @UseGuards(AuthGuard("jwt")), 2 intentionally public (health, auth)
- User identity: All endpoints derive userId from req.user (JWT), never from request params/body
- Admin authorization: AdminController uses @UseGuards(AuthGuard("jwt"), RolesGuard) with @Roles("admin") at class level
- ParseUUIDPipe: Applied to all path ID parameters across all controllers
- JWT strategy: Validates signature (HS256), enforces expiration, rejects 2FA pending tokens, checks user active status
- Refresh token rotation: Family-based replay detection with pessimistic write locks
- Password reset tokens: SHA-256 hashed before storage, 1-hour expiry, revokes all refresh tokens
- OIDC: State/nonce validation, email_verified check before account linking, no open redirects
- CSRF: Double-submit cookie pattern with timing-safe comparison, global guard
- Cookie security: httpOnly, secure (production), sameSite (lax/strict), no tokens in localStorage
- Client-side auth: UI-only role checks, all admin enforcement server-side
- Rate limiting: Auth endpoints 3-5 per 15 min, global 100/min