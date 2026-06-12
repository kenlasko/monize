# Missing Requirements — Quicken Migration Gaps

This document tracks features present in Quicken that are not currently supported in Monize,
identified during a Quicken-to-Monize migration analysis (June 2026). Each section describes
the Quicken behaviour, the current Monize state, and a suggested approach for implementation.

---

## 1. Tax-Advantaged Account Types (HSA, FSA, DCFSA, 401k, IRA)

### Quicken Behaviour

Quicken supports dedicated account types for US tax-advantaged accounts:

- **HSA** (Health Savings Account) — tracks contributions, qualified medical withdrawals, and investment sub-accounts
- **FSA** (Flexible Spending Account) — tracks employer contributions and spending with forfeiture awareness
- **DCFSA** (Dependent Care FSA) — similar to FSA but for dependent care expenses
- **401(k) / 403(b)** — tracks employee + employer contributions, vesting schedules, investment holdings
- **IRA / Roth IRA** — tracks contributions against annual limits, basis for Roth conversions

Each type carries specific metadata: contribution limits, qualified expense enforcement, tax treatment flags, and IRS form awareness (Form 8889 for HSA, Form 5498 for IRA, etc.).

### Current Monize State

### Impact

- HSA, FSA, DCFSA, IRA, Roth IRA, 401k, 403b accounts are now fully modeled.
- CSV imports auto-detect and suggest the correct account types based on name keywords.
- All account types are supported when creating new destination accounts directly within the transaction import wizard, utilizing fully dynamic localizations.

### Suggested Implementation

1. **Phase 1 — New account types**: [x] Added `HSA`, `FSA`, `DCFSA`, `TRADITIONAL_IRA`, `ROTH_IRA`, `401K`, and `403B` (Implemented: June 2026)
2. **Phase 2 — Metadata fields**: Add optional `contributionLimitYear`, `contributionYTD`,
   `taxYear` fields to the account entity so the UI can warn when approaching limits.
3. **Phase 3 — Import awareness**: [x] Updated `suggestAccountType()` name-matchers to recognize HSA, FSA, DCFSA, IRA, Roth IRA, 401K, and 403B. [x] Expanded the Account Creation dropdown on the Transaction Import wizard to support all 22 account types (including 529, HSA, FSA, etc.) with dynamic translation support (Implemented: June 2026).
4. **Phase 4 — Reporting**: Add a "Tax-Advantaged Accounts" section to net-worth and balance
   reports that groups and labels these accounts separately.

---

## 2. Paycheck Wizard

### Quicken Behaviour

Quicken's Paycheck Wizard is a dedicated multi-step setup flow for modelling a recurring paycheck:

1. **Gross pay entry** — User enters gross salary/hourly amount
2. **Pre-tax deductions** — 401k, HSA, FSA contributions (reduce taxable income)
3. **Tax withholding** — Federal, state, local income tax; Social Security (6.2%); Medicare (1.45%)
4. **Post-tax deductions** — Health/dental/vision insurance premiums, Roth 401k, garnishments
5. **Direct deposit split** — Net pay distributed across one or more bank accounts
6. **Recurring schedule** — Frequency set to biweekly, semimonthly, etc. with auto-post support
7. **Per-paycheck adjustments** — Individual occurrence overrides for bonuses, variable hours,
   or tax adjustments without rebuilding the entire template

The result is a fully split recurring transaction where the gross amount is income, each deduction
is a named split with its own category, and the net deposit automatically reconciles to the
checking account balance.

### Current Monize State

Monize has all the **underlying data primitives** but no wizard UX:

| Capability | Available |
|---|---|
| Recurring scheduled transactions | ✅ |
| Biweekly / semimonthly / every-4-weeks frequencies | ✅ |
| Split transactions with multiple category lines | ✅ |
| Transfer splits (e.g. 401k contribution → investment account) | ✅ |
| Per-occurrence overrides | ✅ |
| Auto-post on due date | ✅ |
| Dedicated paycheck setup wizard | ❌ |
| Pre-built deduction templates (FICA, federal tax, etc.) | ❌ |
| Gross-to-net validation (splits must sum to net deposit) | ❌ |
| W-2 / withholding field labels and structured metadata | ❌ |
| Multi-account direct deposit split (e.g. 80% chequing, 20% savings) | ❌ |

