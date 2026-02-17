<p align="center">
  <img src="frontend/public/icons/monize-logo.svg" alt="Monize" width="128" height="128" />
</p>

# Monize
> [!CAUTION] 
> This project is 100% written by AI. I've done practically zero manual changes. I have spent hours prompting Claude Code for features, updates, fixes and tweaks. I have taken steps to ensure this is secure as it can be. I've performed numerous security audits and have implemented best-practice security measures as much as I can (including 2FA and OIDC support), but I can't personally guarantee the security of this code. YOU HAVE BEEN WARNED. 

A comprehensive personal finance management application built with NestJS and Next.js. Designed as a replacement for Microsoft Money. 100% built using farm-fresh, free-range Claude Code.

**[Live Demo](https://monize-demo.ucdialplans.com)**

## Why This Exists?
The personal finance ecosystem is flooded with personal finance platforms. I've tried many of them, but every single one of them had deal-breakers I couldn't work with. I finally decided to try my hand at creating my own platform that met all my criteria by using  "vibe-coding", which is a dirty word in the self-hosting community. I just wanted to see what was possible with the current state of AI. It turned out to be more successful than I evern could have imagined, which is why I'm making this available for others.

### A bit of background on my specific situation that brought me to create this project:
I've been a rabid user of [Microsoft Money](https://en.wikipedia.org/wiki/Microsoft_Money) since 1995, when I had my first real job outside of university doing tech support for Microsoft. I started using it to keep track of my finances and to help get myself out of credit card debt. It allowed me to keep track of every aspect of my finances: chequing accounts, credit cards, loans, mortgages, investments, and more. Being software of the 90's, it didn't have much in the way of automation, especially for non-US customers. This forced me to meticulously enter every single transaction manually into Microsoft Money.

This "feature" helped me truly understand the state of my finances. I knew where every single penny went. Nothing was ever a surprise. I could forecast my finances out a year or more with precision. I've kept that going for more than THIRTY YEARS. Yes, even though Microsoft Money hasn't had a new version since 2010, I still use it. Everything from 1995 to today is stored in Microsoft Money. I can tell you my detailed financial picture going back to 1995. It certainly isn't perfect. I can only run it on one machine. There's no mobile app or anything of the sort. When I go on a trip or something, it can take hours after I return to enter and categorize my data. I've been increasingly wanting a true replacement for Microsoft Money. 

My perfect product to replace MS Money needed the following features:
- Must support all types of banking and investment types, including:
  - Chequing
  - Savings
  - Credit Cards
  - Loans
  - Mortgages
  - Line of Credit
  - Brokerage accounts
  - Asset accounts
- Must support importing from QIF (the only export option available for MS Money)
- Must be self-hostable via containerization
- Must support multiple currencies
- Must support pulling currency exchange rates and stock prices on a regular basis
- Must support PostgreSQL for the backend tables
- Must have a usable mobile app or web interface

Since I couldn't find anything out there to meet that criteria, I decided to create Monize! After weeks of vibe-coding and testing, I finally was able to migrate ALL of 30+ years of Microsoft Money data into Monize with no errors or discrepancies. Microsoft Money has finally been retired!

Monize is running in my [Kubernetes cluster](https://github.com/kenlasko/k8s).


## Features
Before you look at the list of features, you should know what it DOESN'T include:
- automated downloading of transactions from any platform
- importing transactions via anything other than QIF

My reason for this is because I still believe in manually tracking everything. If there is interest from the community, I will add it at some point.

I could easily add import capabilities for other filetypes, but I would need examples.

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
- TOTP two-factor authentication with trusted device support
- Admin user management with role-based access (admin/user)
- Password reset via email with temporary passwords
- Forced password change and forced 2FA policies
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
monize/
├── backend/                    # NestJS backend application
│   ├── src/
│   │   ├── auth/              # Authentication (Local, OIDC, 2FA, trusted devices)
│   │   ├── users/             # User management & preferences
│   │   ├── admin/             # Admin user management (roles, status, password reset)
│   │   ├── accounts/          # Account management
│   │   ├── transactions/      # Transaction management
│   │   ├── categories/        # Category management (hierarchical)
│   │   ├── payees/            # Payee management
│   │   ├── currencies/        # Currency & exchange rates
│   │   ├── securities/        # Stock/security management & portfolio
│   │   ├── scheduled-transactions/   # Recurring payments
│   │   ├── notifications/     # Email notifications (SMTP)
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

### Quick Start with Docker

1. Clone the repository:
```bash
git clone git@github.com:kenlasko/monize.git
cd monize
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
createdb monize
psql monize < ../database/schema.sql
```

3. Create `backend/.env`:
```env
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=monize
DATABASE_USER=your_user
DATABASE_PASSWORD=your_password
JWT_SECRET=your-secret-key
PUBLIC_APP_URL=http://localhost:3001
```

4. Start the backend:
```bash
npm run start:dev
```

5. In a new terminal, set up frontend:
```bash
cd frontend
npm install
cp ../.env.example .env.local  # Update INTERNAL_API_URL if needed
npm run dev
```

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_DB` | Database name | `monize` |
| `POSTGRES_USER` | Database user | `monize_user` |
| `POSTGRES_PASSWORD` | Database password | `secure-password` |
| `JWT_SECRET` | JWT signing key (min 32 chars) | `openssl rand -base64 32` |
| `PUBLIC_APP_URL` | Public frontend URL | `https://money.example.com` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `INTERNAL_API_URL` | Backend URL for server-side calls | `http://localhost:3001` |
| `CORS_ORIGIN` | Additional CORS origin | - |
| `LOCAL_AUTH_ENABLED` | Enable local auth | `true` |
| `REGISTRATION_ENABLED` | Allow new user registration | `true` |
| `FORCE_2FA` | Require 2FA for all local users | `false` |
| `OIDC_ISSUER_URL` | OIDC provider URL | - |
| `OIDC_CLIENT_ID` | OIDC client ID | - |
| `OIDC_CLIENT_SECRET` | OIDC client secret | - |
| `OIDC_CALLBACK_URL` | OIDC callback URL | - |
| `SMTP_HOST` | SMTP server host | - |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_USER` | SMTP username | - |
| `SMTP_PASS` | SMTP password | - |
| `SMTP_FROM` | Email sender address | - |


## Deployment

### Docker Compose (Production)

1. Create `.env` from the example and set production values:
```bash
cp .env.example .env
# Edit .env: set NODE_ENV=production, strong passwords, your domain, etc.
```

2. Build and start:
```bash
docker compose -f docker-compose.prod.yml up -d
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
- `POST /api/v1/auth/2fa/verify` - Verify TOTP 2FA code
- `POST /api/v1/auth/2fa/setup` - Set up 2FA
- `GET /api/v1/auth/2fa/trusted-devices` - List trusted devices
- `GET /api/v1/auth/oidc` - Initiate OIDC authentication
- `GET /api/v1/accounts` - List accounts
- `GET /api/v1/transactions` - List transactions
- `GET /api/v1/portfolio/summary` - Investment portfolio summary
- `GET /api/v1/portfolio/top-movers` - Daily top movers
- `GET /api/v1/admin/users` - Admin: list all users
- `GET /api/v1/built-in-reports/*` - Pre-aggregated reports
- `GET /api/v1/health/live` - Liveness probe
- `GET /api/v1/health/ready` - Readiness probe

## Database Schema

Main tables:
- **users** / **user_preferences**: User accounts and settings
- **trusted_devices**: 2FA trusted browser tokens
- **accounts**: Financial accounts (bank, credit, investment)
- **transactions** / **transaction_splits**: Financial transactions
- **categories**: Hierarchical transaction categories
- **payees**: Payees with default category auto-assignment
- **scheduled_transactions** / **scheduled_transaction_overrides**: Recurring payments
- **securities** / **security_prices** / **holdings**: Stocks, price history, and positions
- **investment_transactions**: Buy/sell/dividend transactions
- **monthly_account_balances**: Net worth snapshots
- **custom_reports**: User-defined report configurations

## Security Notes

- Swagger/OpenAPI is **disabled in production**
- JWT tokens stored in httpOnly cookies (not accessible to JavaScript)
- TOTP 2FA with trusted device tokens (SHA256-hashed, httpOnly cookies)
- Rate limiting enabled on authentication endpoints
- Admin role required for user management operations
- Always use HTTPS in production
- Generate strong JWT secrets (`openssl rand -base64 32`)

## License

AGPL-3.0 License - See LICENSE file for details.
