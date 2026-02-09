# Category Integration with Payees and Transactions

This document explains how categories are integrated with payees and transactions in Monize, including automatic category assignment and split transaction support.

## Overview

Categories in Monize work on two levels:

1. **Simple Transactions**: Single category per transaction (via `categoryId` field)
2. **Split Transactions**: Multiple categories per transaction (via `transaction_splits` table)

Additionally, **payees can have a default category** that automatically applies to new transactions.

## Architecture

### Three-Level Category System

```
Payee → Default Category (optional)
  ↓
Transaction → Category (simple) OR Splits (multiple categories)
  ↓
TransactionSplit → Category (per split)
```

### Entities

#### 1. Transaction Entity (Enhanced)

```typescript
@Entity('transactions')
export class Transaction {
  // ... other fields ...

  @Column({ type: 'uuid', name: 'category_id', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @Column({ name: 'is_split', default: false })
  isSplit: boolean;

  @OneToMany(() => TransactionSplit, (split) => split.transaction)
  splits: TransactionSplit[];
}
```

**Key Points**:
- `categoryId`: For simple (non-split) transactions
- `category`: Loaded relation with full category details
- `isSplit`: Flag indicating if transaction uses splits
- `splits`: Array of split details (for split transactions)

#### 2. TransactionSplit Entity

```typescript
@Entity('transaction_splits')
export class TransactionSplit {
  @Column({ type: 'uuid', name: 'transaction_id' })
  transactionId: string;

  @Column({ type: 'uuid', name: 'category_id', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  category: Category | null;

  @Column({ type: 'decimal', precision: 20, scale: 4 })
  amount: number;

  @Column({ type: 'text', nullable: true })
  memo: string | null;
}
```

**Use Cases**:
- Grocery shopping with different categories (food, household, pets)
- Rent payment split between roommates with different accounts
- Business expense with personal and business portions

#### 3. Payee Entity (With Default Category)

```typescript
@Entity('payees')
export class Payee {
  @Column({ type: 'uuid', name: 'default_category_id', nullable: true })
  defaultCategoryId: string;

  @ManyToOne(() => Category, { nullable: true })
  defaultCategory: Category | null;
}
```

## Automatic Category Assignment

When creating a transaction with a payee, the system automatically assigns the payee's default category if no category is provided.

### Flow

```
1. User creates transaction with payeeId
2. No categoryId provided
3. System fetches payee
4. If payee.defaultCategoryId exists, assign it to transaction.categoryId
5. Transaction created with category auto-filled
```

### Implementation

In `TransactionsService.create()`:

```typescript
// Auto-assign category from payee's default category if not provided
let categoryId = createTransactionDto.categoryId;
if (!categoryId && createTransactionDto.payeeId) {
  try {
    const payee = await this.payeesService.findOne(userId, createTransactionDto.payeeId);
    if (payee.defaultCategoryId) {
      categoryId = payee.defaultCategoryId;
    }
  } catch (error) {
    // If payee not found or error, continue without category
  }
}
```

## API Usage

### Create Transaction with Auto Category Assignment

```http
POST /api/v1/transactions
{
  "accountId": "account-uuid",
  "transactionDate": "2026-01-24",
  "payeeId": "starbucks-uuid",  # Has defaultCategoryId: "cafe-uuid"
  "amount": -5.50
  # categoryId NOT provided
}

Response:
{
  "id": "transaction-uuid",
  "payeeId": "starbucks-uuid",
  "categoryId": "cafe-uuid",  # ← Automatically assigned!
  "payee": {
    "id": "starbucks-uuid",
    "name": "Starbucks",
    "defaultCategoryId": "cafe-uuid"
  },
  "category": {
    "id": "cafe-uuid",
    "name": "Cafes & Coffee Shops",
    "isIncome": false
  },
  ...
}
```

### Override Auto-Assignment