### Current Workaround

A user can manually recreate the result by creating a scheduled transaction with:

- Amount = net take-home pay
- Splits manually entered for each deduction line
- No guardrails — the math must be verified by the user

This is functional but tedious, error-prone, and requires financial knowledge to set up correctly.

### Suggested Implementation

1. **Phase 1 — Paycheck template entity**: Add a `PaycheckTemplate` concept (or reuse
   `ScheduledTransaction` with a `paycheckMetadata` JSON column) that stores named deduction
   lines with their purposes (FEDERAL_TAX, STATE_TAX, FICA_SS, FICA_MEDICARE, HEALTH_INSURANCE,
   DENTAL, VISION, PRE_TAX_401K, ROTH_401K, HSA_CONTRIBUTION, FSA_CONTRIBUTION, etc.).
2. **Phase 2 — Wizard UI**: Multi-step form:
   - Step 1: Employer name, pay frequency, gross pay
   - Step 2: Pre-tax deductions (401k, HSA, FSA) with percentage or fixed amount
   - Step 3: Tax withholding (can pre-fill FICA at fixed rates: 6.2% SS, 1.45% Medicare)
   - Step 4: Post-tax deductions (insurance premiums, etc.)
   - Step 5: Direct deposit destinations (account + percentage/amount)
   - Step 6: Review — shows gross → deductions → net with live validation
3. **Phase 3 — Gross-to-net validation**: The split editor should enforce that all deduction
   splits sum correctly to the net deposit amount, with a real-time balance indicator.
4. **Phase 4 — Paycheck report**: Year-to-date gross pay, taxes withheld, and net pay summary
   useful for tax preparation.

---

## 3. CSV Import — Quicken Column Mapping Gaps

### Quicken Behaviour

Quicken's CSV export includes columns that carry Quicken-specific semantics not present in
standard financial CSV formats:

| Column | Purpose |
|---|---|
| Account | Per-row account routing (multi-account register export) |
| Memo | Transaction memo (maps to Monize Description) |
| Notes | Separate Quicken Notes field (distinct from Memo) |
| Num | Check/reference number |
| Clr | Cleared/reconciled status flag |
| Tax Line Item | Maps the transaction to a specific IRS tax schedule line |
| Downloaded reference | Bank's reference ID from the OFX/QFX feed |
| Downloaded ID | Bank's unique transaction identifier |
| Downloaded payee | Raw payee string from the bank (before Quicken renaming) |
| Downloaded memo | Raw memo from the bank feed |
| Downloaded amount | Signed amount from the bank (may differ from user-edited Amount) |
| Payment | Outflow amount (always positive, represents debits) |
| Cr | Credit/inflow indicator flag |
| Posting Date | Date the transaction cleared/posted at the bank |
| Total | Running account balance after each transaction |

### Current Monize State

[UPDATED - JUNE 2026]

- Added `"payment"` and `"payments"` to debit patterns and three built-in Quicken (US) presets (8-, 9-, and 10-column layouts).
- **Account column** — multi-account CSV import routes rows by account name; Map Source Accounts step + auto-create missing accounts.
- **Notes column** — separate `transactions.notes` field (Memo maps to `description`; Notes stored independently).
- **Num / Clr auto-match** — `referenceNumber` and `reconciliationStatus` patterns include `num` and `clr`.
- **Column conflict warning** — CSV mapping UI warns when the same column index is assigned to multiple fields.
- **Account name matching** — case-insensitive import matching with `checking`/`chequing` synonyms.

### Suggested Implementation

1. **Short-term — Add "Payment" to debit patterns**: [x] (Implemented: June 2026).
2. **Short-term — Quicken presets**: [x] Three presets for single-account, with Account, and with Account + Notes (Implemented: June 2026).
3. **Short-term — Account-column multi-account CSV**: [x] `parseCsvMultiAccount` + import wizard flow (Implemented: June 2026).
4. **Short-term — Separate Notes field**: [x] `transactions.notes` end-to-end (Implemented: June 2026).
5. **Short-term — Memo/notes conflict warning**: [x] Column conflict warning in CSV wizard (Implemented: June 2026).
6. **Medium-term — Posting Date support**: Add an optional `postingDate` field to the
   `CsvColumnMappingConfig` so users can import both transaction date and clearing date.
   Store it on the transaction entity as an optional field.
