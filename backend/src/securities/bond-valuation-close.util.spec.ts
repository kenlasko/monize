import {
  bondEngineClosePointOn,
  valuationClosePointOn,
} from "./bond-valuation-close.util";

/**
 * A26-M26 (A26-S14-01), INV-BOND-010: on a day the bond engine refused to
 * price (no row of that day), a linked security has no close -- not the
 * engine's close of an earlier day and not a lot's trade price.
 */
describe("bond-valuation-close.util", () => {
  // The engine priced 2026-10-13; it refused 2026-10-14 (a BUY with no series),
  // the day an imported trade at 100.00 was struck.
  const engine = [
    { date: "2026-10-12", close: 111.6 },
    { date: "2026-10-13", close: 111.62 },
  ];
  const trades = [{ date: "2026-10-14", close: 100 }];
  const linked = { bondProgramId: "prog-edo" };
  const quoted = { bondProgramId: null };

  it("reads a linked security's engine row on its own day", () => {
    expect(bondEngineClosePointOn(engine, "2026-10-13")).toEqual({
      date: "2026-10-13",
      close: 111.62,
    });
    expect(valuationClosePointOn(linked, engine, trades, "2026-10-13")).toEqual(
      { date: "2026-10-13", close: 111.62 },
    );
  });

  it("is null on a refused day: no carried engine close, no trade price", () => {
    expect(bondEngineClosePointOn(engine, "2026-10-14")).toBeNull();
    expect(
      valuationClosePointOn(linked, engine, trades, "2026-10-14"),
    ).toBeNull();
    expect(
      valuationClosePointOn(linked, engine, trades, "2026-10-15"),
    ).toBeNull();
  });

  it("is null with nothing stored", () => {
    expect(bondEngineClosePointOn(undefined, "2026-10-14")).toBeNull();
    expect(bondEngineClosePointOn([], "2026-10-14")).toBeNull();
  });

  it("keeps the carried close and the trade fallback for a quoted security", () => {
    // The newer of the two sources stands for the day (#1242).
    expect(valuationClosePointOn(quoted, engine, trades, "2026-10-14")).toEqual(
      {
        date: "2026-10-14",
        close: 100,
      },
    );
    expect(valuationClosePointOn(undefined, engine, [], "2026-10-15")).toEqual({
      date: "2026-10-13",
      close: 111.62,
    });
  });

  it("reads a marketable coupon security (marketPriceRequired) from the price the holding is valued at: the person's own price, carried to the day", () => {
    // The engine writes no row for such a security; the person entered 100.25
    // on 2026-10-12 and 101.5 on 2026-10-14 and nothing on 2026-10-13. The
    // newest close at or before the day stands, as for bondHoldingValue's price.
    const manual = [
      { date: "2026-10-12", close: 100.25 },
      { date: "2026-10-14", close: 101.5 },
    ];
    const tips = { bondProgramId: "prog-tips", marketPriceRequired: true };
    expect(valuationClosePointOn(tips, manual, [], "2026-10-13")).toEqual({
      date: "2026-10-12",
      close: 100.25,
    });
    expect(valuationClosePointOn(tips, manual, [], "2026-10-14")).toEqual({
      date: "2026-10-14",
      close: 101.5,
    });
    // A linked security the engine prices keeps the engine rule.
    expect(
      valuationClosePointOn(
        { bondProgramId: "prog-edo", marketPriceRequired: false },
        manual,
        [],
        "2026-10-13",
      ),
    ).toBeNull();
  });
});