```http
POST /api/v1/transactions
{
  "accountId": "account-uuid",
  "payeeId": "starbucks-uuid",  # Has defaultCategoryId: "cafe-uuid"
  "categoryId": "business-meals-uuid",  # Override with explicit category
  "amount": -5.50
}

Response:
{
  "categoryId": "business-meals-uuid",  # ← Explicit category used
  ...
}
```

### Create Transaction Without Payee

```http
POST /api/v1/transactions
{
  "accountId": "account-uuid",
  "payeeName": "One-time vendor",
  "categoryId": "miscellaneous-uuid",  # Must provide category manually
  "amount": -25.00
}
```

### Fetch Transactions with Categories

```http
GET /api/v1/transactions?accountId=account-uuid

Response:
[
  {
    "id": "transaction-uuid",
    "payeeId": "starbucks-uuid",
    "categoryId": "cafe-uuid",
    "payee": {
      "id": "starbucks-uuid",
      "name": "Starbucks",
      "defaultCategory": {
        "id": "cafe-uuid",
        "name": "Cafes & Coffee Shops"
      }
    },
    "category": {  # ← Automatically loaded
      "id": "cafe-uuid",
      "name": "Cafes & Coffee Shops",
      "isIncome": false,
      "color": "#FF6B6B"
    },
    ...
  }
]
```

## Payee-Category Management

### Get Payees by Category

```http
GET /api/v1/payees/by-category/{categoryId}

Response:
[
  {
    "id": "starbucks-uuid",
    "name": "Starbucks",
    "defaultCategoryId": "cafe-uuid",
    "defaultCategory": {
      "id": "cafe-uuid",
      "name": "Cafes & Coffee Shops"
    }
  },
  {
    "id": "dunkin-uuid",
    "name": "Dunkin Donuts",
    "defaultCategoryId": "cafe-uuid",
    "defaultCategory": {
      "id": "cafe-uuid",
      "name": "Cafes & Coffee Shops"
    }
  }
]
```

### Update Payee's Default Category

```http
PATCH /api/v1/payees/{payeeId}
{
  "defaultCategoryId": "new-category-uuid"
}
```

**Effect**:
- Future transactions with this payee will auto-assign the new category
- Existing transactions remain unchanged

## Database Schema

### Migration File

Location: `/database/migrations/002_add_category_to_transactions.sql`

```sql
-- Add category_id column to transactions table
ALTER TABLE transactions
ADD COLUMN category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

-- Add index for performance
CREATE INDEX idx_transactions_category ON transactions(category_id);
```

**Important**: Run this migration before using category features:

```bash
psql -U postgres -d monize -f database/migrations/002_add_category_to_transactions.sql
```

### Existing Tables

```sql
-- Categories (already exists)
CREATE TABLE categories (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    parent_id UUID REFERENCES categories(id),  -- For subcategories
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    color VARCHAR(7),  -- hex color
    is_income BOOLEAN DEFAULT false,
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payees (already exists, has defaultCategoryId)
CREATE TABLE payees (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    default_category_id UUID REFERENCES categories(id),  -- Auto-assignment
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Transaction Splits (already exists)
CREATE TABLE transaction_splits (
    id UUID PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id),
    amount NUMERIC(20, 4) NOT NULL,
    memo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Workflows

### 1. Setting Up Payees with Categories

```bash
# Create categories first
POST /api/v1/categories
{
  "name": "Groceries",
  "isIncome": false,
  "color": "#4CAF50"
}

# Create payee with default category
POST /api/v1/payees
{
  "name": "Whole Foods",
  "defaultCategoryId": "groceries-category-uuid"
}
```

### 2. Quick Transaction Entry

```bash
# User selects "Whole Foods" from autocomplete
# Frontend gets payee with defaultCategoryId
# User creates transaction - category auto-fills

POST /api/v1/transactions
{
  "accountId": "checking-uuid",
  "payeeId": "whole-foods-uuid",
  "amount": -85.50
  # categoryId auto-assigned from payee
}
```

### 3. Bulk Category Updates

```bash
# Update all Starbucks transactions to new category
# 1. Update payee's default category
PATCH /api/v1/payees/starbucks-uuid
{
  "defaultCategoryId": "business-meals-uuid"
}