7. **Long-term — Tax Line Item**: If tax reporting features are added (see requirement 4),
   a `taxLineItem` column mapping could populate a structured tax metadata field on transactions.

---

## 4. Tax Reporting & IRS Schedule Awareness

### Quicken Behaviour

Quicken can tag every transaction with an IRS tax line item (e.g. "Schedule A: Medical",
"Schedule C: Gross receipts", "W-2: Federal tax withheld"). At year-end, it generates a
tax summary report that groups transactions by tax schedule, making it straightforward to
transfer figures to tax software or a CPA.

### Current Monize State

Monize has a `TaxSummaryReport` component file, but no concept of IRS tax schedules or
tax-line mapping on categories or transactions. The `Category` entity has no tax metadata
fields, so the report has nothing to group by. There is no way to distinguish
tax-relevant transactions from general spending at the data model level.

### Impact

- Users migrating from Quicken lose all tax line item associations from imported transactions
- No structured year-end tax summary
- No way to flag categories as tax-deductible or tax-relevant

### Suggested Implementation

1. Add an optional `taxLineItem` field (varchar) to the `Category` entity so a category
   can be associated with a tax schedule line (e.g. "Schedule A: Medical expenses")
2. Wire the existing `TaxSummaryReport` to group transactions by their category's tax line item,
   with date range filtering for a tax year
3. During CSV import, if a `Tax Line Item` column is mapped, store the value in a transaction
   memo or tag so the data is not lost even before full tax line support is built

---

## 5. Transaction Rules & Memorized Payees (Auto-Categorization)

### Quicken Behaviour

Quicken has two complementary automation systems:

- **Memorized Payees** — After seeing a payee once, Quicken stores the category, amount,
  memo, and tags to auto-fill future transactions for that payee.
- **Renaming Rules** — Pattern-based rules that normalize raw bank payee names (e.g.
  "AMZN*AB12CD AMAZ" → "Amazon") before they hit the register. Rules can be based on
  payee name contains/starts-with/equals patterns.
- **Auto-categorization** — When a downloaded transaction's payee matches a memorized payee,
  the category is applied automatically with no user action required.
- **Quick Pay / Bill Pay rules** — Rules can trigger automated payment workflows.

### Current Monize State

Monize has a `Payee` entity with a `defaultCategoryId` field. When a new transaction is
created matching a known payee, the default category is suggested. There is also a
`payee-auto-merge.service.ts` for deduplication and `payee-normalize.util.ts` for name
normalization during import.

**What exists:**

- ✅ Payee default category (single category per payee)
- ✅ Payee name normalization during import
- ✅ AI-powered auto-categorization suggestions (via the `/ai` module)

**What is missing:**

- ❌ **Renaming Rules UI** — No way for users to define custom name-cleaning rules through
  the interface; normalization happens only at import time
- ❌ **Pattern-based rules** — No "if payee contains X, set category to Y and tag to Z"
  rule engine that applies to downloaded/manual transactions at entry time
- ❌ **Default memo/tags per payee** — Only the default category is stored; memo templates
  and default tags are not
- ❌ **Rule priority/ordering** — No concept of rule precedence
- ❌ **Amount-based rules** — No rules conditioned on transaction amount or account

### Suggested Implementation

1. Add a `PayeeRule` entity with fields: `pattern` (contains/starts/equals/regex),
   `patternField` (payee name / memo), `renamePayeeTo`, `categoryId`, `tagIds`, `memoTemplate`
2. Evaluate rules in priority order when a transaction is created or downloaded
3. Build a Rules Manager UI (similar to Gmail filters) where users can create, edit, reorder,
   and test rules against sample transactions

---

## 6. Transaction Attachments & Receipt Storage

### Quicken Behaviour

Quicken allows attaching digital files (photos, PDFs, scans) directly to individual
transactions. On mobile, users can snap a receipt photo and attach it immediately. Attachments
are stored locally in the Quicken data file and synced (up to 3 per transaction) to Quicken's
cloud for mobile access. Transactions can be searched by attachment presence.

### Current Monize State

There is **no attachment or document storage feature** in Monize. No file upload endpoints,
no attachment entity, no UI for photos or PDFs on transactions.

