---
title: "npm audit gate: ACCEPTED_ADVISORIES for an unpatched advisory"
author: Node
date: 2026-11-18
branch: claude/issue-2263
cost: { minutes: 4, tokens: 70191 }
touches:
  - scripts/lib/npm-audit-gate.mjs
  - scripts/npm-audit-gate.test.mjs
  - scripts/npm-audit-gate.mjs
---

## Decided
- Ken chose (#2264) a narrow, dated exception over leaving NPM Audit red or stubbing @parcel/watcher: ACCEPTED_ADVISORIES in scripts/lib/npm-audit-gate.mjs, keyed on target dir + GHSA url + name + exact advisory range, with an expiry date.
- Each entry self-terminates: a changed range, a passed date, or an unused entry (the finding is gone) fails the directory.

## Tried and ruled out
- Pinning an older @parcel/watcher: older releases reach picomatch 2.x via micromatch, still in the vulnerable range.

## Watch out
- npm audit via objects may lack `severity` (the old self-test fixture did); treat anything but info/low/moderate as blocking.
- scripts/*.mjs use prettier defaults plus single quotes; `npx prettier@3 --single-quote --check` matches the existing style.
- `node scripts/npm-audit-gate.mjs backend frontend desktop` works from the lockfiles alone, no npm ci needed.
