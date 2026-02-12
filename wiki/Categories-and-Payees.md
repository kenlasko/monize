# Categories and Payees

Categories and payees are the organizational backbone of your financial data. Categories classify *what* the money was for, while payees track *who* the money went to or came from.

---

## Table of Contents

- [Categories](#categories)
  - [Category Hierarchy](#category-hierarchy)
  - [Managing Categories](#managing-categories)
  - [Income vs Expense Categories](#income-vs-expense-categories)
  - [System Categories](#system-categories)
- [Payees](#payees)
  - [Managing Payees](#managing-payees)
  - [Default Categories](#default-categories)
  - [Payee Auto-Complete](#payee-auto-complete)
  - [Most Used and Recently Used](#most-used-and-recently-used)

---

## Categories

Categories are used to classify transactions by purpose (e.g., "Groceries," "Rent," "Salary"). They form a hierarchical tree structure with parent and child categories.

### Category Hierarchy

Categories support parent-child relationships for detailed tracking:

```
Food & Dining (parent)
  |- Groceries (child)
  |- Restaurants (child)
  |- Coffee Shops (child)

Housing (parent)
  |- Rent (child)
  |- Utilities (child)
  |- Maintenance (child)
```

When viewing reports, you can see totals at the parent level (all "Food & Dining") or drill down to individual children (just "Groceries").

### Managing Categories

Navigate to **Tools > Categories** to access the category management page.

![Categories Page](images/categories-page.png)
<!-- Screenshot: The categories management page showing the hierarchical list of categories with edit/delete buttons -->

#### Creating a Category

1. Click **Add Category**
2. Enter the category details:

| Field | Description |
|-------|-------------|
| **Name** | Category name (e.g., "Groceries") |
| **Parent** | Optional parent category for nesting |
| **Type** | Income or Expense |
| **Colour** | Visual colour for reports and charts |

3. Click **Save**

#### Editing a Category

Click the edit button next to any category to modify its name, parent, type, or colour.

#### Deleting a Category

Categories can only be deleted if no transactions reference them. If transactions use the category, you must reassign them first or choose to merge the category into another one.

### Income vs Expense Categories

Each category is marked as either **Income** or **Expense**:

- **Income categories** -- Salary, freelance income, investment returns, etc.
- **Expense categories** -- Groceries, rent, utilities, entertainment, etc.

This classification determines how transactions are counted in reports (income vs. expenses charts).

### System Categories

Monize includes a set of default system categories that cannot be deleted. These provide a starting point and cover common financial categories. You can rename them or add child categories to customize them for your needs.

---

## Payees

Payees represent the people, businesses, or entities you transact with. Every transaction can optionally be assigned a payee.

### Managing Payees

Navigate to **Tools > Payees** to access the payee management page.

![Payees Page](images/payees-page.png)
<!-- Screenshot: The payees management page showing a list of payees with default categories and transaction counts -->

#### Creating a Payee

1. Click **Add Payee**
2. Enter the payee details:

| Field | Description |
|-------|-------------|
| **Name** | Payee name (e.g., "Amazon", "City Hydro") |
| **Default Category** | Auto-assigned category for new transactions with this payee |
| **Notes** | Optional notes about the payee |

3. Click **Save**

Payees can also be created inline when creating a transaction -- if you type a name that does not exist, you can create it on the fly.

#### Editing a Payee

Click the edit button next to any payee to modify its name, default category, or notes.

#### Merging Payees

If you have duplicate payees (e.g., "Amazon" and "Amazon.com"), you can merge them by renaming one to match the other. All transactions will be reassigned to the surviving payee.

#### Deleting a Payee

Payees can be deleted. Transactions that referenced the deleted payee will have their payee field cleared.

### Default Categories

One of the most powerful features of payees is the **default category**. When you assign a default category to a payee:

1. The next time you create a transaction for that payee, the category is automatically filled in
2. This saves time and ensures consistent categorization
3. You can always override the default for individual transactions

For example, if you set "Loblaws" with a default category of "Groceries," every new transaction to Loblaws will automatically be categorized as Groceries.

### Payee Auto-Complete

When typing a payee name in the transaction form, Monize provides auto-complete suggestions based on:

1. **Existing payees** matching your typed text
2. **Most frequently used** payees appearing first
3. **Recently used** payees given priority

This makes data entry faster and more consistent.

### Most Used and Recently Used

The payee system tracks usage statistics to improve the auto-complete experience:

- **Most Used** -- Payees with the highest transaction count appear first in suggestions
- **Recently Used** -- Payees from recent transactions are prioritized for quick access

These statistics are computed efficiently using a single database query that includes the default category information.
