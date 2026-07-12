import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { LoanScenariosService } from "./loan-scenarios.service";
import { LoanScenario } from "./entities/loan-scenario.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";

describe("LoanScenariosService", () => {
  let service: LoanScenariosService;
  let scenariosRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let queryBuilderMock: Record<string, jest.Mock>;

  const userId = "user-1";
  const accountId = "account-1";

  const mockAccount = {
    id: accountId,
    userId,
    accountType: AccountType.MORTGAGE,
  } as Account;

  const mockScenario = {
    id: "scenario-1",
    userId,
    accountId,
    name: "Extra 200",
    recurringExtraAmount: 200,
    recurringExtraStartDate: null,
    recurringExtraEndDate: null,
    lumpSums: [{ date: "2026-06-01", amount: 5000 }],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  } as LoanScenario;

  beforeEach(async () => {
    queryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    scenariosRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      merge: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilderMock),
    };

    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(mockAccount),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanScenariosService,
        {
          provide: getRepositoryToken(LoanScenario),
          useValue: scenariosRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
      ],
    }).compile();

    service = module.get<LoanScenariosService>(LoanScenariosService);
  });

  describe("findAll", () => {
    it("returns the account's scenarios ordered by name", async () => {
      scenariosRepository.find.mockResolvedValue([mockScenario]);

      const result = await service.findAll(userId, accountId);

      expect(accountsRepository.findOne).toHaveBeenCalledWith({
        where: { id: accountId, userId },
      });
      expect(scenariosRepository.find).toHaveBeenCalledWith({
        where: { userId, accountId },
        order: { name: "ASC" },
      });
      expect(result).toEqual([mockScenario]);
    });

    it("rejects an account the user does not own", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(service.findAll(userId, accountId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("rejects non-loan account types", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.CHEQUING,
      });

      await expect(service.findAll(userId, accountId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("accepts LOAN and LINE_OF_CREDIT accounts", async () => {
      scenariosRepository.find.mockResolvedValue([]);
      for (const accountType of [
        AccountType.LOAN,
        AccountType.LINE_OF_CREDIT,
      ]) {
        accountsRepository.findOne.mockResolvedValue({
          ...mockAccount,
          accountType,
        });
        await expect(service.findAll(userId, accountId)).resolves.toEqual([]);
      }
    });
  });

  describe("create", () => {
    it("saves a scenario with the lump sums JSONB round-tripped", async () => {
      queryBuilderMock.getOne.mockResolvedValue(null);
      scenariosRepository.create.mockImplementation((data) => data);
      scenariosRepository.save.mockImplementation((data) =>
        Promise.resolve({ ...data, id: "scenario-new" }),
      );

      const result = await service.create(userId, accountId, {
        name: "Aggressive",
        recurringExtraAmount: 300,
        lumpSums: [{ date: "2026-06-01", amount: 5000 }],
      });

      expect(scenariosRepository.create).toHaveBeenCalledWith({
        name: "Aggressive",
        recurringExtraAmount: 300,
        recurringExtraMode: null,
        recurringExtraStartDate: null,
        recurringExtraEndDate: null,
        lumpSums: [{ date: "2026-06-01", amount: 5000 }],
        userId,
        accountId,
      });
      expect(result.lumpSums).toEqual([{ date: "2026-06-01", amount: 5000 }]);
    });

    it("defaults lump sums to an empty array", async () => {
      queryBuilderMock.getOne.mockResolvedValue(null);
      scenariosRepository.create.mockImplementation((data) => data);
      scenariosRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.create(userId, accountId, { name: "Plain" });

      expect(result.lumpSums).toEqual([]);
    });

    it("rejects a duplicate name case-insensitively", async () => {
      queryBuilderMock.getOne.mockResolvedValue(mockScenario);

      await expect(
        service.create(userId, accountId, { name: "extra 200" }),
      ).rejects.toThrow(ConflictException);
    });

    it("verifies account ownership before creating", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.create(userId, accountId, { name: "Nope" }),
      ).rejects.toThrow(NotFoundException);
      expect(scenariosRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    beforeEach(() => {
      scenariosRepository.findOne.mockResolvedValue(mockScenario);
      scenariosRepository.merge.mockImplementation((entity, patch) => ({
        ...entity,
        ...patch,
      }));
      scenariosRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );
    });

    it("updates provided fields only", async () => {
      const result = await service.update(userId, accountId, "scenario-1", {
        recurringExtraAmount: 500,
      });

      expect(result.recurringExtraAmount).toBe(500);
      expect(result.name).toBe("Extra 200");
      expect(result.lumpSums).toEqual(mockScenario.lumpSums);
    });

    it("allows clearing nullable fields explicitly", async () => {
      const result = await service.update(userId, accountId, "scenario-1", {
        recurringExtraAmount: null,
      });

      expect(result.recurringExtraAmount).toBeNull();
    });

    it("checks the new name for conflicts", async () => {
      queryBuilderMock.getOne.mockResolvedValue({ id: "other" });

      await expect(
        service.update(userId, accountId, "scenario-1", { name: "Taken" }),
      ).rejects.toThrow(ConflictException);
    });

    it("skips the conflict check when only the case changes", async () => {
      const result = await service.update(userId, accountId, "scenario-1", {
        name: "EXTRA 200",
      });

      expect(queryBuilderMock.getOne).not.toHaveBeenCalled();
      expect(result.name).toBe("EXTRA 200");
    });

    it("404s for a scenario on another account or user", async () => {
      scenariosRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update(userId, accountId, "scenario-1", { name: "X" }),
      ).rejects.toThrow(NotFoundException);
      expect(scenariosRepository.findOne).toHaveBeenCalledWith({
        where: { id: "scenario-1", userId, accountId },
      });
    });
  });

  describe("remove", () => {
    it("removes an owned scenario", async () => {
      scenariosRepository.findOne.mockResolvedValue(mockScenario);
      scenariosRepository.remove.mockResolvedValue(undefined);

      await service.remove(userId, accountId, "scenario-1");

      expect(scenariosRepository.remove).toHaveBeenCalledWith(mockScenario);
    });

    it("404s when the scenario does not exist", async () => {
      scenariosRepository.findOne.mockResolvedValue(null);

      await expect(
        service.remove(userId, accountId, "missing"),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
