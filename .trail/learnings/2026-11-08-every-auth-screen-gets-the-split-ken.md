---
title: "Every auth screen gets the split layout, and the brand panel rotates by a cookie so each visit differs"
author: Ken
date: 2026-11-08
branch: main
id: l-e93a4bf8
scope: repo
status: active
replaces: l-f9f47545
src: agent
touches:
  - docs/frontend/ui-conventions.md
  - docs/images/readme/dashboard.png
  - e2e/readme/02-desktop.spec.ts
  - frontend/src/app/accounts/loading.tsx
  - frontend/src/app/categories/loading.tsx
  - frontend/src/app/dashboard/loading.tsx
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/app/emergency-access/claim/page.tsx
  - frontend/src/app/globals.css
---

## Decided
The auth shell always sets the gradient brand panel beside the form from the `lg` breakpoint up, on every screen that uses it: sign-in, register, first-run setup, password reset and change, email verification, 2FA setup and the emergency-access claim. It was briefly opt-in for first impressions only; Ken asked for all of them, so the prop went away.

A cookie holds the last slide shown, so each visit moves to the next and a repeat is impossible until the list comes round.

## Tried and ruled out
A random pick: with six slides it repeats one visit in six, and the request was for the content to change on each login. localStorage: the pre-login footprint is pinned by a guard test, and adding to it would mean widening that guard.

## Watch out
The panel pictures are generated from the documentation screenshots, so retaking a slide's screen means rerunning the generator. The auth-shell guard expects the shell's source to keep the literal centring classes on its form column. Screenshot capture while a dev stack holds ports 3000/3001 needs its own host ports, plus PUBLIC_APP_URL and CORS_ORIGIN pointed at the new frontend port. Filtering a capture to `2fa-login` alone fails, because it depends on the enrolment test before it.

In the code: frontend/src/components/auth/AuthBrandPanel.tsx, frontend/src/components/auth/AuthShell.tsx, frontend/scripts/build-brand-screenshots.mjs, frontend/public/brand/.
