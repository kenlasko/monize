import { DataSource } from "typeorm";
import {
  ScheduleEstimateBasis,
  ScheduledAmountEstimateService,
  estimateBasisOf,
  estimateReadModel,
  estimatedAmountFor,
  estimatedOccurrenceFor,
  occurrenceFollowsEstimate,
} from "./scheduled-amount-estimate.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { Currency } from "../currencies/entities/currency.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const TODAY = "2026-11-09";
const basis = {
  payeeId: "payee-1",
  categoryId: "cat-1",
  currencyCode: "CAD",
};

describe("ScheduledAmountEstimateService", () => {
  let manager: ManagerMock;
  let service: ScheduledAmountEstimateService;
  let exchangeRates: { getRateForDate: jest.Mock };
  let currencyRepo: { find: jest.Mock };

  const historyRow = (
    date: string,
    amount: number,
    currency = "CAD",
    payeeId = "payee-1",
    categoryId = "cat-1",
  ) => ({
    payee_id: payeeId,
    category_id: categoryId,
    tx_date: date,
    currency_code: currency,
    amount: String(amount),
  });

  beforeEach(() => {
    currencyRepo = {
      find: jest.fn().mockResolvedValue([
        { code: "CAD", decimalPlaces: 2 },
        { code: "USD", decimalPlaces: 2 },
      ]),
    };
    const mocks = createScopedDbMocks([[Currency, currencyRepo]]);
    manager = mocks.manager;
    manager.query.mockResolvedValue([]);
    exchangeRates = { getRateForDate: jest.fn().mockResolvedValue(1.4) };
    service = new ScheduledAmountEstimateService(
      mocks.dataSource as unknown as DataSource,
      exchangeRates as unknown as ExchangeRateService,
    );
  });

  it("estimates from the matched history in the schedule's currency", async () => {
    manager.query.mockResolvedValue([
      historyRow("2026-08-15", -100),
      historyRow("2026-09-15", -110),
      historyRow("2026-10-15", -120),
    ]);

    const estimate = await service.estimateFor("user-1", basis, TODAY);

    expect(estimate.status).toBe("estimated");
    expect(estimatedAmountFor(estimate, "2026-12-15")).toBe(-110);
    // One statement for the whole call, keyed on the payee and category pair,
    // inside the 24-month window.
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("transaction_splits");
    expect(sql).toContain("'VOID'");
    expect(params).toEqual([
      "user-1",
      ["payee-1"],
      ["cat-1"],
      "2024-11-09",
      TODAY,
    ]);
    expect(exchangeRates.getRateForDate).not.toHaveBeenCalled();
  });

  it("converts another currency's payments at the current rate", async () => {
    manager.query.mockResolvedValue([
      historyRow("2026-09-15", -100, "USD"),
      historyRow("2026-10-15", -100, "CAD"),
    ]);

    const estimate = await service.estimateFor("user-1", basis, TODAY);

    // (-140 - 100) / 2 at today's 1.4.
    expect(estimatedAmountFor(estimate, "2026-12-15")).toBe(-120);
    // From what is stored: this read runs on every list, expansion and cron.
    expect(exchangeRates.getRateForDate).toHaveBeenCalledWith(
      "USD",
      "CAD",
      TODAY,
      { fetchMissing: false },
    );
  });

  it("is unknown and names the pair when a payment has no current rate", async () => {
    exchangeRates.getRateForDate.mockResolvedValue(null);
    manager.query.mockResolvedValue([
      historyRow("2026-09-15", -100, "USD"),
      historyRow("2026-10-15", -100, "CAD"),
    ]);

    const estimate = await service.estimateFor("user-1", basis, TODAY);

    expect(estimate).toMatchObject({
      status: "missing-rate",
      missingPair: { from: "USD", to: "CAD" },
      profile: null,
    });
    expect(estimatedAmountFor(estimate, "2026-12-15")).toBeNull();
  });

  it("is no-history with nothing matched and no-basis without a category", async () => {
    const result = await service.estimateMany(
      "user-1",
      new Map<string, ScheduleEstimateBasis>([
        ["a", basis],
        ["b", { ...basis, categoryId: null }],
      ]),
      TODAY,
    );
    expect(result.get("a")!.status).toBe("no-history");
    expect(result.get("b")!.status).toBe("no-basis");
    // Only the matchable pair is asked for.
    expect(manager.query.mock.calls[0][1][2]).toEqual(["cat-1"]);
  });

  it("keeps each schedule's history to its own payee and category", async () => {
    manager.query.mockResolvedValue([
      historyRow("2026-10-15", -50),
      historyRow("2026-10-15", -900, "CAD", "payee-2", "cat-2"),
    ]);

    const result = await service.estimateMany(
      "user-1",
      new Map([
        ["a", basis],
        ["b", { ...basis, payeeId: "payee-2", categoryId: "cat-2" }],
      ]),
      TODAY,
    );

    expect(estimatedAmountFor(result.get("a")!, "2026-12-01")).toBe(-50);
    expect(estimatedAmountFor(result.get("b")!, "2026-12-01")).toBe(-900);
  });

  it("publishes a month per entry from the month before today", async () => {
    manager.query.mockResolvedValue([historyRow("2026-10-15", -80)]);

    const model = estimateReadModel(
      await service.estimateFor("user-1", basis, TODAY),
      TODAY,
    );

    const months = Object.keys(model.months);
    expect(months[0]).toBe("2026-10");
    expect(months[months.length - 1]).toBe("2028-11");
    expect(model.months["2026-12"]).toEqual({ amount: -80, basis: "recent" });
    expect(model).toMatchObject({
      status: "estimated",
      paymentCount: 1,
      latestPaymentDate: "2026-10-15",
      growthRate: null,
      historyMonths: 24,
    });
  });

  it("reaches back to an overdue next occurrence's month, at most two years", async () => {
    manager.query.mockResolvedValue([historyRow("2026-10-15", -80)]);
    const estimate = await service.estimateFor("user-1", basis, TODAY);

    const overdue = estimateReadModel(estimate, TODAY, "2026-07-20");
    expect(Object.keys(overdue.months)[0]).toBe("2026-07");
    expect(overdue.months["2026-07"]).toEqual({ amount: -80, basis: "recent" });

    const ancient = estimateReadModel(estimate, TODAY, "2019-01-01");
    expect(Object.keys(ancient.months)[0]).toBe("2024-11");
  });

  it("lets an override's stated amount or own lines govern its occurrence", () => {
    const estimated = { amountIsEstimated: true };
    expect(occurrenceFollowsEstimate(estimated, null)).toBe(true);
    expect(
      occurrenceFollowsEstimate(estimated, { amount: null, isSplit: false }),
    ).toBe(true);
    expect(
      occurrenceFollowsEstimate(estimated, { amount: -250, isSplit: false }),
    ).toBe(false);
    expect(
      occurrenceFollowsEstimate(estimated, { amount: null, isSplit: true }),
    ).toBe(false);
    expect(occurrenceFollowsEstimate({ amountIsEstimated: false }, null)).toBe(
      false,
    );
  });

  describe("an estimated transfer (issue #2164)", () => {
    const NOV_19 = "2026-11-19";
    const transferBasis = (
      overrides: Partial<NonNullable<ScheduleEstimateBasis["transfer"]>> = {},
    ): ScheduleEstimateBasis => ({
      payeeId: null,
      categoryId: null,
      currencyCode: "CAD",
      transfer: {
        accountId: "acc-chequing",
        transferAccountId: "acc-card",
        frequency: "MONTHLY",
        nextOccurrenceDueDate: "2026-11-26",
        ...overrides,
      },
    });
    const transferRow = (date: string, amount: number, currency = "CAD") => ({
      account_id: "acc-chequing",
      transfer_account_id: "acc-card",
      tx_date: date,
      currency_code: currency,
      amount: String(amount),
    });
    /** The issue's card: closes on the 5th, due on the 26th. */
    const cardRow = {
      id: "acc-card",
      account_type: "CREDIT_CARD",
      statement_settlement_day: 5,
      statement_due_day: 26,
      currency_code: "CAD",
    };

    /**
     * Answers each read by what it asks: the destination, its balances, its
     * credits since the statement and the transfer history.
     */
    const ledger = (opts: {
      account?: Record<string, unknown> | null;
      balances?: Record<string, number>;
      credits?: number;
      history?: ReturnType<typeof transferRow>[];
    }) => {
      manager.query.mockImplementation(async (sql: string) => {
        if (sql.includes("statement_settlement_day")) {
          return opts.account === null ? [] : [opts.account ?? cardRow];
        }
        if (sql.includes("AS balance")) {
          return Object.entries(opts.balances ?? {}).map(([asOf, b]) => ({
            account_id: "acc-card",
            as_of: asOf,
            balance: String(b),
          }));
        }
        if (sql.includes("AS credits")) {
          return [
            { account_id: "acc-card", credits: String(opts.credits ?? 0) },
          ];
        }
        if (sql.includes("linked_transaction_id")) {
          return (
            opts.history ?? [
              transferRow("2026-08-26", -1900),
              transferRow("2026-09-26", -2000),
              transferRow("2026-10-26", -2100),
            ]
          );
        }
        return [];
      });
    };

    it("matches the transfers between the two accounts and raises the next cycles to the card's debt", async () => {
      // The Nov 5 statement owed 2700; the card owes 4800 today.
      ledger({ balances: { [NOV_19]: -4800, "2026-11-05": -2700 } });

      const estimate = await service.estimateFor(
        "user-1",
        transferBasis(),
        NOV_19,
      );

      expect(estimate.status).toBe("estimated");
      // The closed statement, what lies beyond it, then the baseline.
      expect(estimatedOccurrenceFor(estimate, "2026-11-26")).toEqual({
        amount: -2700,
        basis: "balance",
      });
      expect(estimatedAmountFor(estimate, "2026-12-26")).toBe(-2100);
      expect(estimatedOccurrenceFor(estimate, "2027-01-26")).toEqual({
        amount: -2000,
        basis: "recent",
      });

      const history = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("linked_transaction_id"),
      )!;
      expect(history[0]).toContain("'VOID'");
      expect(history[1]).toEqual([
        "user-1",
        ["acc-chequing"],
        ["acc-card"],
        "2024-11-19",
        NOV_19,
      ]);
      const balances = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("AS balance"),
      )!;
      expect(balances[1]).toEqual([
        "user-1",
        ["acc-card", "acc-card"],
        [NOV_19, "2026-11-05"],
      ]);
      const credits = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("AS credits"),
      )!;
      expect(credits[1]).toEqual([
        "user-1",
        ["acc-card"],
        ["2026-11-05"],
        NOV_19,
      ]);
      // No payee history is read for a transfer.
      expect(
        manager.query.mock.calls.some(([sql]) =>
          String(sql).includes("transaction_splits"),
        ),
      ).toBe(false);
    });

    it("raises only the next occurrence outside a card's statement cycle", async () => {
      ledger({
        account: {
          ...cardRow,
          account_type: "LINE_OF_CREDIT",
          statement_settlement_day: null,
          statement_due_day: null,
        },
        balances: { [NOV_19]: -3456.78 },
      });

      const estimate = await service.estimateFor(
        "user-1",
        transferBasis(),
        NOV_19,
      );

      expect(estimatedAmountFor(estimate, "2026-11-26")).toBe(-3456.78);
      expect(estimatedAmountFor(estimate, "2026-12-26")).toBe(-2000);
      expect(
        manager.query.mock.calls.some(([sql]) =>
          String(sql).includes("AS credits"),
        ),
      ).toBe(false);
    });

    it("reads no floor for an account the user does not own", async () => {
      ledger({ account: null });

      const estimate = await service.estimateFor(
        "user-1",
        transferBasis(),
        NOV_19,
      );

      expect(estimate.floors).toEqual([]);
      expect(estimatedAmountFor(estimate, "2026-11-26")).toBe(-2000);
    });

    it("is no-basis without a destination and no-history without transfers", async () => {
      ledger({ history: [], balances: { [NOV_19]: -4800 } });

      const result = await service.estimateMany(
        "user-1",
        new Map([
          ["a", transferBasis({ transferAccountId: null })],
          ["b", transferBasis()],
        ]),
        NOV_19,
      );

      expect(result.get("a")!.status).toBe("no-basis");
      expect(result.get("b")!.status).toBe("no-history");
      expect(estimatedAmountFor(result.get("b")!, "2026-11-26")).toBeNull();
    });

    it("converts a destination's debt in another currency at the current rate", async () => {
      ledger({
        account: { ...cardRow, currency_code: "USD" },
        balances: { [NOV_19]: -3000, "2026-11-05": -2000 },
      });

      const estimate = await service.estimateFor(
        "user-1",
        transferBasis(),
        NOV_19,
      );

      // 2000 USD owed on the statement at 1.4.
      expect(estimatedAmountFor(estimate, "2026-11-26")).toBe(-2800);
      expect(exchangeRates.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        NOV_19,
        { fetchMissing: false },
      );
    });

    it("is unknown and names the pair when the destination's currency has no current rate", async () => {
      exchangeRates.getRateForDate.mockResolvedValue(null);
      ledger({
        account: { ...cardRow, currency_code: "USD" },
        balances: { [NOV_19]: -3000, "2026-11-05": -2000 },
      });

      const estimate = await service.estimateFor(
        "user-1",
        transferBasis(),
        NOV_19,
      );

      expect(estimate).toMatchObject({
        status: "missing-rate",
        missingPair: { from: "USD", to: "CAD" },
        floors: [],
      });
    });

    it("publishes each floor's months raised, never the debt itself", async () => {
      ledger({ balances: { [NOV_19]: -4800, "2026-11-05": -1500 } });

      const model = estimateReadModel(
        await service.estimateFor("user-1", transferBasis(), NOV_19),
        NOV_19,
        "2026-11-26",
      );

      expect(model.months["2026-11"]).toEqual({
        amount: -2000,
        basis: "recent",
      });
      expect(model.floors).toEqual([
        {
          after: "2026-11-05",
          through: "2026-12-05",
          // The statement's 1500 is under the baseline: it reads as the baseline.
          months: {
            "2026-11": { amount: -2000, basis: "recent" },
            "2026-12": { amount: -2000, basis: "recent" },
          },
        },
        {
          after: "2026-12-05",
          through: "2027-01-05",
          months: {
            "2026-12": { amount: -3300, basis: "balance" },
            "2027-01": { amount: -3300, basis: "balance" },
          },
        },
      ]);
    });

    it("builds a transfer's basis from the schedule, at the later of the cursor and a moved occurrence", () => {
      const schedule = {
        payeeId: "payee-1",
        categoryId: "cat-1",
        currencyCode: "CAD",
        accountId: "acc-chequing",
        isTransfer: true,
        transferAccountId: "acc-card",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-11-26",
      };
      expect(estimateBasisOf(schedule, "2026-11-28").transfer).toEqual({
        accountId: "acc-chequing",
        transferAccountId: "acc-card",
        frequency: "MONTHLY",
        nextOccurrenceDueDate: "2026-11-28",
      });
      expect(
        estimateBasisOf(schedule, "2026-11-20").transfer!.nextOccurrenceDueDate,
      ).toBe("2026-11-26");
      expect(
        estimateBasisOf({ ...schedule, isTransfer: false }).transfer,
      ).toBeUndefined();
    });
  });
});
