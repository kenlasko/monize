# Provider outage: stop calling, say it once, tell somebody

Status: implemented (issue #1265).

## The failure this replaces

Yahoo Finance became unreachable from a deployment's container. Every code path
that wanted a price kept calling it:

```
[Nest] 7 - 08/26/2026, 7:11:37 PM ERROR [YahooFinanceService]
Failed to fetch historical prices for ^RUT
TypeError: fetch failed
```

repeated for `^RUT`, `^GSPTSE` and the rest, several times a second. Three
separate defects compounded:

1. **No breaker.** A transport failure was retried by the next caller, forever.
   The retry logic in `throttledFetch` covered 429/503 only -- "upstream is
   asking us to slow down" -- and correctly let network errors propagate, but
   nothing above it drew a conclusion from them.
2. **A log entry that could not be acted on.** `TypeError: fetch failed` is what
   undici rejects with for DNS, TLS, a refused connection, a proxy hangup and a
   timeout alike; the discriminating detail is in `error.cause`, and the code
   logged `error.stack`, whose frames are all undici's. The reporter's log was
   thousands of lines long and contained no cause.
3. **A restart amplified it.** `MarketIndexService.onApplicationBootstrap` ran
   the full refresh with no cooldown: 24 indexes x up to 11 yearly chunks, each
   with its own 60-second timeout. The operator restarted the container because
   of the log; the restart produced the log.

The user-visible result was a sluggish UI, a container restarting on its own, and
an operator whose only signal was the flood.

## What now happens

**A breaker per provider** (`backend/src/provider-health/provider-circuit.ts`).
Five *transport* failures (`isTransportFailure`: no response arrived -- an HTTP
status, however bad, proves the host answered) inside a five-minute sliding
window open it for one minute; each consecutive failed probe doubles the window
to a 15-minute cap; one probe is admitted per window, and its success closes the
breaker and resets the escalation. A refused call raises
`ProviderUnavailableError` **before** the concurrency gate, so it costs no socket
and no wait.

The window is over *time*, not over a consecutive run, and that is not a detail:
a provider that accepts the connection and then stalls the body answers its
headers on every request, so a run-based breaker recorded a success per request
and never reached two failures. Successes therefore do not cancel failures --
only the clock does, and a recovery clears the window outright.

**One log line, with the cause** (`describeFetchFailure`). Nothing in this
deployment restricts Nest's log levels, so "suppressed" has to mean *not
printed at all* -- a `debug` line per refused call is the same flood one level
quieter. The chain and the socket-level fields become one bounded line -- `TypeError: fetch failed <-
getaddrinfo EAI_AGAIN query1.finance.yahoo.com [code=EAI_AGAIN
syscall=getaddrinfo hostname=query1.finance.yahoo.com]`. It is rate-limited to
one line per provider per minute, counts what it suppressed, and prints *nothing*
for a call the breaker refused: the breaker already said so once.

**A restart is not new information.** The start-up warm-up honours the per-index
attempt cooldown; the daily cron still does not, because a schedule is the
request.

**An email, at most one pair per episode.** `provider_health` holds one row per
provider. Four independent gates:

| Gate | Mechanism | Stops |
|---|---|---|
| 15-minute minimum outage | `outage_started_at <= now() - 15min` in the claim's `WHERE`, and the upsert preserves that start while the stored state is `down` | mail about a blip -- and, because the start is durable, a restart loop cannot keep resetting the clock |
| Failure observed 15 minutes in | `last_failure_at >= outage_started_at + 15min` in the same `WHERE` | a single burst nothing re-tested: the row stays `down` until a call is made, so a PC waking from sleep (every lookup `ENOTFOUND` in the second the network returns, then silence) read as a 15-minute outage. A real outage keeps failing probes and qualifies at the first one 15 minutes in; `recordDataFailure` backdates its start by 15 minutes, since its caller has already seen days of stale data |
| One notice per episode | `UPDATE ... SET outage_notified_at = now() WHERE outage_notified_at IS NULL RETURNING ...` -- the claim *is* the serialization point | every replica mailing the same outage |
| 6-hour floor | `last_notified_at`, which a recovery advances and nothing clears | a provider that flaps every 20 minutes mailing a pair each time |

The recovery notice is *derived*, not scheduled: a row that is `up` while
`outage_notified_at` is set is owed an all-clear, and sending it clears the
marker. Nothing has to remember to enqueue anything, which is the property that
makes it hold across restarts (the shape `docs/external-side-effects.md` praises
in the emergency-access grant path).

Recipients are the administrators, resolved through the shared
`queryAdminRecipients` (`backend/src/users/admin-recipients.util.ts`):
`role = 'admin'`, active, not delegate-only. Winning either claim now also
raises the in-app companion rows (`PROVIDER_OUTAGE` / `PROVIDER_RECOVERED`
via `SystemAlertService`, one per admin -- see `docs/specs/system-alerts.md`),
so the sweep no longer stands down when SMTP is unconfigured: the claim is
consumed, the rows are the delivery, and the email leg -- which additionally
requires an address with `notification_email` not disabled, each recipient in
their own locale -- skips inside `deliver`. Only a deployment with no active
administrator at all does nothing.

## Deliberate trades

- **At most once, not at least once.** The claim commits before SMTP is called,
  so a process killed in between loses that alert. For a monitoring email that is
  the right way round: the duplicate is the thing being designed against, the
  outage remains in the log and in the table, and the 6-hour floor makes a
  still-broken provider notifiable again. `BillReminderService` chose the
  opposite for the opposite reason.
- **In-memory breaker, durable notification.** The breaker is a fact about *this*
  replica's sockets; sharing it would mean one replica's bad NIC muting another
  replica's healthy calls. Only the parts that must outlive the process are
  stored.
- **Availability bookkeeping never fails a request.** The write is
  fire-and-forget, outside the caller's transaction, and swallows its own errors.
- **A gate takes the probe slot; a skip-decision does not.** `assertAvailable`
  and `tryRequest` admit one request and return which kind of admission it was;
  a `"probe"` holder owes an outcome (`recordSuccess`, `recordFailure`, or
  `releaseProbe` when the attempt learned nothing about the provider's own
  host), and only a probe holder may release, or a straggler frees somebody
  else's slot. `wouldRefuse` is the read-only predicate, for deciding
  whether to skip work -- `MarketIndexService` uses it so a refused call does
  not stamp `last_attempt_at` and burn a six-hour cooldown for a request that
  never left the process. Using it as a gate would let every caller through the
  instant a window elapsed; `provider-call.guard.spec.ts` fails on that.
- **Per-replica breakers can disagree, and the row takes the last word.** With
  more than one replica, one that can still reach the provider writes `up` on
  its first success and clears an episode another replica is living through.
  That costs the outage its alert, and it is the right way round: if any replica
  is serving prices, the deployment is not down in the way this alert is about.
  A shared breaker would instead let one replica's bad NIC mute a healthy one.

## Not yet adopted

The same shape applies to the other outbound callers -- the AI providers,
`UpdatesService`, `favicon.service`, `password-breach.service`. They are not
wired to the breaker in this change, and `provider-call.guard.spec.ts` scopes
its scan to `src/securities/`, `src/payees/lookup/google-places/` (which adopted
the breaker with the payee contact lookup, and whose rejected-key 4xx is
recorded as a SUCCESS -- the host answered, and one user's bad key must not open
a deployment-wide breaker), `src/bank-sync/providers/enable-banking/` and
`src/currencies/` (the exchange rate adapters, where Frankfurter adopted the
breaker as `frankfurter`, with a 404 recorded as a success for the same reason
and a 429 or 5xx logged but not counted; and the currency lookup and
verification in `CurrenciesService`, which ask the exchange rate provider chain
rather than calling a host) for that reason. Adopting one is: pick an id in `TRACKED_PROVIDERS`, call `assertAvailable` (or
`tryRequest`, where the caller's contract is a `null` rather than a throw)
before the request, `recordSuccess` on any response, `recordFailure` on a
rejection, and `logFailure` in the catch. Both gates take the exclusive
half-open probe slot, so every taker owes an outcome.

## Verification

| Claim | Test |
|---|---|
| The cause reaches the log line | `common/http/fetch-failure.util.spec.ts`, and end to end in `securities/yahoo-finance.service.spec.ts` ("logs what actually failed") |
| A dead provider stops being called | `yahoo-finance.service.spec.ts` ("stops calling an unreachable provider"), `provider-circuit.spec.ts` |
| One probe per window, escalating, capped | `provider-circuit.spec.ts` |
| A flood becomes one log line | `provider-health.service.spec.ts`, `yahoo-finance.service.spec.ts` |
| The episode start survives a restart | `provider-health.service.spec.ts` (the `CASE` is asserted in the SQL, because that is where the property lives) |
| A restart does not re-storm the indexes | `market-index.service.spec.ts` ("skips indexes attempted within the cooldown") |
| One alert per episode, per replica set, with the floor | `provider-outage-alert.service.spec.ts` |
| The provider's own error text cannot inject HTML | `email-templates.spec.ts` |
| Every guarded client is answerable to the breaker | `provider-health/provider-call.guard.spec.ts` |
| The episode start survives a restart, and three concurrent sweeps send one email | `test/integration/provider-health.integration.spec.ts`, against a real PostgreSQL |
| An empty answer is not a refusal, anywhere it gets cached | `msn-finance.service.spec.ts`, `security-price.service.spec.ts`, `exchange-rate.service.spec.ts` |
