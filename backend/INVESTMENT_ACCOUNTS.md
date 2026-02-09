# Investment Accounts Guide

This document explains how investment accounts work in Monize, including the dual-component structure with cash and security holdings.

## Overview

Investment accounts in Monize have a unique two-component structure:

1. **Cash Component**: Tracked via the regular `Account` entity with `currentBalance` representing available cash
2. **Securities Component**: Tracked via `Holdings` which store quantities and average costs of securities

This design allows you to:
- Transfer cash in/out of investment accounts (just like regular accounts)
- Buy/sell securities using the cash in the account
- Track dividends, interest, and capital gains
- Calculate performance and gains/losses
- View portfolio summaries with real-time valuations
- Track daily price movements and top movers

## Architecture

### Core Entities

#### 1. Account (type = INVESTMENT)
```typescript
{
  id: UUID
  accountType: 'INVESTMENT'
  investmentSubtype: 'BROKERAGE' | 'RRSP' | 'TFSA' | 'RESP' | '401K' | 'IRA' | 'ROTH_IRA' | 'OTHER'
  name: 'My Brokerage Account'
  currentBalance: 5000.00  // Cash available in the account
  currencyCode: 'USD'
  institution: 'TD Ameritrade'
  ...
}
```

#### 2. Security
```typescript
{
  id: UUID
  symbol: 'AAPL'
  name: 'Apple Inc.'
  securityType: 'STOCK' | 'ETF' | 'BOND' | 'MUTUAL_FUND'
  exchange: 'NASDAQ'
  currencyCode: 'USD'
  isActive: true
}
```

#### 3. Holding
```typescript
{
  id: UUID
  accountId: UUID  // Links to Account
  securityId: UUID  // Links to Security
  quantity: 100.00000000  // Number of shares
  averageCost: 150.25  // Average cost per share
}
```

#### 4. SecurityPrice
```typescript
{
  id: UUID
  securityId: UUID
  priceDate: Date  // Trading day date (weekdays only)
  openPrice: 148.50
  highPrice: 152.00
  lowPrice: 147.80
  closePrice: 151.25
  volume: 58000000
}
```

#### 5. InvestmentTransaction
```typescript
{
  id: UUID
  userId: UUID
  accountId: UUID
  securityId: UUID
  action: 'BUY' | 'SELL' | 'DIVIDEND' | etc.
  transactionDate: Date
  quantity: 100
  price: 150.25
  commission: 9.99
  totalAmount: 15035.99  // Calculated: (qty * price) + commission
}
```

## Price Integration

Monize integrates with Yahoo Finance for real-time and historical security prices.

### Automatic Price Updates
- **Schedule**: Monday–Friday at 5 PM EST via cron job (`0 17 * * 1-5`)
- **Scope**: All active securities with holdings
- **Trading Date**: Uses Yahoo Finance's `regularMarketTime` to determine the actual trading date (avoids weekend duplicates)
- **Exchanges**: Supports US (NYSE, NASDAQ, AMEX) and Canadian (TSX, TSXV) exchanges
- Yahoo Finance symbols: US stocks use plain symbols (e.g., `AAPL`), Canadian stocks use `.TO` suffix (e.g., `RY.TO`)

### Manual Price Refresh
- `POST /api/v1/securities/prices/refresh` — Refresh prices for all held securities
- `POST /api/v1/securities/prices/refresh-security/:id` — Refresh a single security

### Historical Backfill
- `POST /api/v1/securities/prices/backfill/:id` — Backfill historical prices for a security

## Investment Transaction Types

### BUY
- **Effect on Holdings**: Increases quantity, updates average cost
- **Effect on Cash**: Decreases by `(quantity * price) + commission`
- **Formula**: `totalAmount = (quantity * price) + commission`

**Example**:
```json
{
  "action": "BUY",
  "accountId": "account-uuid",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 10,
  "price": 150.00,
  "commission": 9.99
}
```
- Holdings: +10 shares of AAPL
- Cash: -$1,509.99

### SELL
- **Effect on Holdings**: Decreases quantity, keeps same average cost
- **Effect on Cash**: Increases by `(quantity * price) - commission`
- **Formula**: `totalAmount = (quantity * price) - commission`

**Example**:
```json
{
  "action": "SELL",
  "accountId": "account-uuid",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 5,
  "price": 160.00,
  "commission": 9.99
}
```
- Holdings: -5 shares of AAPL
- Cash: +$790.01

### DIVIDEND
- **Effect on Holdings**: No change
- **Effect on Cash**: Increases by dividend amount
- **Note**: Use `quantity` as 1 and `price` as dividend amount, or calculate separately

