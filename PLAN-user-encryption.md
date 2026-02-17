# Plan: User-Level Zero-Knowledge Encryption

## Goal

Encrypt sensitive financial data so that it can only be decrypted with the user's password. Neither a database administrator nor a server operator with access to environment variables (JWT_SECRET, etc.) should be able to read the plaintext data. This is a "zero-knowledge" architecture: the server never persistently stores the key material needed to decrypt user data.

---

## Cryptographic Design

### Key Derivation Chain

```
User Password
    |
    v
bcrypt (existing, for authentication -- unchanged)
    |
User Password (plaintext, in memory only during login)
    |
    v
Argon2id(password, user_encryption_salt, m=64MB, t=3, p=1) --> Master Key (256-bit)
    |
    v
HKDF-SHA256(masterKey, "data-encryption-key") --> Data Encryption Key (DEK, 256-bit)
HKDF-SHA256(masterKey, "dek-wrapping-key")    --> Key Wrapping Key (KWK, 256-bit)
```

### Key Wrapping (at rest)

The DEK is encrypted (wrapped) with the KWK and stored in the database:

```
users table additions:
  encryption_salt      BYTEA        -- random 32 bytes, generated once per user
  wrapped_dek          TEXT         -- AES-256-GCM(KWK, DEK) -- hex-encoded salt:iv:tag:ciphertext
  dek_version          INTEGER      -- key version for rotation support
```

**Why separate DEK and KWK?** Password changes only require re-wrapping the DEK with a new KWK derived from the new password. All encrypted data remains intact -- no bulk re-encryption needed.

### Encryption Algorithm

**AES-256-GCM** (authenticated encryption with associated data)
- Per-field random 96-bit IV
- AAD = `userId + ":" + fieldName` (binds ciphertext to its owner and column)
- Output format: `enc:v1:iv_hex:tag_hex:ciphertext_hex` (prefixed for easy identification)

---

## What Gets Encrypted

### Tier 1: High Sensitivity (encrypt these)

| Table | Fields |
|---|---|
| `accounts` | `name`, `account_number`, `institution` |
| `transactions` | `payee_name`, `description`, `reference_number` |
| `transaction_splits` | `memo` |
| `payees` | `name`, `notes` |
| `categories` | `name`, `description` |
| `securities` | `name`, `symbol` |
| `scheduled_transactions` | `name` |
| `custom_reports` | `name` |

### NOT Encrypted (by design)

| Data | Reason |
|---|---|
| Amounts / balances | Required for server-side aggregation (reports, net worth, running balances) |
| Dates | Required for server-side filtering, sorting, scheduling |
| UUIDs / foreign keys | Required for relational integrity |
| Enum fields (account_type, status, frequency) | Required for server-side filtering and business logic |
| Currency codes | Required for exchange rate calculations |
| Boolean flags | Required for business logic |
| `user_preferences` | Non-sensitive configuration data |

### Trade-offs of This Boundary

- **Server-side search on encrypted fields becomes impossible.** Full-text search on payee names, transaction descriptions, etc. must move client-side or use a blind index (see below).
- **Server-side sorting on encrypted fields is impossible.** Sorting by name/payee must happen client-side.
- **Reports that group by payee or category name** still work because they group by ID; the name is just a display label decrypted client-side.

---

## Key Lifecycle

### User Registration / Account Creation

1. User submits password
2. Server authenticates (bcrypt hash as usual)
3. Generate random `encryption_salt` (32 bytes)
4. Derive Master Key via Argon2id(password, encryption_salt)
5. Derive DEK via HKDF(masterKey, "data-encryption-key")
6. Derive KWK via HKDF(masterKey, "dek-wrapping-key")
7. Wrap DEK: `wrapped_dek = AES-256-GCM(KWK, DEK)`
8. Store `encryption_salt` and `wrapped_dek` in `users` row
9. Return DEK to the session (see Session Key Management below)

### Login

1. User submits password
2. Server validates via bcrypt (existing flow)
3. Derive Master Key from password + stored `encryption_salt`
4. Derive KWK, unwrap `wrapped_dek` to get DEK
5. DEK is available for the session (see below)

### Password Change

1. User provides old password + new password
2. Unwrap DEK using old password's KWK (verify old password works)
3. Generate new `encryption_salt`
4. Derive new Master Key, new KWK from new password
5. Re-wrap same DEK with new KWK
6. Update `encryption_salt` and `wrapped_dek` in DB
7. No re-encryption of any data needed

### Password Reset (admin or forgot-password flow)

**This is the critical trade-off of zero-knowledge encryption.** If the user forgets their password, the DEK cannot be recovered. Options:

- **Option A: Recovery key at registration.** Generate a random recovery key (e.g., 24-word BIP39 mnemonic or a base64 string) shown once to the user. Store a second wrapped copy of the DEK encrypted with a key derived from the recovery phrase. User must store this securely offline.
- **Option B: Accept data loss.** Password reset wipes encrypted data and starts fresh. User must re-import.
- **Option C: Escrow (breaks zero-knowledge).** Store a server-encrypted copy of the DEK. Defeats the purpose.

