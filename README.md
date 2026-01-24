# MoneyMate 💰

A comprehensive personal finance management application built with NestJS and Next.js.

## Features

### Account Management
- Multiple account types: Chequing, Savings, Credit Cards, Loans, Mortgages
- Investment accounts: RRSP, TFSA, RESP, and general investment accounts
- Support for multiple currencies per account
- Track balances, credit limits, and interest rates

### Transaction Management
- Full transaction tracking with categories
- Split transaction support for complex transactions
- Transaction reconciliation and clearing
- Support for payees with auto-categorization
- Multi-currency transactions with automatic exchange rate tracking

### Investment Features
- Track stocks, bonds, ETFs, and mutual funds
- Support for US and Canadian stock exchanges (NYSE, NASDAQ, TSX, TSXV)
- Daily price updates from market data providers
- Investment transactions: buy, sell, dividend, interest, splits
- Portfolio tracking with real-time valuations

### Multi-Currency Support
- Support for multiple currencies (USD, CAD, EUR, GBP, JPY, CHF, AUD, CNY)
- Daily exchange rate updates
- Automatic currency conversion for reporting
- Per-account currency settings

### Scheduled Transactions & Notifications
- Recurring payment tracking (daily, weekly, monthly, quarterly, yearly)
- Automatic transaction entry option
- Customizable notification reminders
- Email and browser notifications
- Budget alerts and low balance warnings

### Budgeting & Reporting
- Category-based budgeting
- Monthly, quarterly, and yearly budget periods
- Customizable financial reports
- Income vs expense analysis
- Net worth tracking
- Cash flow reports
- Visual charts and graphs

### Security
- Secure by default with industry best practices
- OIDC (OpenID Connect) authentication support
- Local credential authentication with bcrypt hashing
- JWT-based session management
- Rate limiting and request throttling
- Helmet security headers
- HTTPS/TLS encryption in production
- Audit logging for all critical operations

## Technology Stack

### Backend
- **Framework**: NestJS (Node.js/TypeScript)
- **Database**: PostgreSQL 16
- **Cache**: Redis
- **Authentication**: Passport.js (Local & OIDC strategies)
- **API Documentation**: Swagger/OpenAPI
- **ORM**: TypeORM
- **Validation**: class-validator & class-transformer

### Frontend
- **Framework**: Next.js 14 (React)
- **Styling**: Tailwind CSS (to be implemented)
- **State Management**: React Context/Zustand (to be implemented)
- **Charts**: Recharts/Chart.js (to be implemented)
- **Forms**: React Hook Form (to be implemented)

### DevOps
- **Containerization**: Docker & Docker Compose
- **Reverse Proxy**: Nginx (optional, to be configured)
- **Process Management**: PM2 (optional)

## Project Structure

```
finance-app/
├── backend/                    # NestJS backend application
│   ├── src/
│   │   ├── auth/              # Authentication module (Local & OIDC)
│   │   ├── users/             # User management
│   │   ├── accounts/          # Account management (to be implemented)
│   │   ├── transactions/      # Transaction management (to be implemented)
│   │   ├── categories/        # Category management (to be implemented)
│   │   ├── currencies/        # Currency & exchange rates (to be implemented)
│   │   ├── securities/        # Stock/security management (to be implemented)
│   │   ├── scheduled-transactions/ # Recurring payments (to be implemented)
│   │   ├── budgets/           # Budget management (to be implemented)
│   │   ├── reports/           # Reporting engine (to be implemented)
│   │   ├── notifications/     # Notification service (to be implemented)
│   │   └── main.ts            # Application entry point
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── frontend/                   # Next.js frontend application (to be implemented)
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   └── styles/
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── database/
│   └── schema.sql             # Complete PostgreSQL schema
├── docker-compose.yml         # Multi-container orchestration
├── .env.example               # Environment variables template
└── README.md                  # This file
```

## Database Schema

The application uses a comprehensive PostgreSQL schema with the following main tables:

- **users**: User accounts with authentication support
- **user_preferences**: User settings and preferences
- **currencies**: Supported currencies
- **exchange_rates**: Historical currency exchange rates
- **accounts**: Financial accounts (bank, credit, investment)
- **categories**: Transaction categories (hierarchical)
- **payees**: Transaction payees with auto-categorization
- **transactions**: Financial transactions with split support
- **transaction_splits**: Split transaction details
- **scheduled_transactions**: Recurring payment definitions
- **securities**: Stocks, bonds, ETFs, mutual funds
- **security_prices**: Historical security prices
- **holdings**: Current investment holdings
- **investment_transactions**: Buy/sell/dividend transactions
- **budgets**: Category-based budgets
- **notifications**: User notifications
- **reports**: Saved custom reports
- **audit_log**: Audit trail for compliance

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local development)
- PostgreSQL 16+ (if running without Docker)
- Redis (if running without Docker)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd finance-app
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Edit `.env` and update the following:
   - Change `POSTGRES_PASSWORD` to a secure password
   - Change `JWT_SECRET` to a random secure string
   - Add your API keys for exchange rates and stock data
   - Configure OIDC settings if using OpenID Connect