**Example**:
```json
{
  "action": "DIVIDEND",
  "accountId": "account-uuid",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 1,
  "price": 45.50,
  "commission": 0
}
```
- Holdings: No change
- Cash: +$45.50

### REINVEST
- **Effect on Holdings**: Increases quantity using dividend to buy more shares
- **Effect on Cash**: No change (dividend used to purchase shares)

**Example**:
```json
{
  "action": "REINVEST",
  "accountId": "account-uuid",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 0.30,
  "price": 150.00,
  "commission": 0
}
```
- Holdings: +0.30 shares of AAPL
- Cash: No change

### TRANSFER_IN / TRANSFER_OUT
- **Effect on Holdings**: Increases/decreases quantity
- **Effect on Cash**: No change
- **Use Case**: Moving securities between accounts

### SPLIT
- **Effect on Holdings**: Adjusts quantity and average cost for stock splits
- **Effect on Cash**: No change

### ADD_SHARES / REMOVE_SHARES
- **Effect on Holdings**: Directly adds or removes shares
- **Effect on Cash**: No change
- **Use Case**: Correcting positions, initial setup

### INTEREST / CAPITAL_GAIN
- **Effect on Holdings**: No change
- **Effect on Cash**: Increases by amount

## API Endpoints

### Securities Management

#### Create Security
```http
POST /api/v1/securities
Authorization: Bearer {token}

{
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "securityType": "STOCK",
  "exchange": "NASDAQ",
  "currencyCode": "USD"
}
```

#### List Securities
```http
GET /api/v1/securities?includeInactive=false
Authorization: Bearer {token}
```

#### Search Securities
```http
GET /api/v1/securities/search?q=apple
Authorization: Bearer {token}
```

#### Lookup Security (Yahoo Finance)
```http
GET /api/v1/securities/lookup?q=AAPL
Authorization: Bearer {token}
```

#### Get Security by Symbol
```http
GET /api/v1/securities/symbol/AAPL
Authorization: Bearer {token}
```

### Holdings Management

#### List Holdings
```http
GET /api/v1/holdings?accountId={account-uuid}
Authorization: Bearer {token}
```

#### Get Holdings Summary
```http
GET /api/v1/holdings/summary?accountId={account-uuid}
Authorization: Bearer {token}

Response:
{
  "totalHoldings": 3,
  "totalQuantity": 150,
  "totalCostBasis": 22537.50,
  "holdings": [
    {
      "id": "holding-uuid",
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "quantity": 100,
      "averageCost": 150.25,
      "costBasis": 15025.00
    }
  ]
}
```

### Portfolio

#### Portfolio Summary
```http
GET /api/v1/portfolio/summary
Authorization: Bearer {token}

Response:
{
  "totalMarketValue": 125000.00,
  "totalCostBasis": 100000.00,
  "totalGainLoss": 25000.00,
  "totalGainLossPercent": 25.00,
  "holdings": [...]
}
```

#### Top Daily Movers
```http
GET /api/v1/portfolio/top-movers
Authorization: Bearer {token}

Response:
[
  {
    "securityId": "uuid",
    "symbol": "AAPL",
    "name": "Apple Inc.",
    "currencyCode": "USD",
    "currentPrice": 185.50,
    "previousPrice": 182.00,
    "dailyChange": 3.50,
    "dailyChangePercent": 1.92,
    "marketValue": 18550.00
  }
]
```

#### Asset Allocation
```http
GET /api/v1/portfolio/asset-allocation
Authorization: Bearer {token}
```

### Security Prices

#### Refresh All Prices
```http
POST /api/v1/securities/prices/refresh
Authorization: Bearer {token}
```

#### Refresh Single Security
```http
POST /api/v1/securities/prices/refresh-security/{id}
Authorization: Bearer {token}
```

#### Backfill Historical Prices
```http
POST /api/v1/securities/prices/backfill/{id}
Authorization: Bearer {token}
```

#### Get Price History
```http
GET /api/v1/securities/{id}/prices?startDate=2026-01-01&endDate=2026-01-31
Authorization: Bearer {token}
```

### Investment Transactions

#### Create Investment Transaction (Buy)
```http
POST /api/v1/investment-transactions
Authorization: Bearer {token}

{
  "accountId": "account-uuid",
  "action": "BUY",
  "securityId": "security-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 10,
  "price": 150.00,
  "commission": 9.99,
  "description": "Bought 10 shares of AAPL"
}
```

#### Create Investment Transaction (Dividend)
```http
POST /api/v1/investment-transactions
Authorization: Bearer {token}

{
  "accountId": "account-uuid",
  "action": "DIVIDEND",
  "securityId": "security-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 1,
  "price": 45.50,
  "commission": 0,
  "description": "Quarterly dividend"
}
```

