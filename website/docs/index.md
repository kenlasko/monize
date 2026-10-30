# Monize Documentation

Welcome to the Monize documentation -- your guide to managing personal finances with Monize, a modern replacement for Microsoft Money.

---

## What is Monize?

Monize is a self-hosted, web-based personal finance management application. It provides a full suite of tools for tracking your income, expenses, investments, and net worth -- all from a modern, responsive web interface that works as well on a phone as on a desktop, in the language and number format you prefer.

### Key Features

**Accounts and transactions**

- **Multi-Account Support** -- Track chequing, savings, credit cards, loans, mortgages, lines of credit, investments, cash, and assets. See [Accounts](accounts.md)
- **Transactions** -- Splits, transfers, tags, attachments, reconciliation, an advanced search (`payee:costco -cat:gas`, `amount:50..100`), columns you can sort and hide, and a month calendar view with daily balances and day notes. See [Transactions](transactions.md)
- **Attachments and Document Scanning** -- Attach receipts and statements to transactions, scan a paper receipt with your phone's camera, and preview files without downloading them
- **Transaction Rules** -- Fill in the category, payee, description and tags automatically as transactions arrive, split a row or turn it into a transfer, or send it to the AI review inbox
- **Recurring Transactions** -- Schedule bills, deposits, and transfers with flexible recurrence options and a cash flow forecast. See [Bills and Deposits](bills-and-deposits.md)
- **Loans and Mortgages** -- Annuity, Canadian fixed-rate, linear and interest-only mortgages, rate history, amortization schedules, overpayment scenarios, and bank debits that settle an installment directly
- **Categories, Payees and Tags** -- A category hierarchy, payees with contact details and an optional lookup, and flexible cross-category tags (e.g., "Vacation 2026", "Tax Deductible"). See [Categories and Payees](categories-and-payees.md) and [Tags](tags.md)

**Getting data in**

- **Transaction Import** -- Import CSV, OFX/QFX, and QIF files with smart column auto-matching, saved presets, automatic payee matching, OFX re-imports that skip rows already imported, and full-file multi-account QIF support. See [Importing Transactions](importing-transactions.md)
- **Bank Sync** -- Pull booked transactions straight from your bank through Open Banking (Enable Banking), with a preview before anything is imported
- **Email Receipts** -- Read order confirmations from a Gmail, Microsoft 365 or any IMAP mailbox and turn them into itemized transactions matched to what your bank already shows, including brokerage trade confirmations. See [Email Receipts](email-receipts.md)
- **Microsoft Money Full-File Import** -- Read a `.mny` file directly: accounts, transactions, transfers, splits, investments, price history, exchange rates and scheduled bills, with every balance reconciled against the file afterwards. See [Importing from Microsoft Money](importing-from-microsoft-money.md)
- **Quicken Migration** -- Bring your history across from Quicken through QIF. See [Importing from Quicken](importing-from-quicken.md)
- **Share Into Monize** -- Send files from your phone's or computer's share menu straight to a new transaction, the import wizard or the AI Assistant

**Planning and analysis**

- **Investment Portfolio Tracking** -- Brokerage accounts, holdings, cost basis, portfolio performance and automatic price updates, plus government bonds valued from their terms of issue. See [Investments](investments.md)
- **Smart Budgets** -- Budgets generated from your spending history, with velocity tracking and proactive alerts. See [Budgets](budgets.md)
- **Comprehensive Reporting** -- Nearly 50 built-in reports across 10 categories, including a Cash Flow Sankey and debt payoff projections, plus a custom report builder with charts. See [Reports](reports.md)
- **Customizable Dashboard** -- Widgets for net worth, spending, upcoming bills, budgets, portfolio value, the cash flow forecast and more. See [Dashboard](dashboard.md)
- **Multi-Currency** -- Accounts in any currency, with exchange rates updated automatically and totals converted into your home currency. See [Currency Management](currency-management.md)
- **Warranties** -- Keep each purchase's warranty with its documents and claims, add one from a transaction, get reminded before it expires, and import from Warracker. See [Warranties](warranties.md)

**AI**

- **AI Assistant** -- Ask questions about your finances in plain language, get spending insights, and review AI-proposed changes in an inbox before they are applied. See [AI](ai.md)
- **MCP Integration** -- Connect Claude Desktop or other MCP clients directly to your financial data. See [AI](ai.md)

**Sharing, safety and administration**

