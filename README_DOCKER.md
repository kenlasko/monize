# MoneyMate 💰

A comprehensive personal finance management application built with NestJS and Next.js.

## 🚀 Quick Start with Docker (Recommended)

The fastest way to get started:

```bash
cd /home/ken/moneymate
chmod +x docker-setup.sh create-sample-data-docker.sh
./docker-setup.sh
```

Then open **http://localhost:3001** and register an account!

📖 **See [DOCKER_QUICK_START.md](./DOCKER_QUICK_START.md) for detailed Docker instructions**

## 📋 Features

### ✅ Implemented
- **Authentication**: Local registration/login with JWT + Google OAuth support
- **Transactions**: Full CRUD with filtering, clearing, and reconciliation
- **Payees**: Manage payees with default category assignment
- **Categories**: Hierarchical categories for income and expenses
- **Accounts**: Multiple account types (Checking, Savings, Credit Card, Investment)
- **Investment Tracking**: Securities, holdings, and investment transactions
- **Payee Autocomplete**: Smart payee suggestions with auto-category assignment
- **Transaction UI**: Beautiful, responsive UI with real-time summaries

### 🚧 In Progress
- Account management UI
- Category management UI
- Payee management UI
- Dashboard analytics

### 📅 Planned
- Budgets and budget tracking
- Financial reports and charts
- Data import/export (CSV, OFX)
- Recurring transactions
- Multi-currency support
- Mobile responsive design improvements

## 🏗️ Architecture

```
moneymate/
├── backend/          # NestJS API server
│   ├── src/
│   │   ├── auth/          # Authentication module
│   │   ├── accounts/      # Account management
│   │   ├── transactions/  # Transaction management
│   │   ├── payees/        # Payee management
│   │   ├── categories/    # Category management
│   │   ├── securities/    # Investment tracking
│   │   └── ...
│   └── Dockerfile
├── frontend/         # Next.js web application
│   ├── src/
│   │   ├── app/           # Next.js app router pages
│   │   ├── components/    # React components
│   │   ├── lib/           # API clients
│   │   ├── store/         # State management
│   │   └── types/         # TypeScript types
│   └── Dockerfile
├── database/         # Database migrations
└── docker-compose.yml
```

## 🛠️ Technology Stack

### Backend
- **Framework**: NestJS (Node.js)
- **Database**: PostgreSQL 16
- **ORM**: TypeORM
- **Authentication**: Passport.js (JWT + Google OAuth)
- **Validation**: class-validator
- **Documentation**: Swagger/OpenAPI

### Frontend
- **Framework**: Next.js 14 (App Router)
- **UI**: React 18 + TypeScript
- **Styling**: Tailwind CSS
- **Forms**: React Hook Form + Zod
- **State**: Zustand
- **HTTP**: Axios
- **Notifications**: React Hot Toast

### Infrastructure
- **Containerization**: Docker + Docker Compose
- **Cache**: Redis
- **API Documentation**: Swagger UI

## 📚 Documentation

- **[DOCKER_QUICK_START.md](./DOCKER_QUICK_START.md)** - Docker setup and commands (recommended)
- **[QUICK_START.md](./QUICK_START.md)** - Non-Docker setup (3 steps)
- **[SETUP_GUIDE.md](./SETUP_GUIDE.md)** - Detailed manual setup instructions
- **[backend/INVESTMENT_ACCOUNTS.md](./backend/INVESTMENT_ACCOUNTS.md)** - Investment features guide
- **[backend/PAYEES_GUIDE.md](./backend/PAYEES_GUIDE.md)** - Payee management guide
- **[backend/CATEGORY_INTEGRATION.md](./backend/CATEGORY_INTEGRATION.md)** - Category integration details

## 🎯 Getting Started

### Docker (Recommended) 🐳

```bash
./docker-setup.sh
```

Services will be available at:
- **Frontend**: http://localhost:3001
- **Backend**: http://localhost:3000
- **API Docs**: http://localhost:3000/api
- **PostgreSQL**: localhost:5432

### Local Development (Without Docker)

See [QUICK_START.md](./QUICK_START.md) for setup instructions.

## 🧪 Testing the Application

1. **Register**: Create account at http://localhost:3001
2. **Login**: Sign in with credentials
3. **Create Sample Data**:
   ```bash
   ./create-sample-data-docker.sh  # Docker
   # OR
   ./create-sample-data.sh         # Local
   ```
4. **Explore**: Test all transaction features!

### What to Test

- ✅ Payee Autocomplete
- ✅ Auto Category Assignment
- ✅ Transaction Filtering
- ✅ Summary Cards
- ✅ Toggle Cleared Status
- ✅ Edit/Delete Operations
- ✅ Color-Coded Amounts

## 🔌 API Endpoints

View full docs at: **http://localhost:3000/api**

## 🐛 Troubleshooting

### Docker Issues

```bash
docker compose logs -f        # View logs
docker compose restart        # Restart
docker compose down -v        # Clean restart
./docker-setup.sh
```

### Port Conflicts

Edit `.env` and change ports, then restart.

## 📈 Roadmap

- [ ] Complete UI for all modules
- [ ] Budget management
- [ ] Financial reports
- [ ] Data import/export
- [ ] Recurring transactions
- [ ] Mobile app

---

Built with ❤️ using NestJS, Next.js, and PostgreSQL
