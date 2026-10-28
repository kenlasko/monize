# Backend: notifications, push and recipient-locale copy

The one transport boundary, the one writer of the notifications table, collapse keys, and copy composed outside a request. Read this before producing a notification, touching `src/push/` or `src/notification-center/`, or composing an email or push body.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## A business feature asks for a notification; it never imports a transport

`WebPushSender` (`src/push/web-push-sender.service.ts`) is the only file in
`src/` that imports `web-push` or calls `sendNotification`, and
`push-secret.guard.spec.ts` fails on a second one. Budgets, bills, backups and
imports call the notification layer and let it decide the wire -- which is how
UnifiedPush arrived (`docs/specs/notification-preferences.md` section 15) without
any of them changing: a UnifiedPush subscription is a Web Push subscription
whose endpoint is a distributor, tagged `transport = 'unifiedpush'` and gated by
its own matrix channel, delivered by the same sender (discussion #1291,
"delivery isolation"). The VAPID private key follows from the
same boundary: it is read only by `PushConfigService`, handed only to the sender,
and no response shape in `src/push/` declares a private field. See INV-PUSH-001
through INV-PUSH-005.

Two consequences that are easy to get backwards. **A push endpoint is a URL the
server will make an outbound request to**, so it is validated with
`IsPushEndpoint`, which reuses the AI provider's safety check and adds an https
floor -- never a bare `@IsUrl()`. That check resolves the host, and
`dns.resolve4`/`resolve6` carry no timeout of their own, so the lookup is bounded
INSIDE the check itself (`resolveBothFamilies` in
`src/ai/validators/safe-url.validator.ts`) and every caller is covered without
asking: the AI provider `baseUrl` validators and the startup check reach it
through plain `validateUrlIsSafe`, and a resolver that never answers would hold
whichever request asked -- a save, or a subscribe an authenticated caller may
issue twenty times a minute. A timeout answers **false**, and specifically not
"resolved to nothing": an empty answer is allowed (a name that resolves nowhere
fails on its own), so a stall borrowing that answer would be an open door.
`validateUrlIsSafeWithin` bounds the *whole* check and exists for the push
sender, whose documented request worst case (`PUSH_TEST_WORST_CASE_MS`) has to
name a budget it owns.

And **a subscription belongs to a browser profile, not to a session**: the
unique index is on `endpoint_hash` alone, so one endpoint has one owner -- and
the second account subscribing in the same browser is *refused*, never allowed
to take the row over. An endpoint is a string the caller supplied; deleting
somebody else's row on the strength of it is a cross-tenant write no ownership
check covers. The client answers the 409 by
unsubscribing and subscribing again for a fresh endpoint.

**A header sign-out holds the row rather than deleting it** (INV-PUSH-011):
`PushSubscriptionService.hold` sets `held_at`, `sendToUser` and `sendTest` skip a
held row (skipped, not queued: the bell already has every notification), and the
same account's next subscribe clears it on the upsert's `DO UPDATE` arm, under
the same `user_id` guard as every refresh. Held rows still count against
`MAX_LIVE_DEVICES_PER_USER`, and `purgeRetiredDevices` deletes a hold older than
`HELD_DEVICE_RETENTION_DAYS`. The client keeps the browser subscription only
once the hold is confirmed and otherwise releases the endpoint as before
(`releaseLocalPushSubscription`); account deletion always releases.

## The notifications table has one writer

`NotificationService.create` (`src/notification-center/notification.service.ts`)
is the only producer write door. Backup restore preserves archive IDs and
timestamps through its own insert, using the same `notification-bounds.ts`
helpers via `boundRestoredNotification`. For producer writes,
`notification-write-door.spec.ts` fails on a second door. A producer decides
*what* to say; the row's shape is not its decision. There were three writers
with three opinions -- a raw `INSERT` for budget alerts with its own conflict
target and no title bound, an entity `save` for bill reminders with no conflict
handling at all, and a second raw `INSERT` for system alerts with its own
truncation helpers -- so every rule the row must obey held on one path and not
the others.