- **Shared Access and Joint Accounts** -- Give a spouse, accountant or bookkeeper scoped access to chosen accounts, or share an account jointly so it appears in the other person's own account list. See [Shared Access](shared-access.md)
- **Emergency Access** -- Designate trusted contacts who automatically receive a magic link to take over your account if you go inactive for an extended period. See [Emergency Access](emergency-access.md)
- **Encrypted Backups** -- Manual and scheduled backups encrypted with your own password by default, restorable from Settings, with optional off-site copies to S3 storage or email and a de-identified support backup for bug reports. See [Backup and Restore](backup-and-restore.md)
- **Notifications** -- Choose per type whether you are told by email, browser push (no third-party service needed), UnifiedPush or only in the notification bell, with reminders you can repeat or stop. See [Settings and Security](settings-and-security.md)
- **Security** -- Two-factor authentication with backup codes, single sign-on (OIDC), "Remember Me" extended sessions, password breach checking, account lockout, refresh token rotation, rate limiting, and comprehensive security headers. See [Settings and Security](settings-and-security.md)
- **Multiple Languages** -- Display the interface in your preferred language with locale-aware date, number, and currency formatting and right-to-left layout support. See [Language](settings-and-security.md#language)
- **Guided Tours** -- Short walkthroughs of the main features, available any time from Settings
- **Self-Hosted** -- Your financial data stays on your own server, in Docker or on Kubernetes, with an admin area for users, notifications and automatic backups
- **Progressive Web App** -- Installable on desktop and mobile for a native app-like experience with its own window, home screen icon, and cached app shell. See [Installing as a Progressive Web App](getting-started.md#installing-as-a-progressive-web-app)

### Technology Stack

| Component | Technology |
|-----------|------------|
| Frontend  | Next.js (React), Tailwind CSS |
| Backend   | NestJS (Node.js/TypeScript) |
| Database  | PostgreSQL 16 |
| Deployment | Docker Compose, Kubernetes (Helm) |

---

## Quick Navigation

| I want to... | Go to... |
|--------------|----------|
| Set up Monize for the first time | [Getting Started](getting-started.md) |
| Install Monize on my phone or desktop as an app | [Getting Started](getting-started.md#installing-as-a-progressive-web-app) |
| Import transactions from my bank | [Importing Transactions](importing-transactions.md) |
| Migrate from Quicken | [Importing from Quicken](importing-from-quicken.md) |
| Migrate from Microsoft Money | [Importing from Microsoft Money](importing-from-microsoft-money.md) |
| Understand the dashboard | [Dashboard](dashboard.md) |
| Create and manage accounts | [Accounts](accounts.md) |
| Record, search, split or reconcile transactions | [Transactions](transactions.md) |
| Create a budget from my spending history | [Budgets](budgets.md) |
| Track my investments | [Investments](investments.md) |
| Set up recurring bills | [Bills and Deposits](bills-and-deposits.md) |
| Turn order confirmation emails into itemized transactions | [Email Receipts](email-receipts.md) |
| Keep track of warranties, receipts and claims | [Warranties](warranties.md) |
| Organize spending with categories and payees | [Categories and Payees](categories-and-payees.md) |
| Label transactions with tags | [Tags](tags.md) |
| Categorize and tag transactions automatically | [Rules](rules.md) |
| Stop a payroll deduction once the year's maximum is reached | [Taxes](taxes.md) |
| Run financial reports | [Reports](reports.md) |
| View debt payoff projections | [Reports](reports.md) |
| Hold accounts in more than one currency | [Currency Management](currency-management.md) |
| Ask AI about my finances | [AI](ai.md) |
| Get spending insights | [AI](ai.md) |
| Connect Claude Desktop to Monize | [AI](ai.md) |
| Configure my preferences, notifications or security settings | [Settings and Security](settings-and-security.md) |
| Back up or restore my data | [Backup and Restore](backup-and-restore.md) |
| Set up automatic backups for everyone on my server | [Backup and Restore](backup-and-restore.md#automatic-backups) |
| Encrypt my backups before syncing to cloud storage | [Backup and Restore](backup-and-restore.md#encrypted-backups) |
| Send a maintainer my data without revealing my finances | [Backup and Restore](backup-and-restore.md#support-backup-share-a-bug-report-safely) |
| Share my accounts with a spouse, accountant, or family member | [Shared Access](shared-access.md) |
| Share a chequing account with my spouse so it shows up in their own account list | [Shared Access > Joint Accounts](shared-access.md#joint-accounts) |
| Transfer money between my account and one shared with me | [Shared Access > Transfers Between Two People's Accounts](shared-access.md#transfers-between-two-peoples-accounts) |
| Designate a trusted contact to take over my account in an emergency | [Emergency Access](emergency-access.md) |
