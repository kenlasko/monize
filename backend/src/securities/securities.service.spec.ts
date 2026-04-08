import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { SecuritiesService } from "./securities.service";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { SecurityPriceService } from "./security-price.service";
import { ActionHistoryService } from "../action-history/action-history.service";

describe("SecuritiesService", () => {
  let service: SecuritiesService;
  let securitiesRepository: Record<string, jest.Mock>;
  let holdingsRepository: Record<string, jest.Mock>;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let mockSecurityPriceService: Record<string, jest.Mock>;
  let mockActionHistoryService: Record<string, jest.Mock>;

  const mockSecurity = {
    id: "sec-1",
    userId: "user-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    securitiesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-sec" })),
      save: jest.fn().mockImplementation((data) => data),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    holdingsRepository = {
      createQueryBuilder: jest.fn(() => ({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };

    investmentTransactionsRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    mockSecurityPriceService = {
      backfillSecurity: jest.fn().mockResolvedValue(undefined),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecuritiesService,
        {
          provide: getRepositoryToken(Security),
          useValue: securitiesRepository,
        },
        {
          provide: getRepositoryToken(Holding),
          useValue: holdingsRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTransactionsRepository,
        },
        {
          provide: SecurityPriceService,
          useValue: mockSecurityPriceService,
        },
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
      ],
    }).compile();

    service = module.get<SecuritiesService>(SecuritiesService);
  });

  describe("create", () => {
    it("creates a new security", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await service.create("user-1", {
        symbol: "MSFT",
        name: "Microsoft Corp",
        securityType: "STOCK",
        currencyCode: "USD",
      });

      expect(securitiesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: "MSFT", userId: "user-1" }),
      );
      expect(securitiesRepository.save).toHaveBeenCalled();
    });

    it("throws ConflictException for duplicate symbol", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);

      await expect(
        service.create("user-1", {
          symbol: "AAPL",
          name: "Apple",
          securityType: "STOCK",
          currencyCode: "USD",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("records action history on create", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await service.create("user-1", {
        symbol: "MSFT",
        name: "Microsoft Corp.",
        securityType: "STOCK",
        currencyCode: "USD",
      });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "security",
          action: "create",
          description: expect.stringContaining("MSFT"),
        }),
      );
    });
  });

  describe("findAll", () => {
    it("returns only active securities by default", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const result = await service.findAll("user-1");

      expect(securitiesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isActive: true },
        order: { symbol: "ASC" },
      });
      expect(result).toHaveLength(1);
    });

    it("returns all securities when includeInactive is true", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      await service.findAll("user-1", true);

      expect(securitiesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        order: { symbol: "ASC" },
      });
    });
  });

  describe("findOne", () => {
    it("returns security when found", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);

      const result = await service.findOne("user-1", "sec-1");

      expect(result).toEqual(mockSecurity);
    });

    it("throws NotFoundException when not found", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findBySymbol", () => {
    it("returns security when found", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);

      const result = await service.findBySymbol("user-1", "AAPL");

      expect(result).toEqual(mockSecurity);
      expect(securitiesRepository.findOne).toHaveBeenCalledWith({
        where: { symbol: "AAPL", userId: "user-1" },
      });
    });

    it("throws NotFoundException when not found", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(service.findBySymbol("user-1", "FAKE")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("updates security fields", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      const result = await service.update("user-1", "sec-1", {
        name: "Apple Inc. Updated",
      });

      expect(result.name).toBe("Apple Inc. Updated");
      expect(securitiesRepository.save).toHaveBeenCalled();
    });

    it("throws ConflictException when updating to existing symbol", async () => {
      securitiesRepository.findOne
        .mockResolvedValueOnce({ ...mockSecurity }) // findOne for the security
        .mockResolvedValueOnce({ id: "sec-2", symbol: "MSFT" }); // conflict check

      await expect(
        service.update("user-1", "sec-1", { symbol: "MSFT" }),
      ).rejects.toThrow(ConflictException);
    });

    it("allows updating to same symbol", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      const result = await service.update("user-1", "sec-1", {
        symbol: "AAPL",
        name: "Updated name",
      });

      expect(result.name).toBe("Updated name");
    });

    it("updates all provided fields explicitly", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", {
        name: "New Name",
        securityType: "ETF",
        exchange: "NYSE",
        currencyCode: "CAD",
        isActive: false,
      });

      const savedSecurity = securitiesRepository.save.mock.calls[0][0];
      expect(savedSecurity.name).toBe("New Name");
      expect(savedSecurity.securityType).toBe("ETF");
      expect(savedSecurity.exchange).toBe("NYSE");
      expect(savedSecurity.currencyCode).toBe("CAD");
      expect(savedSecurity.isActive).toBe(false);
    });

    it("records action history on update", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", { name: "Apple Inc. Updated" });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "security",
          entityId: "sec-1",
          action: "update",
          beforeData: expect.objectContaining({ name: "Apple Inc." }),
          description: expect.stringContaining("AAPL"),
        }),
      );
    });
  });

  describe("deactivate", () => {
    it("sets isActive to false when no holdings exist", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      const getCount = jest.fn().mockResolvedValue(0);
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount,
      });

      const result = await service.deactivate("user-1", "sec-1");

      expect(result.isActive).toBe(false);
      expect(securitiesRepository.save).toHaveBeenCalled();
      expect(getCount).toHaveBeenCalled();
    });

    it("throws ForbiddenException when security has holdings", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      const getCount = jest.fn().mockResolvedValue(1); // 1 holding exists
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount,
      });

      await expect(service.deactivate("user-1", "sec-1")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.deactivate("user-1", "sec-1")).rejects.toThrow(
        "Cannot deactivate security with active holdings",
      );
      expect(securitiesRepository.save).not.toHaveBeenCalled();
    });

    it("allows deactivating when holdings have zero quantity", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      const getCount = jest.fn().mockResolvedValue(0); // Zero non-zero holdings
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount,
      });

      const result = await service.deactivate("user-1", "sec-1");

      expect(result.isActive).toBe(false);
      expect(securitiesRepository.save).toHaveBeenCalled();
    });
  });

  describe("activate", () => {
    it("sets isActive to true", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        isActive: false,
      });

      const result = await service.activate("user-1", "sec-1");

      expect(result.isActive).toBe(true);
      expect(securitiesRepository.save).toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes security when no holdings or transactions exist", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(securitiesRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sec-1" }),
      );
    });

    it("throws ForbiddenException when security has holdings", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
      });

      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        "Cannot delete security that has holdings",
      );
    });

    it("throws ForbiddenException when security has investment transactions", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      holdingsRepository.createQueryBuilder.mockReturnValueOnce({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(5),
      });

      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        "Cannot delete security that has investment transactions",
      );
    });

    it("throws NotFoundException when security does not exist", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(service.remove("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("deletes security and cleans up zero-quantity holdings", async () => {
      const zeroHoldings = [
        { id: "h-1", securityId: "sec-1", accountId: "acc-1", quantity: 0 },
        { id: "h-2", securityId: "sec-1", accountId: "acc-2", quantity: 0 },
      ];
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(zeroHoldings),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHoldings);
      expect(securitiesRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sec-1" }),
      );
    });

    it("does not call holdingsRepository.remove when no zero-quantity holdings exist", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(holdingsRepository.remove).not.toHaveBeenCalled();
      expect(securitiesRepository.remove).toHaveBeenCalled();
    });

    it("allows deletion when only zero-quantity holdings exist (ABS threshold check)", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      const andWhereMock = jest.fn().mockReturnThis();
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: andWhereMock,
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest
            .fn()
            .mockResolvedValue([
              { id: "h-1", securityId: "sec-1", quantity: 0.000000001 },
            ]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      // Verify the ABS threshold filter was applied
      expect(andWhereMock).toHaveBeenCalledWith(
        "ABS(holding.quantity) > :threshold",
        { threshold: 0.00000001 },
      );
      expect(securitiesRepository.remove).toHaveBeenCalled();
    });

    it("records action history on remove", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "security",
          entityId: "sec-1",
          action: "delete",
          beforeData: expect.objectContaining({ symbol: "AAPL" }),
          description: expect.stringContaining("AAPL"),
        }),
      );
    });
  });

  describe("getSecurityIdsWithTransactions", () => {
    it("returns security IDs that have transactions", async () => {
      const getRawMany = jest
        .fn()
        .mockResolvedValue([{ securityId: "sec-1" }, { securityId: "sec-2" }]);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany,
      });

      const result = await service.getSecurityIdsWithTransactions("user-1");

      expect(result).toEqual(["sec-1", "sec-2"]);
      expect(getRawMany).toHaveBeenCalled();
    });

    it("returns empty array when no transactions exist", async () => {
      const getRawMany = jest.fn().mockResolvedValue([]);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany,
      });

      const result = await service.getSecurityIdsWithTransactions("user-1");

      expect(result).toEqual([]);
    });
  });

  describe("search", () => {
    it("searches by symbol and name using query builder", async () => {
      const getMany = jest.fn().mockResolvedValue([mockSecurity]);
      securitiesRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.search("user-1", "AAPL");

      expect(result).toHaveLength(1);
      expect(securitiesRepository.createQueryBuilder).toHaveBeenCalledWith(
        "security",
      );
      expect(getMany).toHaveBeenCalled();
    });

    it("returns empty array when no matches", async () => {
      const result = await service.search("user-1", "ZZZZZ");

      expect(result).toHaveLength(0);
    });
  });
});
