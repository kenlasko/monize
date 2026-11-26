---
title: "E2E spec for provisional amounts (issue 2401): running Playwright here and seeding a rate"
author: Node
date: 2026-11-26
branch: claude/issue-2401
cost: { minutes: 22, tokens: 117791 }
touches:
  - e2e/testdata/provisional-amounts/eur-savings.qif
  - e2e/testdata/provisional-amounts/usd-checking.qif
  - e2e/tests/provisional-amounts.spec.ts
  - scripts/e2e-playwright.sh
---

## Decided
- The spec (e2e/tests/provisional-amounts.spec.ts) takes the FX rate from the real provider for a fixed past date (2025-01-15) and reads it back from the leg's exchangeRate. The e2e stack has no endpoint or DB port to write a rate, so assertions are relational: amount is about 100 x exchangeRate, not par, then exactly 90 after the EUR file.
- QIF fixtures are static files in e2e/testdata/provisional-amounts/. A directory named e2e/fixtures/ would sit beside fixtures.ts, so it was avoided.

## Tried and ruled out
- Seeding a rate through the API: the only exchange-rate writes are provider fetches (fill-gaps, refresh, backfill). A DB insert is impossible from the Playwright container.
- Running Playwright from the host: chromium lacks libglib here. scripts/e2e-playwright.sh also fails with EACCES because of the rootless uid mapping.

## Watch out
- Backend `nest build` in the e2e container OOMs at the default heap. Use a throwaway compose override outside the repo with NODE_OPTIONS=--max-old-space-size=4096 and `-p issue-<n>`.
- Run the spec with `docker run --rm --init --ipc=host --network host -e CI=1 -v $PWD:/work -w /work/e2e <image from scripts/e2e-playwright.sh> npx playwright test <file>`. CI=1 skips the webServer, which would try to start the stack again.
- The API returns money and rates as decimal strings ("90.00000000"). Convert with Number before toBe.
