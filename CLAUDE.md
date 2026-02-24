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

#### React act() Warnings (Frontend)

Components with async `useEffect` hooks (e.g., API calls on mount) will cause `act(...)` warnings if `render()` is called without flushing those updates. **Always wrap initial render in `act(async () => { ... })` for components that fetch data on mount.**

Pattern: create a helper per test file and use it for every test:

```typescript
async function renderMyComponent() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MyComponent />);
  });
  return result!;
}
```

- Use `await renderMyComponent()` instead of bare `render(<MyComponent />)` in every test
- For user interactions that trigger async state updates (e.g., clicking a button that fetches data), wrap the event in `act(async () => { fireEvent.click(...); })`
- The `afterEach` flush pattern (`await act(async () => {})`) does NOT fix warnings that occur during test execution — it only helps with cleanup-phase updates
- Tests that intentionally check loading/skeleton states with never-resolving mocks still need the `act()` wrapper to flush other effects (like `getStatus()`)

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
- [x] CSP unsafe-inline: Replaced with nonce-based CSP via proxy.ts; added object-src 'none'
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

### File Upload / Import Security Audit (Feb 2026)

#### Architecture (Secure by Design)
- No traditional file uploads (no multer/multipart/FileInterceptor)
- QIF content sent as string in JSON POST body, processed in-memory
- No files written to disk or stored on the server
- No files served from web-accessible directories
- No external tool processing (no ImageMagick, sharp, ffmpeg, etc.)
- No stored XSS risk: React auto-escapes JSX, no dangerouslySetInnerHTML
- All database operations use parameterized TypeORM queries

#### Fixed
- [x] dateFormat field in ImportQifDto validated against enum via @IsIn(): Previously accepted any string up to 50 chars, cast `as any` to parser
- [x] @IsNotEmpty() added to ParseQifDto.content and ImportQifDto.content: Empty strings previously passed @IsString() + @MaxLength() validation
- [x] QIF parser field truncation to match DB column limits: payee (255), referenceNumber (100), memo (5000), category (255), security (255) - prevents DB errors from crafted QIF content
- [x] accountType in AccountMappingDto validated against AccountType enum via @IsIn(): Previously accepted any string
- [x] securityType in SecurityMappingDto validated against allowed values via @IsIn(): Previously accepted any string
- [x] Removed unsafe `as any` cast on dateFormat in import service: Now uses proper DateFormat type

### Dependency Audit (Feb 2026)

#### npm audit: All three packages (backend, frontend, e2e) report 0 vulnerabilities.

#### Credential & Secret Management: SECURE
- All sensitive values externalized to environment variables via ConfigService
- .gitignore properly excludes .env files (only .env.example committed)
- JWT_SECRET enforces minimum 32-character length at startup
- Helm/K8s configs use secretRef pattern, no hardcoded secrets
- All external API URLs use HTTPS
- Demo credentials (seed.service.ts) are known and documented

#### Fixed
- [x] axios minimum version bumped to ^1.13.5 in backend and frontend: CVE-2026-25639 (DoS via __proto__ in mergeConfig) affects <=1.13.4. Lockfiles already resolved to 1.13.5 but package.json floor allowed vulnerable 1.13.4
- [x] @hookform/resolvers upgraded from v3 to v5 (5.2.2): Replaced custom zodResolver wrapper with official resolver that natively supports Zod v4. Extracted z.config({ jitless: true }) CSP config to dedicated zodConfig.ts

#### Action Required
- [ ] openid-client v5 to v6 migration: v5 EOL is April 30, 2026. v6 is a complete API rewrite (ESM-only, functional API). No CVEs in v5 currently, but security patches end at EOL. Migration requires rewriting the OIDC authentication module

#### Monitoring (no action needed now)
- [ ] passport ^0.7.0 / passport-jwt ^4.0.1 / passport-local ^1.0.0: All on latest versions but ecosystem shows low maintenance activity (passport-local last released 12 years ago). No CVEs. Deeply embedded in NestJS auth pattern
- [ ] class-transformer ^0.5.1: Latest version, no CVEs, but inactive maintenance (no releases in 12+ months). Required by NestJS ecosystem
- [ ] react-hot-toast ^2.6.0: No releases since April 2023. No CVEs. Consider migrating to sonner if React 19 compatibility issues arise
- [ ] source-map-support ^0.5.21 (dev): Unmaintained (~4 years). Consider replacing with Node.js built-in --enable-source-maps

#### Verified Current (no issues)
- NestJS ecosystem: All packages on latest (11.x)
- bcryptjs ^3.0.3: Latest, no CVEs, actively maintained
- otplib ^13.2.1: Latest major, no CVEs, uses audited crypto deps
- helmet ^8.1.0: Latest, actively maintained
- lodash override 4.17.23: Correctly patches CVE-2025-13465 (prototype pollution)
- typeorm ^0.3.28: Latest, CVE-2025-60542 (SQL injection) only affects MySQL, not PostgreSQL
- nodemailer ^8.0.1: Latest, CVE-2025-14874 and CVE-2025-13033 patched in v8.x
- next ^16.1.6: All known CVEs patched (including critical CVE-2025-66478 RCE)
- react/react-dom ^19.2.4: All known CVEs patched (including CVE-2025-55182 RCE)
- zod ^4.3.6, zustand ^5.0.11, tailwindcss ^4.1.18: All current
- All dev dependencies current with no known CVEs

