# Quick Start Guide - MoneyMate Frontend

## Prerequisites

- Node.js 18+ installed
- Backend server running on `http://localhost:3001`
- npm or yarn package manager

## Installation

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
2. Enter:
   - Email: `test@example.com`
   - Password: `password123`
   - First Name: `Test` (optional)
   - Last Name: `User` (optional)
3. Click "Create account"
4. You'll be redirected to the dashboard

### Option 2: Login with Existing Account
1. Visit `http://localhost:3000/login`
2. Enter your email and password
3. Click "Sign in"
4. You'll be redirected to the dashboard

### Option 3: SSO/OIDC Login
1. Visit `http://localhost:3000/login`
2. Click "Sign in with SSO"
3. Complete authentication with your OIDC provider
4. You'll be redirected back to the dashboard

## Available Routes

- `/` - Home page (redirects to login)
- `/login` - Login page
- `/register` - Registration page
- `/dashboard` - Protected dashboard (requires authentication)
- `/auth/callback` - OIDC callback handler (automatic)

## Testing Protected Routes

Try accessing `/dashboard` without logging in - you'll be automatically redirected to `/login`.

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

After confirming authentication works:
1. Build dashboard features (accounts, transactions, budgets)
2. Add email verification
3. Implement password reset
4. Add two-factor authentication
5. Create user settings page

See [AUTH_SETUP.md](AUTH_SETUP.md) for detailed documentation.
