# Authentication Setup Guide

This document describes the authentication system implementation for Monize.

## Overview

The authentication system provides:
- **Local Authentication**: Email/password registration and login with bcrypt hashing
- **OIDC/OAuth Support**: Single Sign-On with third-party identity providers
- **JWT Token-based Auth**: Secure token management with httpOnly cookies (7-day expiration)
- **Two-Factor Authentication**: TOTP-based 2FA with authenticator app support
- **Trusted Devices**: "Don't ask again" option for 2FA (30-day browser trust)
- **Password Management**: Change password, forced password change, admin password reset
- **Admin User Management**: Role assignment, user status toggle, user creation/deletion
- **Protected Routes**: Automatic route protection with middleware and forced redirects
- **Form Validation**: Zod schema validation with React Hook Form
- **State Management**: Zustand store with persistence

## Architecture

### Frontend Structure

```
frontend/src/
├── app/
│   ├── auth/
│   │   └── callback/              # OIDC callback handler
│   │       └── page.tsx
│   ├── admin/                     # Admin user management
│   │   └── page.tsx
│   ├── dashboard/                 # Protected dashboard page
│   │   └── page.tsx
│   ├── login/                     # Login page
│   │   └── page.tsx
│   ├── register/                  # Registration page
│   │   └── page.tsx
│   ├── change-password/           # Change/forced password change
│   │   └── page.tsx
│   ├── setup-2fa/                 # Forced 2FA setup
│   │   └── page.tsx
│   ├── settings/                  # User settings (profile, 2FA, devices)
│   │   └── page.tsx
│   ├── accounts/                  # Account management
│   ├── transactions/              # Transaction management
│   ├── investments/               # Investment portfolio
│   ├── bills/                     # Scheduled transactions
│   ├── reports/                   # Financial reports
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── auth/
│   │   ├── ProtectedRoute.tsx     # Client-side route protection
│   │   └── TwoFactorVerify.tsx    # 2FA code entry with "remember device"
│   ├── admin/
│   │   └── UserManagementTable.tsx # Admin user management
│   └── ui/
│       ├── Button.tsx
│       ├── Input.tsx
│       ├── Modal.tsx
│       └── Select.tsx
├── lib/
│   ├── api.ts                     # Axios client with interceptors
│   ├── auth.ts                    # Authentication API functions
│   └── user-settings.ts           # User preferences API
├── store/
│   ├── authStore.ts               # Zustand auth state management
│   └── preferencesStore.ts        # User preferences state
├── types/
│   └── auth.ts                    # TypeScript type definitions
└── middleware.ts                  # Next.js middleware for route protection
```

## Features Implemented

### 1. Authentication Pages

#### Login Page (`/login`)
- Email and password fields with validation
- SSO/OIDC login button (shown when OIDC is configured)
- Link to registration page (when registration is enabled)
- Form validation with Zod
- Loading states and error handling
- Triggers 2FA verification when required

#### Register Page (`/register`)
- Email, password, and confirm password fields
- Optional first name and last name
- Password strength validation (min 8 characters)
- Password confirmation matching
- SSO/OIDC registration option
- Can be disabled via `REGISTRATION_ENABLED=false` env var

#### OIDC Callback Page (`/auth/callback`)
- Handles OAuth/OIDC redirect after authentication
- Reads JWT from httpOnly cookie set by backend
- Fetches user profile
- Stores authentication state
- Redirects to dashboard on success
- Error handling with user feedback

### 2. Two-Factor Authentication

#### 2FA Verification (`TwoFactorVerify` component)
- Displayed after successful password login when 2FA is enabled
- 6-digit TOTP code entry
- "Don't ask again on this browser for 30 days" checkbox
- When checked, a trusted device token is stored as an httpOnly cookie
- On subsequent logins, the trusted device cookie skips 2FA automatically

#### 2FA Setup (`/setup-2fa`)
- QR code display for authenticator app scanning
- Manual secret key display for manual entry
- Verification code confirmation before enabling
- Forced redirect when `FORCE_2FA=true` and 2FA is not set up