**Recommendation: Option A** -- recovery key shown once at encryption enrollment time. The user has responsibility to store it. If both password and recovery key are lost, data is unrecoverable.

### Admin Password Reset

When an admin forces a password reset via `resetUserPassword`:
- The DEK cannot be re-wrapped because the admin does not know the user's password
- The user's `must_change_password` flag is set
- On next login with the temporary password, the system unwraps the DEK with the temp password... **wait, this won't work** -- the wrapped DEK is tied to the old password
- **Solution:** Admin password reset must require the user to enter their recovery key on next login to re-wrap the DEK with their new password. Or, the admin reset flow is removed/modified for encrypted users.

---

## Session Key Management

### Option: Server-side session DEK (simpler, recommended for this architecture)

The DEK is held in server memory for the duration of the user's session:

1. On login, DEK is unwrapped and stored in an encrypted in-memory store (e.g., a `Map<userId, DEK>`) on the backend
2. The DEK is **never** written to disk, database, or logs
3. On logout or session expiry, the DEK is cleared from memory
4. The access token (JWT) identifies which user's DEK to use

**Pros:** All encryption/decryption happens server-side. No changes to API response format. Frontend is unaware of encryption.
**Cons:** DEK is in server memory. A server memory dump could expose it. Multi-instance deployments need sticky sessions or a shared encrypted cache (Redis with encryption).

### Alternative: Client-side DEK (true zero-knowledge)

The DEK is sent to the client at login and all encryption/decryption happens in the browser:

**Pros:** Server never holds the DEK after login response. True zero-knowledge.
**Cons:** Massive frontend rework. Every API response contains ciphertext. All search/filter/sort on encrypted fields must be client-side. The DEK is in browser memory (XSS risk). Key must survive page refreshes (sessionStorage or in-memory only).

**Recommendation: Server-side session DEK.** It provides strong protection against database theft and passive server access while keeping the architecture manageable. It does NOT protect against an active attacker with server shell access who can inspect process memory, but that threat model requires client-side encryption which has enormous complexity costs.

---

## Implementation Phases

### Phase 1: Infrastructure

1. **Add database columns** to `users`:
   - `encryption_salt BYTEA`
   - `wrapped_dek TEXT`
   - `dek_version INTEGER DEFAULT 1`
   - `recovery_key_wrapped_dek TEXT` (second copy of DEK wrapped with recovery key)
   - `recovery_key_salt BYTEA`

2. **Create encryption service** (`EncryptionService`):
   - `deriveKeys(password, salt) -> { masterKey, dek, kwk }`
   - `wrapDek(kwk, dek) -> wrappedDek`
   - `unwrapDek(kwk, wrappedDek) -> dek`
   - `encryptField(dek, userId, fieldName, plaintext) -> ciphertext`
   - `decryptField(dek, userId, fieldName, ciphertext) -> plaintext`
   - Uses Argon2id (via `argon2` npm package) + HKDF + AES-256-GCM

3. **Create session key store** (`KeyStoreService`):
   - In-memory `Map<string, { dek: Buffer, expiresAt: number }>`
   - `storeDek(userId, dek, ttl)` / `getDek(userId)` / `clearDek(userId)`
   - TTL matches refresh token lifetime; cleared on logout
   - Periodic cleanup of expired entries

4. **Create TypeORM subscriber or interceptor** for transparent encryption/decryption:
   - `@EncryptedColumn()` decorator marks entity fields that should be encrypted
   - Before INSERT/UPDATE: encrypt marked fields using DEK from KeyStoreService
   - After SELECT: decrypt marked fields
   - Falls back to plaintext if value doesn't start with `enc:v1:` prefix (migration compatibility)

### Phase 2: Auth Flow Integration

5. **Modify registration** (`AuthService.register()`):
   - After bcrypt hash, derive keys and create wrapped DEK
   - Generate recovery key, wrap DEK copy, show recovery key to user once
   - Store encryption columns

6. **Modify login** (`AuthService.login()` / `AuthService.verify2fa()`):
   - After successful authentication, derive keys, unwrap DEK
   - Store DEK in KeyStoreService
   - On token refresh: DEK stays in memory (keyed by userId, not token)

7. **Modify logout** / session revocation:
   - Clear DEK from KeyStoreService

8. **Modify change password** (`UsersService.changePassword()`):
   - Re-wrap DEK with new password-derived KWK
   - Update encryption_salt and wrapped_dek

9. **Modify password reset flow**:
   - Forgot password: after reset, require recovery key entry to restore DEK
   - Admin reset: flag account, require recovery key on next login

### Phase 3: Data Layer Integration

10. **Add `@EncryptedColumn()` decorator** to entity fields listed in "What Gets Encrypted"

