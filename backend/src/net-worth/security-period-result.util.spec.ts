/**
 * The worked cases of `docs/specs/investment-performance-report-period.md`
 * section 5, and the reconciliation that is the point of the split: the rows
 * plus the unattributed figure add up to `investedPeriodResult` over the
 * portfolio's own summed series.
 */
import { addDaysYMD } from "../common/date-utils";
import {
  EMPTY_INVESTED_FLOW_DAY,
  InvestedFlowDay,
  InvestedFlowRow,
} from "./invested-capital-flow.util";
import { investedPeriodResult } from "./invested-period-result.util";
import {
  SecurityPeriodDay,
  SecurityPeriodInput,
  priceChange,
  securityDaySeries,
  securityPeriodResults,
  splitSecurityIdsOf,
} from "./security-period-result.util";

const START = "2026-03-02";
const dayOf = (index: number) => addDaysYMD(START, index);

interface Holding {
  /** Shares at each day's close; 0 is "not held". */
  quantity: number[];
  /** The accepted close each day; `null` is "nothing priced it". */
  close: (number | null)[];
  /** Days whose value did not convert. */
  unconverted?: number[];
}

function daysFrom(holdings: Record<string, Holding>, length: number) {
  const days: SecurityPeriodDay[] = [];
  for (let i = 0; i < length; i++) {
    const quantities = new Map<string, number>();
    const closes = new Map<string, number | null>();
    const closeValues = new Map<string, number | null>();
    for (const [id, holding] of Object.entries(holdings)) {
      const qty = holding.quantity[i];
      if (qty === 0) continue;
      const close = holding.close[i];
      quantities.set(id, qty);
      closes.set(id, close);
      closeValues.set(
        id,
        close === null || holding.unconverted?.includes(i) ? null : qty * close,
      );
    }
    days.push({ date: dayOf(i), quantities, closes, closeValues });
  }
  return days;
}

function flows(byDay: Record<number, Partial<InvestedFlowDay>>) {
  return new Map<string, InvestedFlowDay>(
    Object.entries(byDay).map(([index, value]) => [
      dayOf(Number(index)),
      { ...EMPTY_INVESTED_FLOW_DAY, ...value },
    ]),
  );
}

const CASES: Record<string, Holding> = {
  A: { quantity: [10, 10, 10], close: [100, 105, 110] },
  B: { quantity: [0, 10, 10], close: [90, 100, 120] },
  C: { quantity: [10, 0, 0], close: [50, 60, 70] },
  D: { quantity: [10, 10, 10], close: [100, 100, 100] },
  F: { quantity: [10, 20, 20], close: [100, 50, 50] },
};

const FLOWS = new Map([
  ["B", flows({ 1: { capitalIn: 1000 } })],
  ["C", flows({ 1: { capitalOut: 600 } })],
  ["D", flows({ 1: { income: 30 } })],
]);
const UNATTRIBUTED = flows({ 1: { income: 5 } });

function input(
  overrides: Partial<SecurityPeriodInput> = {},
  holdings: Record<string, Holding> = CASES,
): SecurityPeriodInput {
  return {
    days: daysFrom(holdings, 3),
    flowsBySecurity: FLOWS,
    unattributedFlows: UNATTRIBUTED,
    splitSecurityIds: new Set(["F"]),
    securities: new Map(
      Object.keys(holdings).map((id) => [
        id,
        {
          symbol: `${id}${id}${id}`,
          name: `Security ${id}`,
          currencyCode: "USD",
        },
      ]),
    ),
    closeAt: (id, date) => {
      const holding = holdings[id];
      if (!holding) return null;
      const index = [0, 1, 2].find((i) => dayOf(i) === date);
      return index === undefined ? null : holding.close[index];
    },
    currency: "USD",
    ...overrides,
  };
}