4. Start the application with Docker Compose:
```bash
docker-compose up -d
```

5. The services will be available at:
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001
   - API Documentation: http://localhost:3001/api/docs
   - PostgreSQL: localhost:5432
   - Redis: localhost:6379

### Development Setup (Without Docker)

1. Install backend dependencies:
```bash
cd backend
npm install
```

2. Set up PostgreSQL database:
```bash
createdb finance_db
psql finance_db < ../database/schema.sql
```

3. Start Redis:
```bash
redis-server
```

4. Start the backend:
```bash
npm run start:dev
```

5. Install frontend dependencies (once implemented):
```bash
cd frontend
npm install
npm run dev
```

## API Documentation

Once the backend is running, visit http://localhost:3001/api/docs to access the interactive Swagger API documentation.

### Authentication Endpoints

- `POST /api/v1/auth/register` - Register with local credentials
- `POST /api/v1/auth/login` - Login with local credentials
- `GET /api/v1/auth/oidc` - Initiate OIDC authentication
- `GET /api/v1/auth/oidc/callback` - OIDC callback handler
- `GET /api/v1/auth/profile` - Get current user profile
- `POST /api/v1/auth/logout` - Logout

## External API Integration

### Currency Exchange Rates

The application supports multiple providers for currency exchange rates:

- **Fixer.io**: https://fixer.io/ (recommended, requires API key)
- **ExchangeRate-API**: https://www.exchangerate-api.com/ (free tier available)
- **Open Exchange Rates**: https://openexchangerates.org/

Configure your preferred provider in the `EXCHANGE_RATE_API_KEY` environment variable.

### Stock Market Data

For US and Canadian stock prices, the application supports:

- **Alpha Vantage**: https://www.alphavantage.co/ (free tier: 5 requests/min)
- **Finnhub**: https://finnhub.io/ (free tier: 60 requests/min)
- **IEX Cloud**: https://iexcloud.io/ (free tier available)

Configure your preferred provider in the `STOCK_API_KEY` environment variable.

## Scheduled Services

The scheduler service runs the following tasks:

1. **Daily Currency Rate Updates** (midnight UTC)
   - Fetches latest exchange rates
   - Updates historical rate data

2. **Daily Stock Price Updates** (after market close)
   - Updates prices for all tracked securities
   - Calculates portfolio valuations

3. **Scheduled Transaction Processing** (hourly)
   - Checks for due scheduled transactions
   - Creates transactions or sends notifications

4. **Notification Delivery** (every 5 minutes)
   - Processes pending notifications
   - Sends email and browser notifications

## Security Best Practices

1. **Always change default passwords** in production
2. **Use strong JWT secrets** (minimum 32 characters)
3. **Enable HTTPS/TLS** for production deployments
4. **Regularly update dependencies** for security patches
5. **Enable two-factor authentication** when available
6. **Use environment-specific .env files** (never commit secrets)
7. **Regular database backups** are essential
8. **Monitor audit logs** for suspicious activity

## Development Roadmap

### Phase 1: Backend Core (In Progress)
- [x] Database schema design
- [x] Docker configuration
- [x] Authentication system (Local & OIDC)
- [ ] Account management endpoints
- [ ] Transaction management endpoints
- [ ] Category management endpoints
- [ ] Multi-currency support

### Phase 2: Backend Services
- [ ] Currency exchange rate service
- [ ] Stock price update service
- [ ] Scheduled transaction processor
- [ ] Notification service
- [ ] Budget tracking
- [ ] Report generation

### Phase 3: Frontend Development
- [ ] Next.js project setup
- [ ] Authentication UI
- [ ] Dashboard layout
- [ ] Account management UI
- [ ] Transaction entry and management
- [ ] Investment portfolio tracking
- [ ] Budget management UI
- [ ] Reporting and charts
- [ ] Mobile-responsive design

### Phase 4: Advanced Features
- [ ] Data import/export (OFX, QFX, CSV)
- [ ] Automatic bank transaction import
- [ ] Receipt capture and OCR
- [ ] Advanced reporting with custom filters
- [ ] Multi-user support with shared accounts
- [ ] Mobile app (React Native)

## Testing

```bash
# Unit tests
cd backend
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## Deployment

### Production with Docker

1. Update environment variables for production
2. Build production images:
```bash
docker-compose -f docker-compose.prod.yml build
```

3. Start services:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Manual Deployment

Refer to individual service documentation for manual deployment options.

## Contributing

This is a personal project template. Feel free to fork and customize for your own needs.

## License

MIT License - See LICENSE file for details

## Support

For issues and questions, please refer to the documentation or create an issue in the repository.

## Acknowledgments

- Inspired by Microsoft Money
- Built with modern open-source technologies
- Community-driven development

---

**Note**: This application is under active development. Features and documentation will be updated regularly.
