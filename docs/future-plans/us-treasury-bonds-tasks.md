# US Treasury securities: tasks

Plan: `docs/future-plans/us-treasury-bonds.md`.

## Phase 1: marketability, rounding basis, lot cost

- [x] `instrument.marketability` accepts `MARKETABLE`; `PURCHASE_AFTER_MATURITY` refusal (primitives 3)
- [x] `rounding.basis`, `unitDecimals`, `referenceAmount`; one `roundLot` (primitives 4)
- [x] `lot.cost` for a discount lot, `principalBasis` in the valuation and the split; the lot fold carries cost (primitives 6.1)
- [x] Price policy per marketability, `marketPriceRequired` (primitives 3); `docs/system-invariants.md` INV-BOND-005 text

## Phase 2: coupon dates and actual/actual

- [ ] Schedule `COUPON_DATES` with regular, short and long first periods, end of month, payment adjustment (primitives 5.1)
- [ ] Accrual `ACTUAL_ACTUAL_ICMA` (primitives 5.2, 5.3)
- [ ] `accruedInterestOn` (primitives 6.2)

## Phase 3: the US adapter, bills, notes, bonds

- [ ] Calendar `US`, CUSIP check digit, series code grammar, `programOf`
- [ ] Programs and templates BILL, NOTE, BOND; provider id `treasurydirect`
- [ ] TA_WS fetch with the cross-checks and bounds; fixtures
- [ ] Goldens `bill-cases.json`, `note-cases.json`
- [ ] Installed in `INSTALLED_BOND_ADAPTERS`; `FORBIDDEN` literals; i18n labels; quantity unit hint

## Phase 4: TIPS and FRN

- [ ] Principal rule `INDEX_RATIO`, unit `INDEX_LEVEL`, `US_CPI_U_NSA` fetcher, TIPS template, `tips-cases.json`
- [ ] Rate rule `DAILY_INDEX_PLUS_SPREAD`, accrual `ACTUAL_360_DAILY_SUM`, `US_TBILL_13W_MMY` fetcher, FRN template, `frn-cases.json`

## Phase 5: savings bonds (not started)

- [ ] Primitives of section 8; programs `I`, `EE`
