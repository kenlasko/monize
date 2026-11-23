/**
 * The twelve worked cases of `docs/specs/portfolio-period-result.md` section
 * 10.5, table-driven over the pure decision.
 *
 * The adversarial case is (4): a large deposit the day before the window ends
 * moves the account-level value change by 50,000 and must move neither invested
 * figure by a cent. A `totalValue - cash` patch at the two boundaries passes
 * cases 1-4 and fails 5, 6, 7 and 9, which is why each of those carries its own
 * row here.
 */
import { addDaysYMD } from "../common/date-utils";
import {
  EMPTY_INVESTED_FLOW_DAY,
  InvestedFlowDay,
} from "./invested-capital-flow.util";
import {
  InvestedDayValue,
  investedPeriodResult,
} from "./invested-period-result.util";

const START = "2026-01-01";

/** A day's invested value, complete unless the case says otherwise. */
function day(
  date: string,
  securitiesValue: number,
  flags: Partial<InvestedDayValue> = {},
): InvestedDayValue {
  return {
    date,
    securitiesValue,
    fxComplete: true,
    pricesComplete: true,
    missingRatePairs: [],
    unpricedSecurityIds: [],
    ...flags,
  };
}

function flow(partial: Partial<InvestedFlowDay>): InvestedFlowDay {
  return { ...EMPTY_INVESTED_FLOW_DAY, ...partial };
}

/** `values[i]` is the close of day `START + i`; index 0 is the baseline `b`. */
function series(values: number[]): InvestedDayValue[] {
  return values.map((value, index) => day(addDaysYMD(START, index), value));
}

function dayOf(index: number): string {
  return addDaysYMD(START, index);
}

function run(
  values: number[],
  flows: Record<number, Partial<InvestedFlowDay>> = {},
  overrides: Partial<Parameters<typeof investedPeriodResult>[0]> = {},
) {
  const points = series(values);
  const flowsByDay = new Map<string, InvestedFlowDay>(
    Object.entries(flows).map(([index, value]) => [
      dayOf(Number(index)),
      flow(value),
    ]),
  );
  return investedPeriodResult({
    points,
    startIndex: 0,
    endIndex: points.length - 1,
    flowsByDay,
    ...overrides,
  });
}