Two consequences worth knowing before you add a producer. The insert is
`ON CONFLICT DO NOTHING` with **no conflict target**, which covers both unique
indexes at once (the fingerprint for a budget notification, the dedupe key for a
system one) -- a producer does not know which applies to it, and does not have
to; `null` back means somebody else holds this notification, so it is not yours
to email about, and that is the normal case rather than an error. And **reads
are deliberately not centralized**: a producer's own de-duplication query is
about its candidates, not about the reader's list.

`category` is derived (`notificationCategoryOf`), never stored -- see migration
179's header for why, and `notification-category.spec.ts` asserts the column's
absence against `schema.sql`.

**What a push notification COLLAPSES onto is the producer's decision, and the
type is not the subject.** The browser replaces a shown notification whose `tag`
matches, so `PushPayload.collapseKey` is a required field: `null` means "this
type is one subject" (a test send, "email delivery is failing"), and a value
names the subject. Deliberately not derived from `target` -- the bill producer
sends every reminder to `/bills`, because there is no per-bill page, so a tag
built from the route collapsed exactly the case it had to separate: two bills due
on the same day, one of them shown and the other silently replaced. It carries an
id, never a name or an amount: the payload is encrypted to the device, but a
collapse key is metadata. The dispatch derives it in this order: a producer's
`NotifyOptions.collapseKey` (the admin fan-out passes its `emailDedupeKey`, so
sixty rows about one full disk are one notification on the phone), then the
reminder id of a re-emitted nag (`rem:<id>` -- its per-fire dedupe key differs
every fire), then the row's dedupe key, then its id.

The HTTP surface lives in its own module (`notification-api.module.ts`) because
it is the one part that needs a producer: bill reminders are materialized when
the list is read. Put that edge on `NotificationCenterModule` and every producer
of a notification lands on a require cycle with budgets.

## A push's chart token lives as long as the push, and a movement alert is written before its baseline

- **The chart token outlives nothing it rides on (A26-L27).** `CHART_TOKEN_TTL_MS` (`src/push/push-chart-artifact.service.ts`) is `PUSH_TTL_SECONDS * 1000`, because a push held for a phone in Doze shows its image URL hours later. `CHART_ARTIFACT_LIMIT` is unchanged and now binds sooner; at the cap `issue` returns `null` and the push goes without a chart. The spec pins the relation.
- **Do the thing, then write down what happened (A26-L28).** `PortfolioMovementAlertService` calls `notify` first and stores the new baseline after it returns. A failed `notify` leaves the old baseline, so the next run measures the same movement; the per-day dedupe key (`portmove:<currency>:<day>`) makes the retry harmless. A `null` from `notify` means another replica wrote today's alert, and the baseline still moves.

## Copy composed outside a request is rendered in the recipient's locale

`emailTranslator(i18n, lang)` with `resolveUserEmailLocale` is not email-only
despite the names: a Web Push body is composed on the server, in a cron or a
background write with no request locale to inherit, so it resolves the
recipient's stored `user_preferences.language` exactly as an email does. Reuse
those two; a second locale resolver is how the answers drift.

Notification email bodies and dynamic subjects go through `notificationEmailCopy`
(`src/notifications/notification-email-copy.ts`) at delivery time, including
immediate dispatch, admin alerts and budget digests. Supply the snapshot's currency
in `data`; missing facts on legacy rows retain the stored copy rather than inventing
amounts or currency. HTML templates escape the composed strings once.

## Notification lookups do not use recognition projections

Bill reminder deduplication reads `Notification` entities normally inside `withScopedDb`, retaining its user and notification-type filters. `reportingEntities` checks the root entity's TypeORM metadata before adding recognition provenance: only a transaction root has those virtual columns. A notification or other non-transaction root keeps an ordinary entity read regardless of reporting preference. `accrual-bill-reminders.integration.spec.ts` executes the due-reminder/list sequence and repeated-read deduplication under enforced RLS in both cash and accrual mode; it also checks a non-transaction query passed to the helper.
