# Test Coverage Analysis

## Executive Summary

The monize codebase has **240+ test files** (80 backend, 157 frontend, 3 E2E) with **3,579 total tests** (2,366 backend, 1,213 frontend). Backend unit test coverage is strong at **95.6% statements / 86.5% branches**, well above the 80% project target. Frontend coverage is significantly below target at **53.1% statements / 46.1% branches**. Integration tests exist only as infrastructure -- no implementations. E2E tests cover only 3 basic happy-path scenarios.

### Coverage at a Glance

| Layer | Stmts | Branch | Funcs | Lines | Target | Status |
|-------|-------|--------|-------|-------|--------|--------|
| Backend unit | 95.6% | 86.5% | 96.9% | 95.9% | 80% | PASS |
| Frontend unit | 53.1% | 46.1% | 49.4% | 54.4% | 80% | FAIL |
| Backend integration | 0% | 0% | 0% | 0% | -- | Missing |
| E2E (Playwright) | 3 tests | -- | -- | -- | -- | Minimal |

### Configuration Issue: Coverage Thresholds

CLAUDE.md specifies **80% minimum coverage**. However:
- Backend Jest thresholds are set to **5%** across all metrics (`backend/package.json`)
- Frontend Vitest has **no coverage thresholds at all**

These should be raised to enforce the project standard.

---

## Backend Analysis (95.6% overall)

All 42 services and 19 controllers have test files. Most modules achieve 95-100% coverage. The few gaps worth addressing are below.

### 1. Auth Controller (58.9% statements -- lowest in backend)

The auth controller is the single biggest backend gap. Untested endpoints:

- **OIDC login and callback**: State/nonce generation, cookie handling, user creation/lookup, token pair generation, error handling for provider failures
- **2FA lifecycle**: Setup, confirm, disable, verify endpoints
- **Trusted device management**: List devices, detect current device, revoke individual or all, cookie clearing
- **Refresh token error handling**: Cookie clearing when refresh fails
- **CSRF refresh endpoint**

This is **security-critical** code. OIDC and 2FA bugs could lead to account compromise or lockout.

### 2. JWT Strategy (77.8% statements)

The `extractJwtFromRequest` helper is untested: Bearer token extraction from Authorization header, fallback to httpOnly cookie, and null return when both are missing.

### 3. Reports Service (89.3% statements)

Missing coverage for advanced `FilterGroups` with nested bracket conditions and OR logic, transaction-specific column sorting (DATE, PAYEE, DESCRIPTION, MEMO, CATEGORY, ACCOUNT), and default/unknown metric type handling.

### 4. Import Regular Processor (85.0% statements)

Missing coverage for cross-currency transfer detection and matching, split transfer linking from prior imports, placeholder transaction cleanup, and balance adjustments for currency conversions.

### 5. QIF Parser (85.7% statements)

Missing coverage for ambiguous date format detection (all parts <= 12), M/D'YY format with apostrophe separator, 2-digit year conversion boundary (49 vs 50), EOF handling without ^ terminator, and account name extraction.

### 6. Scheduled Transactions Service (92.9% statements)

Missing coverage for loan payment split recalculation, cron job error handling (partial failures), override date boundary cases, and end date validation.

---

## Frontend Analysis (53.1% overall -- needs significant work)

### Pages with 0% Coverage

Seven full pages have zero test coverage:

| Page | Lines | Risk | Key Untested Functionality |
|------|-------|------|---------------------------|
| **app/bills/page.tsx** | 704 | HIGH | Monthly frequency normalization (DAILY x30, WEEKLY x4.33), calendar grid generation, override confirmation dialogs |
| **app/investments/page.tsx** | 552 | HIGH | Price refresh orchestration with retry, parallel portfolio loading, auto-refresh timing |
| **app/reconcile/page.tsx** | 474 | HIGH | Three-step state machine, floating-point balance calc (`Math.round(x*100)/100`), bulk reconcile affecting 100+ records |
| **app/payees/page.tsx** | 261 | MED | Optimistic state updates, search+pagination reset, sort toggling |
| **app/admin/users/page.tsx** | 233 | MED | Role changes (destructive), user deletion, temporary password display |
| **app/setup-2fa/page.tsx** | 42 | LOW | Redirect when already enabled, completion callback |
| **app/auth/callback/page.tsx** | 87 | MED | OIDC callback handling, conditional routing for password change, error states |

Additionally, **app/import/page.tsx** (1,145 lines) has only **5.3% coverage**. This is the most complex page in the application: multi-file bulk import orchestration, QIF parsing with fuzzy name matching, inline account/category creation, and step-progression logic with conditional steps.

### Components with Critical Gaps

| Component | Stmts | Key Untested Functionality |
|-----------|-------|---------------------------|
| TransferTransactionFields | 7.1% | Cross-currency detection, account filtering, target amount input |
| NormalTransactionFields | 14.3% | Payee/category combobox creation, split button, amount handling |
| SplitTransactionFields | 16.7% | Split editor integration, total validation, row add/remove |
| SelectAccountStep (import) | 13.8% | File-by-file account selection, inline creation, matching confidence |
| TransactionFilterPanel | 23.5% | All filter interactions, favorite accounts, date range, clear filters |
| ScheduledTransactionForm | 27.3% | Frequency selection, due/end date logic, auto-post, reminders |
| TransactionForm | 30.2% | Mode switching (normal/split/transfer), form submission per mode |
| CategoryAutoAssignDialog | 32.8% | Sliders, preview loading, batch apply, select all/none |
| SecuritySection (settings) | 38.5% | Password change, 2FA setup/disable, trusted device management |

