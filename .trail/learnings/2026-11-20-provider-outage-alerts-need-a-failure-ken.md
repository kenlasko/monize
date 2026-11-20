---
title: "Provider outage alerts need a failure seen 15 minutes into the episode, not just a row still marked down"
author: Ken
date: 2026-11-20
branch: main
cost: { minutes: 9, tokens: 116685 }
id: l-bd8d20b7
scope: repo
status: active
src: agent
touches:
  - backend/src/notifications/provider-outage-alert.service.ts
  - backend/src/provider-health/providers.ts
---

## Decided
The outage alert only fires when a failure was recorded at least 15 minutes after the episode began. A `down` row on its own proves nothing: the state only changes when something calls the provider, so one failed burst followed by silence stays `down` indefinitely and used to read as a 15-minute outage.

The trigger was Monize for Windows waking from sleep. The overdue price/FX/index jobs fire in the same second the network comes back, every lookup fails with `getaddrinfo ENOTFOUND` (Yahoo, MSN, Frankfurter all at once), the breakers open, and nothing calls again until the app is opened. The 10-minute sweep then emailed "Yahoo Finance is not responding" for an outage that lasted seconds.

## Tried and ruled out
"A failure within the last 10 minutes" as the gate: an hourly or daily caller during a real outage would rarely land inside that window. "A failure 15 minutes after the start" holds for real outages because failed probes keep landing (breaker window doubles to a 15-minute cap).

## Watch out
`recordDataFailure` (bond benchmark feeds) writes the start and the failure in one call, and its caller runs once a weekday after already seeing 3 days of stale data. It backdates the start by `MIN_OUTAGE_MS` so it still meets the gate; any new single-shot caller of the health row needs the same.

In the code: claim WHERE in backend/src/notifications/provider-outage-alert.service.ts (`last_failure_at >= outage_started_at + MIN_OUTAGE_MS`); `MIN_OUTAGE_MS` now lives in backend/src/provider-health/providers.ts; Windows logs at %LOCALAPPDATA%\Monize\logs\backend.log and main.log ("LAN: this PC's network addresses changed" marks the wake).
