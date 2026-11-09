---
title: "The sign-in brand panel rotates by a cookie, so every visit shows a different feature"
author: Ken
date: 2026-11-08
branch: main
id: l-f9f47545
scope: repo
status: active
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
  - frontend/src/app/globals.css
  - frontend/src/app/institutions/loading.tsx
---

## Decided
The split sign-in, register and first-run screens step through a fixed list of feature slides. A cookie holds the last index shown, so each visit moves to the next slide and a repeat is impossible until the list comes round. Only the screens that are first impressions opt in, through a prop on the auth shell; forgot-password, 2FA setup and the rest stay centred.

## Tried and ruled out
A random pick: with six slides it repeats one visit in six, and the request was for the content to change on each login. localStorage: the pre-login footprint is pinned by a guard test, and adding to it would mean widening that guard.

## Watch out
The panel pictures are generated from the documentation screenshots, so retaking a slide's screen means rerunning the generator. Screenshot capture while a dev stack holds ports 3000/3001 needs its own host ports, plus PUBLIC_APP_URL and CORS_ORIGIN pointed at the new frontend port. Filtering a capture to `2fa-login` alone fails, because it depends on the enrolment test before it.

In the code: frontend/src/components/auth/AuthBrandPanel.tsx, frontend/scripts/build-brand-screenshots.mjs, frontend/public/brand/.