### Impact

- Users cannot digitize and link receipts to transactions
- No paperless record-keeping within the application
- Common use case for expense tracking (especially tax-deductible items) is unsupported

### Suggested Implementation

1. Add a `TransactionAttachment` entity: `id`, `transactionId`, `fileName`, `fileSize`,
   `mimeType`, `storagePath`, `thumbnailPath`, `createdAt`
2. Add a file upload endpoint (`POST /transactions/:id/attachments`) with size limits and
   type validation (images, PDF)
3. Store files on disk or object storage (S3/MinIO); the `.env` already configures storage
4. Add attachment thumbnail strip to the transaction detail view
5. Add attachment count filter to the transaction list

---

## 7. Financial Planning Tools (Lifetime Planner / Retirement / College)

### Quicken Behaviour

Quicken's **Planning** tab includes several forward-looking projection tools:

- **Lifetime Planner** — A full cash-flow simulation model that ingests all accounts,
  debts, incomes, and expenses to project year-by-year net worth through retirement. Supports
  scenario testing ("what if I retire at 60?"), inflation assumptions, and tax-advantaged
  account modelling including RMDs.
- **Retirement Calculator** — Simplified retirement savings trajectory with adjustable return
  rate, contribution level, and retirement age inputs.
- **College Calculator** — Projects whether current 529/savings plan covers future tuition
  at a specified inflation rate, with a deposit schedule to close any gap.
- **Debt Reduction Planner** — Compares debt payoff strategies (avalanche vs. snowball) with
  "what-if" extra-payment scenarios showing interest savings and payoff date.
- **Home Purchase / Major Purchase Planner** — Savings target calculator for large future
  expenditures.

### Current Monize State

Monize has a sophisticated **Monte Carlo simulation** (retirement projection) and a
**Debt Payoff Timeline** report. These partially cover Quicken's retirement and debt planning.

| Quicken Feature | Monize Equivalent | Gap |
|---|---|---|
| Lifetime Planner | Monte Carlo Report | Monize uses probabilistic simulation vs. deterministic cash-flow model; no income/expense integration |
| Retirement Calculator | Monte Carlo (simplified) | Similar scope, different methodology |
| College Calculator | ❌ None | Entirely missing |
| Debt Reduction Planner (avalanche/snowball) | Debt Payoff Timeline Report | Monize has payoff timeline but no strategy comparison |
| Home/Major Purchase Planner | ❌ None | Entirely missing |
| Scenario "what-if" comparison | Monte Carlo scenario comparison | Partial — investment-focused only |

### Suggested Implementation

1. **College Savings Calculator** — Input: child's age, current savings balance, target cost,
   expected tuition inflation rate → Output: projected shortfall and required monthly deposit
2. **Savings Goal Planner** — Generic goal (house down payment, car, vacation, emergency fund)
   with target amount, target date, and linked savings account
3. **Debt Strategy Comparison** — Extend the existing Debt Payoff Timeline to show both
   avalanche and snowball strategies side-by-side with total interest and payoff date comparison
4. **Budget-Integrated Retirement Projection** — Connect Monte Carlo to actual income/expense
   data from the budget and transactions so projections use real numbers rather than manual inputs

---

## 8. Bank / Account Sync (Automatic Transaction Download)

### Quicken Behaviour

Quicken connects directly to thousands of financial institutions using Direct Connect (OFX),
Express Web Connect, or Web Connect to automatically download transactions. Once set up, a
single "One Step Update" fetches new transactions from all linked accounts, matches them to
scheduled transactions, and flags duplicates.

### Current Monize State

Monize is **import-only**. There is no bank connectivity layer. Users must:

1. Log into each bank website/app
2. Export a CSV or OFX/QFX file
3. Upload it manually to Monize's import wizard

There is no automatic sync, no institution credential storage, no background polling.

### Impact

- This is the single largest daily friction point for migrating Quicken users
- Manual exports from multiple accounts daily is not sustainable as a long-term workflow
- Without sync, the application is a manual bookkeeping tool rather than a live financial dashboard

### Suggested Implementation

