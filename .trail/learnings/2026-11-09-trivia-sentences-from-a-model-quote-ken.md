---
title: "Trivia sentences from a model quote figures through named placeholders, never digits of their own"
author: Ken
date: 2026-11-09
branch: feat/mobile-tab-bar
id: l-6f14a50b
scope: repo
status: active
src: agent
touches:
  - README.md
  - backend/eslint.config.mjs
  - backend/src/ai/ai.module.ts
  - backend/src/ai/context/prompt-templates.ts
  - backend/src/ai/entities/dashboard-trivia.entity.ts
  - backend/src/ai/trivia/dashboard-trivia.controller.spec.ts
  - backend/src/ai/trivia/dashboard-trivia.controller.ts
  - backend/src/ai/trivia/dashboard-trivia.service.spec.ts
  - backend/src/ai/trivia/dashboard-trivia.service.ts
  - backend/src/ai/trivia/trivia-facts.spec.ts
---

## Decided
The daily dashboard trivia is a server-built fact sheet. A model only writes the words, referring to each figure as a {placeholder}; a sentence holding a digit outside a placeholder, an unknown placeholder or one from the other topic is dropped. The browser fills the figures in with the reader's number format. Account and security names never go to the provider. A fact exists only when every figure in it is known. The greeting moved out of the two hero sets so it stays still while they slide.

## Tried and ruled out
Letting the model write the numbers, as in free-form insights: the figures would be whatever it typed, and locale formatting would be the model's too. Using Math.random to pick a sentence: banned in production source by a frontend guard, so the server shuffles and the client starts from the minute the page opened. Reusing ai_insights: it would fill the Insights page and share its cooldown.

## Watch out
On Auto both sets can be mounted, so `getByTestId("dashboard-hero")` can match two; the one on screen is the section not under `[inert]`. HeroHeadline must read HeroPanelActiveContext or both sets fight over the app header's collapsed title. pg_isready over the socket passes during Postgres init; check over TCP before running integration suites on a throwaway container.

In the code: backend/src/ai/trivia/, frontend/src/components/dashboard/useHeroCycle.ts, claim type DashboardTrivia, cron 30 6 * * *.
