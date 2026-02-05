# MoneyMate

A comprehensive personal finance management application built with NestJS and Next.js.

## Features

### Account Management
- Multiple account types: Chequing, Savings, Credit Cards, Loans, Mortgages, Line of Credit
- Investment accounts with brokerage support
- Support for multiple currencies per account
- Track balances, credit limits, and interest rates
- Account reconciliation

### Transaction Management
- Full transaction tracking with categories and payees
- Split transaction support for complex transactions
- Transaction reconciliation and clearing
- Payees with auto-categorization rules
- Multi-currency transactions with automatic exchange rate tracking
- QIF file import support

### Investment Features
- Track stocks, bonds, ETFs, and mutual funds
- Support for US and Canadian exchanges (NYSE, NASDAQ, TSX, TSXV)
- Daily price updates from Yahoo Finance
- Investment transactions: buy, sell, dividend, interest, splits, transfers
- Portfolio tracking with real-time valuations
- Historical price backfill

### Multi-Currency Support
- Support for multiple currencies (USD, CAD, EUR, GBP, JPY, CHF, AUD, CNY)
- Daily exchange rate updates
- Automatic currency conversion for reporting
- Per-account currency settings

### Scheduled Transactions
- Recurring payment tracking (daily, weekly, bi-weekly, monthly, quarterly, yearly)
- Automatic transaction entry option
- Skip and override individual occurrences
- Bill payment history tracking

### Reports
- **Built-in Reports** (server-side aggregated):
  - Spending by Category / Payee
  - Income by Source
  - Monthly Spending Trend
  - Income vs Expenses
  - Cash Flow
  - Year over Year Comparison
  - Weekend vs Weekday Spending
  - Spending Anomalies Detection
  - Tax Summary
  - Recurring Expenses
  - Bill Payment History
  - Uncategorized Transactions
  - Duplicate Transaction Finder
- **Net Worth Report**: Historical net worth tracking with monthly snapshots
- **Custom Reports**: Build your own reports with flexible filters
- Visual charts (pie, bar, line, area)

### Security
- OIDC (OpenID Connect) authentication (Authentik, Authelia, Pocket-ID, etc.)
- Local credential authentication with bcrypt hashing
- JWT-based session management with httpOnly cookies
- Rate limiting and request throttling
- Helmet security headers
- CORS protection

## Technology Stack

### Backend
- **Framework**: NestJS (Node.js/TypeScript)
- **Database**: PostgreSQL 16
- **Authentication**: Passport.js (Local & OIDC strategies)
- **API Documentation**: Swagger/OpenAPI (development only)
- **ORM**: TypeORM
- **Validation**: class-validator & class-transformer

### Frontend
- **Framework**: Next.js 14 (React/TypeScript)
- **Styling**: Tailwind CSS
- **State Management**: Zustand
- **Charts**: Recharts
- **Forms**: React Hook Form
- **HTTP Client**: Axios
- **Date Handling**: date-fns

### DevOps
- **Containerization**: Docker & Docker Compose
- **Orchestration**: Kubernetes-ready
- **Output**: Next.js standalone build for minimal container size

## Project Structure

```
moneymate/
├── backend/                    # NestJS backend application
│   ├── src/
│   │   ├── auth/              # Authentication (Local & OIDC)
│   │   ├── users/             # User management
│   │   ├── accounts/          # Account management
│   │   ├── transactions/      # Transaction management
│   │   ├── categories/        # Category management (hierarchical)
│   │   ├── payees/            # Payee management
│   │   ├── currencies/        # Currency & exchange rates
│   │   ├── securities/        # Stock/security management
│   │   ├── investment-transactions/  # Investment transactions
│   │   ├── scheduled-transactions/   # Recurring payments
│   │   ├── net-worth/         # Net worth calculations
│   │   ├── built-in-reports/  # Server-side report aggregation
│   │   ├── custom-reports/    # User-defined custom reports
│   │   ├── import/            # QIF file import
│   │   ├── health/            # Health check endpoints
│   │   └── main.ts            # Application entry point
│   └── Dockerfile
├── frontend/                   # Next.js frontend application
│   ├── src/
│   │   ├── app/               # Next.js App Router pages
│   │   ├── components/        # React components
│   │   ├── lib/               # API clients and utilities
│   │   ├── hooks/             # Custom React hooks
│   │   ├── store/             # Zustand state stores
│   │   └── types/             # TypeScript type definitions
│   └── Dockerfile
├── database/
│   └── schema.sql             # Complete PostgreSQL schema
├── docker-compose.yml         # Development environment
├── docker-compose.prod.yml    # Production environment
├── .env.example               # Environment variables template
└── README.md
```

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local development)
- PostgreSQL 16+ (if running without Docker)
- Redis (if running without Docker)

