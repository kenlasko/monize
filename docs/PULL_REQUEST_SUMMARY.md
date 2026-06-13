# Pull Request Summary: Quicken Replacements & Optimizations

This branch (`QuickenBranchv1`) contains a comprehensive set of features, performance enhancements, and user experience optimizations designed to establish Monize as a robust, modern replacement for desktop personal finance software like Quicken.

---

## Executive Summary of Features

### 1. Customizable Balance History Chart & Fast Render Optimization
* **Timeframe Presets**: Added report-style timeframe selector buttons (`1M`, `3M`, `6M`, `1Y`, `YTD`, `All Time`, `Custom`) directly to the Balance History chart header, operating independently of the transaction table list dates.
* **Fast Render Toggle**: Added a slide switch to dynamically toggle **Fast Render** (downsampling) mode, persisting user preference in local storage.
* **Backend Query Downsampling**:
  - Automatically calculates the date range difference in the NestJS service.
  - Dynamically downsamples the database results (weekly for ranges > 1 year; monthly for ranges > 3 years) when **Fast Render** is active.
  - Keeps cumulative balances 100% correct by calculating the daily running balances inside a PostgreSQL CTE before downsampling.

### 2. Custom AI Import Instructions & Account Type Coercion
* **Encrypted Custom Instructions**: Users can specify custom AI processing instructions for transactions parsed via the Smart Import tool. Instructions are securely stored in the database using the app-wide encryption key.
* **Account Type Coercion**: The AI-assisted transaction parser now dynamically coerces imported account types to match the destination account type, eliminating manual type discrepancies.

### 3. AI Smart Import Feature
* **Natural Language Parsing**: Users can copy-paste raw, unstructured bank statement text, transaction receipts, or CSV-like dumps and parse them using OpenAI's LLM engine.
* **Account Mapping**: Seamless mapping of AI-parsed data fields into Monize transaction objects with validation before insertion.

### 4. Paycheck Wizard & Category Auto-seeding
* **Paycheck Setup Wizard**: A multi-step wizard to set up recurring paychecks with automatic gross pay, deductions, tax withholdings, and net deposits.
* **Category Auto-seeding**: Auto-populates standard paycheck-related categories (e.g. Gross Salary, Federal Tax, Health Insurance) during user onboarding.

### 5. Split Transaction Enhancements
* **Convert Splits Back to Regular Transactions**: Added a user interface function to collapse split transactions back into regular, single-category transactions seamlessly.

### 6. Tax Line Support
* **Tax Line Assignment**: Added tax-related metadata tracking fields to Categories to match Quicken's schedule-tax grouping feature.

### 7. Support for New Account Types (Phase 1)
* **Expanded Accounts Schema**: Database and controller updates to support additional specialized accounts (e.g. Brokerage, Asset, and Liability accounts) in the transaction import wizard.

---

## Technical Details & Files Changed

### Backend Modifications
* **Daily Balances & Downsampling**:
  - [accounts.controller.ts](file:///h:/AiModelLearning/QuickenReplacements/monize/backend/src/accounts/accounts.controller.ts): Added `@Query('optimize')` parameter.
  - [accounts.service.ts](file:///h:/AiModelLearning/QuickenReplacements/monize/backend/src/accounts/accounts.service.ts): Implemented PostgreSQL filter injection (`EXTRACT(DAY/ISODOW)`) based on range.
  - [accounts.service.spec.ts](file:///h:/AiModelLearning/QuickenReplacements/monize/backend/src/accounts/accounts.service.spec.ts): Added downsampling test coverage.
* **AI Configuration & Security**:
  - Securely reads, writes, and decrypts AI instructions from database configurations.

### Frontend Modifications
* **Balance History UI Card**:
  - [BalanceHistoryChart.tsx](file:///h:/AiModelLearning/QuickenReplacements/monize/frontend/src/components/transactions/BalanceHistoryChart.tsx): Added `ToggleSwitch` for Fast Render and integration with `DateRangeSelector`.
  - [page.tsx](file:///h:/AiModelLearning/QuickenReplacements/monize/frontend/src/app/transactions/page.tsx): Maintained `optimizeChart` state in local storage and appended parameters to api client requests.
  - [accounts.ts](file:///h:/AiModelLearning/QuickenReplacements/monize/frontend/src/lib/accounts.ts): Updated API parameters and deduplication cache key tracking.

---

## Testing & Verification

### Automated Unit Tests
* **Backend Tests**: Verify query parameter parsing, dynamic date bounds resolution, and database interval query correctness.
  - Run with: `npm run test -- src/accounts/accounts.service.spec.ts`
* **Frontend Tests**: Verify interactive renders, loading states, and callback behaviors.
  - Run with: `npx vitest run BalanceHistoryChart.test.tsx`
