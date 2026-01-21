# Authentication Setup Guide

This document describes the authentication system implementation for MoneyMate.

## Overview

The authentication system provides:
- **Local Authentication**: Email/password registration and login
- **OIDC/OAuth Support**: Single Sign-On with third-party providers
- **JWT Token-based Auth**: Secure token management with 7-day expiration
- **Protected Routes**: Automatic route protection with middleware
- **Form Validation**: Zod schema validation with React Hook Form
- **State Management**: Zustand store with persistence

## Architecture

### Frontend Structure

```
frontend/src/
├── app/
│   ├── auth/
│   │   └── callback/          # OIDC callback handler
│   │       └── page.tsx
│   ├── dashboard/             # Protected dashboard page
│   │   └── page.tsx
│   ├── login/                 # Login page
│   │   └── page.tsx
│   ├── register/              # Registration page
│   │   └── page.tsx
│   ├── globals.css            # Global styles
│   ├── layout.tsx             # Root layout with toast provider
│   └── page.tsx               # Home page (redirects to login)
├── components/
│   ├── auth/
│   │   └── ProtectedRoute.tsx # Client-side route protection
│   └── ui/
│       ├── Button.tsx         # Reusable button component
│       └── Input.tsx          # Reusable input component
├── lib/
│   ├── api.ts                 # Axios client with interceptors
│   ├── auth.ts                # Authentication API functions
│   └── utils.ts               # Utility functions
├── store/
│   └── authStore.ts           # Zustand auth state management
├── types/
│   └── auth.ts                # TypeScript type definitions
└── middleware.ts              # Next.js middleware for route protection
```

## Features Implemented

### 1. Authentication Pages

#### Login Page (`/login`)
- Email and password fields with validation
- "Remember me" checkbox
- "Forgot password" link (placeholder)
- SSO/OIDC login button
- Link to registration page
- Form validation with Zod
- Loading states and error handling

#### Register Page (`/register`)
- Email, password, and confirm password fields
- Optional first name and last name
- Password strength validation (min 8 characters)
- Password confirmation matching
- SSO/OIDC registration option
- Links to terms of service and privacy policy
- Form validation with Zod

#### OIDC Callback Page (`/auth/callback`)
- Handles OAuth/OIDC redirect after authentication
- Extracts token from query parameters
- Fetches user profile
- Stores authentication state
- Redirects to dashboard on success
- Error handling with user feedback

### 2. State Management

**Auth Store** ([authStore.ts](src/store/authStore.ts)):
- User information storage
- Token management with cookies
- Authentication status tracking
- Loading and error states
- Persistent storage with localStorage
- Actions: login, logout, setUser, setToken, setError, clearError

### 3. API Integration

**API Client** ([api.ts](src/lib/api.ts)):
- Axios instance with base URL configuration
- Request interceptor: Auto-attaches JWT Bearer token
- Response interceptor: Handles 401 errors and auto-logout
- Timeout configuration (10 seconds)

**Auth API** ([auth.ts](src/lib/auth.ts)):
- `login(credentials)` - Authenticate with email/password
- `register(data)` - Create new user account
- `logout()` - Invalidate session
- `getProfile()` - Fetch current user data
- `initiateOidc()` - Redirect to OIDC provider

### 4. Route Protection

**Middleware** ([middleware.ts](src/middleware.ts)):
- Server-side route protection
- Checks for auth token in cookies
- Redirects unauthenticated users to login
- Redirects authenticated users away from auth pages
- Preserves redirect path for post-login navigation

**ProtectedRoute Component** ([ProtectedRoute.tsx](src/components/auth/ProtectedRoute.tsx)):
- Client-side route protection wrapper
- Shows loading state while checking auth
- Redirects to login if not authenticated

### 5. Form Components

**Input Component** ([Input.tsx](src/components/ui/Input.tsx)):
- Label and error message support
- Accessible form controls
- Tailwind styling with error states
- Forward ref support for react-hook-form