#### 2FA in Settings (`/settings`)
- Enable/disable 2FA toggle
- QR code and secret key for setup
- Info banner for OIDC users (2FA only applies to password logins)
- Trusted devices management section (see below)

### 3. Trusted Devices

Managed in the Settings page under Security:
- Lists all trusted browsers/devices with device name, IP, last used, and expiry
- "Current device" badge for the active browser
- Individual device revocation
- "Revoke All" button with confirmation modal
- Automatically cleared when 2FA is disabled

### 4. Password Management

#### Change Password (`/change-password`)
- Current password verification (for password-based accounts)
- New password with confirmation
- Forced password change redirect when `mustChangePassword` flag is set
- Used after admin password resets (temporary passwords)

#### Admin Password Reset
- Admins can reset any user's password from the admin panel
- Generates a temporary password that must be changed on next login

### 5. Admin User Management (`/admin`)

- User list table with search
- Role assignment (admin/user)
- Toggle user active/disabled status
- Reset user passwords (generates temporary password)
- Create new users
- Delete users with confirmation
- Admin-only route guard

### 6. State Management

**Auth Store** ([authStore.ts](src/store/authStore.ts)):
- User information storage
- Authentication status tracking
- Loading and error states
- Persistent storage with localStorage
- Actions: login, logout, setUser, setError, clearError

### 7. API Integration

**API Client** ([api.ts](src/lib/api.ts)):
- Axios instance with base URL configuration
- Credentials included (`withCredentials: true`) for httpOnly cookies
- Response interceptor: Handles 401 errors and auto-logout
- Timeout configuration (10 seconds)

**Auth API** ([auth.ts](src/lib/auth.ts)):
- `login(credentials)` - Authenticate with email/password
- `register(data)` - Create new user account
- `logout()` - Invalidate session and clear cookies
- `getProfile()` - Fetch current user data
- `initiateOidc()` - Redirect to OIDC provider
- `verify2FA(tempToken, code, rememberDevice)` - Verify TOTP code
- `setup2FA()` - Get QR code and secret for 2FA setup
- `enable2FA(code)` - Confirm and enable 2FA
- `disable2FA(code)` - Disable 2FA
- `changePassword(currentPassword, newPassword)` - Change password
- `getTrustedDevices()` - List trusted devices
- `revokeTrustedDevice(id)` - Revoke specific device
- `revokeAllTrustedDevices()` - Revoke all devices

### 8. Route Protection

**Middleware** ([middleware.ts](src/middleware.ts)):
- Server-side route protection
- Checks for auth token in httpOnly cookies
- Redirects unauthenticated users to login
- Redirects authenticated users away from auth pages
- Preserves redirect path for post-login navigation

**ProtectedRoute Component** ([ProtectedRoute.tsx](src/components/auth/ProtectedRoute.tsx)):
- Client-side route protection wrapper
- Shows loading state while checking auth
- Redirects to login if not authenticated
- Redirects to `/change-password` if `mustChangePassword` is true
- Redirects to `/setup-2fa` if `FORCE_2FA` is enabled and 2FA is not set up

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

**Authentication:**
- `POST /api/v1/auth/register` - User registration
- `POST /api/v1/auth/login` - User login (sets httpOnly cookie)
- `POST /api/v1/auth/logout` - User logout (clears cookie)
- `GET /api/v1/auth/profile` - Get user profile
- `GET /api/v1/auth/oidc` - Initiate OIDC flow
- `GET /api/v1/auth/oidc/callback` - OIDC callback handler

**Two-Factor Authentication:**
- `POST /api/v1/auth/2fa/verify` - Verify TOTP code
- `POST /api/v1/auth/2fa/setup` - Generate QR code and secret
- `POST /api/v1/auth/2fa/enable` - Enable 2FA after verification
- `POST /api/v1/auth/2fa/disable` - Disable 2FA

