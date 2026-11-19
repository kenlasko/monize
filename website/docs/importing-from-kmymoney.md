# Importing from KMyMoney

This is the complete guide to migrating your financial data from KMyMoney to Monize. You import the KMyMoney file itself -- no QIF or CSV export is needed.

For importing from other sources using CSV or OFX/QFX files, see [Importing Transactions](importing-transactions.md). If you are coming from Microsoft Money, see [Importing from Microsoft Money](importing-from-microsoft-money.md).

---

## Overview

Monize reads a KMyMoney file directly -- `.kmy` (KMyMoney's default, a compressed XML document) or a plain `.xml` file -- with its accounts, category tree, payees, tags, transactions, transfers, splits, securities, price history, exchange rates and scheduled transactions intact. Nothing needs to be installed, KMyMoney does not need to be on the machine, and the file never leaves your Monize server.

The import follows the same flow as the [Microsoft Money import](importing-from-microsoft-money.md): upload, review, a background import, and a verification report. The difference that matters to you: Monize works out what **every account balance and every holding should be straight from your KMyMoney file**, using KMyMoney's own arithmetic, and compares the result against what it actually imported. A mapping problem therefore shows up as a difference you can see, not as a silent error.

---

## Before You Start

**Save the file unencrypted.** KMyMoney's only encryption is GPG over the whole file, and Monize cannot decrypt it. In KMyMoney turn off encryption (**Settings > Configure KMyMoney > Encryption**) and save the file again, or decrypt a copy with `gpg -d`, then import that.

**Use a `.kmy` or `.xml` file.** The upload step accepts `.kmy` and `.xml`. A `.kmy` goes to the KMyMoney importer, which decides what it is from its contents. An `.xml` is looked at first: Monize reads the start of the file and opens it as a KMyMoney file if it is one, as an OFX bank statement if it is that (see [Importing Transactions](importing-transactions.md)), and otherwise refuses it, so a stray XML file is never guessed at.

**If your data is in an SQL database, save it as a file first.** A KMyMoney SQL database (SQLite) cannot be imported. Open it in KMyMoney, choose **File > Save As**, pick the KMyMoney (`.kmy`) format, and import the saved file.

**Do not use an anonymized file.** KMyMoney can write an anonymized copy (`.anon.xml`) for bug reports. It scrambles every amount and replaces the names, so it is not your data and Monize refuses it. Import your original file.

**Very old files.** The binary format of KMyMoney 0.8 and earlier is refused. Open the file in a current KMyMoney, save it again, and import the result.

**Nothing needs closing, and nothing is changed.** Monize reads the copy you upload and never writes to your KMyMoney file. Making a spare copy of years of finances still costs nothing.

**Import into an empty profile.** The import does not merge at the transaction level. It creates what the file describes; an account of the same name that already exists receives the file's transactions without Monize working out which ones it already has. On a profile with data you will get duplicates. If you have been trying Monize out and want to start over, the review step offers **Start fresh**, which runs the same Delete My Data operation as **Settings > Danger Zone** before the import begins. It asks you to type a confirmation word and re-enter your password, and it cannot be undone.

**Import the same file once.** Monize refuses a file whose exact bytes it already imported into your account, so a second click cannot double your data. Saving an unchanged file again in KMyMoney writes different bytes, so a re-saved copy is not recognised as the same file and would import a second time. To import a file again, use **Start fresh**.

**Check the file size limits if you self-host.** The uploaded file may be up to 300 MB by default, set by `MNY_IMPORT_LIMIT_MB`. A `.kmy` is compressed, so a second limit applies to what it holds: at most 100 MB of XML once uncompressed (about 200,000 transactions of ordinary size; a real file of 120,000 transactions is 59 MB), and at most 600,000 records. These two limits are fixed and cannot be changed. See [Troubleshooting the KMyMoney Import](#troubleshooting-the-kmymoney-import) if a large upload fails.

---

## Step by Step

Navigate to **Tools > Import Transactions** to begin.

**Step 1: Upload the file**

Select or drag your `.kmy` or `.xml` file onto the upload area. Import KMyMoney files **one at a time** -- a KMyMoney file holds a whole profile, so there is nothing to bulk-select. Monize reads the file on the server and shows a preview. Nothing is written yet.

![Import wizard: upload your files](images/import-upload-step.png)

If the file cannot be opened, the reason appears in red on the upload step (see [Troubleshooting the KMyMoney Import](#troubleshooting-the-kmymoney-import)). Unlike Microsoft Money files, a KMyMoney file never asks for a password.

**Step 2: Review what will be imported**

This step is worth the minute it takes.

![Review your KMyMoney file: the file summary and the counts](images/import-kmy-review.png)

- The file summary names the file, the KMyMoney file format version, and the base currency, and says that the balances shown are computed from the file, as of the date it names. Transactions dated after that day are not counted in them.
- **Counts** for transactions (with the number of transfers linked), payees, payee aliases (with the number of payees that get a default category), categories, tags, accounts, securities, investment transactions, price history, exchange rates and scheduled transactions are each shown against the total in the file, so "40 of 500 payees" is visible before rather than after.
- **Every account** is listed with its type, currency, transaction count, opening balance and the **final balance computed from the KMyMoney file itself**. Compare a few against KMyMoney -- that same number is what the verification report reconciles against afterwards. A KMyMoney investment account appears as its two Monize halves, " - Cash" and " - Brokerage". An account Monize had to rename (two accounts sharing a name) shows "named X in KMyMoney" underneath, and closed, favourite and excluded-from-net-worth accounts are marked.
- **Untick any account you do not want**, or use **Select all** / **Select none**. Closed accounts are included by default and stay closed; they still hold history worth keeping.
- **Override an account's currency** with its dropdown if KMyMoney had it wrong.

![The accounts in the KMyMoney file, with the balance computed from it](images/import-kmy-accounts.png)

- **Scheduled transactions to create** appear as a checkbox list with each schedule's account, frequency, next due date and amount, and whether it is a transfer. All active schedules are pre-ticked; schedules KMyMoney marks finished are not offered. An unticked schedule is simply not created. A frequency Monize cannot express exactly is marked as the closest shorter one, so no occurrence is missed.

![The scheduled transactions found in the KMyMoney file](images/import-kmy-bills.png)

- **Notes about this file** collects anything ambiguous or left behind -- budgets that were not imported, a security without a symbol, a transaction that does not balance. Where a note is about particular transactions, **Show the *n* transactions** lists them with their date, account, payee and amount, so you can find them in KMyMoney. Worth reading; none of it stops the import. One note deserves special attention: if Monize reports that an account or holding **would end with a balance that differs from the one computed from the file**, do not import until that is explained.

![Notes about this file](images/import-kmy-notes.png)

**Step 3: Start the import**

Choose the [import options](#import-options) under the accounts, then click **Start import**. It runs on the server, so you can leave the page and come back. A large file takes a few minutes. The progress list shows which phase is running, with a row counter: preparing; accounts, categories and payees; transactions; investments; scheduled transactions; prices and exchange rates; recalculating balances; verifying.

Only one import can run at a time for your account. If the server restarts mid-import, nothing is left half-written: **Try again** runs it again from the file you already uploaded, and **Start over** goes back to the upload step.

**Step 4: Check the verification report**

See [After the Import](#after-the-import) for how to read it.

---

## Import Options

Set on the review step, before you start the import.

| Option | Default | What it does |
|---|---|---|
| **Only import payees that are used** | On | Skips payees no transaction refers to |
| **Only import categories that are used** | On | KMyMoney seeds its category tree from a template whether you use it or not. Leaving this on imports only the categories your transactions use, plus their parent categories |
| **Import closed accounts** | On | Closed accounts keep their history and are created closed |
| **Import price history** | On | KMyMoney's own record of what each security was worth, day by day. Turn it off if you would rather start from live quotes |
| **Import exchange rates** | On | Historical rates between the currencies in your file, used only for dates Monize has no rate for. Rates already stored are never replaced |
| **Start fresh: remove my existing Monize data first** | Off | Removes your existing Monize data before importing. Typed confirmation and password required |

![Import options](images/import-kmy-options.png)

With **Start fresh** ticked, **Start import** first opens **Remove Existing Data**. It lists what is removed and warns that this cannot be undone, even if the import then fails. Type `DELETE` and your **Password** (an account that signs in through single sign-on confirms with its identity provider instead), then click **Delete my data and import**.

---

## What Is Imported

- **Accounts.** Checking, savings, cash, credit card, loan, investment, money market, certificate of deposit, asset, liability and currency accounts, with opening balances, currencies, and closed and favourite flags. A KMyMoney account's institution becomes the account's institution name. See the table below for how each KMyMoney type maps.
- **Categories**, at their full depth. Income and expense categories keep their parent and child structure however many levels it has.
- **Transactions**, including splits, reference numbers (check numbers), memos, tags, and the cleared or reconciled state and reconciled date of each side. KMyMoney's "frozen" state arrives as reconciled.
- **Transfers**, linked exactly from the two sides KMyMoney records. A transaction that mixes transfers and categories, such as a paycheque that also puts money into savings, arrives as one split transaction with a transfer leg and category legs. A cross-currency transfer keeps each side's own amount in its own account's currency and the exchange rate it implies. If the amounts imply no rate and the file does not price the pair, the transfer is imported without a rate and the notes list it: open its receiving side and enter the rate.
- **Opening balances.** KMyMoney stores an opening balance as a transaction against an equity account. Monize folds the earliest one into the account's opening balance so it does not appear as a transaction.
- **Payees**, with their **matching rules as payee aliases**, their **default category** and their **contact details** (notes, email, phone and address). A matching rule is imported whenever Monize can reproduce it exactly; each rule it cannot is skipped on its own and named in the notes. See [Payee Matching Rules](#payee-matching-rules). The reference number, bank identifiers and link pattern KMyMoney keeps on a payee are not carried over (see [What Is Not Imported](#what-is-not-imported)).
- **Tags**, on the transactions and splits that carry them.
- **Investments.** Buys, sells, dividends, interest, reinvested dividends, added and removed shares, and stock splits. Commissions and fees are kept, the executed total is treated as the fact, and the per-share price is derived from it. A security moved between brokerage accounts (removed from one, added to another on the same date in the same quantity) becomes a linked transfer out and in that carries its cost basis. A KMyMoney investment account becomes Monize's linked cash and brokerage pair; Monize finds the cash side from the brokerage account KMyMoney links to the investment account, or failing that by KMyMoney's own naming (`<account name> (Brokerage)`, in English or any language KMyMoney ships).
- **Stock splits are applied.** A KMyMoney stock split is the share movement itself, so each becomes a split in Monize with the same ratio (a 3:2 split is 1.5).
- **Securities and price history.** Only securities that a holding in an imported account refers to, with their type (stock, mutual fund, bond) where KMyMoney records one.
- **Exchange rates**, for the currencies your accounts and securities actually use. Rates already stored in Monize are never replaced, and every imported rate and price is labelled as coming from the KMyMoney import.
- **Scheduled transactions** you ticked, with their frequency and next due date, created active and set **not** to post automatically, so nothing lands in your accounts without you.
- **Loans.** The payment structure is kept: the principal leg is a transfer to the loan account and the interest leg is a category. Where payments and a selected schedule make it unambiguous, the loan's funding account, payment amount, frequency and start date are filled in too.

### Payee Matching Rules

KMyMoney uses a payee's matching rule to pick the payee when you import a bank statement. Monize's equivalent is a [payee alias](categories-and-payees.md#payee-aliases): an imported name that matches the alias goes to that payee. The two are not the same language, so the import translates each rule only when the result matches **exactly the same names**, and tells you about every rule it did not.

| KMyMoney rule | What you get in Monize |
|---|---|
| Matching turned off | No alias. Monize cannot turn matching off: a later import or bank sync whose payee is exactly the payee's name still links to it. Noted once per payee |
| "Match Payees name (partial)" | An alias of the name with a `*` on both sides, so `Netflix` becomes `*Netflix*` |
| "Match Payees name (exact)" | An alias of the name, when the rule ignores case and the name has letters. Monize already links a payee by its exact name, which is case-sensitive, so a case-sensitive rule, or a name with no letters (`7/11`), needs no alias |
| "Match on a name listed below" | One alias per listed name (or per pattern) that translates. The statement-created kind, `^THE\ AMERICAN\ CHE\ CONS\ PAY$`, becomes `THE AMERICAN CHE CONS PAY`; a plain name such as `CITY POWER` becomes `*CITY POWER*`; `^AMZN.*MKTP$` becomes `AMZN*MKTP` |

KMyMoney's rules are regular expressions that match anywhere in the name; Monize aliases match the whole name and know only the `*` wildcard. What translates is a key made of plain text, an optional `^` at the start (the name must begin there), an optional `$` at the end (it must end there), `.*` for "anything", and a backslash before a punctuation mark or space. Anything else is **not imported**, and the notes name the payee and the rule so you can find it:

- patterns that are more than text: `AMAZON.COM` (where the dot means "any character"), `(SHELL|ESSO)`, `\d{4} PAYROLL`, `[0-9]+`, `colou?r`;
- a rule that holds a literal `*`, a `<` or `>`, or begins or ends with a space, which Monize cannot store in an alias;
- a rule that would match every name (`.*`), or longer than 255 characters.

To keep one of these, add the alias by hand: open the payee in Monize, add a pattern in **Aliases** (for example `AMAZON*`) and press **Add**.

Three more things are said rather than done silently:

- **Case.** A KMyMoney rule can be case-sensitive; Monize aliases never are. The alias is imported and the notes say it now also matches the same name in other capitals.
- **Conflicts.** Monize does not allow an alias that matches another payee's alias, or equals another payee's name. Where two payees in the file would clash, the first payee in the file keeps its alias and the later one is skipped and named. The same refusal applies to aliases and payees you already have in Monize.
- **Overlap.** Two aliases that can match the same name but do not clash outright (`*Amazon*` and `*Prime*` both match "Amazon Prime") are both imported and named. KMyMoney gives such a name to the payee with the longer match; Monize may pick either, so check them.

Aliases act on later imports and bank syncs, not on the transactions in this file, which already carry the payee KMyMoney assigned.

A payee's **default category** is imported when it is an income or expense category; the category and its parents are created even if you left **Only import categories that are used** on. KMyMoney lets a payee's default be an ordinary account, which Monize cannot use, so that default is skipped and named in the notes. When a payee already exists in Monize, the import **fills in only what is empty**: your own default category, notes, email, phone and address are kept, and the notes name the payees where the KMyMoney value was not used.

Contact details are imported only when they fit Monize's own limits: an email address that is valid, a phone number Monize can read (a number without a country code is read in the region of your number-format and language settings, and left out if neither names a region), and notes and address within 500 characters. A detail that does not fit is named in the notes.

### How KMyMoney account types map

| KMyMoney | Monize |
|---|---|
| Checking | Chequing |
| Savings, Money Market, Certificate of Deposit | Savings |
| Cash | Cash |
| Credit Card | Credit Card (the credit limit comes across) |
| Loan, Liability | Loan |
| Investment (with its brokerage cash account) | Investment: a cash and a brokerage account |
| Asset, Currency trading, Loan to someone else (Asset Loan) | Asset |
| Income, Expense | Categories |
| Equity | Not an account; see below |
| An account whose currency is a cryptocurrency | Crypto |

**Equity.** Monize has no equity accounts. Apart from an opening balance, money moved to or from an equity account arrives with that equity account as an income-type category, so every account balance stays exact and the movement shows in reports.

---

## What Is Not Imported

| Data type | Notes |
|---|---|
| **Budgets** | KMyMoney's budgets have no clean equivalent. Recreate with [Budgets](budgets.md) -- Monize can generate budgets from your imported spending history |
| **Saved reports** | Recreate them with [Reports](reports.md) |
| **Online banking settings and online transfer orders** | Not read. You can set up bank sync in Monize |
| **Account numbers and IBANs** | Not imported |
| **Payee reference numbers, bank identifiers and link patterns** | Not imported; Monize has no field for them. Notes, email, phone, address, default category and matching rules are imported (see [Payee Matching Rules](#payee-matching-rules)) |
| **Payee matching rules Monize cannot reproduce exactly** | Each such rule is skipped on its own and named in the notes with its payee. Add an alias in Monize if you want one |
| **Payee contact details that do not fit** | An invalid email address, a phone number with no country code when your settings name no region, or text over 500 characters is named in the notes and left out |
| **Cost centers** | Monize has no cost centers |
| **Tax and VAT settings on categories** | Not imported |
| **Tag colours, notes and closed state** | Tags import by name only |
| **The account hierarchy between asset and liability accounts** | Monize lists accounts side by side, so an account nested under another becomes a top-level account |
| **Schedule options** | The weekend rule (move a due date off weekends), automatic entry, and fixed-versus-estimated amounts. Recorded past payments are not imported either |
| **Entry date of a transaction** | Monize has no such field |
| **Unused securities and unused currency rates** | Securities no imported holding refers to, and rates for currencies none of your accounts or securities use, are skipped so the import does not create things nobody uses |

Not supported at all: KMyMoney files encrypted with GPG, SQL databases, anonymized files and the pre-0.9 binary format (each is refused with a message saying what to do), and writing KMyMoney files.

Each of the items above that exists in your file is counted in the **Notes about this file** list, so you know what was left behind.

---

## Known Limitations

**Stock-split precision.** KMyMoney multiplies your share balance by the split ratio and rounds the result to the security's own fraction. Monize stores ratios to 8 decimal places and keeps fractions of a share. Two things can therefore differ by a tiny amount: a ratio such as 1-for-3 that cannot be written exactly, and a split that leaves a fraction of a share KMyMoney rounded away. Each such split is listed in the notes so a holdings difference arrives already explained. Monize also checks each split against the prices around it, and tells you when a split looks inverted compared with them; it never changes the ratio itself, so check it against your statement.

**Shares added without cost.** KMyMoney records "Add shares" with no cost. Monize cannot calculate a gain on shares it has no cost for, so a sale drawn on them reports an unknown gain rather than treating them as free. Shares added in one account and removed from another on the same date in the same quantity are paired as a transfer and carry their cost; any other addition is listed. Edit it in Monize to add the cost if you know it.

**Schedules.** The weekend rule and automatic entry are not carried over: a due date stays on the date as scheduled, and a schedule KMyMoney would have entered automatically waits for you to post it. A schedule whose next due date was already in the past arrives overdue, as it shows in KMyMoney. Monize also writes every imported schedule without auto-posting. A loan payment schedule imports as one transfer of the payment amount, because KMyMoney works out the principal and interest split when the payment is entered and does not store it.

**Loan interest rate.** KMyMoney stores a loan's interest rate, original principal and term on the account. Monize does not import them; the notes name each loan and its latest rate so you can enter it on the loan account.

**Investment accounts without a findable cash account.** If Monize cannot find an investment account's brokerage account, it creates an empty cash account for it and says so. Trades paid from other accounts still move those accounts correctly.

**Trades whose amounts do not add up.** Each trade is checked against the share value the file records. A trade whose total and commission do not add up to it is listed with the two figures, and the note says not to import until it is explained.

**Share movements that fit no investment activity.** A transaction that moves shares but matches none of the investment activities Monize knows is imported as a split transaction for its cash and categories, and the shares as a purchase or sale at the value the file records. Each is listed; check it.

**Money moved from an account to itself.** Each side is imported as its own entry rather than as a transfer, and the transaction is listed.

**Reconciliation history.** Each entry keeps its reconciled state and date, but KMyMoney's statement dates and balances are not imported. The accounts that had a history are listed.

**Share transfers Monize had to infer.** A removal and an addition of the same shares on the same day are imported as a transfer between brokerage accounts that carries the cost. Each such pair is listed so you can check it was a transfer and not a sale and a gift.

**Share counts finer than eight decimal places.** Monize stores eight, so such a count is rounded to eight and listed.

**Transactions that do not balance.** KMyMoney marks a transaction whose splits do not add up as erroneous. Monize imports the difference as an uncategorized split so the account balance stays what KMyMoney shows, and lists the transaction.

**Cryptocurrency.** A coin can only be the currency of a Crypto account in Monize. A security priced in a cryptocurrency is not imported, and its trades come across as plain cash movements.

**Securities sharing a symbol.** Monize's symbols are unique, so the second security with the same symbol gets a suffix (`VOO-2`) and a note. A security with no symbol gets a generated placeholder and is excluded from automatic price updates.

**No merge, no de-duplication.** See [Before You Start](#before-you-start).

**A failure after the data was saved says so.** If an import fails after its records were written (a final check, for example), the wizard tells you the records are in your account and does not offer to try again: importing the same file again would duplicate them. Check your accounts before importing anything else.

---

## After the Import

When the import finishes, the **Balance verification** table lists every account with three things: the balance **From KMyMoney file**, the balance **In Monize**, and the difference. **Holdings verification** does the same for every investment account's shares: **Shares in KMyMoney** against the shares Monize now holds. Both are KMyMoney's own balance computation, done independently of Monize's mapping. The counts above the tables say what was created.

- **A green run** says every account and holding reconciles.
- **A row with a difference** is listed with the figure so you can look at it directly. A balance that differs is a defect rather than a rounding effect, so report it.
- **The date line** above the balance table says the day the figures are cut off at. Transactions dated later are not counted in any of them; the review step shows the same date.
- **"Import rows sum to X"** appears under the expected figure when what Monize's own mapping produced differs from the figure computed from the file. It tells you whether the difference arose in reading your file or in writing it.
- A share count that differs after a stock split is normally explained by one of the stock-split notes (see Known Limitations).
- **Notes about this import** repeats anything the import had to decide. **Download report** saves it as JSON; **Done** returns to the upload step.

Then:

1. **Review auto-created securities** in **Tools > Securities**. A security that had no symbol gets a placeholder and is excluded from price updates until you give it a real symbol and exchange.
2. **Enter loan interest rates** on your loan accounts (see Known Limitations).
3. **Recreate budgets** -- see [Budgets](budgets.md).
4. **Check your scheduled transactions** in [Bills and Deposits](bills-and-deposits.md). Imported schedules are active but set not to post automatically; switch on auto-posting for the ones you want it on, and post or skip anything that arrived overdue.
5. **Check your payee aliases** in **Payees** for the ones the notes named as overlapping, and add by hand any matching rule that was skipped.
6. **Check net worth** on the Dashboard against your KMyMoney net worth report.

If the result is not what you wanted, re-run the import with **Start fresh** ticked.

---

## Troubleshooting the KMyMoney Import

Nothing is written unless the whole import succeeds, so a failure leaves your data as it was, and the uploaded file is kept for one more attempt.

| What you see | What it means |
|---|---|
| "No KMyMoney file was uploaded." | The upload was empty. Choose the file again |
| "This XML file is neither a KMyMoney file nor an OFX file" | The `.xml` file you chose is some other XML, such as a different bank's statement format, a report or an image. Nothing was imported. Choose the `.kmy` or `.xml` file KMyMoney saves, or an OFX or QFX statement |
| "That file is not a KMyMoney file." | Wrong file, a category template, or some other XML. Choose the `.kmy` or `.xml` file KMyMoney saves. If your data is in an SQL database, open it in KMyMoney and use **File > Save As** to save it as a `.kmy` file first |
| "That KMyMoney file is encrypted with GPG, which Monize cannot open." | Turn off encryption in KMyMoney (**Settings > Configure KMyMoney > Encryption**) and save the file again, or decrypt a copy with `gpg -d`, then import that |
| "That is a KMyMoney SQL database." | Open it in KMyMoney, choose **File > Save As**, pick the KMyMoney (`.kmy`) format, and import the saved file |
| "That is an anonymized KMyMoney file" | An anonymized file has scrambled amounts and replaced names. Import your original `.kmy` file instead |
| "That file uses the binary format of KMyMoney 0.8 or earlier." | Open it in a current KMyMoney and save it again, then import the result |
| "That KMyMoney file is damaged or incomplete and could not be read." | If it was copied or downloaded, try the original file again |
| "That KMyMoney file is larger than the N MB import limit." | See Self-Hosting Failures below. The same message says "once uncompressed" when the compressed file fit but its contents did not; that limit is 100 MB and is not configurable |
| "That KMyMoney file holds more records than Monize imports from one file." | The file is within the size limits but holds more than 600,000 records, or a single transaction with more than 10,000 splits. Nothing was imported. This limit is fixed |
| "Monize could not convert this KMyMoney file." | This is a fault in Monize, not in your file, and nothing was saved. Please report it, with the file's version from the review step if you can |
| "The existing account ... is closed, so the KMyMoney file cannot be merged into it." | An account of that name already exists in Monize and is closed. Reopen or rename it, then import again |
| "The existing account ... uses X, but the KMyMoney file account uses Y." | Rename one of the two accounts, then import again |
| "This file was already imported into your account" | Importing it again would duplicate its records. To replace them, start over with **Start fresh** ticked |
| "The import saved your data, but a step after that failed" or "...stopped responding after it had already saved your data" | The records are in your account. Check your accounts before importing anything else; importing the same file again would duplicate them |
| "The import stopped responding" | The server restarted mid-import. Your file is still here: press **Try again** |
| "The uploaded KMyMoney file is no longer available." | Uploaded files are kept 24 hours. Upload it again |
| "This KMyMoney file is being imported." | Wait for the import to finish before discarding the file |
| "An import is already running" | Wait for it to finish -- possibly in another tab |

### Self-Hosting Failures

Two failures look like the app is broken and are configuration:

- **The upload is refused as too large.** The frontend passes a KMyMoney file to the backend through its own upload route, which refuses anything over `MNY_IMPORT_LIMIT_MB` (default 300). The variable must be set on the **frontend** as well as the backend. The uncompressed size is a separate, fixed limit of 100 MB, and raising `MNY_IMPORT_LIMIT_MB` does not change it.
- **The server is killed partway through every attempt.** It is running out of memory. A KMyMoney file is held in memory while it is read, in compressed and uncompressed form; a file at the limits costs about 470 MB above the backend's own use. See `helm/README.md` for the sizing rules.
