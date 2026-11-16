---
title: "Four backend suites fail inside test:changed's own parallel run and pass when re-run alone"
author: Ken
date: 2026-11-16
branch: feat/frankfurter-v2-provider
cost: { minutes: 24, tokens: 125644 }
id: l-19968725
scope: repo
status: active
replaces: l-b71774c4
src: agent
touches:
  - backend/src/bank-sync/bank-sync.service.spec.ts
  - backend/src/currencies/providers/fx-provider-source.guard.spec.ts
  - backend/scripts/test-changed.mjs
---

## Watch out
- Backend `npm run test:changed` fails the same four suites on this machine. They fail when the frontend suite runs at the same time, and also when the backend run is alone. They pass every time they are re-run alone, on main and on a branch. The load of `test:changed`'s own parallel workers is enough to trip them:
  - simplefin.provider.spec.ts: `client.accounts` is called twice where once is expected.
  - bond-price.service.spec.ts: the R1 timing check (under 1000 ms) took about 1100 ms.
  - budget-alert.service.spec.ts.
  - yahoo-finance.service.spec.ts: three failures.
- Before treating these four as a regression, re-run them alone with `TZ=UTC npx jest <files>`. Only a failure that persists alone counts.

In the code: backend/scripts/test-changed.mjs; src/bonds/bond-price.service.spec.ts:455 (the 1000 ms bound)
