# Spec: bank sync notifications

Status: **proposed, awaiting maintainer approval** of the two new categories
and their default channels (`notification-preferences.md` section 12). The
product decisions were made by the feature's requester on 2026-10-01: consent
reminders at 30, 14, 7, 3, 2, 1 and 0 days and on expiry; the success
notification configurable by the user; default channels by importance.

Owner: bank-sync. Related: `docs/specs/bank-sync.md` (task BS12 of
`docs/future-plans/bank-sync-tasks.md`), `notification-preferences.md` (the
delivery matrix this producer plugs into), `system-alerts.md` (the dedupe-key
pattern it copies), INV-NOTIFY-001 (the write door).

---

## 1. What this adds, and the one rule it must obey

Two producers write Notification Center rows for bank sync:

1. **Consent reminders.** A bank connection's consent ends at `valid_until`.
   The user is reminded when 30, 14, 7, 3, 2, 1 and 0 days remain, and once
   when it has ended.
2. **Sync outcomes.** The daily (unattended) sync reports what it did: rows
   imported, an account that failed, a consent the bank ended early.

The rule: **a reminder fires on reaching a threshold, once per consent
period, never on mere observation.** A consent with 5 days left produces the
7-day reminder once; the next days produce nothing until 3 days remain. If
the evaluation missed days (an outage), only the most recent threshold
reached fires, never a burst of the skipped ones.

A sync the user starts by hand reports through its own toast and writes no
notification.

## 2. Types and categories

| Type | Category | Severity | When |
|---|---|---|---|
| `BANK_SYNC_CONSENT_EXPIRING` | `BANK_SYNC` | `info` at 30 and 14 days, `warning` at 7 to 1, `critical` at 0 | a threshold is reached |
| `BANK_SYNC_CONSENT_EXPIRED` | `BANK_SYNC` | `critical` | the consent has ended, or the bank ended it early |
| `BANK_SYNC_FAILED` | `BANK_SYNC` | `warning` | the daily sync of one or more accounts failed |
| `BANK_SYNC_IMPORTED` | `BANK_SYNC_ACTIVITY` | `success` | the daily sync finished, per the connection's success mode |

Two categories, so the matrix can give them different channels: what needs
the user's action (`BANK_SYNC`) and what only reports (`BANK_SYNC_ACTIVITY`).

**Default channels** (the requester's "by importance"; a stored matrix row
always wins):

| Category | In app | Email (immediate) | Push |
|---|---|---|---|
| `BANK_SYNC` | always | on | on |
| `BANK_SYNC_ACTIVITY` | always | off | off |

The current defaults are global (`toChannelPreference`). This spec adds a
per-category default table beside `NOTIFICATION_CATEGORY_CHANNELS`, read only
where no row is stored; every existing category keeps today's defaults, which
a test pins.

## 3. The success mode

`bank_sync_connections.notify_success` (`'always'`, `'when_imported'`,
`'never'`; default `'when_imported'`), set on the connection card:

| Mode | Daily sync imported rows | Daily sync imported nothing |
|---|---|---|
| `always` | notify | notify ("no new transactions") |
| `when_imported` | notify | nothing |
| `never` | nothing | nothing |

Failures and consent reminders do not depend on the mode; the matrix turns
their channels off.

## 4. Consent reminders: evaluation and idempotency

`BankSyncConsentReminderService`, a cron at `23 6 * * *` (UTC). The fan-out
(`withSystemContext`) lists `active` and `expired` connections whose
`valid_until` lies between 7 days ago and 32 days ahead (the two extra days
cover a consent that ends later in the day than the run, and timezones up to
14 hours either side; the day count below alone decides what is owed). Per
user, under
`withUserContext`:

- **Days left** are counted in the user's effective timezone
  (`getUsersByEffectiveTimezone`): the calendar date of `valid_until` in that
  zone minus today in that zone.
- **The threshold to fire** is the smallest `t` in `[30, 14, 7, 3, 2, 1, 0]`
  with `days <= t`, for `days >= 0`. Example: 5 days left gives 7; 2 gives 2.