### Quick Start with Docker

1. Clone the repository:
```bash
git clone <repository-url>
cd moneymate
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Edit `.env` and configure:
   - `POSTGRES_PASSWORD` - secure database password
   - `JWT_SECRET` - generate with `openssl rand -base64 32`
   - `PUBLIC_APP_URL` - your public frontend URL
   - OIDC settings (optional) for SSO authentication

4. Start the application:
```bash
docker-compose up -d
```

5. Access the application:
   - Frontend: http://localhost:3001
   - Backend API: http://localhost:3000

### Development Setup (Without Docker)

1. Install backend dependencies:
```bash
cd backend
npm install
```

2. Set up PostgreSQL database:
```bash
createdb moneymate
psql moneymate < ../database/schema.sql
```

3. Start Redis:
```bash
redis-server
```

4. Create `backend/.env`:
```env
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=moneymate
DATABASE_USER=your_user
DATABASE_PASSWORD=your_password
JWT_SECRET=your-secret-key
PUBLIC_APP_URL=http://localhost:3001
```

5. Start the backend:
```bash
npm run start:dev
```

6. In a new terminal, set up frontend:
```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_DB` | Database name | `moneymate` |
| `POSTGRES_USER` | Database user | `moneymate_user` |
| `POSTGRES_PASSWORD` | Database password | `secure-password` |
| `JWT_SECRET` | JWT signing key (min 32 chars) | `openssl rand -base64 32` |
| `PUBLIC_APP_URL` | Public frontend URL | `https://money.example.com` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `INTERNAL_API_URL` | Backend URL for server-side calls | `http://localhost:3001` |
| `CORS_ORIGIN` | Additional CORS origin | - |
| `LOCAL_AUTH_ENABLED` | Enable local auth | `true` |
| `OIDC_ISSUER_URL` | OIDC provider URL | - |
| `OIDC_CLIENT_ID` | OIDC client ID | - |
| `OIDC_CLIENT_SECRET` | OIDC client secret | - |
| `OIDC_CALLBACK_URL` | OIDC callback URL | - |

## Deployment

### Docker Compose (Production)

1. Create `.env.prod` with production values:
```env
POSTGRES_DB=moneymate
POSTGRES_USER=moneymate_user
POSTGRES_PASSWORD=<strong-password>
JWT_SECRET=<generate-with-openssl>
PUBLIC_APP_URL=https://your-domain.com
```

2. Build and start:
```bash
docker-compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

### Kubernetes

The application is Kubernetes-ready with:
- Health endpoints: `/api/v1/health/live` and `/api/v1/health/ready`
- Standalone Next.js build for minimal image size
- Environment-based configuration

Example environment for K8s:
```yaml
# Frontend pod
- name: INTERNAL_API_URL
  value: "http://backend-svc:3000"
- name: PUBLIC_APP_URL
  value: "https://money.example.com"

# Backend pod
- name: PUBLIC_APP_URL
  value: "https://money.example.com"
```

## API Documentation

Swagger UI is available at `/api/docs` in **development mode only** (disabled in production for security).

### Key Endpoints

- `POST /api/v1/auth/register` - Register with local credentials
- `POST /api/v1/auth/login` - Login with local credentials
- `GET /api/v1/auth/oidc` - Initiate OIDC authentication
- `GET /api/v1/accounts` - List accounts
- `GET /api/v1/transactions` - List transactions
- `GET /api/v1/built-in-reports/*` - Pre-aggregated reports
- `GET /api/v1/health/live` - Liveness probe
- `GET /api/v1/health/ready` - Readiness probe

## Database Schema

Main tables:
- **users** / **user_preferences**: User accounts and settings
- **accounts**: Financial accounts (bank, credit, investment)
- **transactions** / **transaction_splits**: Financial transactions
- **categories**: Hierarchical transaction categories
- **payees** / **payee_rules**: Payees with auto-categorization
- **scheduled_transactions**: Recurring payments
- **securities** / **security_prices**: Stocks and price history
- **investment_transactions**: Buy/sell/dividend transactions
- **monthly_account_balances**: Net worth snapshots
- **custom_reports**: User-defined report configurations

## Security Notes

- Swagger/OpenAPI is **disabled in production**
- JWT tokens stored in httpOnly cookies (not accessible to JavaScript)
- Rate limiting enabled on authentication endpoints
- Always use HTTPS in production
- Generate strong JWT secrets (`openssl rand -base64 32`)

## License

MIT License - See LICENSE file for details.