1. **Phase 1 — Plaid / Finicity integration**: Integrate a bank data aggregator (Plaid is the
   most common in the US/Canada; Finicity/MX are alternatives). This requires:
   - OAuth-based institution linking UI
   - Credential storage (tokenized, not raw passwords)
   - Background sync job (already have cron infrastructure)
   - Duplicate detection against existing transactions
2. **Phase 2 — Institution management UI**: List linked institutions, show last sync time,
   allow re-authentication when tokens expire
3. **Phase 3 — Sync conflict resolution**: When a downloaded transaction partially matches
   a manually entered one, present a merge/confirm dialog

*Note: Bank sync requires a third-party data provider subscription (Plaid: ~$0.30–0.50/connected
account/month). This is a significant infrastructure and cost decision.*

---

## 9. Alerts & Notifications (Beyond Bill Reminders)

### Quicken Behaviour

Quicken supports a rich set of customizable alerts delivered via in-app notifications, email,
SMS, and mobile push:

- Large deposit or withdrawal (threshold-based)
- Account balance falls below a set amount
- Credit card balance exceeds a percentage of the limit
- Bill overdue or upcoming (within N days)
- Unusual spending detected in a category
- Investment price change exceeds a threshold
- Loan/mortgage payment due

### Current Monize State

Monize has **email-only bill reminders** via a daily cron job (`bill-reminder.service.ts`).
The notification is triggered when a manual bill is due within its `reminderDaysBefore` window.
There is:

- ✅ Email bill reminders (configurable per scheduled transaction)
- ❌ No balance alerts (low balance, credit limit threshold)
- ❌ No large transaction alerts
- ❌ No unusual/anomalous spending alerts
- ❌ No investment price alerts
- ❌ No in-app notification center (toast-only, ephemeral)
- ❌ No push notifications (mobile not applicable yet, but no webhook/push infrastructure)
- ❌ No SMS/text notifications

### Suggested Implementation

1. **Alert Rules entity**: `alertType` (BALANCE_LOW, LARGE_TRANSACTION, CREDIT_LIMIT,
   BUDGET_EXCEEDED, etc.), `threshold`, `accountId`, `categoryId`, `deliveryMethod`
2. **Alert evaluation cron**: Run daily (or on each transaction post) to evaluate all active
   alert rules and queue notifications
3. **In-app notification center**: Persistent notification log accessible from the nav bar
   (bell icon), showing unread alerts with mark-as-read functionality
4. **Budget overage alerts**: Trigger when a category reaches 80%/100% of its budget allocation

---

## 10. Mobile Application

### Quicken Behaviour

Quicken provides a companion mobile app (iOS and Android) with:

- View account balances and transaction history
- Enter transactions on the go
- Split transactions
- Snap and attach receipt photos
- View and manage budgets
- Get push notifications for alerts
- Sync changes back to the desktop

### Current Monize State

Monize is a **web application only** (Next.js). It is responsive and can be used in a
mobile browser, but there is no:

- ❌ Native iOS or Android app
- ❌ Camera access for receipt capture
- ❌ Offline mode / PWA with background sync
- ❌ Push notification delivery
- ✅ The web app has a PWA manifest (`manifest.ts`) suggesting PWA intent, but no service
  worker or offline capability has been verified

### Suggested Implementation

1. **PWA enhancement** — Add a service worker for offline transaction entry that syncs when
   connectivity returns; enable "Add to Home Screen" on mobile browsers
2. **React Native app** — A longer-term native app that shares API clients with the web app,
   with camera access for receipt photos and push notification support
3. **Near-term** — Audit and optimize the mobile web experience (touch targets, viewport,
   bottom navigation) so the web app is genuinely usable on phones without a native app

---

## 11. Property & Asset Tracking

### Quicken Behaviour

Quicken allows tracking of real estate, vehicles, and personal property as asset accounts:

- Link a property asset account to a mortgage loan account to track equity
- Optional Zillow integration to auto-update home market value
- Vehicle value tracking (manual or via third-party value lookup)
- Rental property management (income, expenses, tenant tracking — Business & Personal edition)

### Current Monize State

Monize has an `ASSET` account type with `dateAcquired` and `assetCategory` fields. This
provides basic asset tracking. However:

- ✅ Asset account type exists
- ✅ Loan accounts can link to a source account
- ❌ No property-to-mortgage equity tracking UI (linking exists at data level but no dedicated view)
- ❌ No market value update integration (Zillow or similar)
- ❌ No vehicle value tracking
- ❌ No rental property / landlord features

