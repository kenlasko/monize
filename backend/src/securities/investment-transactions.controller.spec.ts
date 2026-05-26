import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { InvestmentTransactionsController } from "./investment-transactions.controller";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import { DelegationService } from "../delegation/delegation.service";

describe("InvestmentTransactionsController", () => {
  let controller: InvestmentTransactionsController;
  let service: Record<string, jest.Mock>;
  let delegationMock: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };
  const UUID1 = "00000000-0000-0000-0000-000000000001";
  const UUID2 = "00000000-0000-0000-0000-000000000002";

  const mockTransaction = {
    id: "txn-1",
    userId: "user-1",
    accountId: UUID1,
    securityId: "sec-1",
    action: "BUY",
    quantity: 10,
    price: 150.0,
    totalAmount: 1500.0,
    date: "2025-01-15",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      transferSecurity: jest.fn(),
      findAll: jest.fn(),
      getSummary: jest.fn(),
      getRealizedGains: jest.fn(),
      getCapitalGainsByMonth: jest.fn(),
      getCapitalGainsByDay: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      removeAll: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvestmentTransactionsController],
      providers: [
        { provide: InvestmentTransactionsService, useValue: service },
        {
          provide: DelegationService,
          useValue: (delegationMock = {
            readableAccountIds: jest.fn().mockResolvedValue([]),
          }),
        },
      ],
    }).compile();

    controller = module.get<InvestmentTransactionsController>(
      InvestmentTransactionsController,
    );
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("create", () => {
    it("delegates to service.create with userId and dto", async () => {
      const dto = {
        accountId: UUID1,
        securityId: "sec-1",
        action: "BUY",
        quantity: 10,
        price: 150,
      };
      service.create.mockResolvedValue(mockTransaction);

      const result = await controller.create(req, dto as any);

      expect(service.create).toHaveBeenCalledWith("user-1", dto);
      expect(result).toEqual(mockTransaction);
    });
  });

  describe("transferSecurity", () => {
    it("delegates to service.transferSecurity with userId and dto", async () => {
      const dto = {
        fromAccountId: UUID1,
        toAccountId: UUID2,
        securityId: "sec-1",
        transactionDate: "2025-04-01",
        quantity: 100,
        costPerShare: 1.67,
      };
      const expected = { transferOut: { id: "out" }, transferIn: { id: "in" } };
      service.transferSecurity.mockResolvedValue(expected);

      const result = await controller.transferSecurity(req, dto as any);

      expect(service.transferSecurity).toHaveBeenCalledWith("user-1", dto);
      expect(result).toEqual(expected);
    });
  });

  describe("findAll", () => {
    it("returns paginated transactions with default params", async () => {
      const response = {
        data: [mockTransaction],
        total: 1,
        page: 1,
        limit: 50,
      };
      service.findAll.mockResolvedValue(response);

      const result = await controller.findAll(req);

      expect(service.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(response);
    });

    it("parses accountIds CSV into array", async () => {
      service.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(req, `${UUID1},${UUID2}`);

      expect(service.findAll).toHaveBeenCalledWith(
        "user-1",
        [UUID1, UUID2],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(controller.findAll(req, "not-a-uuid")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects invalid date format for startDate", async () => {
      await expect(
        controller.findAll(req, undefined, "01-01-2025"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid page parameter", async () => {
      await expect(
        controller.findAll(req, undefined, undefined, undefined, "abc"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects limit exceeding 200", async () => {
      await expect(
        controller.findAll(
          req,
          undefined,
          undefined,
          undefined,
          undefined,
          "500",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("parses page and limit as integers", async () => {
      service.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(
        req,
        undefined,
        "2025-01-01",
        "2025-12-31",
        "2",
        "25",
        "AAPL",
        "BUY",
      );

      expect(service.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
        "2025-01-01",
        "2025-12-31",
        2,
        25,
        "AAPL",
        "BUY",
      );
    });

    it("scopes an acting delegate to readable accounts", async () => {
      const actingReq = {
        user: { id: "owner-1", isActing: true, delegationId: "g1" },
      };
      service.findAll.mockResolvedValue({ data: [], total: 0 });
      delegationMock.readableAccountIds.mockResolvedValue([UUID2]);

      await controller.findAll(actingReq, `${UUID1},${UUID2}`);

      expect(service.findAll).toHaveBeenCalledWith(
        "owner-1",
        [UUID2],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it("returns a naturally-empty result when the delegate has no readable accounts", async () => {
      const actingReq = {
        user: { id: "owner-1", isActing: true, delegationId: "g1" },
      };
      service.findAll.mockResolvedValue({ data: [], total: 0 });
      delegationMock.readableAccountIds.mockResolvedValue([]);

      await controller.findAll(actingReq);

      expect(service.findAll).toHaveBeenCalledWith(
        "owner-1",
        ["00000000-0000-0000-0000-000000000000"],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe("getSummary", () => {
    it("returns summary without accountIds filter", async () => {
      const summary = { totalBuys: 5, totalSells: 2 };
      service.getSummary.mockResolvedValue(summary);

      const result = await controller.getSummary(req);

      expect(service.getSummary).toHaveBeenCalledWith("user-1", undefined);
      expect(result).toEqual(summary);
    });

    it("parses accountIds CSV and passes to service", async () => {
      service.getSummary.mockResolvedValue({});

      await controller.getSummary(req, `${UUID1},${UUID2}`);

      expect(service.getSummary).toHaveBeenCalledWith("user-1", [UUID1, UUID2]);
    });
  });

  describe("getRealizedGains", () => {
    it("passes filters through to the service", async () => {
      const rows = [{ transactionId: "s1", realizedGain: 100 }];
      service.getRealizedGains.mockResolvedValue(rows);

      const result = await controller.getRealizedGains(
        req,
        `${UUID1},${UUID2}`,
        "2024-01-01",
        "2024-12-31",
      );

      expect(service.getRealizedGains).toHaveBeenCalledWith("user-1", {
        accountIds: [UUID1, UUID2],
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      });
      expect(result).toEqual(rows);
    });

    it("rejects invalid UUIDs", async () => {
      await expect(
        controller.getRealizedGains(req, "not-a-uuid"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects malformed dates", async () => {
      await expect(
        controller.getRealizedGains(req, undefined, "2024/01/01"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getCapitalGains", () => {
    it("passes startDate, endDate, and account filters through to the service", async () => {
      const rows = [
        {
          month: "2024-06",
          totalCapitalGain: 250,
          realizedGain: 0,
          unrealizedGain: 250,
        },
      ];
      service.getCapitalGainsByMonth.mockResolvedValue(rows);

      const result = await controller.getCapitalGains(
        req,
        "2024-01-01",
        "2024-12-31",
        `${UUID1},${UUID2}`,
      );

      expect(service.getCapitalGainsByMonth).toHaveBeenCalledWith("user-1", {
        accountIds: [UUID1, UUID2],
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      });
      expect(result).toEqual(rows);
    });

    it("dispatches to getCapitalGainsByDay when granularity=day", async () => {
      const rows = [
        {
          month: "2024-06-15",
          totalCapitalGain: 50,
          realizedGain: 0,
          unrealizedGain: 50,
        },
      ];
      service.getCapitalGainsByDay.mockResolvedValue(rows);

      const result = await controller.getCapitalGains(
        req,
        "2024-06-01",
        "2024-06-30",
        undefined,
        "day",
      );

      expect(service.getCapitalGainsByDay).toHaveBeenCalledWith("user-1", {
        accountIds: undefined,
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      });
      expect(service.getCapitalGainsByMonth).not.toHaveBeenCalled();
      expect(result).toEqual(rows);
    });

    it("rejects an unknown granularity value", async () => {
      await expect(
        controller.getCapitalGains(
          req,
          "2024-01-01",
          "2024-12-31",
          undefined,
          "week",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("requires startDate", async () => {
      await expect(
        controller.getCapitalGains(req, "", "2024-12-31"),
      ).rejects.toThrow(BadRequestException);
    });

    it("requires endDate", async () => {
      await expect(
        controller.getCapitalGains(req, "2024-01-01", ""),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects malformed dates", async () => {
      await expect(
        controller.getCapitalGains(req, "2024/01/01", "2024-12-31"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when startDate is after endDate", async () => {
      await expect(
        controller.getCapitalGains(req, "2024-12-31", "2024-01-01"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid account UUIDs", async () => {
      await expect(
        controller.getCapitalGains(
          req,
          "2024-01-01",
          "2024-12-31",
          "not-a-uuid",
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("findOne", () => {
    it("returns a single transaction by id", async () => {
      service.findOne.mockResolvedValue(mockTransaction);

      const result = await controller.findOne(req, "txn-1");

      expect(service.findOne).toHaveBeenCalledWith("user-1", "txn-1");
      expect(result).toEqual(mockTransaction);
    });
  });

  describe("update", () => {
    it("delegates to service.update with userId, id, and dto", async () => {
      const dto = { quantity: 20 };
      service.update.mockResolvedValue({ ...mockTransaction, quantity: 20 });

      const result = await controller.update(req, "txn-1", dto as any);

      expect(service.update).toHaveBeenCalledWith("user-1", "txn-1", dto);
      expect(result.quantity).toBe(20);
    });
  });

  describe("remove", () => {
    it("delegates to service.remove", async () => {
      service.remove.mockResolvedValue(undefined);

      await controller.remove(req, "txn-1");

      expect(service.remove).toHaveBeenCalledWith("user-1", "txn-1");
    });
  });

  describe("removeAll", () => {
    it("delegates to service.removeAll", async () => {
      const result = {
        transactionsDeleted: 10,
        holdingsDeleted: 5,
        accountsReset: 2,
      };
      service.removeAll.mockResolvedValue(result);

      const actual = await controller.removeAll(req);

      expect(service.removeAll).toHaveBeenCalledWith("user-1");
      expect(actual).toEqual(result);
    });
  });
});