#### List Investment Transactions
```http
GET /api/v1/investment-transactions?accountId={account-uuid}&startDate=2026-01-01&endDate=2026-01-31
Authorization: Bearer {token}
```

#### Get Investment Summary
```http
GET /api/v1/investment-transactions/summary?accountId={account-uuid}
Authorization: Bearer {token}

Response:
{
  "totalTransactions": 25,
  "totalBuys": 12,
  "totalSells": 8,
  "totalDividends": 125.50,
  "totalInterest": 15.25,
  "totalCapitalGains": 0,
  "totalCommissions": 99.88
}
```

#### Update Investment Transaction
```http
PATCH /api/v1/investment-transactions/{id}
Authorization: Bearer {token}

{
  "quantity": 15,
  "price": 148.50
}
```

#### Delete Investment Transaction
```http
DELETE /api/v1/investment-transactions/{id}
Authorization: Bearer {token}
```

## Typical Workflows

### 1. Setting Up an Investment Account

```bash
# Step 1: Create the investment account
POST /api/v1/accounts
{
  "accountType": "INVESTMENT",
  "investmentSubtype": "BROKERAGE",
  "name": "My Brokerage",
  "currencyCode": "USD",
  "openingBalance": 10000,
  "institution": "TD Ameritrade"
}

# Step 2: Search for securities (via Yahoo Finance lookup)
GET /api/v1/securities/lookup?q=AAPL

# Step 3: Create securities you want to track
POST /api/v1/securities
{
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "securityType": "STOCK",
  "exchange": "NASDAQ",
  "currencyCode": "USD"
}
```

### 2. Buying Securities

```bash
# Buy 10 shares of AAPL at $150/share with $9.99 commission
POST /api/v1/investment-transactions
{
  "accountId": "account-uuid",
  "action": "BUY",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 10,
  "price": 150.00,
  "commission": 9.99
}

# Result:
# - Account cash balance: $10,000 - $1,509.99 = $8,490.01
# - Holdings: 10 shares AAPL at avg cost $150.99/share
```

### 3. Receiving Dividends

```bash
# Record dividend payment
POST /api/v1/investment-transactions
{
  "accountId": "account-uuid",
  "action": "DIVIDEND",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 1,
  "price": 45.50,
  "commission": 0,
  "description": "Q1 2026 Dividend"
}

# Result:
# - Account cash balance: $8,490.01 + $45.50 = $8,535.51
# - Holdings: No change
```

### 4. Selling Securities

```bash
# Sell 5 shares of AAPL at $160/share with $9.99 commission
POST /api/v1/investment-transactions
{
  "accountId": "account-uuid",
  "action": "SELL",
  "securityId": "aapl-uuid",
  "transactionDate": "2026-01-24",
  "quantity": 5,
  "price": 160.00,
  "commission": 9.99
}

# Result:
# - Account cash balance: $8,535.51 + $790.01 = $9,325.52
# - Holdings: 5 shares AAPL (still at avg cost $150.99/share)
# - Realized gain: 5 * ($160 - $150.99) - $9.99 = $35.06
```

### 5. Adding Cash to Investment Account

```bash
# Regular transaction to add cash (deposit)
POST /api/v1/transactions
{
  "accountId": "investment-account-uuid",
  "transactionDate": "2026-01-24",
  "amount": 5000,
  "description": "Transfer from checking",
  "payeeName": "Deposit"
}

# Result:
# - Account cash balance increases by $5,000
# - Holdings: No change
```

### 6. Withdrawing Cash from Investment Account

```bash
# Regular transaction to withdraw cash
POST /api/v1/transactions
{
  "accountId": "investment-account-uuid",
  "transactionDate": "2026-01-24",
  "amount": -2000,
  "description": "Withdrawal to checking",
  "payeeName": "Withdrawal"
}

# Result:
# - Account cash balance decreases by $2,000
# - Holdings: No change
```

## Average Cost Calculation

When buying shares, the average cost is recalculated using a weighted average:

```typescript
// Example: You own 10 shares at $100/share, then buy 5 more at $120/share

const currentQuantity = 10;
const currentAvgCost = 100;
const buyQuantity = 5;
const buyPrice = 120;

const totalCostBefore = currentQuantity * currentAvgCost; // = 1000
const totalCostAdded = buyQuantity * buyPrice;            // = 600
const newQuantity = currentQuantity + buyQuantity;        // = 15
const newAvgCost = (totalCostBefore + totalCostAdded) / newQuantity;
// = (1000 + 600) / 15 = 106.67

// New holding: 15 shares at $106.67/share
```