### Directory-Level Frontend Coverage

| Directory | Stmts | Branch | Notes |
|-----------|-------|--------|-------|
| app/* (pages) | 0-80% | 0-68% | 7 pages at 0%, import at 5% |
| components/transactions | 35.8% | 47.0% | Core CRUD components undertested |
| components/scheduled-transactions | 38.9% | 34.2% | Form and dialog components weak |
| components/import | 38.9% | 38.4% | Multi-step wizard components weak |
| components/payees | 47.1% | 40.5% | Auto-assign dialog very low |
| components/layout | 56.5% | 41.1% | AppHeader at 43.8% |
| components/investments | 64.2% | 48.8% | Form and list components weak |
| components/reports | 72.1% | 49.9% | Branch coverage consistently low |
| components/ui | 71.7% | 67.8% | CurrencyInput at 42.9%, Pagination at 54.8% |
| hooks | 66.1% | 44.4% | useSwipeNavigation at 32.9% stmts, 9.5% branches |
| lib | 85.2% | 71.4% | exchange-rates at 40.9%, forecast at 65.6% |
| store | 97.0% | 100% | Well tested |
| contexts | 93.2% | 85.0% | Well tested |

---

## Integration and E2E Gaps

### Backend Integration Tests (0 implementations)

The test helper infrastructure exists (`/backend/test/helpers/`) with database setup, auth helpers, and factory functions. The Jest E2E config exists. But **no actual integration test files have been written**.

Critical flows that need integration tests:
1. **Auth lifecycle**: Register -> login -> access protected resource -> refresh token -> logout
2. **Transaction lifecycle**: Create -> update -> split -> transfer -> reconcile -> delete
3. **Import pipeline**: QIF parse -> category mapping -> account matching -> transaction creation -> balance updates
4. **Scheduled transactions**: Create -> auto-post via cron -> balance update -> loan recalculation
5. **Reports**: Create custom report -> execute with filters -> verify aggregation

### E2E Tests (3 files, minimal)

Current Playwright tests cover only registration, login, basic account creation, and basic transaction creation. Missing: import workflow, reconciliation, investments, scheduled transactions, reports, multi-currency operations, admin management, 2FA flows.

---

## Prioritized Recommendations

### Tier 1: Critical (security and data integrity)

1. **Auth controller tests** -- Add 30-40 tests for OIDC, 2FA, trusted devices, refresh token error handling. These are security-critical flows with the lowest backend coverage (58.9%).

2. **Reconcile page tests** -- Floating-point balance calculations and bulk state updates. Precision errors silently prevent reconciliation. The `Math.round(x*100)/100` logic and the three-step state machine need coverage.

3. **Import page tests** -- Multi-file orchestration, fuzzy name matching, conditional step progression. At 5.3% coverage on 1,145 lines, this is the largest untested surface. Bugs cause data loss during onboarding.

4. **Raise coverage thresholds** -- Change backend Jest thresholds from 5% to 80%. Add 80% thresholds to frontend Vitest config. This prevents regression.

### Tier 2: High (core functionality)

5. **Transaction form components** -- TransactionForm (30.2%), TransferTransactionFields (7.1%), NormalTransactionFields (14.3%), SplitTransactionFields (16.7%). These are the most-used UI components.

6. **Bills page tests** -- Monthly calculation normalization and calendar generation.

7. **Investments page tests** -- Price refresh with retry, portfolio loading, symbol filtering.

8. **Backend integration tests** -- Implement auth and transaction lifecycle tests using existing helper infrastructure.

### Tier 3: Medium (improved confidence)

9. **ScheduledTransactionForm** -- Frequency logic, due/end date handling, override creation.

10. **SecuritySection (settings)** -- Password change form, 2FA management UI.

11. **FilterBuilder and TransactionFilterPanel** -- Complex filter state management.

12. **Backend edge cases** -- Cross-currency transfers in import, QIF date parsing, report advanced filtering, loan recalculation in scheduled transactions.

13. **E2E expansion** -- Add Playwright tests for import, reconciliation, investments, and scheduled transactions.

### Tier 4: Low (polish)

14. **useSwipeNavigation** -- Touch gesture state machine (9.5% branch coverage).

15. **lib/exchange-rates.ts** (40.9%) and **lib/forecast.ts** (65.6%) -- API wrappers and date calculations.

16. **Remaining pages** -- payees, admin, setup-2fa, auth callback, report pages.

---

## Quick Wins

These provide the most coverage gain for the least effort:

1. **Page-level smoke tests** for the 7 untested pages: Render with mocked data, verify key elements appear. Estimated +5-8% frontend statement coverage.

2. **Transaction form mode switching**: 3-4 tests covering normal/split/transfer transitions would cover a significant portion of the 70% gap in TransactionForm.

3. **Reconcile balance calculation unit tests**: Isolate the `Math.round(x*100)/100` logic and test with known floating-point problem values (0.1 + 0.2, etc.).

4. **Raise coverage thresholds**: One-line change in `backend/package.json` (5 -> 80) and a few lines in `frontend/vitest.config.ts` to enforce standards in CI.