describe("investedPeriodResult (spec section 10.5)", () => {
  it("nets a large buy and its sale to exactly zero (Discussion #2343)", () => {
    // 300000000000.03 * 10000 is 3000000000000300.5 in doubles, which the
    // float scaling rounded up for the buy and toward zero for the sale,
    // leaving a 0.0001 capital flow and a -0.0001 result.
    const result = run([0, 300_000_000_000.03, 0], {
      1: { capitalIn: 300_000_000_000.03 },
      2: { capitalOut: 300_000_000_000.03 },
    });

    expect(result.investmentCapitalFlows).toBe(0);
    expect(result.investmentPnl).toBe(0);
  });

  it("scales a day's buy and sale apart before netting them", () => {
    // 896107217744.2177 - 622315886394.1361 is 273791331350.08154 in doubles,
    // a unit short of the 273791331350.0816 the two legs net to; scaling the
    // difference read the period's result as -0.0001 instead of zero.
    const result = run([0, 273_791_331_350.0816], {
      1: { capitalIn: 896_107_217_744.2177, capitalOut: 622_315_886_394.1361 },
    });

    expect(result.investmentCapitalFlows).toBe(273_791_331_350.0816);
    expect(result.investmentPnl).toBe(0);
  });

  it("case 1: cash only -- nothing invested, nothing earned, a known zero", () => {
    // Deposit 10,000, no securities: IV is 0 on every day of the month.
    const result = run(Array.from({ length: 31 }, () => 0));

    expect(result.investmentPnl).toBe(0);
    expect(result.investmentReturnPercent).toBe(0);
    expect(result.investedComplete).toBe(true);
    // A window that never held an investment has no money-weighted rate to
    // report -- every flow of its schedule is zero -- and says so rather than
    // printing the P&L's honest zero under a rate's caption (section 11.5).
    expect(result.investmentMoneyWeightedReturnPercent).toBeNull();
    expect(result.investedReasons).toEqual(["mwrUndefined"]);
  });

  it("case 2: a deposit invested at once is a capital flow, not a gain", () => {
    // d1 buys 8,000 of a security; 2,000 of the deposit stays as cash.
    const result = run([0, 8_000, 8_000, 8_000], { 1: { capitalIn: 8_000 } });

    expect(result.investmentCapitalFlows).toBe(8_000);
    expect(result.investmentPnl).toBe(0);
    expect(result.investmentReturnPercent).toBe(0);
  });

  it("case 3: a 10% gain is 10%, not 8% -- the idle cash is in no base", () => {
    const result = run([0, 8_000, 8_800, 8_800], { 1: { capitalIn: 8_000 } });

    expect(result.investmentPnl).toBe(800);
    expect(result.investmentReturnPercent).toBe(10);
  });

  it("case 4: a 50,000 deposit the day before the end changes neither figure", () => {
    // The deposit is cash. It is in no IV, no capital flow and no income, so
    // the figures are identical to case 3 to the cent. (The account-level
    // valueChange moves by 50,000; that is the other measure's business.)
    const invested = run([0, 8_000, 8_800, 8_800], { 1: { capitalIn: 8_000 } });
    // The deposit lands on the second-to-last day and is left uninvested, so
    // IV does not move on it while the account's own value jumps by 50,000.
    const withDeposit = run([0, 8_000, 8_800, 8_800, 8_800], {
      1: { capitalIn: 8_000 },
    });

    expect(withDeposit.investmentPnl).toBe(invested.investmentPnl);
    expect(withDeposit.investmentReturnPercent).toBe(
      invested.investmentReturnPercent,
    );
    expect(withDeposit.investmentPnl).toBe(800);
    expect(withDeposit.investmentReturnPercent).toBe(10);
  });

  it("a reinvested dividend is income and capital at once, and moves no return", () => {
    // Discussion #1670. 10,000 bought on d1; a 200 dividend reinvested on d2
    // at an unchanged price, so IV rises to 10,200 with no external flow.
    const values = [0, 10_000, 10_200, 10_200];
    const reinvested = run(values, {
      1: { capitalIn: 10_000 },
      2: { reinvestedIncome: 200 },
    });
    // The same ledger before reinvestments were counted as income.
    const unclassified = run(values, { 1: { capitalIn: 10_000 } });

    // The distribution is printed as income, and as the purchase it funded.
    expect(reinvested.investmentIncome).toBe(200);
    expect(reinvested.investmentCapitalFlows).toBe(10_200);
    // So the three figures still add up: 10,200 - 10,200 + 200 = 200.
    expect(reinvested.investedValueChange).toBe(10_200);
    expect(reinvested.investmentPnl).toBe(200);
    // And the result and both rates are the ones the shares in IV already gave.
    expect(reinvested.investmentPnl).toBe(unclassified.investmentPnl);
    expect(reinvested.investmentReturnPercent).toBe(2);
    expect(reinvested.investmentReturnPercent).toBe(
      unclassified.investmentReturnPercent,
    );
    expect(reinvested.investmentMoneyWeightedTotalPercent).toBe(
      unclassified.investmentMoneyWeightedTotalPercent,
    );
  });

  it("case 5: a second purchase at an unchanged price changes neither figure", () => {
    // 8,000 in, up 10% to 8,800, then 4,000 more at an unchanged price.
    const result = run([0, 8_000, 8_800, 12_800, 12_800], {
      1: { capitalIn: 8_000 },
      3: { capitalIn: 4_000 },
    });

    expect(result.investmentCapitalFlows).toBe(12_000);
    expect(result.investmentPnl).toBe(800);
    // The purchase day's factor is (12,800) / (8,800 + 4,000) = 1.
    expect(result.investmentReturnPercent).toBe(10);
  });

  it("case 6: a full sale inside the window keeps the gain it realised", () => {
    // Buy 8,000 on d1, sell the lot for 9,000 on d3.
    const result = run([0, 8_000, 8_000, 0, 0], {
      1: { capitalIn: 8_000 },
      3: { capitalOut: 9_000 },
    });

    expect(result.investmentCapitalFlows).toBe(-1_000);
    expect(result.investmentPnl).toBe(1_000);
    // (0 + 9,000) / 8,000 = 1.125. Under a pure start-of-day flow convention
    // the base would be 8,000 - 9,000 = -1,000 and this day -- the one that
    // realised the whole gain -- would drop out of the chain.
    expect(result.investmentReturnPercent).toBe(12.5);
  });

  it("case 7: the proceeds sitting as cash earn nothing afterwards", () => {
    const sold = run([0, 8_000, 8_000, 0, 0], {
      1: { capitalIn: 8_000 },
      3: { capitalOut: 9_000 },
    });
    const andWaited = run([0, 8_000, 8_000, 0, 0, 0, 0, 0], {
      1: { capitalIn: 8_000 },
      3: { capitalOut: 9_000 },
    });

    expect(andWaited.investmentPnl).toBe(sold.investmentPnl);
    expect(andWaited.investmentReturnPercent).toBe(
      sold.investmentReturnPercent,
    );
  });

  it("case 8: a dividend is return although it ends up as cash", () => {
    const result = run([8_000, 8_000, 8_000], { 2: { income: 100 } });

    expect(result.investmentIncome).toBe(100);
    expect(result.investmentPnl).toBe(100);
    // (8,000 + 100) / 8,000 - 1 = 1.25%.
    expect(result.investmentReturnPercent).toBe(1.25);
  });

  it("case 9: a position closed before today is still in the window", () => {
    // X: 5,000 in on d1, 6,000 on d2, sold for 6,000 on d3. Y: 6,000 in on d4,
    // 6,600 on d5. A reconstruction from today's holdings would report only Y.
    const result = run([0, 5_000, 6_000, 0, 6_000, 6_600], {
      1: { capitalIn: 5_000 },
      3: { capitalOut: 6_000 },
      4: { capitalIn: 6_000 },
    });

    expect(result.investmentCapitalFlows).toBe(5_000);
    expect(result.investmentPnl).toBe(1_600);
    // 1.2 on X's gain day, 1.1 on Y's: 1.32 - 1 = 32%.
    expect(result.investmentReturnPercent).toBe(32);
  });

  it("case 10: an internal share transfer is factor 1 and no net flow", () => {
    // Both legs are in scope, so the day carries capital in AND out at the same
    // value while IV does not move.
    const result = run([10_000, 10_000, 10_000], {
      1: { capitalIn: 3_000, capitalOut: 3_000 },
    });

    expect(result.investmentCapitalFlows).toBe(0);
    expect(result.investmentPnl).toBe(0);
    expect(result.investmentReturnPercent).toBe(0);
  });

  it("case 11: the figures are read in whatever currency the caller folded to", () => {
    // Conversion happens before this function: IV per day, each K and I at its
    // own day. What it must not do is re-derive anything from a single rate --
    // the same numbers in a second currency give the same percentage.
    const inCad = run([0, 8_000, 8_800], { 1: { capitalIn: 8_000 } });
    const inEur = run([0, 4_000, 4_400], { 1: { capitalIn: 4_000 } });

    expect(inEur.investmentReturnPercent).toBe(inCad.investmentReturnPercent);
    expect(inEur.investmentPnl).toBe(400);
  });

  it("case 12: a missing price inside the window withholds both figures", () => {
    const points = series([0, 8_000, 8_800, 8_800]);
    points[2] = day("2026-01-03", 8_800, {
      pricesComplete: false,
      unpricedSecurityIds: ["sec-1"],
    });

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: points.length - 1,
      flowsByDay: new Map([["2026-01-02", flow({ capitalIn: 8_000 })]]),
    });

    expect(result.investmentPnl).toBeNull();
    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investedReasons).toContain("incompletePrices");
  });

  it("case 12: a capital row that would not convert withholds both figures", () => {
    const result = run([0, 8_000, 8_800], {
      1: {
        capitalIn: 8_000,
        complete: false,
        missingPairs: ["EUR->CAD"],
      },
    });

    expect(result.investmentCapitalFlows).toBeNull();
    expect(result.investmentIncome).toBeNull();
    expect(result.investmentPnl).toBeNull();
    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investedReasons).toContain("missingRatePairs");
  });

  it("reports the boundary's own causes when the start day is a subtotal", () => {
    const points = series([0, 8_000]);
    points[0] = day(START, 0, { fxComplete: false });

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: 1,
      flowsByDay: new Map(),
    });

    expect(result.investmentPnl).toBeNull();
    expect(result.investedReasons).toContain("missingRatePairs");
  });

  it("does not read cashComplete: cash is in no invested figure", () => {
    // The point carries a cash gap, which withholds the ACCOUNT-level value
    // change and must not withhold these figures: no cash is in IV.
    const points = series([8_000, 8_800]).map((point) => ({
      ...point,
      cashComplete: false,
      unknownCashAccountIds: ["cash-1"],
    }));

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: 1,
      flowsByDay: new Map(),
    });

    expect(result.investmentPnl).toBe(800);
    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investedComplete).toBe(true);
  });

  it("has no ratio for a result with no invested capital behind it", () => {
    // A distribution on a day IV was zero throughout: the money is known, the
    // ratio is not, and 0% would be a claim that nothing happened.
    const result = run([0, 0], { 1: { income: 100 } });

    expect(result.investmentPnl).toBe(100);
    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investedReasons).toContain("zeroStart");
  });

  it("is noValueSeries for a window the series does not cover", () => {
    const result = investedPeriodResult({
      points: [],
      startIndex: 0,
      endIndex: 0,
      flowsByDay: new Map(),
    });

    expect(result.investedReasons).toEqual(["noValueSeries"]);
    expect(result.investmentPnl).toBeNull();
    expect(result.investmentReturnMethod).toBe("twr");
  });
});

