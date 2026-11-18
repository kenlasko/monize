---
title: "US Treasury results XML: DFS layout since 2026-10-19 (#2263)"
author: Node
date: 2026-11-18
branch: claude/issue-2263
cost: { minutes: 14, tokens: 171858 }
touches:
  - backend/src/bonds/adapters/us/series/auction.ts
  - backend/src/bonds/adapters/us/series/fetch-series-recorded.spec.ts
  - backend/src/bonds/adapters/us/series/fetch-series.spec.ts
  - backend/src/bonds/adapters/us/series/fixtures/README.md
  - backend/src/bonds/adapters/us/series/fixtures/recorded/R_20261022_4.xml
  - backend/src/bonds/adapters/us/series/fixtures/recorded/R_20261028_1.xml
  - backend/src/bonds/adapters/us/series/fixtures/recorded/R_20261110_1.xml
  - backend/src/bonds/adapters/us/series/fixtures/recorded/R_20261112_2.xml
  - backend/src/bonds/adapters/us/series/fixtures/recorded/R_20261112_4.xml
  - backend/src/bonds/adapters/us/series/fixtures/recorded/search-912797WF0.json
---

## Decided
- parseResultsXml reads both Auction_v7_0_0 and DFS-TreasuryAuctionResults-v20260415, chosen by which section the file carries; DFS elements are looked up through the v7 names via a place table (group, element, index), so results-check.ts did not change.
- A TIPS DFS file has no HighPrice; AdjustedPrice is the fallback (v7 HighPrice == AdjustedPrice for TIPS, checked on 91282CRE3).
- TA_WS leaves a bill's inflationProtected/floatingRate blank since 2026-10-19: blank = No for a bill only, Yes on a bill = SOURCE_INCONSISTENT.

## Tried and ruled out
- The discussion's patch (elementOf over the whole TreasuryAuctionResults body) only fixes bills: coupon files have no FirstInterestPaymentDate, InflationIndexSecurity or RefCPIDatedDate in DFS.

## Watch out
- treasurydirect.gov is reachable from this sandbox (curl with a browser UA); record live answers into fixtures/recorded/ instead of constructing them.
- trail check flags verbatim TreasuryDirect fixtures on keyword matches (month end, rate/amount); those are false positives.
