---
title: Price-history fixtures at now - k days flake across DST (bars dated in the exchange zone)
author: Node
date: 2026-11-06
branch: claude/issue-2026
cost: { minutes: 3, tokens: 30025 }
touches:
  - backend/src/securities/security-price.service.spec.ts
---

## Decided
- In security-price.service.spec.ts, the daily-bar fixtures now sit at 16:00 UTC (midday New York under either offset), not at `now - k days`.
## Watch out
- barDate (providers/market-session.util.ts) dates a bar in the exchange's zone. A fixture timestamp at `Date.now() - k*DAY` lands between 04:00 and 05:00 UTC for part of each day, so in a window spanning a DST change two bars share one New York date and the service's per-date dedupe drops one. The test is red only in that hour, in the weeks after a DST change.
- Anchor any new multi-day bar fixture at a mid-session UTC hour.
