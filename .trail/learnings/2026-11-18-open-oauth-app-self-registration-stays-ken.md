---
title: Open OAuth app self-registration stays on; fix the phishing advisory by hardening consent the way other OAuth providers do
author: Ken
date: 2026-11-18
branch: feat/desktop-lan-access
cost: { minutes: 10, tokens: 55448 }
id: l-a1b3cda7
scope: repo
status: active
src: agent
touches:
  - backend/src/oauth/oauth-provider.service.ts
  - backend/src/oauth/consent-template.ts
  - backend/src/oauth/redirect-target.ts
---

## Decided
- OAuth Dynamic Client Registration stays open with no initial access token. MCP clients (Claude's "Add connector", IDE agents) register themselves, and GitHub/Google/Slack also let anyone create an app and rely on user consent. Ken's position: trust users to deny requests they didn't start, and make the consent screen honest instead of gating registration.
- GHSA-vmgq-326p-fprx (DCR phishing chain) is answered by: rejecting malformed registrations (redirect_uris must be https, loopback http, or a custom app scheme; client_name stripped of control/bidi chars, length-capped, not allowed to claim to be Monize), making the redirect host the consent page's headline with the self-chosen name secondary, putting the host in the new-grant notification, and adding a per-app "Connected apps" revoke list. The reporter's recommendation 1 (initial access token) is declined in the advisory with the MCP compatibility reason.

## Tried and ruled out
- A new env var to disable DCR: Ken doesn't want another admin toggle for this.
- A "Connect a new app" window the user must open in Settings before consent can be granted: no other OAuth provider works this way; extra friction for a non-standard defence.
- Pointing at REGISTRATION_ENABLED as the mitigation: it only gates Monize user signup (/auth/register and OIDC first-login account creation), not /oauth/reg. The phishing victim is an existing signed-in user, so it does nothing for this advisory. (It does block GHSA-r2wj, the delegate-claim 2FA bypass, which is fixed in v1.20.0 by af3e4097b.)

## Watch out
- oidc-provider 9.x only forces https redirect URIs for implicit-flow web clients, so code-flow DCR clients can register http://<any host> unless our validator refuses it.
- Until a per-grant revoke exists, the grant notification's only remedy is "change your password", which disconnects every app.

In the code:
- DCR config and the extraClientMetadata validator: backend/src/oauth/oauth-provider.service.ts (registration block ~L163, validator ~L226)
- Consent page heading and destination block: backend/src/oauth/consent-template.ts; destination formatting: backend/src/oauth/redirect-target.ts
- Already merged after v1.21.0, unreleased: 22d09c517 (throttle/expiry/sweep), 697379366 (grant notifications), df2fd0dff (MCP CORS)
