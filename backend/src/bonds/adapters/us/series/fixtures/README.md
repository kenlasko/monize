# Fixtures of the US series fetch

Read by `../fetch-series.spec.ts`, `../results-xml.spec.ts` and the golden specs.
No test touches the network. Country spec: `docs/specs/us-treasury-securities.md`
(section 10 lists what is still to verify against live responses).

| File | Status | What it is |
| --- | --- | --- |
| `R_20260428_1.xml` | RECORDED | The official results file of the 2-year FRN `91282CQM6` (auction 2026-04-28), saved verbatim from https://www.treasurydirect.gov/xml/R_20260428_1.xml on 2026-11-04. The only recorded file. |
| `ta-ws-912797WM5.json` | CONSTRUCTED | The `TA_WS` `search?cusip=912797WM5` answer for the 26-week bill of discussion kenlasko/monize#1908 (issue 2026-10-01, maturity 2027-04-01, 4.285 %, price 97.833694), built from the values reported there. Field names and value formats are inferred. |
| `R_20260929_1.xml` | CONSTRUCTED | The results file of that bill, the element structure of `R_20260428_1.xml` with the bill's values. |
| `ta-ws-91282CZK0.json` | CONSTRUCTED | A 2-year note with a semiannual coupon (3.75 %, dated and issued 2026-09-30, maturing 2028-09-30, first coupon 2027-03-31) and a reopening of it in the same array. The CUSIP is built to have a valid check digit; it names no real security. |
| `R_20260928_1.xml` | CONSTRUCTED | The results file of that note's original auction, the element structure of `R_20260428_1.xml` with the note's values. |
| `ta-ws-91282CQM6.json` | CONSTRUCTED | The `TA_WS` record of the recorded FRN, built from `R_20260428_1.xml` (no recorded JSON exists): issue 2026-04-30, maturity 2028-04-30, spread 0.103, first payment 2026-07-31, quarterly. Its first index is the 13-week auction of 2026-04-27 in `../../benchmark-fixtures/ta-ws-auctioned-bills.json`. |
| `ta-ws-912810FQ6.json` | CONSTRUCTED | A 30-year TIPS, 3-3/8 %, dated 2001-10-15, auctioned 2001-10-25, issued 2001-10-31, maturing 2032-04-15, Ref CPI of the dated date 177.50000, semiannual, first coupon 2002-04-15. The values follow the example of the primitives spec; the record is not a copy of a real auction and the field formats are inferred. |
| `R_20011025_1.xml` | CONSTRUCTED | The results file of that TIPS, the element structure of `R_20260428_1.xml` with the TIPS' values (`InflationIndexSecurity` Y, `RefCPIDatedDate`, `InterestRate`). |
| `ta-ws-912797WM5-par.json` | CONSTRUCTED | The record of the bill above with a high discount rate of 0.000000 and a high price of 100.000000, no results file: a bill auctioned at par, as Treasury did in 2020. Built from the 26-week bill's record; it is not a copy of a real auction. |

The constructed files use the field names of the live source (checked against
the recordings below on 2026-11-06); their values stay constructed because the
golden cases are computed from them.

`recorded/` holds answers saved verbatim from `www.treasurydirect.gov` on
2026-11-06, read by `../fetch-series-recorded.spec.ts`:

| File | What it is |
| --- | --- |
| `search-912797WM5.json`, `R_20260928_1.xml` | The 26-week bill of #1908 (issue 2026-10-01) and its results file. |
| `search-91282CRF0.json`, `R_20260812_2.xml` | A 10-year note, 4-5/8 %, with two reopenings, and its original auction's results. |
| `search-912810UW6.json`, `R_20260813_3.xml` | A 30-year bond, 5-1/8 %, with two reopenings, and its original auction's results. |
| `search-91282CRE3.json`, `R_20260723_3.xml` | A 10-year TIPS, 2-3/8 %, Ref CPI 333.96974, with one reopening, and its original auction's results. |
| `search-91282CQM6.json`, `R_20260428_1.xml` | The 2-year FRN above, with two reopenings. |
| `search-912810FQ6.json` | The 2032 TIPS of 2001; its record names no results file. |
| `search-13-week-bills.json` | `TA_WS/securities/search?securityType=Bill&securityTerm=13-Week&dateFieldName=issueDate&startDate=2026-09-01&endDate=2026-11-06`: ten weekly 13-week auctions, the query the benchmark fetch sends. |

What the live records do not carry, and how the fetch reads it instead: no
`firstInterestPaymentDate` (the first coupon is the regular date after the dated
date that `firstInterestPaymentLength` names, checked against the results file's
`FirstInterestPaymentDate`); no `auctionDate` (`competitiveAuctionCloseDate`); no
`highDiscountRate` (a bill's `highRate`). `auctioned?days=` returns at most 90
bills of every term whatever `days` asks, so the 13-week history comes from
`search` with a term and an issue-date range.
