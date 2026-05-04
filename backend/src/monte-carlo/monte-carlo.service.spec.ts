import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MonteCarloService } from "./monte-carlo.service";
import { MonteCarloSimulationService } from "./monte-carlo-simulation.service";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { PortfolioService } from "../securities/portfolio.service";
import { CreateScenarioDto } from "./dto/create-scenario.dto";

describe("MonteCarloService", () => {
  let service: MonteCarloService;
  let scenariosRepository: Record<string, jest.Mock>;
  let investmentTxRepository: Record<string, jest.Mock>;
  let portfolioService: { getPortfolioSummary: jest.Mock };

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
    investmentTxRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    portfolioService = {
      getPortfolioSummary: jest.fn().mockResolvedValue({
        totalPortfolioValue: 250000,
      }),
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
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTxRepository,
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
      await service.create(userId, validInputs);
      expect(scenariosRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId, name: "Test scenario" }),
      );
      expect(scenariosRepository.save).toHaveBeenCalled();
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
      scenariosRepository.findOne.mockResolvedValueOnce(existing);
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

    it("returns null stats when there is no transaction history", async () => {
      investmentTxRepository.find.mockResolvedValueOnce([]);
      const stats = await service.getHistoricalStats(userId, ["acct-1"]);
      expect(stats.meanReturn).toBeNull();
      expect(stats.volatility).toBeNull();
      expect(stats.currentBalance).toBe(250000);
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
