# Backend Architecture

## Tech Stack
- **Framework:** NestJS 11 with TypeScript 5.9
- **ORM:** TypeORM 0.3 with PostgreSQL
- **Auth:** Passport.js (JWT + Local strategies), OIDC, bcryptjs, otplib (TOTP)
- **Validation:** class-validator + class-transformer
- **Security:** Helmet, CSRF double-submit, rate limiting (ThrottlerGuard)
- **Email:** Nodemailer
- **Scheduling:** NestJS Schedule (cron jobs)
- **Docs:** Swagger/OpenAPI (enabled in dev/test)
- **Testing:** Jest 30 + Supertest

## Directory Structure
```
src/
  accounts/                # Account CRUD, loan/mortgage amortization, investment pairs
  admin/                   # Admin user management
  auth/                    # JWT, refresh tokens, OIDC, 2FA, password reset, trusted devices
    crypto.util.ts         # AES-256-GCM encrypt/decrypt for TOTP secrets
    jwt.strategy.ts        # Passport JWT strategy (cookie or header)
    local.strategy.ts      # Passport local strategy
  budgets/                 # Budget management
  built-in-reports/        # Pre-defined financial reports
  categories/              # Hierarchical categories (parent/child), default import
  common/                  # Shared code
    decorators/            # @SkipCsrf()
    guards/                # CsrfGuard, RolesGuard
    interceptors/          # CsrfRefreshInterceptor
    csrf.util.ts           # CSRF token generation + cookie options
  currencies/              # Currency + exchange rate management
  database/                # DB initialization, seeding, default categories
  health/                  # Health check endpoint
  import/                  # QIF file import
  net-worth/               # Net worth calculation (monthly snapshots, holdings replay)
  notifications/           # Email service
  payees/                  # Payee CRUD, category suggestions
  reports/                 # Custom report builder + execution
  scheduled-transactions/  # Recurring transactions (bills, deposits)
  securities/              # Securities, holdings, prices, investment transactions
  transactions/            # Core transaction CRUD, splits, transfers, reconciliation
  users/                   # User entities, preferences
  main.ts                  # App bootstrap (ValidationPipe, Helmet, CORS, cookie-parser)
  app.module.ts            # Root module (global guards, TypeORM config)
```

## Module Pattern
Each feature module contains:
```
feature/
  feature.module.ts        # NestJS module definition
  feature.controller.ts    # HTTP endpoints
  feature.service.ts       # Business logic
  entities/                # TypeORM entity definitions
  dto/                     # class-validator DTOs
```

## Key Entities

### User
- UUID PK, email (unique), passwordHash, firstName, lastName
- authProvider (`local`/`oidc`), oidcSubject
- twoFactorSecret (encrypted AES-256-GCM), twoFactorEnabled
- resetToken (SHA-256 hashed), resetTokenExpiry
- role (`user`/`admin`), isActive, lastLogin

### Account
- UUID PK, userId, accountType (enum: CHEQUING, SAVINGS, CREDIT_CARD, LOAN, MORTGAGE, INVESTMENT, CASH, LINE_OF_CREDIT, ASSET, OTHER)
- name, currencyCode, openingBalance, currentBalance
- creditLimit, interestRate
- **Investment:** accountSubType (CASH/BROKERAGE), linkedAccountId
- **Loan:** paymentAmount, paymentFrequency, paymentStartDate, sourceAccountId, principalCategoryId, interestCategoryId
- **Mortgage:** isCanadianMortgage, isVariableRate, termMonths, amortizationMonths, originalPrincipal
- **Asset:** assetCategoryId, dateAcquired
- isFavourite, isClosed, closedDate

### Transaction
- UUID PK, userId, accountId
- transactionDate (DATE type, stored as string to avoid timezone issues)
- amount, currencyCode, exchangeRate
- payeeId, payeeName, categoryId
- referenceNumber, description
- status: UNRECONCILED / CLEARED / RECONCILED / VOID
- isSplit, isTransfer, linkedTransactionId
- parentTransactionId (for splits)

### TransactionSplit
- Links to parent transaction
- categoryId, amount, memo
- transferAccountId, linkedTransactionId (for transfer splits)

### Category
- Hierarchical: parentId, children[]
- userId, name, isIncome, isSystem
- icon, color (hex)
- 130+ default categories with subcategories

### ScheduledTransaction
- Frequency: ONCE, DAILY, WEEKLY, BIWEEKLY, SEMIMONTHLY, MONTHLY, QUARTERLY, YEARLY
- nextDueDate, startDate, endDate
- occurrencesRemaining, totalOccurrences
- autoPost, reminderDaysBefore
- Supports splits and transfers
- Overrides relationship (skip/modify specific occurrences)

