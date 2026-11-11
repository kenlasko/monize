# Bills and Deposits

The Bills & Deposits feature lets you schedule recurring transactions so you never miss a payment or forget about regular income.

---

## Overview

Bills & Deposits manages your recurring financial obligations and expected income. It shows a cash flow forecast built from your schedules, lists every scheduled transaction (or shows them on a month calendar), and can post transactions automatically on their due dates.

![The Bills & Deposits page](images/bills-deposits-page.png)

The summary at the top counts your **Active Bills** and **Active Deposits**, the **Monthly Net** of all your active schedules converted to your home currency, and how many are **Due Now** (overdue or due today).

---

## Creating a Scheduled Transaction

1. Navigate to **Bills & Deposits** from the top navigation bar
2. Click **+ New Schedule**
3. Choose what you are scheduling with the buttons at the top: a **Transaction**, a **Split** across several categories, a **Transfer** between accounts, or an **Investment** transaction
4. Fill in the form:

![The New Scheduled Transaction form](images/scheduled-transaction-form.png)

5. Click **Create**

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | What the schedule is called, for example Rent, Netflix, or Salary |
| **Account** | Yes | Which account this transaction uses |
| **Next Due Date** | Yes | When the next occurrence is due; later occurrences follow from it |
| **Payee** | No | Who the transaction is with |
| **Category** | No | Expense or income category |
| **Amount** | Yes | Transaction amount (negative for a bill, positive for a deposit). Leave it at zero for a reminder of a bill whose amount varies, or turn on **Estimate**. The currency button beside it lets you enter the amount in the currency the biller charges |
| **Estimate** | No | Work each occurrence's amount out from your payment history instead of typing it (see [Estimated Amounts](#estimated-amounts)). The **Amount** is then greyed out and shows the next occurrence's estimate |
| **Reference Number** | No | Cheque number, confirmation number, or another reference; each posted transaction carries it unless you change it when posting |
| **Frequency** | Yes | How often the transaction recurs (default Monthly; see [Frequency Options](#frequency-options)) |
| **Remind Days Before** | No | How many days before the due date the schedule counts as coming up, for reminders and the dashboard's Due soon list (default 3) |
| **Description** | No | Additional notes |
| **End Condition** | No | Stop the schedule **End by date** (an **End Date**) or after a **Number of occurrences** |
| **Active** | No | Turn off to pause the schedule without deleting it |
| **Auto-post on due date** | No | Whether to create the transaction automatically on the due date (see [Auto-Posting](#auto-posting)) |
| **Tags** | No | One or more [tags](tags.md) applied when the transaction is posted |

### Estimated Amounts

For a bill whose amount changes from month to month, such as heating or electricity, turn on **Estimate** beside the **Amount**. Monize then works out each occurrence's amount from the last 24 months of payments to the schedule's **Payee** in its **Category**, in any of your accounts:

- The starting point is the average of your three most recent payments, so a price change is the price from then on.
- When two years of payments show the same pattern by month, both years, each month is shaped by that pattern: a bill that costs more in winter is forecast to cost more in winter. A bill that costs the same every month, or one whose price simply changed, is not treated as seasonal.
- When every month went up (or down) by about the same share from one year to the next, the estimate carries that trend forward.
- A payment in another currency is converted at the current exchange rate. Refunds from the biller are left out.

![A schedule with Estimate on](images/scheduled-transaction-estimate.png)

The estimate follows new payments as you record them. Under the **Amount**, the form says how many payments the estimate is based on, or what is missing when there is not enough to estimate from: no payments yet, or no exchange rate for a payment's currency. An estimated schedule needs a **Payee** and a **Category**, is available for a single-category transaction in the account's own currency (not a split, transfer, investment, or foreign-currency amount), and is never posted automatically, so **Auto-post on due date** is turned off.

You still decide every occurrence: the bills list labels the amount **Estimated**, **Edit Occurrence** shows each upcoming occurrence's estimate and lets you change any of them, and the **Post Transaction** dialog opens on the estimate for you to correct before posting. An occurrence you change keeps your amount; one you leave alone keeps following the estimate.

### Split Scheduled Transactions

Like regular transactions, scheduled transactions support splits across multiple categories. Choose **Split** at the top of the form (or click **Split Transaction**) to add multiple category/amount rows; the rows must add up to the **Total Amount**. **Cancel Split** returns to a single category.

### Transfer Scheduling

You can schedule recurring transfers between accounts (e.g., a monthly transfer from chequing to savings). Choose **Transfer**, then the **From Account**, the **To Account**, and the **Transfer Amount**. You may optionally also assign a **Category**: the transfer is still not counted as income or expense, but it will appear in the monthly category breakdown (useful for tracking recurring investment contributions).

### Investment Scheduling

Choose **Investment** to schedule a recurring investment transaction, such as a monthly purchase of an ETF or a dividend reinvestment. Pick the **Investment Account**, the **Action** (Buy, Sell, Dividend, Reinvest Dividend, and so on), the **Security**, and the **Quantity (Shares)**, **Price per Share**, and **Commission**. The **Funding Account** defaults to the investment account's own cash; pick another account to model a contribution followed by a purchase. When the occurrence is posted, you can adjust the quantity, price, or total to what was actually traded.

The **Funding Account** -- not the brokerage named in **Investment Account** -- is the account this schedule's cash actually settles in: the one the Cash Flow Forecast projects a balance change on, and the one Bills & Deposits warns about if it would go below zero. The brokerage holds the resulting shares, but its own cash balance never moves for a buy funded from elsewhere.

---

## Frequency Options

| Frequency | Description |
|-----------|-------------|
| **One Time** | A single future transaction (useful for reminders) |
| **Daily** | Every day |
| **Weekly** | Once per week |
| **Every 2 Weeks** | Every two weeks |
| **Every 4 Weeks** | Every four weeks (useful for pay cycles that do not align to calendar months) |
| **Twice a Month** | Twice per month |
| **Monthly** | Once per month on the same date |
| **Every 2 Months** | Every two months |
| **Quarterly** | Every three months |
| **Every 4 Months** | Every four months |
| **Twice a Year** | Every six months |
| **Yearly** | Once per year |
| **Every 2 Years** | Every other year |
| **Custom** | A pattern you define, such as every Monday, Wednesday and Friday (see [Custom Schedules](#custom-schedules)) |

A monthly schedule on the 31st falls on the last day of shorter months.

### Custom Schedules

Choose **Custom** as the **Frequency** when none of the fixed options fits, for example a bill due every Monday, Wednesday and Friday, or on the 1st and 15th and the last day of each month. A **Repeats** panel appears with three units:

| Unit | What you pick | Example |
|------|---------------|---------|
| **Weekly** | Days of the week (Mon to Sun) | Every week on Mon, Wed and Fri |
| **Monthly** | Days of the month (1 to 31, or **Last day**) | Every 2 months on the 1st, 15th and last day |
| **Yearly** | **Dates of the year**: choose a **Month** and **Day**, then click **Add date** | Every year on 1 March and 15 September |

Use **Repeat every** to space the pattern out: every 1 to 12 weeks, months or years. Below the panel, a summary (for example "Every week on Mon, Wed and Fri") shows what you set, and **First occurrence** under **Next Due Date** shows when it first falls due.

- A day past the end of a short month falls on that month's last day, so day 31 lands on 30 April and 28 February.
- If two days land on the same date, the transaction posts once.
- 29 February falls on 28 February in years without one.

Every occurrence of a custom schedule can be edited, skipped, moved or posted like any other bill (see [Overriding Individual Occurrences](#overriding-individual-occurrences)). If you change the pattern and some occurrences you edited no longer fall on it, Monize warns you before you save and deletes those edited occurrences when you do.

> [!NOTE]
> Custom is not available for loan or mortgage payment schedules, or for payroll schedules with deduction limits. Choose a fixed frequency for those.

---

## Bills List

Below the forecast, the list shows all scheduled transactions with:

| Column | Description |
|--------|-------------|
| **Name / Payee** | What the schedule is called and who it is with |
| **Account** | The account involved |
| **Category** | The category, the transfer's destination, or a **Split** badge |
| **Amount** | The amount of the next occurrence |
| **Schedule** | The next due date with an **Overdue**, **Due Today**, or **Due Soon** (within a week) badge, the frequency, and how many occurrences are left |
| **Auto-Post** | **On** when the schedule posts itself |
| **Actions** | **Post Transaction**, **Skip Occurrence**, **Edit Occurrence**, **Edit Schedule**, and **Delete** |

![The list of scheduled transactions](images/bills-list.png)

A **modified** badge counts the upcoming occurrences you have changed (see [Overriding Individual Occurrences](#overriding-individual-occurrences)), and paused schedules are marked inactive.

### Filtering

**Show filters** opens the filter panel and **Hide** folds it away again. At the top of the panel, the **All**, **Bills**, and **Deposits** buttons narrow the list to one kind of schedule; below them you can search by **Name** and narrow by **Payees**, **Accounts**, and **Categories**. While the panel is folded, its header counts the filters in use and lists each one as a chip you can remove, and **Clear** removes them all.

### The Bar Above the List

The bar directly above the column headers starts with the **Table** and **Calendar** buttons and, just right of them, how many schedules the filters leave (**Showing 5 of 12 bills and deposits**, not shown on a phone). At its right-hand end, **Export** downloads the list as it is filtered to a CSV file, with each schedule's next occurrence amount and due date, and the density button sets how much fits on screen.

### Calendar View

The **Table** and **Calendar** buttons switch between the list and a month calendar of every occurrence; in calendar view they sit at the left of the toolbar, with the month in the middle. Move between months with the arrows, click the month to jump to any month by typing it (for example `Mar 1998` or `2026-03`), or return to the current one with **Today**. Click an occurrence to edit its schedule.

![Bills & Deposits in calendar view](images/bills-calendar.png)

---

## Posting a Transaction

To record an occurrence yourself, click **Post Transaction** on its row. The **Post Transaction** dialog lets you change the **Transaction Date**, the **Amount**, the **Category**, the **Description**, and the **Reference Number** for this posting only, or split it with **Split this transaction**. It shows what the posting does to the account's balance, and warns you when posting on that date would take an account below zero or over its credit limit.

![The Post Transaction dialog](images/bills-post-transaction.png)

Click **Post Transaction** to create the transaction and advance the schedule to its next due date. Clicking an item in the dashboard's [Upcoming Bills](dashboard.md#upcoming-bills) widget opens the same dialog.

---

## Auto-Posting

When **Auto-post on due date** is turned on for a scheduled transaction, Monize automatically creates the transaction on its due date without any manual intervention.

### How It Works

1. Every hour, Monize checks for active, auto-posting scheduled transactions that are due today or overdue in your timezone
2. Each due occurrence is created in the designated account, with any changes you made to that occurrence
3. The next due date is calculated based on the frequency
4. When the end date or the number of occurrences is reached, the schedule ends

A posting that fails (for example, for want of an exchange rate) raises a notification so you can post it by hand.

### When to Use Auto-Posting

- **Fixed-amount bills** (e.g., rent, subscription services) -- The amount is the same each time
- **Regular transfers** (e.g., monthly savings contribution) -- Predictable, consistent amounts

### When NOT to Use Auto-Posting

- **Variable-amount bills** (e.g., utilities, credit card payments) -- Use reminders instead and enter the actual amount manually, or turn on [Estimate](#estimated-amounts) so the forecast follows your history (an estimated bill is never auto-posted)
- **Bills your bank's import already brings in** -- the imported row and the auto-posted one would both be recorded

---

## Overriding Individual Occurrences

You can modify or skip individual occurrences of a scheduled transaction without changing the overall schedule.

### Modifying an Occurrence

1. In the bills list, click **Edit Occurrence** on the scheduled transaction
2. In **Select Occurrence Date**, choose which upcoming occurrence to change (occurrences you already changed are marked **Modified**)
3. In the **Edit Occurrence** dialog, change the **Occurrence Date**, **Amount**, **Category**, or **Description** for this occurrence only
4. To split just this occurrence across multiple categories, turn on **Split this occurrence** and add category/amount rows (independent of whether the underlying schedule is split)
5. Click **Save Override** (or **Update Override** for one you changed before)

![The Edit Occurrence dialog](images/bills-edit-occurrence.png)

The override only affects that single occurrence. All other future occurrences follow the original schedule. **Reset to Default** removes the override. When you later edit a schedule that has overrides, Monize asks whether to **Keep Modifications** or **Delete All Modifications**.

### Skipping an Occurrence

If a recurring bill does not apply for a particular period (e.g., a holiday causes a payment to be skipped):

1. Click **Skip Occurrence** on the scheduled transaction
2. Confirm in the **Skip Occurrence** dialog
3. The schedule advances to its next due date

---

## Cash Flow Forecast

The **Cash Flow Forecast** at the top of the page projects your account balances from today's balances, the transactions already dated in the future, and every scheduled occurrence.

![The Cash Flow Forecast chart](images/cash-flow-forecast.png)

- Choose how far ahead to look: **7D**, **30D**, **90D**, **6M**, or **1Y**
- **Accounts to forecast** picks the accounts. With none picked, all your accounts are drawn as one line; with two or more, each account gets its own line beside a **Total of Accounts** line
- Hover over the chart to see the balance on a day and the transactions that move it; an [estimated](#estimated-amounts) occurrence is marked **(estimated)**
- Below the chart: the **Starting** and **Ending** balances and the lowest point of the period (**Min Balance** for liability accounts)
- **Hide chart** (the arrow at the top right) folds the forecast to a thin strip; click the strip to bring it back. This browser remembers the choice

An occurrence that fell due and was neither posted nor skipped counts on the first day of the forecast. If an exchange rate is missing for one of the currencies involved, the forecast says so rather than showing a total that leaves it out. Likewise, if an estimated bill's amount cannot be worked out yet, the forecast names the bill and why, until you enter that occurrence's amount or record a payment.

This helps you:
- Anticipate when account balances will be low
- Plan for upcoming large expenses
- Ensure sufficient funds for automatic payments

The same forecast is available as a [dashboard widget](dashboard.md#cash-flow-forecast).

---

## Loan Payment Scheduling

For loan and mortgage accounts, scheduled transactions track the regular payments.

### Setting Up Loan Payments

The easiest way is to let Monize create the schedule: fill in the payment details when you [create the loan or mortgage](accounts.md#loan-and-mortgage-setup), or use **Set Up Recurring Payments** on an existing one. The schedule it creates splits each payment into a principal transfer to the loan account and an interest line booked to the loan's interest category, priced from the balance and the rate in effect on each due date. The calendar, the Upcoming Bills widget, and **Edit Occurrence** each show that occurrence's own payment and split.

To set one up by hand, create a **Split** schedule from your bank account with a **Transfer** line to the loan account for the principal and a **Category** line for the interest.

> [!TIP]
> If your bank's import brings in the payment, turn on [payment matching](accounts.md#payment-matching) on the loan instead of auto-posting: the imported row then settles the scheduled payment rather than being recorded twice.

> [!NOTE]
> When importing from Microsoft Money, loan payment categories are automatically detected and mapped to the corresponding loan accounts. See [Importing from Microsoft Money](importing-from-microsoft-money.md) for details.

---

## Schedule as Recurring

You can create a scheduled transaction from any existing transaction without re-entering its details.

1. On the [Transactions](transactions.md) page, find the transaction you want to schedule
2. Click the **Copy** dropdown on the transaction row and select **Schedule as Recurring**
3. The scheduled transaction form opens pre-filled with the transaction's account, payee, amount, category, and tags
4. Set the frequency, next due date, and other scheduling options
5. Click **Create**

The original transaction is not modified -- a new scheduled transaction is created based on its details.

A credit card's detail page can also schedule a monthly payment with **Make a Payment**, and a bank account's detail page offers **Create bill** for recurring charges it finds in your transactions. See [Account Detail Pages](accounts.md#account-detail-pages).

---

## Email Reminders

Monize reminds you of scheduled transactions as they come due, in the notification bell and, when you turn them on under [Notifications](settings-and-security.md#notifications), by email or push. A schedule's **Remind Days Before** sets how early. Reminder emails are colour-coded to help you quickly distinguish between expenses and income at a glance.
