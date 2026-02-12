# Test Coverage Analysis

## Current State

| Layer | Framework | Test Files | Tests | Stmt Coverage | Branch Coverage |
|-------|-----------|-----------|-------|---------------|-----------------|
| Backend Unit | Jest | 60 | 1,461 | 82.37% | 66.34% |
| Frontend Unit | Vitest | 154 | 1,058 | 52.68% | 45.43% |
| E2E | Playwright | 3 | ~10 | N/A | N/A |
| Backend Integration | Jest | 0 | 0 | N/A | N/A |

**Backend** meets the 80% statement coverage target overall, but several critical services fall far short. **Frontend** is at 52.68% - well below the 80% target. **Integration tests** have infrastructure in place (helpers, factories, config) but zero actual tests. **E2E tests** cover only the most basic happy paths.

---

## Priority 1: Backend Services with Critical Coverage Gaps

### 1.1 transactions.service.ts - 32.64% line coverage

The most critical gap. This is the largest service (1,935 lines) and the core of the application.

**Untested functionality:**
- `findAll()` - pagination, filtering by category (with children), search, running balance calculation
- `getReconciliationData()` / `bulkReconcile()` - entire reconciliation workflow
- `getSummary()` - transaction aggregation with currency grouping
- Split operations: `getSplits()`, `updateSplits()`, `addSplit()`, `removeSplit()`, `createSplits()`
- `updateTransfer()` - transfer updates with amount/account changes
- Complex `update()` paths: split creation within updates, account changes, VOID transitions
- `deleteTransferSplitLinkedTransactions()` - cascading delete logic
- `triggerNetWorthRecalc()` - debounce mechanism

**Recommended tests:**
- Pagination with various sort/filter combinations
- Category filtering with subcategory inclusion
- Full split transaction lifecycle (create, update, remove splits)
- Reconciliation flow (get data, bulk reconcile, verify balances)
- Transfer updates (change amounts, change accounts, cross-currency)
- Transaction summary aggregation

### 1.2 auth.service.ts - 32.31% line coverage

Critical security code with minimal test coverage (776 lines).

**Untested functionality:**
- `setup2FA()` / `confirmSetup2FA()` / `disable2FA()` - entire 2FA lifecycle
- `findOrCreateOidcUser()` / `validateOidcUser()` - entire OIDC flow
- `refreshTokens()` - replay detection, pessimistic locking, family tracking, token rotation
- `purgeExpiredRefreshTokens()` - cron job cleanup
- Trusted device operations: `createTrustedDevice()`, `validateTrustedDevice()`, `getTrustedDevices()`, `revokeTrustedDevice()`, `revokeAllTrustedDevices()`
- `generateResetToken()` - token generation and SHA-256 hashing
- `resetPassword()` - success path with actual password update
- Login with trusted device bypass of 2FA
- `verify2FA()` - success path with rememberDevice flow

**Recommended tests:**
- 2FA setup, confirmation, and disable flows
- Refresh token rotation with replay detection (reuse of old token revokes entire family)
- OIDC user creation, linking, and update flows
- Trusted device CRUD and validation
- Password reset complete flow (generate token, hash, verify, reset)
- Token purge cron job

### 1.3 accounts.service.ts - 50.17% line coverage

**Untested functionality:**
- `findAll()` - batch canDelete calculation, inactive filtering
- `createInvestmentAccountPair()` - dual account creation and linking
- `createLoanAccount()` - loan setup with amortization schedule generation
- `createMortgageAccount()` - mortgage setup including Canadian mortgage variants
- `previewMortgageAmortization()` / `previewLoanAmortization()` - amortization previews
- `updateMortgageRate()` - rate changes with payment recalculation
- `reopen()` - account reopening
- `getSummary()` - asset/liability categorization, net worth calculation
- Investment pair currency synchronization during updates

**Recommended tests:**
- Investment account pair lifecycle (create, update currency sync, close both)
- Loan creation with amortization schedule verification
- Mortgage creation (standard and Canadian) with payment calculation
- Mortgage rate update with payment recalculation
- Account summary aggregation

### 1.4 currencies.service.ts - 44.68% line coverage

