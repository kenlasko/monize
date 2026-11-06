import {
  ACCOUNT_A,
  SERIES_1,
  TODAY,
  flow,
  lot,
  security,
} from "../test-helpers/bond-valuation-fixtures";
import {
  buildInterestNotification,
  interestCandidates,
} from "./bond-notification-events";

/**
 * A coupon whose date is not a business day is paid on the next one
 * (`docs/specs/bond-marketable-primitives.md` 5.1): the flow's `date` is the day
 * the money arrives, `accrualEndDate` the unadjusted period end.
 */
describe("item 2, interest payment of an adjusted coupon", () => {
  const paying = (
    flows = [flow({ date: TODAY, accrualEndDate: "2026-10-11" })],
  ) =>
    security(
      [
        lot({
          quantity: 10,
          valuation: {
            asOf: "2026-10-10",
            knownCashflows: flows,
            projectedCashflows: [],
            maturityDate: "2029-10-13",
          },
        }),
      ],
      { asOf: "2026-10-10" },
    );

  it("is raised on the payment date, not on the unadjusted period end", () => {
    const candidates = interestCandidates(paying(), TODAY);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      accountId: ACCOUNT_A,
      instrumentId: SERIES_1,
      paymentDate: TODAY,
      amount: "51.00",
    });
    expect(
      buildInterestNotification(security([]), candidates[0]).dedupeKey,
    ).toBe(`bond:interest:${ACCOUNT_A}:${SERIES_1}:${TODAY}`);
  });

  it("is not raised for a coupon whose payment day has not come", () => {
    const later = paying([
      flow({ date: "2026-10-14", accrualEndDate: "2026-10-11" }),
    ]);
    expect(interestCandidates(later, TODAY)).toHaveLength(0);
  });

  it("leaves the last coupon, paid with the principal after an adjusted maturity, to the maturity items", () => {
    const v = paying([
      flow({ date: TODAY, accrualEndDate: "2026-10-11" }),
      flow({
        date: TODAY,
        accrualEndDate: "2026-10-11",
        type: "PRINCIPAL",
        amount: "1000.00",
      }),
    ]);
    const matured = {
      ...v,
      lots: v.lots.map((l) => ({
        ...l,
        valuation: { ...l.valuation, maturityDate: "2026-10-11" },
      })),
    };
    expect(interestCandidates(matured, TODAY)).toHaveLength(0);
  });
});
