---
title: "Never run Prettier on frontend files, and the loading Skeleton is not a ui/Skeleton module"
author: Ken
date: 2026-11-10
branch: feat/dashboard-hero-trivia
id: l-17d23b7c
scope: repo
status: active
src: agent
touches:
  - backend/src/ai/trivia/dashboard-trivia.service.spec.ts
  - backend/src/ai/trivia/dashboard-trivia.service.ts
  - docs/cron-jobs.md
  - docs/future-plans/dashboard-trivia.md
  - frontend/src/components/dashboard/DashboardHero.test.tsx
  - frontend/src/components/dashboard/DashboardHero.tsx
  - frontend/src/components/dashboard/TriviaWidget.test.tsx
  - frontend/src/components/dashboard/TriviaWidget.tsx
---

## Decided
Frontend files are formatted by ESLint alone: the pre-commit hook runs `eslint --fix` for frontend/ and Prettier only for e2e/. Format a frontend edit by hand to the surrounding style, single quotes and long lines included.

## Tried and ruled out
Running `npx prettier --write` on frontend components: with no frontend Prettier config it falls back to defaults, switches every quote to double and rewraps the whole file, burying a small change in a large diff. The fix was to restore the file from the last commit and reapply the edit by script.

## Watch out
frontend/CLAUDE.md names "Skeleton" as the loading placeholder, but there is no `@/components/ui/Skeleton` module and importing it fails the type check. Use the `animate-pulse skeleton-shimmer` classes, or the components in `LoadingSkeleton.tsx`.

In the code: .lintstagedrc.cjs (frontend: eslint --max-warnings=0 --fix; e2e: prettier --write), frontend/src/components/ui/LoadingSkeleton.tsx.