function rowOf(result: ReturnType<typeof securityPeriodResults>, id: string) {
  const row = result.securities.find((r) => r.securityId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("securityPeriodResults", () => {
  const result = securityPeriodResults(input());

  it.each([
    // id, IV(b), IV(e), K, I, P&L, return, price change
    ["A", 1000, 1100, 0, 0, 100, 10, 10],
    ["B", 0, 1200, 1000, 0, 200, 20, 33.33],
    ["C", 500, 0, -600, 0, 100, 20, 40],
    ["D", 1000, 1000, 0, 30, 30, 3, 0],
    ["F", 1000, 1000, 0, 0, 0, 0, null],
  ])(
    "case %s: the spec's worked figures",
    (id, start, end, capital, income, pnl, percent, price) => {
      const row = rowOf(result, id as string);
      expect(row.investedValueStart).toBe(start);
      expect(row.investedValueEnd).toBe(end);
      expect(row.investmentCapitalFlows).toBe(capital);
      expect(row.investmentIncome).toBe(income);
      expect(row.investmentPnl).toBe(pnl);
      expect(row.investmentReturnPercent).toBeCloseTo(percent as number, 4);
      expect(row.priceChangePercent).toBe(price);
      expect(row.investedComplete).toBe(true);
    },
  );

  it("names each security and its quantities at both ends", () => {
    const c = rowOf(result, "C");
    expect(c).toMatchObject({
      symbol: "CCC",
      name: "Security C",
      securityCurrency: "USD",
      startQuantity: 10,
      // A position sold out inside the window is still a row.
      endQuantity: 0,
      startClose: 50,
      endClose: 70,
    });
    expect(rowOf(result, "B").startQuantity).toBe(0);
  });

  it("withholds the price change over a split and says why", () => {
    expect(rowOf(result, "F").priceChangeReason).toBe("splitInWindow");
  });

  it("reports the rows naming no security on their own (case G)", () => {
    expect(result.unattributedPnl).toBe(5);
  });

  it("adds up to the portfolio's own investedPeriodResult", () => {
    const days = input().days;
    const points = days.map((day) => {
      let total = 0;
      for (const value of day.closeValues.values()) total += value ?? 0;
      return { date: day.date, securitiesValue: total };
    });
    const portfolio = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: points.length - 1,
      flowsByDay: flows({
        1: { capitalIn: 1000, capitalOut: 600, income: 35 },
      }),
    });
    const rows = result.securities.reduce(
      (sum, row) => sum + Math.round((row.investmentPnl ?? NaN) * 10000),
      Math.round((result.unattributedPnl ?? NaN) * 10000),
    );
    expect(portfolio.investmentPnl).toBe(435);
    expect(rows / 10000).toBe(portfolio.investmentPnl);
  });

  it("drops the money-weighted figures and their causes", () => {
    for (const row of result.securities) {
      expect(row).not.toHaveProperty("investmentMoneyWeightedReturnPercent");
      expect(row.investedReasons).not.toContain("windowTooShort");
      expect(row.investedReasons).not.toContain("mwrUndefined");
    }
  });

  it("withholds only the row of the security nothing priced", () => {
    const split = securityPeriodResults(
      input(
        {},
        { ...CASES, A: { quantity: [10, 10, 10], close: [100, null, 110] } },
      ),
    );
    const a = rowOf(split, "A");
    expect(a.investmentPnl).toBeNull();
    expect(a.investedReasons).toContain("incompletePrices");
    expect(rowOf(split, "B").investmentPnl).toBe(200);
  });

  it("withholds a row whose value did not convert, naming the pair", () => {
    const split = securityPeriodResults(
      input(
        { currency: "CAD" },
        { ...CASES, D: { ...CASES.D, unconverted: [2] } },
      ),
    );
    expect(rowOf(split, "D").investmentPnl).toBeNull();
    expect(rowOf(split, "D").investedReasons).toContain("missingRatePairs");
  });

  it("lists a security with income in the window it never held", () => {
    const split = securityPeriodResults(
      input({
        flowsBySecurity: new Map([["X", flows({ 1: { income: 12 } })]]),
      }),
    );
    const x = rowOf(split, "X");
    expect(x.investmentPnl).toBe(12);
    // No capital was ever at risk: an amount with no ratio.
    expect(x.investmentReturnPercent).toBeNull();
    expect(x.symbol).toBeNull();
  });

  it("withholds the unattributed figure when one of its rows did not convert", () => {
    const split = securityPeriodResults(
      input({
        unattributedFlows: flows({
          1: { income: 5, complete: false, missingPairs: ["EUR->USD"] },
        }),
      }),
    );
    expect(split.unattributedPnl).toBeNull();
  });

  it("answers nothing for a window with no valued day", () => {
    expect(securityPeriodResults(input({ days: [] }))).toEqual({
      securities: [],
      unattributedPnl: null,
    });
  });
});

describe("securityDaySeries", () => {
  it("reads a day the security was not held as a known zero", () => {
    const days = daysFrom({ B: CASES.B }, 3);
    expect(securityDaySeries(days, "B", "USD->CAD")[0]).toEqual({
      date: dayOf(0),
      securitiesValue: 0,
    });
  });
});

describe("priceChange", () => {
  it.each([
    [100, 110, false, 10, null],
    [null, 110, false, null, "noStartClose"],
    [0, 110, false, null, "noStartClose"],
    [100, null, false, null, "noEndClose"],
    [100, 50, true, null, "splitInWindow"],
  ])("start %p, end %p, split %p", (start, end, split, percent, reason) => {
    expect(
      priceChange(
        start as number | null,
        end as number | null,
        split as boolean,
      ),
    ).toEqual({ priceChangePercent: percent, priceChangeReason: reason });
  });
});

describe("splitSecurityIdsOf", () => {
  const row = (action: string, securityId: string | null): InvestedFlowRow => ({
    date: dayOf(1),
    currency: "USD",
    action,
    securityId,
    total: 0,
    quantity: 2,
    price: null,
    commission: 0,
  });

  it("collects the securities a SPLIT row names, and no others", () => {
    expect([
      ...splitSecurityIdsOf([
        row("SPLIT", "F"),
        row("BUY", "A"),
        row("SPLIT", null),
      ]),
    ]).toEqual(["F"]);
  });
});
