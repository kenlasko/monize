---
title: "Monize's privacy statement lists every outside service, instead of SignPath's ready-made no-network sentence"
author: Ken
date: 2026-11-16
branch: docs/code-signing-policy
cost: { minutes: 10, tokens: 119958 }
id: l-8ce6c8a8
scope: repo
status: active
src: agent
touches:
  - "frontend/src/app/currencies/[code]/page.test.tsx"
  - "frontend/src/app/currencies/[code]/page.tsx"
  - frontend/src/app/currencies/page.test.tsx
  - frontend/src/components/currencies/RateHistoryCoverage.test.tsx
  - frontend/src/components/currencies/RateHistoryCoverage.tsx
  - frontend/src/components/currencies/detail/CurrencyRateHistorySection.tsx
  - frontend/src/components/currencies/detail/CurrencyRateTable.tsx
  - frontend/src/components/currencies/detail/CurrencyPeriodSummary.test.tsx
  - frontend/src/components/currencies/detail/CurrencyPeriodSummary.tsx
  - frontend/src/i18n/messages/de/currencyDetail.json
---

## Decided
SignPath Foundation requires a privacy statement on the code signing policy, either its boilerplate ("This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it") or a link to the project's own. Monize links its own, because the boilerplate is false here: with no setup at all, the server fetches exchange rates (Frankfurter, Yahoo as fallback), checks GitHub for a new version (server every 12 hours, the Windows app at start), and sends a password-hash prefix to Have I Been Pwned when a password is set. The statement splits services into "contacted without any setup" and "contacted when you use a feature".

## Tried and ruled out
Using the boilerplate sentence: it contradicts those default calls, and the Foundation can reject or revoke a project on a false statement.

## Watch out
The list is a claim about the code. A new outbound provider, a changed default (e.g. a new FX or quote provider in the default chain, a new cron that fetches), or a new telemetry-like call must be added to the privacy statement in the same PR. The frontend makes no third-party requests (CSP connect-src 'self'); keep it that way or say so there.

In the code:
- PRIVACY.md (repo root); linked from README "Code Signing Policy", website/docs/windows.md "Code Signing Policy" and the site footer (website/index.html).
- Defaults behind the "no setup" rows: backend/src/currencies/providers/fx-provider.config.ts (DEFAULT_FX_PROVIDERS), backend/src/updates/updates.service.ts (UPDATE_CHECK_ENABLED, off in desktop/src/env.ts), backend/src/auth/password-breach.service.ts (HIBP, fails open), desktop/src/updater.ts (electron-updater).
