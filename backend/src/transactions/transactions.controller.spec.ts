import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { TransactionsController } from "./transactions.controller";
import { TransactionsService } from "./transactions.service";

describe("TransactionsController", () => {
  let controller: TransactionsController;
  let mockService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  // Valid UUIDs for testing
  const uuid1 = "00000000-0000-0000-0000-000000000001";
  const uuid2 = "00000000-0000-0000-0000-000000000002";
  const uuid3 = "00000000-0000-0000-0000-000000000003";

  beforeEach(async () => {
    mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      markCleared: jest.fn(),
      reconcile: jest.fn(),
      unreconcile: jest.fn(),
      updateStatus: jest.fn(),
      getReconciliationData: jest.fn(),
      bulkReconcile: jest.fn(),
      getSplits: jest.fn(),
      updateSplits: jest.fn(),
      addSplit: jest.fn(),
      removeSplit: jest.fn(),
      createTransfer: jest.fn(),
      getLinkedTransaction: jest.fn(),
      removeTransfer: jest.fn(),
      updateTransfer: jest.fn(),
      getSummary: jest.fn(),
      bulkUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        {
          provide: TransactionsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<TransactionsController>(TransactionsController);
  });

  describe("create()", () => {
    it("delegates to service.create with userId and dto", async () => {
      const dto = { accountId: uuid1, amount: -50 };
      const expected = { id: "tx-1", accountId: uuid1, amount: -50 };
      mockService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to service.findAll with userId and parsed parameters", async () => {
      const expected = { data: [{ id: "tx-1" }], total: 1 };
      mockService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
      );
    });

    it("parses accountIds from comma-separated string", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(
        mockReq,
        undefined,
        `${uuid1},${uuid2}`,
        "2024-01-01",
        "2024-12-31",
      );

      expect(mockService.findAll).toHaveBeenCalledWith(
        "user-1",
        [uuid1, uuid2],
        "2024-01-01",
        "2024-12-31",
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
      );
    });

    it("falls back to singular accountId when accountIds not provided", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(mockReq, uuid1);

      expect(mockService.findAll).toHaveBeenCalledWith(
        "user-1",
        [uuid1],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
      );
    });

    it("parses page and limit as integers", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(
        mockReq,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "2",
        "25",
      );

      expect(mockService.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        2,
        25,
        false,
        undefined,
        undefined,
      );
    });

    it("parses includeInvestmentBrokerage as boolean", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(
        mockReq,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );

      expect(mockService.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
      );
    });

    it("passes search and targetTransactionId", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(
        mockReq,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "grocery",
        uuid3,
      );

      expect(mockService.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        "grocery",
        uuid3,
      );
    });

    // ── Validation tests ────────────────────────────────────────

    it("rejects negative page number", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "-1",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects page=0", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "0",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects non-numeric page", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "abc",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects limit=0", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "0",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects negative limit", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "-5",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects limit exceeding 200", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "201",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects invalid startDate format", () => {
      expect(() =>
        controller.findAll(mockReq, undefined, undefined, "notadate"),
      ).toThrow(BadRequestException);
    });

    it("rejects invalid endDate format", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          "2024/01/01",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects invalid UUID in accountIds", () => {
      expect(() =>
        controller.findAll(mockReq, undefined, "not-a-uuid"),
      ).toThrow(BadRequestException);
    });

    it("rejects invalid UUID in singular accountId", () => {
      expect(() => controller.findAll(mockReq, "not-a-uuid")).toThrow(
        BadRequestException,
      );
    });

    it("rejects invalid targetTransactionId", () => {
      expect(() =>
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "not-a-uuid",
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe("findOne()", () => {
    it("delegates to service.findOne with userId and id", async () => {
      const expected = { id: "tx-1", amount: -50 };
      mockService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne(mockReq, "tx-1");

      expect(result).toEqual(expected);
      expect(mockService.findOne).toHaveBeenCalledWith("user-1", "tx-1");
    });
  });

  describe("update()", () => {
    it("delegates to service.update with userId, id, and dto", async () => {
      const dto = { amount: -75 };
      const expected = { id: "tx-1", amount: -75 };
      mockService.update.mockResolvedValue(expected);

      const result = await controller.update(mockReq, "tx-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockService.update).toHaveBeenCalledWith("user-1", "tx-1", dto);
    });
  });

  describe("remove()", () => {
    it("delegates to service.remove with userId and id", async () => {
      mockService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(mockReq, "tx-1");

      expect(result).toBeUndefined();
      expect(mockService.remove).toHaveBeenCalledWith("user-1", "tx-1");
    });
  });

  describe("markCleared()", () => {
    it("delegates to service.markCleared with userId, id, and isCleared", async () => {
      const expected = { id: "tx-1", isCleared: true };
      mockService.markCleared.mockResolvedValue(expected);

      const result = await controller.markCleared(mockReq, "tx-1", {
        isCleared: true,
      });

      expect(result).toEqual(expected);
      expect(mockService.markCleared).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
        true,
      );
    });
  });

  describe("reconcile()", () => {
    it("delegates to service.reconcile with userId and id", async () => {
      const expected = { id: "tx-1", status: "reconciled" };
      mockService.reconcile.mockResolvedValue(expected);

      const result = await controller.reconcile(mockReq, "tx-1");

      expect(result).toEqual(expected);
      expect(mockService.reconcile).toHaveBeenCalledWith("user-1", "tx-1");
    });
  });

  describe("unreconcile()", () => {
    it("delegates to service.unreconcile with userId and id", async () => {
      const expected = { id: "tx-1", status: "cleared" };
      mockService.unreconcile.mockResolvedValue(expected);

      const result = await controller.unreconcile(mockReq, "tx-1");

      expect(result).toEqual(expected);
      expect(mockService.unreconcile).toHaveBeenCalledWith("user-1", "tx-1");
    });
  });

  describe("updateStatus()", () => {
    it("delegates to service.updateStatus with userId, id, and status", async () => {
      const expected = { id: "tx-1", status: "cleared" };
      mockService.updateStatus.mockResolvedValue(expected);

      const result = await controller.updateStatus(mockReq, "tx-1", {
        status: "cleared" as any,
      });

      expect(result).toEqual(expected);
      expect(mockService.updateStatus).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
        "cleared",
      );
    });
  });

  describe("getReconciliationData()", () => {
    it("delegates to service.getReconciliationData with parsed statementBalance", async () => {
      const expected = {
        transactions: [],
        clearedBalance: 1000,
        difference: 0,
      };
      mockService.getReconciliationData.mockResolvedValue(expected);

      const result = await controller.getReconciliationData(
        mockReq,
        uuid1,
        "2024-01-31",
        "1000.50",
      );

      expect(result).toEqual(expected);
      expect(mockService.getReconciliationData).toHaveBeenCalledWith(
        "user-1",
        uuid1,
        "2024-01-31",
        1000.5,
      );
    });
  });

  describe("bulkReconcile()", () => {
    it("delegates to service.bulkReconcile with userId, accountId, transactionIds, and reconciledDate", async () => {
      const body = {
        transactionIds: ["tx-1", "tx-2"],
        reconciledDate: "2024-01-31",
      };
      const expected = { reconciled: 2 };
      mockService.bulkReconcile.mockResolvedValue(expected);

      const result = await controller.bulkReconcile(mockReq, uuid1, body);

      expect(result).toEqual(expected);
      expect(mockService.bulkReconcile).toHaveBeenCalledWith(
        "user-1",
        uuid1,
        ["tx-1", "tx-2"],
        "2024-01-31",
      );
    });
  });

  describe("getSplits()", () => {
    it("delegates to service.getSplits with userId and id", async () => {
      const expected = [{ id: "split-1", amount: -25 }];
      mockService.getSplits.mockResolvedValue(expected);

      const result = await controller.getSplits(mockReq, "tx-1");

      expect(result).toEqual(expected);
      expect(mockService.getSplits).toHaveBeenCalledWith("user-1", "tx-1");
    });
  });

  describe("updateSplits()", () => {
    it("delegates to service.updateSplits with userId, id, and splits array", async () => {
      const splits = [
        { categoryId: "cat-1", amount: -25 },
        { categoryId: "cat-2", amount: -25 },
      ];
      const expected = [{ id: "split-1" }, { id: "split-2" }];
      mockService.updateSplits.mockResolvedValue(expected);

      const result = await controller.updateSplits(mockReq, "tx-1", {
        splits,
      } as any);

      expect(result).toEqual(expected);
      expect(mockService.updateSplits).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
        splits,
      );
    });
  });

  describe("addSplit()", () => {
    it("delegates to service.addSplit with userId, id, and splitDto", async () => {
      const splitDto = { categoryId: "cat-1", amount: -25 };
      const expected = { id: "split-1", categoryId: "cat-1", amount: -25 };
      mockService.addSplit.mockResolvedValue(expected);

      const result = await controller.addSplit(
        mockReq,
        "tx-1",
        splitDto as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.addSplit).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
        splitDto,
      );
    });
  });

  describe("removeSplit()", () => {
    it("delegates to service.removeSplit with userId, id, and splitId", async () => {
      mockService.removeSplit.mockResolvedValue(undefined);

      const result = await controller.removeSplit(mockReq, "tx-1", "split-1");

      expect(result).toBeUndefined();
      expect(mockService.removeSplit).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
        "split-1",
      );
    });
  });

  describe("createTransfer()", () => {
    it("delegates to service.createTransfer with userId and dto", async () => {
      const dto = {
        fromAccountId: uuid1,
        toAccountId: uuid2,
        amount: 500,
      };
      const expected = { id: "tx-1", linkedTransactionId: "tx-2" };
      mockService.createTransfer.mockResolvedValue(expected);

      const result = await controller.createTransfer(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockService.createTransfer).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("getLinkedTransaction()", () => {
    it("delegates to service.getLinkedTransaction with userId and id", async () => {
      const expected = { id: "tx-2", linkedTransactionId: "tx-1" };
      mockService.getLinkedTransaction.mockResolvedValue(expected);

      const result = await controller.getLinkedTransaction(mockReq, "tx-1");

      expect(result).toEqual(expected);
      expect(mockService.getLinkedTransaction).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
      );
    });
  });

  describe("removeTransfer()", () => {
    it("delegates to service.removeTransfer with userId and id", async () => {
      mockService.removeTransfer.mockResolvedValue(undefined);

      const result = await controller.removeTransfer(mockReq, "tx-1");

      expect(result).toBeUndefined();
      expect(mockService.removeTransfer).toHaveBeenCalledWith("user-1", "tx-1");
    });
  });

  describe("updateTransfer()", () => {
    it("delegates to service.updateTransfer with userId, id, and dto", async () => {
      const dto = { amount: 600 };
      const expected = { id: "tx-1", amount: 600 };
      mockService.updateTransfer.mockResolvedValue(expected);

      const result = await controller.updateTransfer(
        mockReq,
        "tx-1",
        dto as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.updateTransfer).toHaveBeenCalledWith(
        "user-1",
        "tx-1",
        dto,
      );
    });
  });

  describe("getSummary()", () => {
    it("delegates to service.getSummary with userId and parsed parameters", async () => {
      const expected = { totalIncome: 5000, totalExpenses: 3000 };
      mockService.getSummary.mockResolvedValue(expected);

      const result = await controller.getSummary(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.getSummary).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it("parses comma-separated accountIds for summary", async () => {
      mockService.getSummary.mockResolvedValue({});

      await controller.getSummary(
        mockReq,
        undefined,
        `${uuid1},${uuid2}`,
        "2024-01-01",
        "2024-12-31",
      );

      expect(mockService.getSummary).toHaveBeenCalledWith(
        "user-1",
        [uuid1, uuid2],
        "2024-01-01",
        "2024-12-31",
        undefined,
        undefined,
        undefined,
      );
    });

    it("rejects invalid date in summary startDate", () => {
      expect(() =>
        controller.getSummary(mockReq, undefined, undefined, "notadate"),
      ).toThrow(BadRequestException);
    });

    it("rejects invalid UUID in summary accountIds", () => {
      expect(() =>
        controller.getSummary(mockReq, undefined, "bad-uuid"),
      ).toThrow(BadRequestException);
    });
  });
});
