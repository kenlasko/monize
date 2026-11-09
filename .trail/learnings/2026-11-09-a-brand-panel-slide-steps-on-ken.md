---
title: "A brand panel slide steps on per visit, and survives an immediate swap between screens of that visit"
author: Ken
date: 2026-11-09
branch: feat/first-impressions
id: l-17f012f3
scope: repo
status: active
src: agent
touches:
  - frontend/scripts/build-brand-screenshots.mjs
  - frontend/src/app/auth/callback/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/components/auth/AuthBrandPanel.test.tsx
  - frontend/src/components/auth/AuthBrandPanel.tsx
  - frontend/src/components/auth/AuthShell.tsx
  - frontend/src/components/layout/BootSplash.test.tsx
  - frontend/src/components/layout/BootSplash.tsx
  - website/scripts/fetch-screenshots.ps1
  - website/scripts/fetch-screenshots.sh
---

## Decided
A new auth panel keeps the current slide if the previous panel is still mounted or went away within a second. Otherwise it reads the cookie and steps on. So register into first-run setup keeps its picture, and signing out then back in still shows a new one.

## Tried and ruled out
Advancing on every mount: the picture jumped and replayed its animation right after submitting registration, because that step swaps the whole shell. Holding the slide for the life of the page: sign-out is a client navigation, so the next sign-in would repeat the same slide.

## Watch out
The new panel's state initializer runs during render, before the old panel's unmount cleanup, so "still mounted" has to count as the same visit or the hold never applies. Specs that mock js-cookie with only `set` crash once they render an auth shell; `get` is needed too.

In the code: frontend/src/components/auth/AuthBrandPanel.tsx (SAME_VISIT_MS).
