---
title: "Issue #2245: currency detail page owns rate history, gap fill and spread"
author: Node
date: 2026-11-16
branch: claude/issue-2245
cost: { minutes: 48, tokens: 397555 }
touches:
  - website/docs/images/currency-detail.light.png
  - website/docs/images/currency-detail.png
  - website/docs/images/currency-rate-history.light.png
  - website/docs/images/currency-rate-history.png
  - "frontend/src/app/currencies/[code]/page.test.tsx"
  - "frontend/src/app/currencies/[code]/page.tsx"
  - frontend/src/app/currencies/page.tsx
  - frontend/src/components/currencies/RateHistoryCoverage.tsx
  - frontend/src/components/currencies/detail/CurrencyRateChart.test.tsx
  - frontend/src/components/currencies/detail/CurrencyRateChart.tsx
---

## Decided
- The Currencies list's "Rate history" action and dialog were removed; the row action is now Details (hidden for a delegate, shown for the reporting currency). RateHistoryCoverage lost its stored-rate list (`showStoredRates`) and gained `title`, `className`, `reportingCurrency`, `onFilled`; the detail page renders it in a "Stored Rates" card.
- "Only back to 2019" was STORED_RATE_ROW_CAP = 2000 (about 7.7 years of weekday rates), shared by the stored and transaction-rate listings. Raised to 20000 rather than adding server-side date filtering: the page still loads once and filters client-side.
- The chart's period preset lives in CurrencyRateHistorySection (keyed by code, so the per-currency localStorage key is re-read on a switch) and scopes chart, table and the new period cards.
- Average Spread = mean of |settled - market| / market. `marketRate` is set on each TransactionRate server-side via one getRateIndex plus resolveIndexedRate (INV-FX-001, 45-day carry). A transaction with null marketRate is counted as unmeasured, never averaged in.
## Tried and ruled out
- Reading the preferred currency (useExchangeRates) for the coverage card on the detail page: it can disagree with the server's usage.reportingCurrency and render an empty card. Pass it as a prop.
## Watch out
- A gap fill can finish after a currency switch. reloadRates must check shownCodeRef against its code, or the new currency's rates are blanked for good.
- A missingPairs entry FROM->TO names the posting currency, so the page's fill only fixes `${code}->...` pairs (summary.missingRatesElsewhere covers the rest).
- Docs screenshots here: the e2e backend OOMs building at 2 GB (set NODE_OPTIONS=--max-old-space-size=3072 in the override). The host Chromium lacks libglib, so run Playwright in mcr.microsoft.com/playwright:v1.65.0-noble with --network host.
- `trail check` gives about 20 lexical false positives on currency changes.