### AI Module Security Audit (Feb 2026)

#### Fixed
- [x] SSRF via baseUrl: User-supplied baseUrl for Ollama/OpenAI-compatible providers had no validation. Added IsSafeUrl validator that rejects private/internal IPs (127.x, 10.x, 172.16-31.x, 192.168.x, ::1), cloud metadata endpoints (169.254.169.254), .internal/.local hostnames, non-HTTP(S) protocols, and URLs with embedded credentials
- [x] Uncaught JSON.parse in OpenAI tool arguments: OpenAI provider's completeWithTools parsed tool call arguments with bare JSON.parse, which would throw on malformed LLM output and crash the request. Wrapped in try/catch with empty-object fallback
- [x] Uncaught JSON.parse in Ollama streaming: Ollama provider's stream method parsed NDJSON lines without try/catch. Malformed chunks from the Ollama server would throw and terminate the stream. Added try/catch with continue
- [x] No per-user config limit: Users could create unlimited AI provider configurations (DoS/storage abuse). Added MAX_CONFIGS_PER_USER = 10 limit enforced in createConfig
- [x] Prototype pollution via config DTO: The config field (JSONB) accepted arbitrary nested objects including __proto__/constructor keys. Added IsSafeConfigObject validator that restricts to flat objects with primitive values only (max 20 keys)
- [x] Error message leakage in testConnection: Raw provider error messages (including internal URLs, API key validation messages, stack traces) were returned to the client. Now logs internally and returns generic message
- [x] Error message leakage in complete(): When all providers fail, raw error messages from each provider were concatenated and returned to the client. Now logs the details server-side and returns generic message
- [x] Error message leakage in SSE streaming: The catch block in streamQuery forwarded raw error.message to the SSE event stream. Now logs internally and sends generic error
- [x] Error message leakage in AI query iterations: Provider errors during tool-use iterations were forwarded to the client. Now logs internally and returns generic message
- [x] Unbounded priority field: priority had @Min(0) but no upper bound, accepting arbitrarily large integers. Added @Max(100)

#### Verified Secure (no action needed)
- Authentication: Both AiController and AiQueryController use class-level @UseGuards(AuthGuard("jwt")). All endpoints derive userId from req.user (JWT)
- Authorization/IDOR: All service methods take userId from JWT and filter queries with userId. No cross-user data access possible
- MustChangePasswordGuard: Applied globally via APP_GUARD, covers AI endpoints (no @SkipPasswordCheck on AI controllers)
- SQL injection: All queries in ToolExecutorService use TypeORM QueryBuilder with parameterized bindings (:userId, :startDate, :search, etc.)
- Rate limiting: AI query endpoints have @Throttle 10 req/min, config creation 10 req/min, test connection 5 req/min. Global 100/min also applies
- API key encryption: Uses AES-256-GCM with per-encryption random salt via crypto.scryptSync. AI_ENCRYPTION_KEY minimum 32 chars enforced
- API key exposure: Keys are never returned to client, only masked (last 4 chars) via toResponseDto
- Input validation: AiQueryDto has @IsString + @MaxLength(2000) + @IsNotEmpty + @SanitizeHtml. All DTO fields have appropriate constraints
- Tool execution boundary: ToolExecutorService only executes from a fixed allowlist of 6 tool names (switch/case), no dynamic dispatch
- Tool iteration limit: MAX_ITERATIONS = 5 prevents infinite tool-use loops
- XSS: Frontend uses React JSX (auto-escaped), no dangerouslySetInnerHTML in AI components
- Prompt injection defense: System prompt instructs model to only share aggregated data, never individual transaction details. Tools return aggregates only
- CSRF: Global CsrfGuard covers AI endpoints. Frontend SSE fetch includes X-CSRF-Token header
- ParseUUIDPipe: Applied to all :id parameters in AI controllers

#### Informational (acceptable risk or design notes)
- [ ] Prompt injection is an inherent risk with LLM-based features: System prompt rules (e.g., "never reveal individual transaction details") are advisory, not enforceable. A determined user querying their own data can potentially override these via prompt manipulation. Since users can only access their own data, this is an acceptable risk
- [ ] AI response content is rendered as plain text: If markdown rendering is added later, content sanitization will be needed to prevent stored XSS from LLM outputs
- [ ] Ollama baseUrl defaults to http://localhost:11434: The default is only used when no explicit config exists. In Docker deployments, this typically points to a sibling container. The SSRF validator does not apply to the env-based AI_DEFAULT_BASE_URL (admin-controlled)
- [ ] config JSONB field stores provider settings in plaintext: Values like temperature/maxTokens are non-sensitive. If sensitive values are added in future, they should use the encryption service