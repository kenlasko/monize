import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BondHoldingsService } from "./bond-holdings.service";
import { BondValuationService } from "./bond-valuation.service";
import { BondAdapter } from "./bond-adapter";
import { POLISH_BOND_ADAPTER } from "./adapters/pl";
import type { RedemptionSplit } from "./engine/redemption-split";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const SEC = "sec-1";
const ACC = "acc-1";
const OTHER_ACC = "acc-2";
const PROGRAM = "prog-1";
const EDO = "11111111-1111-5111-8111-111111111111";
const COI = "22222222-2222-5222-8222-222222222222";

type Row = {
  id: string;
  action: string;
  tx_date: string;
  quantity: string;
  account_id?: string;
  bond_instrument_id: string | null;
  counterpart_account_id?: string | null;
  total_amount?: string | null;
};

const row = (over: Partial<Row> & { id: string }): Row => ({
  action: "BUY",
  tx_date: "2026-01-10",
  quantity: "10",
  account_id: ACC,
  bond_instrument_id: EDO,
  counterpart_account_id: null,
  total_amount: null,
  ...over,
});

function setup(
  opts: {
    linked?: boolean;
    ledger?: Row[];
    onSale?: string[];
    country?: string;
    program?: string;
  } = {},
) {
  const { manager, dataSource } = createScopedDbMocks();
  dataSource.transaction.mockImplementation(
    async (fn: (m: unknown) => unknown) => fn(manager),
  );
  const codes: Record<string, string> = { [EDO]: "EDO1036", [COI]: "COI1030" };
  manager.query.mockImplementation(
    async (sql: string, params: unknown[] = []) => {
      if (sql.includes("bond_auto_fetch")) {
        const own = params[1] === USER && opts.linked !== false;
        return own
          ? [
              {
                id: SEC,
                user_id: USER,
                symbol: "EDO",
                currency_code: "PLN",
                bond_program_id: PROGRAM,
                bond_auto_fetch: false,
              },
            ]
          : [];
      }
      if (sql.includes("FROM bond_programs WHERE id")) {
        return [
          {
            issuer_country_code: opts.country ?? "PL",
            program_code: opts.program ?? "EDO",
          },
        ];
      }
      if (sql.includes("counterpart_account_id")) {
        return (opts.ledger ?? []).map((r) => ({
          status: "UNRECONCILED",
          ...r,
        }));
      }
      if (sql.includes("saleWindow")) {
        return (opts.onSale ?? []).map((id) => ({ id }));
      }
      if (sql.includes("SELECT series_code")) {
        return [{ series_code: codes[String(params[0])] }];
      }
      return [];
    },
  );
  // One bond of the series pays 100.00 principal and interest 0.10 per day
  // held since the purchase date (a stand-in for the engine, which has its own
  // suite): the portions the service asks about are what these figures show.
  const valuation = {
    loadReference: jest.fn(async () => ({
      terms: { rounding: { moneyDecimals: 2 } },
    })),
    redemptionSplitFrom: jest.fn(
      (
        _reference: unknown,
        lot: { purchaseDate: string; quantity: number },
        date: string,
      ): RedemptionSplit => {
        const days = Math.round(
          (Date.parse(date) - Date.parse(lot.purchaseDate)) / 86_400_000,
        );
        const interest = (days * 10 * lot.quantity) / 100;
        const money = (v: number) => v.toFixed(2);
        const figures = {
          principal: money(lot.quantity * 100),
          grossInterest: money(interest),
          deduction: "0.00",
          interest: money(interest),
          principalReturned: money(lot.quantity * 100),
          payout: money(lot.quantity * 100 + interest),
        };
        return {
          date,
          quantity: lot.quantity,
          ...figures,
          perBond: figures,
          refusal: null,
        };
      },
    ),
  };
  const service = new BondHoldingsService(
    dataSource as unknown as DataSource,
    valuation as unknown as BondValuationService,
  );
  return { service, manager, valuation };
}