### Suggested Implementation

1. Add an **Equity View** that pairs an asset account with its linked mortgage and shows:
   current market value, outstanding mortgage balance, and calculated equity with trend chart
2. Add a `marketValueSource` field to asset accounts (`MANUAL`, `ZILLOW`, `CUSTOM_API`)
   with a scheduled refresh job for supported providers
3. Rental property tracking is a significant scope expansion better suited to a dedicated
   "Business" tier of the application

### Note on Loan Tracking

Monize's core loan and mortgage tracking is **strong** — see Section 15 for details. The gaps
above are specifically about the property asset ↔ mortgage equity linkage and market value
auto-update, not the loan amortization engine itself.

---

## 12. Data Portability & Export

### Quicken Behaviour

Quicken supports exporting data in multiple formats:

- QIF export (full transaction history per account)
- OFX export
- CSV export (customizable columns, as seen in your export)
- Tax reports exportable to TXF format (importable by TurboTax, H&R Block)
- Reports exportable to PDF or Excel

### Current Monize State

- ✅ CSV export of transactions (per account)
- ✅ Report data viewable in-app with chart export (likely PNG)
- ❌ No QIF or OFX export (import only)
- ❌ No TXF (Tax Exchange Format) export for tax software integration
- ❌ No full database export in a portable format (backup/restore exists but is internal)
- ❌ No PDF export of reports (no server-side PDF generation)
- ❌ No Excel/XLSX export of reports

### Suggested Implementation

1. **QIF/OFX export** — Add export endpoints that convert stored transactions back to QIF/OFX
   format, enabling migration away from Monize if needed (important for user trust)
2. **PDF report export** — Add a print/PDF stylesheet or use a headless PDF library
   (Puppeteer/wkhtmltopdf) to render any report as a downloadable PDF
3. **Excel export** — Add XLSX export to all tabular reports using a library like `exceljs`
4. **TXF export** — Low priority but high value for US tax users; export tax-line-tagged
   transactions in TurboTax-compatible TXF format

---

## 13. Multi-Currency & International Features

### Quicken Behaviour

Quicken (US edition) has limited multi-currency support — primarily for investment securities
traded in foreign currencies. True multi-currency account tracking (holding balances in foreign
currencies) is not a strength of the US edition.

### Current Monize State

Monize has **strong multi-currency support**:

- ✅ Each account has its own `currencyCode`
- ✅ Currency exchange rate fetching and storage
- ✅ Currency Exposure report
- ✅ Investment transactions with `exchangeRate` fields
- This is actually an area where Monize **exceeds** Quicken US.

*No gap identified in this area.*

---

## 14. Summary Priority Matrix

