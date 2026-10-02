# Notification preferences and delivery control

Status: DRAFT (spec-first, per `AGENTS.md` "a financial feature of any substance
starts from a short approved spec committed before the implementation").
Owner: notification-center. Related: discussion #1291, INV-NOTIFY-001,
INV-PUSH-001..005.

This spec covers the *preferences and delivery* layer on top of the existing
notification center (one `notifications` table, one write door
`NotificationService.create`, one push transport `WebPushSender`). It does not
change what a producer decides to say; it decides **whether, where, how often,
and how loudly** each notification reaches a user.

The as-is map, the concrete data model, the migration number and the per-file
integration plan are filled in Sections 8-11 after the code survey; Sections
1-7 are the design and are stable regardless of that survey.

---

## 1. Requirements (from the user and discussion #1291)

R1. Notifications are organised into **groups**: security, system, balances,
    transactions, investments, securities prices, budgets, bills, goals.

R2. A **matrix** of group x channel decides delivery. Channels: in-app (bell),
    email, web push, UnifiedPush/ntfy (Section 15).

R3. A notification may be delivered **once** or **repeatedly** on an interval.
    The interval is user-defined, with a **minimum of 5 minutes**.

R4. A repeating notification must be **stoppable** from the phone (the app UI)
    **and** from the notification itself (a Stop action on the push).

R5. For securities-price notifications, include a **chart** in the push if the
    platform supports it.

R6. **Clicking a notification opens the page that contains exactly that
    information** (a precise deep link, not a generic landing page).

R7. **Grouping / throttling rules** are configurable: e.g. if a notification
    from the same group fired in the last 15 minutes, do not notify again.

R8. (maintainer, #1291) history expires automatically [done: `purgeOld`];
    security notifications are opt-in; balance thresholds are user-configurable;
    per-device push toggles; localisation follows the user's language.

Non-goals (explicitly deferred by the maintainer): restored/cloned-environment
safety for subscriptions; a Firebase/APNs path. UnifiedPush was scaffolded as a
"coming soon" column in the first cut; the maintainer has since asked for the
**full transport**, now specified in **Section 15** (encrypted Web Push to a
UnifiedPush distributor endpoint, `WebPushSender` reused).

---

## 2. Vocabulary

- **Group** -- a stable key naming a family of notifications
  (`security`, `system`, `budgets`, `bills`, `balances`, `transactions`,
  `investments`, `prices`, `goals`). Derived from a notification's `type`, never
  stored on the row (same rule as `notificationCategoryOf`; the group is a
  function of the type, so renaming a group cannot orphan history).
- **Channel** -- a delivery transport: `in_app`, `email`, `push`,
  `unifiedpush`. `in_app` is the source of truth (the row in `notifications`);
  the others are fan-outs.
- **Preference** -- a per-user, per-group record carrying the channel matrix
  (four booleans) plus the group's throttling window and repeat policy.
- **Reminder** -- an active, repeating re-delivery of one notification (or one
  group condition) on an interval until stopped. Distinct from a *schedule*
  (bills) which is about when a transaction posts.

---

## 3. The group x channel matrix (R1, R2)

One row per (user, group). Columns: `in_app`, `email`, `push`, `unifiedpush`
(booleans), plus `throttle_minutes` and the repeat policy (Section 5). Absent
row -> defaults below. The matrix is resolved once, server-side, by
`resolveNotificationPreference(userId, group)`; every producer and every
fan-out consults it, so a user's choice cannot hold on one path and not another
(the same "one write door" discipline the notifications table already has).

Proposed default matrix (a preference-less user):

| Group        | in_app | email | push | unifiedpush | throttle |
|--------------|:------:|:-----:|:----:|:-----------:|:--------:|
| security     |   on   |  on   | off  |     off     |   0 min  |
| system       |   on   |  on   | off  |     off     |  15 min  |
| budgets      |   on   |  off  | off  |     off     |  60 min  |
| bills        |   on   |  off  | off  |     off     |   0 min  |
| balances     |   on   |  off  | off  |     off     |  60 min  |
| transactions |   on   |  off  | off  |     off     |  15 min  |
| investments  |   on   |  off  | off  |     off     |   0 min  |
| prices       |   on   |  off  | off  |     off     |   5 min  |
| goals        |   on   |  off  | off  |     off     |   0 min  |
| bank_sync    |   on   |  on   |  on  |     off     |   0 min  |
| bank_sync_activity | on |  off  | off  |     off     |   0 min  |

The two bank sync groups (`docs/specs/bank-sync-notifications.md`, proposed)
are the first with their own defaults: `NOTIFICATION_CATEGORY_DEFAULTS`, read
only where no matrix row is stored, keeps every older group on the global
defaults and gives `bank_sync` immediate email and push, because a consent
about to end or a failed sync needs the user's action. A preference-less
user's first matrix write starts from these defaults. Push still needs a
device enabled first.

Rationale: in-app is always the record (a user opts a group *out* of the bell
deliberately, which is allowed but off the default path). email defaults on only
where the message is important and infrequent (security, system). push defaults
off because it requires per-device enablement first (a matrix cell cannot turn a
device on). `unifiedpush` defaults off for the same reason -- a cell cannot
register a distributor endpoint -- and ships live with its transport (Section 15).

**in_app is always on; it is the record.** The maintainer's ruling is that the
bell shows *all* unread notifications, so `in_app` is not a user-toggled column
in the first cut -- the notifications table stays the source of truth and the
throttle below never suppresses an in-app row. The columns the user toggles are
`email`, `push`, `unifiedpush`.

The first cut also *rendered* an in-app column, locked on, so the grid read as a
complete matrix. That column has since been removed: a sixth of a phone's width
spent on a column of permanent ticks is width the four real controls needed, and
"the bell always shows every notification" is one sentence above the grid rather
than a control that cannot be operated. Nothing about the model changed -- the
in-app row is still always written -- and if the "mute a whole group's bell
entries" decision is later taken, `in_app=off` means the row is not written and
the column comes back with something to toggle. There is no hidden state either
way.

**Groups vs. what exists today.** The nine groups above are the *target*. Today
only three of them have producers, and the code already names them:
`notificationCategoryOf(type)` derives `PAYMENTS` (bills), `BUDGETS` (the nine
budget types) and `SYSTEM` (the seven system types). The other groups
(`balances`, `transactions`, `investments`, `prices`, `goals`, `security`) have
**no producers yet** -- each is its own follow-on feature (the maintainer has
asked for balance thresholds; price alerts and the rest follow). So the matrix
ships for the three live categories first and each new group arrives *with its
producer*, never as a dead row. The preference key is the derived category, so
adding a group is one `NotificationCategory` member plus its producer.

Security is opt-in per the maintainer; there is no security *category* yet (no
login/2FA notification types exist), so it enters with those producers.

**A cell is a control only where a producer reads it.** Not every category
exposes every channel. `NOTIFICATION_CATEGORY_CHANNELS` (backend) maps each
matrix category to which of `email` (report), `email_notification` and `push`
are live controls, and the API returns that per row as `supportedChannels` so
the grid is server-authoritative. PAYMENTS and BUDGETS expose all three;
**SYSTEM exposes push only** -- its email is the admin fan-out's own
severity-driven, SQL-gated path (Section 8), not a user toggle -- and **its row
is listed and writable for administrators only** (`configurableCategoriesFor`,
keyed on the JWT role): every SYSTEM type is raised through `raiseAdminAlert`, so
for anyone else the row would be a control over nothing, and a non-admin's
matrix has two rows. An unsupported
cell renders "not applicable" and `resolveNotificationDelivery` forces its
resolved delivery off whatever the stored row says, so a value written to an
unsupported cell can never become a delivery nobody asked for. The map is
mirrored on the client (`frontend/src/lib/notification-preferences.ts`) and held
equal by `notification-preferences.contract.test.ts`.

---

## 4. Two email modes, and what the throttle gates (R7)

**Resolved (maintainer, replacing the earlier contradictory draft).** The first
throttle attempt made the write door *drop the row* when throttled, which
contradicted Section 3's ruling that the in-app row is always written -- so a
throttled notification vanished from the bell. That attempt was reverted. The
model below is the reconciliation.

Email is delivered in **two modes**, and the matrix carries a column for each:

- **`email_report` -- report mode (the batch/digest, exactly as today).** The
  weekly budget digest, the monthly summary, the daily bill reminder, and
  `budget-alert`'s batched immediate-critical email are all reports: several
  events summarised into one message on a schedule (or one per cron run).
  Reports are **never throttled** -- a report *is* the batching -- and they are
  gated only by their `email_report` column (plus their own digest toggles).
  This is the channel `resolveEmail(category)` gates today; the Phase 1 matrix
  column is renamed to make that honest.
- **`email_notification` -- notification mode (immediate, one message per
  notification).** This is the channel the throttle governs. It does **not
  exist as a delivery path yet**: it lands with the push dispatch (Section 5 /
  Phase 5), because push is the other notification-mode fan-out and the two
  share the same gate. Until then the column is **stored but rendered
  "coming soon"** (the UnifiedPush pattern in Section 1), so no migration is
  needed later.

**The throttle gates the notification-mode fan-out, never the in-app row and
never a report.** In-app is always written (Section 3). When a
notification-mode delivery (immediate email or push) is about to go out for
group G and user U, it is suppressed if a **non-dismissed** notification of G
was created within the last `throttle_minutes` -- except a strictly
*higher-severity escalation*, which always goes (silence on an escalation is the
dangerous direction). The in-app row for the suppressed one still exists in the
bell; only the interrupting fan-out is skipped. `throttle_minutes = 0` disables
the window for that group.

This is a **rate limit on the interrupting channels**, layered on top of the
exact-duplicate dedupe (the fingerprint / dedupe-key unique index): dedupe stops
the identical row, the throttle stops a *different* same-group interruption too
soon. `throttle_minutes` is stored now (inert), and its enforcement -- a windowed
check at the notification-mode fan-out, its concurrency mechanism, and how it
reads across `budget-alert`'s batching -- is specified and built in Phase 5 with
the push dispatch, not in the write door's row creation.

---

## 5. Repeat / one-time re-delivery (R3, R4)

Most notifications are one-shot. A user may additionally ask that a *group* (or a
specific still-unread notification) be **re-delivered on an interval** until they
act -- a nag for a due bill, a breached balance threshold, a price target.

Model: a `notification_reminders` record: `{ user_id, group_key,
source_notification_id?, interval_minutes, next_fire_at, created_at,
stopped_at }`. `interval_minutes >= REMINDER_MIN_INTERVAL_MINUTES = 5` (a
constant, enforced by the DTO `@Min(5)` and re-checked server-side; a stored
value below it is clamped up, never down). `repeat_mode` on the preference is
`off | once | repeat`:

- `off` -- normal one-shot delivery (default for every group).
- `once` -- deliver, then a single follow-up after `interval_minutes`, then stop.
- `repeat` -- deliver every `interval_minutes` until stopped.

Firing: a cron (`@Cron` every minute, min interval 5 so a one-minute tick is
cheap and precise) claims due reminders per user (`withUserContext`), re-emits
through the **same write door** (so throttle/matrix still apply -- a repeat is
still subject to the channel matrix), advances `next_fire_at`, and for `once`
sets `stopped_at`. Claiming uses the existing per-user job-lease mechanism so a
second replica does not double-fire (`docs/cron-jobs.md`).

Stopping (R4), three doors, all landing on the same `stopReminder(userId, id)`:

1. **From the app** -- a Stop control on the notification row / group settings.
2. **From the push notification** -- the push carries
   `actions: [{ action: 'stop-reminder', title: 'Stop' }]` and a
   `reminderId` in its (encrypted) data. The service worker's
   `notificationclick` handler, on `event.action === 'stop-reminder'`, issues a
   same-origin `fetch('/api/v1/notifications/reminders/<id>/stop', {method:'POST',
   credentials:'include'})` (cookies ride same-origin, and the CSRF double-submit
   cookie is readable in the SW to set the header). A failure is retried once and
   otherwise surfaced as a follow-up notification "could not stop -- open Monize"
   rather than silently leaving the nag running.
3. **From opening the notification** -- clicking the body (not the Stop action)
   deep-links to the subject (R6) and marks read; a read notification whose
   `repeat_mode = once` is considered acted-on and its reminder is stopped.

Safety: a reminder is stopped when its `source_notification_id` is dismissed or
the underlying condition clears (the bill posts, the balance recovers), so a nag
cannot outlive its cause. The one mechanism is the firing cron's sweep over
dismissed and orphaned sources (Section 13.3, door 3): a producer that clears a
condition dismisses the source notification through `NotificationService.dismiss`
and the sweep stops the reminder on its next minute. There is deliberately no
second stop door for producers -- a second door is a second rule.

`notification_reminders` is user-owned and RLS-scoped like every other table.

---

## 6. Deep linking (R6)

Every notification already carries `target` (a route). The rule this spec adds:
**`target` names the most specific page that shows the notification's own
subject**, not a section landing page. Examples:

- a bill reminder -> the scheduled transaction / bills view focused on that bill;
- a balance-threshold alert -> `/accounts/<accountId>`;
- a price alert -> `/securities/<securityId>`;
- a budget alert -> the budget's detail;
- a backup failure -> the backup settings section;
- a security alert -> the security settings / sessions page.

The service worker's `notificationclick` focuses an existing client on `target`
if one is open (posting it a navigate message) and otherwise opens a new window
at `target`. A guard test asserts every producer sets a `target` and that the
target resolves to a real route prefix (a scan over the route table).

`target` is a path only (never an absolute URL), resolved against the app origin
in the SW -- the "a target is a path, not a URL" rule mirrors the push-endpoint
SSRF discipline in reverse.

---

## 7. Chart-in-push feasibility (R5)

Findings (to be re-verified against the shipping browsers):

- The Web Notifications `image` field (the "big picture") is supported on
  **Android Chrome/Edge** and some desktop Chromium; it is **not** rendered on
  iOS/Safari web push, and Firefox support is partial. So a chart-in-push is a
  progressive enhancement, never the only carrier of the information.
- The push *payload* is capped (~4KB after encryption), so the chart is **not**
  inlined as a data: URI. Instead the payload carries a **path** to a
  server-rendered PNG, and the browser (not our page) fetches it when it expands
  the notification -- so the app CSP does not apply, but the URL must be
  unguessable and short-lived because the fetch is unauthenticated.
- Therefore: `prices` notifications may set `payload.image = '/api/v1/push/
  chart/<token>.png'`, where `<token>` is a single-use, short-TTL, HMAC-signed
  reference to a pre-rendered chart the backend holds (no user input in the path;
  CWE-22 validated). The renderer produces a small sparkline of the security's
  recent closes. The SW passes only the validated same-origin chart path to `showNotification`.
- Fallback: where `image` is unsupported, the shipping implementation retains
  generic localized Investments text for lock-screen privacy (Section 14.6).
  The deep link (R6) opens the instrument on `/securities/<id>`. The original
  proposal to put the price move in every push body is not enabled by this
  image-only opt-in; numerical details remain in the bell and immediate email.

This is the highest-risk, lowest-portability requirement; it ships last (Phase 5)
and behind a per-group toggle, defaulting off until validated on real devices.

---

## 8. Current system (as-is)

- **One table, one write door.** `notifications` (renamed from `budget_alerts`
  by migration 179). `NotificationService.create(userId, input)` is the sole
  writer (`notification-write-door.spec.ts` enforces it): a raw
  `INSERT ... ON CONFLICT DO NOTHING RETURNING id` (no conflict target, so it
  covers both the budget fingerprint index and the `dedupe_key` index), then a
  read-back inside the same `withScopedDb` transaction. `null` means another
  replica holds the row -- "not yours to email about".
- **Category is derived, never stored.** `notificationCategoryOf(type)`:
  `BILL_DUE -> PAYMENTS`; the seven `SYSTEM_NOTIFICATION_TYPES -> SYSTEM`; the
  nine budget types `-> BUDGETS`. `NotificationCategory` = `{PAYMENTS, BUDGETS,
  SYSTEM}`, with the entity comment already naming Investments/Goals/Imports as
  future members. **This is the group axis this spec builds on.**
- **17 `alert_type` values** (`NotificationType`): 9 budget, 1 payment
  (`BILL_DUE`), 7 system (`BACKUP_FAILED`, `BACKUP_PARTIAL`,
  `ENCRYPTION_KEY_MISSING`, `PROVIDER_OUTAGE`, `PROVIDER_RECOVERED`,
  `SMTP_FAILURE`, `SCHEDULED_POST_FAILED`).
- **Email is per-producer, gated through `NotificationPreferenceService.resolveEmail(userId, category)`** (which reads the per-category row AND the
  `user_preferences.notification_email` master switch). Producers:
  `budget-alert.service.ts` (immediate + weekly digest, BUDGETS),
  `budget-period-cron.service.ts` (monthly summary, BUDGETS -- shares
  `budget_digest_enabled` with the weekly digest),
  `bill-reminder.service.ts` (daily digest, PAYMENTS, email-only, no in-app row),
  `accounts/mortgage-reminder.service.ts` (renewal reminder, PAYMENTS,
  email-only). `system-alert.service.ts` is the one email sender that is NOT
  category-gated: its EMAIL is a severity-driven admin fan-out gated by
  `queryAdminRecipients.emailEnabled` in SQL, never by the matrix. Its rows do
  fan out through the dispatch seam, so SYSTEM is a matrix category that exposes
  **push only** (`NOTIFICATION_CATEGORY_CHANNELS`): an admin who turns SYSTEM
  push on receives the alert on their device, while the two email columns render
  "not applicable" and `resolveNotificationDelivery` forces them off. Locale for any
  off-request copy resolves through `emailTranslator(i18n, lang)` +
  `resolveUserEmailLocale`. `notification-email-gate.guard.spec.ts` is the
  source scan that keeps every category producer on the resolver and pins each
  one's category -- the earlier omission of the monthly summary and the mortgage
  reminder from this inventory is exactly what it now prevents (audit Finding 1).
- **Push was built but unwired at survey time.** `WebPushSender.send` was called
  only by `PushSubscriptionService.sendTest` (the `POST /push/test` button); there
  was no `sendToUser`, and nothing bridged `NotificationService.create -> push`.
  (Superseded: Phase 5 added `sendToUser` and the dispatch seam, Section 14; the
  UnifiedPush wire rides the same sender, Section 15.)
  `PushPayload.collapseKey` is required and privacy-minimal (no amounts). The
  service worker's `push`/`notificationclick` handlers exist; `collapseTag` does
  device-side collapse; **no `actions` and no `image` are used yet**.
- **Existing prefs:** `notification_email` (enforced), `notification_browser`
  (dormant at survey time; removed by migration 188, superseded by the
  per-category `push` setting), `budget_digest_enabled` /
  `budget_digest_day`. No per-category, per-channel, quiet-hours or throttle
  preference exists. Settings UI: `NotificationsSection.tsx` (email toggle +
  digest + test-email, then the push panels).
- **Deep-link mechanism exists:** `target` (same-origin path, <=255), validated
  three times (`boundedTarget` at the door, `safeNotificationTarget` in the app,
  `safeNotificationPath` in the worker). `notification-target.contract.test.ts`
  asserts every producer's literal target resolves to a real App Router page.
  `/bills` is used for bills (there is no per-bill route yet).

## 9. Data model and migration

**Phase 1 table (migration 180)** -- `notification_preferences`, user-owned:

```sql
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id    uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category   varchar(20) NOT NULL,     -- NotificationCategory member
    email      boolean NOT NULL DEFAULT true,
    PRIMARY KEY (user_id, category)
);
-- RLS: policy notification_preferences_isolation on user_id + ENABLE (Section 6
-- pattern from migrations 178/179). Classify in support-backup-rules.ts.
```

Only the columns Phase 1 consumes exist (`email`). Later phases add columns in
their own migrations as they wire a channel: `push` + `unifiedpush` +
`throttle_minutes` with Phase 4's push dispatch; the repeat policy lands on a
separate `notification_reminders` table (Section 5) in Phase 4/5. This keeps the
"no column without a consumer" discipline rather than a wide, half-dead table.

`schema.sql` updated in the same commit; migration idempotent
(`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`);
replays as a no-op on a fresh `schema.sql` (`scripts/verify-schema.sh`). No new
SQL function, so `required-db-functions.ts` is untouched. New table must be
exported by the backup or listed excluded -- it is user data, so **exported**
(add to `export-table-queries.ts`, `restore-plan.ts` after `users`, and classify
in the support backup).

Default resolution: absent row -> `email` defaults from the *legacy*
`notification_email` (so an existing user who turned all email off keeps it off
until they touch the new matrix), then from the Section 3 table per category.
`resolveNotificationEmailPreference(userId, category)` is the one reader.

## 10. Integration plan (per file)

Phase 1 (this slice):

- `backend/src/notification-center/entities/notification-preference.entity.ts`
  (new) -- `NotificationPreference`.
- `backend/src/notification-center/notification-preference.service.ts` (new) --
  `resolve(userId)` (all categories, filling defaults), `resolveEmail(userId,
  category)`, `setEmail(userId, category, enabled)`. All through `withScopedDb`.
- `backend/src/notification-center/notification-preference.controller.ts` (new)
  -- `GET /notifications/preferences`, `PUT /notifications/preferences/:category`
  (JWT, `ParseEnumPipe` on category, DTO `{email: boolean}`).
- Wire every category email producer to `resolveEmail(userId, category)` instead
  of the bare `notification_email` read -- `bill-reminder` and
  `mortgage-reminder` (PAYMENTS), `budget-alert` immediate + weekly digest and
  `budget-period-cron` monthly summary (BUDGETS); keep `notification_email` as
  the default seed and the global master switch (email off globally still wins --
  the per-category matrix narrows, never widens, an off master).
  `system-alert` (SYSTEM) keeps its SQL recipient gate for EMAIL; its rows fan
  out through the dispatch seam so SYSTEM push is a live per-admin control
  (SYSTEM exposes push only).
  `notification-email-gate.guard.spec.ts` enforces both halves: no email sender
  gates on the bare master switch, and each category producer names its category.
- `frontend/src/components/settings/NotificationPreferencesMatrix.tsx` (new) --
  the category x channel grid (email toggle per category), mounted in
  `NotificationsSection.tsx` in place of the single email toggle. One DOM at
  every width: below `md` each category is a card of labelled control rows, from
  `md` up the row wrapper becomes `contents` and its cells fall into the grid.
  `md` rather than `sm` because `InfoTooltip` was then desktop-only, so the
  per-column help had to be inline prose wherever the tooltip was not rendered
  (it has since gained a tap trigger; the layout stands on its own merits).
- `frontend/src/lib/notification-preferences.ts` (new) -- api client + the
  category list + default table mirrored from the backend (contract test).
- i18n: `settings.notifications.preferences.*` (category labels, channel
  headers, help), English-first + every locale.

Later phases: Section 4 (throttle) adds `throttle_minutes` + the dispatch check;
Section 6 (deep-link) sharpens targets and adds routes; Section 5 (push +
reminders) builds `sendToUser`, the `push` column, SW `actions`/`image`, and
`notification_reminders` + its cron + stop endpoint.

## 11. Test matrix

Phase 1 (all offline-runnable -- unit + source-scan; the DB-backed integration
spec is written but noted as un-run here, no PostgreSQL in this environment):

- Resolver: absent row -> per-category default; legacy `notification_email=false`
  -> email default off for every category; explicit row wins; unknown category
  rejected.
- Master switch: `notification_email=false` globally suppresses email even where
  a category row says on (narrows, never widens).
- Write door unchanged: `create` still writes the in-app row regardless of the
  email matrix (bell shows all) -- a regression test that a category with email
  off still produces a bell row.
- Each category email producer: email sent iff `resolveEmail` true; the in-app
  row (where the producer writes one) is created either way. The per-category
  gate has its own regression per producer (a BUDGETS/PAYMENTS off with the
  master on suppresses that email), and `notification-email-gate.guard.spec.ts`
  scans the tree so a fifth producer cannot ship gating on the bare master
  switch or naming the wrong category.
- Contract: frontend category list + defaults equal the backend
  (`notification-preferences.contract.test.ts`), like the existing
  `notification.contract.test.ts`.
- UI: the matrix renders one row per live category, toggling email calls the
  api and updates optimistic state; email column disabled when SMTP is
  unconfigured (mirrors the existing gate).
- i18n parity across every locale; pseudo fresh.
- Backup: `notification_preferences` is exported and restored (golden
  support-backup classification test).

---

## 12. Open decisions (resolved with defaults, since the design proceeds autonomously)

D1. **Preference storage**: a dedicated `notification_preferences` table
    (one row per user+group) rather than a JSONB blob on `user_preferences`,
    because the throttle window and repeat policy are queried by the cron and
    benefit from being columns. Chosen: dedicated table.

D2. **in_app off = not written**: chosen (Section 3), because a "written but
    hidden" state is a second source of truth for unread counts.

D3. **Throttle default 15 min** only for system/transactions; event-per-subject
    groups (bills, investments, prices low, goals) default to 0 or 5. Chosen as
    tabulated; every value is a default a user can change.

D4. **Reminder minimum 5 min**: chosen constant `REMINDER_MIN_INTERVAL_MINUTES`,
    enforced both in the DTO and server-side (clamp up).

D5. **Chart-in-push**: progressive enhancement, Android-only, ships last, default
    off. Chosen.

D6. **Security opt-in**: default on for in_app+email but fully user-toggleable.
    Chosen (matches maintainer "optional, not mandatory").

Every default above is a **reviewable decision, not a fact about the domain** --
a human (the maintainer) confirms the matrix defaults and the throttle windows
before this ships to users, per the org rule that AI output is auxiliary.

---

## 13. Phase 4 implementation -- repeating / one-time reminders (R3, R4)

This refines Section 5 into the shipping design. Phase 4 delivers reminders
end to end on the **in-app** channel (always written, Section 3) with an
explicit Stop from the app; the push carrier for R4's "Stop from the
notification" and the interrupting email/push fan-out are Phase 5, and the design
below is built so Phase 4 needs no rework when they land.

### 13.1 Data model (migration 182)

`notification_reminders`, user-owned, one row per active reminder a user asked
for. It carries the **template** the fire re-emits, so a fire never has to reload
the (possibly dismissed) source notification:

```sql
CREATE TABLE IF NOT EXISTS notification_reminders (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The notification whose subject this nags about. SET NULL (not CASCADE):
    -- the reminder is stopped when the source is dismissed, and losing the link
    -- must not silently delete the reminder mid-fire.
    source_notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
    -- The template the fire re-emits, mirroring a notification's public fields.
    alert_type             VARCHAR(30) NOT NULL,   -- NotificationType to re-emit
    severity               VARCHAR(20) NOT NULL,   -- NotificationSeverity
    title                  VARCHAR(255) NOT NULL,
    message                TEXT NOT NULL,
    data                   JSONB NOT NULL DEFAULT '{}',
    target                 VARCHAR(255),
    -- Base for the per-fire dedupe key; each fire appends the fire ordinal so
    -- every re-emit is a fresh bell row (Section 13.3).
    dedupe_base            VARCHAR(80),
    repeat_mode            VARCHAR(10) NOT NULL,   -- 'once' | 'repeat'
    interval_minutes       INTEGER NOT NULL,       -- >= REMINDER_MIN_INTERVAL_MINUTES
    next_fire_at           TIMESTAMP NOT NULL,
    last_fired_at          TIMESTAMP,
    fire_count             INTEGER NOT NULL DEFAULT 0,
    stopped_at             TIMESTAMP,
    created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- The cron scans due, non-stopped rows across all users each minute.
CREATE INDEX IF NOT EXISTS idx_notification_reminders_due
    ON notification_reminders (next_fire_at) WHERE stopped_at IS NULL;
-- RLS: uniform direct policy on user_id + ENABLE (numbered after 123); the
-- GUC-aware updated_at trigger, like every table carrying the column.
```

`repeat_mode` is the row's own mode and is only ever `once` or `repeat` -- the
preference-level `off` from Section 5 means *no reminder row exists*, so it is
not a stored value here. `notification_reminders` is exported by backups (user
data): `export-table-queries.ts`, `restore-plan.ts` after `notifications` (the
`source_notification_id` FK), and classified in the support backup.

### 13.2 The firing cron -- one atomic claim, no advisory lock

`@Cron` every minute (the interval floor is 5, so a one-minute tick is cheap and
precise). Every replica runs it, so the claim must be idempotent across replicas
**without** an advisory lock -- a single conditional `UPDATE ... RETURNING`
(bounded to the configured claim batch per tick through a `FOR UPDATE SKIP LOCKED` CTE,
so a replica's tick takes rows another replica is not already holding, and the
rest go next minute; re-emits run at the configured concurrency behind an
in-process overlap guard) is
the mechanism (`docs/concurrency-and-idempotency.md`, "atomic delta / CAS"):

```sql
UPDATE notification_reminders
   SET next_fire_at = CURRENT_TIMESTAMP + (interval_minutes * INTERVAL '1 minute'),
       last_fired_at = CURRENT_TIMESTAMP,
       fire_count    = fire_count + 1
 WHERE stopped_at IS NULL AND next_fire_at <= CURRENT_TIMESTAMP
 RETURNING id, user_id, alert_type, severity, title, message, data, target,
           dedupe_base, repeat_mode, fire_count;
```

The claim advances `next_fire_at` in the **same statement** that reads the row,
so a second replica's `UPDATE` blocks on the row lock, re-evaluates the `WHERE`
against the committed new value (now future), and skips it: each due row is
claimed exactly once. It runs under `withSystemContext` (a cross-user sweep);
each claimed row is then re-emitted under `withUserContext(row.userId)`. **Order
matters and is deliberate:** the claim commits *before* the re-emit, so a re-emit
that fails skips this occurrence and re-fires one interval later rather than
risking a double-fire -- the safe direction for a notification. `next_fire_at` is
set to `now + interval` rather than `previous + interval` so a cron that missed
several ticks fires once and reschedules, never a catch-up burst.

**A `once` reminder is NOT consumed by the claim.** Setting `stopped_at` here
would commit before the delivery, so a failed re-emit would lose the single
follow-up with no retry (a `once` reminder claimed and then unable to write its
notification). Instead the claim only advances the schedule, and the `once` stop
runs **inside the same transaction that writes the notification** (Section 13.3):
`NotificationService.create`'s nested `withScopedDb` joins the re-emit's, so the
INSERT and the `UPDATE ... SET stopped_at ... WHERE id = $1 AND stopped_at IS
NULL` commit together. A failure rolls back both, leaving the reminder claimable
next interval -- it delivers exactly once, never zero and never twice.

### Reminder cron capacity

The every-minute cron claims at most `NOTIFICATION_REMINDER_CLAIM_BATCH` due
rows per replica (default 100, accepted range 1..10000), and re-emits at most
`NOTIFICATION_REMINDER_REEMIT_CONCURRENCY` concurrently per replica (default 5,
range 1..100). Both environment settings are read at backend startup; missing
values use the defaults, and invalid or out-of-range values log a warning and
fall back. Set them in the backend container's environment and restart it. Docker Compose
dev/prod forward them from `.env`; Helm deployments can use `backend.extraEnv`.

The `LIMIT` and `FOR UPDATE SKIP LOCKED` claim keep each tick bounded and divide
work between replicas. Increasing the limits raises database and transport load;
it does not remove the backlog policy. Rows beyond the claim limit stay due for
later ticks. A tick still in flight suppresses another tick on that replica.

### 13.3 What a fire re-emits (through the dispatch seam)

Each fire calls `NotificationDispatchService.notify` (Section 14), which writes
through the one write door (Section 8, unchanged) and then fans out per the
matrix and throttle, with:

- `type`, `severity`, `title`, `message`, `data`, `target` from the row;
- `data.reminderId = row.id` merged in, so the bell row carries a Stop control
  and the push (Phase 5) can carry the `reminderId` its Stop action needs;
- `dedupeKey = "${dedupe_base ?? alert_type}:rem:${id}:${fireCount}"` (bounded to
  120) -- the fire ordinal makes **every re-emit a distinct row**, so the bell
  shows a fresh unread nag each interval rather than `ON CONFLICT DO NOTHING`
  swallowing it against the still-live previous one. A re-emit carries no
  `budgetId`/`budgetCategoryId`: it uses the `dedupe_key` index, never the budget
  fingerprint index, so it cannot collide with the source's fingerprint.

A repeat nag therefore interrupts by push and immediate email subject to the
matrix, and the push carries `reminderId` plus the Stop action (Section 13.4).
It sits **outside the category cooldown on both sides**: the cooldown governs
producers' interruptions, and a reminder is the user's own schedule (an interval
they chose, five minutes or more) -- held by the cooldown, a 15-minute reminder
under a 30-minute cooldown would never push, its source or its own previous nag
always a prior in the window, a control that changes nothing; counted as a
prior, it would silence the category's other interruptions. So `notify` takes
no lock and no decision for a row carrying `data.reminderId`, and
`priorInWindow` ignores such rows. The cron lives in `notifications/notification-reminder-cron.service.ts`,
beside the dispatch, because `NotificationCenterModule` is a leaf that cannot
import the delivery side. Two same-transaction follow-ups ride `notify`'s
`onWritten` hook: the previous nag of the same reminder is **dismissed** (one live
nag per reminder -- a month of un-opened five-minute repeats is not a month of
unread rows crowding the bell, and the purge retires the dismissed ones), and a
`once` reminder is stopped in the transaction that writes its follow-up.

### 13.4 Stopping (R4)

All three doors land on `stopReminder(userId, id)` (idempotent: stopping a
stopped reminder is a no-op, not a 404-after-the-fact):

1. **From the app** -- `POST /notifications/reminders/:id/stop` (JWT), and a Stop
   control on any bell row carrying `data.reminderId`. The bell links to
   `/reminders`, a standalone owner-only list of active reminders. Each row shows
   its localized subject, interval, next occurrence and a Stop control. The
   list reads structured template facts from the owner-scoped reminder endpoint
   and uses the same copy composer as the bell, with the existing legacy text
   fallback. Delegates must switch back to their own account to manage it.
2. **From the push notification** -- a re-emitted nag's payload carries
   `reminderId` and `actions: [{ action: "stop-reminder", title }]` (the title
   rendered on the server in the recipient's locale, `push.actions.stopReminder`),
   and the SW renders the action and keeps the id in `data`. The stop rides the
   session cookie, which outlives the app by fifteen minutes at most, so a 401 is
   answered by one same-origin `POST /auth/refresh` (the refresh cookie is
   same-origin, path `/`) and a single retry; a stop that still fails opens the
   active reminders page at `/reminders`, where each active reminder has a Stop
   control. The SW `notificationclick`
   handler, on `event.action === "stop-reminder"`, `fetch`es that same endpoint
   same-origin with the CSRF header. It reads Cookie Store where available;
   otherwise it calls authenticated `GET /auth/csrf-refresh`, which returns the
   same session-bound token in its cookie and a non-cacheable JSON response.
   A token retrieval failure never sends an unprotected Stop request. A 401 at
   token retrieval or Stop triggers at most one session refresh and retry,
   acquiring a fresh CSRF token because refresh rotates the cookie. JWT,
   ownership and double-submit CSRF checks on Stop remain required. Failure
   opens `/reminders` so the user can finish stopping it there. This removes
   the Cookie Store dependency for browsers that deliver the Stop action;
   native action availability and delivery still require browser validation.
3. **Source gone / condition cleared** -- the firing cron's sweep stops any
   reminder whose source was **dismissed** *or* **deleted**. The source FK is
   `ON DELETE SET NULL`, so a source that is read-but-never-dismissed and then
   purged after `RETENTION_DAYS` leaves the reminder orphaned
   (`source_notification_id` NULL); the sweep stops orphaned reminders too, so a
   nag cannot outlive its cause even when the cause is deleted rather than
   dismissed. A producer that clears an underlying condition (the bill posts,
   the balance recovers) dismisses the source notification and lets the sweep do
   the stopping; no such producer exists yet. A dedicated stop-by-source door for
   producers shipped without a caller and was removed in review rather than kept
   as a promise nothing tested end to end.

**One active reminder per source, and a per-user cap.** A second "remind me" on
the same notification re-configures the one active reminder rather than adding a
parallel nag -- enforced by the partial unique index
`idx_notification_reminders_active_source (user_id, source_notification_id)
WHERE stopped_at IS NULL AND source_notification_id IS NOT NULL`, with a
concurrent double-submit recovered by re-reading the winner's row. A genuinely
new reminder counts against `MAX_ACTIVE_REMINDERS_PER_USER` (50), because the
every-minute cron scans and fires O(active reminders per user) -- an uncapped
count is the same resource lever an unbounded device list or request array is
(INV-REMINDER-006).

### 13.5 Invariants

- **INV-REMINDER-001** a reminder fires at most once per interval per replica-set
  (the atomic claim), and a missed tick does not burst.
- **INV-REMINDER-002** `interval_minutes >= REMINDER_MIN_INTERVAL_MINUTES` (= 5),
  enforced by the DTO `@Min(5)` and clamped up server-side; a stored value below
  it is never fired below the floor.
- **INV-REMINDER-003** a stopped reminder (`stopped_at` set) never fires again;
  stopping is idempotent and ownership is in the `WHERE`.
- **INV-REMINDER-004** a reminder is stopped when its source notification is
  dismissed, so it cannot outlive its cause.
- **INV-REMINDER-005** each fire is a distinct in-app row (the fire-ordinal
  dedupe key); the in-app row is always written, matching Section 3.
- **INV-REMINDER-006** at most one active reminder exists per (user, source)
  (partial unique index), and a user holds at most
  `MAX_ACTIVE_REMINDERS_PER_USER` active reminders (the every-minute cron's work
  is O(active reminders), so the count is bounded like every other
  user-controlled resource).

### 13.6 Test matrix (all offline-runnable -- unit + source-scan)

- Claim: two concurrent `fireDue` calls fire each due row once (asserted via the
  atomic UPDATE's `RETURNING` set, mocked to a single-claim contract).
- Clamp: `interval_minutes` below 5 rejected by the DTO and clamped by the
  service; a stored 2 is fired as 5, never as 2.
- `once` fires exactly once then sets `stopped_at`; `repeat` reschedules.
- Stop: idempotent, ownership-scoped, and a stopped reminder is skipped by the
  next claim.
- Source dismissed -> the cron's sweep stops the reminder; re-emit after stop
  writes nothing.
- Re-emit: fire N writes a fresh bell row (distinct dedupe key), never collides
  with the source, and merges `data.reminderId`.
- RLS smoke: the cron claim runs under system context, each re-emit under the
  affected user's context; request-path methods under the caller's.
- Backup: `notification_reminders` exported and restored (FK ordering after
  `notifications`), classified in the support backup.
- i18n parity for the new UI strings; pseudo fresh.

Every window and default here remains a **reviewable decision** the maintainer
confirms before shipping, per the org rule that AI output is auxiliary.

---

## 14. Phase 5 design -- push dispatch, notification email, throttle, chart (R2, R5, R7)

This section is the **design for the largest and highest-risk slice**, and it is
written for the maintainer to confirm *before* implementation, because it (a)
wires a fan-out onto the `NotificationService.create` path -- the write door a
throttle attempt was already reverted from once (Section 4) -- and (b) changes
the module graph and every producer that opts into fan-out. Nothing in this
section is built yet; Phase 4 shipped without needing any of it.

### 14.1 The dispatch seam -- where a fan-out attaches without a cycle

The project has **no event emitter** (`@nestjs/event-emitter` is not a
dependency), so the seam is an explicit service, not a listener. A
`NotificationDispatchService` exposes:

```
notify(userId, input): Promise<Notification | null>
```

which calls `NotificationService.create(userId, input)` and, **only when a row
was written** (`!= null` -- the ON CONFLICT winner), performs the fan-out:
notification-mode email and push, each gated by the matrix and the throttle
(14.3, 14.4). `create` stays the **sole writer** (the write-door guard is
untouched); `notify` is a layer *above* it, so the in-app row is still always
written and the fan-out never gates it (Section 3 preserved).

**Module placement (the no-cycle proof).** `NotificationDispatchService` lives in
`NotificationsModule` (`src/notifications/`), which already imports
`NotificationCenterModule` (leaf) and holds `EmailService`. It additionally
imports `PushModule` (also a leaf: it depends only on `EncryptionModule`,
`DataSource`, `I18nService`). Two leaves plus the local `EmailService` means
**no `forwardRef` and no cycle** -- `src/module-graph.spec.ts` is the proof
obligation. `NotificationDispatchService` injects `NotificationService`,
`NotificationPreferenceService`, `EmailService`, and the push fan-out (14.2), and
`NotificationsModule` exports it.

**Producer migration is incremental and explicit.** A producer opts into fan-out
by calling `dispatch.notify(...)` instead of `notifications.create(...)`. That is
a per-producer module-wiring change (the producer's module imports
`NotificationsModule` for `NotificationDispatchService`), reviewed one producer
at a time -- **not** a global switch. A producer that only wants the bell row
keeps calling `create` directly. The write door does not become two doors: both
paths write through `create`; `notify` only adds the fan-out after it.

**Context.** `notify` runs in the producer's ambient RLS context (a cron body's
`withUserContext`, a request's interceptor context), exactly as `create` does
today; it seeds none of its own. The fan-out's own DB reads (devices, the
throttle window) inherit that context.

### 14.2 The push fan-out primitive -- `sendToUser`

`PushSubscriptionService.sendToUser(userId, payload): Promise<{ attempted,
delivered }>` fans a payload out over the user's live devices, reusing the exact
machinery `sendTest` already has (the concurrency-bounded batches,
`recordOutcome`, the retire-on-`MAX_CONSECUTIVE_FAILURES` bound). The batching
loop is extracted into a shared private `fanOut(...)`; `sendTest` keeps its
request-facing throws (no devices -> 400) while `sendToUser` is **non-throwing**
(no devices / channel off -> `{ attempted: 0, delivered: 0 }`), because a push is
an external side effect that must never roll back the notification it is about
(INV-PUSH, `docs/external-side-effects.md`). It is built **with** its dispatch
consumer (14.1), never shipped alone (the no-dead-code rule).

### 14.3 Notification-mode email goes live

`resolveEmailNotification(userId, category)` reads the `email_notification`
column (stored since Phase 2, Section 4) under the same master-switch discipline
as `resolveEmail`. When true, `notify` renders a per-notification email through
`EmailService` + a new `notificationImmediate` template, in the recipient's
locale via `emailTranslator` (copy composed outside a request). This is a
notification-mode delivery, so it is **subject to the throttle** (14.4); the
report-mode `email` column (digests) stays live and unthrottled exactly as today.

### 14.4 The throttle as the fan-out gate

Before a notification-mode delivery (immediate email or push) for group G and
user U, suppress it if a **non-dismissed** notification of G was created within
the last `throttle_minutes` -- **except a strictly higher-severity escalation**,
which always goes (silence on an escalation is the dangerous direction). The
in-app row for the suppressed one still exists; only the interrupting channel is
skipped (Section 4). `throttle_minutes = 0` disables the window.

- **Mechanism:** a windowed `SELECT` on the authoritative `notifications` table
  (`user_id = U`, category(G) via the `alert_type` set, `dismissed_at IS NULL`,
  `created_at > now - throttle_minutes`, `severity` rank below the current one),
  read inside the dispatch. This layers on top of the exact-duplicate dedupe (the
  fingerprint / dedupe-key unique index already stops the identical row); the
  throttle stops a *different* same-group interruption too soon.
- **Push copy:** the payload's `title`/`body` are the *category's* generic copy
  (`push.notification.<category>`, English fallbacks in `PUSH_CATEGORY_COPY`),
  rendered with `emailTranslator` in the recipient's stored locale -- the row's
  own title and message are producer-composed English and may carry amounts or
  names, and a Web Push body is composed outside any request, so it follows the
  email rule. The wire is encrypted end to end (Section 15), the lock screen is
  not; the in-app row, one tap away through `target`, carries the detail.
  `collapseKey` stays the row's dedupe key or id. Email detail is composed from
  `type` and `data` with `notificationEmailCopy` in the recipient's stored
  language. This applies to immediate dispatch (including reminder re-emits),
  critical budget emails, weekly budget digests and system-admin emails; dynamic
  subjects use the same localized title. Each admin is rendered separately.
  Catalogs under `emails.notificationCopy` cover all active notification types.
  Numbers, snapshot currencies, dates and month names use the recipient's locale;
  bill headlines are recomputed at delivery time against the UTC calendar day,
  matching the server's bill-date convention. Push stays generic per category.
  Names, symbols and diagnostic errors stay literal and are HTML-escaped by the
  templates. New budget snapshots carry their currency code alongside the amounts.
  Missing or malformed facts on legacy/restored rows retain the entire stored
  title/message; no amount, currency, date or GEM state is invented. The dormant
  `PACE_WARNING` enum has no producer or data contract and retains that fallback.
  Tests: `backend/src/notifications/notification-email-copy.spec.ts` exercises
  real nestjs-i18n, the active type set, English fallback, locales, incomplete
  data and escaping; the dispatch, budget and system-alert service suites check
  the four delivery paths and localized subjects.
- **Concurrency, stated honestly:** the throttle is a **best-effort rate limit on
  external side effects**, not an exactly-once guarantee -- two replicas firing
  the same group within the window can both pass the `SELECT` and both send. Push
  collapses device-side on `collapseKey` (so a double push is one notification);
  a double email does not collapse, so where that matters the dispatch takes a
  per-`(user, category)` advisory lock (`pg_advisory_xact_lock`) **before the row
  is written**, in the transaction that writes it, and decides on that same
  connection -- a lock taken after the commit serialises nothing, because the
  other replica's row may commit between the write and the decision -- at the
  cost of serialising that user's same-category writes. The prior it looks for
  is every other live row in the window, excluded by id: `created_at` is the
  transaction's BEGIN time, so the later lock-holder's row can carry the earlier
  stamp, and ordering on it let both replicas send. **Decision D7:
  advisory lock on the email path or accept rare duplicates** -- the maintainer
  picks; the default proposal is the lock, since a duplicate financial email is
  worse than a serialised send.
- **`budget-alert`'s batching:** `budget-alert` already batches immediate-critical
  emails per cron run (a report, not a notification), so it stays on the
  report-mode path and is **not** double-sent by the notification-mode throttle.
  The dispatch reads across that batching by keying the window on the in-app rows
  it wrote, not on the emails.

### 14.5 The push matrix column goes live

The matrix's `push` column (rendered "coming soon" in Phase 2) becomes a real
per-category toggle. **A matrix cell cannot turn a device on** (permission needs
a user gesture, Section on push enablement), so the column is enabled only when
the user has >= 1 live device. The `unifiedpush` column went live with its
transport (Section 15), gated the same way on a live UnifiedPush device.

What the cell cannot do, a button beside it can. The matrix first rendered
"enable push on this device first (see below)" -- a pointer, in a section that
already contained the thing pointed at. It now renders
`EnableThisEndpointButton`, which carries the same click-driven permission
request the devices panel does (`usePushEnable`, one copy of the
transient-activation rule and the three refusal messages) and keys off **this
endpoint** rather than the account: a reader whose phone is registered has a
working channel and still nothing on the machine in front of them, and that is
exactly the state the old copy had no words for. It renders nothing -- hint
included -- when it could not help: the instance does not offer push, the browser
cannot receive it, or the endpoint is already registered.

### 14.5.1 Telling one registered endpoint from another

`device_name` is derived from the User-Agent (`defaultDeviceName`), so two
browsers on one machine are listed under identical words -- and a reader
deciding whether to REVOKE a registration has to be able to identify it first.
The device list therefore shows, per row: the endpoint digest (the row's own
identity; the endpoint itself is a delivery credential and never leaves the
server), the wire, the address it was registered from, when it was registered,
when it was last active, when it was last actually delivered to, and the agent
string.

`push_subscriptions.registered_ip INET` (migration 185) holds that address. Two
properties are load-bearing:

- **It is REGISTERED, not current.** A push travels from this server to the push
  SERVICE, which reaches the device over a connection this deployment never
  sees, so where a device is reachable today is not knowable here. The column is
  written from the subscribe request and refreshed on each re-registration, at
  the same moment `last_seen_at` moves -- the refresh arm OVERWRITES rather than
  `COALESCE`s, because an older address under a moved `last_seen_at` would make
  the pair a lie.
- **Unknown is a state.** Null for a row predating the column and for a request
  whose address the server could not determine; the client renders "Unknown"
  rather than a blank cell or an invented address.

The address is read by `clientIpOf` (`backend/src/common/client-ip.util.ts`),
which is the deployment's one reading of a client address -- shared with the 2FA
trusted-device path, so one machine cannot be stored under two spellings (a
dual-stack listener reports every IPv4 client as `::ffff:<v4>`). It is the
reader's own address, shown only to them, on an RLS-policied user-owned table;
`push_subscriptions` stays in `EXCLUDED_FROM_EXPORT`, so it does not travel in a
backup.

**It only exists if the deployment's edge asserts it.** Every request reaches
the backend through the Next.js proxy (`frontend/src/proxy.ts`), so the
backend's socket peer is always that proxy; what `req.ip` resolves to is
whatever `X-Forwarded-For` the proxy set. Next.js middleware cannot see the
connecting socket either (`NextRequest.ip` was Vercel-only and was removed in
Next 15), so the proxy forwards the address the operator's reverse proxy
appended to `X-Forwarded-For`, read `TRUSTED_PROXY_HOPS` entries from the right
(or a dedicated header only when `CLIENT_IP_HEADER` names it;
`assertedClientAddress`, `frontend/src/lib/client-address.ts`) -- and forwards
NOTHING when there is none, so a browser's own `X-Forwarded-For` can never pass
through unaltered.
The predecessor fell back to the literal `127.0.0.1`, which every deployment
behind an edge that sets only `X-Forwarded-For` (Traefik, most cloud load
balancers) then recorded against every registration and every trusted device --
an address nobody was at, indistinguishable from a genuine loopback connection.
A deployment fronted by nothing has no client address to record, and the column
says so.

### 14.6 Chart-in-push (R5) -- delivery and security envelope

The `SECURITY_PRICE_MOVEMENT` producer (`security-price-alerts.md`) can now
attach a PNG to Web Push. Each instrument is one collapse group and has a
separate `priceChartEnabled` opt-in, default false. The price-alert threshold
alone does not authorize images. The sender rechecks the owner, active status,
threshold and chart opt-in before reading stored quotes. UnifiedPush remains
text-only. Category delivery gates and throttling apply before rendering.

The renderer uses at most 60 stored closes, with the alert's own price/date as
the last point, and produces a 640 × 280 PNG without browser or native runtime
dependencies. It makes no provider requests. A chart shows quoted prices, not
portfolio holdings or returns; axes use numeric prices and ISO dates.

Each target device receives a separate
`payload.image = '/api/v1/push/chart/<token>.png'`. The opaque token contains a
random 256-bit nonce, expiry and purpose-separated HMAC. The endpoint requires
this bearer credential rather than a session: anyone holding it can view that
one image once within five minutes. Signature, format and TTL are checked
before database access; PostgreSQL `DELETE RETURNING` consumes it atomically
across replicas. HEAD does not consume it. No token becomes a filesystem path.
The response is non-cacheable; the service worker accepts only this exact
same-origin path format, without query strings, fragments or external URLs.

Storage is shared PostgreSQL infrastructure, excluded from backups, capped at
1,000 images of at most 64 KiB each. An advisory transaction lock serializes
quota decisions; expired rows are removed on issue and every five minutes.
Invalid data, missing history, a full store or rendering/storage failure leaves
the existing localized, generic Investments text and instrument deep link.
Images are a progressive enhancement: browsers without image support and
notifications received after the image expires remain text-only. Push retention
is longer than image retention by design. The opt-in permits a price chart on
the device's notification screen; text otherwise retains the existing privacy
policy and does not disclose amounts.

Unit tests cover rendering, owner/opt-in gating, per-device issuance, invalid
payloads, token validation and safe worker image paths. A PostgreSQL integration
test covers concurrent consumption and replay. It has not run in the local
workspace (no PostgreSQL); native browser image rendering also remains a manual
validation item, alongside the existing browser test environment limitation.

### 14.7 Invariants and the test obligations

- **INV-DISPATCH-001** `create` remains the sole writer; `notify` never writes a
  row itself (write-door guard unchanged).
- **INV-DISPATCH-002** the in-app row is written for every `notify`, regardless
  of matrix or throttle (Section 3); a category with push+email off still bells.
- **INV-DISPATCH-003** the throttle gates only notification-mode fan-out, never
  the in-app row and never a report; an escalation is never throttled.
- **INV-DISPATCH-004** a failed push/email never rolls back the notification
  (`sendToUser` / the email send are non-throwing to `notify`).
- **INV-MODULE** `NotificationsModule` importing `PushModule` introduces no
  require cycle (`module-graph.spec.ts`).
- Tests: `module-graph.spec.ts` (no cycle); a dispatch spec proving each of the
  four dispatch invariants; a throttle matrix (within/just-after the window, an
  escalation, `throttle=0`, a dismissed prior row not counting); the real-DB
  advisory-lock behaviour if D7 chooses the lock; the push matrix column's
  device-gating; and the chart token's single-use + TTL + CWE-22 path validation.

### 14.8 Decisions the maintainer confirms before this is built

- **D7** throttle-email concurrency: advisory lock (proposed) vs. accept rare
  duplicate emails.
- **D8** which producers opt into fan-out first (proposed: `budget-alert`
  immediate-critical as notification-mode, plus `SCHEDULED_POST_FAILED`), and
  whether any existing report email should move to notification-mode.
- **D9** notification-mode email default per category (Section 3 table has email
  on only for security/system as *report* mode; notification-mode defaults off
  everywhere until confirmed).
- **D10** chart-in-push: confirm it ships only with a real price-alert producer,
  Android-only, default off.

This section is a **plan, not an implementation**. Per the org rule that AI
output is auxiliary and must not autonomously make decisions with downstream
effects, the seam, the throttle concurrency choice, and the producer-migration
order are put to the maintainer here rather than built unattended.

---

## 15. The UnifiedPush transport (maintainer-confirmed, promoting the deferred column)

Section 1 deferred UnifiedPush as a "coming soon" column. The maintainer has
since asked for the **full transport**, and confirmed the model: **encrypted Web
Push delivered to a UnifiedPush distributor endpoint**, never a plaintext ntfy
publish. The privacy line is the reason -- a notification body can carry an
amount or a payee, and a finance app must not hand that to a third-party relay in
the clear.

### 15.1 What UnifiedPush is here, and what it is not

A UnifiedPush subscription **is a Web Push subscription**: an `endpoint` at a
distributor (ntfy, NextPush, a self-hosted UnifiedPush provider) plus the two
keys (`p256dh`, `auth`) that RFC 8291 encrypts to, signed under this instance's
VAPID key pair exactly as a browser subscription is. The *only* things that make
it a distinct **channel** are (a) the endpoint host is a distributor rather than
a browser vendor's push service, and (b) a per-subscription `transport` tag so a
per-user `unifiedpush` channel toggle can gate it independently of web push.

Because the wire protocol is identical, **`WebPushSender` is reused unchanged**
-- delivery isolation (INV-PUSH, `docs/backend/notifications-and-push.md`) holds: it stays the one
file in `src/` importing `web-push`, and a business feature still asks the
notification layer for a notification, never a transport. There is no second
sender, no ntfy-native JSON publish, and no new outbound-request shape: the
endpoint is still a URL the server POSTs an encrypted body to, validated with the
same `IsPushEndpoint` (https floor + SSRF resolve), so no new CWE-918 surface.
Private distributors are disabled by default. An operator can enable exact
HTTPS DNS origins through `UNIFIEDPUSH_PRIVATE_ENDPOINTS`, a JSON mapping from
origin to a pinned RFC1918 IPv4 or IPv6 ULA address. Example:
`{"https://ntfy.home.lan:8443":"192.168.20.5"}`. Pass it to the backend environment
and restart every replica; both Compose variants forward the variable.

The exception applies only when `transport = 'unifiedpush'`, at registration
and before each send. Hostname and port must match exactly; subdomains,
wildcards, URL credentials, fragments, path-prefixed entries and IP-literal
origins are not admitted. At most 32 entries and 16 KiB of configuration are
accepted. Invalid configuration prevents backend startup. User preferences,
subscription fields and administrator API requests cannot edit this setting.

Each private delivery's HTTPS agent resolves only to the configured IP, with
normal certificate verification and SNI for the original hostname. DNS changes
cannot redirect that exception elsewhere. Loopback, link-local, metadata,
multicast and public addresses cannot be pins. Use a dedicated distributor
origin: the exception authorizes encrypted POSTs to paths on that origin, not
an arbitrary host in a network range. Certificates must chain to a CA trusted
by Node; no insecure TLS switch is introduced. The recipient client must also
be able to reach and trust this server.

Removing an entry and restarting the backend removes the private exception;
existing subscriptions are rechecked before delivery. Public endpoints retain
the existing bounded SSRF validation. Browser `webpush` subscriptions receive
no private exception, even if their origin appears in the mapping. Tests cover
configuration, exact matching, DTO transport, pinned lookup callback forms and
sender refusal after removal. `npm run push:tls:test` also exercises real HTTPS
on loopback: the production lookup helper preserves SNI, encrypted Web Push is
decrypted by the reference receiver, and untrusted or mismatched certificates
are rejected before an HTTP body arrives. It creates an ephemeral certificate
with OpenSSL and trusts it only in the test agent. Loopback remains forbidden
in production configuration. These four tests passed locally and run in CI;
delivery to the actual ntfy deployment over LAN remains a smoke test.


**What it is not.** A browser PWA cannot *receive* at an arbitrary endpoint --
`pushManager.subscribe()` is bound to the browser's own push service. So a
UnifiedPush subscription is registered by a **UnifiedPush-capable client** (a
native/wrapped Monize build, or a browser whose own push service already is a
self-hosted UnifiedPush endpoint -- which the ordinary `push` channel already
covers). The client posts its endpoint and keys through the same
`POST /push/subscriptions`, tagging `transport: "unifiedpush"`. The web settings
surface **manages and gates** UnifiedPush subscriptions (lists them with a
transport badge, renames, removes, and exposes the channel toggle); it does not
mint the keys, because the client that will decrypt owns them. Copy says so
rather than offering a browser button that could never receive.

### 15.1.1 ntfy reference receiver

`backend/scripts/unifiedpush-client/` now provides a Node.js receiver with local
recipient key storage, owner-authenticated registration, encrypted ntfy polling,
checkpointed reconnects and subscription removal. It uses the existing
`POST /push/subscriptions` with `transport: "unifiedpush"`; no authentication,
SSRF or delivery gate is relaxed. Monize session credentials are sent only to
Monize and are unnecessary while listening. Message copy is localized by the
server; the receiver emits JSON and accepts only same-origin navigation targets.

This closes the absence of any registering receiver in the tree for ntfy.
It does not provide an Android package, a D-Bus connector, desktop banners,
or browser registration to arbitrary distributors. Session handoff is manual
and ntfy endpoints requiring separate HTTP credentials are unsupported. The
README specifies installation, lifecycle and the deployment smoke test.
The automated registration-to-decryption harness uses real Web Push encryption
with mocked HTTP boundaries; live distributor verification remains outstanding.

### 15.2 Data model (migration 184)

- `push_subscriptions.transport VARCHAR(20) NOT NULL DEFAULT 'webpush'`, with a
  `CHECK (transport IN ('webpush','unifiedpush'))` (idempotent: `DROP CONSTRAINT
  IF EXISTS` before `ADD CONSTRAINT`). Default `'webpush'` so every existing row
  keeps today's behaviour. The table is in `EXCLUDED_FROM_EXPORT`
  (`export-table-queries.ts`) -- a device credential minted under this
  deployment's VAPID key -- so the column needs no backup classification.
- `notification_preferences.unifiedpush BOOLEAN NOT NULL DEFAULT false`. `DEFAULT
  FALSE` for the push reason: a matrix cell cannot register a distributor, so the
  channel stays off until a UnifiedPush subscription exists and the category is
  toggled. Exported, so `unifiedpush: keep` in `support-backup-rules.ts` (a flag,
  not identifying).

No new SQL function, so `required-db-functions.ts` is untouched. Both tables keep
their existing RLS policies -- adding a column changes no policy. `schema.sql`
updated in the same commit; migration replays as a no-op on a fresh schema.

### 15.3 Delivery gating (the dispatch reads two push channels)

`NOTIFICATION_CATEGORY_CHANNELS` gains `unifiedpush` per category (same support as
`push`: PAYMENTS/BUDGETS expose it, SYSTEM exposes it -- an admin's infra alert is
as reasonable on a UnifiedPush device as a web-push one). `resolveNotificationDelivery`
returns `unifiedpush` beside `push`, forced off where unsupported, never
email-master-gated (a different channel), defaulting off.

`PushSubscriptionService.sendToUser` takes an optional **transport filter**;
`sendTest` keeps sending to every live device (a test is "does any device
work"). The dispatch's `fanOut` computes the enabled transport set from the
resolved delivery -- `webpush` when `delivery.push`, `unifiedpush` when
`delivery.unifiedpush` -- and calls `sendToUser` once with that set; the
`if (!push && !emailNotification) return` short-circuit gains `&& !unifiedpush`.
The throttle gates all interrupting channels alike, unchanged.

### 15.4 Invariants and test obligations

IDs continue the `docs/system-invariants.md` register (INV-PUSH-006 is already
"a channel is offered only while its key can be used"; these four are registered
there with their enforcement status).

- **INV-PUSH-007** UnifiedPush reuses `WebPushSender`: `push-secret.guard.spec.ts`
  still finds exactly one `web-push` importer; no second sender appears.
- **INV-PUSH-008** a `transport` tag gates delivery: a user with `push` on and
  `unifiedpush` off receives on web-push subscriptions only, and the reverse; the
  four combinations are a matrix test at the dispatch (which set is passed) AND a
  service test (the filter is applied, an empty set reaches no database).
- **INV-PUSH-009** an unsupported channel is forced off in
  `resolveNotificationDelivery` for `unifiedpush` exactly as for `push`.
- **INV-PUSH-010** a UnifiedPush endpoint is `IsPushEndpoint`-validated (https +
  SSRF), never a bare `@IsUrl()`; `transport` is bounded to `PUSH_TRANSPORTS` by
  the DTO and by the `push_subscriptions_transport_check` CHECK, and the two
  lists are held equal by `push-transport.contract.spec.ts`.
- Contract: `NOTIFICATION_CATEGORY_CHANNELS` (backend) and its client mirror stay
  equal (`notification-preferences.contract.test.ts`), now over four channels.
- The matrix's `unifiedpush` column gates on `>= 1` live UnifiedPush
  subscription, the same shape as the push column's device gating.

---

## 16. Maintainer decisions resolving #1291 open questions (2026-09)

Section 12 recorded autonomous defaults with the caveat that a human confirms
them before shipping to users. The maintainer answered the #1291 "Open questions"
directly in **discussion kenlasko/monize#1291, comment dated 2026-09-01**; each
item below cites that answer, so it is a **confirmed decision, not an AI default**.
Where an answer expands scope beyond PR #1304 it is marked **NEW** -- a follow-on
surface or producer, with its spec obligation named. (Per the org rule that AI
output is auxiliary, the source of each answer is named so the next reader can
verify it against the discussion rather than trusting this summary.)

### 16.1 Product

- **MVP notification types** -- every type the app supports today, plus others as
  they make sense. PR #1304 ships the three live categories (`PAYMENTS`,
  `BUDGETS`, `SYSTEM`); further types arrive each with its producer (Section 3).
- **Successful auto-backups** -- no notification; failures only. Done: the only
  backup notification types are `BACKUP_FAILED` and `BACKUP_PARTIAL`, and neither
  announces a success.
- **Security notifications mandatory?** -- no, opt-in. Confirms D6.
- **History expiry** -- automatic. Done (`purgeOld`).
- **User-configurable balance thresholds** -- yes. **NEW**: a `balances` producer
  with per-account user thresholds. Financial, so it starts from its own spec
  (Section 16.4).
- **Investment / portfolio-movement alerts** -- maintainer's choice, "could be
  useful". **NEW / optional**: an `investments`/portfolio producer. Financial,
  its own spec (Section 16.4).
- **Default push-content detail** -- no preference. Keep the privacy-first
  category copy already shipped (Section 14 and "Privacy of the wire"): the wire
  carries the category's generic copy, never an amount or a payee.

### 16.2 UX

- **Opening a notification marks it read** -- yes. (Verify the bell marks-on-open;
  `markRead` exists.)
- **"Mark all as read"** -- yes. Done (`PATCH /notifications/read-all`).
- **Bell shows all unread**, not only important -- yes. Done.
- **Push / notification configuration on a DEDICATED Notifications page**, not in
  general Settings -- **NEW**: today the device and diagnostics panels
  (`PushDevicesPanel`, `PushDiagnostics`) sit under `/settings`; they move to a
  dedicated notifications surface.
- **Per-device push disable while enabled elsewhere** -- yes. **NEW (small)**:
  today `DELETE /push/subscriptions/:id` removes a subscription entirely; add a
  disable toggle so a device is silenced without having to re-subscribe.

### 16.3 Architecture

- **VAPID keys persisted in the database** -- yes. Done (`push_instance_config`,
  private half encrypted under `ENCRYPTION_KEY`).
- **VAPID rotation** -- a sensible default: admin-triggered rotation that disables
  stale subscriptions. Done (`rotateKeyPair`).
- **Notification history in backup/restore** -- yes. Done.
- **Push subscriptions in portable backups** -- **excluded, and deliberately so.**
  `push_subscriptions` and `push_instance_config` are both in
  `INTENTIONALLY_EXCLUDED_TABLES` (`export-table-queries.ts`), and INV-PUSH-005 is
  `enforced` on exactly that exclusion: a subscription is instance-bound (a restored
  one is either undeliverable or lets a test instance push to a real device), and
  `push_instance_config` carries the encrypted VAPID private key, an instance secret
  rather than user data. This is the maintainer's "restored/cloned-environment push
  safety -- don't bother" answer, applied. Including them would require superseding
  INV-PUSH-005 (an ADR), which is not done and not proposed. The earlier draft of
  this bullet said "included -- Done"; that was wrong and is corrected here.
- **Restored / cloned-environment push safety** -- don't bother; a developer edge
  case. Confirms the Section 1 non-goal.
- **Durable scheduler** -- implementer's choice. Done (a per-minute cron claiming
  due rows through `FOR UPDATE SKIP LOCKED`, Section 13.2).
- **Transaction -> event integrity** -- if the transaction that drives an event is
  deleted, the event goes too. **NEW**: a notification or reminder whose subject
  is a specific transaction is removed when that transaction is deleted. Needs a
  bounded design (Section 16.4): which producers tie a row to a transaction id,
  and delete-vs-null per row.
- **Async localization** -- the recipient's chosen language. Implemented for
  push category copy, email framing and structured notification titles/messages,
  including admin alerts and budget digests (PR #1304 open item 2, Section 14).
  Legacy rows without the required facts retain their stored English fallback.

### 16.4 What still needs a spec before code

These follow-on features are the ones the branch author has now asked to build,
and each is kept behind a short approved spec (invariants, state-transition truth
table, missing-data policy, numeric examples, test matrix) per the repository rule,
committed before the implementation it guides. Each has a proposed spec awaiting
maintainer approval; no code lands until the open decisions in each are confirmed.
The measure and product decisions in each were confirmed with the requester
(recorded in each spec's Decisions section):

1. **Balance-threshold notifications** (`balances`) -- financial, **event-driven**
   (evaluated from the post-commit balance-invalidation seam, not a daily cron).
   `balance-threshold-notifications.md`.
2. **Portfolio-movement notifications** (`investments`) -- financial. Daily, above a
   user threshold, measuring the **market change net of external cash flows** (a
   deposit does not fire; a dividend is return, not a loss).
   `portfolio-movement-notifications.md`.
3. **GEM recommendation-change notifications** (`strategies`) -- a change of GEM
   recommendation between periods, with `RISK_ON <-> RISK_OFF` as its own louder
   event. `gem-signal-change-notifications.md`.
4. **Transaction-deletion cascade** -- not itself a calculation, but it changes what
   a delete reverses, so it is specified with the producers whose rows it removes
   rather than bolted on. `notification-transaction-cascade.md`. (Not in the current
   build batch; listed here as the fourth follow-on.)

The core rule #1291 fixes for every producer: fire on a **crossing** (79% -> 81%
fires the 80% warning; 81% -> 82% -> 83% does not), never on mere observation of the
current state. The budget producer approximates this within a period via a
fingerprint dedupe; the balance producer uses an explicit armed latch, and GEM a
period-over-period comparison -- each spec names its own mechanism rather than
claiming the budget producer's applies unchanged.

### 16.5 Notes carried into the design

- Scheduled-transaction reminders use each bill/deposit's own
  `reminder_days_before`. Done (`reminderWindowThrough(todayStr,
  bill.reminderDaysBefore)`).
- The bell's filter by **severity** and by **type** (financial vs system) is
  preserved and must not regress (`NotificationBell`, `NotificationList`).


### Delegate access policy (TODO 10)

Notification delivery and read state are personal to the owner. An acting
delegate may read the existing notification feed only with the Budgets section
grant. Reading as a delegate does not materialize new bill notifications.

| Operation while acting as an owner | Policy |
| --- | --- |
| Read the notification feed | Budgets section grant required |
| Mark read, mark all read, dismiss one or many | Owner only |
| Read or change channel preferences and portfolio alert thresholds | Owner only |
| Read push configuration, list/register/remove devices, send test push | Owner only |
| List, create or stop reminders, including the push Stop request | Owner only |

`@OwnerOnly()` makes this explicit on the four controllers; only the feed's
list method overrides it with `@AllowDelegate()`. The global delegate guard
continues to enforce the policy for direct API calls. Managing one's own
notifications requires switching back to one's own account context. There is
no notification-management delegation capability in this feature.

The bell follows the same grant check and hides all write controls for an
acting delegate. Opening a row navigates without marking the owner's row read.
Context changes discard the previous feed and cancel pending dismiss timers.
Settings already exposes only the actor's security controls in delegated mode;
the reminders page already declines delegated access without fetching rows.

`notification-delegate-policy.spec.ts` exercises the production guard with real
route metadata and signed tokens for all four controllers. UI regressions cover
read-only rows and the missing-grant case. Feed category visibility remains the
existing Budgets-section policy; this decision does not add account/category
filtering or grant delegates access to the owner's delivery destinations.
