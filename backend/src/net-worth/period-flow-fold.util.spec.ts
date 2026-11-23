import { addDaysYMD } from "../common/date-utils";
import { RateIndex } from "../common/time-series/rate-index.util";
import { FlowSubtotalRow, foldFlowSubtotals } from "./period-flow-fold.util";

const logger = { warn: jest.fn() };

describe("foldFlowSubtotals", () => {
  it("folds a period whose large flows cancel to exactly zero (Discussion #2343)", () => {
    // A hundred deposits of 300000000000.03 each withdrawn the next day. The
    // float scaling in FxAggregate left 0.0001 per pair, so this period's net
    // external flow came back 0.01.
    const rows: FlowSubtotalRow[] = [];
    for (let i = 0; i < 100; i++) {
      const day = addDaysYMD("2026-01-01", i * 2);
      rows.push({ date: day, currency: "USD", amount: 300_000_000_000.03 });
      rows.push({
        date: addDaysYMD(day, 1),
        currency: "USD",
        amount: -300_000_000_000.03,
      });
    }

    const flow = foldFlowSubtotals(rows, "USD", new Map(), logger);

    expect(flow.complete).toBe(true);
    expect(flow.value).toBe(0);
    expect(flow.missingPairs).toEqual([]);
  });

  it("folds cancelling flows converted at their own day's rate to zero", () => {
    // 400000000000.07 * 0.8 is 320000000000.056, which the float scaling
    // turned into 3200000000000560.5 ten-thousandths: the same residue on the
    // converted path.
    const rateIndex: RateIndex = new Map([
      ["CAD->USD", [{ date: "2026-01-01", rate: 0.8 }]],
    ]);
    const rows: FlowSubtotalRow[] = [
      { date: "2026-01-02", currency: "CAD", amount: 400_000_000_000.07 },
      { date: "2026-01-03", currency: "CAD", amount: -400_000_000_000.07 },
    ];

    const flow = foldFlowSubtotals(rows, "USD", rateIndex, logger);

    expect(flow.complete).toBe(true);
    expect(flow.value).toBe(0);
    expect(flow.gaps).toEqual([]);
  });
});
