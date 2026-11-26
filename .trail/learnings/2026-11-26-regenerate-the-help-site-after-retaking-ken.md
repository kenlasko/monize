---
title: "Regenerate the help site after retaking screenshots, because each page records its pictures' sizes"
author: Ken
date: 2026-11-26
branch: feat/occurrence-auto-post
cost: { minutes: 49, tokens: 525188 }
id: l-9dd53f79
scope: repo
status: active
src: agent
touches:
  - frontend/src/test/website-docs.test.ts
  - backend/src/notifications/bill-reminder.service.spec.ts
  - backend/src/notifications/bill-reminder.service.ts
  - backend/src/scheduled-transactions/scheduled-occurrence.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-occurrence.service.ts
  - backend/src/scheduled-transactions/scheduled-transaction-override.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-transaction-override.service.ts
  - backend/src/scheduled-transactions/scheduled-transactions.controller.spec.ts
  - backend/src/scheduled-transactions/scheduled-transactions.controller.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
---

## Decided
- After any docs-screenshot retake, run the website docs build again and commit the regenerated page with the pictures, because the page's HTML carries each picture's width and height; otherwise CI fails.
- A report test that triggers an export waits for the export to be enabled (the mocked ExportDropdown's `data-disabled="false"`), because the toolbar is on screen while the report is still loading and the mock does not honour `disabled`; on a slow CI runner the click exports zero rows ("expected [] to deeply equal [ Array(2) ]").

## Watch out
- Building the page before a retake that changes a picture's height (a few pixels is enough) passes locally at the time, then CI's website-docs test fails with "website/docs is out of date with its Markdown" once the new pictures land.

In the code: frontend `npm run docs:build` / `npm run docs:check`; the check is frontend/src/test/website-docs.test.ts; pictures in website/docs/images/.
- `waitFor` gives up after 1 s by default, so a probe delay above that fails the fixed test too; that is the probe, not the fix.

In the code: frontend/src/components/reports/MonthlySpendingTrendReport.test.tsx ("writes each month's server figure to the CSV"); the same mock shape appears in other report tests that click `export-csv`.

## Tried and ruled out
- Assuming the button only appears after loading: a 50 ms delayed response still passed, which looked like proof, but a 500 ms delay reproduces CI's exact failure. Test a race with a delay longer than the runner's slowest render, not a short one.