**Button Component** ([Button.tsx](src/components/ui/Button.tsx)):
- Multiple variants: primary, secondary, outline, ghost
- Size options: sm, md, lg
- Loading state with spinner
- Disabled state handling

## Configuration

### Environment Variables

Create a `.env.local` file in the frontend directory:

```bash
# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001

# App URL (for OIDC callback)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### Backend Requirements

The backend must have these endpoints:

- `POST /api/v1/auth/register` - User registration
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/logout` - User logout
- `GET /api/v1/auth/profile` - Get user profile
- `GET /api/v1/auth/oidc` - Initiate OIDC flow
- `GET /api/v1/auth/oidc/callback` - OIDC callback handler

## Usage

### Install Dependencies

```bash
cd frontend
npm install
```

### Run Development Server

```bash
npm run dev
```

The frontend will be available at `http://localhost:3000`.

### Testing Authentication

1. **Register a new account**:
   - Navigate to `http://localhost:3000/register`
   - Fill in email, password, and optional name fields
   - Submit the form

2. **Login with existing account**:
   - Navigate to `http://localhost:3000/login`
   - Enter email and password
   - Submit the form

3. **SSO/OIDC Login**:
   - Click "Sign in with SSO" button
   - You'll be redirected to the OIDC provider
   - After authentication, you'll return to `/auth/callback`
   - Then redirect to dashboard

4. **Access Protected Routes**:
   - Navigate to `http://localhost:3000/dashboard`
   - If not authenticated, you'll be redirected to login
   - After login, you'll see the dashboard

5. **Logout**:
   - Click the "Logout" button in the dashboard
   - You'll be logged out and redirected to login

## Token Management

- **Storage**: JWT tokens are stored in cookies with 7-day expiration
- **Cookie Settings**:
  - `expires: 7` (7 days)
  - `sameSite: 'strict'` (CSRF protection)
- **Auto-logout**: If a 401 response is received, user is automatically logged out
- **Persistence**: User data is persisted in localStorage via Zustand

## Security Features

1. **HTTPS-only in Production**: Ensure cookies are secure in production
2. **CSRF Protection**: SameSite cookie attribute
3. **Form Validation**: Client-side validation with Zod
4. **Password Requirements**: Minimum 8 characters
5. **Token Expiration**: 7-day JWT expiration
6. **Auto-logout on 401**: Automatic session invalidation

## Next Steps

To enhance the authentication system:

1. **Email Verification**: Add email confirmation for new accounts
2. **Password Reset**: Implement forgot password flow
3. **Two-Factor Authentication**: Add 2FA support
4. **Refresh Tokens**: Implement token refresh mechanism
5. **Social Logins**: Add specific Google, GitHub buttons
6. **Account Settings**: User profile editing page
7. **Session Management**: View and manage active sessions

## Troubleshooting

### "Invalid credentials" error
- Verify backend is running on `http://localhost:3001`
- Check network tab for API errors
- Ensure CORS is properly configured on backend

### Redirect loops
- Clear cookies and localStorage
- Verify middleware configuration
- Check that public paths are properly defined

### Token not persisting
- Check browser cookie settings
- Verify cookie domain matches
- Check for browser extensions blocking cookies

### OIDC not working
- Verify OIDC environment variables in backend
- Check OIDC provider configuration
- Ensure callback URL is whitelisted in provider

## Type Definitions

See [types/auth.ts](src/types/auth.ts) for complete TypeScript type definitions:
- `User` - User data structure
- `LoginCredentials` - Login form data
- `RegisterData` - Registration form data
- `AuthResponse` - API response structure
- `AuthState` - Zustand store state

## Dependencies

Key packages used:
- **next**: React framework with routing
- **react-hook-form**: Form state management
- **zod**: Schema validation
- **@hookform/resolvers**: Zod integration with react-hook-form
- **zustand**: Lightweight state management
- **axios**: HTTP client
- **js-cookie**: Cookie management
- **react-hot-toast**: Toast notifications
- **tailwindcss**: Styling
- **@tailwindcss/forms**: Form styling plugin