| Requirement | Effort | User Impact | Recommended Priority | Status |
|---|---|---|---|---|
| Add "Payment" to debit patterns (CSV fix) | Very Low | High | 🔴 Immediate | ✅ Completed (June 2026) |
| Quicken CSV built-in preset | Low | High | 🔴 Immediate | ✅ Completed (June 2026) |
| HSA / FSA account types (Phase 1 enum) | Medium | High | 🟠 Near-term | ✅ Completed (June 2026) |
| `suggestAccountType()` keyword update | Very Low | Medium | 🟠 Near-term | ✅ Completed (June 2026) |
| Memo conflict warning in CSV wizard | Low | Medium | 🟠 Near-term | ✅ Completed (June 2026) |
| Account-column multi-account CSV import | Medium | High | 🟠 Near-term | ✅ Completed (June 2026) |
| Separate transaction Notes field (Quicken) | Medium | High | 🟠 Near-term | ✅ Completed (June 2026) |
| Default memo/tags per payee | Low | Medium | 🟠 Near-term | Pending |
| Budget overage email alerts | Medium | High | 🟠 Near-term | Pending |
| In-app notification center | Medium | Medium | 🟠 Near-term | Pending |
| Debt strategy comparison (avalanche vs. snowball) | Medium | High | 🟠 Near-term | Pending |
| Transaction attachments / receipt storage | High | High | 🟡 Medium-term | Pending |
| Paycheck wizard (Phase 1-2) | High | High | 🟡 Medium-term | Pending |
| Gross-to-net split validation | Medium | High | 🟡 Medium-term | Pending |
| Transaction renaming rules engine | High | High | 🟡 Medium-term | Pending |
| Posting Date column support in CSV | Medium | Low | 🟡 Medium-term | Pending |
| Tax line item on Category | Medium | Medium | 🟡 Medium-term | Pending |
| QIF / OFX export | Medium | Medium | 🟡 Medium-term | Pending |
| PDF / Excel report export | Medium | Medium | 🟡 Medium-term | Pending |
| PWA / mobile web improvements | Medium | High | 🟡 Medium-term | Pending |
| Property-to-mortgage equity view | Medium | Medium | 🟡 Medium-term | Pending |
| College savings calculator | Medium | Medium | 🟡 Medium-term | Pending |
| Savings goal planner | Medium | High | 🟡 Medium-term | Pending |
| Tax summary report (wired to categories) | High | Medium | 🟡 Medium-term | Pending |
| Balance low / large transaction alerts | Medium | High | 🟡 Medium-term | Pending |
| `isHidden` account flag (keep separate) | Medium | High | 🟠 Near-term | ✅ Completed (June 2026) |
| `hideInTransfers` account flag | Low | Medium | 🟡 Medium-term | Pending |
| Bank sync via Plaid/aggregator (Phase 1) | Very High | Very High | 🔵 Long-term | Pending |
| HSA contribution limit tracking (Phase 2-4) | High | Medium | 🔵 Long-term | Pending |
| Full paycheck wizard with W-2 metadata | Very High | High | 🔵 Long-term | Pending |
| TXF export for TurboTax | High | Medium | 🔵 Long-term | Pending |
| Market value auto-update for assets | High | Low | 🔵 Long-term | Pending |
| Native mobile app (iOS/Android) | Very High | High | 🔵 Long-term | Pending |
| Rental property / landlord features | Very High | Low | 🔵 Long-term | Pending |

---

## 15. Areas Where Monize Exceeds Quicken

For completeness, here are areas where Monize is ahead of Quicken:

| Feature | Detail |
|---|---|
| **Multi-currency support** | Per-account currencies, live exchange rates, currency exposure report — far stronger than Quicken US |
| **Self-hosted / privacy** | No Intuit/Quicken cloud dependency; full data ownership |
| **Open source** | Auditable, extensible, no vendor lock-in |
| **Multi-user with delegation** | Emergency access and delegate acce
| **Monte Carlo simulation** | Probabilistic retirement modeling more sophisticated than Quicken's deterministic Lifetime Planner |
| **Investment reporting depth** | Sector weightings, geographic allocation, dividend yield growth, realized gains — matches or exceeds Quicken Premier |
| **Modern web UI** | Quicken's desktop UI is aging; Monize's web interface is significantly more modern |
| **Docker / self-hosted deployment** | Easy deployment via Docker Compose, not tied to a single machine |
| **Loan & mortgage tracking** | See detail below — Monize matches or exceeds Quicken in this area |

### Loan, Mortgage & Line of Credit Tracking Detail

Monize has a comprehensive, dedicated loan tracking engine that covers all three major debt types.
This is **not a missing feature** — it is a core strength of the application.

#### Mortgages (`MORTGAGE` account type)

| Feature | Monize | Quicken |
|---|---|---|
| Principal, interest rate, amortization period | ✅ | ✅ |
| Term length (separate from amortization) | ✅ | ✅ |
| Payment frequencies (Monthly, Semi-Monthly, Biweekly, Weekly) | ✅ | ✅ |
| **Accelerated Biweekly / Accelerated Weekly** | ✅ | Limited |
| **Canadian semi-annual mortgage compounding** flag | ✅ | ❌ |
| Variable rate flag | ✅ | ✅ |
| Live amortization preview at account setup | ✅ | ✅ |
| Preview shows: payment amount, first P+I split, total payments, total interest, payoff date, effective annual rate | ✅ | Partial |
| Source account linkage (payment debited from chequing) | ✅ | ✅ |
| Interest category auto-assignment (splits payment into principal + interest) | ✅ | ✅ |
| Full `LoanAmortizationReport` with full schedule | ✅ | ✅ |

