#!/bin/bash

# Sample Data Creation Script for MoneyMate (Docker version)
# Run this after registering a user and logging in

echo "=========================================="
echo "MoneyMate Sample Data Creator (Docker)"
echo "=========================================="
echo ""

# Check if jq is installed for JSON parsing
if ! command -v jq &> /dev/null; then
    echo "jq is not installed. Installing..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y jq
    elif command -v brew &> /dev/null; then
        brew install jq
    else
        echo "Please install jq manually: https://stedolan.github.io/jq/download/"
        exit 1
    fi
fi

# Backend API URL
API_URL="http://localhost:3000"

# Prompt for authentication
echo "First, you need to login to get your JWT token."
echo ""
read -p "Enter your email: " EMAIL
read -sp "Enter your password: " PASSWORD
echo ""
echo ""

# Login and get JWT token
echo "Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST $API_URL/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.accessToken')

if [ "$TOKEN" == "null" ] || [ -z "$TOKEN" ]; then
    echo "❌ Login failed. Please check your credentials."
    echo "Response: $LOGIN_RESPONSE"
    exit 1
fi

echo "✅ Login successful!"
echo ""

# Create Categories
echo "Creating categories..."

# Expense Categories
GROCERIES=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Groceries","type":"EXPENSE","color":"#10b981"}' | jq -r '.id')
echo "✅ Created: Groceries"

UTILITIES=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Utilities","type":"EXPENSE","color":"#f59e0b"}' | jq -r '.id')
echo "✅ Created: Utilities"

ENTERTAINMENT=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Entertainment","type":"EXPENSE","color":"#8b5cf6"}' | jq -r '.id')
echo "✅ Created: Entertainment"

DINING=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Dining Out","type":"EXPENSE","color":"#ef4444"}' | jq -r '.id')
echo "✅ Created: Dining Out"

TRANSPORT=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Transportation","type":"EXPENSE","color":"#3b82f6"}' | jq -r '.id')
echo "✅ Created: Transportation"

# Income Categories
SALARY=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Salary","type":"INCOME","color":"#059669"}' | jq -r '.id')
echo "✅ Created: Salary"

FREELANCE=$(curl -s -X POST $API_URL/categories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Freelance","type":"INCOME","color":"#0891b2"}' | jq -r '.id')
echo "✅ Created: Freelance"

echo ""

# Create Accounts
echo "Creating accounts..."

CHECKING=$(curl -s -X POST $API_URL/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Checking Account","type":"CHECKING","currencyCode":"CAD","currentBalance":5000}' | jq -r '.id')
echo "✅ Created: Checking Account ($5,000)"

SAVINGS=$(curl -s -X POST $API_URL/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Savings Account","type":"SAVINGS","currencyCode":"CAD","currentBalance":10000}' | jq -r '.id')
echo "✅ Created: Savings Account ($10,000)"

CREDIT=$(curl -s -X POST $API_URL/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Credit Card","type":"CREDIT_CARD","currencyCode":"CAD","currentBalance":-500}' | jq -r '.id')
echo "✅ Created: Credit Card (-$500)"

echo ""

# Create Payees with default categories
echo "Creating payees..."

GROCERY_STORE=$(curl -s -X POST $API_URL/payees \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"Walmart\",\"defaultCategoryId\":\"$GROCERIES\"}" | jq -r '.id')
echo "✅ Created: Walmart (default: Groceries)"

ELECTRIC=$(curl -s -X POST $API_URL/payees \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"Electric Company\",\"defaultCategoryId\":\"$UTILITIES\"}" | jq -r '.id')
echo "✅ Created: Electric Company (default: Utilities)"

NETFLIX=$(curl -s -X POST $API_URL/payees \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"Netflix\",\"defaultCategoryId\":\"$ENTERTAINMENT\"}" | jq -r '.id')
echo "✅ Created: Netflix (default: Entertainment)"

RESTAURANT=$(curl -s -X POST $API_URL/payees \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"The Keg Steakhouse\",\"defaultCategoryId\":\"$DINING\"}" | jq -r '.id')
echo "✅ Created: The Keg Steakhouse (default: Dining Out)"

GAS_STATION=$(curl -s -X POST $API_URL/payees \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"Shell Gas Station\",\"defaultCategoryId\":\"$TRANSPORT\"}" | jq -r '.id')
echo "✅ Created: Shell Gas Station (default: Transportation)"

EMPLOYER=$(curl -s -X POST $API_URL/payees \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"Acme Corp\",\"defaultCategoryId\":\"$SALARY\"}" | jq -r '.id')
echo "✅ Created: Acme Corp (default: Salary)"

echo ""

# Create Sample Transactions
echo "Creating sample transactions..."

# Income - Salary
curl -s -X POST $API_URL/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$CHECKING\",\"transactionDate\":\"2026-01-15\",\"payeeId\":\"$EMPLOYER\",\"categoryId\":\"$SALARY\",\"amount\":3500,\"currencyCode\":\"CAD\",\"description\":\"Monthly salary\"}" > /dev/null
echo "✅ Income: Salary +$3,500"

# Expense - Groceries
curl -s -X POST $API_URL/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$CHECKING\",\"transactionDate\":\"2026-01-20\",\"payeeId\":\"$GROCERY_STORE\",\"categoryId\":\"$GROCERIES\",\"amount\":-125.50,\"currencyCode\":\"CAD\",\"description\":\"Weekly groceries\"}" > /dev/null
echo "✅ Expense: Groceries -$125.50"

# Expense - Utilities
curl -s -X POST $API_URL/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$CHECKING\",\"transactionDate\":\"2026-01-10\",\"payeeId\":\"$ELECTRIC\",\"categoryId\":\"$UTILITIES\",\"amount\":-89.99,\"currencyCode\":\"CAD\",\"description\":\"Monthly electric bill\"}" > /dev/null
echo "✅ Expense: Utilities -$89.99"

# Expense - Entertainment
curl -s -X POST $API_URL/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$CREDIT\",\"transactionDate\":\"2026-01-05\",\"payeeId\":\"$NETFLIX\",\"categoryId\":\"$ENTERTAINMENT\",\"amount\":-16.99,\"currencyCode\":\"CAD\",\"description\":\"Monthly subscription\"}" > /dev/null
echo "✅ Expense: Netflix -$16.99"

# Expense - Dining
curl -s -X POST $API_URL/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$CREDIT\",\"transactionDate\":\"2026-01-18\",\"payeeId\":\"$RESTAURANT\",\"categoryId\":\"$DINING\",\"amount\":-87.50,\"currencyCode\":\"CAD\",\"description\":\"Dinner with friends\"}" > /dev/null
echo "✅ Expense: Dining -$87.50"

# Expense - Transportation
curl -s -X POST $API_URL/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$CHECKING\",\"transactionDate\":\"2026-01-22\",\"payeeId\":\"$GAS_STATION\",\"categoryId\":\"$TRANSPORT\",\"amount\":-65.00,\"currencyCode\":\"CAD\",\"description\":\"Fill up tank\"}" > /dev/null
echo "✅ Expense: Gas -$65.00"

echo ""
echo "=========================================="
echo "✅ Sample data created successfully!"
echo "=========================================="
echo ""
echo "Summary:"
echo "- 7 Categories (5 expense, 2 income)"
echo "- 3 Accounts (Checking, Savings, Credit Card)"
echo "- 6 Payees with default categories"
echo "- 6 Sample Transactions"
echo ""
echo "Now open http://localhost:3001 and navigate to:"
echo "- Transactions page to see your data"
echo "- Try creating new transactions with autocomplete"
echo "- Filter by account or date range"
echo ""
