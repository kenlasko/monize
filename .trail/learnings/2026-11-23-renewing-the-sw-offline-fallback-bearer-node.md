---
title: Renewing the SW offline-fallback Bearer exception (issue 2355)
author: Node
date: 2026-11-23
branch: claude/issue-2355
cost: { minutes: 2, tokens: 61504 }
touches:
  - ".github/workflows/ci.yml"
  - frontend/public/sw.js
  - frontend/src/test/sw-offline.test.ts
  - scripts/check-bearer-exceptions.mjs
---

## Decided
For issue #2355 (one overdue Bearer exception, `e717be7fe9c133adba7d48ccb371c6ba_0`, manual HTML sanitization in frontend/public/sw.js's offline-fallback builder): re-checked escapeHtml/SAFE_CSS_COLOR against current source and frontend/src/test/sw-offline.test.ts, confirmed the reasoning in the existing comment block still holds (no DOM/DOMPurify exists inside a service worker), and only moved the review-by date forward ~3 months (2026-11-19 -> 2027-02-21). Fingerprint and exclude-fingerprint list untouched. This matches a prior learning (l-3e21df60, 2026-11-03) on the same renewal pattern.

## Tried and ruled out
Did not touch the second exception mentioned in the issue's script output (173289a7a56f6f6b27dc2314746e9451_0, review-by 2026-11-26) — it's only a 14-day warning, not FAIL, and the issue's FAIL list named only the one overdue fingerprint. Scoped the change to exactly what was overdue.

## Watch out
`node scripts/check-bearer-exceptions.mjs` is the authoritative local check (fails on overdue, warns within 14 days) — run it before and after editing .github/workflows/ci.yml to confirm the FAIL clears and nothing else regressed. The same script's 14-day warning will likely recur as a separate issue soon for 173289a7a56f6f6b27dc2314746e9451_0 (due 2026-11-26) since it wasn't touched here.
