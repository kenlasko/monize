# MoneyMate - Quick Start

Get MoneyMate up and running in 3 simple steps!

## Step 1: Run Setup

```bash
cd /home/ken/moneymate
chmod +x setup.sh create-sample-data.sh
./setup.sh
```

This will:
- Configure PostgreSQL database
- Install all dependencies
- Create environment files
- Run database migrations

## Step 2: Start the Servers

Open two terminal windows:

**Terminal 1 - Backend:**
```bash
cd /home/ken/moneymate/backend
npm run start:dev
```
Wait for: `Nest application successfully started` ✅

**Terminal 2 - Frontend:**
```bash
cd /home/ken/moneymate/frontend
npm run dev
```
Wait for: `Ready in XXXms` ✅

## Step 3: Create Account & Test

1. **Open browser:** http://localhost:3001

2. **Register:**
   - Click "Sign Up"
   - Fill in your details
   - Create account

3. **Login with your credentials**

4. **Create sample data:**
   ```bash
   cd /home/ken/moneymate
   ./create-sample-data.sh
   ```
   Enter your email and password when prompted.

5. **Navigate to Transactions:**
   - Click "Transactions" from the dashboard
   - See your sample data
   - Try creating a new transaction!

## What to Test

✅ **Payee Autocomplete:** Start typing "Walm..." in the payee field
✅ **Auto Category:** Select a payee and watch category auto-fill
✅ **Filtering:** Filter transactions by account or date
✅ **Summary Cards:** Watch totals update as you add transactions
✅ **Toggle Cleared:** Click checkmark to mark transactions as cleared
✅ **Edit/Delete:** Modify or remove transactions

## Troubleshooting

**Setup script fails?** See [SETUP_GUIDE.md](./SETUP_GUIDE.md) for manual steps

**Can't connect to database?** Make sure PostgreSQL is running:
```bash
sudo service postgresql start
```

**Port already in use?** Backend and frontend will show which ports they're using

## API Documentation

Once backend is running: http://localhost:3000/api

## Need Help?

- Full setup guide: [SETUP_GUIDE.md](./SETUP_GUIDE.md)
- Backend docs: [backend/README.md](./backend/README.md)
- Frontend docs: [frontend/README.md](./frontend/README.md)

Happy testing! 🚀
