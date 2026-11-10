---
title: Retaking docs screenshots in the rootless-Docker sandbox; estimate model after review
author: Node
date: 2026-11-10
branch: claude/issue-2096
cost: { minutes: 19, tokens: 137151 }
touches:
  - docs/future-plans/scheduled-amount-estimate-tasks.md
  - e2e/docs-screenshots/bills-and-deposits.spec.ts
  - website/docs/bills-and-deposits.html
  - website/docs/bills-and-deposits.md
  - website/docs/images/bills-calendar.light.png
  - website/docs/images/bills-calendar.png
  - website/docs/images/bills-deposits-page.light.png
  - website/docs/images/bills-deposits-page.png
  - website/docs/images/bills-edit-occurrence.light.png
  - website/docs/images/bills-edit-occurrence.png
---

## Decided
- The scheduled-amount estimate (issue #2096) admits a season or a trend only when the history shows it. Level = newest 3 payments, deseasonalized. The seasonal index is per-year month mean / year mean, used only when both years vary by at least 10% and agree (correlation >= 0.6). Growth applies only when the per-month YoY ratios have stdev <= 0.1, so a price step is a new level, not a trend. The reviewer's flat and price-step cases are pinned in amount-estimate.spec.ts.
- The docs screenshot spec switches the demo Hydro Bill to Estimate and first seeds the prior year of Hydro One payments through the API (the demo has only 12 months).

## Tried and ruled out
- `scripts/e2e-playwright.sh` as-is: its `--user $(id -u)` maps to a different uid under rootless Docker, so Playwright cannot mkdir in the mounted tree (EACCES). Run the same pinned image without `--user` (container root maps to the host user).
- The e2e stack with default heap: the backend's `nest build` OOMs at 2 GB. Add `NODE_OPTIONS: "--max-old-space-size=4096"` to the backend in the /tmp override file.

## Watch out
- Order: `up -d --build --wait`, then `npm run docs:admin`, then `docker compose exec -e DEMO_MODE=true backend node dist/database/seed.js`, then `npm run docs:screenshots -- docs-screenshots/<page>.spec.ts`. No ImageMagick or oxipng here, so the PNGs go in unoptimized.
