# Importing from Quicken

This is the complete guide to migrating your financial data from Quicken to Monize using QIF file exports. It covers exporting from Quicken, preparing your data, and importing into Monize. For importing from other sources using CSV or OFX/QFX files, see [Importing Transactions](importing-transactions.md). For migrating from Microsoft Money, see [Importing from Microsoft Money](importing-from-microsoft-money.md).

---

## Overview

Quicken uses QIF (Quicken Interchange Format) for data export. Monize includes a comprehensive QIF import wizard that handles:

- Regular banking transactions (chequing, savings, credit cards)
- Investment transactions (buy, sell, dividends, splits, reinvestments)
- Split transactions (multiple categories per transaction)
- Account-to-account transfers
- Category creation and mapping (with colon-separated hierarchy support)
- Tag definitions from Quicken's tag system
- Security creation and mapping
- Multi-account full-file exports (all accounts in a single QIF file)

Monize auto-detects whether a QIF file is a single-account export or a full-file export and adapts the import wizard accordingly. Quicken for Mac's `.qmtf` transfer files are QIF under another extension, with section headers in capitals and Mac line endings; Monize reads them exactly like a `.qif` file.

---

## Important Limitations

> [!WARNING]
> **Future-Dated Transactions Are Not Supported**
>
> Monize does not support importing future-dated transactions. Quicken's QIF export defaults to a far-future end date that includes scheduled and future transactions. **When exporting, always set the "to" date to today's date** to exclude them. See [Removing Future-Dated Transactions](#removing-future-dated-transactions) if you need to clean up a file that was already exported with future transactions.

---

## Part 1: Exporting from Quicken

Quicken offers two ways to export your data as QIF files.

### Single-Account Export

Export one account at a time:

1. In Quicken, select the account you want to export
2. Go to **File > Export > QIF File**
3. **Important:** Change the **"to"** date to **today's date**. Quicken defaults this to a far-future date (e.g., 31/12/2099), which will include scheduled and future-dated transactions that Monize cannot import.
4. Select the transactions to include
5. Save the `.qif` file with a descriptive name (e.g., `Chequing.qif`, `Visa.qif`)
6. Repeat for each account

![Quicken QIF Export dialog — change the highlighted "to" date to today's date](images/quicken-qif-export.png)

> **Investment Accounts:** Unlike Microsoft Money, Quicken's QIF export for investment accounts includes both securities transactions and cash transactions in a single file. You do not need to export twice.

### Full-File Export (All Accounts)

Export your entire Quicken data file at once:

1. In Quicken, go to **File > Export > QIF File**
2. Select **All Accounts** (or select multiple accounts)
3. **Important:** Change the **"to"** date to **today's date**. Quicken defaults this to a far-future date (e.g., 31/12/2099), which will include scheduled and future-dated transactions that Monize cannot import. Set it to today's date to export only past and present transactions.
4. Ensure categories and tags are included in the export
5. Save the `.qif` file

![Quicken QIF Export dialog — change the highlighted "to" date to today's date](images/quicken-qif-export.png)

A full-file export produces a single QIF file that contains:

- **Category definitions** (`!Type:Cat` sections) -- your full category hierarchy with tax-related flags
- **Tag definitions** (`!Type:Tag` sections) -- your Quicken tags
- **Account blocks** (`!Account` sections) -- each account's transactions grouped together
- **Transaction data** -- all transactions across all included accounts

### Which Export Method to Use

| Method | Best For | Advantages | Disadvantages |
|--------|----------|------------|---------------|
| **Single-account** | Selective migration, importing specific accounts | Full control over what to import; can import in a specific order | Must handle transfer linking across separate imports |
| **Full-file** | Complete migration from Quicken | One file, one import; transfers auto-linked; categories and tags included | All-or-nothing |

---

## Part 2: Preparing Your QIF Files

### Removing Future-Dated Transactions

The easiest fix is to **re-export from Quicken** with the "to" date set to today. See [Full-File Export](#full-file-export-all-accounts) for details.

If you prefer to fix an already-exported file, open it in a text editor (Notepad, VS Code, etc.) and delete any transactions with future dates. Each transaction looks like this:

```
D3/14/2026
T-45.00
PGrocery Store
LFood:Groceries
^
```

The `D` line is the date and `^` marks the end of the transaction. Delete the entire block (from `D` through `^`) for any transaction dated after today, then save the file.

---

## Part 3: Importing Single-Account QIF Files

Navigate to **Tools > Import Transactions** to begin.

### Recommended Import Order

If you are importing multiple single-account QIF files, the order matters for transfer linking. Import in this order:

```
1. Asset Accounts
      |
2. Bank, Credit Card and Line of Credit Accounts (Home Currency)
      |
3. Bank, Credit Card and Line of Credit Accounts (Foreign Currency)
      |
4. Investment Accounts
```

Monize matches pending transfers from previously imported files, so importing accounts with the most outgoing transfers first ensures correct linking.

> **Tip:** Select all your QIF files at once for bulk import. Monize processes them sequentially and coordinates transfer matching across files.

### Step 1: Upload QIF Files

![Import wizard: upload your files](images/import-upload-step.png)

1. Click the upload area or drag your QIF files onto it
2. You can select **multiple files** at once for bulk import
3. Monize parses each file and extracts:
   - Account type detected from the QIF header
   - Number of transactions
   - Date range of transactions
   - Categories found (including colon-separated hierarchy)
   - Transfer accounts referenced
   - Securities found (for investment files)

### Step 2: Select Destination Account

For each QIF file, specify which Monize account the transactions should be imported into.

![Select Destination Account](images/import-select-account.png)

#### File Information

A gray information box shows:
- **File:** The filename being imported
- **Transactions:** Number of transactions found
- **Date Range:** Earliest to latest transaction dates
- **Detected Type:** Account type from the QIF header (e.g., Chequing, Investment, Credit Card)

#### Selecting an Account

Choose from the **Import into account** dropdown:
- For **investment QIF files** (detected type: Investment), only brokerage accounts are shown, and a blue note says so
- For **regular QIF files**, all non-brokerage accounts are shown

> **Auto-Matching:** Monize matches QIF file names to account names automatically, so `Visa.qif` lands on your "Visa" account. When several files are uploaded together, each gets its own dropdown; files matched by name are shown in green and guesses in amber.

![Select Destination Accounts for several QIF files](images/import-select-account-bulk.png)

#### Creating a New Account

If the destination account does not exist:

1. Click **+ Create new account** (**+ Create new** for a file in a bulk import)
2. Fill in the **Account name** (pre-filled from the file name), **Account type** and **Currency**
3. Click **Create**

The new account is auto-selected as the destination. Creating an **Investment** account creates its linked cash and brokerage pair; an investment file goes into the brokerage side.

#### Date Format

Monize detects the date format from the dates in the file, including Quicken's space-padded dates. There is no override for a single-account file, so if the dates come out swapped (day and month), re-export from Quicken with your system's date format set to the format you expect. A full-file export has a **Date Format** dropdown on its review step (see [Part 4](#part-4-importing-a-full-file-qif-export)).

> **Quicken Date Quirk:** Quicken may pad single-digit days with spaces (e.g., `2/ 4/19` instead of `2/4/19`). Monize handles this automatically.

### Step 3: Map Categories

Quicken uses colon-separated category paths (e.g., `Food:Groceries`, `Auto:Fuel`, `Fees & Charges:Bank Fee`). Monize automatically parses this hierarchy and matches each path against your existing categories.

![Map Categories for a Quicken file: a new category under an existing parent](images/import-quicken-map-categories.png)

A summary line counts the categories that need attention and those matched, and they are displayed in three groups:

1. **Needs attention** (amber border) -- Categories that could not be auto-matched. Require your input.
2. **Auto-matched to loan accounts** (shown expanded) -- Matched to loan or mortgage account names (imported as payments to the loan account).
3. **Auto-matched to categories** (collapsed) -- Successfully matched to existing Monize categories. Click **Show *n* auto-matched to categories** to review or change them.

For a colon path Monize cannot match, the row comes already filled in to create the last level under its parent: `Auto:Parking` suggests a new "Parking" under an existing "Auto", or under a new parent "Auto" if you have none. Accept the suggestion, or change it. For each unmatched category, you can:
- **Map to existing** -- Select an existing Monize category
- **Or create new** -- Enter a new category name, then pick a **Parent category** (or **+ Create new parent...**)
- **Skip** -- Leave the dropdown at **Skip (no category)**; categorize later
- **This is a loan payment** -- Tick it to import the category's transactions as payments to an existing loan, or to a new loan you name with its type, institution and initial amount

#### Automatic Category Hierarchy Creation

When Monize creates new categories from Quicken's colon-separated paths:

1. It detects the parent-child relationship from the colon separator
2. Creates the parent category if it does not exist
3. Creates the child category under the correct parent
4. Deduplicates parents across multiple children

For example, importing categories `Food:Groceries`, `Food:Restaurants`, and `Food:Coffee` creates one "Food" parent with three children.

### Step 4: Map Securities

This step appears only for investment QIF files containing security references.

![Map Securities](images/import-map-securities.png)

When you reach the step, Monize looks up every security it could not match to one of yours (the line "Looking up securities..." shows while it runs) and fills in what it finds. A row shows a green border once it is ready and an amber one while it needs attention.

For each security, you can:
- **Map to existing** -- Select from the dropdown of existing Monize securities (it starts at **Skip (no security)**)
- **Or create new (symbol)** -- Enter the symbol, the **Security name**, the **Security type** (Stock, ETF, Mutual Fund, Bond, Option, GIC, Cryptocurrency, Cash/Money Market or Other), the **Exchange** and the **Currency**. Picking an exchange sets the currency that exchange trades in
- **Lookup** -- Search again by name or symbol. When several securities fit, you choose the right one from a list

Your preferred exchanges (**Settings > Preferences**) are tried first.

### Step 5: Map Transfer Accounts

This step appears when the QIF file references transfers to other accounts (using Quicken's `[Account Name]` notation). It is skipped for investment files, whose transfers go through the linked cash account.

![Map Transfer Accounts](images/import-map-accounts.png)

For each referenced account (names that match one of your accounts are filled in already):
- **Map to existing** -- Select from the dropdown of existing Monize accounts
- **Or create new** -- Enter the account name, then choose its **Account type** and **Currency**

> **Bulk Import Tip:** If you are importing all files at once, transfers between accounts in the batch are linked automatically. You only need to map accounts that are not part of the current import.

### Step 6: Review and Import

The review step shows a summary of everything that will happen:

- Files and transaction counts
- Target accounts
- Categories, transfer accounts and securities: how many are mapped and how many will be created

![Review Import](images/import-review-step.png)

Click **Import Transactions** to execute. Each file is imported inside a database transaction -- if the import fails, none of its changes are kept. A single transaction that cannot be imported is counted as an error and the rest of the file still imports.

### Step 7: Import Complete

After import, Monize displays:

| Metric | Description |
|--------|-------------|
| **Imported** | Transactions successfully imported |
| **Skipped** | Transfers already recorded from the other account, listed row by row |
| **Errors** | Transactions that failed (with details) |
| **Categories created** | New categories added |
| **Accounts created** | New accounts added |
| **Payees created** | New payees added |
| **Securities created** | New securities added |

If a loan or mortgage account was created without scheduled payments, **Set Up Payments** lets you add them straight away. **View Transactions** (or **View Investments**) opens the accounts you just imported into; **Import More Files** starts again.

![Import Complete](images/import-complete-step.png)

---

## Part 4: Importing a Full-File QIF Export

When you upload a full-file QIF export, Monize detects it automatically (by the presence of several `!Account` sections or a `!Type:Cat` category list) and adapts the import wizard.

### How Full-File Import Differs

| Aspect | Single-Account Import | Full-File Import |
|--------|----------------------|------------------|
| **Account selection** | Choose one account per file | None: each account in the file is matched to your account of the same name, or created |
| **Category mapping** | Map each category | None: the `!Type:Cat` definitions (and any other categories the transactions use) are matched to your categories of the same name, or created with their hierarchy |
| **Tag definitions** | Extracted from transaction data | Created from `!Type:Tag` sections and the transactions |
| **Transfer linking** | Across files in a bulk import | Automatic within the single file |
| **Date format** | Detected | Detected, with a dropdown to change it |
| **Number of files** | One or more | One file |

### Full-File Import Steps

1. **Upload** -- Select your full-file `.qif` export (one file on its own; several files are treated as single-account exports)
2. **Review** -- The **Multi-Account QIF Import** step summarizes the file ("This file contains 3 accounts, 6 categories, 2 tags, and 6 transactions") and lists:
   - **Currency for New Accounts** -- the currency every account the import creates is given
   - **Date Format** -- detected from the file; the sample dates underneath show how it was read
   - **Accounts** -- each account with its type, transaction count and date range
   - **Categories** -- grouped into Expense and Income
   - **Tags** -- the tags that will be created
3. **Choose missing account types** -- if the file does not say what type an account is, a **Choose a type** dropdown appears beside it, and the import cannot start until each one has a type
4. **Map Securities** -- if the file holds investment accounts, the notice says how many securities need mapping; click **Next: Map Securities** and map them as in [Step 4](#step-4-map-securities), then click **Import All** there
5. **Import** -- otherwise click **Import All** on the review step
6. **Complete** -- View results

![Multi-Account QIF Import: the review of a full-file export](images/import-multi-account-review.png)

An account in the file that has the same name as one of your accounts is imported into it rather than created again (for an investment account, the "*name* - Cash" account counts too). Every other account is created, an investment account as its linked cash and brokerage pair.

> **Tip:** Full-file import is the easiest way to migrate from Quicken. All transfers between accounts are automatically linked, and your complete category and tag hierarchy is preserved.

---

## Part 5: Post-Import Steps

After importing your Quicken data, take these steps to verify and finalize your migration.

### 5.1 Verify Account Balances

Compare each account's current balance in Monize against Quicken. If balances do not match:

1. Check the opening balance -- it should match the balance as of the first transaction date
2. Look for missing or duplicate transactions
3. Check that transfers between accounts were matched correctly

### 5.2 Verify Investment Holdings

1. Navigate to **Investments**
2. Check that each holding shows the correct quantity and cost basis
3. Compare against your Quicken portfolio summary
4. If any securities were auto-created, update their symbols and exchange information

### 5.3 Check Security Price Updates

Securities created during import use the symbol, exchange and type entered on the Map Securities step, and get price updates like any other security. If one was created with a guessed symbol:

1. Navigate to **Tools > Securities**
2. Edit the security to correct its symbol, exchange, and type
3. Prices are fetched for the corrected symbol from then on

### 5.4 Review Categories

Navigate to **Tools > Categories** and review the category hierarchy. Categories imported from Quicken preserve the colon-separated hierarchy (e.g., `Food:Groceries` becomes "Groceries" under parent "Food"). Verify the hierarchy looks correct and reorganize if needed.

### 5.5 Set Up Scheduled Transactions

Quicken's QIF export does **not** include scheduled or recurring transactions. You must recreate these manually:

1. Navigate to **Bills & Deposits**
2. Create each recurring bill and deposit
3. See [Bills and Deposits](bills-and-deposits.md) for details

### 5.6 Check for Uncategorized Transactions

Run the **Uncategorized Transactions** report (**Reports > Uncategorized Transactions**) to find any transactions imported without a category.

### 5.7 Verify Net Worth

Navigate to the Dashboard and check the Net Worth chart. Click **Recalculate** on the Net Worth report if needed to refresh balance snapshots after import.

---

## Part 6: Starting Over

If your import did not go as expected and you want to start fresh, you can delete all your financial data without losing your user account or settings.

1. Navigate to **Settings**
2. Scroll to the **Danger Zone** section
3. Click **"Delete Data..."**
4. Check all four optional boxes (Accounts, Categories, Payees, Currency preferences) for a completely clean slate
5. Enter your password to confirm

This removes all transactions, accounts, categories, securities, budgets, and other financial data. Your user account, preferences, and security settings (2FA, trusted devices) are preserved. You can then re-import your QIF files.

For more details, see [Settings and Security > Danger Zone](settings-and-security.md#danger-zone).

---

## Part 7: Quicken QIF Format Details

Understanding the QIF format can help when troubleshooting or manually editing files.

### QIF Record Fields

| Field Code | Description | Example |
|------------|-------------|---------|
| `D` | Date | `3/14/2026` |
| `T` | Amount | `-45.00` |
| `P` | Payee | `Grocery Store` |
| `M` | Memo | `Weekly groceries` |
| `N` | Cheque number (regular) or Action (investment) | `1234` or `Buy` |
| `C` | Cleared status (`*` or `c` = cleared, `X` or `R` = reconciled) | `*` |
| `L` | Category (or `[Account]` for transfers) | `Food:Groceries` or `[Savings]` |
| `S` | Split category | `Food:Groceries` |
| `E` | Split memo | `Groceries portion` |
| `$` | Split amount | `-30.00` |
| `Y` | Security name (investment) | `AAPL` |
| `I` | Price per share (investment) | `150.25` |
| `Q` | Quantity (investment) | `10` |
| `O` | Commission (investment) | `9.99` |
| `^` | End of record | |

### Account Type Headers

| QIF Header | Monize Account Type |
|------------|-------------------|
| `!Type:Bank` | Chequing |
| `!Type:Cash` | Cash |
| `!Type:CCard` | Credit Card |
| `!Type:Invst` | Investment |
| `!Type:Oth A` | Asset |
| `!Type:Oth L` | Line of Credit |

### Quicken-Specific Format Notes

- **Quicken for Mac:** `.qmtf` files, `!TYPE:` and `!ACCOUNT` headers in capitals, and classic Mac line endings are all read
- **Category hierarchy:** Uses colon separator (e.g., `Food:Groceries`) unlike Microsoft Money's `/` separator
- **Date padding:** Quicken may pad single-digit days with spaces (e.g., `2/ 4/19`)
- **Tags:** Appended after `/` in the category field (e.g., `Food:Groceries/Vacation`)
- **Full-file sections:** `!Type:Cat` for category definitions, `!Type:Tag` for tag definitions, `!Account` for account blocks

---

## Part 8: Troubleshooting

### Future-Dated Transactions Cause Issues

**Cause:** The QIF file contains transactions with dates in the future.

**Solution:** Remove future-dated transactions from the QIF file before importing. See [Removing Future-Dated Transactions](#removing-future-dated-transactions). Alternatively, re-export from Quicken with a date range ending on or before today.

### Dates Appear Wrong

**Cause:** The date format was detected incorrectly (e.g., MM/DD was interpreted as DD/MM).

**Solution:** For a full-file export, change the **Date Format** dropdown on the review step. A single-account file's format is detected from its dates; if they are all ambiguous (every day 12 or less), re-export from Quicken with an unambiguous date range or format. Quicken typically uses MM/DD/YYYY format.

### Category Hierarchy Not Created

**Cause:** The colon separator in category names was not detected.

**Solution:** Verify the QIF file uses standard colon-separated categories (e.g., `LFood:Groceries`). If categories use a different separator, they will be imported as flat names. You can reorganize them manually in **Tools > Categories**.

### Duplicate Transactions After Import

**Cause:** Importing the same file twice, or transfer transactions appearing in both accounts.

**Solution:**
- Monize skips the second side of a transfer that is already recorded when importing the other account
- If duplicates still appear, use the **Duplicate Transaction Finder** report
- For future imports, import all related files in a single bulk operation

### Transfer Not Linked Between Accounts

**Cause:** Transfer accounts were not mapped correctly, or files were imported in separate sessions.

**Solution:**
- Import all files at once using bulk import
- For full-file exports, transfers are linked automatically
- Manually link unmatched transfers by editing the transactions

### Investment Securities Not Found During Lookup

**Cause:** The security name in Quicken does not match market data.

**Solution:**
1. During the Map Securities step, click **Lookup** after typing the symbol instead of the name
2. If lookup fails, manually enter the symbol, name, type, and exchange
3. After import, verify securities in **Tools > Securities**

### Opening Balance Incorrect

**Cause:** The opening balance transaction in the QIF does not match expected starting point.

**Solution:**
1. Navigate to **Accounts**
2. Edit the account
3. Adjust the opening balance and opening date
4. The current balance will be recalculated

### Import Times Out

**Cause:** Very large QIF file (near the 10 MB limit or thousands of transactions).

**Solution:** The import has a 5-minute timeout. If the file is too large, re-export from Quicken with a smaller date range.

---

## Part 9: What Cannot Be Imported

The QIF format and Quicken export have limitations. The following data must be recreated manually in Monize:

| Data Type | Status | Notes |
|-----------|--------|-------|
| **Account balances** | Auto-detected | Extracted from QIF "Opening Balance" record |
| **Transactions** | Imported | All regular and investment transactions |
| **Categories** | Imported | Created with hierarchy during import mapping |
| **Tags** | Imported | Created from `!Type:Tag` sections (full-file export) or extracted from transactions |
| **Cleared status** | Imported | `*` or `c` imports as cleared, `X` or `R` as reconciled |
| **Payees** | Imported | Created automatically from QIF data |
| **Securities** | Imported | Created during import mapping |
| **Future transactions** | Not supported | Must be removed before import; recreate as scheduled transactions |
| **Scheduled transactions** | Not exported | Must be recreated in [Bills & Deposits](bills-and-deposits.md) |
| **Budgets** | Not exported | Must be recreated using [Budgets](budgets.md) -- Monize can auto-generate from imported spending history |
| **Reports** | Not applicable | Monize has its own reporting system |
| **Loan amortization** | Not exported | Loan payment transactions are imported, but schedules must be set up manually |
| **Account numbers** | Not in QIF | QIF format does not include account numbers |
| **Attachments** | Not in QIF | Receipt images or attached documents cannot be exported |
| **Online banking links** | Not applicable | Monize does not use online banking connections |

---

## Quick Reference Card

### Export from Quicken

1. **File > Export > QIF File**
2. Choose single-account or full-file export
3. Set date range to end on or before today (to avoid future transactions)
4. Save the `.qif` file

### Import into Monize

1. **Tools > Import Transactions**
2. Upload your QIF file(s), or one full-file export
3. Single-account files: map accounts, categories, securities, and transfer accounts, then review and click **Import Transactions**
4. Full-file export: check the review, map any securities, and click **Import All**

### After Import Checklist

```
[ ] Remove future-dated transactions from QIF files before import
[ ] Verify all account balances match Quicken
[ ] Verify investment holdings and cost basis
[ ] Update auto-created securities with correct symbols
[ ] Recreate scheduled transactions (bills and deposits)
[ ] Run "Uncategorized Transactions" report and fix gaps
[ ] Review category hierarchy and reorganize if needed
[ ] Check net worth trend on Dashboard
```