**Trusted Devices:**
- `GET /api/v1/auth/2fa/trusted-devices` - List trusted devices
- `DELETE /api/v1/auth/2fa/trusted-devices/:id` - Revoke specific device
- `DELETE /api/v1/auth/2fa/trusted-devices` - Revoke all devices

**Password Management:**
- `POST /api/v1/auth/change-password` - Change password

**Admin:**
- `GET /api/v1/admin/users` - List all users
- `POST /api/v1/admin/users` - Create new user
- `PATCH /api/v1/admin/users/:id/role` - Change user role
- `PATCH /api/v1/admin/users/:id/status` - Toggle active/disabled
- `POST /api/v1/admin/users/:id/reset-password` - Reset user password
- `DELETE /api/v1/admin/users/:id` - Delete user

## Token Management

- **Storage**: JWT tokens are stored in httpOnly cookies set by the backend
- **Cookie Settings**:
  - `httpOnly: true` (not accessible via JavaScript)
  - `sameSite: 'lax'` (CSRF protection)
  - `secure: true` (HTTPS only in production)
  - `maxAge: 7 days`
- **Trusted Device Cookie**: Separate httpOnly cookie (`trusted_device`) with 30-day expiry
- **Auto-logout**: If a 401 response is received, user is automatically logged out
- **Persistence**: User data is persisted in localStorage via Zustand (tokens are NOT in localStorage)

## Security Features

1. **httpOnly Cookies**: JWT tokens cannot be accessed by JavaScript (XSS-safe)
2. **SameSite Cookies**: CSRF protection via cookie attribute
3. **Form Validation**: Client-side validation with Zod
4. **Password Requirements**: Minimum 8 characters with bcrypt hashing
5. **Token Expiration**: 7-day JWT expiration
6. **Auto-logout on 401**: Automatic session invalidation
7. **TOTP 2FA**: Time-based one-time passwords via authenticator apps
8. **Trusted Device Tokens**: SHA256-hashed tokens for device trust
9. **Rate Limiting**: Auth endpoints are rate-limited on the backend
10. **Role-Based Access**: Admin routes protected by role guards
11. **Forced Security Policies**: Configurable forced 2FA and password change

## Troubleshooting

### "Invalid credentials" error
- Verify backend is running on `http://localhost:3001`
- Check network tab for API errors
- Ensure CORS is properly configured on backend

### Redirect loops
- Clear cookies and localStorage
- Verify middleware configuration
- Check that public paths are properly defined

### Cookies not working
- Ensure `withCredentials: true` is set on API client
- Verify backend CORS allows credentials from frontend origin
- Check that cookie domain matches (localhost for development)
- Try in incognito/private mode

### 2FA not working
- Ensure device clock is synchronized (TOTP is time-based)
- Verify authenticator app is using the correct secret
- Check that 2FA was properly enabled (verification step completed)

### OIDC not working
- Verify OIDC environment variables in backend
- Check OIDC provider configuration
- Ensure callback URL is whitelisted in provider

## Type Definitions

See [types/auth.ts](src/types/auth.ts) for complete TypeScript type definitions:
- `User` - User data with `hasPassword`, `twoFactorEnabled`, `mustChangePassword`
- `AdminUser` - Extended user data for admin views
- `TrustedDevice` - Trusted device with `isCurrent` flag
- `LoginCredentials` - Login form data
- `RegisterData` - Registration form data
- `AuthResponse` - API response structure (may include `requires2FA` and `tempToken`)
- `UserPreferences` - User settings (currency, theme, date format, etc.)

## Dependencies

Key packages used:
- **next**: React framework with App Router
- **react-hook-form**: Form state management
- **zod**: Schema validation
- **@hookform/resolvers**: Zod integration with react-hook-form
- **zustand**: Lightweight state management
- **axios**: HTTP client (with `withCredentials` for cookies)
- **react-hot-toast**: Toast notifications
- **tailwindcss**: Styling with dark mode support
