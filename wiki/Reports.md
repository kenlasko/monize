# Reports

Monize includes 15+ built-in reports and a custom report builder for analyzing your financial data in depth.

---

## Table of Contents

- [Overview](#overview)
- [Built-In Reports](#built-in-reports)
- [Custom Report Builder](#custom-report-builder)
- [Chart Types](#chart-types)
- [Report Filters](#report-filters)
- [Saving and Favouriting Reports](#saving-and-favouriting-reports)

---

## Overview

Navigate to **Reports** from the top navigation bar to access the reporting system. The Reports page lists all built-in reports and any custom reports you have created.

![Reports Page](images/reports-page.png)
<!-- Screenshot: The reports page showing the list of available built-in and custom reports -->

---

## Built-In Reports

### Spending Reports

| Report | Description |
|--------|-------------|
| **Spending by Category** | Breaks down your expenses by category for a selected time period |
| **Spending by Payee** | Shows your top spending recipients |
| **Monthly Spending Trend** | Tracks how your spending changes month over month |
| **Weekend vs Weekday** | Compares spending patterns between weekdays and weekends |
| **Spending Anomalies** | Identifies unusual transactions that deviate from normal patterns |
| **Recurring Expenses** | Analyzes your regular, repeating expenses |

![Spending by Category Report](images/report-spending-category.png)
<!-- Screenshot: The spending by category report showing a pie chart and table breakdown of expenses -->

### Income Reports

| Report | Description |
|--------|-------------|
| **Income by Source** | Categorizes your income streams |
| **Income vs Expenses** | Monthly comparison of income and expenses |
| **Cash Flow** | Shows net money flow (income minus expenses) by period |

![Income vs Expenses Report](images/report-income-expenses.png)
<!-- Screenshot: The income vs expenses report showing monthly bars with totals -->

### Comparison Reports

| Report | Description |
|--------|-------------|
| **Year over Year** | Compares spending and income across different years |

### Tax and Compliance

| Report | Description |
|--------|-------------|
| **Tax Summary** | Groups transactions by tax-relevant categories |

### Data Quality

| Report | Description |
|--------|-------------|
| **Uncategorized Transactions** | Lists transactions without a category assigned |
| **Duplicate Transaction Finder** | Identifies potential duplicate entries |

### Billing and Payment

| Report | Description |
|--------|-------------|
| **Bill Payment History** | Tracks your scheduled transaction payment patterns |

### Net Worth

| Report | Description |
|--------|-------------|
| **Net Worth Report** | Historical monthly snapshots of your assets, liabilities, and net worth |

![Net Worth Report](images/report-net-worth.png)
<!-- Screenshot: The net worth report showing a line chart with assets, liabilities, and net worth over time -->

---

## Custom Report Builder

Create your own reports with flexible filtering, grouping, and visualization options.

1. Navigate to **Reports**
2. Click **Create Custom Report**
3. Configure the report parameters

![Custom Report Builder](images/custom-report-builder.png)
<!-- Screenshot: The custom report builder showing all configuration options -->

### Report Configuration

| Setting | Options |
|---------|---------|
| **Name** | A descriptive name for your report |
| **Timeframe** | Date range for the report data |
| **Group By** | Category, Payee, Month, Week, or Day |
| **Direction** | Income only, Expenses only, or Both |
| **Metric** | Total amount, Transaction count, or Average amount |
| **Chart Type** | Table, Line, Bar, Pie, or Area chart |
| **Sorting** | Sort by name, amount, count, or date |

### Report Filters

| Filter | Description |
|--------|-------------|
| **Accounts** | Include only specific accounts |
| **Categories** | Filter to specific categories |
| **Payees** | Filter to specific payees |
| **Search Text** | Free-text filter on transaction details |

---

## Chart Types

Custom reports support five visualization types:

### Table

A tabular view showing rows of data with columns for the grouped dimension and selected metrics.

![Table Chart](images/report-chart-table.png)
<!-- Screenshot: A report displayed as a data table -->

### Line Chart

A trend line connecting data points over time. Best for showing changes over months, weeks, or days.

### Bar Chart

Vertical bars comparing values across groups. Best for category or payee comparisons.

### Pie Chart

A circular chart showing proportional breakdown. Best for understanding the composition of spending or income.

### Area Chart

Similar to a line chart but with the area below filled in. Effective for showing cumulative trends.

---

## Report Filters

### Filtering from Reports to Transactions

When viewing a report, you can click on any data point (a bar, pie segment, or table row) to navigate directly to the Transactions page with filters pre-applied. This allows you to drill down from a high-level summary to the individual transactions that make up that figure.

### Date Range Selection

Reports support flexible date ranges:

- **This Month** / **Last Month**
- **This Quarter** / **Last Quarter**
- **This Year** / **Last Year**
- **Last 30 Days** / **Last 90 Days** / **Last 12 Months**
- **Custom Range** -- Select specific start and end dates

---

## Saving and Favouriting Reports

### Saving Custom Reports

Custom reports are saved automatically when you create them. They appear in the Reports list alongside the built-in reports.

### Favouriting Reports

Mark frequently used reports as favourites for quick access:

1. On the Reports page, click the star icon next to a report
2. Favourite reports appear at the top of the list

### Editing Custom Reports

Click the edit button on any custom report to modify its configuration. Built-in reports cannot be edited, but you can create a custom report with similar parameters if you need a variation.

### Deleting Custom Reports

Custom reports can be deleted from the Reports page. Built-in reports cannot be deleted.
