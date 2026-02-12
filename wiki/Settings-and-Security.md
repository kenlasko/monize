# Settings and Security

Monize provides comprehensive security features and configurable user preferences.

---

## Table of Contents

- [User Settings](#user-settings)
- [Two-Factor Authentication (2FA)](#two-factor-authentication-2fa)
- [Trusted Devices](#trusted-devices)
- [Password Management](#password-management)
- [Single Sign-On (OIDC)](#single-sign-on-oidc)
- [Security Architecture](#security-architecture)
- [Admin Features](#admin-features)

---

## User Settings

Navigate to **Settings** (gear icon in the top-right corner) to configure your preferences.

![Settings Page](images/settings-overview.png)
<!-- Screenshot: The settings page showing display preferences, home currency, and security options -->

### Display Preferences

| Setting | Description |
|---------|-------------|
| **Home Currency** | Primary currency for reporting and dashboard totals |
| **Date Format** | How dates are displayed throughout the application |
| **Number Format** | Decimal and thousands separator preferences |
| **Theme** | Light or dark mode |
| **Email Notifications** | Toggle email notifications for bills and reminders |

---

## Two-Factor Authentication (2FA)

Monize supports Time-based One-Time Password (TOTP) authentication for an additional layer of security.

### Setting Up 2FA

1. Navigate to **Settings**
2. Click **Enable Two-Factor Authentication**
3. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)
4. Enter the 6-digit verification code to confirm setup
5. **Save your backup codes** in a secure location

![2FA Setup](images/2fa-setup.png)
<!-- Screenshot: The 2FA setup page showing the QR code and verification input -->

### Logging in with 2FA

After enabling 2FA:

1. Enter your email and password as normal
2. You will be prompted for a 6-digit TOTP code
3. Enter the code from your authenticator app
4. Optionally check "Trust this device" to skip 2FA on this device for future logins

### Disabling 2FA

1. Navigate to **Settings**
2. Click **Disable Two-Factor Authentication**
3. Enter your current TOTP code to confirm

---

## Trusted Devices

When logging in with 2FA, you can mark a device as "trusted" to skip the TOTP prompt on future logins from that device.

### Managing Trusted Devices

1. Navigate to **Settings**
2. Scroll to the **Trusted Devices** section
3. View all currently trusted devices
4. Click **Remove** to revoke trust for any device

![Trusted Devices](images/trusted-devices.png)
<!-- Screenshot: The trusted devices section showing a list of devices with remove buttons -->

> **Security Note:** Trusted device tokens are stored as SHA-256 hashes in the database. The actual token is stored only in the browser cookie.

---

## Password Management

### Changing Your Password

1. Navigate to **Settings** or **Change Password**
2. Enter your current password
3. Enter and confirm your new password
4. Click **Save**

Password changes immediately revoke all existing refresh tokens, logging you out of all other sessions.

### Forgot Password

1. On the login page, click **Forgot Password**
2. Enter your email address
3. Check your email for a reset link
4. Click the link and set a new password

> **Security Note:** Password reset tokens are hashed with SHA-256 before being stored in the database. The token expires after a set time period.

---

## Single Sign-On (OIDC)

Monize supports OpenID Connect (OIDC) for single sign-on integration with identity providers.

### Supported Providers

- Authentik
- Authelia
- Pocket-ID
- Any OpenID Connect-compatible provider

### Configuration

OIDC is configured via environment variables:

```bash
OIDC_ISSUER=https://your-identity-provider.com
OIDC_CLIENT_ID=monize
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=http://localhost:3001/auth/callback
```

When OIDC is configured, a "Sign in with SSO" button appears on the login page.

![OIDC Login](images/oidc-login.png)
<!-- Screenshot: The login page showing the "Sign in with SSO" button below the standard login form -->

---

## Security Architecture

Monize implements comprehensive security measures:

### Authentication

| Feature | Implementation |
|---------|---------------|
| **Password Hashing** | bcrypt with salt rounds |
| **Access Tokens** | JWT with 15-minute expiry |
| **Refresh Tokens** | 7-day rotating tokens with family-based replay detection |
| **TOTP Encryption** | Per-user unique salt (not shared secret) |
| **Rate Limiting** | 100 req/min global, 3-5 per 15 min on auth endpoints |

### Data Protection

| Feature | Implementation |
|---------|---------------|
| **User Isolation** | All database queries filter by userId |
| **Input Validation** | DTO validation with whitelist mode (rejects unknown fields) |
| **SQL Injection** | Parameterized queries via TypeORM |
| **XSS Protection** | No dangerouslySetInnerHTML, HTML escaping in emails |
| **CSRF** | Token validation with httpOnly cookies |

### HTTP Security Headers

| Header | Value |
|--------|-------|
| **Content-Security-Policy** | Restrictive CSP with style-src and script-src whitelist |
| **Strict-Transport-Security** | max-age=31536000; includeSubDomains |
| **X-Content-Type-Options** | nosniff |
| **X-Frame-Options** | DENY |
| **Referrer-Policy** | strict-origin-when-cross-origin |
| **Cross-Origin-Opener-Policy** | same-origin |
| **Cross-Origin-Resource-Policy** | same-origin |
| **Permissions-Policy** | Restrictive policy |

---

## Admin Features

Users with the **admin** role have access to additional features.

### User Management

Navigate to **Admin > User Management** to manage application users.

![User Management](images/admin-user-management.png)
<!-- Screenshot: The admin user management page showing a list of users with roles and actions -->

Admin capabilities:

- View all registered users
- Change user roles (user/admin)
- Disable or enable user accounts
- Reset user passwords

> **Note:** The admin section only appears in the navigation if your user account has the admin role.
