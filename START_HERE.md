# 🚀 Start Here - MoneyMate Setup

Welcome to MoneyMate! This guide will get you up and running in minutes.

## ✨ What You Need

- **Docker Desktop** (includes Docker Compose)
  - [Download for Windows/Mac](https://www.docker.com/products/docker-desktop/)
  - Linux: Install Docker Engine + Docker Compose plugin

That's it! Everything else runs in containers.

## 🎯 Three Simple Steps

### Step 1: Run Setup Script

```bash
cd /home/ken/moneymate
chmod +x docker-setup.sh create-sample-data-docker.sh
./docker-setup.sh
```

This takes 2-5 minutes and sets up:
- ✅ PostgreSQL database
- ✅ Backend API server
- ✅ Frontend web application
- ✅ All configurations

### Step 2: Create Your Account

Open your browser to: **http://localhost:3001**

1. Click "Sign Up"
2. Enter your email, password, and name
3. Click "Create Account"
4. Login with your new credentials

### Step 3: Add Sample Data

```bash
./create-sample-data-docker.sh
```

Enter your email and password when prompted.

This creates:
- 7 Categories (Groceries, Utilities, etc.)
- 3 Accounts (Checking, Savings, Credit Card)
- 6 Payees with smart defaults
- 6 Sample Transactions

## 🎉 You're Done!

Now explore the app:

1. Click "Transactions" from the dashboard
2. Try creating a new transaction
3. Type "Walm..." in the payee field - watch autocomplete work!
4. Select "Walmart" - see the category auto-fill to "Groceries"
5. Filter transactions by account or date
6. Watch the summary cards update in real-time

## 📚 What's Available

| Service | URL | What It Does |
|---------|-----|--------------|
| **Frontend** | http://localhost:3001 | Main web interface |
| **Backend API** | http://localhost:3000 | REST API |
| **API Docs** | http://localhost:3000/api | Interactive API documentation |
| **Database** | localhost:5432 | PostgreSQL database |

## 🔧 Useful Commands

```bash
# View logs
docker compose logs -f

# View backend logs only
docker compose logs -f backend

# Stop everything
docker compose down

# Restart everything
docker compose restart

# Complete reset (deletes all data!)
docker compose down -v
./docker-setup.sh
```

## 📖 Need More Help?

- **Docker Guide**: [DOCKER_QUICK_START.md](./DOCKER_QUICK_START.md)
- **Features**: [README_DOCKER.md](./README_DOCKER.md)
- **Manual Setup**: [SETUP_GUIDE.md](./SETUP_GUIDE.md)

## ❓ Troubleshooting

### Services won't start?

```bash
# Check Docker is running
docker info

# View what went wrong
docker compose logs

# Clean restart
docker compose down -v
./docker-setup.sh
```

### Port already in use?

Edit `.env` file:
```bash
BACKEND_PORT=3000   # Change to 3002, 3003, etc.
FRONTEND_PORT=3001  # Change to 3004, 3005, etc.
```

Then restart:
```bash
docker compose down
docker compose up -d
```

### Can't connect to backend?

Wait 30-60 seconds after startup for services to fully initialize.

Check status:
```bash
docker compose ps
```

All services should show "Up" or "healthy".

## 🎨 What to Build Next

Now that you have a working transaction system, you can:

1. Build account management UI
2. Build category management UI
3. Build payee management UI
4. Add budgets and tracking
5. Create financial reports
6. Add data import/export

The backend APIs for all these already exist! Just build the frontend.

## 🤝 Questions?

All the backend API endpoints are documented at:
**http://localhost:3000/api**

You can test them directly from the Swagger interface!

---

**Ready to go?** Run `./docker-setup.sh` and start building your financial future! 💰