11. **Build migration script** to encrypt existing plaintext data:
    - This is a one-time batch operation
    - Requires the user to be logged in (DEK available) or provide their password
    - Could be triggered on first login after the feature is deployed
    - Processes all rows for the user, encrypts marked fields, updates in batch

12. **Handle search on encrypted fields**:
    - **Blind index approach**: For fields that need server-side lookup (e.g., payee name for deduplication), store `HMAC-SHA256(dek, lowercase(plaintext))` as a separate indexed column
    - This allows exact-match lookups without exposing plaintext
    - Partial/fuzzy search must be client-side

### Phase 4: Frontend Adjustments

13. **Recovery key display**: Show recovery key once during registration or encryption enrollment. Force user to confirm they've saved it.

14. **Recovery key entry flow**: New page/modal for entering recovery key after password reset.

15. **Search modifications**: Transaction search, payee search, etc. may need to shift to client-side filtering for encrypted fields, or use the blind index for exact matches.

16. **Encryption enrollment for existing users**: Settings page option to "Enable encryption" -- prompts for password, generates keys, runs migration.

---

## Database Migration

```sql
ALTER TABLE users ADD COLUMN encryption_salt BYTEA;
ALTER TABLE users ADD COLUMN wrapped_dek TEXT;
ALTER TABLE users ADD COLUMN dek_version INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN recovery_key_wrapped_dek TEXT;
ALTER TABLE users ADD COLUMN recovery_key_salt BYTEA;

-- Blind index columns for searchable encrypted fields
ALTER TABLE payees ADD COLUMN name_hmac VARCHAR(64);
CREATE INDEX idx_payees_name_hmac ON payees(user_id, name_hmac);

ALTER TABLE categories ADD COLUMN name_hmac VARCHAR(64);
CREATE INDEX idx_categories_name_hmac ON categories(user_id, name_hmac);
```

---

## Multi-Instance / Scaling Considerations

- The in-memory KeyStore is per-process. With multiple backend instances:
  - **Option 1: Sticky sessions** -- route all requests from a user to the same instance
  - **Option 2: Encrypted Redis** -- store DEK in Redis encrypted with a server-side key. Still better than plaintext DB since the Redis key is ephemeral and the DEK is double-encrypted
  - **Option 3: Re-derive on each request** -- expensive (Argon2id is intentionally slow), not viable for high-frequency API calls
  - **Recommendation for current Docker single-instance setup:** Option 1 is automatic (single instance). Document Option 2 for future scaling.

---

## Security Analysis

| Threat | Protected? | Notes |
|---|---|
| Database dump / SQL injection data exfil | Yes | Data is AES-256-GCM encrypted, key not in DB |
| Database backup theft | Yes | Same as above |
| Server env vars compromised (JWT_SECRET) | Yes | DEK is not derived from JWT_SECRET |
| Active attacker with server shell access | Partial | DEK is in process memory during active sessions. Protects data of users not currently logged in |
| Server-side code modification (malicious deploy) | No | Attacker could modify code to exfiltrate DEK on login. Only client-side encryption fully mitigates this |
| User forgets password + recovery key | Data loss | By design -- this is the cost of zero-knowledge |
| XSS (with client-side DEK variant) | Risk | Not applicable with server-side DEK recommendation |

---

## Risks and Complexities

1. **Performance**: Argon2id key derivation adds latency to login (~200-500ms). Field encryption/decryption is fast (AES-GCM is hardware-accelerated on modern CPUs).

2. **Bulk operations**: Importing QIF data, bulk transaction updates -- all must go through the encryption layer. The TypeORM subscriber approach handles this transparently.

3. **Reports**: Server-side aggregation by amount/date still works. Grouping by encrypted field names requires decrypting the group labels, which is fine since report execution already fetches categories/payees.

4. **Unique constraints**: `UNIQUE(user_id, name)` on payees/categories breaks with encrypted names. Must use blind index HMAC column for uniqueness: `UNIQUE(user_id, name_hmac)`.

5. **Sorting**: Server cannot sort by encrypted field values. Client must sort by decrypted values. This affects account lists, payee lists, category lists -- all relatively small datasets that can be sorted client-side.

6. **Migration complexity**: Existing users with unencrypted data need a careful migration path. The "encrypt on first login" approach is safest but means data is temporarily unencrypted until the user logs in.

7. **OIDC users**: Users who authenticate solely via OIDC have no password. Options:
   - Require them to set an "encryption passphrase" separate from their OIDC login
   - Derive from OIDC tokens (not viable -- tokens rotate and are controlled by the IdP)
   - Exclude OIDC-only users from encryption

---

## Estimated Scope

- New files: ~5-7 (encryption service, key store service, decorator, migration, recovery key UI components)
- Modified files: ~15-20 (auth service, users service, all entity files with encrypted columns, search-related services, frontend components for recovery key)
- New npm dependency: `argon2` (native addon, needs build tools in Docker image)
- Database migration: schema changes + data migration script