### Security / InvestmentTransaction
- Security: symbol (unique per user), name, type, exchange, currencyCode, skipPriceUpdates
- InvestmentTransaction: action (BUY/SELL/DIVIDEND/INTEREST/CAPITAL_GAIN/SPLIT/TRANSFER_IN/TRANSFER_OUT/REINVEST/ADD_SHARES/REMOVE_SHARES), quantity, price, totalAmount
- SecurityPrice: historical end-of-day prices

### RefreshToken
- tokenHash (hashed, not raw), familyId (groups rotations)
- isRevoked, replacedByHash (audit trail), expiresAt

### TrustedDevice
- tokenHash, deviceName (parsed from user-agent), ipAddress
- lastUsedAt, expiresAt (30 days)

## API Endpoints

### Standard CRUD pattern
```
GET    /api/v1/{resource}         - List (with optional filters)
POST   /api/v1/{resource}         - Create
GET    /api/v1/{resource}/:id     - Get one
PATCH  /api/v1/{resource}/:id     - Update
DELETE /api/v1/{resource}/:id     - Delete
```

### Auth endpoints
```
POST   /auth/register             POST   /auth/login
POST   /auth/refresh              POST   /auth/logout
GET    /auth/oidc                 GET    /auth/oidc/callback
POST   /auth/forgot-password      POST   /auth/reset-password
POST   /auth/2fa/setup            POST   /auth/2fa/confirm-setup
POST   /auth/2fa/verify           POST   /auth/2fa/disable
GET    /auth/2fa/trusted-devices  DELETE /auth/2fa/trusted-devices/:id
GET    /auth/csrf-refresh
```

### Specialized endpoints
```
GET    /accounts/summary           - Aggregate stats across accounts
POST   /accounts/loan-preview      - Calculate amortization schedule
POST   /accounts/mortgage-preview  - Calculate mortgage amortization
POST   /accounts/:id/close        POST /accounts/:id/reopen
POST   /transactions/transfer      - Create linked transfer
PUT    /transactions/:id/splits    - Atomic split update
POST   /transactions/:id/clear    POST /transactions/:id/reconcile
GET    /reconcile/:accountId       - Reconciliation data
POST   /reconcile/:accountId       - Bulk reconcile
GET    /categories/tree            - Hierarchical structure
POST   /categories/import-defaults - Bootstrap defaults
```

## Security Architecture

### Authentication
- JWT access tokens (15 min), extracted from `auth_token` cookie or Authorization header
- Refresh token rotation with family tracking and replay detection
- Pessimistic write locking on token refresh (prevents race conditions)
- 2FA pending tokens type-checked to prevent misuse on normal endpoints

### CSRF Protection
- Double-submit pattern: cookie + `X-CSRF-Token` header
- Timing-safe comparison (`crypto.timingSafeEqual`)
- `@SkipCsrf()` decorator for exempt endpoints
- Auto-refresh via `CsrfRefreshInterceptor`

### Rate Limiting
- General: 100 req/min
- Login: 5 req/15 min
- Forgot password: 3 req/15 min
- Token refresh: 10 req/min

### Data Protection
- All queries filter by `userId` (strict tenant isolation)
- Parameterized queries via TypeORM (no SQL injection)
- class-validator with `whitelist: true, forbidNonWhitelisted: true`
- Sensitive fields excluded from responses (`@Exclude()` on passwordHash, etc.)

## Key Patterns

### Service user isolation
```typescript
async findAll(userId: string) {
  return this.repo.find({ where: { userId }, relations: ['relation'] });
}
```

### DTO validation
```typescript
export class CreateAccountDto {
  @IsEnum(AccountType) accountType: AccountType;
  @IsString() @MaxLength(255) name: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) openingBalance?: number;
}
```

### Transaction atomicity
```typescript
await this.dataSource.transaction(async (manager) => {
  await manager.save(Transaction, tx);
  await manager.update(Account, id, { currentBalance: () => `current_balance + ${amount}` });
});
```

### Guards and decorators
- `@UseGuards(AuthGuard('jwt'))` on controllers
- `@Roles('admin')` + `RolesGuard` for admin endpoints
- `@SkipCsrf()` on auth endpoints and safe methods
- `@Throttle()` for per-endpoint rate limits

## Configuration
- **main.ts:** ValidationPipe (global), Helmet, CORS, cookie-parser, 10MB body limit, trust proxy
- **app.module.ts:** TypeORM (PostgreSQL async config), ThrottlerModule, ScheduleModule, global guards
- **API prefix:** `/api/v1`
- **Date handling:** Custom pg type parser returns DATE as string (prevents timezone shifting)
- **Docker entrypoint:** `docker-entrypoint.sh` runs `db-init.js` then `main.js`
