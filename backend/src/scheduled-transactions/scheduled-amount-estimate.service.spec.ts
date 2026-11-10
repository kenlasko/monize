import { DataSource } from "typeorm";
import {
  ScheduleEstimateBasis,
  ScheduledAmountEstimateService,
  estimateReadModel,
  estimatedAmountFor,
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
});
