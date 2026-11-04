import {
  BondLotTransaction,
  bondLotsAsOf,
  bondLotsFromTransactions,
} from "./bond-lots";

const tx = (
  action: string,
  transactionDate: string,
  quantity: string | null,
  over: Partial<BondLotTransaction> = {},
): BondLotTransaction => ({
  action,
  status: "UNRECONCILED",
  transactionDate,
  quantity,
  pairedTransfer: false,
  ...over,
});

const lots = (rows: BondLotTransaction[]) => {
  const result = bondLotsFromTransactions(rows);
  if (result.lots === null) {
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.detail}`);
  }
  return result.lots;
};

describe("bondLotsFromTransactions (spec 12.2 truth table)", () => {
  describe("adds a lot dated the transaction", () => {
    it.each(["BUY", "REINVEST", "ADD_SHARES", "REINVEST_INTEREST"])(
      "%s",
      (action) => {
        expect(lots([tx(action, "2026-10-15", "25.00000000")])).toEqual([
          {
            purchaseDate: "2026-10-15",
            quantity: 25,
            instrumentId: null,
            purchaseDateAssumed: false,
            cost: null,
          },
        ]);
      },
    );
  });

  describe("transfers", () => {
    it("a linked TRANSFER_OUT / TRANSFER_IN pair changes nothing and keeps the lot's date", () => {
      expect(
        lots([
          tx("BUY", "2026-01-10", "10"),
          tx("TRANSFER_OUT", "2026-02-01", "10", { pairedTransfer: true }),
          tx("TRANSFER_IN", "2026-02-01", "10", { pairedTransfer: true }),
        ]),
      ).toEqual([
        {
          purchaseDate: "2026-01-10",
          quantity: 10,
          instrumentId: null,
          purchaseDateAssumed: false,
          cost: null,
        },
      ]);
    });

    it("an unlinked TRANSFER_IN is a lot dated the transfer, flagged assumed", () => {
      expect(lots([tx("TRANSFER_IN", "2026-03-01", "7")])).toEqual([
        {
          purchaseDate: "2026-03-01",
          quantity: 7,
          instrumentId: null,
          purchaseDateAssumed: true,
          cost: null,
        },
      ]);
    });

    it("an unlinked TRANSFER_OUT removes first-in first-out", () => {
      expect(
        lots([
          tx("BUY", "2026-01-10", "10"),
          tx("TRANSFER_OUT", "2026-02-01", "4"),
        ]),
      ).toEqual([
        {
          purchaseDate: "2026-01-10",
          quantity: 6,
          instrumentId: null,
          purchaseDateAssumed: false,
          cost: null,
        },
      ]);
    });
  });

  describe("lots are held per account (R6)", () => {
    const IKE = "acct-ike";
    const PLAIN = "acct-plain";
    const at = (account: string) => ({ accountId: account });
    const open = (rows: BondLotTransaction[]) =>
      lots(rows).map((l) => [l.accountId, l.purchaseDate, l.quantity]);

    it("a removal takes from the lots of its own account, not the oldest of another", () => {
      // The audit's case: IKE lot A (older), plain lot B; the plain account sells.
      expect(
        open([
          tx("BUY", "2026-10-01", "10", at(IKE)),
          tx("BUY", "2026-10-31", "10", at(PLAIN)),
          tx("SELL", "2027-04-01", "10", at(PLAIN)),
        ]),
      ).toEqual([[IKE, "2026-10-01", 10]]);
    });

    it("FIFO within the account: its oldest lot goes first", () => {
      expect(
        open([
          tx("BUY", "2026-01-01", "5", at(IKE)),
          tx("BUY", "2026-02-01", "5", at(PLAIN)),
          tx("BUY", "2026-03-01", "5", at(IKE)),
          tx("SELL", "2026-04-01", "6", at(IKE)),
        ]),
      ).toEqual([
        [PLAIN, "2026-02-01", 5],
        [IKE, "2026-03-01", 4],
      ]);
    });

    it("a removal larger than its account holds is OVER_REMOVAL even when another account holds enough", () => {
      const result = bondLotsFromTransactions([
        tx("BUY", "2026-01-01", "10", at(IKE)),
        tx("BUY", "2026-01-02", "10", at(PLAIN)),
        tx("SELL", "2026-02-01", "11", at(PLAIN)),
      ]);
      expect(result.lots).toBeNull();
      expect(result.refusal?.code).toBe("OVER_REMOVAL");
    });

    it("a paired transfer moves the lots FIFO to the destination, keeping their purchase dates", () => {
      expect(
        open([
          tx("BUY", "2026-01-10", "4", at(IKE)),
          tx("BUY", "2026-02-10", "6", at(IKE)),
          tx("TRANSFER_OUT", "2026-03-01", "7", {
            ...at(IKE),
            pairedTransfer: true,
            counterpartAccountId: PLAIN,
          }),
          tx("TRANSFER_IN", "2026-03-01", "7", {
            ...at(PLAIN),
            pairedTransfer: true,
            counterpartAccountId: IKE,
          }),
        ]).sort(),
      ).toEqual(
        [
          [IKE, "2026-02-10", 3],
          [PLAIN, "2026-01-10", 4],
          [PLAIN, "2026-02-10", 3],
        ].sort(),
      );
    });

    it("a later sale in the destination takes the oldest moved lot first, even if it arrived after a newer one", () => {
      expect(
        open([
          tx("BUY", "2026-05-01", "5", at(PLAIN)),
          tx("BUY", "2026-01-10", "5", at(IKE)),
          tx("TRANSFER_OUT", "2026-06-01", "5", {
            ...at(IKE),
            pairedTransfer: true,
            counterpartAccountId: PLAIN,
          }),
          tx("TRANSFER_IN", "2026-06-01", "5", {
            ...at(PLAIN),
            pairedTransfer: true,
            counterpartAccountId: IKE,
          }),
          tx("SELL", "2026-07-01", "5", at(PLAIN)),
        ]),
      ).toEqual([[PLAIN, "2026-05-01", 5]]);
    });

    it("moving more than the source holds is OVER_REMOVAL", () => {
      const result = bondLotsFromTransactions([
        tx("BUY", "2026-01-10", "4", at(IKE)),
        tx("TRANSFER_OUT", "2026-03-01", "5", {
          ...at(IKE),
          pairedTransfer: true,
          counterpartAccountId: PLAIN,
        }),
      ]);
      expect(result.refusal?.code).toBe("OVER_REMOVAL");
    });

    it("an unpaired TRANSFER_OUT removes from its account; an unpaired TRANSFER_IN adds an assumed lot there", () => {
      expect(
        open([
          tx("BUY", "2026-01-10", "5", at(IKE)),
          tx("TRANSFER_OUT", "2026-02-01", "2", at(IKE)),
          tx("TRANSFER_IN", "2026-03-01", "3", at(PLAIN)),
        ]),
      ).toEqual([
        [IKE, "2026-01-10", 3],
        [PLAIN, "2026-03-01", 3],
      ]);
    });

    it("rows with no account share one unnamed account (the old pooled behaviour)", () => {
      expect(
        open([
          tx("BUY", "2026-01-10", "5"),
          tx("BUY", "2026-02-10", "5"),
          tx("SELL", "2026-03-01", "6"),
        ]),
      ).toEqual([[undefined, "2026-02-10", 4]]);
    });
  });

  describe("removals are first-in first-out", () => {
    const buys = [tx("BUY", "2026-01-10", "10"), tx("BUY", "2026-02-10", "5")];

    it.each(["SELL", "REDEEM", "REMOVE_SHARES"])(
      "%s takes the oldest lot first and may span lots",
      (action) => {
        expect(lots([...buys, tx(action, "2026-03-01", "12")])).toEqual([
          {
            purchaseDate: "2026-02-10",
            quantity: 3,
            instrumentId: null,
            purchaseDateAssumed: false,
            cost: null,
          },
        ]);
      },
    );

    it("an exact removal closes the lot", () => {
      expect(lots([...buys, tx("SELL", "2026-03-01", "10")])).toEqual([
        {
          purchaseDate: "2026-02-10",
          quantity: 5,
          instrumentId: null,
          purchaseDateAssumed: false,
          cost: null,
        },
      ]);
    });

    it("everything sold leaves no lots, not a refusal", () => {
      expect(lots([...buys, tx("SELL", "2026-03-01", "15")])).toEqual([]);
    });
  });

  it("excludes VOID rows", () => {
    expect(
      lots([
        tx("BUY", "2026-01-10", "10", { status: "VOID" }),
        tx("BUY", "2026-02-10", "5"),
        tx("SELL", "2026-03-01", "99", { status: "VOID" }),
      ]),
    ).toEqual([
      {
        purchaseDate: "2026-02-10",
        quantity: 5,
        instrumentId: null,
        purchaseDateAssumed: false,
        cost: null,
      },
    ]);
  });

  it("ignores cash-only actions, whatever their quantity", () => {
    expect(
      lots([
        tx("BUY", "2026-01-10", "10"),
        tx("DIVIDEND", "2026-02-01", "3.5"),
        tx("INTEREST", "2026-02-02", null),
        tx("CAPITAL_GAIN", "2026-02-03", "1"),
      ]),
    ).toHaveLength(1);
  });

  it("reads NUMERIC text exactly: 25.00000000 is 25, and a zero quantity adds no lot", () => {
    expect(lots([tx("BUY", "2026-01-10", "25.00000000")])[0].quantity).toBe(25);
    expect(lots([tx("BUY", "2026-01-10", "0")])).toEqual([]);
  });

  describe("refuses, naming the reason, and returns no lots", () => {
    it("a SPLIT", () => {
      const result = bondLotsFromTransactions([
        tx("BUY", "2026-01-10", "10"),
        tx("SPLIT", "2026-02-01", "2"),
      ]);
      expect(result.lots).toBeNull();
      expect(result.refusal).toMatchObject({
        code: "SPLIT",
        params: { action: "SPLIT", date: "2026-02-01", quantity: "2" },
      });
      expect(result.refusal?.detail).toContain("2026-02-01");
    });

    it.each(["2.5", "10.00000001", "0.5"])(
      "a non-whole quantity (%s)",
      (quantity) => {
        const result = bondLotsFromTransactions([
          tx("BUY", "2026-01-10", quantity),
        ]);
        expect(result.lots).toBeNull();
        expect(result.refusal).toMatchObject({
          code: "FRACTIONAL_QUANTITY",
          params: { action: "BUY", date: "2026-01-10", quantity },
        });
      },
    );

    it("a removal larger than the open lots", () => {
      const result = bondLotsFromTransactions([
        tx("BUY", "2026-01-10", "10"),
        tx("SELL", "2026-02-01", "11"),
      ]);
      expect(result.lots).toBeNull();
      expect(result.refusal).toMatchObject({
        code: "OVER_REMOVAL",
        params: { action: "SELL", date: "2026-02-01", quantity: "11" },
      });
      expect(result.refusal?.detail).toContain("11");
      expect(result.refusal?.detail).toContain("10");
    });

    it("a removal with nothing held", () => {
      expect(
        bondLotsFromTransactions([tx("SELL", "2026-02-01", "1")]).refusal,
      ).toMatchObject({ code: "OVER_REMOVAL" });
    });

    it("names the base action of a refined row and its raw quantity", () => {
      expect(
        bondLotsFromTransactions([tx("REINVEST_INTEREST", "2026-03-01", "1.5")])
          .refusal,
      ).toMatchObject({
        params: { action: "REINVEST", date: "2026-03-01", quantity: "1.5" },
      });
      expect(
        bondLotsFromTransactions([tx("BUY", "2026-01-10", null)]).refusal,
      ).toMatchObject({ params: { quantity: null } });
    });

    it.each([null, "-5", "abc", "99999999999999999999"])(
      "a quantity that cannot be counted (%s)",
      (quantity) => {
        expect(
          bondLotsFromTransactions([tx("BUY", "2026-01-10", quantity)]).refusal,
        ).toMatchObject({ code: "INVALID_QUANTITY" });
      },
    );

    it("a VOID split or fractional row does not refuse", () => {
      expect(
        lots([
          tx("BUY", "2026-01-10", "10"),
          tx("SPLIT", "2026-02-01", "2", { status: "VOID" }),
          tx("BUY", "2026-02-02", "1.5", { status: "VOID" }),
        ]),
      ).toHaveLength(1);
    });
  });

  it("does not modify the rows it was handed and returns new lot objects", () => {
    const rows = [tx("BUY", "2026-01-10", "10"), tx("SELL", "2026-02-01", "3")];
    const before = JSON.stringify(rows);
    const first = lots(rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(lots(rows)).toEqual(first);
    expect(lots(rows)[0]).not.toBe(first[0]);
  });

  describe("bondLotsAsOf", () => {
    const rows = [
      tx("BUY", "2026-01-10", "10"),
      tx("BUY", "2026-02-10", "5"),
      tx("SELL", "2026-03-01", "12"),
      tx("SPLIT", "2026-04-01", "2"),
    ];

    it("is the fold of the rows up to and including the date", () => {
      expect(bondLotsAsOf(rows, "2026-01-09").lots).toEqual([]);
      expect(bondLotsAsOf(rows, "2026-02-09").lots).toEqual([
        {
          purchaseDate: "2026-01-10",
          quantity: 10,
          instrumentId: null,
          purchaseDateAssumed: false,
          cost: null,
        },
      ]);
      expect(bondLotsAsOf(rows, "2026-02-10").lots).toHaveLength(2);
      expect(bondLotsAsOf(rows, "2026-03-01").lots).toEqual([
        {
          purchaseDate: "2026-02-10",
          quantity: 3,
          instrumentId: null,
          purchaseDateAssumed: false,
          cost: null,
        },
      ]);
    });

    it("refuses from the day a row makes the lots unknowable, and not before", () => {
      expect(bondLotsAsOf(rows, "2026-03-31").refusal).toBeNull();
      expect(bondLotsAsOf(rows, "2026-04-01").refusal).toMatchObject({
        code: "SPLIT",
      });
    });
  });

  describe("series (docs/specs/bond-program-securities.md 2.3 and 2.4)", () => {
    const edo = "series-edo";
    const cOi = "series-coi";
    const acquire = (date: string, quantity: string, series: string | null) =>
      tx("BUY", date, quantity, { accountId: "a1", instrumentId: series });
    const take = (
      action: string,
      date: string,
      quantity: string,
      series?: string | null,
      over: Partial<BondLotTransaction> = {},
    ) =>
      tx(action, date, quantity, {
        accountId: "a1",
        instrumentId: series,
        ...over,
      });

    it("keeps two series of one account as separate lots, each with its series", () => {
      expect(
        lots([
          acquire("2026-01-10", "10", edo),
          acquire("2026-02-10", "5", cOi),
        ]).map((l) => [l.instrumentId, l.purchaseDate, l.quantity]),
      ).toEqual([
        [edo, "2026-01-10", 10],
        [cOi, "2026-02-10", 5],
      ]);
    });

    it("a removal that names a series leaves that series' oldest lots first and the others alone", () => {
      expect(
        lots([
          acquire("2026-01-10", "10", edo),
          acquire("2026-02-10", "5", cOi),
          acquire("2026-03-10", "4", edo),
          take("SELL", "2026-04-01", "12", edo),
        ]).map((l) => [l.instrumentId, l.purchaseDate, l.quantity]),
      ).toEqual([
        [cOi, "2026-02-10", 5],
        [edo, "2026-03-10", 2],
      ]);
    });

    it("a removal that names none leaves the account's lots first-in first-out across series", () => {
      expect(
        lots([
          acquire("2026-01-10", "10", edo),
          acquire("2026-02-10", "5", cOi),
          acquire("2026-03-10", "4", edo),
          take("SELL", "2026-04-01", "12"),
        ]).map((l) => [l.instrumentId, l.purchaseDate, l.quantity]),
      ).toEqual([
        [cOi, "2026-02-10", 3],
        [edo, "2026-03-10", 4],
      ]);
    });

    it("refuses a removal larger than the series it names, though the account holds enough overall", () => {
      const result = bondLotsFromTransactions([
        acquire("2026-01-10", "10", edo),
        acquire("2026-02-10", "5", cOi),
        take("SELL", "2026-04-01", "6", cOi),
      ]);
      expect(result.lots).toBeNull();
      expect(result.refusal).toMatchObject({
        code: "REMOVAL_EXCEEDS_SERIES",
        params: { action: "SELL", date: "2026-04-01", quantity: "6" },
      });
      // Without naming the series the same removal is fine.
      expect(
        bondLotsFromTransactions([
          acquire("2026-01-10", "10", edo),
          acquire("2026-02-10", "5", cOi),
          take("SELL", "2026-04-01", "6"),
        ]).refusal,
      ).toBeNull();
    });

    it("a removal larger than the whole account is still OVER_REMOVAL", () => {
      expect(
        bondLotsFromTransactions([
          acquire("2026-01-10", "10", edo),
          take("SELL", "2026-04-01", "11"),
        ]).refusal,
      ).toMatchObject({ code: "OVER_REMOVAL" });
    });

    it("a paired transfer moves lots with their series and purchase dates", () => {
      const moved = lots([
        acquire("2026-01-10", "10", edo),
        acquire("2026-02-10", "5", cOi),
        take("TRANSFER_OUT", "2026-03-01", "12", undefined, {
          pairedTransfer: true,
          counterpartAccountId: "a2",
        }),
        tx("TRANSFER_IN", "2026-03-01", "12", {
          accountId: "a2",
          pairedTransfer: true,
        }),
      ]);
      expect(
        moved.map((l) => [
          l.accountId,
          l.instrumentId,
          l.purchaseDate,
          l.quantity,
        ]),
      ).toEqual([
        // Oldest purchase first across accounts.
        ["a2", edo, "2026-01-10", 10],
        ["a1", cOi, "2026-02-10", 3],
        ["a2", cOi, "2026-02-10", 2],
      ]);
    });

    it("a transfer that names a series moves only that series", () => {
      const moved = lots([
        acquire("2026-01-10", "10", edo),
        acquire("2026-02-10", "5", cOi),
        take("TRANSFER_OUT", "2026-03-01", "5", cOi, {
          pairedTransfer: true,
          counterpartAccountId: "a2",
        }),
      ]);
      expect(
        moved.map((l) => [l.accountId, l.instrumentId, l.quantity]),
      ).toEqual([
        ["a1", edo, 10],
        ["a2", cOi, 5],
      ]);
    });

    it("an unlinked TRANSFER_IN is an acquisition of the series it names", () => {
      expect(
        lots([
          tx("TRANSFER_IN", "2026-03-01", "7", {
            accountId: "a1",
            instrumentId: edo,
          }),
        ]).map((l) => [l.instrumentId, l.purchaseDateAssumed]),
      ).toEqual([[edo, true]]);
    });

    it("an acquisition of a program-linked security with no series is SERIES_NOT_DETERMINED", () => {
      expect(
        bondLotsFromTransactions([acquire("2026-01-10", "10", null)]).refusal,
      ).toMatchObject({
        code: "SERIES_NOT_DETERMINED",
        params: { action: "BUY", date: "2026-01-10" },
      });
      // A removal with none is fine: it names no series by design.
      expect(
        bondLotsFromTransactions([
          acquire("2026-01-10", "10", edo),
          take("SELL", "2026-02-01", "3", null),
        ]).refusal,
      ).toBeNull();
    });
  });
});

describe("a refusal names the row that caused it (the write guard compares it with the row it wrote)", () => {
  it("carries the row's id when the caller supplied ids, and none when it did not", () => {
    const withIds = bondLotsFromTransactions([
      {
        id: "s1",
        action: "SELL",
        status: "UNRECONCILED",
        transactionDate: "2026-02-01",
        quantity: "3",
        pairedTransfer: false,
      },
    ]);
    expect(withIds.refusal).toMatchObject({
      code: "OVER_REMOVAL",
      rowId: "s1",
    });
    const withoutIds = bondLotsFromTransactions([
      {
        action: "SELL",
        status: "UNRECONCILED",
        transactionDate: "2026-02-01",
        quantity: "3",
        pairedTransfer: false,
      },
    ]);
    expect(withoutIds.refusal).not.toHaveProperty("rowId");
  });
});

describe("the cost of a lot", () => {
  const costs = (rows: BondLotTransaction[]) =>
    lots(rows).map((l) => [l.purchaseDate, l.quantity, l.cost]);

  it("is the acquisition's cost as given", () => {
    expect(
      costs([tx("BUY", "2026-10-01", "100", { cost: "9783.3700" })]),
    ).toEqual([["2026-10-01", 100, "9783.3700"]]);
  });

  it("stays unknown when the row has none, and for an unpaired transfer in", () => {
    expect(
      costs([
        tx("BUY", "2026-10-01", "10"),
        tx("TRANSFER_IN", "2026-10-02", "5", { cost: "500.0000" }),
        tx("BUY", "2026-10-03", "5", { cost: "not a number" }),
      ]),
    ).toEqual([
      ["2026-10-01", 10, null],
      ["2026-10-02", 5, null],
      ["2026-10-03", 5, null],
    ]);
  });

  it("is split pro rata when part of a lot leaves, the parts adding up exactly", () => {
    const rest = lots([
      tx("BUY", "2026-10-01", "3", { cost: "100.0000" }),
      tx("SELL", "2026-10-05", "1"),
    ]);
    expect(rest.map((l) => [l.quantity, l.cost])).toEqual([[2, "66.6667"]]);
    const moved = lots([
      tx("BUY", "2026-10-01", "3", { cost: "100.0000", accountId: "A" }),
      tx("TRANSFER_OUT", "2026-10-05", "1", {
        pairedTransfer: true,
        accountId: "A",
        counterpartAccountId: "B",
      }),
    ]);
    // 100.0000 x 1/3 = 33.3333 leaves; the 66.6667 that stays is the rest.
    expect(moved.map((l) => [l.accountId, l.quantity, l.cost])).toEqual([
      ["A", 2, "66.6667"],
      ["B", 1, "33.3333"],
    ]);
  });

  it("takes the whole cost when the whole lot leaves, and carries it through a transfer", () => {
    const moved = lots([
      tx("BUY", "2026-10-01", "4", { cost: "400.0000", accountId: "A" }),
      tx("TRANSFER_OUT", "2026-10-05", "1", {
        pairedTransfer: true,
        accountId: "A",
        counterpartAccountId: "B",
      }),
    ]);
    const byAccount = Object.fromEntries(
      moved.map((l) => [l.accountId, [l.quantity, l.cost]]),
    );
    expect(byAccount).toEqual({ A: [3, "300.0000"], B: [1, "100.0000"] });
  });

  it("splits first in first out: the older lot's cost goes first, the remainder keeps cost less taken", () => {
    const rest = lots([
      tx("BUY", "2026-10-01", "2", { cost: "200.0000" }),
      tx("BUY", "2026-10-02", "2", { cost: "260.0000" }),
      tx("SELL", "2026-10-05", "3"),
    ]);
    expect(rest.map((l) => [l.purchaseDate, l.quantity, l.cost])).toEqual([
      ["2026-10-02", 1, "130.0000"],
    ]);
  });

  it("keeps an unknown cost unknown through a partial removal", () => {
    expect(
      costs([tx("BUY", "2026-10-01", "4"), tx("SELL", "2026-10-05", "1")]),
    ).toEqual([["2026-10-01", 3, null]]);
  });
});