When selling shares, the average cost **does not change**. This allows you to calculate realized gains/losses.

## Balance Tracking

### Account Balance
The `Account.currentBalance` represents **cash only** in the investment account. It does not include the market value of securities.

### Total Account Value
To calculate the total value of an investment account:

```typescript
totalValue = cashBalance + sum(holdings.quantity * currentMarketPrice)
```

### Unrealized Gains/Losses
```typescript
for each holding:
  costBasis = holding.quantity * holding.averageCost
  marketValue = holding.quantity * currentMarketPrice
  unrealizedGain = marketValue - costBasis
```

### Realized Gains/Losses
Calculated when selling:
```typescript
realizedGain = (sellPrice - averageCost) * quantitySold - commission
```

## Transaction Reversals

All investment transactions can be updated or deleted, and the system automatically:
1. Reverses the original effects on holdings and cash
2. Applies the new effects (for updates)
3. Maintains data integrity

### Update Example
```bash
# Original: Buy 10 shares at $150
# Update: Change to 15 shares at $148

PATCH /api/v1/investment-transactions/{id}
{
  "quantity": 15,
  "price": 148
}

# Process:
# 1. Reverse original: Remove 10 shares, add back cash
# 2. Apply new: Add 15 shares, remove new cash amount
```

### Delete Example
```bash
# Delete a buy transaction
DELETE /api/v1/investment-transactions/{id}

# Process:
# 1. Remove shares from holdings
# 2. Refund cash to account
# 3. Delete transaction record
```

## Security Features

- **User Ownership**: All operations verify user owns the account
- **Account Type Validation**: Only INVESTMENT accounts can have investment transactions
- **Security Validation**: Securities must exist before use
- **Balance Checks**: System prevents negative cash balances (handled by database constraints)
- **Atomic Operations**: Holdings and cash updates are transactional

## Database Schema

All tables are already created in the database:

- `securities` - Security master data (symbol, name, type, exchange, currency)
- `holdings` - Current positions per account (quantity, average cost)
- `investment_transactions` - Transaction history (buy, sell, dividend, etc.)
- `security_prices` - Historical price data with daily OHLCV data (updated automatically)

Constraints:
- `UNIQUE(account_id, security_id)` on holdings - one holding per security per account
- `UNIQUE(security_id, price_date)` on security_prices - one price per security per trading day
- Foreign keys with CASCADE deletes for data integrity
- Decimal precision: 20,4 for prices, 20,8 for quantities

## Multi-Currency Support

Securities can be denominated in different currencies than the investment account:
- Each security has its own `currencyCode` (e.g., USD for US stocks, CAD for TSX stocks)
- The portfolio summary and top movers display prices in the security's native currency
- Foreign securities (different from user's default currency) show the currency code alongside the price
- Exchange rates are updated daily for portfolio valuation in the user's default currency

## Next Steps

Potential enhancements:
1. **Performance Tracking**: Calculate IRR, TWR, and other metrics
2. **Tax Reporting**: Generate capital gains reports
3. **Lot Tracking**: Track specific tax lots (FIFO, LIFO, specific identification)
4. **Corporate Actions**: Handle mergers, spinoffs
5. **Margin Accounts**: Track margin borrowing and interest

## File Reference

Key backend files:
- [security.entity.ts](src/securities/entities/security.entity.ts) - Security model
- [security-price.entity.ts](src/securities/entities/security-price.entity.ts) - Price data model
- [holding.entity.ts](src/securities/entities/holding.entity.ts) - Holding model
- [investment-transaction.entity.ts](src/securities/entities/investment-transaction.entity.ts) - Transaction model
- [securities.service.ts](src/securities/securities.service.ts) - Security operations
- [security-price.service.ts](src/securities/security-price.service.ts) - Price refresh and Yahoo Finance integration
- [portfolio.service.ts](src/securities/portfolio.service.ts) - Portfolio summary, top movers, asset allocation
- [holdings.service.ts](src/securities/holdings.service.ts) - Holdings operations
- [investment-transactions.service.ts](src/securities/investment-transactions.service.ts) - Transaction processing
- [securities.controller.ts](src/securities/securities.controller.ts) - Security API
- [holdings.controller.ts](src/securities/holdings.controller.ts) - Holdings API
- [portfolio.controller.ts](src/securities/portfolio.controller.ts) - Portfolio API
- [investment-transactions.controller.ts](src/securities/investment-transactions.controller.ts) - Transactions API
- [securities.module.ts](src/securities/securities.module.ts) - Module configuration
