import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MonteCarloService } from "./monte-carlo.service";
import { MonteCarloSimulationService } from "./monte-carlo-simulation.service";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { MonteCarloCashFlow } from "./entities/monte-carlo-cash-flow.entity";
import { CreateScenarioDto } from "./dto/create-scenario.dto";
import {
  CashFlowDto,
  CashFlowTypeDto,
  MAX_SCENARIO_CASH_FLOWS,
} from "./dto/cash-flow.dto";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// A `loadPriceSeries` row: the close struck on 31 December of `year`.
const yearEnd = (
  secId: string,
  year: string,
  close: string,
  hasAdjusted = false,
) => ({
  series_id: secId,
  price_date: `${year}-12-31`,
  close_price: close,
  has_adjusted: hasAdjusted,
});

describe("MonteCarloService", () => {
  let service: MonteCarloService;
  let scenariosRepository: Record<string, jest.Mock>;
  let cashFlowsRepository: Record<string, jest.Mock>;
  let holdingsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let securitiesRepository: Record<string, jest.Mock>;
  let securityPriceService: { backfillSecurityRange: jest.Mock };
  let exchangeRateService: { ensureRatesForDate: jest.Mock };
  let preferenceRepository: Record<string, jest.Mock>;
  let portfolioService: {
    getPortfolioSummary: jest.Mock;
    getLatestPrices: jest.Mock;
    convertSecurityValuesToDefault: jest.Mock;
  };
  let manager: ManagerMock;
  let dataSource: DataSourceMock;

  const userId = "user-1";
  const otherUserId = "user-2";

  const buildScenario = (
    overrides: Partial<MonteCarloScenario> = {},
  ): MonteCarloScenario =>
    ({
      id: "scn-1",
      userId,
      name: "Retirement",
      description: null,
      accountIds: ["acct-1"],
      startingValue: 100000,
      useCurrentBalance: false,
      yearsToRetirement: 5,
      annualContribution: 1000,
      contributionGrowthRate: 0,
      yearsInRetirement: 0,
      annualWithdrawal: 0,
      expectedReturn: 0.07,
      volatility: 0.15,
      inflationRate: 0.025,
      showRealValues: false,
      simulationCount: 200,
      targetValue: null,
      randomSeed: "1",
      useHistoricalReturns: false,
      isFavourite: false,
      sortOrder: 0,
      lastRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as MonteCarloScenario;

  const validInputs: CreateScenarioDto = {
    name: "Test scenario",
    accountIds: ["11111111-1111-1111-1111-111111111111"],
    startingValue: 50000,
    useCurrentBalance: false,
    yearsToRetirement: 10,
    annualContribution: 5000,
    contributionGrowthRate: 0,
    yearsInRetirement: 0,
    annualWithdrawal: 0,
    expectedReturn: 0.07,
    volatility: 0.15,
    inflationRate: 0.025,
    showRealValues: false,
    useHistoricalReturns: false,
    simulationCount: 200,
    targetValue: null,
    randomSeed: "1",
  };

  beforeEach(() => {
    scenariosRepository = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve({ id: "scn-1", ...entity })),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
    };
    cashFlowsRepository = {
      create: jest.fn((entity) => entity),
      save: jest.fn((rows) => Promise.resolve(rows)),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    holdingsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    accountsRepository = {
      // The ownership guard asks for the requested accounts scoped to the
      // caller; default to "all requested accounts are the caller's own" by
      // echoing the In(...) ids back. Tests about foreign accounts override
      // with mockResolvedValueOnce.
      find: jest.fn().mockImplementation(async (opts: any) => {
        const idOp = opts?.where?.id;
        const ids: string[] = Array.isArray(idOp?.value) ? idOp.value : [];
        return ids.map((id) => ({
          id,
          userId: opts?.where?.userId ?? "user-1",
          name: id,
          currencyCode: "USD",
        }));
      }),
    };
    securitiesRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    securityPriceService = {
      backfillSecurityRange: jest.fn().mockResolvedValue(0),
    };
    exchangeRateService = {
      ensureRatesForDate: jest.fn().mockResolvedValue(0),
    };
    portfolioService = {
      getPortfolioSummary: jest.fn().mockResolvedValue({
        totalPortfolioValue: 250000,
        totalCashValue: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
      }),
      getLatestPrices: jest.fn().mockResolvedValue(new Map()),
      getBrokerageAccounts: jest.fn().mockResolvedValue([]),
      // Same-currency identity by default (what every existing single-USD test
      // needs): sum the supplied native values by security, nothing unconvertible.
      // The mixed-currency and missing-rate cases override this.
      convertSecurityValuesToDefault: jest
        .fn()
        .mockImplementation(
          async (
            _userId: string,
            items: Array<{ securityId: string; nativeValue: number }>,
          ) => {
            const valueBySecurity = new Map<string, number>();
            for (const it of items) {
              valueBySecurity.set(
                it.securityId,
                (valueBySecurity.get(it.securityId) ?? 0) + it.nativeValue,
              );
            }
            return { valueBySecurity, missingRatePairs: [] };
          },
        ),
    } as unknown as {
      getPortfolioSummary: jest.Mock;
      getLatestPrices: jest.Mock;
      convertSecurityValuesToDefault: jest.Mock;
    };
    preferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };
    ({ manager, dataSource } = createScopedDbMocks([
      [MonteCarloScenario, scenariosRepository],
      [MonteCarloCashFlow, cashFlowsRepository],
      [Holding, holdingsRepository],
      [Account, accountsRepository],
      [Security, securitiesRepository],
      [UserPreference, preferenceRepository],
    ]));
    manager.update.mockResolvedValue({ affected: 1 });
    manager.query.mockResolvedValue([]);

    service = new MonteCarloService(
      new MonteCarloSimulationService(),
      portfolioService as never,
      securityPriceService as never,
      exchangeRateService as never,
      dataSource as never,
    );
  });

  describe("create", () => {
    it("persists the scenario with the user id", async () => {
      // create() reloads via findOne after save to return relations; that
      // second findOne needs to resolve to the newly-created scenario.
      scenariosRepository.findOne.mockResolvedValueOnce(buildScenario());
      await service.create(userId, validInputs);
      expect(scenariosRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId, name: "Test scenario" }),
      );
      expect(scenariosRepository.save).toHaveBeenCalled();
    });

    it("persists cash flows when provided", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(buildScenario());
      await service.create(userId, {
        ...validInputs,
        cashFlows: [
          {
            name: "Pension",
            amount: 30000,
            flowType: "RECURRING" as never,
            startYear: 25,
            inflationAdjust: true,
          },
        ],
      });
      expect(cashFlowsRepository.delete).toHaveBeenCalledWith({
        scenarioId: "scn-1",
      });
      expect(cashFlowsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Pension", amount: 30000 }),
      );
      expect(cashFlowsRepository.save).toHaveBeenCalled();
    });
  });

  describe("findOne", () => {
    it("throws NotFound when scenario does not exist for the user", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(userId, "scn-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(scenariosRepository.findOne).toHaveBeenCalledWith({
        where: { id: "scn-1", userId },
        relations: ["cashFlows"],
      });
    });

    it("returns the scenario when it exists", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(buildScenario());
      const result = await service.findOne(userId, "scn-1");
      expect(result.id).toBe("scn-1");
    });
  });

  describe("multi-tenancy", () => {
    it("does not return another user's scenario", async () => {
      // Repo returns the scenario only when both id+userId match — service
      // re-checks via the where clause.
      scenariosRepository.findOne.mockImplementationOnce(
        ({ where }: { where: { id: string; userId: string } }) =>
          where.userId === userId
            ? Promise.resolve(buildScenario())
            : Promise.resolve(null),
      );
      await expect(
        service.findOne(otherUserId, "scn-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("update", () => {
    it("only updates whitelisted fields", async () => {
      const existing = buildScenario();
      // First findOne loads, second findOne returns the saved scenario.
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      scenariosRepository.findOne.mockResolvedValueOnce({
        ...existing,
        name: "Renamed",
      });
      scenariosRepository.save.mockImplementationOnce((s) =>
        Promise.resolve(s),
      );
      const updated = await service.update(userId, "scn-1", {
        name: "Renamed",
        // attempt to inject a userId — should be ignored by explicit mapping
        ...({ userId: "attacker" } as object),
      });
      expect(updated.userId).toBe(userId);
      expect(updated.name).toBe("Renamed");
    });
  });

  describe("runSaved", () => {
    it("returns simulation result and updates lastRunAt", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      scenariosRepository.save.mockImplementationOnce((s) =>
        Promise.resolve(s),
      );
      const result = await service.runSaved(userId, "scn-1");
      expect(result.percentiles.p50).toHaveLength(5);
      expect(scenariosRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastRunAt: expect.any(Date) }),
      );
    });

    it("uses the live portfolio value when useCurrentBalance is true", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      scenariosRepository.save.mockImplementationOnce((s) =>
        Promise.resolve(s),
      );
      const result = await service.runSaved(userId, "scn-1");
      expect(portfolioService.getPortfolioSummary).toHaveBeenCalledWith(
        userId,
        ["acct-1"],
      );
      // With the deterministic seed and a starting balance of 250k (vs 100k
      // saved on the scenario), the median final should clearly be > 100k.
      expect(result.finalDistribution.median).toBeGreaterThan(150000);
    });
  });

  describe("runAdHoc", () => {
    it("runs without persisting", async () => {
      const result = await service.runAdHoc(userId, validInputs);
      expect(result.percentiles.p50).toHaveLength(10);
      expect(scenariosRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("cash-flow count bound", () => {
    // The simulation is synchronous and its cost grows with the number of
    // cash flows, so every path that stores or runs a list refuses one over
    // MAX_SCENARIO_CASH_FLOWS -- before writing or simulating anything.
    const flows = (n: number): CashFlowDto[] =>
      Array.from({ length: n }, (_, i) => ({
        name: `Flow ${i}`,
        amount: 100,
        flowType: CashFlowTypeDto.ONE_TIME,
        startYear: 1,
        inflationAdjust: false,
      }));
    const storedFlows = (n: number) =>
      flows(n).map(
        (cf, i) =>
          ({
            ...cf,
            id: `cf-${i}`,
            scenarioId: "scn-1",
            endYear: null,
            sortOrder: i,
          }) as unknown as MonteCarloCashFlow,
      );

    it("refuses a saved scenario holding more than the limit (e.g. restored rows) before simulating", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ cashFlows: storedFlows(MAX_SCENARIO_CASH_FLOWS + 1) }),
      );
      const runSpy = jest.spyOn(MonteCarloSimulationService.prototype, "run");
      await expect(service.runSaved(userId, "scn-1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(runSpy).not.toHaveBeenCalled();
      expect(scenariosRepository.save).not.toHaveBeenCalled();
      runSpy.mockRestore();
    });

    it("runs a saved scenario at exactly the limit", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ cashFlows: storedFlows(MAX_SCENARIO_CASH_FLOWS) }),
      );
      scenariosRepository.save.mockImplementationOnce((s) =>
        Promise.resolve(s),
      );
      const result = await service.runSaved(userId, "scn-1");
      expect(result.percentiles.p50).toHaveLength(5);
    });

    it("refuses an ad-hoc run over the limit", async () => {
      await expect(
        service.runAdHoc(userId, {
          ...validInputs,
          cashFlows: flows(MAX_SCENARIO_CASH_FLOWS + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to create a scenario over the limit without writing", async () => {
      await expect(
        service.create(userId, {
          ...validInputs,
          cashFlows: flows(MAX_SCENARIO_CASH_FLOWS + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scenariosRepository.save).not.toHaveBeenCalled();
      expect(cashFlowsRepository.delete).not.toHaveBeenCalled();
      expect(cashFlowsRepository.save).not.toHaveBeenCalled();
    });

    it("refuses to update a scenario over the limit without writing", async () => {
      scenariosRepository.findOne.mockResolvedValue(buildScenario());
      await expect(
        service.update(userId, "scn-1", {
          cashFlows: flows(MAX_SCENARIO_CASH_FLOWS + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scenariosRepository.save).not.toHaveBeenCalled();
      expect(cashFlowsRepository.delete).not.toHaveBeenCalled();
      expect(cashFlowsRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("getHistoricalStats", () => {
    it("rejects empty account list", async () => {
      await expect(
        service.getHistoricalStats(userId, []),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("returns null stats when there are no holdings", async () => {
      holdingsRepository.find.mockResolvedValueOnce([]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.meanReturn).toBeNull();
      expect(stats.volatility).toBeNull();
      expect(stats.currentBalance).toBe(250000);
    });

    it("uses adjusted_close (total return) when the column is populated", async () => {
      // The query selects COALESCE(adjusted_close, close_price). To confirm
      // the SQL is wired through, prove that the alias `close_price` returned
      // by our query actually comes from the adjusted column when both
      // exist: feed it adjusted-driven values and check the mean reflects
      // them, not the raw closes (we don't see the raw closes from the mock,
      // only what the query returns under the close_price alias).
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-1",
        quantity: 10,
        security: {
          symbol: "VOO",
          name: "Vanguard S&P 500",
          currencyCode: "USD",
        },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      // Simulate a clean +10%/yr total return (e.g. 5% price + 5% dividend
      // reinvested) over 6 calendar years. The query already returns
      // COALESCE(adjusted_close, close_price) under the close_price alias.
      // Both the initial query and the post-backfill re-query return the
      // same series — backfill is mocked to a no-op below.
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2020", "100"),
        yearEnd("sec-1", "2021", "110"),
        yearEnd("sec-1", "2022", "121"),
        yearEnd("sec-1", "2023", "133.1"),
        yearEnd("sec-1", "2024", "146.41"),
        yearEnd("sec-1", "2025", "161.051"),
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-1", 161.051]]));

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.meanReturn).not.toBeNull();
      // Expected mean of yearly returns ≈ 0.10
      expect(stats.meanReturn!).toBeCloseTo(0.1, 4);
    });
  });

  describe("historical weighting is in one currency and complete (RR5-003)", () => {
    it("weights securities by common-currency value, not raw native price", async () => {
      // A +20% USD holding worth 100 USD and a -20% JPY holding worth 15,000 JPY
      // that is also 100 USD. Weighting by native price (100 vs 15,000) drowns the
      // USD holding and produces about -20%; in common currency the balanced mix
      // is 0%.
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-usd",
          quantity: 1,
          security: { symbol: "USDCO", name: "USD Co", currencyCode: "USD" },
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-jpy",
          quantity: 1,
          security: { symbol: "JPYCO", name: "JPY Co", currencyCode: "JPY" },
        },
      ]);
      // +20% for the USD security, -20% for the JPY security, two years each.
      const closes = [
        yearEnd("sec-usd", "2023", "100"),
        yearEnd("sec-usd", "2024", "120"),
        yearEnd("sec-usd", "2025", "144"),
        yearEnd("sec-jpy", "2023", "100"),
        yearEnd("sec-jpy", "2024", "80"),
        yearEnd("sec-jpy", "2025", "64"),
      ];
      // A flat rate keeps the JPY return native, so the weighting is the point.
      const flatRates = ["2023", "2024", "2025"].map((y) => ({
        from_currency: "JPY",
        to_currency: "USD",
        rate: 1,
        rate_date: `${y}-12-31`,
      }));
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes("exchange_rates") ? flatRates : closes,
      );
      portfolioService.getLatestPrices = jest.fn().mockResolvedValue(
        new Map([
          ["sec-usd", 100],
          ["sec-jpy", 15000],
        ]),
      );
      // The real converter turns 15,000 JPY into 100 USD; the mock does the same,
      // so both securities carry equal weight.
      portfolioService.convertSecurityValuesToDefault = jest
        .fn()
        .mockResolvedValue({
          valueBySecurity: new Map([
            ["sec-usd", 100],
            ["sec-jpy", 100],
          ]),
          missingRatePairs: [],
        });

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);

      expect(stats.returnsComplete).toBe(true);
      // Balanced: each year the +20% and -20% cancel to 0.
      expect(stats.meanReturn!).toBeCloseTo(0, 6);
    });

    it("refuses when a held security cannot be converted for weighting", async () => {
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-jpy",
          quantity: 1,
          security: { symbol: "JPYCO", name: "JPY Co", currencyCode: "JPY" },
        },
      ]);
      manager.query.mockResolvedValue([
        yearEnd("sec-jpy", "2023", "100"),
        yearEnd("sec-jpy", "2024", "80"),
        yearEnd("sec-jpy", "2025", "64"),
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-jpy", 15000]]));
      portfolioService.convertSecurityValuesToDefault = jest
        .fn()
        .mockResolvedValue({
          valueBySecurity: new Map(),
          missingRatePairs: ["JPY->USD"],
        });

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);

      // A subset return is not the portfolio return.
      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.volatility).toBeNull();
      expect(stats.missingRatePairs).toEqual(["JPY->USD"]);
    });

    it("refuses when a held security has no current price", async () => {
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-priced",
          quantity: 1,
          security: { symbol: "P", name: "Priced", currencyCode: "USD" },
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-unpriced",
          quantity: 1,
          security: { symbol: "U", name: "Unpriced", currencyCode: "USD" },
        },
      ]);
      manager.query.mockResolvedValue([
        yearEnd("sec-priced", "2023", "100"),
        yearEnd("sec-priced", "2024", "110"),
        yearEnd("sec-priced", "2025", "121"),
      ]);
      // Only the priced security has a current price.
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-priced", 121]]));

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);

      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.unpricedSecurityIds).toEqual(["sec-unpriced"]);
    });
  });

  describe("historical return inputs (time-series contract)", () => {
    const holding = (securityId: string, currencyCode = "USD") => ({
      id: `h-${securityId}`,
      accountId: "acct-1",
      securityId,
      quantity: 1,
      security: { symbol: securityId, name: securityId, currencyCode },
    });
    const prices = (entries: Array<[string, number]>) =>
      portfolioService.getLatestPrices.mockResolvedValue(new Map(entries));

    it("loads closes through the one-basis loader, not a per-row COALESCE", async () => {
      holdingsRepository.find.mockResolvedValueOnce([holding("sec-1")]);
      prices([["sec-1", 100]]);
      await service.getHistoricalStats(userId, ["acct-1"]);
      const sqls = manager.query.mock.calls.map((c) => String(c[0]));
      expect(
        sqls.some((q) => q.includes("bool_or(adjusted_close IS NOT NULL)")),
      ).toBe(true);
      expect(sqls.some((q) => q.includes("COALESCE(adjusted_close"))).toBe(
        false,
      );
    });

    it("does not file a two-year move under one year", async () => {
      holdingsRepository.find.mockResolvedValueOnce([holding("sec-1")]);
      prices([["sec-1", 165]]);
      // 2022 has no close: 110 -> 150 spans two years and is not a return.
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2020", "100"),
        yearEnd("sec-1", "2021", "110"),
        yearEnd("sec-1", "2023", "150"),
        yearEnd("sec-1", "2024", "165"),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.yearsObserved).toBe(2);
      expect(stats.meanReturn).toBeCloseTo(0.1, 4);
    });

    it("drops a stale year-end close and the incomplete current year", async () => {
      holdingsRepository.find.mockResolvedValueOnce([holding("sec-1")]);
      prices([["sec-1", 165]]);
      const currentYear = new Date().getUTCFullYear();
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2020", "100"),
        yearEnd("sec-1", "2021", "110"),
        // Last 2022 close is two months before year end: not the year end.
        { ...yearEnd("sec-1", "2022", "500"), price_date: "2022-10-31" },
        yearEnd("sec-1", "2023", "133.1"),
        {
          ...yearEnd("sec-1", String(currentYear), "999"),
          price_date: `${currentYear}-02-01`,
        },
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      // Only 2021 (110/100) is a clean consecutive pair.
      expect(stats.yearsObserved).toBe(1);
    });

    it("names a missing cash pair when the summary is incomplete", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({
        totalPortfolioValue: 200000,
        totalCashValue: 100000,
        fxComplete: false,
        missingRatePairs: ["EUR->USD"],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: false,
      });
      holdingsRepository.find.mockResolvedValueOnce([holding("sec-1")]);
      prices([["sec-1", 100000]]);
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2022", "100"),
        yearEnd("sec-1", "2023", "120"),
        yearEnd("sec-1", "2024", "120"),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.missingRatePairs).toEqual(["EUR->USD"]);
      expect(stats.portfolioValueUnknown).toBe(true);
    });

    it("flags an unknown portfolio value when the summary fails outright", async () => {
      portfolioService.getPortfolioSummary.mockRejectedValue(
        new Error("db down"),
      );
      holdingsRepository.find.mockResolvedValueOnce([holding("sec-1")]);
      prices([["sec-1", 100000]]);
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2022", "100"),
        yearEnd("sec-1", "2023", "120"),
        yearEnd("sec-1", "2024", "120"),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.returnsComplete).toBe(false);
      expect(stats.missingRatePairs).toEqual([]);
      expect(stats.portfolioValueUnknown).toBe(true);
    });

    it("weights idle cash at zero return and zero volatility", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({
        totalPortfolioValue: 200000,
        totalCashValue: 100000,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
      });
      holdingsRepository.find.mockResolvedValueOnce([holding("sec-1")]);
      prices([["sec-1", 100000]]);
      // +20% then 0%: mean 10%, stdev 14.14% on its own.
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2022", "100"),
        yearEnd("sec-1", "2023", "120"),
        yearEnd("sec-1", "2024", "120"),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.meanReturn).toBeCloseTo(0.05, 4);
      expect(stats.volatility).toBeCloseTo(0.0707, 4);
    });

    // Year-end closes and the exchange_rates read share manager.query; route
    // by statement so each gets its own rows.
    const routeQueries = (closes: unknown[], rates: unknown[]) =>
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes("exchange_rates") ? rates : closes,
      );
    const rateRow = (date: string, rate: number) => ({
      from_currency: "JPY",
      to_currency: "USD",
      rate,
      rate_date: date,
    });
    const jpyCloses = () => [
      yearEnd("sec-jpy", "2022", "100"),
      yearEnd("sec-jpy", "2023", "100"),
      yearEnd("sec-jpy", "2024", "100"),
    ];

    it("converts each year-end close at the rate of its own date", async () => {
      holdingsRepository.find.mockResolvedValueOnce([
        holding("sec-jpy", "JPY"),
      ]);
      prices([["sec-jpy", 100]]);
      // Flat in yen; the yen gains 10% a year against the dollar.
      routeQueries(jpyCloses(), [
        rateRow("2022-12-31", 0.01),
        rateRow("2023-12-31", 0.011),
        rateRow("2024-12-31", 0.0121),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.returnsComplete).toBe(true);
      expect(stats.meanReturn).toBeCloseTo(0.1, 4);
    });

    it("loads each pair's rates once, not once per year-end close", async () => {
      holdingsRepository.find.mockResolvedValueOnce([
        holding("sec-jpy", "JPY"),
      ]);
      prices([["sec-jpy", 100]]);
      routeQueries(jpyCloses(), [
        rateRow("2022-12-31", 0.01),
        rateRow("2023-12-31", 0.011),
        rateRow("2024-12-31", 0.0121),
      ]);
      await service.getHistoricalStats(userId, ["acct-1"]);
      const rateLoads = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("exchange_rates"),
      );
      expect(rateLoads).toHaveLength(1);
    });

    it("refuses, naming the pair, when a year-end rate is missing", async () => {
      holdingsRepository.find.mockResolvedValueOnce([
        holding("sec-jpy", "JPY"),
      ]);
      prices([["sec-jpy", 100]]);
      routeQueries(jpyCloses(), [
        rateRow("2022-12-31", 0.01),
        rateRow("2024-12-31", 0.01),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.missingRatePairs).toEqual(["JPY->USD"]);
    });
  });

  describe("year-end FX gaps", () => {
    const rateRow = (date: string, rate: number) => ({
      from_currency: "JPY",
      to_currency: "USD",
      rate,
      rate_date: date,
    });
    const jpyHolding = () =>
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h-jpy",
          accountId: "acct-1",
          securityId: "sec-jpy",
          quantity: 1,
          security: { symbol: "JPY1", name: "Yen", currencyCode: "JPY" },
        },
      ]);
    const closeRows = (years: number[]) =>
      years.map((y) => yearEnd("sec-jpy", String(y), "100"));
    const route = (years: number[], rates: () => unknown[]) =>
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes("exchange_rates") ? rates() : closeRows(years),
      );
    const priceJpy = () =>
      portfolioService.getLatestPrices.mockResolvedValue(
        new Map([["sec-jpy", 100]]),
      );

    it("fetches the missing pair's history, then converts again", async () => {
      jpyHolding();
      priceJpy();
      let fetched = false;
      exchangeRateService.ensureRatesForDate.mockImplementation(async () => {
        fetched = true;
        return 12;
      });
      route([2021, 2022, 2023, 2024], () =>
        fetched
          ? [2021, 2022, 2023, 2024].map((y) => rateRow(`${y}-12-31`, 0.01))
          : [],
      );
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(exchangeRateService.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "JPY", to: "USD" }],
        "2022-12-31",
      );
      expect(stats.returnsComplete).toBe(true);
      expect(stats.yearsObserved).toBe(3);
    });

    it("drops the one year whose close cannot convert and keeps the stats", async () => {
      jpyHolding();
      priceJpy();
      // 2020-2025 closes; no rate for 2022 and the provider has nothing.
      const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
      route(years, () =>
        years.filter((y) => y !== 2022).map((y) => rateRow(`${y}-12-31`, 0.01)),
      );
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(exchangeRateService.ensureRatesForDate).toHaveBeenCalled();
      expect(stats.returnsComplete).toBe(true);
      // 2019, 2020, 2021 and 2024, 2025 remain: 2022 and 2023 touch the gap.
      expect(stats.yearsObserved).toBe(5);
      expect(stats.meanReturn).not.toBeNull();
    });

    it("withholds the stats when the gap leaves too few yearly returns", async () => {
      jpyHolding();
      priceJpy();
      route([2022, 2023, 2024], () => [
        rateRow("2022-12-31", 0.01),
        rateRow("2024-12-31", 0.01),
      ]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.missingRatePairs).toEqual(["JPY->USD"]);
    });
  });

  describe("backfill cooldown", () => {
    it("calls the provider for a sparse holding that has never been backfilled", async () => {
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-new",
        quantity: 1,
        security: {
          symbol: "NEWCO",
          name: "Newly Listed",
          currencyCode: "USD",
        },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      // Sparse: only 1 yearly return → triggers backfill check.
      manager.query.mockResolvedValue([
        yearEnd("sec-new", "2024", "100"),
        yearEnd("sec-new", "2025", "110"),
      ]);
      securitiesRepository.find.mockResolvedValueOnce([
        {
          id: "sec-new",
          symbol: "NEWCO",
          historicalBackfillAttemptedAt: null,
        },
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-new", 110]]));

      await service.getHistoricalStats(userId, ["acct-1"]);
      expect(securityPriceService.backfillSecurityRange).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sec-new" }),
        "10y",
      );
      expect(securitiesRepository.update).toHaveBeenCalled();
    });

    it("skips the provider when a recent backfill attempt is on file", async () => {
      const recent = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-recent",
        quantity: 1,
        security: { symbol: "RCNT", name: "Recent", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([
        yearEnd("sec-recent", "2024", "100"),
        yearEnd("sec-recent", "2025", "110"),
      ]);
      securitiesRepository.find.mockResolvedValueOnce([
        {
          id: "sec-recent",
          symbol: "RCNT",
          historicalBackfillAttemptedAt: recent,
        },
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-recent", 110]]));

      await service.getHistoricalStats(userId, ["acct-1"]);
      expect(securityPriceService.backfillSecurityRange).not.toHaveBeenCalled();
      expect(securitiesRepository.update).not.toHaveBeenCalled();
    });

    it("retries the provider once the cooldown window has expired", async () => {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-stale",
        quantity: 1,
        security: { symbol: "STAL", name: "Stale", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([
        yearEnd("sec-stale", "2024", "100"),
        yearEnd("sec-stale", "2025", "110"),
      ]);
      securitiesRepository.find.mockResolvedValueOnce([
        {
          id: "sec-stale",
          symbol: "STAL",
          historicalBackfillAttemptedAt: stale,
        },
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-stale", 110]]));

      await service.getHistoricalStats(userId, ["acct-1"]);
      expect(securityPriceService.backfillSecurityRange).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  describe("remove", () => {
    it("deletes the scenario", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      await service.remove(userId, "scn-1");
      expect(scenariosRepository.remove).toHaveBeenCalledWith(existing);
    });
  });

  describe("reorder", () => {
    it("writes sortOrder to each scenario inside a transaction", async () => {
      await service.reorder(userId, ["scn-2", "scn-1", "scn-3"]);
      // All three writes share one scoped transaction.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenNthCalledWith(
        1,
        MonteCarloScenario,
        { id: "scn-2", userId },
        { sortOrder: 0 },
      );
      expect(manager.update).toHaveBeenNthCalledWith(
        2,
        MonteCarloScenario,
        { id: "scn-1", userId },
        { sortOrder: 1 },
      );
      expect(manager.update).toHaveBeenNthCalledWith(
        3,
        MonteCarloScenario,
        { id: "scn-3", userId },
        { sortOrder: 2 },
      );
    });

    it("aborts the transaction when an update fails", async () => {
      manager.update.mockRejectedValueOnce(new Error("boom"));
      await expect(service.reorder(userId, ["scn-1", "scn-2"])).rejects.toThrow(
        "boom",
      );
      // The failure propagates out of the single scoped transaction, so the
      // second update never runs.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-array argument", async () => {
      await expect(
        service.reorder(userId, "not an array" as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("findAll", () => {
    it("sorts cashFlows on each scenario by sortOrder", async () => {
      const a = buildScenario({
        id: "a",
        cashFlows: [
          { id: "cf-2", sortOrder: 1 } as never,
          { id: "cf-1", sortOrder: 0 } as never,
        ] as never,
      });
      const b = buildScenario({ id: "b", cashFlows: undefined as never });
      scenariosRepository.find.mockResolvedValue([a, b]);
      const result = await service.findAll(userId);
      expect(result).toHaveLength(2);
      expect(a.cashFlows![0].id).toBe("cf-1");
    });
  });

  describe("findOne sorts cashFlows", () => {
    it("sorts the loaded cashFlows by sortOrder", async () => {
      const cashFlows = [
        { id: "cf-3", sortOrder: 2 } as never,
        { id: "cf-1", sortOrder: 0 } as never,
        { id: "cf-2", sortOrder: 1 } as never,
      ];
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ cashFlows: cashFlows as never }),
      );
      const result = await service.findOne(userId, "scn-1");
      expect(result.cashFlows!.map((c) => c.id)).toEqual([
        "cf-1",
        "cf-2",
        "cf-3",
      ]);
    });
  });

  describe("update branches", () => {
    it("applies all whitelisted fields when each is present in the dto", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      scenariosRepository.findOne.mockResolvedValueOnce({
        ...existing,
        name: "X",
      });

      await service.update(userId, "scn-1", {
        name: "X",
        description: "d",
        accountIds: ["a-2"],
        startingValue: 1,
        useCurrentBalance: true,
        yearsToRetirement: 2,
        annualContribution: 3,
        contributionGrowthRate: 0.01,
        yearsInRetirement: 4,
        annualWithdrawal: 5,
        expectedReturn: 0.06,
        volatility: 0.2,
        inflationRate: 0.01,
        showRealValues: true,
        useHistoricalReturns: true,
        simulationCount: 100,
        targetValue: 1_000_000,
        randomSeed: "seed",
        isFavourite: true,
        cashFlows: [],
      } as never);
      expect(scenariosRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "X",
          accountIds: ["a-2"],
          isFavourite: true,
          targetValue: 1_000_000,
          randomSeed: "seed",
        }),
      );
    });

    it("converts null description / targetValue / randomSeed to null", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      await service.update(userId, "scn-1", {
        description: null as never,
        targetValue: null as never,
        randomSeed: null as never,
      });
      expect(scenariosRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          description: null,
          targetValue: null,
          randomSeed: null,
        }),
      );
    });

    it("does not delete cashFlows when the dto omits them", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      cashFlowsRepository.delete.mockClear();
      await service.update(userId, "scn-1", { name: "Y" });
      expect(cashFlowsRepository.delete).not.toHaveBeenCalled();
    });

    it("clears existing cashFlows when an empty array is provided", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      await service.update(userId, "scn-1", { cashFlows: [] });
      expect(cashFlowsRepository.delete).toHaveBeenCalledWith({
        scenarioId: "scn-1",
      });
      // No new rows should be created when the list is empty.
      expect(cashFlowsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe("getHoldingStats", () => {
    it("rejects empty account list", async () => {
      await expect(service.getHoldingStats(userId, [])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("returns [] when no requested accounts belong to the user", async () => {
      accountsRepository.find.mockResolvedValueOnce([]);
      const result = await service.getHoldingStats(userId, ["other"]);
      expect(result).toEqual([]);
    });

    it("returns empty holdings entries when user has no active holdings", async () => {
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      holdingsRepository.find.mockResolvedValueOnce([]);
      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result).toEqual([
        {
          accountId: "acct-1",
          accountName: "A",
          currencyCode: "USD",
          holdings: [],
        },
      ]);
    });

    it("computes per-holding stats with security symbol/currency fallbacks", async () => {
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-1",
        quantity: 5,
        security: undefined, // exercise the ?? fallbacks
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2023", "100"),
        yearEnd("sec-1", "2024", "110"),
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-1", 110]]));

      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result[0].holdings[0]).toEqual(
        expect.objectContaining({
          symbol: "?",
          name: "Unknown",
          currencyCode: null,
          marketValue: 550,
        }),
      );
    });

    it("reports marketValue as null when no current price is available (RR4-004)", async () => {
      // This test used to assert `0`, entrenching the defect: a held position with
      // no quote was reported as worth nothing, in the same report that refuses to
      // project from an incomplete current value. Unknown is not zero.
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-1",
        quantity: 5,
        security: { symbol: "X", name: "X co", currencyCode: "EUR" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([]);
      portfolioService.getLatestPrices = jest.fn().mockResolvedValue(new Map());

      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result[0].holdings[0].marketValue).toBeNull();
      expect(result[0].holdings[0].meanReturn).toBeNull();
    });

    it("still reports a real zero market value as zero", async () => {
      // The control: a security genuinely priced at 0 stays 0, so the nullable
      // field does not turn every cheap holding into an unknown one.
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-1",
          quantity: 5,
          security: { symbol: "X", name: "X co", currencyCode: "USD" },
        },
      ]);
      manager.query.mockResolvedValue([]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-1", 0]]));

      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result[0].holdings[0].marketValue).toBe(0);
    });

    it("ignores holdings whose accountId is not in the (verified) account set", async () => {
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-1", name: "A", currencyCode: "USD" },
      ]);
      const matchingHolding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-1",
        quantity: 5,
        security: { symbol: "X", name: "X", currencyCode: "USD" },
      };
      const orphanedHolding = {
        id: "h2",
        accountId: "stranger",
        securityId: "sec-1",
        quantity: 1,
        security: { symbol: "X", name: "X", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([
        matchingHolding,
        orphanedHolding,
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-1", 100]]));

      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result[0].holdings).toHaveLength(1);
    });
  });

  describe("getBrokerageAccounts", () => {
    it("delegates to portfolioService", async () => {
      (portfolioService as Record<string, jest.Mock>).getBrokerageAccounts =
        jest.fn().mockResolvedValue([{ id: "a1" }]);
      const result = await service.getBrokerageAccounts(userId);
      expect(result).toEqual([{ id: "a1" }]);
    });
  });

  describe("computeCurrentValue branches via runSaved", () => {
    it("refuses to run when the portfolio valuation throws (P5-010)", async () => {
      // This test previously read "returns 0 when portfolio service throws" and
      // asserted only that the call did not blow up -- it documented the defect
      // as intended behaviour. A user with 100,000 invested got a full
      // retirement projection built from an opening portfolio of nothing:
      // success rate, percentile bands and safe-withdrawal figures all
      // mathematically valid and financially meaningless, with nothing on
      // screen to say the valuation had failed.
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockRejectedValueOnce(
        new Error("db down"),
      );

      await expect(service.runSaved(userId, "scn-1")).rejects.toThrow(
        /could not be determined/,
      );
    });

    it("refuses to run when the portfolio value is not finite", async () => {
      // A non-finite aggregate means some component was unusable, which is a
      // failure to value rather than a value of zero.
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockResolvedValueOnce({
        totalPortfolioValue: NaN,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
      });

      await expect(service.runSaved(userId, "scn-1")).rejects.toThrow(
        /could not be determined/,
      );
    });

    it("refuses to run from an incomplete portfolio total (FR-005)", async () => {
      // The check used to look only for a thrown error or a non-finite number, so
      // a portfolio with one unresolvable currency pair handed over a perfectly
      // finite figure -- short by whatever could not be converted -- and the
      // simulation ran from it. A subtotal is not a starting portfolio value.
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockResolvedValueOnce({
        totalPortfolioValue: 100,
        fxComplete: false,
        missingRatePairs: ["EUR->USD"],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: false,
      });

      await expect(service.runSaved(userId, "scn-1")).rejects.toThrow(
        /could not be determined/,
      );
    });

    it("refuses to run when a held position has no price (RR3-004)", async () => {
      // A different cause from a missing rate and the same consequence. The FX gate
      // did not cover it: an unpriced holding was dropped out of the total without
      // recording anything, so `fxComplete` stayed true and the simulation started
      // from a value short by that whole position.
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockResolvedValueOnce({
        totalPortfolioValue: 100,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: false,
        unpricedSecurityIds: ["sec-2"],
        valuationComplete: false,
      });

      await expect(service.runSaved(userId, "scn-1")).rejects.toThrow(
        /could not be determined/,
      );
    });

    it("still runs from a genuinely empty portfolio", async () => {
      // Zero is a known answer. Refusing here would tell the user a settled
      // question could not be worked out, which is the other half of the same
      // mistake.
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockResolvedValueOnce({
        totalPortfolioValue: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
      });
      scenariosRepository.save.mockImplementationOnce((s) =>
        Promise.resolve(s),
      );

      const result = await service.runSaved(userId, "scn-1");
      expect(result).toBeDefined();
    });
  });

  describe("resolveReturns branches via runAdHoc", () => {
    it("uses fallback returns when useHistoricalReturns is false", async () => {
      const result = await service.runAdHoc(userId, {
        ...validInputs,
        useHistoricalReturns: false,
      });
      expect(result).toBeDefined();
      expect(holdingsRepository.find).not.toHaveBeenCalled();
    });

    it("uses fallback when accountIds is empty even if historical is requested", async () => {
      const result = await service.runAdHoc(userId, {
        ...validInputs,
        accountIds: [],
        useHistoricalReturns: true,
        useCurrentBalance: false,
      });
      expect(result).toBeDefined();
    });

    it("uses computed historical stats when available", async () => {
      const holding = {
        id: "h1",
        accountId: validInputs.accountIds[0],
        securityId: "sec-1",
        quantity: 10,
        security: { symbol: "VOO", name: "VOO", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([
        yearEnd("sec-1", "2020", "100"),
        yearEnd("sec-1", "2021", "110"),
        yearEnd("sec-1", "2022", "121"),
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-1", 121]]));

      const result = await service.runAdHoc(userId, {
        ...validInputs,
        useHistoricalReturns: true,
      });
      expect(result).toBeDefined();
    });

    it("refuses the run when historical returns cannot be computed", async () => {
      // No holdings → meanReturn null. The old behaviour silently substituted
      // the manually entered figures, so a run configured as "use historical
      // returns" proceeded on a stale form default with nothing in the result
      // saying so (review #1132). Refuse, like requireCurrentValue does.
      holdingsRepository.find.mockResolvedValueOnce([]);
      await expect(
        service.runAdHoc(userId, {
          ...validInputs,
          useHistoricalReturns: true,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("ownership of requested accounts (review #1132)", () => {
    it("does not read holdings for accounts the caller does not own", async () => {
      // The Holding query filters on accountId alone, so without the guard a
      // caller could read another user's return statistics by supplying their
      // account ids.
      accountsRepository.find.mockResolvedValueOnce([]);

      const stats = await service.getHistoricalStats(userId, [
        "someone-elses-account",
      ]);

      expect(holdingsRepository.find).not.toHaveBeenCalled();
      expect(stats.meanReturn).toBeNull();
      expect(stats.volatility).toBeNull();
      expect(stats.returnsComplete).toBe(true);
      expect(stats.currentBalance).toBe(0);
      expect(accountsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId }),
        }),
      );
    });

    it("restricts holdings to the owned subset of the requested accounts", async () => {
      accountsRepository.find.mockResolvedValueOnce([
        { id: "acct-mine", userId, name: "Mine", currencyCode: "USD" },
      ]);
      holdingsRepository.find.mockResolvedValueOnce([]);

      await service.getHistoricalStats(userId, ["acct-mine", "acct-foreign"]);

      const where = holdingsRepository.find.mock.calls[0][0].where;
      expect(where.accountId.value).toEqual(["acct-mine"]);
    });
  });

  describe("weighting completeness (review #1132)", () => {
    const accountRow = { id: "acct-1", userId, name: "A", currencyCode: "USD" };

    it("uses only years where every weighted security has a return", async () => {
      // sec-a has returns for 2023-2025; sec-b only for 2024-2025. The old
      // shape renormalized 2023 over sec-a alone, reporting a subset year
      // under returnsComplete: true. Only the fully covered years count.
      accountsRepository.find.mockResolvedValueOnce([accountRow]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-a",
          quantity: 1,
          security: { symbol: "A", name: "A", currencyCode: "USD" },
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-b",
          quantity: 1,
          security: { symbol: "B", name: "B", currencyCode: "USD" },
        },
      ]);
      manager.query.mockResolvedValue([
        yearEnd("sec-a", "2022", "100"),
        yearEnd("sec-a", "2023", "200"), // +100% — the subset year
        yearEnd("sec-a", "2024", "220"), // +10%
        yearEnd("sec-a", "2025", "242"), // +10%
        yearEnd("sec-b", "2023", "100"),
        yearEnd("sec-b", "2024", "110"), // +10%
        yearEnd("sec-b", "2025", "121"), // +10%
      ]);
      portfolioService.getLatestPrices = jest.fn().mockResolvedValue(
        new Map([
          ["sec-a", 242],
          ["sec-b", 121],
        ]),
      );

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);

      // 2024 and 2025 are fully covered; 2023 (sec-a alone, +100%) is not a
      // portfolio year and must not appear.
      expect(stats.yearsObserved).toBe(2);
      expect(stats.returnsComplete).toBe(true);
      expect(stats.meanReturn!).toBeCloseTo(0.1, 6);
    });

    it("refuses when a weighted security is net short", async () => {
      // A long-only value weighting cannot represent a negative weight, and
      // dropping it silently made the long subset stand in for the portfolio.
      accountsRepository.find.mockResolvedValueOnce([accountRow]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-long",
          quantity: 10,
          security: { symbol: "L", name: "Long", currencyCode: "USD" },
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-short",
          quantity: -10,
          security: { symbol: "S", name: "Short", currencyCode: "USD" },
        },
      ]);
      manager.query.mockResolvedValue([
        yearEnd("sec-long", "2023", "100"),
        yearEnd("sec-long", "2024", "110"),
        yearEnd("sec-long", "2025", "121"),
        yearEnd("sec-short", "2023", "50"),
        yearEnd("sec-short", "2024", "55"),
        yearEnd("sec-short", "2025", "60.5"),
      ]);
      portfolioService.getLatestPrices = jest.fn().mockResolvedValue(
        new Map([
          ["sec-long", 121],
          ["sec-short", 60.5],
        ]),
      );

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);

      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.volatility).toBeNull();
      expect(stats.unweightableSecurityIds).toEqual(["sec-short"]);
    });

    it("refuses when a held security's currency is unknown instead of assuming USD", async () => {
      // Fabricating USD converted a foreign value at the USD rate — a silent
      // FX fallback in the exact path the refusal exists for.
      accountsRepository.find.mockResolvedValueOnce([accountRow]);
      holdingsRepository.find.mockResolvedValueOnce([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-nocur",
          quantity: 1,
          security: null,
        },
      ]);
      manager.query.mockResolvedValue([
        yearEnd("sec-nocur", "2023", "100"),
        yearEnd("sec-nocur", "2024", "110"),
        yearEnd("sec-nocur", "2025", "121"),
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-nocur", 121]]));

      const stats = await service.getHistoricalStats(userId, ["acct-1"]);

      expect(stats.returnsComplete).toBe(false);
      expect(stats.meanReturn).toBeNull();
      expect(stats.unweightableSecurityIds).toEqual(["sec-nocur"]);
    });
  });

  describe("backfill error tolerance", () => {
    it("swallows provider errors during sparse-history backfill", async () => {
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-x",
        quantity: 1,
        security: { symbol: "X", name: "X", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([
        yearEnd("sec-x", "2024", "100"),
        yearEnd("sec-x", "2025", "110"),
      ]);
      securitiesRepository.find.mockResolvedValueOnce([
        {
          id: "sec-x",
          symbol: "X",
          historicalBackfillAttemptedAt: null,
        },
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-x", 110]]));
      securityPriceService.backfillSecurityRange.mockRejectedValueOnce(
        new Error("API down"),
      );

      await expect(
        service.getHistoricalStats(userId, ["acct-1"]),
      ).resolves.toBeDefined();
      expect(securitiesRepository.update).toHaveBeenCalled();
    });

    it("treats invalid stamp dates as 'never attempted'", async () => {
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-x",
        quantity: 1,
        security: { symbol: "X", name: "X", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      manager.query.mockResolvedValue([
        yearEnd("sec-x", "2024", "100"),
        yearEnd("sec-x", "2025", "110"),
      ]);
      securitiesRepository.find.mockResolvedValueOnce([
        {
          id: "sec-x",
          symbol: "X",
          historicalBackfillAttemptedAt: "not a date",
        },
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-x", 110]]));

      await service.getHistoricalStats(userId, ["acct-1"]);
      expect(securityPriceService.backfillSecurityRange).toHaveBeenCalled();
    });
  });
});
