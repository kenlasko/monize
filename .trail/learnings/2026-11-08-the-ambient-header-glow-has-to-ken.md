---
title: "The ambient header glow has to live on the page wrapper, because a body background is painted over"
author: Ken
date: 2026-11-08
branch: main
id: l-eb50fbb8
scope: repo
status: active
src: agent
touches:
  - docs/frontend/ui-conventions.md
  - frontend/src/app/accounts/loading.tsx
  - frontend/src/app/categories/loading.tsx
  - frontend/src/app/dashboard/loading.tsx
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/app/globals.css
  - frontend/src/app/institutions/loading.tsx
  - frontend/src/app/investments/loading.tsx
  - frontend/src/app/payees/loading.tsx
---

## Decided
The accent glow behind the page header is a background on the page wrapper (PageLayout and each route's loading wrapper), one radial wash from the blue ramp. It fades out 9rem down so it stops with the header.

## Tried and ruled out
The first version sat in the `body` background and never showed: SwipeShell and PageLayout both paint an opaque gray over the body, so it shipped invisible. It also used a second wash from the income token, dropped because the glow is meant to be the accent colour only.

Considered drawing the glow inside PageHeader. A negative z-index needs `isolate` on the header to stay above the wrapper's background, and that traps the help tooltip and any action-menu dropdown inside the header's stacking context, so they slide under the content below.

## Watch out
A wrapper with its own opaque background covers the glow; a new page shell needs the class too. Midnight and highcontrast deliberately keep it transparent.

In the code: frontend/src/app/globals.css (--ambient-glow, .page-ambient-glow), frontend/src/components/layout/PageLayout.tsx, the app/**/loading.tsx wrappers.
