# Getting Started with Personal Finance Management System

This guide will walk you through setting up and running your personal finance management application.

## Quick Start (Docker - Recommended)

The fastest way to get started is using Docker Compose, which sets up all services automatically.

### 1. Prerequisites

Install the following on your system:
- [Docker](https://docs.docker.com/get-docker/) (version 20.10+)
- [Docker Compose](https://docs.docker.com/compose/install/) (version 2.0+)

### 2. Configuration

```bash
# Navigate to the project directory
cd /home/ken/moneymate

# Copy the environment template
cp .env.example .env

# Edit the .env file with your settings
nano .env  # or use your preferred editor
```

### 3. Important Environment Variables

Update these in your `.env` file:

```bash
# Security (REQUIRED - Change these!)
POSTGRES_PASSWORD=your_strong_password_here
JWT_SECRET=your_random_32+_character_secret_here
SESSION_SECRET=another_random_secret_here

# API Keys (Optional but recommended for full functionality)
EXCHANGE_RATE_API_KEY=get_from_https://exchangerate-api.com
STOCK_API_KEY=get_from_https://www.alphavantage.co

# OIDC (Optional - only if using external authentication)
OIDC_ISSUER_URL=https://your-oidc-provider.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
```

### 4. Start the Application

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Check service status
docker-compose ps
```

### 5. Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **API Documentation**: http://localhost:3001/api/docs

### 6. Create Your First Account

1. Open http://localhost:3000
2. Click "Register" to create a new account
3. Fill in your email and password
4. Start managing your finances!

## Development Setup (Without Docker)

If you prefer to run services individually:

### 1. Install Dependencies

#### Backend
```bash
cd backend
npm install
```

#### Frontend
```bash
cd frontend
npm install
```

### 2. Set Up PostgreSQL

```bash
# Create database
createdb moneymate_db

# Create user
psql -c "CREATE USER moneymate_user WITH PASSWORD 'changeme';"

# Grant privileges
psql -c "GRANT ALL PRIVILEGES ON DATABASE moneymate_db TO moneymate_user;"

# Initialize schema
psql moneymate_db < database/schema.sql
```

### 3. Start Redis

```bash
# macOS (with Homebrew)
brew services start redis

# Linux
sudo systemctl start redis

# Or run directly
redis-server
```

### 4. Start the Backend

```bash
cd backend
npm run start:dev
```

The API will be available at http://localhost:3001

### 5. Start the Frontend

```bash
cd frontend
npm run dev
```

The application will be available at http://localhost:3000

## Next Steps

### 1. Complete Backend Implementation

The following modules need to be implemented:

```bash
cd backend/src

# Create remaining module files:
# - transactions/
# - categories/
# - currencies/
# - securities/
# - scheduled-transactions/
# - budgets/
# - reports/
# - notifications/
```

You can use NestJS CLI to generate these:

```bash
# Install NestJS CLI globally
npm install -g @nestjs/cli

# Generate modules
cd backend
nest g module transactions
nest g service transactions
nest g controller transactions

# Repeat for other modules
```

### 2. Implement Frontend

Create the frontend application structure:

```bash
cd frontend/src

# Create directory structure:
mkdir -p app/{auth,dashboard,accounts,transactions,investments,budgets,reports}
mkdir -p components/{ui,forms,charts,layout}
mkdir -p lib/{api,utils,stores}
mkdir -p styles
```

Key pages to implement:
- Login/Register pages
- Dashboard (overview of finances)
- Accounts page (list and manage accounts)
- Transactions page (view and add transactions)
- Investments page (portfolio tracking)
- Budgets page (budget management)
- Reports page (financial reports and charts)

### 3. Set Up External APIs

#### Exchange Rate API

1. Sign up at https://exchangerate-api.com/ (free tier available)
2. Get your API key
3. Add to `.env`: `EXCHANGE_RATE_API_KEY=your_key`

Alternative providers:
- Fixer.io: https://fixer.io/
- Open Exchange Rates: https://openexchangerates.org/

#### Stock Market API

1. Sign up at https://www.alphavantage.co/ (free tier: 5 requests/min, 500/day)
2. Get your API key
3. Add to `.env`: `STOCK_API_KEY=your_key`

Alternative providers:
- Finnhub: https://finnhub.io/ (60 requests/min free)
- IEX Cloud: https://iexcloud.io/
- Yahoo Finance API (unofficial)

### 4. Configure OIDC (Optional)

If you want to use external authentication (Google, Azure AD, Okta, etc.):

1. Set up an application in your OIDC provider
2. Get the issuer URL, client ID, and client secret
3. Configure redirect URL: `http://localhost:3000/auth/callback`
4. Add credentials to `.env`

Popular OIDC providers:
- **Auth0**: https://auth0.com/
- **Okta**: https://www.okta.com/
- **Azure AD**: https://azure.microsoft.com/en-us/services/active-directory/
- **Google Identity**: https://developers.google.com/identity
- **Keycloak**: https://www.keycloak.org/ (self-hosted)

## Testing the API

### Using Swagger UI

Visit http://localhost:3001/api/docs for interactive API documentation.

### Using cURL

```bash
# Register a new user
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!",
    "firstName": "John",
    "lastName": "Doe"
  }'

# Login
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }'

# Use the returned token for authenticated requests
TOKEN="your_jwt_token_here"

# Get user profile
curl -X GET http://localhost:3001/api/v1/auth/profile \
  -H "Authorization: Bearer $TOKEN"
```

## Stopping the Application

### Docker
```bash
# Stop all services
docker-compose down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose down -v
```

### Development
```bash
# Press Ctrl+C in each terminal running a service
```

## Troubleshooting

### Port Already in Use

If ports 3000, 3001, 5432, or 6379 are already in use:

```bash
# Find and kill the process using a port
# macOS/Linux:
lsof -ti:3000 | xargs kill -9

# Or change the ports in docker-compose.yml
```

### Database Connection Error

```bash
# Check if PostgreSQL is running
docker-compose ps postgres

# View PostgreSQL logs
docker-compose logs postgres

# Restart PostgreSQL
docker-compose restart postgres
```

### Backend Won't Start

```bash
# Check backend logs
docker-compose logs backend

# Common issues:
# 1. Database not ready - wait a few seconds and try again
# 2. Missing environment variables - check .env file
# 3. Port conflict - change PORT in .env
```

### Frontend Won't Start

```bash
# Check frontend logs
docker-compose logs frontend

# Rebuild if needed
docker-compose up -d --build frontend
```

## Database Management

### Backup Database

```bash
# Using Docker
docker-compose exec postgres pg_dump -U moneymate_user moneymate_db > backup.sql

# Restore
docker-compose exec -T postgres psql -U moneymate_user moneymate_db < backup.sql
```

### Access Database

```bash
# Using Docker
docker-compose exec postgres psql -U moneymate_user -d moneymate_db

# Or use a GUI tool like:
# - pgAdmin: https://www.pgadmin.org/
# - DBeaver: https://dbeaver.io/
# - DataGrip: https://www.jetbrains.com/datagrip/
```

### Reset Database

```bash
# WARNING: This deletes all data!
docker-compose down -v
docker-compose up -d
```

## Security Checklist

Before deploying to production:

- [ ] Change all default passwords
- [ ] Use strong JWT secrets (32+ characters)
- [ ] Enable HTTPS/TLS
- [ ] Set up firewall rules
- [ ] Enable rate limiting
- [ ] Configure CORS properly
- [ ] Regular backups
- [ ] Update dependencies regularly
- [ ] Enable audit logging
- [ ] Set up monitoring and alerts

## Performance Optimization

### Database Indexes

The schema includes essential indexes, but you may want to add more based on your query patterns:

```sql
-- Example: Add index for frequent queries
CREATE INDEX idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
```

### Redis Caching

Configure caching for frequently accessed data:

```typescript
// Example: Cache exchange rates for 1 hour
await this.cacheManager.set('exchange_rates', rates, 3600);
```

### Query Optimization

Use database query optimization:

```typescript
// Use select to limit returned fields
const accounts = await this.accountsRepository.find({
  select: ['id', 'name', 'currentBalance'],
  where: { userId, isClosed: false },
});
```

## Additional Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Next.js Documentation](https://nextjs.org/docs)
- [TypeORM Documentation](https://typeorm.io/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Docker Documentation](https://docs.docker.com/)

## Getting Help

If you encounter issues:

1. Check the logs: `docker-compose logs -f`
2. Review the README.md file
3. Check GitHub issues
4. Review API documentation at http://localhost:3001/api/docs

## What's Next?

Now that you have the foundation running:

1. **Complete the backend modules** - Implement remaining services
2. **Build the frontend** - Create the user interface
3. **Add external integrations** - Connect to financial APIs
4. **Customize** - Adapt the system to your needs
5. **Deploy** - Move to production when ready

Happy coding! 🚀
