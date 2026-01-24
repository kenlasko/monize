# Payees Management Guide

This document explains how payees work in MoneyMate, including creation, management, and integration with transactions.

## Overview

Payees represent the people, businesses, or entities you transact with. The payees system in MoneyMate provides:

- **Auto-complete**: Quick payee selection when entering transactions
- **Default Categories**: Automatically assign categories based on payee
- **Transaction Tracking**: Link transactions to specific payees
- **Search & Filter**: Find payees by name
- **Usage Analytics**: Most used and recently used payees

## Architecture

### Payee Entity

```typescript
{
  id: UUID
  userId: UUID
  name: 'Starbucks'
  defaultCategoryId: UUID | null  // Optional default category
  notes: 'Local coffee shop on Main Street'
  createdAt: Date
}
```

**Key Features**:
- **Unique Constraint**: Each user can only have one payee with a specific name
- **Default Category**: Optional category auto-applied to new transactions
- **Notes**: Additional information about the payee

### Relationship with Transactions

Transactions have two payee-related fields:

1. **payeeId**: Links to the Payee entity (optional, can be null)
2. **payeeName**: Free-text payee name (can differ from `payee.name`)

This dual approach allows:
- Linking transactions to managed payees (via `payeeId`)
- One-time or custom payee names (via `payeeName` without `payeeId`)
- Overriding payee display name per transaction

```typescript
// Transaction with linked payee
{
  payeeId: 'payee-uuid',
  payeeName: 'Starbucks Downtown',  // Display name can differ
  payee: {  // Populated via relation
    id: 'payee-uuid',
    name: 'Starbucks',
    defaultCategoryId: 'cafe-category-uuid'
  }
}

// Transaction with one-time payee
{
  payeeId: null,
  payeeName: 'John Doe',
  payee: null
}
```

## API Endpoints

### Create Payee

```http
POST /api/v1/payees
Authorization: Bearer {token}

{
  "name": "Starbucks",
  "defaultCategoryId": "category-uuid",  // optional
  "notes": "Local coffee shop on Main Street"  // optional
}

Response: 201 Created
{
  "id": "payee-uuid",
  "userId": "user-uuid",
  "name": "Starbucks",
  "defaultCategoryId": "category-uuid",
  "notes": "Local coffee shop on Main Street",
  "createdAt": "2026-01-24T10:00:00Z",
  "defaultCategory": {
    "id": "category-uuid",
    "name": "Dining & Drinks",
    ...
  }
}
```

### List All Payees

```http
GET /api/v1/payees
Authorization: Bearer {token}

Response: 200 OK
[
  {
    "id": "payee-uuid-1",
    "name": "Starbucks",
    "defaultCategoryId": "category-uuid",
    "notes": "...",
    "createdAt": "...",
    "defaultCategory": {...}
  },
  ...
]
```

### Search Payees

```http
GET /api/v1/payees/search?q=star&limit=10
Authorization: Bearer {token}

Response: 200 OK
[
  {
    "id": "payee-uuid",
    "name": "Starbucks",
    ...
  }
]
```

**Use Cases**:
- General search across all payees
- Finding payees containing a specific word
- Case-insensitive partial matching

### Autocomplete Payees

```http
GET /api/v1/payees/autocomplete?q=star
Authorization: Bearer {token}

Response: 200 OK
[
  {
    "id": "payee-uuid-1",
    "name": "Starbucks",
    ...
  },
  {
    "id": "payee-uuid-2",
    "name": "Star Market",
    ...
  }
]
```

**Use Cases**:
- Transaction entry form autocomplete
- Returns only payees starting with the query
- Limited to 10 results for performance

### Get Most Used Payees

```http
GET /api/v1/payees/most-used?limit=10
Authorization: Bearer {token}

Response: 200 OK
[
  {
    "id": "payee-uuid",
    "name": "Grocery Store",
    ...
  }
]
```

**Use Cases**:
- Quick access to frequent payees
- Transaction entry shortcuts
- Ordered by transaction count (descending)

### Get Recently Used Payees

```http
GET /api/v1/payees/recently-used?limit=10
Authorization: Bearer {token}

Response: 200 OK
[
  {
    "id": "payee-uuid",
    "name": "Gas Station",
    ...
  }
]
```

**Use Cases**:
- Quick access to recent payees
- Transaction entry shortcuts
- Ordered by most recent transaction date

### Get Payee Summary

```http
GET /api/v1/payees/summary
Authorization: Bearer {token}

Response: 200 OK
{
  "totalPayees": 45,
  "payeesWithCategory": 38,
  "payeesWithoutCategory": 7
}
```

### Get Single Payee

```http
GET /api/v1/payees/{id}
Authorization: Bearer {token}

Response: 200 OK
{
  "id": "payee-uuid",
  "name": "Starbucks",
  "defaultCategoryId": "category-uuid",
  "notes": "...",
  "createdAt": "...",
  "defaultCategory": {...}
}
```

### Update Payee