/**
 * `investedValueChange` is the difference a value chart draws: its last point
 * less its first. It is two-ended, so it survives everything that withholds the
 * P&L between the two boundaries, and it reconciles with the P&L exactly
 * wherever both are known: `change - capital + income === pnl`.
 */
describe("investedPeriodResult, investedValueChange", () => {
  /** Every section 10.5 case that reports a P&L, as run() inputs. */
  const reconcilable: Array<{
    name: string;
    values: number[];
    flows: Record<number, Partial<InvestedFlowDay>>;
  }> = [
    { name: "case 1", values: [0, 0, 0], flows: {} },
    {
      name: "case 2",
      values: [0, 8_000, 8_000, 8_000],
      flows: { 1: { capitalIn: 8_000 } },
    },
    {
      name: "case 3",
      values: [0, 8_000, 8_800, 8_800],
      flows: { 1: { capitalIn: 8_000 } },
    },
    {
      name: "case 5",
      values: [0, 8_000, 8_800, 12_800, 12_800],
      flows: { 1: { capitalIn: 8_000 }, 3: { capitalIn: 4_000 } },
    },
    {
      name: "case 6",
      values: [0, 8_000, 8_000, 0, 0],
      flows: { 1: { capitalIn: 8_000 }, 3: { capitalOut: 9_000 } },
    },
    {
      name: "case 8",
      values: [8_000, 8_000, 8_000],
      flows: { 2: { income: 100 } },
    },
    {
      name: "case 9",
      values: [0, 5_000, 6_000, 0, 6_000, 6_600],
      flows: {
        1: { capitalIn: 5_000 },
        3: { capitalOut: 6_000 },
        4: { capitalIn: 6_000 },
      },
    },
    {
      name: "case 10",
      values: [10_000, 10_000, 10_000],
      flows: { 1: { capitalIn: 3_000, capitalOut: 3_000 } },
    },
    { name: "no invested base", values: [0, 0], flows: { 1: { income: 100 } } },
    {
      name: "fractional cents",
      values: [1_000.1234, 1_050.5678, 1_101.0101],
      flows: { 1: { capitalIn: 20.0001 }, 2: { income: 0.3333 } },
    },
  ];

  it.each(reconcilable)(
    "$name: the change less capital plus income is the P&L",
    ({ values, flows }) => {
      const result = run(values, flows);

      expect(result.investedValueChange).toBe(
        Math.round((values[values.length - 1] - values[0]) * 10000) / 10000,
      );
      expect(result.investmentPnl).not.toBeNull();
      const reconciled =
        (Math.round(result.investedValueChange! * 10000) -
          Math.round(result.investmentCapitalFlows! * 10000) +
          Math.round(result.investmentIncome! * 10000)) /
        10000;
      expect(reconciled).toBe(result.investmentPnl);
    },
  );

  it("is known when a day between the boundaries is a subtotal", () => {
    const points = series([0, 8_000, 8_800, 8_800]);
    points[2] = day("2026-01-03", 8_800, {
      pricesComplete: false,
      unpricedSecurityIds: ["sec-1"],
    });

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: points.length - 1,
      flowsByDay: new Map([["2026-01-02", flow({ capitalIn: 8_000 })]]),
    });

    expect(result.investmentPnl).toBeNull();
    expect(result.investedValueStart).toBeNull();
    expect(result.investedValueChange).toBe(8_800);
  });

  it("is known when a flow did not convert", () => {
    const unconverted = run([0, 8_000, 8_800], {
      1: { capitalIn: 8_000, complete: false, missingPairs: ["EUR->CAD"] },
    });

    expect(unconverted.investedValueChange).toBe(8_800);
  });

  it.each([
    { name: "start", index: 0 },
    { name: "end", index: 1 },
  ])("is null when the $name boundary is a subtotal", ({ index }) => {
    const points = series([8_000, 8_800]);
    points[index] = { ...points[index], fxComplete: false };

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: 1,
      flowsByDay: new Map(),
    });

    expect(result.investedValueChange).toBeNull();
  });

  it("does not read cashComplete", () => {
    const points = series([8_000, 8_800]).map((point) => ({
      ...point,
      cashComplete: false,
    }));

    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: 1,
      flowsByDay: new Map(),
    });

    expect(result.investedValueChange).toBe(800);
  });

  it("is null for a window with no series", () => {
    const result = investedPeriodResult({
      points: [],
      startIndex: 0,
      endIndex: 0,
      flowsByDay: new Map(),
    });

    expect(result.investedValueChange).toBeNull();
  });
});

