---
title: "Four backend suites fail under a loaded full test:changed run and pass alone, on main too"
author: Ken
date: 2026-11-16
branch: feat/frankfurter-v2-provider
cost: { minutes: 37, tokens: 258252 }
id: l-b71774c4
scope: repo
status: active
src: agent
touches:
  - frontend/src/i18n/messages/de/currencies.json
  - frontend/src/i18n/messages/de/currencyDetail.json
  - frontend/src/i18n/messages/es/currencies.json
  - frontend/src/i18n/messages/es/currencyDetail.json
  - frontend/src/i18n/messages/fr/currencies.json
  - frontend/src/i18n/messages/fr/currencyDetail.json
  - frontend/src/i18n/messages/hi/currencies.json
  - frontend/src/i18n/messages/hi/currencyDetail.json
  - frontend/src/i18n/messages/id/currencies.json
  - frontend/src/i18n/messages/id/currencyDetail.json
---

## Watch out
- If backend `npm run test:changed` runs while another heavy suite is also running (the frontend `test:changed` here), the following suites fail. All four pass when re-run alone, on both main and the branch, so treat them as load flakes, not regressions:
  - simplefin.provider.spec.ts: `client.accounts` is called twice where once is expected.
  - bond-price.service.spec.ts: the R1 timing check (under 1000 ms) took 1092 ms.
  - budget-alert.service.spec.ts.
  - yahoo-finance.service.spec.ts: three failures.
- Run the two layers' suites one after the other. Re-run only the named files with `npx jest <files>` to confirm before investigating.

In the code: backend/scripts/test-changed.mjs; src/bonds/bond-price.service.spec.ts:455 (the 1000 ms bound)