**Untested functionality:**
- `lookupCurrency()` - metadata lookup, Yahoo Finance API fallback
- `searchMetadataByText()` - name/symbol matching and substring search
- `extractCurrencyCode()` - code extraction from forex pairs
- `findAll()` - inactive currency filtering
- `isInUse()` - complex SQL EXISTS validation

**Recommended tests:**
- Currency lookup by name, code, and country
- Yahoo Finance fallback behavior
- Metadata search matching edge cases
- Deletion prevention when currency is in use

---

## Priority 2: Frontend Pages with Zero Coverage

13 pages have 0% test coverage and no test files exist for any of them.

### 2.1 High-impact pages (should be tested first)

| Page | Lines | Complexity | Why It Matters |
|------|-------|------------|----------------|
| `app/bills/page.tsx` | 679 | High | Core feature: scheduled transaction management, calendar/list views, overrides, forecasting |
| `app/import/page.tsx` | 1,224 | Very High | 7-step wizard: file upload, account/category/security mapping, review |
| `app/investments/page.tsx` | 528 | High | Portfolio management: holdings, allocation charts, price refresh |
| `app/reconcile/page.tsx` | ~460 | High | Bank reconciliation: transaction matching, balance confirmation |
| `app/payees/page.tsx` | ~250 | Medium | Payee management: CRUD, category reassignment |
| `app/admin/users/page.tsx` | 234 | Medium | User management: role changes, status toggles, password resets |

### 2.2 Auth-related pages

| Page | Complexity | Why It Matters |
|------|------------|----------------|
| `app/auth/callback/page.tsx` | Medium | OAuth/OIDC callback handler |
| `app/change-password/page.tsx` | Low | Password change form |
| `app/forgot-password/page.tsx` | Low | Password recovery initiation |
| `app/reset-password/page.tsx` | Low | Password reset completion |
| `app/setup-2fa/page.tsx` | Medium | 2FA enrollment |

### 2.3 Reports pages

| Page | Complexity |
|------|------------|
| `app/reports/[reportId]/page.tsx` | Low |
| `app/reports/custom/page.tsx` | Low |
| `app/reports/custom/new/page.tsx` | Low |
| `app/reports/custom/[id]/page.tsx` | Low |
| `app/reports/custom/[id]/edit/page.tsx` | Medium |

---

## Priority 3: Frontend Components with Low Coverage

### 3.1 Transaction Components (7-30% coverage)

The transaction component group has test files but they mostly test initial rendering, not behavior.

**Missing across all transaction components:**
- Form submission and validation error display
- Field-level interactions (typing, selecting, clearing)
- Transaction type switching (normal, transfer, split)
- Multi-currency amount handling
- Payee/category inline creation
- Filter panel: applying and clearing filters
- Pagination controls

**Key files needing more tests:**
- `TransactionForm.tsx` (28.8% stmts) - form submission, validation, type switching
- `SplitEditor.tsx` (41.66%) - split line add/remove, balance validation
- `TransactionFilterPanel.tsx` (23.52%) - filter apply/clear/persist
- `TransferTransactionFields.tsx` (16.66%) - account selection, validation
- `InvestmentTransactionFields.tsx` (7.14%) - investment-specific fields
- `NormalTransactionFields.tsx` (14.28%) - core field interactions

### 3.2 Scheduled Transaction Components (25-46% coverage)

- `ScheduledTransactionForm.tsx` (25.38%) - frequency, occurrence, override creation
- `OverrideEditorDialog.tsx` (46.34%) - override application, date selection
- `PostTransactionDialog.tsx` (41.26%) - posting confirmation, field modifications

### 3.3 Import Components (13-40% coverage)

- `SelectAccountStep.tsx` (13.84%) - account selection, creation, bulk handling
- `ReviewStep.tsx` (36.66%) - summary validation, bulk review
- `CategoryMappingRow.tsx` (40.47%) - category selection, parent handling

### 3.4 Other Low-Coverage Components

- `AppHeader.tsx` (43.75%) - mobile menu, dropdowns, logout, admin visibility
- `CategoryAutoAssignDialog.tsx` (32.78%) - payee-category assignment
- `SecurityForm.tsx` (30.9%) - security CRUD
- `ResetPasswordModal.tsx` (30%) - admin password reset

---

## Priority 4: Missing Test Layers

### 4.1 Backend Integration Tests (0 tests)

