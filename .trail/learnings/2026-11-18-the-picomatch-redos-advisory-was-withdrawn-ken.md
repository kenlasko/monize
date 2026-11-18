---
title: "The picomatch ReDoS advisory was withdrawn, so its npm audit exception is gone"
author: Ken
date: 2026-11-18
branch: fix/drop-withdrawn-picomatch-advisory
cost: { minutes: 9, tokens: 19458 }
id: l-529c5c1b
scope: repo
status: active
replaces: l-a7f41f34
src: agent
touches:
  - scripts/lib/npm-audit-gate.mjs
  - frontend/package.json
---

## Decided
- GitHub withdrew GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7) on 2026-11-18. npm's advisory feed dropped it the same day, so `npm audit --omit=dev` reports nothing for picomatch 4.0.4. The ACCEPTED_ADVISORIES entry from #2264 was removed, and the list is now empty.
- The gate forced this: an unused entry fails its directory ("no longer matches any finding; remove it"), so NPM Audit went red on every PR the moment the advisory was withdrawn.

## Watch out
- When the gate says an accepted advisory no longer matches, check `gh api /advisories/<GHSA> --jq .withdrawn_at` before assuming a patched release shipped.
- The frontend's exact `picomatch` override (4.0.4) is unchanged; it no longer guards against anything known.

In the code: scripts/lib/npm-audit-gate.mjs (ACCEPTED_ADVISORIES), frontend/package.json overrides.picomatch.