```http
PATCH /api/v1/payees/{id}
Authorization: Bearer {token}

{
  "name": "Starbucks Coffee",
  "defaultCategoryId": "new-category-uuid",
  "notes": "Updated notes"
}

Response: 200 OK
{
  "id": "payee-uuid",
  "name": "Starbucks Coffee",
  ...
}
```

### Delete Payee

```http
DELETE /api/v1/payees/{id}
Authorization: Bearer {token}

Response: 200 OK
```

**Note**: Deleting a payee does NOT delete associated transactions. Transactions will keep their `payeeName` but `payeeId` will be set to null (via database ON DELETE SET NULL - check schema).

## Integration with Transactions

### Creating Transaction with Payee

#### Option 1: Link to Existing Payee

```http
POST /api/v1/transactions
{
  "accountId": "account-uuid",
  "transactionDate": "2026-01-24",
  "payeeId": "starbucks-uuid",
  "amount": -5.50,
  "description": "Morning coffee"
}
```

The transaction will:
- Link to the payee via `payeeId`
- Automatically use the payee's name as `payeeName`
- Optionally inherit `defaultCategoryId` (if implemented in frontend)

#### Option 2: One-Time Payee Name

```http
POST /api/v1/transactions
{
  "accountId": "account-uuid",
  "transactionDate": "2026-01-24",
  "payeeName": "John Doe",
  "amount": -20.00,
  "description": "Repay loan"
}
```

The transaction will:
- Have `payeeId` as null
- Store "John Doe" in `payeeName`
- Not link to any managed payee

#### Option 3: Override Payee Display Name

```http
POST /api/v1/transactions
{
  "accountId": "account-uuid",
  "transactionDate": "2026-01-24",
  "payeeId": "starbucks-uuid",
  "payeeName": "Starbucks Downtown",
  "amount": -5.50
}
```

The transaction will:
- Link to "Starbucks" payee via `payeeId`
- Display as "Starbucks Downtown" using `payeeName`

### Fetching Transactions with Payee Data

When you fetch transactions, the payee relation is automatically loaded:

```http
GET /api/v1/transactions?accountId=account-uuid

Response:
[
  {
    "id": "transaction-uuid",
    "transactionDate": "2026-01-24",
    "payeeId": "starbucks-uuid",
    "payeeName": "Starbucks",
    "amount": -5.50,
    "payee": {
      "id": "starbucks-uuid",
      "name": "Starbucks",
      "defaultCategoryId": "cafe-uuid",
      "defaultCategory": {
        "id": "cafe-uuid",
        "name": "Cafes & Coffee Shops"
      }
    },
    ...
  },
  {
    "id": "transaction-uuid-2",
    "transactionDate": "2026-01-23",
    "payeeId": null,
    "payeeName": "Jane Doe",
    "amount": -15.00,
    "payee": null,
    ...
  }
]
```

## Typical Workflows

### 1. Setting Up Payees

```bash
# Create common payees with default categories

POST /api/v1/payees
{
  "name": "Grocery Store",
  "defaultCategoryId": "groceries-category-uuid"
}

POST /api/v1/payees
{
  "name": "Gas Station",
  "defaultCategoryId": "transportation-category-uuid"
}

POST /api/v1/payees
{
  "name": "Electric Company",
  "defaultCategoryId": "utilities-category-uuid"
}
```

### 2. Transaction Entry with Autocomplete

```bash
# User types "gro" in transaction form
GET /api/v1/payees/autocomplete?q=gro

Response:
[
  {
    "id": "payee-uuid",
    "name": "Grocery Store",
    "defaultCategoryId": "groceries-category-uuid"
  }
]

# User selects "Grocery Store", frontend creates transaction:
POST /api/v1/transactions
{
  "accountId": "checking-uuid",
  "transactionDate": "2026-01-24",
  "payeeId": "payee-uuid",
  "amount": -85.50,
  "categoryId": "groceries-category-uuid"  // auto-filled from payee
}
```

### 3. Finding All Transactions for a Payee

```bash
# Get all transactions
GET /api/v1/transactions

# Filter on frontend by payeeId
transactions.filter(t => t.payeeId === 'starbucks-uuid')

# Or search by payee name
transactions.filter(t => t.payeeName?.includes('Starbucks'))
```

### 4. Bulk Categorization

```bash
# Update payee's default category
PATCH /api/v1/payees/starbucks-uuid
{
  "defaultCategoryId": "dining-category-uuid"
}

# Future transactions will inherit this category
# Existing transactions remain unchanged unless manually updated
```

### 5. Merging Duplicate Payees

```bash
# User has two payees: "Grocery Store" and "grocery store"

# 1. Get all transactions with the duplicate
GET /api/v1/transactions

# 2. Update each transaction to use the correct payee
PATCH /api/v1/transactions/{transaction-id}
{
  "payeeId": "correct-payee-uuid"
}

# 3. Delete the duplicate payee
DELETE /api/v1/payees/{duplicate-payee-uuid}
```

## Advanced Features

### Find or Create Pattern

The service includes a `findOrCreate` method for automatic payee management:

