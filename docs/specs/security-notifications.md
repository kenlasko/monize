# Spec: security notifications

Status: implements upstream issue kenlasko/monize#2179. Related:
`notification-preferences.md` (the delivery matrix), `ai-review-notifications.md`
(the dedupe-key pattern), INV-NOTIFY-001 (the write door,
`NotificationDispatchService.notify`).

## 1. Purpose

Monize sent no notice when a new OAuth client got access to an account, or when
an MCP credential answered the AI chat relay for the first time. A person could
not learn that somebody new could reach the account. Both events now write a
Notification Center row through the existing dispatch seam (bell, immediate
email, push by the matrix). No new channel, table or migration.

## 2. Types and category

| Type | Category | Severity | When |
|---|---|---|---|
| `OAUTH_CLIENT_AUTHORIZED` | `SECURITY` | `warning` | consent confirmed and a NEW grant was saved |
| `RELAY_CREDENTIAL_FIRST_USE` | `SECURITY` | `warning` | a credential claimed a relay prompt for the first time |

`SecurityNoticeService` (`src/notifications/security-notice.service.ts`) is the
producer. It calls `notify(userId, input, { fanOut: "detached" })` and never
throws: a failed notice must not break consent or the relay. A `null` from
`notify` means the notice already exists, which is the normal repeat case.

## 3. First use is the dedupe key

The unique index `idx_notifications_dedupe (user_id, dedupe_key)` is the
mechanism: `NotificationService.create` is `ON CONFLICT DO NOTHING`, so a repeat
writes no row and sends nothing.

- OAuth: `oauth:grant:<grantId>`. One key per grant, so it needs no long memory.
  An adopted existing grant raises nothing.
- Relay: `relay:cred:<credentialId>`. The prefix is in
  `STATE_KEYED_DEDUPE_PREFIXES`, so `purgeOld` keeps the row as the memory that
  the credential was announced. Without it the purge would delete the row and the
  next claim would announce the same credential again. `purgeOld` never forgets
  a `relay:cred:` row, also not after a year dismissed.
- Known limit: the notification row is the only memory, so the two paths that
  delete a user's notifications outright, "delete my data" and the backup
  restore wipe, also forget which credentials were announced. A personal access
  token that survives them is announced once more on its next relay claim.
  Keeping the mark on the credential itself would remove this; that is a design
  change left for agreement.
- Known limit: no row is seeded for credentials that already exist when this
  ships, so each relay credential already in use is announced once on its first
  claim after the upgrade. Seeding dismissed `relay:cred:` rows would need a data
  migration, outside this change; the release notes should say so.
- Known limit: both notices advise a password change, which revokes every grant
  and token. An account that signs in only through OIDC, with no usable local
  password, has no remedy in the app until a grant list with revoke exists
  (out of scope, section 5).

`data` holds `{ clientId, clientName }` (name with control, format and
line/paragraph separator characters replaced, trimmed, at most 100 code points,
the client id when empty) or `{ credentialKind }` (`pat` or `oauth`). The raw
credential id is never in `data`, the title or the message. A client name is
chosen by whoever registered the client; the immediate email template escapes
the composed strings once.

## 4. Defaults and target

`NOTIFICATION_CATEGORY_DEFAULTS[SECURITY]`: bell, immediate email and push on,
UnifiedPush off (as `BANK_SYNC`). No report-mode digest reads the category.
The target of both is `/settings`. Push copy names the category only.

## 5. Out of scope

- A settings screen listing OAuth grants with revoke.
- Relay credential binding (`AiRelayService`).
