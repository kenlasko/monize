---
title: "Padding utilities lose on text and search inputs because the global form rules sit outside Tailwind's layers"
author: Ken
date: 2026-11-09
branch: feat/widget-domain-tints
id: l-b13b11e7
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/CustomizeDashboardModal.test.tsx
  - frontend/src/components/dashboard/CustomizeDashboardModal.tsx
  - frontend/src/components/help/HelpSearchDialog.test.tsx
  - frontend/src/components/help/HelpSearchDialog.tsx
  - frontend/src/app/globals.css
  - frontend/src/components/ui/Input.tsx
---

## Decided
To change the padding of a text or search input, use Tailwind's important modifier (`pl-10!`). The global form-element rules are unlayered CSS, and unlayered CSS outranks every layer, so a plain utility on the input is silently ignored whatever its specificity.

## Tried and ruled out
Reading the class list as proof. `pl-10` was on the element and unit tests passed, but jsdom applies no cascade, so a test can only pin the `!` modifier, not the rendered padding.

## Watch out
The same rule covers `text-sm` and any other property the global block sets. `Input`'s `prefix` (`pl-7`) and password (`pr-10`) padding are plain utilities and were not checked in a browser.

In the code: frontend/src/app/globals.css ("Form element styling"), frontend/src/components/help/HelpSearchDialog.tsx, frontend/src/components/ui/Input.tsx.