- **Idempotency** is the notifications dedupe index:
  `dedupeKey = bsc:exp:<connection id>:<valid_until date>:<t>`. A replica that
  loses the insert gets `null` from `create` and sends nothing. A renewal
  changes `valid_until`, so the next period has new keys.
- **The date in a dedupe key** is the UTC date of `valid_until`, so a user
  who changes timezone mid-period does not mint new keys. `data.validUntil`
  is the date in the user's zone on a reminder and the UTC date on an expiry
  notice.
- **Expired** (`valid_until` has passed, even earlier the same day, or the
  connection is `expired`):
  `dedupeKey = bsc:expd:<connection id>:<valid_until date>`. The cron also
  moves an `active` connection whose `valid_until` has passed to `expired`
  with a conditional `UPDATE ... WHERE status = 'active' AND valid_until <
  now()`. The 7-day look-back bounds the window, so a reminder purged after
  30 days (read rows are kept 30 days) is not raised again.

Example: consent valid until 2027-03-30, user in Europe/Warsaw. On 2027-02-28
(30 days) the 30-day reminder; on 2027-03-16 the 14-day one; then 7, 3, 2,
1, 0 on 03-23, 03-27, 03-28, 03-29, 03-30; on 03-31 the expired one. Renewed
on 03-25 to 2027-09-21: no further reminder for the old period, the next on
2027-08-22.

## 5. Sync outcomes

Written by the daily cron after each user's run, once per connection:

- `BANK_SYNC_IMPORTED` per the success mode, written only when at least one
  account synced, with `data` = `{ connectionId, institutionName, imported,
  skipped, accounts }` (`accounts` is the number of accounts that synced). Dedupe key
  `bsc:imp:<connection id>:<UTC date>`.
- `BANK_SYNC_FAILED` when one or more accounts failed for a reason other than
  an ended consent, with `data.failures` = `[{ bankAccountId, label, code }]`
  (the bank's label, else the masked identifier; a label shaped like an
  account number, eight or more digits, is replaced by the masked
  identifier).
  Dedupe key `bsc:fail:<connection id>:<UTC date>`.
- A `session_expired` failure writes `BANK_SYNC_CONSENT_EXPIRED` with the
  expired key of section 4, so the user gets one expiry notice, whichever
  path saw it first, and the cron stops reading that connection's other
  accounts, which would only fail the same way.
- An account that needs its preview (`docs/specs/bank-sync.md` section 7a) is
  skipped and logged, with no notification: its card already says so.
- An account whose sync lost the per-account lease to another sync (a manual
  sync running) is skipped without a failure.
- Failure codes in `data.failures`: the provider error kinds, `credentials`
  (unreadable or refused credentials; `unauthorized` is reported as this),
  `refused` and `unexpected`.

Every row: `target = /settings/bank-sync`. `data` holds facts (dates,
counts, codes), never "in 3 days" text, so the client renders it in the
reader's language and on the reader's clock.

## 6. Copy

- **In app:** composed on the client from `type` and `data`
  (`useNotificationCopy`), with English `title`/`message` stored as the
  fallback.
- **Email and push:** composed in the recipient's language
  (`emailTranslator`, `resolveUserEmailFormats`), through
  `composeLocalizedNotificationCopy`; every value in the email template goes
  through `escapeHtml`. Push carries the generic category copy.
- Strings in every locale.

## 7. Missing-data policy

- A connection without `valid_until` (the provider gave none) gets no
  reminder; its card already shows "no expiry reported".
- A user without a resolvable timezone counts in UTC.
- A sync that could not start for a user (credentials unreadable) writes
  `BANK_SYNC_FAILED` with code `credentials`, once per day.

## 8. Test matrix

| Claim | Test |
|---|---|
| Threshold choice for days 31..-1, including a missed-days jump | unit, pure function |
| One row per threshold across two concurrent evaluations | integration (dedupe index), two connections |
| Renewal starts new keys; the old period fires nothing more | unit and integration |
| Expired marks the connection and notifies once | integration |
| Success mode truth table (section 3) | unit |
| Manual sync writes no notification | unit |
| Per-category defaults: bank sync rows as in section 2, every other category unchanged | unit |
| Copy: every type in every locale, email values escaped | the existing copy and parity specs |
| Cron seeds identity | `rls-context-smoke` pattern |
