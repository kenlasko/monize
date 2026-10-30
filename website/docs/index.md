# Monize Documentation

Welcome to the Monize documentation -- your guide to managing personal finances with Monize, a modern replacement for Microsoft Money.

---

## What is Monize?

Monize is a self-hosted, web-based personal finance management application. It provides a full suite of tools for tracking your income, expenses, investments, and net worth -- all from a modern, responsive web interface.

### Key Features

- **Multi-Account Support** -- Track chequing, savings, credit cards, loans, mortgages, investments, cash, lines of credit, and assets
- **Investment Portfolio Tracking** -- Full brokerage account support with automatic price updates from Yahoo Finance
- **Recurring Transactions** -- Schedule bills, deposits, and transfers with flexible recurrence options
- **Smart Budgets** -- Auto-generated budgets from spending history with velocity tracking and proactive alerts
- **Comprehensive Reporting** -- 40+ built-in reports across 10 categories plus a custom report builder with charts
- **Multi-Currency** -- Support for 8+ currencies with automatic exchange rate updates
- **Multiple Languages** -- Display the interface in your preferred language with locale-aware date, number, and currency formatting and right-to-left layout support. See [Language](settings-and-security.md#language)
- **Tags** -- Flexible cross-category labels for transactions (e.g., "Vacation 2026", "Tax Deductible", "Reimbursable")
- **Transaction Import** -- Import CSV, OFX/QFX, and QIF files with smart column auto-matching, saved presets, automatic payee matching, and full-file multi-account QIF support
- **Email Receipts** -- Read order confirmations from a Gmail, Microsoft 365 or any IMAP mailbox and turn them into itemized transactions matched to what your bank already shows. See [Email Receipts](email-receipts.md)
- **Warranties** -- Keep each purchase's warranty with its documents and claims, add one from a transaction, get reminded before it expires, and import from Warracker. See [Warranties](warranties.md)
- **Microsoft Money Full-File Import** -- Read a `.mny` file directly: accounts, transactions, transfers, splits, investments, price history, exchange rates and scheduled bills, with every balance reconciled against the file afterwards. See [Importing from Microsoft Money](importing-from-microsoft-money.md)
- **AI Assistant** -- Ask questions about your finances in plain language and get spending insights
- **MCP Integration** -- Connect Claude Desktop or other MCP clients directly to your financial data
- **Debt Tracking** -- Debt payoff timeline projections, loan amortization schedules, and payment analysis for loans and mortgages
- **Security** -- Two-factor authentication with backup codes, "Remember Me" extended sessions, password breach checking, account lockout, refresh token rotation, rate limiting, and comprehensive security headers
- **Emergency Access** -- Designate trusted contacts who automatically receive a magic link to take over your account if you go inactive for an extended period
- **Encrypted Backups** -- Optionally wrap manual and scheduled backups in an AES-256-GCM envelope keyed by your password, safe for off-site or cloud storage
- **Self-Hosted** -- Your financial data stays on your own server
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
| Import transactions from my bank | [Importing Transactions](importing-transactions.md) |
| Migrate from Quicken | [Importing from Quicken](importing-from-quicken.md) |
| Migrate from Microsoft Money | [Importing from Microsoft Money](importing-from-microsoft-money.md) |
| Understand the dashboard | [Dashboard](dashboard.md) |
| Create and manage accounts | [Accounts](accounts.md) |
| Track my investments | [Investments](investments.md) |
| Create a budget from my spending history | [Budgets](budgets.md) |
| Set up recurring bills | [Bills and Deposits](bills-and-deposits.md) |
| Label transactions with tags | [Tags](tags.md) |
| Run financial reports | [Reports](reports.md) |
| View debt payoff projections | [Reports](reports.md) |
| Ask AI about my finances | [AI](ai.md) |
| Get spending insights | [AI](ai.md) |
| Connect Claude Desktop to Monize | [AI](ai.md) |
| Back up or restore my data | [Backup and Restore](backup-and-restore.md) |
| Set up automatic backups | [Backup and Restore](backup-and-restore.md) |
| Encrypt my backups before syncing to cloud storage | [Backup and Restore](backup-and-restore.md#encrypted-backups) |
| Configure security settings | [Settings and Security](settings-and-security.md) |
| Share my accounts with a spouse, accountant, or family member | [Shared Access](shared-access.md) |
| Share a chequing account with my spouse so it shows up in their own account list | [Shared Access > Joint Accounts](shared-access.md#joint-accounts) |
| Transfer money between my account and one shared with me | [Shared Access > Transfers Between Two People's Accounts](shared-access.md#transfers-between-two-peoples-accounts) |
| Designate a trusted contact to take over my account in an emergency | [Emergency Access](emergency-access.md) |
