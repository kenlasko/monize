# Quick Start Guide - MoneyMate Frontend

## Prerequisites

- Node.js 20+ installed
- Backend server running on `http://localhost:3001`
- npm package manager

## Installation

### Option 1: Docker (Recommended)

The easiest way to run MoneyMate is via Docker Compose from the project root:

```bash
cd /home/ken/moneymate
cp .env.example .env  # Configure as needed
docker compose up -d
```

This starts the frontend, backend, and PostgreSQL database together.

### Option 2: Local Development

1. Navigate to the frontend directory:
```bash
cd /home/ken/moneymate/frontend
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment variables:
```bash
cp .env.local.example .env.local
```

4. Start the development server:
```bash
npm run dev
```

5. Open your browser to `http://localhost:3000`

## Test the Authentication Flow

### Option 1: Create a New Account
1. Visit `http://localhost:3000/register`
2. Enter email, password, and optional name fields
3. Click "Create account"
4. You'll be redirected to the dashboard

### Option 2: Login with Existing Account
1. Visit `http://localhost:3000/login`
2. Enter your email and password
3. Click "Sign in"
4. If 2FA is enabled, enter your authenticator code
5. You'll be redirected to the dashboard

### Option 3: SSO/OIDC Login
1. Visit `http://localhost:3000/login`
2. Click "Sign in with SSO"
3. Complete authentication with your OIDC provider
4. You'll be redirected back to the dashboard

## Available Routes

### Public Routes
- `/login` - Login page
- `/register` - Registration page (when enabled)
- `/auth/callback` - OIDC callback handler (automatic)

### Protected Routes
- `/dashboard` - Dashboard with account summaries, charts, upcoming bills, top movers
- `/accounts` - Account list and management
- `/accounts/[id]` - Account details and transactions
- `/transactions` - Transaction list with search and filtering
- `/investments` - Investment portfolio, holdings, and transactions
- `/bills` - Scheduled transactions and cash flow forecast
- `/reports` - Financial reports (spending, income, net worth, etc.)
- `/settings` - Profile, password, 2FA, trusted devices, preferences
- `/change-password` - Change password (also used for forced password change)
- `/setup-2fa` - Two-factor authentication setup (also used for forced 2FA)

### Admin Routes
- `/admin` - User management (admin role required)

## Testing Protected Routes

Try accessing `/dashboard` without logging in — you'll be automatically redirected to `/login`.

## Troubleshooting

### Port 3000 already in use
```bash
# Kill the process using port 3000
lsof -ti:3000 | xargs kill -9

# Or run on a different port
PORT=3001 npm run dev
```

### Backend connection error
- Ensure backend is running: `cd ../backend && npm run start:dev`
- Check `.env.local` has correct `NEXT_PUBLIC_API_URL`
- Verify CORS is enabled in backend for `http://localhost:3000`

### Cookies not persisting
- Clear browser cookies and localStorage
- Try in incognito/private mode
- Check browser console for errors

## Development Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run linter
npm run lint

# Type check
npm run type-check
```

## What's Next?

After confirming the application works:
1. Set up your accounts (chequing, savings, credit, investment, etc.)
2. Import transactions via QIF file import
3. Configure categories and payees
4. Set up scheduled transactions for recurring bills
5. Add investment holdings and securities
6. Enable two-factor authentication for security
7. Configure notification preferences for bill reminders

See [AUTH_SETUP.md](AUTH_SETUP.md) for detailed authentication documentation.
