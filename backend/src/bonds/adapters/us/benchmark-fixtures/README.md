# Fixtures of the US benchmark fetchers

Read by `../us-benchmark-fetchers.spec.ts`. No test touches the network. Both
files are CONSTRUCTED: the shell that wrote them could not reach
`api.bls.gov` or `www.treasurydirect.gov`. They prove the code path, not the live
format (country spec `docs/specs/us-treasury-securities.md` section 10); replace
a file with a recorded response and delete its line here.

| File | Status | What it is |
| --- | --- | --- |
| `bls-cuur0000sa0.json` | CONSTRUCTED | A BLS API v2 answer for series `CUUR0000SA0`: CPI-U NSA March 2026 330.213, April 333.020, May 335.123 (the three levels of the July 2026 TIPS table); the earlier months are invented; October 2025 is `-` (not published). Structure inferred: `status`, `Results.series[0].data[]` with `year`, `period`, `value`. |
| `ta-ws-auctioned-bills.json` | CONSTRUCTED | A `TA_WS` `auctioned?type=Bill` list: 13-week auctions of 2026-04-27 (discount 3.610, issue 2026-04-30, the first index of the FRN `91282CQM6`, see `series/fixtures/ta-ws-91282CQM6.json`), of 2026-05-04 (3.620) and of 2021-01-11 (0.095, 91 days: 0.095022819 %, example E11), plus a 26-week and a 52-week bill that the fetch must skip. The CUSIPs are invented. |