describe("BondHoldingsService.seriesOnSale", () => {
  it("answers the series the write would infer, with its code, from the same sale-window query", async () => {
    const { service, manager } = setup({ onSale: [EDO] });
    await expect(
      service.seriesOnSale(USER, SEC, "2026-10-15"),
    ).resolves.toEqual({ instrumentId: EDO, seriesCode: "EDO1036" });
    const call = manager.query.mock.calls.find(([sql]: [string]) =>
      sql.includes("saleWindow"),
    );
    expect(call?.[1]).toEqual([PROGRAM, "2026-10-15"]);
  });

  it("answers null when no series, or more than one, was on sale that day (the write would refuse as well)", async () => {
    await expect(
      setup({ onSale: [] }).service.seriesOnSale(USER, SEC, "2026-10-15"),
    ).resolves.toBeNull();
    await expect(
      setup({ onSale: [EDO, COI] }).service.seriesOnSale(
        USER,
        SEC,
        "2026-10-15",
      ),
    ).resolves.toBeNull();
  });

  it("is a 404 for another user's security and for one that is not linked to a program", async () => {
    await expect(
      setup().service.seriesOnSale("someone-else", SEC, "2026-10-15"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ linked: false }).service.seriesOnSale(USER, SEC, "2026-10-15"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("BondHoldingsService.expectedSeries", () => {
  const adapters = [POLISH_BOND_ADAPTER];

  it("names the Polish series sold on the date, from the adapter's grammar, and says it is fetchable", async () => {
    await expect(
      setup().service.expectedSeries(USER, SEC, "2026-10-15", adapters),
    ).resolves.toEqual({
      seriesCode: "EDO1036",
      countryCode: "PL",
      fetchable: true,
    });
    await expect(
      setup({ program: "OTS" }).service.expectedSeries(
        USER,
        SEC,
        "2026-11-03",
        adapters,
      ),
    ).resolves.toMatchObject({ seriesCode: "OTS0227" });
  });

  it("answers a null code, still fetchable, for a program the adapter's grammar does not know", async () => {
    await expect(
      setup({ program: "XYZ" }).service.expectedSeries(
        USER,
        SEC,
        "2026-10-15",
        adapters,
      ),
    ).resolves.toEqual({
      seriesCode: null,
      countryCode: "PL",
      fetchable: true,
    });
  });

  it("answers a null code and not fetchable for a country with no adapter or one without the members", async () => {
    await expect(
      setup({ country: "DE" }).service.expectedSeries(
        USER,
        SEC,
        "2026-10-15",
        adapters,
      ),
    ).resolves.toEqual({
      seriesCode: null,
      countryCode: "DE",
      fetchable: false,
    });
    const bare = {
      ...POLISH_BOND_ADAPTER,
      fetchSeries: undefined,
      seriesCodeFor: undefined,
    } as BondAdapter;
    await expect(
      setup().service.expectedSeries(USER, SEC, "2026-10-15", [bare]),
    ).resolves.toEqual({
      seriesCode: null,
      countryCode: "PL",
      fetchable: false,
    });
  });

  it("is a 404 for another user's security and for one that is not linked", async () => {
    await expect(
      setup().service.expectedSeries(
        "someone-else",
        SEC,
        "2026-10-15",
        adapters,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ linked: false }).service.expectedSeries(
        USER,
        SEC,
        "2026-10-15",
        adapters,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("BondHoldingsService.seriesHoldings", () => {
  const ledger = [
    row({ id: "b1", quantity: "10", tx_date: "2026-01-10" }),
    row({
      id: "b2",
      quantity: "7",
      tx_date: "2026-02-10",
      bond_instrument_id: COI,
    }),
    row({
      id: "b3",
      quantity: "3",
      tx_date: "2026-03-10",
      account_id: OTHER_ACC,
    }),
    row({
      id: "s1",
      action: "SELL",
      quantity: "4",
      tx_date: "2026-04-10",
      bond_instrument_id: EDO,
    }),
  ];

  it("sums the open lots of the account per series, oldest first, quantity above zero only, as of the date", async () => {
    const { service } = setup({ ledger });
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-12-31"),
    ).resolves.toEqual({
      holdings: [
        { instrumentId: EDO, seriesCode: "EDO1036", quantity: 6 },
        { instrumentId: COI, seriesCode: "COI1030", quantity: 7 },
      ],
    });
    // The date bounds the rows: the sale of April is not yet made in March.
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-03-31"),
    ).resolves.toEqual({
      holdings: [
        { instrumentId: EDO, seriesCode: "EDO1036", quantity: 10 },
        { instrumentId: COI, seriesCode: "COI1030", quantity: 7 },
      ],
    });
    // Only the account asked for.
    await expect(
      service.seriesHoldings(USER, SEC, OTHER_ACC, "2026-12-31"),
    ).resolves.toEqual({
      holdings: [{ instrumentId: EDO, seriesCode: "EDO1036", quantity: 3 }],
    });
  });

  it("leaves out a series the account sold out of", async () => {
    const { service } = setup({
      ledger: [
        row({ id: "b1", quantity: "4" }),
        row({ id: "s1", action: "SELL", quantity: "4", tx_date: "2026-02-01" }),
      ],
    });
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-12-31"),
    ).resolves.toEqual({ holdings: [] });
  });

  it("excludes the transaction being edited, so its own removal does not hide what it may take", async () => {
    const { service } = setup({ ledger });
    await expect(
      service.seriesHoldings(USER, SEC, ACC, "2026-12-31", "s1"),
    ).resolves.toEqual({
      holdings: [
        { instrumentId: EDO, seriesCode: "EDO1036", quantity: 10 },
        { instrumentId: COI, seriesCode: "COI1030", quantity: 7 },
      ],
    });
  });

  it("is a 422 with the refusal code as errorCode when the lots cannot be derived", async () => {
    const { service } = setup({
      ledger: [
        row({
          id: "s1",
          action: "SELL",
          quantity: "4",
          bond_instrument_id: null,
        }),
      ],
    });
    const error = await service
      .seriesHoldings(USER, SEC, ACC, "2026-12-31")
      .catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toMatchObject({ errorCode: "OVER_REMOVAL" });
  });

  it("is a 404 for another user's security", async () => {
    await expect(
      setup({ ledger }).service.seriesHoldings(
        "someone-else",
        SEC,
        ACC,
        "2026-12-31",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("BondHoldingsService.redemptionSplit", () => {
  const ledger = [
    row({ id: "b1", quantity: "3", tx_date: "2026-01-10" }),
    row({ id: "b2", quantity: "5", tx_date: "2026-01-20" }),
    row({
      id: "b3",
      quantity: "9",
      tx_date: "2026-01-05",
      bond_instrument_id: COI,
    }),
    row({
      id: "b4",
      quantity: "4",
      tx_date: "2026-01-01",
      account_id: OTHER_ACC,
    }),
  ];

  it("splits the lots the removal takes first in first out, across purchase dates, and sums them exactly", async () => {
    const { service, valuation } = setup({ ledger });
    const split = await service.redemptionSplit(
      USER,
      SEC,
      ACC,
      EDO,
      "2026-02-09",
      4,
    );
    // 3 bonds of 10 Jan (30 days) and 1 bond of 20 Jan (20 days).
    expect(
      valuation.redemptionSplitFrom.mock.calls.map(([, lot]) => lot),
    ).toEqual([
      expect.objectContaining({ purchaseDate: "2026-01-10", quantity: 3 }),
      expect.objectContaining({ purchaseDate: "2026-01-20", quantity: 1 }),
    ]);
    expect(split).toEqual({
      date: "2026-02-09",
      quantity: 4,
      principal: "400.00",
      grossInterest: "11.00",
      deduction: "0.00",
      interest: "11.00",
      principalReturned: "400.00",
      payout: "411.00",
      refusal: null,
    });
  });

  it("takes the exact cost of the lot it removes from when two lots of one day cost differently", async () => {
    // 5 bonds for 500.0000 and 5 bonds for 600.0000 on the same day. First in
    // first out takes 3 of the first: 3 / 5 of 500.0000 = 300.0000. A removal
    // rebuilt from the difference of two folds charged the pooled cost of the
    // day, 1100 / 10 x 3 = 330 and then a share of the remainder: 371.4286.
    const { service, valuation } = setup({
      ledger: [
        row({
          id: "c1",
          quantity: "5",
          tx_date: "2026-01-10",
          total_amount: "500.0000",
        }),
        row({
          id: "c2",
          quantity: "5",
          tx_date: "2026-01-10",
          total_amount: "600.0000",
        }),
      ],
    });
    await service.redemptionSplit(USER, SEC, ACC, EDO, "2026-02-09", 3);
    expect(
      valuation.redemptionSplitFrom.mock.calls.map(([, lot]) => [
        lot.quantity,
        (lot as { cost?: string | null }).cost,
      ]),
    ).toEqual([[3, "300.0000"]]);
  });

  it("leaves a lot the edited row already took available when it is excluded", async () => {
    const { service, valuation } = setup({
      ledger: [
        ...ledger,
        row({
          id: "r1",
          action: "REDEEM",
          quantity: "8",
          tx_date: "2026-02-01",
        }),
      ],
    });
    await expect(
      service.redemptionSplit(USER, SEC, ACC, EDO, "2026-02-09", 4),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.redemptionSplit(USER, SEC, ACC, EDO, "2026-02-09", 4, "r1");
    expect(valuation.redemptionSplitFrom).toHaveBeenCalled();
  });

  it("makes a figure null when any portion's is unknown and returns the refusal", async () => {
    const { service, valuation } = setup({ ledger });
    const base = valuation.redemptionSplitFrom.getMockImplementation()!;
    valuation.redemptionSplitFrom.mockImplementation((r, lot, date) =>
      lot.purchaseDate === "2026-01-20"
        ? {
            ...base(r, lot, date),
            interest: null,
            payout: null,
            principalReturned: null,
            grossInterest: null,
            deduction: null,
            refusal: "RATE_UNKNOWN",
          }
        : base(r, lot, date),
    );
    await expect(
      service.redemptionSplit(USER, SEC, ACC, EDO, "2026-02-09", 4),
    ).resolves.toMatchObject({
      principal: "400.00",
      interest: null,
      payout: null,
      refusal: "RATE_UNKNOWN",
    });
  });

  it("refuses a quantity above what the account holds of the series with the removal refusal", async () => {
    const { service } = setup({ ledger });
    const error = await service
      .redemptionSplit(USER, SEC, ACC, EDO, "2026-02-09", 9)
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      errorCode: "REMOVAL_EXCEEDS_SERIES",
    });
  });

  it("takes only the lots acquired on or before the date", async () => {
    const { service } = setup({ ledger });
    await expect(
      service.redemptionSplit(USER, SEC, ACC, EDO, "2026-01-15", 4),
    ).rejects.toMatchObject({
      response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
    });
  });

  it("is a 422 when the ledger's lots cannot be derived, and a 404 for another user's security", async () => {
    const broken = setup({
      ledger: [
        row({
          id: "s1",
          action: "SELL",
          quantity: "4",
          bond_instrument_id: null,
        }),
      ],
    });
    await expect(
      broken.service.redemptionSplit(USER, SEC, ACC, EDO, "2026-02-09", 1),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      setup({ ledger }).service.redemptionSplit(
        "someone-else",
        SEC,
        ACC,
        EDO,
        "2026-02-09",
        1,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
