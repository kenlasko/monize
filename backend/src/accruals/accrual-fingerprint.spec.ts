import { buildAccrualPlan } from "./accrual-allocation";
import {
  accrualPreviewFingerprint,
  AccrualSourceSnapshot,
} from "./accrual-fingerprint";

describe("accrual preview expectation", () => {
  const source: AccrualSourceSnapshot = {
    userId: "owner",
    transactionId: "transaction",
    splitId: null,
    revision: "rev-1",
    amount: "-1200",
    paymentDate: "2026-10-15",
    accountId: "account",
    currencyCode: "USD",
    currencyDecimals: 2,
    categoryId: "property-tax",
    payeeId: "county",
    payeeName: "County",
    description: "Tax",
    tagIds: ["home", "annual"],
    status: "UNRECONCILED",
    originalAmount: null,
    originalCurrencyCode: null,
    exchangeRate: null,
  };
  const period = { preset: "NTM" as const };
  const plan = buildAccrualPlan(source.paymentDate, source.amount, 2, period);
  const fingerprint = (value = source, revision: number | null = null) =>
    accrualPreviewFingerprint(value, "expense", period, plan, revision);

  it("is stable across equivalent decimal formatting and unordered tags", () => {
    expect(fingerprint()).toBe(
      fingerprint({
        ...source,
        amount: "-1200.0000",
        tagIds: ["annual", "home", "annual"],
      }),
    );
    expect(fingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { userId: "other" },
    { transactionId: "other" },
    { splitId: "split" },
    { revision: "rev-2" },
    { amount: "-2400" },
    { paymentDate: "2026-11-15" },
    { accountId: "other" },
    { currencyCode: "CAD" },
    { currencyDecimals: 3 },
    { categoryId: "other" },
    { payeeId: "other" },
    { payeeName: "Changed" },
    { description: "Changed" },
    { tagIds: ["home"] },
    { status: "VOID" },
    { originalAmount: "-1000" },
    { originalCurrencyCode: "EUR" },
    { exchangeRate: "1.2" },
  ])("changes when source fields change: %j", (update) => {
    expect(fingerprint({ ...source, ...update })).not.toBe(fingerprint());
  });
  it("detects schedule revision changes", () => {
    expect(fingerprint(source, 2)).not.toBe(fingerprint(source, 1));
    expect(fingerprint(source, 1)).not.toBe(fingerprint());
  });
  it("detects family, preset and allocation changes", () => {
    expect(
      accrualPreviewFingerprint(source, "income", period, plan, null),
    ).not.toBe(fingerprint());
    expect(
      accrualPreviewFingerprint(
        source,
        "expense",
        { preset: "CUSTOM", startMonth: plan.startMonth, monthCount: 12 },
        plan,
        null,
      ),
    ).not.toBe(fingerprint());
    const other = buildAccrualPlan(source.paymentDate, "-2400", 2, period);
    expect(
      accrualPreviewFingerprint(source, "expense", period, other, null),
    ).not.toBe(fingerprint());
  });
});