/**
 * The money-weighted return of the same windows
 * (`docs/specs/portfolio-period-result.md` section 11.7).
 *
 * The adversarial case is (3): two equal purchases a year apart with the rise
 * in the second year. The TWR is 10% over the window (4.880885% a year) and the
 * XIRR is 6.52%, because more of the reader's money was invested while the rise
 * happened. An implementation that returned the TWR under this caption, or that
 * solved a rate over undated flows, passes cases 1, 2, 5 and 7 and fails this
 * one, case 4 and case 6.
 */
describe("investedPeriodResult, money-weighted (spec section 11.7)", () => {
  /** A flat series of `days + 1` closes, index 0 being the baseline. */
  const flat = (days: number, value: number): number[] =>
    Array.from({ length: days + 1 }, () => value);

  it("case 1: one purchase, +10% over a year, equals the TWR", () => {
    const values = flat(365, 1_000);
    values[365] = 1_100;
    const result = run(values);

    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investmentMoneyWeightedReturnPercent).toBe(10);
    expect(result.investmentMoneyWeightedTotalPercent).toBe(10);
    expect(result.investmentMoneyWeightedMethod).toBe("xirr");
    expect(result.investedReasons).toEqual([]);
  });

  it("case 2: the same +10% over two years annualises to 4.88%", () => {
    const values = flat(730, 1_000);
    values[730] = 1_100;
    const result = run(values);

    // The TWR is not annualised, which is why the card labels the two.
    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investmentMoneyWeightedReturnPercent).toBe(4.88);
    expect(result.investmentMoneyWeightedTotalPercent).toBe(10);
  });

  it("case 3: a second purchase before the rise beats the time-weighted rate", () => {
    const values = flat(730, 1_000);
    for (let i = 365; i <= 730; i++) values[i] = 2_000;
    values[730] = 2_200;
    const result = run(values, { 365: { capitalIn: 1_000 } });

    expect(result.investmentPnl).toBe(200);
    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investmentMoneyWeightedReturnPercent).toBe(6.52);
    expect(result.investmentMoneyWeightedTotalPercent).toBe(13.48);
  });

  it("case 4: a dividend halfway is credited for having arrived early", () => {
    const result = run(flat(730, 1_000), { 365: { income: 10 } });

    expect(result.investmentPnl).toBe(10);
    expect(result.investmentReturnPercent).toBe(1);
    expect(result.investmentMoneyWeightedReturnPercent).toBe(0.5);
    // 1.005012% over the window against the TWR's 1%: the money-weighted
    // measure also credits the reader for having had the distribution a year
    // before the end.
    expect(result.investmentMoneyWeightedTotalPercent).toBe(1.01);
  });

  it("case 5: a late cash deposit is in none of the flows it reads", () => {
    const values = flat(730, 1_000);
    for (let i = 365; i <= 730; i++) values[i] = 2_000;
    values[730] = 2_200;
    // The 50,000 deposited the day before the end is not an investment
    // transaction: no capital, no income, and not in IV. There is no field on
    // this input for it to arrive through, and case 3's answer is unchanged.
    const result = run(values, { 365: { capitalIn: 1_000 }, 729: {} });

    expect(result.investmentMoneyWeightedReturnPercent).toBe(6.52);
    expect(result.investmentPnl).toBe(200);
  });

  it("case 6: a full sale is measured from the sale, not from the cash after it", () => {
    const values = flat(730, 8_000);
    for (let i = 365; i <= 730; i++) values[i] = 0;
    const result = run(values, { 365: { capitalOut: 9_000 } });

    expect(result.investmentPnl).toBe(1_000);
    expect(result.investmentReturnPercent).toBe(12.5);
    expect(result.investmentMoneyWeightedReturnPercent).toBe(12.5);
    // The total extrapolates that rate over a second year which held nothing,
    // which is why no surface may caption it as what the reader made.
    expect(result.investmentMoneyWeightedTotalPercent).toBe(26.56);
  });

  it("case 7: an incomplete price inside the window withholds both figures", () => {
    const points = series(flat(365, 1_000));
    points[200] = day(points[200].date, 1_000, {
      pricesComplete: false,
      unpricedSecurityIds: ["sec-1"],
    });
    const result = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: points.length - 1,
      flowsByDay: new Map(),
    });

    expect(result.investmentReturnPercent).toBeNull();
    expect(result.investmentMoneyWeightedReturnPercent).toBeNull();
    expect(result.investmentMoneyWeightedTotalPercent).toBeNull();
    expect(result.investedReasons).toEqual(["incompletePrices"]);
  });

  it("case 8: a seven-day window reports the total and no annual rate", () => {
    const values = flat(7, 1_000);
    values[7] = 1_010;
    const result = run(values);

    // The rate exists -- 68.007541% a year -- and is exactly why it is not
    // printed: a 1% week is not a claim about a year.
    expect(result.investmentMoneyWeightedReturnPercent).toBeNull();
    expect(result.investmentMoneyWeightedTotalPercent).toBe(1);
    expect(result.investedReasons).toEqual(["windowTooShort"]);
    // The window's own figures are unaffected by the refusal.
    expect(result.investmentPnl).toBe(10);
    expect(result.investmentReturnPercent).toBe(1);
    expect(result.investedComplete).toBe(true);
  });

  it("withholds both figures for a window with no invested capital at all", () => {
    const result = run([0, 0], { 1: { income: 100 } });

    expect(result.investmentMoneyWeightedReturnPercent).toBeNull();
    expect(result.investmentMoneyWeightedTotalPercent).toBeNull();
    expect(result.investedReasons).toContain("zeroStart");
    // A withheld decision carries its own causes; "the rate is undefined too"
    // adds nothing to them (section 11.5).
    expect(result.investedReasons).not.toContain("mwrUndefined");
  });

  it("names the method even where every figure is withheld", () => {
    const result = investedPeriodResult({
      points: [],
      startIndex: 0,
      endIndex: 0,
      flowsByDay: new Map(),
    });

    expect(result.investmentMoneyWeightedMethod).toBe("xirr");
    expect(result.investmentMoneyWeightedReturnPercent).toBeNull();
  });
});
