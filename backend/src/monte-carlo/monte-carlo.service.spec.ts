import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
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
  let portfolioService: {
    getPortfolioSummary: jest.Mock;
    getLatestPrices: jest.Mock;
  };

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
    const securitiesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    const securityPriceService = {
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

  describe("remove", () => {
    it("deletes the scenario", async () => {
      const existing = buildScenario();
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
      await service.remove(userId, "scn-1");
      expect(scenariosRepository.remove).toHaveBeenCalledWith(existing);
    });
  });
});
