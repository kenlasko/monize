import { Test, TestingModule } from "@nestjs/testing";
import { InvestmentTransactionsController } from "./investment-transactions.controller";
import { InvestmentTransactionsService } from "./investment-transactions.service";

describe("InvestmentTransactionsController", () => {
  let controller: InvestmentTransactionsController;
  let service: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };

  const mockTransaction = {
    id: "txn-1",
    userId: "user-1",
    accountId: "acc-1",
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
      findAll: jest.fn(),
      getSummary: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      removeAll: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvestmentTransactionsController],
      providers: [
        { provide: InvestmentTransactionsService, useValue: service },
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
        accountId: "acc-1",
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

      await controller.findAll(req, "acc-1,acc-2");

      expect(service.findAll).toHaveBeenCalledWith(
        "user-1",
        ["acc-1", "acc-2"],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
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

      await controller.getSummary(req, "acc-1,acc-2");

      expect(service.getSummary).toHaveBeenCalledWith("user-1", [
        "acc-1",
        "acc-2",
      ]);
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
