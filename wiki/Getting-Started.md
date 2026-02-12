# Getting Started

This guide walks you through setting up Monize and getting your financial data organized.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [First-Time Setup](#first-time-setup)
- [Creating Your First Account](#creating-your-first-account)
- [Navigating the Application](#navigating-the-application)
- [Next Steps](#next-steps)

---

## Prerequisites

Before installing Monize, ensure you have:

- **Docker** and **Docker Compose** installed on your server
- A minimum of 1 GB RAM available
- A modern web browser (Chrome, Firefox, Safari, or Edge)

---

## Installation

### Using Docker Compose (Recommended)

1. Clone the repository:

```bash
git clone https://github.com/your-repo/monize.git
cd monize
```

2. Create a `.env` file with your configuration:

```bash
# Required
JWT_SECRET=your-secret-key-minimum-32-characters-long

# Database (defaults shown)
POSTGRES_USER=monize
POSTGRES_PASSWORD=your-database-password
POSTGRES_DB=monize

# Optional: Email notifications
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASS=your-email-password
```

> **Important:** The `JWT_SECRET` must be at least 32 characters long. The application will refuse to start with a shorter secret.

3. Start the application:

```bash
docker compose up -d
```

4. Access Monize at `http://localhost:3001`

### Using Kubernetes (Helm)

Helm charts are provided in the `helm/` directory for Kubernetes deployments. Refer to the Helm README for detailed configuration options.

---

## First-Time Setup

### Registration

When you first access Monize, you will be presented with the login page.

![Login Page](images/login-page.png)
<!-- Screenshot: The login page showing email/password fields and the Register link -->

1. Click **Register** to create your account
2. Enter your **first name**, **email address**, and **password**
3. Click **Register** to complete account creation
4. You will be redirected to the dashboard

![Registration Page](images/registration-page.png)
<!-- Screenshot: The registration form with first name, email, and password fields -->

### Setting Your Home Currency

After registration, navigate to **Settings** (gear icon in the top-right corner) to configure your home currency. This is the primary currency used for reporting and net worth calculations.

![Settings Page](images/settings-page.png)
<!-- Screenshot: The settings page showing currency selection and user preferences -->

---

## Creating Your First Account

1. Navigate to **Accounts** from the top navigation bar
2. Click **Create Account**
3. Fill in the account details:
   - **Account Name** -- A descriptive name (e.g., "Main Chequing")
   - **Account Type** -- Select from the available types (see [Accounts](Accounts.md) for details)
   - **Currency** -- The currency this account operates in
   - **Opening Balance** -- The starting balance as of a specific date
4. Click **Save**

![Create Account Form](images/create-account-form.png)
<!-- Screenshot: The account creation form showing name, type, currency, and opening balance fields -->

---

## Navigating the Application

The main navigation bar provides access to all major features:

![Navigation Bar](images/navigation-bar.png)
<!-- Screenshot: The top navigation bar showing all menu items -->

### Primary Navigation

| Menu Item | Description |
|-----------|-------------|
| **Transactions** | View, search, and manage all transactions |
| **Accounts** | Manage your accounts and view balances |
| **Investments** | Track your investment portfolio |
| **Bills & Deposits** | Manage scheduled and recurring transactions |
| **Reports** | Access built-in and custom reports |

### Tools Menu

Click the **Tools** dropdown to access additional features:

| Tool | Description |
|------|-------------|
| **Categories** | Manage income and expense categories |
| **Payees** | Manage payee records |
| **Securities** | Manage investment securities |
| **Currencies** | View and manage currencies and exchange rates |
| **Import Transactions** | Import QIF files from Microsoft Money or other software |

![Tools Dropdown](images/tools-dropdown.png)
<!-- Screenshot: The Tools dropdown menu showing Categories, Payees, Securities, Currencies, and Import Transactions -->

### User Menu

The top-right corner shows your name and provides access to:

- **Settings** -- Configure preferences, two-factor authentication, and trusted devices
- **Logout** -- Sign out of the application

---

## Next Steps

Once you have Monize installed and your first account created, here are recommended next steps:

1. **Migrating from Microsoft Money?** Follow the detailed [Importing from Microsoft Money](Importing-from-Microsoft-Money.md) guide
2. **Set up your categories** -- Customize the default categories in [Categories and Payees](Categories-and-Payees.md)
3. **Add your accounts** -- Create all your financial accounts in [Accounts](Accounts.md)
4. **Schedule recurring transactions** -- Set up your bills and regular deposits in [Bills and Deposits](Bills-and-Deposits.md)
5. **Explore reports** -- Check out the [Reports](Reports.md) section to see what insights are available
