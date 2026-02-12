# Investments

Monize provides comprehensive investment portfolio tracking with automatic price updates, cost basis calculation, and performance reporting.

---

## Table of Contents

- [Overview](#overview)
- [Investment Account Structure](#investment-account-structure)
- [Portfolio View](#portfolio-view)
- [Investment Transaction Types](#investment-transaction-types)
- [Creating Investment Transactions](#creating-investment-transactions)
- [Securities Management](#securities-management)
- [Price Updates](#price-updates)
- [Holdings and Cost Basis](#holdings-and-cost-basis)
- [Importing Investment Data](#importing-investment-data)

---

## Overview

The Investments page gives you a complete picture of your investment portfolio, including current market values, unrealized gains/losses, and daily price movements.

![Investments Page](images/investments-page.png)
<!-- Screenshot: The investments page showing portfolio summary, holdings list, and account selection -->

---

## Investment Account Structure

Investment accounts in Monize are composed of two linked accounts:

| Component | Purpose |
|-----------|---------|
| **Brokerage Account** | Holds your securities (stocks, ETFs, mutual funds, bonds) |
| **Cash Account** | Tracks the cash balance within the brokerage |

When you create an investment account, both components are created automatically. The cash account is hidden from the main Accounts list but is managed through the Investments interface.

### How It Works

- **Buying securities** decreases the cash balance and adds to holdings
- **Selling securities** increases the cash balance and reduces holdings
- **Dividends** increase the cash balance
- **Transfers** move cash in or out of the investment account

> **Microsoft Money users:** In Microsoft Money, the cash and securities are combined in a single investment account. Monize separates these for cleaner transaction tracking, but the import process handles this mapping automatically.

---

## Portfolio View

The portfolio view shows all your investment holdings grouped by account.

![Portfolio Holdings](images/portfolio-holdings.png)
<!-- Screenshot: The portfolio view showing holdings grouped by account with market values, gains, and percentages -->

### Portfolio Summary

At the top, a summary card shows:

- **Total Market Value** -- Current value of all investment holdings
- **Total Cost Basis** -- What you paid for all holdings
- **Total Unrealized Gain/Loss** -- The difference (both dollar and percentage)
- **Cash Balances** -- Total cash across all investment accounts

### Holdings List

Each holding displays:

| Column | Description |
|--------|-------------|
| **Security** | Name and symbol of the security |
| **Quantity** | Number of shares/units held |
| **Average Cost** | Your average cost per share |
| **Current Price** | Latest market price |
| **Market Value** | Current total value (quantity x current price) |
| **Unrealized Gain/Loss** | Difference from cost basis (both $ and %) |

Holdings are colour-coded: green for gains, red for losses.

---

## Investment Transaction Types

Monize supports 9 investment transaction types:

| Action | Description | Cash Impact |
|--------|-------------|-------------|
| **Buy** | Purchase securities | Cash decreases |
| **Sell** | Sell securities | Cash increases |
| **Dividend** | Cash dividend received | Cash increases |
| **Interest** | Interest income received | Cash increases |
| **Capital Gain** | Realized or unrealized capital gains | Cash increases |
| **Reinvest** | Dividend reinvested as additional shares | No cash change |
| **Split** | Stock split adjustment | No cash change |
| **Transfer In** | Securities moved in from another account | No cash change |
| **Transfer Out** | Securities moved out to another account | No cash change |

---

## Creating Investment Transactions

1. Navigate to **Investments**
2. Select the brokerage account
3. Click **Add Transaction**
4. Select the transaction type (Buy, Sell, Dividend, etc.)
5. Fill in the details:

![Investment Transaction Form](images/investment-transaction-form.png)
<!-- Screenshot: The investment transaction form showing security selection, action type, quantity, price, and commission fields -->

### Transaction Fields

| Field | Description |
|-------|-------------|
| **Date** | Transaction date |
| **Action** | Transaction type (Buy, Sell, etc.) |
| **Security** | The security involved |
| **Quantity** | Number of shares/units |
| **Price** | Price per share/unit |
| **Commission** | Any trading commission or fee |
| **Total** | Calculated total (quantity x price + commission) |
| **Description** | Optional notes |

---

## Securities Management

Securities represent the stocks, ETFs, mutual funds, bonds, and other instruments you trade.

### Accessing Securities

Navigate to **Tools > Securities** to manage your security master list.

![Securities List](images/securities-list.png)
<!-- Screenshot: The securities management page showing a list of securities with symbols, names, types, and exchanges -->

### Security Fields

| Field | Description |
|-------|-------------|
| **Symbol** | Ticker symbol (e.g., AAPL, VGRO.TO) |
| **Name** | Full name (e.g., Apple Inc.) |
| **Type** | STOCK, ETF, MUTUAL_FUND, BOND, GIC, CASH, or OTHER |
| **Exchange** | Stock exchange (NYSE, NASDAQ, TSX, etc.) |
| **Currency** | The currency the security trades in |

### Adding Securities

Securities can be added:
- Manually from the Securities page
- During import (mapped or auto-created from QIF data)
- Automatically when creating investment transactions

---

## Price Updates

Security prices are updated automatically and can also be refreshed manually.

### Automatic Updates

- **Schedule:** Weekdays (Monday-Friday) at 5:00 PM EST
- **Source:** Yahoo Finance
- **Data:** Daily OHLCV (Open, High, Low, Close, Volume)

### Manual Refresh

Click the **Refresh Prices** button on the Investments page or Dashboard to trigger an immediate price update.

### Historical Prices

When you import investment data or add a new security, Monize automatically backfills historical prices (up to 10 years). This ensures accurate portfolio valuation for historical reporting.

---

## Holdings and Cost Basis

Monize tracks your cost basis using the **average cost method**.

### How Average Cost Works

1. When you **buy** shares, the total cost is added to your cost basis
2. The average cost per share is: `total cost basis / total shares held`
3. When you **sell** shares, the cost basis for the sold shares is calculated using the average cost
4. **Reinvested dividends** add to both quantity and cost basis

### Example

| Transaction | Shares | Price | Total Cost | Total Shares | Avg Cost |
|------------|--------|-------|------------|--------------|----------|
| Buy 100 | 100 | $10 | $1,000 | 100 | $10.00 |
| Buy 50 | 50 | $12 | $1,600 | 150 | $10.67 |
| Sell 75 | -75 | $15 | $800 | 75 | $10.67 |

### Zero Holdings

When all shares of a security are sold, the holding is removed from your portfolio. If you buy the same security again, a new cost basis starts from that purchase.

---

## Importing Investment Data

Importing investment data from Microsoft Money requires special handling. See the [Importing from Microsoft Money](Importing-from-Microsoft-Money.md) guide for complete details.

### Key Points

- Microsoft Money exports investment accounts as two separate QIF files: "Investment" type for securities transactions and "Regular" type for cash transactions
- Import the investment brokerage file first, then the cash file
- Securities must be mapped to existing records or created during import
- Monize automatically creates the linked cash transactions when importing investment QIF files

For the recommended import order, see [Recommended Import Order](Importing-from-Microsoft-Money.md#recommended-import-order).
