---
title: "Combobox picked-icon padding needs the ! variant"
author: Node
date: 2026-11-20
branch: claude/issue-2290
cost: { minutes: 9, tokens: 59161 }
touches:
  - frontend/src/components/ui/Combobox.test.tsx
  - frontend/src/components/ui/Combobox.tsx
---

## Decided
Combobox's picked-icon padding was plain `pl-9`/`pr-8`, inert under the unlayered `[type='text']` rule in globals.css; now `pl-9!`/`pr-8!` (issue #2290).

## Tried and ruled out
Trusting the class-name test alone: verified instead by compiling globals.css with `@tailwindcss/node` `compile(css).build([...])` and checking the `!important` output; a cheap check that needs no app stack.

## Watch out
`Input.tsx` has the same pattern (`prefix && 'pl-7'`, `isPassword && 'pr-10'`, and its own `px-3`), all outranked by the same rule; not fixed here.