Infrastructure exists (`test/helpers/test-database.ts`, `test/helpers/test-factories.ts`, `test/helpers/auth-helper.ts`) but no integration tests have been written.

**High-value integration tests to add:**
- Transaction CRUD through API endpoints with real database
- Transfer creation and balance propagation
- Split transaction lifecycle
- Account creation with opening balance transaction
- Reconciliation workflow end-to-end
- Auth flows: register, login, refresh token, 2FA setup/verify
- Import workflow: upload, map, review, confirm
- Scheduled transaction posting

### 4.2 E2E Tests (3 files, basic happy paths only)

Current E2E tests cover registration, login, basic account creation, and basic transaction creation. They use `waitForTimeout` (flaky) and conditional flows.

**Missing E2E scenarios:**
- Bill/scheduled transaction management
- Import workflow (QIF/CSV file upload through completion)
- Investment portfolio management
- Bank reconciliation
- Report generation and viewing
- Multi-currency operations
- Settings management
- Category management with drag-and-drop reordering
- Password change / 2FA setup

---

## Priority 5: Branch Coverage Gaps

Overall backend branch coverage is 66.34% (vs 82.37% statements). This gap indicates many conditional paths are untested.

**Worst branch coverage in backend:**
- `auth.service.ts` - 16.16% branches
- `transactions.service.ts` - 26.73% branches
- `currencies.service.ts` - 27.08% branches
- `accounts.service.ts` - 36.73% branches
- `import.service.ts` - 68.31% branches

**Worst branch coverage in frontend:**
- `useSwipeNavigation.ts` - 9.45% branches
- `MortgageFields.tsx` - 12% branches
- `app/accounts/page.tsx` - 13.15% branches
- `IncomeExpensesBarChart.tsx` - 15.78% branches
- `SelectAccountStep.tsx` - 12.5% branches

**Common patterns in missing branches:**
- Error handling catch blocks
- Null/undefined guard clauses
- Feature flag / configuration conditionals
- Edge cases in calculations (zero amounts, negative balances)
- Empty state rendering

---

## Recommended Action Plan

### Phase 1: Close Critical Backend Gaps

Focus on the four services below 50% coverage. These are the core of the application and contain security-critical code.

1. Add tests for `transactions.service.ts` targeting splits, reconciliation, and findAll
2. Add tests for `auth.service.ts` targeting 2FA, OIDC, refresh tokens, and trusted devices
3. Add tests for `accounts.service.ts` targeting investment pairs, loans, and mortgages
4. Add tests for `currencies.service.ts` targeting lookup and metadata search

**Target: Bring all four services above 80% statement coverage.**

### Phase 2: Frontend Page Tests

Add test files for the 13 pages currently at 0% coverage, prioritizing by user impact and complexity.

1. `app/bills/page.tsx` - complex state management, calendar views
2. `app/import/page.tsx` - multi-step wizard, file handling
3. `app/investments/page.tsx` - portfolio charts, price refresh
4. `app/reconcile/page.tsx` - reconciliation workflow
5. Auth pages (change-password, forgot-password, reset-password, setup-2fa)
6. `app/payees/page.tsx` and `app/admin/users/page.tsx`
7. Reports pages

**Target: All pages above 50% statement coverage.**

### Phase 3: Deepen Frontend Component Tests

Improve coverage on components that have test files but only test rendering.

1. Transaction form components - add submission, validation, type-switching tests
2. Scheduled transaction components - add frequency, posting, override tests
3. Import step components - add interaction and error tests
4. AppHeader - add mobile menu, dropdown, and auth-state tests

**Target: All components above 60% statement coverage.**

### Phase 4: Backend Integration Tests

Write integration tests using the existing test helpers and factories.

1. Transaction lifecycle (create, update, split, reconcile, delete)
2. Auth flows (register, login, refresh, 2FA, OIDC)
3. Account lifecycle (create various types, close, reopen)
4. Import pipeline

**Target: Cover all critical API endpoints with at least happy-path integration tests.**

### Phase 5: E2E Test Expansion

Expand Playwright tests to cover more user journeys.

1. Import workflow
2. Bills/scheduled transactions
3. Investments
4. Reconciliation
5. Reports

**Target: One E2E test per major feature area.**
