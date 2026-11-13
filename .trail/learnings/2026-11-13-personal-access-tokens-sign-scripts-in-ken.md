---
title: "Personal access tokens sign scripts in to the REST API, but only on routes that opted in"
author: Ken
date: 2026-11-13
branch: claude/pat-rest-api
id: l-07ab5e5d
scope: repo
status: active
src: agent
touches:
  - backend/src/auth/guards/pat-access.guard.ts
  - backend/src/auth/pat-access/pat-bearer.ts
  - backend/src/auth/strategies/jwt.strategy.ts
  - backend/src/common/guards/csrf.guard.ts
  - backend/src/auth/guards/pat-access.routes.guard.spec.ts
---

## Decided
A PAT is the non-interactive credential for the REST API, for every sign-in type (password, 2FA, SSO or passkey); before this branch only the MCP endpoint accepted one and REST answered 401. Access is fail-closed: a controller is closed to tokens until it carries @AllowPat() and is added to the reviewed list. GET needs the read scope, anything else write. INV-AUTH-006.

## Tried and ruled out
- Scripted password login or copied session cookies: breaks on 2FA and SSO, and the session dies when a refresh is missed.
- A second passport strategy on 77 controllers: the existing one authenticates the token instead, so no controller changed its guard.
- Validating the token again in the strategy: it would let a token reach a route the policy refused. The strategy only trusts the guard's record.

## Watch out
- Opening a controller is not enough review. Mark @NoPat() any handler that approves on a person's behalf, changes alerting, bulk-rewrites by filter, checks a password, or spends on a paid provider; an independent review found eleven such handlers after the first pass.
- A token request must not count as the person being active (emergency-access clock).
- Existing tokens were minted for MCP, many with no expiry, and gain REST access on upgrade. Still an open decision, as is a write cap for REST.
- Shared expenses, bank sync and AI settings are closed only by default, not by the guard spec's directory list.

In the code:
- Policy: backend/src/auth/guards/pat-access.guard.ts; decorators in backend/src/auth/pat-access/pat-access.decorator.ts
- patBearerOf in backend/src/auth/pat-access/pat-bearer.ts is the one predicate the guard, JwtStrategy.authenticate and CsrfGuard share
- Reviewed lists: PAT_CONTROLLERS and PAT_READ_OVERRIDES in backend/src/auth/guards/pat-access.routes.guard.spec.ts
- Omitted expiresAt = DEFAULT_PAT_LIFETIME_DAYS (90); null = never
