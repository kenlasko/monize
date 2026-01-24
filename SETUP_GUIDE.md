# MoneyMate Setup Guide

Complete setup instructions for running the MoneyMate application.

## Prerequisites

✅ Node.js v22.20.0 - Installed
✅ npm v10.9.3 - Installed
✅ PostgreSQL 18.0 - Installed

## Quick Setup

Run the automated setup script:

```bash
cd /home/ken/moneymate
chmod +x setup.sh
./setup.sh
```

The script will:
- Start PostgreSQL
- Create the database and user
- Run all migrations
- Install dependencies for backend and frontend
- Create environment configuration files

## Manual Setup (if script fails)

### 1. Start PostgreSQL

For WSL/Ubuntu:
```bash
sudo service postgresql start
```

For systemd:
```bash
sudo systemctl start postgresql
```

### 2. Create Database and User

```bash
sudo -u postgres psql
```

Then run:
```sql
CREATE DATABASE moneymate;
CREATE USER moneymate_user WITH PASSWORD 'moneymate_password';
GRANT ALL PRIVILEGES ON DATABASE moneymate TO moneymate_user;
ALTER DATABASE moneymate OWNER TO moneymate_user;
\c moneymate
GRANT ALL ON SCHEMA public TO moneymate_user;
\q
```

### 3. Run Database Migrations

```bash
cd /home/ken/moneymate
sudo -u postgres psql -d moneymate -f database/migrations/001_initial_schema.sql
sudo -u postgres psql -d moneymate -f database/migrations/002_add_category_to_transactions.sql
```

### 4. Backend Setup

```bash
cd /home/ken/moneymate/backend

# Install dependencies
npm install

# Create .env file
cat > .env << 'EOF'
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=moneymate_user
DB_PASSWORD=moneymate_password
DB_DATABASE=moneymate

JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=7d

PORT=3000
NODE_ENV=development

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

FRONTEND_URL=http://localhost:3001
EOF
```

### 5. Frontend Setup

```bash
cd /home/ken/moneymate/frontend

# Install dependencies
npm install

# Create .env.local file
echo "NEXT_PUBLIC_API_URL=http://localhost:3000" > .env.local
```

## Running the Application

### Terminal 1 - Backend Server

```bash
cd /home/ken/moneymate/backend
npm run start:dev
```

Backend will run on: **http://localhost:3000**

### Terminal 2 - Frontend Server

```bash
cd /home/ken/moneymate/frontend
npm run dev
```

Frontend will run on: **http://localhost:3001**

## Testing the Application

1. Open browser to: **http://localhost:3001**

2. **Register a new account:**
   - Click "Sign Up"
   - Fill in email, password, first name, last name
   - Click "Create Account"

3. **Login:**
   - Use your registered credentials
   - You'll be redirected to the dashboard

4. **Create Sample Data:**

   First, create an account:
   - Click "Accounts" from Quick Actions
   - Or navigate to: http://localhost:3001/accounts
   - Create a "Checking Account" with initial balance

   Then, create some categories:
   - Click "Categories" from Quick Actions
   - Create expense categories: Groceries, Utilities, Entertainment
   - Create income categories: Salary, Freelance

   Create payees with default categories:
   - Click "Payees" from Quick Actions
   - Create "Grocery Store" with default category "Groceries"
   - Create "Electric Company" with default category "Utilities"
   - Create "Netflix" with default category "Entertainment"

5. **Test Transactions:**
   - Click "Transactions" from Quick Actions
   - Click "+ New Transaction"
   - Select your account
   - Pick a date
   - Start typing a payee name (e.g., "Groc...")
   - Watch the autocomplete suggest "Grocery Store"
   - Select it and see the category auto-fill to "Groceries"
   - Enter amount (negative for expense, positive for income)
   - Add description
   - Save

6. **Test Features:**
   - ✅ Filter by account
   - ✅ Filter by date range
   - ✅ Toggle cleared status
   - ✅ Edit transactions
   - ✅ Delete transactions
   - ✅ View summary cards update in real-time

## Troubleshooting

### PostgreSQL won't start

```bash
# Check if already running
pg_isready

# Check status
sudo service postgresql status

# Start manually
sudo service postgresql start
```

### Port already in use

If port 3000 or 3001 is taken:

Backend - Edit `backend/.env` and change `PORT=3000` to another port
Frontend - It will auto-select the next available port

### Database connection fails

Check credentials in `backend/.env` match your PostgreSQL setup:
```bash
psql -h localhost -U moneymate_user -d moneymate
# Enter password: moneymate_password
```

### Frontend can't connect to backend

1. Verify backend is running on http://localhost:3000
2. Check `frontend/.env.local` has correct API URL
3. Check browser console for CORS errors

## API Documentation

Once backend is running, view API docs at:
**http://localhost:3000/api**

## Sample Data Script

After setup, you can create sample data via the API or UI. All data is user-specific and requires authentication.

## Next Steps

- Explore the transaction management UI
- Create budgets (UI coming soon)
- Set up investment accounts
- View financial reports

Enjoy testing MoneyMate! 🎉
