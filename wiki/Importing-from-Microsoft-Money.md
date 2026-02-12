# Importing from Microsoft Money

This is the complete guide to migrating your financial data from Microsoft Money to Monize. It covers exporting from Microsoft Money, preparing your data, and importing into Monize with the recommended order to ensure transfers and investment data are handled correctly.

---

## Table of Contents

- [Overview](#overview)
- [Part 1: Preparing Microsoft Money for Export](#part-1-preparing-microsoft-money-for-export)
- [Part 2: Exporting from Microsoft Money](#part-2-exporting-from-microsoft-money)
  - [Exporting Regular Accounts](#exporting-regular-accounts)
  - [Exporting Investment Accounts](#exporting-investment-accounts)
  - [File Naming Convention](#file-naming-convention)
- [Part 3: Recommended Import Order](#part-3-recommended-import-order)
- [Part 4: Importing into Monize Step by Step](#part-4-importing-into-monize-step-by-step)
  - [Step 1: Upload QIF Files](#step-1-upload-qif-files)
  - [Step 2: Select Destination Account](#step-2-select-destination-account)
  - [Step 3: Map Categories](#step-3-map-categories)
  - [Step 4: Map Securities](#step-4-map-securities)
  - [Step 5: Map Transfer Accounts](#step-5-map-transfer-accounts)
  - [Step 6: Review and Import](#step-6-review-and-import)
  - [Step 7: Import Complete](#step-7-import-complete)
- [Part 5: Post-Import Steps](#part-5-post-import-steps)
- [Part 6: Troubleshooting](#part-6-troubleshooting)
- [Part 7: What Cannot Be Imported](#part-7-what-cannot-be-imported)

---

## Overview

Microsoft Money uses QIF (Quicken Interchange Format) for data export. Monize includes a comprehensive QIF import wizard that handles:

- Regular banking transactions (chequing, savings, credit cards)
- Investment transactions (buy, sell, dividends, splits, reinvestments)
- Split transactions (multiple categories per transaction)
- Account-to-account transfers
- Category creation and mapping
- Security creation and mapping
- Multi-currency accounts

The import process is designed for bulk operations -- you can import multiple QIF files at once, and the system intelligently coordinates between files to link transfers, reuse categories, and handle cross-references.

---

## Part 1: Preparing Microsoft Money for Export

Before exporting, take these preparatory steps in Microsoft Money to ensure a clean migration.

### 1.1 Note Your Account Details

Create a spreadsheet or list with the following for each account:

| Detail | Example |
|--------|---------|
| Account Name | "Main Chequing" |
| Account Type | Chequing, Savings, Credit Card, Investment, etc. |
| Currency | USD, CAD, GBP, etc. |
| Opening Balance | $1,234.56 |
| Opening Balance Date | January 1, 2005 |

> **Why this matters:** The opening balance and date are critical. For imported accounts to show the correct current balance, the opening balance must be set to the balance as of the first transaction date in the QIF file. Microsoft Money often includes an "Opening Balance" transaction in the QIF export, which Monize detects automatically. However, having this information written down gives you a fallback if the auto-detection does not match.

### 1.2 Clean Up Special Characters

Microsoft Money allows emoji-like icons in category names, payee names, and account names. These icons export as garbled characters in QIF format.

**Before exporting:**
1. Go through your **Categories** and remove any icons or special characters from names
2. Go through your **Payees** and clean up names
3. Go through your **Account** names and ensure they use only standard characters

![Microsoft Money Categories](images/ms-money-categories.png)
<!-- Screenshot: Microsoft Money category list - if you have a screenshot of MS Money's category editor, place it here -->

### 1.3 Open Closed Accounts (if needed)

If you have closed accounts in Microsoft Money that you want to import, you may need to temporarily reopen them -- Microsoft Money may not allow exporting closed accounts.

### 1.4 Make a List of All Accounts

Microsoft Money exports one account at a time, so make a checklist:

```
[ ] Main Chequing (Regular)
[ ] Savings (Regular)
[ ] Visa Credit Card (Regular)
[ ] Emergency Fund (Regular)
[ ] RRSP Brokerage (Investment)
[ ] RRSP Brokerage (Regular - for cash transactions)
[ ] TFSA Brokerage (Investment)
[ ] TFSA Brokerage (Regular - for cash transactions)
[ ] Home (Asset)
```

> **Important for Investment Accounts:** Each investment account requires TWO exports -- one as "Investment" type (for securities transactions) and one as "Regular" type (for cash transactions). Mark both on your checklist.

---

## Part 2: Exporting from Microsoft Money

### Exporting Regular Accounts

Follow these steps for each chequing, savings, credit card, cash, line of credit, and asset account:

**Step 1:** Open Microsoft Money and load your `.mny` file

**Step 2:** Go to **File > Export**

![MS Money File Menu](images/ms-money-file-export.png)
<!-- Screenshot: Microsoft Money File menu with Export highlighted -->

**Step 3:** In the export dialog, select **Loose QIF** format

![MS Money Export Format](images/ms-money-export-format.png)
<!-- Screenshot: The Microsoft Money export format selection dialog showing "Loose QIF" selected -->

> **Always choose "Loose QIF"** -- it carries more information than "Strict QIF," including split transaction details and transfer references.

**Step 4:** Choose a save location (Desktop is easiest) and name the file after the account

**Step 5:** Select **Regular** as the account type

![MS Money Account Type](images/ms-money-account-type-regular.png)
<!-- Screenshot: The Microsoft Money export dialog showing "Regular" account type selected -->

**Step 6:** Select the specific account to export from the account list

**Step 7:** Click **Continue** to export

**Step 8:** Check the account off your list and repeat for the next account

### Exporting Investment Accounts

Investment accounts in Microsoft Money contain two types of data:
- **Investment transactions** (buy, sell, dividend, etc.)
- **Cash transactions** (deposits, withdrawals, fees)

You must export each investment account **twice**.

#### Export 1: Investment Transactions

1. Go to **File > Export**
2. Select **Loose QIF**
3. Name the file with the account name and "-Investment" suffix (e.g., `RRSP-Investment.qif`)
4. Select **Investment** as the account type
5. Select the specific investment account
6. Click **Continue**

![MS Money Investment Export](images/ms-money-export-investment.png)
<!-- Screenshot: The Microsoft Money export dialog showing "Investment" account type selected and an investment account highlighted -->

#### Export 2: Cash Transactions

1. Go to **File > Export** again
2. Select **Loose QIF**
3. Name the file with the account name and "-Regular" suffix (e.g., `RRSP-Regular.qif`)
4. Select **Regular** as the account type
5. Select the same investment account
6. Click **Continue**

### File Naming Convention

Use a consistent naming convention to keep your exports organized. Here is a recommended approach:

```
01-Asset-Home.qif
02-Chequing-Main.qif
03-Chequing-Joint.qif
04-Savings-Emergency.qif
05-Savings-USD.qif
06-CreditCard-Visa.qif
07-CreditCard-Mastercard.qif
08-RRSP-Investment.qif
09-RRSP-Regular.qif
10-TFSA-Investment.qif
11-TFSA-Regular.qif
```

The numeric prefix ensures the files sort in your intended import order. Investment account pairs should be adjacent.

> **Tip:** Keep the filenames matching (or close to) the account names in Microsoft Money. Monize attempts to auto-match QIF files to accounts by filename, so closer names mean less manual mapping during import.

---

## Part 3: Recommended Import Order

The order in which you import your QIF files matters. Monize handles transfers between accounts by matching pending transactions from previously imported files. Importing in the right order ensures transfers are linked correctly and reduces manual cleanup.

### Recommended Order

Import your accounts in this order:

```
1. Asset Accounts
      |
2. Bank Accounts (Home Currency)
      |
3. Bank Accounts (Foreign Currency)
      |
4. Credit Card Accounts
      |
5. Investment Cash Accounts (-Regular exports)
      |
6. Investment Brokerage Accounts (-Investment exports)
      |
7. Line of Credit / Loan Accounts
```

### Why This Order?

| Order | Account Type | Reason |
|-------|-------------|--------|
| **1** | **Asset Accounts** | Assets rarely have transfers to other accounts. Import them first to establish any asset-related categories. |
| **2** | **Bank Accounts (Home Currency)** | These are your primary accounts and typically the source/destination of most transfers. Importing them early means subsequent imports can link transfers to these accounts. |
| **3** | **Bank Accounts (Foreign Currency)** | Foreign currency accounts may have transfers to/from home currency accounts. Importing after home currency accounts ensures the other side of cross-currency transfers already exists. |
| **4** | **Credit Card Accounts** | Credit card payments typically come from bank accounts (already imported). The import will match these transfers to the existing bank transactions. |
| **5** | **Investment Cash Accounts** | Import the "-Regular" (cash) QIF files for investment accounts next. These contain deposits/withdrawals to the investment account's cash balance, often transferred from bank accounts (already imported). |
| **6** | **Investment Brokerage Accounts** | Import the "-Investment" QIF files last among the investment pair. These contain buy/sell/dividend transactions. Monize automatically creates the corresponding cash-side transactions in the linked cash account. |
| **7** | **Line of Credit / Loan Accounts** | These typically receive payments from bank accounts. Import them last to maximize transfer matching. |

### Bulk Import

Monize supports importing multiple QIF files in a single bulk operation. When you select multiple files:

1. Files are processed sequentially in the order listed
2. Categories, payees, and accounts created in file 1 are available for file 2, and so on
3. Transfer matching happens across all files in the batch

**The best approach is to select ALL your QIF files at once** and let Monize process them in order. Use the numeric filename prefix (from the naming convention above) to ensure they sort correctly.

---

## Part 4: Importing into Monize Step by Step

Navigate to **Tools > Import Transactions** to begin the import process.

### Step 1: Upload QIF Files

The upload step presents a drag-and-drop area where you can select your QIF files.

![Upload Step](images/import-upload-step.png)
<!-- Screenshot: The import upload step showing the drag-and-drop area with "Click to select QIF file(s)" text -->

1. Click the upload area or drag your QIF files onto it
2. You can select **multiple files** at once for bulk import
3. Monize parses each file and extracts metadata:
   - Account type detected from the QIF header
   - Number of transactions
   - Date range of transactions
   - Categories found
   - Transfer accounts referenced
   - Securities found (for investment files)

After parsing, you advance to account selection.

> **Pre-Selection:** If you navigate to the import page from a specific account, that account is pre-selected. A blue banner shows "Importing to: [Account Name]".

### Step 2: Select Destination Account

For each QIF file, you need to specify which Monize account the transactions should be imported into.

![Select Account Step](images/import-select-account.png)
<!-- Screenshot: The select account step showing the file info box (filename, transaction count, date range, detected type) and the account dropdown -->

#### File Information

A gray information box shows:
- **File:** The filename being imported
- **Transactions:** Number of transactions found
- **Date Range:** Earliest to latest transaction dates
- **Detected Type:** Account type identified from the QIF header (e.g., Bank, Investment, Credit Card)

#### Selecting an Account

Choose from the **"Import into account"** dropdown. The dropdown shows all compatible accounts:
- For **investment QIF files** (detected type: Investment), only brokerage accounts are shown
- For **regular QIF files**, all non-brokerage accounts are shown

> **Auto-Matching:** Monize attempts to match QIF filenames to account names automatically. If a match is found, it is pre-selected in the dropdown.

#### Creating a New Account

If the destination account does not exist yet:

1. Click **"+ Create new account"**
2. Fill in:
   - **Account name** (e.g., "My Chequing")
   - **Account type** (Chequing, Savings, Credit Card, etc.)
   - **Currency** (USD, CAD, etc.)
3. Click **Create**

![Create Account During Import](images/import-create-account.png)
<!-- Screenshot: The inline account creation form during import showing name, type, and currency fields -->

The new account is created immediately and auto-selected as the destination.

> **Investment accounts:** When you create an Investment type account during import, both the brokerage and linked cash accounts are created automatically.

#### Date Format

If the detected date format does not look correct (e.g., dates seem to be swapped between MM/DD and DD/MM), you can override the date format using the date format dropdown. Monize supports:
- MM/DD/YYYY (US format)
- DD/MM/YYYY (International format)
- YYYY-MM-DD (ISO format)

### Step 3: Map Categories

If the QIF file contains category references, you need to map them to Monize categories.

![Map Categories Step](images/import-map-categories.png)
<!-- Screenshot: The map categories step showing unmatched categories (amber), auto-matched categories (green, collapsed), and loan categories (blue, collapsed) -->

#### Understanding the Display

Categories are displayed in three groups:

1. **Needs Attention** (amber/yellow border) -- Categories that could not be auto-matched. These require your input.
2. **Auto-Matched to Categories** (green, collapsed by default) -- Categories that Monize matched to existing categories. Click to expand and verify.
3. **Auto-Matched to Loan Accounts** (blue, collapsed by default) -- Categories that match loan or mortgage account names, indicating loan payments.

#### Summary Badges

At the top of the list, badges summarize the mapping status:
- **Amber badge:** "[X] need attention" -- categories requiring manual mapping
- **Green badge:** "[X] matched to categories" -- successfully auto-matched
- **Blue badge:** "[X] matched to loans" -- matched to loan accounts

#### Mapping a Category

For each unmatched category, you can:

**Option A: Map to an existing category**
- Select from the dropdown of existing Monize categories

**Option B: Create a new category**
- Enter a new category name
- Optionally select a parent category
- The category is created during import

**Option C: Skip the category**
- Leave unmapped (select "Skip") to import transactions without a category
- You can categorize them later in the Transactions page

#### Loan Category Detection

If a QIF category name matches an existing loan or mortgage account name, Monize detects it as a loan payment. These transactions are imported as transfers to the loan account rather than regular categorized transactions.

If the loan account does not exist yet, you can create it during this step.

### Step 4: Map Securities

This step appears only when importing investment QIF files that contain security references.

![Map Securities Step](images/import-map-securities.png)
<!-- Screenshot: The map securities step showing security mapping rows with lookup buttons, existing security dropdowns, and new security creation fields -->

#### Security Lookup

Monize can look up securities automatically:
- Click **"Lookup"** next to any security to search by name/symbol
- A bulk lookup runs automatically for all securities when you first reach this step
- Lookup results include the security name, symbol, type, and exchange

#### Mapping a Security

For each security, you can:

**Option A: Map to an existing security**
- Select from the "Map to existing" dropdown

**Option B: Create a new security**
- Enter the **symbol** (e.g., "AAPL")
- Enter the **name** (e.g., "Apple Inc.")
- Select the **type** (Stock, ETF, Mutual Fund, Bond, GIC, Cash, Other)
- Enter the **exchange** (e.g., "NYSE", "TSX")

#### Row Status Indicators

Each security row is colour-coded:
- **Green border** -- Ready to import (mapped to existing or new security details filled in)
- **Amber border** -- Needs attention (no mapping selected)

### Step 5: Map Transfer Accounts

This step appears when the QIF file references transfers to other accounts (e.g., `[Savings Account]` notation in QIF).

> **Note:** This step is skipped for investment QIF files. Investment transfers are handled automatically through the linked cash account.

![Map Transfer Accounts Step](images/import-map-accounts.png)
<!-- Screenshot: The map transfer accounts step showing account mapping rows with existing account dropdown and new account creation fields -->

#### Mapping a Transfer Account

For each referenced transfer account:

**Option A: Map to an existing account**
- Select from the "Map to existing" dropdown

**Option B: Create a new account**
- Enter the account name
- Select the account type
- Select the currency

> **Tip:** If you are importing all files in bulk, transfers between imported accounts are linked automatically. You only need to map accounts that are not part of the current import batch.

### Step 6: Review and Import

The review step shows a summary of everything that will happen during import.

![Review Step](images/import-review-step.png)
<!-- Screenshot: The review step showing the summary of files, transaction counts, categories, accounts, and securities to be created -->

#### Single File Import Summary

- **File:** filename.qif
- **Transactions to import:** [count]
- **Target account:** [account name]

#### Bulk Import Summary

- **Files to Import:** List of each file with transaction count and target account
- **Total:** [X] files, [Y] transactions

#### Entity Creation Summary

- **Categories:** Total, mapped, new to create, mapped to loans, new loans to create
- **Transfer Accounts:** Total, mapped, new to create
- **Securities:** Total, mapped, new to create

#### Executing the Import

Click **"Import Transactions"** to begin. The button shows a loading spinner while processing.

For bulk imports, files are processed sequentially. Entities created in earlier files (categories, accounts, payees, securities) are available for subsequent files.

> **Important:** The import runs inside a database transaction. If an error occurs, changes are rolled back -- no partial imports.

### Step 7: Import Complete

After successful import, the complete step shows detailed results.

![Import Complete](images/import-complete-step.png)
<!-- Screenshot: The import complete step showing the green checkmark, summary statistics, and per-file results -->

#### Results Displayed

| Metric | Description |
|--------|-------------|
| **Imported** | Number of transactions successfully imported |
| **Skipped** | Number of duplicate transfers skipped (already existed) |
| **Errors** | Number of transactions that failed to import |
| **Categories created** | New categories added |
| **Accounts created** | New accounts added |
| **Payees created** | New payees added |
| **Securities created** | New securities added |

#### Per-File Results (Bulk Import)

For bulk imports, each file shows its individual results with success/error indicators:
- Green background for files with no errors
- Red background for files with errors, including the first 3 error messages

#### Next Steps

After import, you have two options:
- **"View Investments"** / **"View Transactions"** -- Go directly to see your imported data
- **"Import More Files"** -- Return to the upload step for additional imports

---

## Part 5: Post-Import Steps

After importing all your data, take these steps to verify and finalize your migration.

### 5.1 Verify Account Balances

Compare each account's current balance in Monize against your Microsoft Money records. If balances do not match:

1. Check the opening balance -- it should match the balance as of the first transaction date
2. Look for missing or duplicate transactions
3. Check that transfers between accounts were matched correctly (not doubled)

### 5.2 Review Cross-Currency Transfers

Cross-currency transfers from Microsoft Money may need manual adjustment because the QIF format does not include exchange rate information. Look for transactions with a memo containing *"PENDING IMPORT"* and update the amounts to reflect the actual exchange rates.

### 5.3 Verify Investment Holdings

1. Navigate to **Investments**
2. Check that each holding shows the correct quantity and cost basis
3. Compare against your Microsoft Money portfolio summary
4. If any securities were auto-created (marked with `*` suffix), update their symbols and names

### 5.4 Set Up Security Price Updates

Auto-created securities during import have price updates disabled by default. For each security:

1. Navigate to **Tools > Securities**
2. Edit each security to ensure the correct symbol, exchange, and type
3. Price updates will start automatically once the security has a valid symbol

### 5.5 Review Categories

Navigate to **Tools > Categories** and review the category hierarchy. Categories imported from Microsoft Money use the QIF naming convention (with `/` separating parent and child). You may want to reorganize or rename them.

### 5.6 Set Up Scheduled Transactions

QIF export from Microsoft Money does **not** include scheduled/recurring transactions. You must recreate these manually:

1. Navigate to **Bills & Deposits**
2. Create each recurring bill and deposit
3. See [Bills and Deposits](Bills-and-Deposits.md) for details

### 5.7 Check for Uncategorized Transactions

Run the **Uncategorized Transactions** report (**Reports > Uncategorized Transactions**) to find any transactions that were imported without a category. Assign categories as needed.

### 5.8 Verify Net Worth

Navigate to the Dashboard and check the Net Worth chart. Monize automatically calculates monthly net worth snapshots after import. Compare the trend against your Microsoft Money net worth report.

---

## Part 6: Troubleshooting

### Common Issues

#### "Account type mismatch" Error

**Cause:** Trying to import an Investment QIF file into a non-brokerage account, or a Regular QIF file into a brokerage account.

**Solution:** Make sure you select the correct account type:
- Investment QIF files (-Investment) go into brokerage accounts
- Regular QIF files (-Regular or standard banking) go into non-brokerage accounts

#### Dates Appear Wrong

**Cause:** The date format was detected incorrectly (e.g., MM/DD was interpreted as DD/MM).

**Solution:**
1. Go back to the Select Account step
2. Change the date format dropdown to the correct format
3. The file will be re-parsed with the new format

#### Duplicate Transactions After Import

**Cause:** Importing the same file twice, or transfer transactions appearing in both accounts.

**Solution:**
- Monize skips duplicate transfers when importing the second account
- If duplicates still appear, use the **Duplicate Transaction Finder** report to identify and remove them
- For future imports, always import all related files in a single bulk operation

#### Transfer Not Linked Between Accounts

**Cause:** The transfer accounts were not mapped correctly, or the files were imported in separate sessions.

**Solution:**
- When possible, import all files at once using bulk import
- Check that account names in QIF match the Monize account names
- Manually link unmatched transfers by editing the transactions

#### Investment Securities Not Found

**Cause:** Microsoft Money does not include a security master list in QIF exports.

**Solution:**
1. During the Map Securities step, use the "Lookup" button to search for each security
2. If lookup fails, manually enter the symbol, name, type, and exchange
3. After import, edit any auto-created securities (with `*` suffix) in **Tools > Securities**

#### Opening Balance Incorrect

**Cause:** Microsoft Money's opening balance transaction may not match the expected starting point.

**Solution:**
1. Navigate to **Accounts**
2. Edit the account
3. Adjust the opening balance and opening date to match your records
4. The current balance will be recalculated

#### Cross-Currency Transfer Amounts Wrong

**Cause:** QIF files do not contain exchange rate information.

**Solution:**
1. Search transactions for "PENDING IMPORT" in the memo field
2. Edit each flagged transaction
3. Adjust the amount in the destination account to match the actual transfer amount
4. This correctly sets the effective exchange rate

#### Import Times Out

**Cause:** Very large QIF files (near the 10 MB limit or files with thousands of transactions).

**Solution:**
- The import has a 5-minute timeout
- If a single file is too large, try splitting it into smaller date ranges in Microsoft Money
- Contact Microsoft Money support resources about the historical 500-transaction limit per QIF export

---

## Part 7: What Cannot Be Imported

The QIF format and Microsoft Money export have limitations. The following data must be recreated manually in Monize:

| Data Type | Status | Notes |
|-----------|--------|-------|
| **Account balances** | Auto-detected | Extracted from QIF "Opening Balance" record |
| **Transactions** | Imported | All regular and investment transactions |
| **Categories** | Imported | Created during import mapping |
| **Payees** | Imported | Created automatically from QIF data |
| **Securities** | Imported | Created during import mapping |
| **Scheduled transactions** | Not exported | Must be recreated in Bills & Deposits |
| **Budgets** | Not exported | Monize does not currently have a budget feature |
| **Reports** | Not applicable | Monize has its own reporting system |
| **Loan amortization** | Not exported | Loan payment transactions are imported, but amortization schedules must be set up manually |
| **Account numbers** | Not in QIF | QIF format does not include account numbers |
| **Cheque images** | Not in QIF | Physical cheque images cannot be exported |
| **Online banking links** | Not applicable | Monize does not use online banking connections |
| **Planner/forecast data** | Not exported | Financial plans must be recreated |
| **Invoices/customers** | Not exported | Business data is not supported |

---

## Quick Reference Card

### Export from Microsoft Money

1. **File > Export > Loose QIF**
2. One file per account
3. Investment accounts need two exports (Investment + Regular)
4. Name files with numeric prefix for sort order

### Import into Monize

1. **Tools > Import Transactions**
2. Select all files at once for bulk import
3. Map accounts, categories, securities, and transfer accounts
4. Review and click "Import Transactions"

### Recommended Import Order

```
1. Asset accounts
2. Home currency bank accounts
3. Foreign currency bank accounts
4. Credit card accounts
5. Investment cash accounts (-Regular files)
6. Investment brokerage accounts (-Investment files)
7. Line of credit / loan accounts
```

### After Import Checklist

```
[ ] Verify all account balances match Microsoft Money
[ ] Fix cross-currency transfer amounts ("PENDING IMPORT" memos)
[ ] Verify investment holdings and cost basis
[ ] Update auto-created securities with correct symbols
[ ] Recreate scheduled transactions (bills and deposits)
[ ] Run "Uncategorized Transactions" report and fix gaps
[ ] Review category hierarchy and reorganize if needed
[ ] Check net worth trend on Dashboard
```