```typescript
// In service layer
const payee = await payeesService.findOrCreate(
  userId,
  'New Payee Name',
  optionalCategoryId
);

// If payee exists: returns existing
// If payee doesn't exist: creates and returns new one
```

**Use Case**: Import transactions from bank statements where payee names may not exist yet.

### Default Category Inheritance

When creating a transaction with a payee that has a `defaultCategoryId`:

```typescript
// Frontend logic
if (selectedPayee.defaultCategoryId && !transaction.categoryId) {
  transaction.categoryId = selectedPayee.defaultCategoryId;
}
```

This automatically categorizes transactions based on the payee.

### Payee Usage Analytics

Track which payees are used most frequently:

```bash
# Get top 5 most used payees
GET /api/v1/payees/most-used?limit=5

Response:
[
  {"name": "Grocery Store", "transactionCount": 48},
  {"name": "Gas Station", "transactionCount": 32},
  {"name": "Starbucks", "transactionCount": 28},
  ...
]
```

## Data Model Considerations

### Payee Name vs Transaction Payee Name

- **Payee.name**: The canonical name of the payee
- **Transaction.payeeName**: The display name for this specific transaction

Example:
- Payee: "Amazon"
- Transaction 1: payeeName = "Amazon Prime"
- Transaction 2: payeeName = "Amazon Marketplace"
- Both link to the same payee via `payeeId`

### Null Payees

Transactions can have:
1. **Both null**: `payeeId = null`, `payeeName = null` - no payee
2. **Only name**: `payeeId = null`, `payeeName = "..."` - one-time payee
3. **Linked**: `payeeId = "uuid"`, `payeeName = "..."` - managed payee

### Unique Constraint

Each user can only have ONE payee with a specific name:
- Constraint: `UNIQUE(user_id, name)`
- Prevents: Creating "Starbucks" twice
- Case-sensitive: "starbucks" and "Starbucks" are different

## Security

- **User Isolation**: All endpoints verify user ownership
- **Forbidden Access**: Cannot access other users' payees
- **Cascade Delete**: Deleting a user deletes all their payees
- **Soft Delete on Transactions**: Deleting a payee nullifies transaction links but keeps transaction data

## Best Practices

### 1. Consistent Naming
Use consistent payee names:
- ✅ "Starbucks"
- ❌ "starbucks", "STARBUCKS", "Starbucks Coffee"

### 2. Default Categories
Set default categories for frequently used payees:
```javascript
{
  "Grocery Store": "Groceries",
  "Gas Station": "Transportation",
  "Electric Company": "Utilities",
  "Rent": "Housing"
}
```

### 3. Notes for Context
Use notes field for additional information:
```javascript
{
  "name": "Dr. Smith",
  "notes": "Dentist on 5th Avenue"
}
```

### 4. Autocomplete in UI
Implement autocomplete for better UX:
- Trigger after 2-3 characters
- Show defaultCategory in dropdown
- Allow creating new payee on-the-fly

### 5. Payee Cleanup
Periodically clean up unused payees:
```sql
-- Find payees with no transactions
SELECT p.* FROM payees p
LEFT JOIN transactions t ON t.payee_id = p.id
WHERE t.id IS NULL;
```

## Error Handling

### Duplicate Payee Name
```http
POST /api/v1/payees
{"name": "Starbucks"}

Response: 409 Conflict
{
  "statusCode": 409,
  "message": "Payee with name \"Starbucks\" already exists"
}
```

### Payee Not Found
```http
GET /api/v1/payees/invalid-uuid

Response: 404 Not Found
{
  "statusCode": 404,
  "message": "Payee with ID invalid-uuid not found"
}
```

### Invalid Category
```http
POST /api/v1/payees
{
  "name": "New Payee",
  "defaultCategoryId": "invalid-uuid"
}

Response: 400 Bad Request
// Foreign key constraint violation
```

## File Reference

Key backend files:
- [payee.entity.ts](src/payees/entities/payee.entity.ts) - Payee model
- [payees.service.ts](src/payees/payees.service.ts) - Business logic with search/autocomplete
- [payees.controller.ts](src/payees/payees.controller.ts) - API endpoints
- [create-payee.dto.ts](src/payees/dto/create-payee.dto.ts) - Creation validation
- [update-payee.dto.ts](src/payees/dto/update-payee.dto.ts) - Update validation
- [payees.module.ts](src/payees/payees.module.ts) - Module configuration
- [transaction.entity.ts](src/transactions/entities/transaction.entity.ts) - Transaction with payee relation

## Next Steps

Potential enhancements:
1. **Payee Aliases**: Multiple names for the same payee
2. **Auto-categorization Rules**: Complex rules based on payee + amount + description
3. **Payee Logos**: Store/fetch logos for visual identification
4. **Transaction Patterns**: Detect recurring transactions with same payee
5. **Spending by Payee**: Analytics showing total spent per payee
6. **Payee Merging UI**: Tool to merge duplicate payees
7. **Import Mapping**: Map imported payee names to existing payees