# 2. Find all Starbucks transactions
GET /api/v1/transactions?payeeId=starbucks-uuid

# 3. Update each transaction (if needed)
PATCH /api/v1/transactions/{transaction-id}
{
  "categoryId": "business-meals-uuid"
}
```

### 4. Split Transaction (Future Enhancement)

```bash
# Create split transaction
POST /api/v1/transactions
{
  "accountId": "checking-uuid",
  "payeeName": "Walmart",
  "amount": -120.00,
  "isSplit": true
}

# Add splits
POST /api/v1/transaction-splits
{
  "transactionId": "transaction-uuid",
  "categoryId": "groceries-uuid",
  "amount": -80.00,
  "memo": "Food items"
}

POST /api/v1/transaction-splits
{
  "transactionId": "transaction-uuid",
  "categoryId": "household-uuid",
  "amount": -40.00,
  "memo": "Cleaning supplies"
}
```

## Benefits

### For Users
1. **Faster Data Entry**: Categories auto-fill based on payee
2. **Consistency**: Same payee always gets same category
3. **Flexibility**: Can override auto-assignment when needed
4. **Organization**: Group payees by category

### For Reporting
1. **Accurate Categorization**: Most transactions automatically categorized
2. **Spending by Category**: Easy to generate category-based reports
3. **Budget Tracking**: Compare actual spending vs budget per category
4. **Trend Analysis**: Track category spending over time

## Best Practices

### 1. Set Default Categories for Common Payees

```javascript
const commonPayees = [
  { name: "Grocery Store", category: "Groceries" },
  { name: "Gas Station", category: "Transportation" },
  { name: "Electric Company", category: "Utilities" },
  { name: "Landlord", category: "Rent" },
  { name: "Gym Membership", category: "Health & Fitness" },
];
```

### 2. Use Specific Categories

Instead of generic "Shopping", use:
- "Groceries"
- "Clothing"
- "Electronics"
- "Home Improvement"

### 3. Review Uncategorized Transactions

```bash
# Find transactions without category
GET /api/v1/transactions

# Filter on frontend:
transactions.filter(t => !t.categoryId && !t.isSplit)
```

### 4. Periodic Category Cleanup

- Merge duplicate categories
- Update payee default categories
- Recategorize misclassified transactions

## File Reference

Key files:
- [transaction.entity.ts](src/transactions/entities/transaction.entity.ts) - Transaction with categoryId
- [transaction-split.entity.ts](src/transactions/entities/transaction-split.entity.ts) - Split details
- [transactions.service.ts](src/transactions/transactions.service.ts) - Auto-assignment logic
- [transactions.module.ts](src/transactions/transactions.module.ts) - Module with PayeesModule import
- [payees.service.ts](src/payees/payees.service.ts) - findByCategory method
- [create-transaction.dto.ts](src/transactions/dto/create-transaction.dto.ts) - DTO with categoryId
- [002_add_category_to_transactions.sql](../database/migrations/002_add_category_to_transactions.sql) - Migration

## TODO: Manual Controller Update

Add this method to `payees.controller.ts` after the `summary` endpoint:

```typescript
@Get('by-category/:categoryId')
@ApiOperation({ summary: 'Get all payees with a specific default category' })
@ApiResponse({ status: 200, description: 'Payees in category', type: [Payee] })
getByCategory(@Request() req, @Param('categoryId', ParseUUIDPipe) categoryId: string): Promise<Payee[]> {
  return this.payeesService.findByCategory(req.user.id, categoryId);
}
```

Note: Place this BEFORE the `@Get(':id')` endpoint to avoid route conflicts.

## Next Steps

Potential enhancements:
1. **Split Transaction UI**: Full CRUD for transaction splits
2. **Category Rules**: Auto-categorize based on amount + payee + description
3. **Category Budgets**: Set spending limits per category
4. **Category Reports**: Spending trends and visualizations
5. **Subcategories**: Hierarchical category structure (already supported in DB)
6. **Category Transfer**: Move all transactions from one category to another
