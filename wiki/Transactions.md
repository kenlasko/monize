# Transactions

Transactions are the core of your financial data in Monize. This page covers creating, searching, filtering, and managing transactions.

---

## Table of Contents

- [Overview](#overview)
- [Creating a Transaction](#creating-a-transaction)
- [Transaction List](#transaction-list)
- [Searching and Filtering](#searching-and-filtering)
- [Split Transactions](#split-transactions)
- [Transfers Between Accounts](#transfers-between-accounts)
- [Editing and Deleting Transactions](#editing-and-deleting-transactions)
- [Transaction Status](#transaction-status)

---

## Overview

The Transactions page provides a comprehensive view of all your financial transactions across all accounts. It supports advanced filtering, search, and density controls for efficient data management.

![Transactions Page](images/transactions-page.png)
<!-- Screenshot: The transactions page showing the list, filter panel, and summary card -->

---

## Creating a Transaction

1. Navigate to **Transactions**
2. Click **Add Transaction** (or use the quick-add button)
3. Fill in the transaction form:

![Transaction Form](images/transaction-form.png)
<!-- Screenshot: The transaction creation form showing all fields -->

### Transaction Fields

| Field | Required | Description |
|-------|----------|-------------|
| **Date** | Yes | The date of the transaction |
| **Account** | Yes | Which account this transaction belongs to |
| **Payee** | No | Who the transaction was with |
| **Amount** | Yes | The transaction amount (negative for expenses, positive for income) |
| **Category** | No | The expense or income category |
| **Memo** | No | Additional notes or description |
| **Reference** | No | Cheque number or reference code |
| **Status** | No | Unreconciled, Cleared, or Reconciled |

### Quick Payee Creation

If the payee does not exist, you can create a new one directly from the transaction form without leaving the page.

---

## Transaction List

The transaction list displays your transactions in a table with the following columns:

| Column | Description |
|--------|-------------|
| **Date** | Transaction date |
| **Account** | Account name |
| **Payee** | Who the transaction was with |
| **Category** | Assigned category (or "Split" if multiple categories) |
| **Memo** | Transaction notes |
| **Amount** | Transaction amount (red for expenses, green for income) |
| **Balance** | Running balance for the account |
| **Status** | Reconciliation status indicator |

### Display Density

You can adjust the display density to fit more or fewer transactions on screen:

- **Compact** -- Smaller rows, more transactions visible
- **Normal** -- Default spacing
- **Comfortable** -- Larger rows, easier to read

### Pagination

Transactions are paginated at 50 per page. Use the pagination controls at the bottom of the list to navigate between pages.

---

## Searching and Filtering

The filter panel provides powerful options for finding specific transactions.

![Transaction Filters](images/transaction-filters.png)
<!-- Screenshot: The filter panel showing account, category, payee, date range, and search filters -->

### Available Filters

| Filter | Description |
|--------|-------------|
| **Accounts** | Filter by one or more accounts |
| **Account Status** | Show active or archived accounts |
| **Categories** | Filter by one or more categories |
| **Payees** | Filter by one or more payees |
| **Date Range** | Set start and end dates |
| **Search** | Free-text search across payee, memo, and reference fields |

### Filter Persistence

Your filter selections are saved in your browser's local storage, so they persist between sessions. When navigating from a report, the report's filters are applied via URL parameters and override your saved filters temporarily.

---

## Split Transactions

A split transaction distributes a single payment across multiple categories. For example, a supermarket purchase might be split between "Groceries" and "Household Supplies."

### Creating a Split

1. In the transaction form, click **Split**
2. Add multiple category/amount rows
3. Each row has its own category, amount, and optional memo
4. The split amounts must total the transaction amount
5. Click **Save**

![Split Transaction](images/split-transaction.png)
<!-- Screenshot: The split transaction interface showing multiple category/amount rows -->

Split transactions display "Split" in the category column of the transaction list. Click on the transaction to see the full breakdown.

---

## Transfers Between Accounts

Transfers move money between your accounts (e.g., from chequing to savings).

### Creating a Transfer

1. In the transaction form, select the **source account**
2. Instead of choosing a category, select **Transfer to account**
3. Choose the **destination account**
4. Enter the amount
5. Click **Save**

Monize creates two linked transactions -- one in each account. The source account shows a withdrawal and the destination shows a deposit.

### Cross-Currency Transfers

If the source and destination accounts are in different currencies, you may need to adjust the exchange rate or amounts after import. See [Currency Management](Currency-Management.md) for details.

---

## Editing and Deleting Transactions

### Editing

Click on any transaction in the list to open it in the edit form. Modify any field and click **Save**.

### Voiding

Voiding a transaction reverses its effect on the account balance but preserves the record for audit purposes. The transaction amount is set to zero and the status changes to **Void**.

### Deleting

Deleting permanently removes a transaction. This action cannot be undone. The account balance is adjusted accordingly.

> **Caution:** If the transaction is part of a linked transfer, deleting it will also affect the linked transaction in the other account.

---

## Transaction Status

Each transaction has a reconciliation status:

| Status | Icon | Description |
|--------|------|-------------|
| **Unreconciled** | (blank) | New transaction, not yet verified against a statement |
| **Cleared** | C | Verified to match a bank statement entry |
| **Reconciled** | R | Locked as part of a completed reconciliation |
| **Void** | V | Cancelled, zero-amount record preserved |

The status flow is typically: **Unreconciled** -> **Cleared** -> **Reconciled**

You can change the status from the transaction list by clicking the status indicator, or during the account reconciliation process. See [Account Reconciliation](Accounts.md#account-reconciliation) for details.
