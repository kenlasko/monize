# Accounts

Monize supports a wide variety of account types to represent your complete financial picture. This page covers creating, managing, and organizing your accounts.

---

## Table of Contents

- [Account Types](#account-types)
- [Creating an Account](#creating-an-account)
- [Account List](#account-list)
- [Editing and Closing Accounts](#editing-and-closing-accounts)
- [Account Reconciliation](#account-reconciliation)
- [Favourite Accounts](#favourite-accounts)
- [Investment Account Pairs](#investment-account-pairs)
- [Multi-Currency Accounts](#multi-currency-accounts)

---

## Account Types

Monize supports 10 account types:

| Account Type | Description | Typical Use |
|-------------|-------------|-------------|
| **Chequing** | Checking or current account | Day-to-day banking |
| **Savings** | Savings account | Emergency fund, short-term savings |
| **Credit Card** | Credit card account | Credit card spending and payments |
| **Loan** | Installment loan | Personal loans, auto loans |
| **Mortgage** | Mortgage account | Home mortgage tracking |
| **Investment** | Brokerage account | Stocks, ETFs, mutual funds |
| **Cash** | Cash wallet or petty cash | Physical cash tracking |
| **Line of Credit** | Line of credit | Revolving credit facilities |
| **Asset** | Asset tracking | Property, vehicles, collectibles |
| **Other** | Miscellaneous | Any account that does not fit other types |

### Account Type Details

**Credit Card** accounts include a credit limit field. The available credit is calculated as `credit limit - current balance`.

**Loan and Mortgage** accounts support interest rate tracking. Mortgage accounts include Canadian-specific settings for amortization.

**Investment** accounts are always created as a linked pair -- a brokerage account (for holding securities) and a cash account (for the cash balance within the brokerage). See [Investment Account Pairs](#investment-account-pairs) for details.

**Asset** accounts are used to track the value of physical assets like property or vehicles. Transactions on asset accounts represent changes in value.

---

## Creating an Account

1. Navigate to **Accounts** from the top navigation bar
2. Click the **Create Account** button
3. Fill in the account form:

![Create Account Form](images/create-account-form.png)
<!-- Screenshot: The account creation form showing all fields -->

### Required Fields

| Field | Description |
|-------|-------------|
| **Account Name** | A descriptive name for the account |
| **Account Type** | Select from the available types |
| **Currency** | The currency this account operates in |

### Optional Fields

| Field | Description |
|-------|-------------|
| **Opening Balance** | The starting balance (defaults to 0) |
| **Opening Date** | The date of the opening balance |
| **Credit Limit** | For credit cards only |
| **Interest Rate** | For savings, loans, and mortgages |
| **Notes** | Any additional notes about the account |

4. Click **Save** to create the account

> **Tip:** When importing from Microsoft Money, you do not need to create accounts manually if you plan to create them during the import process. However, creating accounts first gives you more control over the exact names, types, and opening balances.

---

## Account List

The Accounts page displays all your accounts organized by type.

![Accounts List](images/accounts-list.png)
<!-- Screenshot: The accounts list page showing accounts grouped by type with balances -->

Each account entry shows:

- **Account name**
- **Account type** indicator
- **Current balance** in the account's currency
- **Currency code** (if different from your home currency)
- **Actions** -- Edit, close, or delete

### Summary Card

At the top of the accounts page, a summary card shows:

- **Total assets** -- Sum of all positive-balance accounts
- **Total liabilities** -- Sum of all debt accounts
- **Net worth** -- Assets minus liabilities

### Filtering

You can toggle between:
- **Active accounts** -- Currently in use
- **All accounts** -- Including closed/archived accounts

---

## Editing and Closing Accounts

### Editing

Click the edit button on any account to modify its details. All fields from account creation can be updated.

### Closing Accounts

When an account is no longer active (e.g., you closed a bank account), you can close it in Monize:

1. Click the edit button on the account
2. Toggle the **Closed** switch
3. Click **Save**

Closed accounts are hidden from the active accounts view and from transaction dropdowns, but their historical data is preserved for reporting.

### Deleting Accounts

Accounts can only be deleted if they have no transactions. If an account has transactions, you must either delete the transactions first or close the account instead.

---

## Account Reconciliation

Reconciliation helps you verify that your Monize records match your bank statement.

![Reconciliation](images/account-reconciliation.png)
<!-- Screenshot: The reconciliation screen showing cleared and unreconciled transactions -->

### How to Reconcile

1. Navigate to the account you want to reconcile
2. Click **Reconcile**
3. Enter the **statement ending balance** and **statement date** from your bank
4. Review each transaction:
   - **Cleared** transactions match your bank statement
   - **Unreconciled** transactions have not yet appeared on a statement
5. Mark transactions as cleared by clicking on them
6. When the difference is zero, click **Finish Reconciling**

### Transaction Status

| Status | Meaning |
|--------|---------|
| **Unreconciled** | New transaction, not yet on a statement |
| **Cleared** | Matches a bank statement entry |
| **Reconciled** | Previously cleared and locked |
| **Void** | Cancelled transaction |

---

## Favourite Accounts

Mark accounts as favourites to have them displayed on the Dashboard:

1. In the account list, click the star icon next to an account
2. The account will appear in the Favourite Accounts widget on the Dashboard

---

## Investment Account Pairs

When you create an **Investment** type account, Monize automatically creates two linked accounts:

1. **Brokerage Account** -- Holds your securities (stocks, ETFs, mutual funds, etc.)
2. **Cash Account** -- Tracks the cash balance within the brokerage

These are linked internally. When you buy securities, the cash balance decreases. When you sell or receive dividends, the cash balance increases.

The cash account is hidden from the main account list but is accessible through the investment interface. For more details, see [Investments](Investments.md).

> **Important for Microsoft Money users:** In Microsoft Money, investment accounts contain both securities and cash in a single account. In Monize, these are split into two linked accounts. When importing, the QIF parser handles this automatically -- the "Investment" export maps to the brokerage account and the "Regular" export maps to the cash account.

---

## Multi-Currency Accounts

Each account has a designated currency. If you have accounts in different currencies:

- Transactions in that account are recorded in the account's currency
- The Dashboard and reports convert balances to your home currency using the latest exchange rates
- Cross-currency transfers record both amounts and the effective exchange rate

For more details, see [Currency Management](Currency-Management.md).
