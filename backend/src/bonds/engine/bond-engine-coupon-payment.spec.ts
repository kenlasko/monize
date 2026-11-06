import { couponTerms, value, weekdays } from "@/test-helpers/bond-coupon-terms";
import { accrualEndOf } from "./bond-engine";

describe("payment adjustment (spec 5.1)", () => {
  const dates = {
    datedDate: "2026-04-17",
    firstCouponDate: "2026-10-17", // a Saturday
    maturityDate: "2027-04-17", // a Saturday
    rate: "0.05",
  };
  const adjusted = couponTerms({
    ...dates,
    paymentAdjustment: "NEXT_BUSINESS_DAY",
  });
  const plain = couponTerms(dates);
  const calendars = new Map([["TEST", weekdays]]);

  it("pays a coupon due on a Saturday on the Monday, accrual unchanged", () => {
    const v = value(adjusted, "2026-04-17", 100, "2026-04-17", calendars);
    expect(
      v.knownCashflows.map((f) => [f.date, f.accrualEndDate, f.type, f.amount]),
    ).toEqual([
      ["2026-10-19", "2026-10-17", "INTEREST", "250.00"],
      ["2027-04-19", "2027-04-17", "INTEREST", "250.00"],
      ["2027-04-19", "2027-04-17", "PRINCIPAL", "10000.00"],
    ]);
    expect(v.valuationComplete).toBe(true);
  });

  it("earns no extra interest for the days of the delay", () => {
    const withDelay = value(
      adjusted,
      "2026-04-17",
      100,
      "2026-04-17",
      calendars,
    );
    const without = value(plain, "2026-04-17", 100, "2026-04-17", calendars);
    expect(withDelay.knownCashflows.map((f) => f.amount)).toEqual(
      without.knownCashflows.map((f) => f.amount),
    );
    // and the accrued interest stops at the period end, not at the payment day
    expect(
      value(adjusted, "2026-04-17", 100, "2026-10-18", calendars)
        .accruedInterest,
    ).toBe(
      value(plain, "2026-04-17", 100, "2026-10-18", calendars).accruedInterest,
    );
  });

  it("keeps the coupon open until its payment day", () => {
    const v = value(adjusted, "2026-04-17", 100, "2026-10-18", calendars);
    expect(v.nextPayment.map((f) => [f.date, f.period])).toEqual([
      ["2026-10-19", 1],
    ]);
    expect(
      value(
        adjusted,
        "2026-04-17",
        100,
        "2026-10-19",
        calendars,
      ).nextPayment.map((f) => f.date),
    ).toEqual(["2027-04-19", "2027-04-19"]);
  });

  it("keeps a payment on a business day where it is, with no accrual date", () => {
    const v = value(
      couponTerms({
        datedDate: "2026-04-15",
        firstCouponDate: "2026-10-15", // a Thursday
        maturityDate: "2027-04-15", // a Thursday
        rate: "0.05",
        paymentAdjustment: "NEXT_BUSINESS_DAY",
      }),
      "2026-04-15",
      100,
      "2026-04-15",
      calendars,
    );
    expect(v.knownCashflows.map((f) => [f.date, f.accrualEndDate])).toEqual([
      ["2026-10-15", undefined],
      ["2027-04-15", undefined],
      ["2027-04-15", undefined],
    ]);
  });

  it("reads the accrual end of a flow, adjusted or not", () => {
    const v = value(adjusted, "2026-04-17", 100, "2026-04-17", calendars);
    expect(v.knownCashflows.map(accrualEndOf)).toEqual([
      "2026-10-17",
      "2027-04-17",
      "2027-04-17",
    ]);
    expect(
      accrualEndOf({
        date: "2026-10-15",
        type: "INTEREST",
        amount: "1.00",
        status: "KNOWN",
        period: 1,
      }),
    ).toBe("2026-10-15");
  });

  it("makes the terms incomplete when the calendar is unknown", () => {
    const v = value(adjusted, "2026-04-17", 100, "2026-04-17", new Map());
    expect(v.dataCompleteness.termsComplete).toBe(false);
    expect(v.valuationComplete).toBe(false);
    expect(v.knownCashflows[0]).toMatchObject({
      date: "2026-10-17",
      amount: "250.00",
    });
  });

  it("does not look at the calendar when payments are not adjusted", () => {
    const v = value(plain, "2026-04-17", 100, "2026-04-17", calendars);
    expect(v.knownCashflows.map((f) => f.date)).toEqual([
      "2026-10-17",
      "2027-04-17",
      "2027-04-17",
    ]);
  });
});
