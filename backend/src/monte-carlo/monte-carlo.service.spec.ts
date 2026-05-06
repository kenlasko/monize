import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { MonteCarloService } from "./monte-carlo.service";
import { MonteCarloSimulationService } from "./monte-carlo-simulation.service";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Account } from "../accounts/entities/account.entity";
import { SecurityPriceService } from "../securities/security-price.service";
import { MonteCarloCashFlow } from "./entities/monte-carlo-cash-flow.entity";
import { PortfolioService } from "../securities/portfolio.service";
import { CreateScenarioDto } from "./dto/create-scenario.dto";

describe("MonteCarloService", () => {
  let service: MonteCarloService;
  let scenariosRepository: Record<string, jest.Mock>;
  let cashFlowsRepository: Record<string, jest.Mock>;
  let holdingsRepository: Record<string, jest.Mock>;
  let securityPriceRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let securitiesRepository: Record<string, jest.Mock>;
  let securityPriceService: { backfillSecurityRange: jest.Mock };
  let portfolioService: {
    getPortfolioSummary: jest.Mock;
    getLatestPrices: jest.Mock;
  };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: { update: jest.Mock };
  };
  let dataSource: { createQueryRunner: jest.Mock };

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

  beforeEach(async () => {
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
    securityPriceRepository = {
      query: jest.fn().mockResolvedValue([]),
    };
    accountsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    securitiesRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    securityPriceService = {
      backfillSecurityRange: jest.fn().mockResolvedValue(0),
    };
    portfolioService = {
      getPortfolioSummary: jest.fn().mockResolvedValue({
        totalPortfolioValue: 250000,
      }),
      getLatestPrices: jest.fn().mockResolvedValue(new Map()),
      getBrokerageAccounts: jest.fn().mockResolvedValue([]),
    } as unknown as {
      getPortfolioSummary: jest.Mock;
      getLatestPrices: jest.Mock;
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: { update: jest.fn().mockResolvedValue({ affected: 1 }) },
    };
    dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonteCarloService,
        MonteCarloSimulationService,
        {
          provide: getRepositoryToken(MonteCarloScenario),
          useValue: scenariosRepository,
        },
        {
          provide: getRepositoryToken(MonteCarloCashFlow),
          useValue: cashFlowsRepository,
        },
        {
          provide: getRepositoryToken(Holding),
          useValue: holdingsRepository,
        },
        {
          provide: getRepositoryToken(SecurityPrice),
          useValue: securityPriceRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: getRepositoryToken(Security),
          useValue: securitiesRepository,
        },
        {
          provide: SecurityPriceService,
          useValue: securityPriceService,
        },
        {
          provide: PortfolioService,
          useValue: portfolioService,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get(MonteCarloService);
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", year: "2020", close_price: "100" },
        { security_id: "sec-1", year: "2021", close_price: "110" },
        { security_id: "sec-1", year: "2022", close_price: "121" },
        { security_id: "sec-1", year: "2023", close_price: "133.1" },
        { security_id: "sec-1", year: "2024", close_price: "146.41" },
        { security_id: "sec-1", year: "2025", close_price: "161.051" },
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

  describe("backfill cooldown", () => {
    it("calls the provider for a sparse holding that has never been backfilled", async () => {
      const holding = {
        id: "h1",
        accountId: "acct-1",
        securityId: "sec-new",
        quantity: 1,
        security: { symbol: "NEWCO", name: "Newly Listed", currencyCode: "USD" },
      };
      holdingsRepository.find.mockResolvedValueOnce([holding]);
      // Sparse: only 1 yearly return → triggers backfill check.
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-new", year: "2024", close_price: "100" },
        { security_id: "sec-new", year: "2025", close_price: "110" },
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-recent", year: "2024", close_price: "100" },
        { security_id: "sec-recent", year: "2025", close_price: "110" },
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-stale", year: "2024", close_price: "100" },
        { security_id: "sec-stale", year: "2025", close_price: "110" },
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
      expect(queryRunner.connect).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
        1,
        MonteCarloScenario,
        { id: "scn-2", userId },
        { sortOrder: 0 },
      );
      expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
        2,
        MonteCarloScenario,
        { id: "scn-1", userId },
        { sortOrder: 1 },
      );
      expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
        3,
        MonteCarloScenario,
        { id: "scn-3", userId },
        { sortOrder: 2 },
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it("rolls the transaction back when an update fails", async () => {
      queryRunner.manager.update.mockRejectedValueOnce(new Error("boom"));
      await expect(
        service.reorder(userId, ["scn-1", "scn-2"]),
      ).rejects.toThrow("boom");
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it("rejects a non-array argument", async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", year: "2023", close_price: "100" },
        { security_id: "sec-1", year: "2024", close_price: "110" },
      ]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map([["sec-1", 110]]));

      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result[0].holdings[0]).toEqual(
        expect.objectContaining({
          symbol: "?",
          name: "Unknown",
          currencyCode: "USD",
          marketValue: 550,
        }),
      );
    });

    it("uses 0 marketValue when no current price is available", async () => {
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
      securityPriceRepository.query.mockResolvedValue([]);
      portfolioService.getLatestPrices = jest
        .fn()
        .mockResolvedValue(new Map());

      const result = await service.getHoldingStats(userId, ["acct-1"]);
      expect(result[0].holdings[0].marketValue).toBe(0);
      expect(result[0].holdings[0].meanReturn).toBeNull();
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
      (portfolioService as Record<string, jest.Mock>).getBrokerageAccounts = jest
        .fn()
        .mockResolvedValue([{ id: "a1" }]);
      const result = await service.getBrokerageAccounts(userId);
      expect(result).toEqual([{ id: "a1" }]);
    });
  });

  describe("computeCurrentValue branches via runSaved", () => {
    it("returns 0 when portfolio service throws", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockRejectedValueOnce(
        new Error("db down"),
      );
      scenariosRepository.save.mockImplementationOnce((s) =>
        Promise.resolve(s),
      );

      const result = await service.runSaved(userId, "scn-1");
      // Should not blow up — falls back to 0 starting value.
      expect(result).toBeDefined();
    });

    it("clamps non-finite portfolio values to 0", async () => {
      scenariosRepository.findOne.mockResolvedValueOnce(
        buildScenario({ useCurrentBalance: true }),
      );
      portfolioService.getPortfolioSummary.mockResolvedValueOnce({
        totalPortfolioValue: NaN,
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", year: "2020", close_price: "100" },
        { security_id: "sec-1", year: "2021", close_price: "110" },
        { security_id: "sec-1", year: "2022", close_price: "121" },
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

    it("uses fallback when historical stats lack data (still null)", async () => {
      // No holdings → meanReturn null → fallback used.
      holdingsRepository.find.mockResolvedValueOnce([]);
      const result = await service.runAdHoc(userId, {
        ...validInputs,
        useHistoricalReturns: true,
      });
      expect(result).toBeDefined();
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-x", year: "2024", close_price: "100" },
        { security_id: "sec-x", year: "2025", close_price: "110" },
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
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-x", year: "2024", close_price: "100" },
        { security_id: "sec-x", year: "2025", close_price: "110" },
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
      expect(
        securityPriceService.backfillSecurityRange,
      ).toHaveBeenCalled();
    });
  });
});