#### Car Loans / Personal Loans (`LOAN` account type)

| Feature | Monize | Quicken |
|---|---|---|
| Payment amount + frequency (Weekly, Biweekly, Monthly, Quarterly, Yearly) | ✅ | ✅ |
| First payment date | ✅ | ✅ |
| Live amortization preview (principal/interest split, payoff date) | ✅ | ✅ |
| Source account + interest category linkage | ✅ | ✅ |

#### Lines of Credit (`LINE_OF_CREDIT` account type)

| Feature | Monize | Quicken |
|---|---|---|
| Revolving balance tracking | ✅ | ✅ |
| Credit limit + interest rate fields | ✅ | ✅ |
| No amortization schedule (correct for revolving credit) | ✅ | ✅ |

#### Remaining Small Gaps vs. Quicken

| Gap | Detail |
|---|---|
| Extra payment "what-if" calculator | Quicken lets you model how an extra $X/month changes payoff date and total interest. Not in Monize |
| Debt payoff strategy comparison | Avalanche vs. snowball across all debts — covered in §7 of this document |
| Variable rate history log | Quicken tracks rate changes over time for ARM/variable mortgages; Monize has the flag but no rate-change history |
| Mortgage → property equity UI | Linking exists at data level but no combined equity view — covered in §11 |

---

*Document authored: June 2026*  
*Based on: Quicken Classic Deluxe/Premier feature set vs. Monize v1.x codebase analysis*

---

## 16. Account Display Options & Account Intent

### Quicken Behaviour

Quicken's **Account Details → Display Options** tab provides three per-account display/isolation
flags plus an **Account Intent** classification:

| Setting | What it does |
|---|---|
| **Keep this account separate** | Excludes the account from ALL Quicken reports, graphs, and features. Used for corrupted, archived, or tracking-only accounts that should be invisible to normal analysis while still preserving the data |
| **Hide in transaction entry lists** | Account doesn't appear in "Transfer to/from" dropdowns when entering transactions, preventing accidental transfers into archived or special-purpose accounts |
| **Hide account name in account bar and account list** | Account is completely hidden from the sidebar navigation and account list — still exists and data is intact, just not visible in the UI |
| **Account Intent** (Spending / Saving / Investing / Property & Debt) | Groups accounts in the Account Bar and determines which accounts participate in Cash Flow features and certain summaries |

### Current Monize State

Monize has **strong** coverage of this feature set now:

| Quicken Feature | Monize Equivalent | Gap |
|---|---|---|
| Keep account separate (exclude from all reports) | `keepSeparate: boolean` | [IMPLEMENTED - JUNE 2026] |
| Hide in transaction entry lists | ❌ None | Entirely missing |
| Hide account name in account bar/list | `keepSeparate: boolean` | [IMPLEMENTED - JUNE 2026] |
| Account Intent grouping | `accountType` enum | **Partial** — account type provides implicit grouping but no user-settable intent (Spending vs. Saving) independent of type |

**The "Keep Separate" gap has been fully resolved.** Marking an account as separate will exclude it from all standard listings, net-worth summaries, and reports unless toggled to show.

### Suggested Implementation

1. **`isHidden` flag** — [x] Added `keepSeparate` boolean column mapped to `keep_separate` database column. Excludes from lists, summaries, and reports. Adds showHidden filter toggles. (Implemented: June 2026)
2. **`hideInTransfers` flag** — Prevents the account from appearing in transfer dropdowns
   during transaction entry. Useful for investment cash sub-accounts, old accounts still being
   reconciled, or externally-managed accounts that should not be manual transfer targets
3. **Account Intent grouping** — Add an `accountIntent` field (`SPENDING`, `SAVING`,
   `INVESTING`, `PROPERTY_AND_DEBT`) separate from `accountType`. This allows:
   - Custom sidebar grouping (e.g., an HSA SAVINGS account with intent INVESTING)
   - Cash flow calculations that filter by intent rather than raw account type
   - Compatibility with Quicken data imports that carry intent metadata

### Priority

- `isHidden` / keep-separate flag: [x] Completed (June 2026)
- `hideInTransfers` flag: 🟡 **Medium-term** — quality-of-life improvement for complex setups
- Account Intent grouping: 🔵 **Long-term** — mainly affects sidebar organization
