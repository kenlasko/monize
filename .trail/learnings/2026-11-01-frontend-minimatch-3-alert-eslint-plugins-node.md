---
title: "Frontend minimatch 3 alert (eslint plugins): dismissed, not shimmed"
author: Node
date: 2026-11-01
branch: claude/issue-1982
cost: { minutes: 5, tokens: 34214 }
touches:
  - frontend/src/components/shared-expenses/SharedPrivateFinances.test.tsx
  - frontend/src/components/shared-expenses/SharedPrivateFinances.tsx
  - frontend/package-lock.json
---

## Decided
- Ken chose (issue #1982) to dismiss Dependabot #121 (GHSA-g3hv-75wg-m249, minimatch <11.0.1 in frontend/package-lock.json) as dev-only. The remaining copy is minimatch 3.1.5 under eslint 9, @eslint/eslintrc and eslint-plugin-react/jsx-a11y/import, whose latest releases still require ^3.1.2; lint patterns come from our own config, so no untrusted input reaches it.
- Code scanning #228 (js/xss-through-dom) in SharedPrivateFinances.tsx was fixed by encodeURIComponent on the <select>-derived group id in the href.

## Tried and ruled out
- eslint 10: depends on minimatch ^10.2.5, still in the vulnerable range.
- Overriding minimatch@3 to 11: the plugins call require('minimatch') as a function; 11 only has a named export. A local CJS shim was offered and not chosen.

## Watch out
- If the alert resurfaces, check whether the eslint plugins moved off minimatch 3 before proposing anything.
