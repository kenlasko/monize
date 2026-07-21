import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { TransactionsController } from "./transactions.controller";
import { TransactionsService } from "./transactions.service";
import { DelegateTransferMaskInterceptor } from "../delegation/interceptors/delegate-transfer-mask.interceptor";
import { DelegationService } from "../delegation/delegation.service";

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
      getGroupedTotals: jest.fn(),
      getTagKeyBreakdown: jest.fn(),
      getRecurringCharges: jest.fn(),
      bulkUpdate: jest.fn(),
      getRecent: jest.fn(),
      getFxFeeSummary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        {
          provide: TransactionsService,
          useValue: mockService,
        },
        DelegateTransferMaskInterceptor,
        {
          provide: DelegationService,
          useValue: { readableAccountIds: jest.fn().mockResolvedValue([]) },
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

  describe("getRecent()", () => {
    it("delegates to service.getRecent with userId and default limit of 5", async () => {
      const expected = [{ id: "tx-1" }];
      mockService.getRecent.mockResolvedValue(expected);

      const result = await controller.getRecent(mockReq, {});

      expect(result).toEqual(expected);
      expect(mockService.getRecent).toHaveBeenCalledWith("user-1", 5, {
        payeeId: undefined,
        payeeName: undefined,
      });
    });

    it("forwards the requested limit when provided", async () => {
      mockService.getRecent.mockResolvedValue([]);

      await controller.getRecent(mockReq, { limit: 10 });

      expect(mockService.getRecent).toHaveBeenCalledWith("user-1", 10, {
        payeeId: undefined,
        payeeName: undefined,
      });
    });

    it("forwards payeeId for payee-scoped quick-fill", async () => {
      mockService.getRecent.mockResolvedValue([]);

      await controller.getRecent(mockReq, { payeeId: uuid1 });

      expect(mockService.getRecent).toHaveBeenCalledWith("user-1", 5, {
        payeeId: uuid1,
        payeeName: undefined,
      });
    });

    it("forwards payeeName when no payeeId is provided", async () => {
      mockService.getRecent.mockResolvedValue([]);

      await controller.getRecent(mockReq, { payeeName: "Free-text Coffee" });

      expect(mockService.getRecent).toHaveBeenCalledWith("user-1", 5, {
        payeeId: undefined,
        payeeName: "Free-text Coffee",
      });
    });

    it("uses authenticated userId, never trusts query params", async () => {
      mockService.getRecent.mockResolvedValue([]);

      await controller.getRecent({ user: { id: "user-1" } } as any, {
        limit: 5,
      });

      expect(mockService.getRecent).toHaveBeenCalledWith("user-1", 5, {
        payeeId: undefined,
        payeeName: undefined,
      });
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    // ── Validation tests ────────────────────────────────────────

    it("rejects negative page number", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects page=0", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-numeric page", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects limit=0", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects negative limit", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects limit exceeding 200", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid startDate format", async () => {
      await expect(
        controller.findAll(mockReq, undefined, undefined, "notadate"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid endDate format", async () => {
      await expect(
        controller.findAll(
          mockReq,
          undefined,
          undefined,
          undefined,
          "2024/01/01",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid UUID in accountIds", async () => {
      await expect(
        controller.findAll(mockReq, undefined, "not-a-uuid"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid UUID in singular accountId", async () => {
      await expect(controller.findAll(mockReq, "not-a-uuid")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("parses statuses from comma-separated string", async () => {
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "UNRECONCILED,CLEARED",
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["UNRECONCILED", "CLEARED"],
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it("rejects an unknown reconciliation status", async () => {
      await expect(
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
          undefined,
          undefined,
          undefined,
          undefined,
          "BOGUS",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid targetTransactionId", async () => {
      await expect(
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
      ).rejects.toThrow(BadRequestException);
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
        undefined,
        undefined,
        undefined,
      );
    });

    it("parses comma-separated tagIds for summary", async () => {
      mockService.getSummary.mockResolvedValue({});

      await controller.getSummary(
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
        `${uuid1},${uuid2}`,
      );

      expect(mockService.getSummary).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [uuid1, uuid2],
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

    it("parses amountFrom and amountTo as floats for summary", async () => {
      mockService.getSummary.mockResolvedValue({});

      await controller.getSummary(
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
        "10.50",
        "99.99",
      );

      expect(mockService.getSummary).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        10.5,
        99.99,
        undefined,
      );
    });

    it("rejects non-numeric amountFrom in summary", () => {
      expect(() =>
        controller.getSummary(
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
          "abc",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects non-numeric amountTo in summary", () => {
      expect(() =>
        controller.getSummary(
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
          "xyz",
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe("getGroupedTotals()", () => {
    it("delegates to service.getGroupedTotals with parsed parameters", async () => {
      const expected = [
        {
          id: uuid1,
          name: "Groceries",
          currencyCode: "CAD",
          total: -10,
          count: 1,
        },
      ];
      mockService.getGroupedTotals.mockResolvedValue(expected);

      const result = await controller.getGroupedTotals(
        mockReq,
        "category",
        `${uuid1},${uuid2}`,
        "2024-01-01",
        "2024-12-31",
        undefined,
        uuid3,
        undefined,
        "coffee",
        "-500",
        "0",
        "25",
      );

      expect(result).toEqual(expected);
      expect(mockService.getGroupedTotals).toHaveBeenCalledWith("user-1", {
        groupBy: "category",
        accountIds: [uuid1, uuid2],
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        categoryIds: undefined,
        payeeIds: [uuid3],
        tagIds: undefined,
        search: "coffee",
        amountFrom: -500,
        amountTo: 0,
        limit: 25,
        includeUnreconciledBeforeStart: false,
      });
    });

    it("passes includeUnreconciledBeforeStart through as a boolean", async () => {
      mockService.getGroupedTotals.mockResolvedValue([]);

      await controller.getGroupedTotals(
        mockReq,
        "category",
        undefined,
        "2024-06-10",
        "2024-07-09",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "true",
      );

      expect(mockService.getGroupedTotals).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ includeUnreconciledBeforeStart: true }),
      );
    });

    it("rejects a missing or invalid groupBy", () => {
      expect(() => controller.getGroupedTotals(mockReq)).toThrow(
        BadRequestException,
      );
      expect(() => controller.getGroupedTotals(mockReq, "month")).toThrow(
        BadRequestException,
      );
    });

    it("rejects an invalid date and a non-positive limit", () => {
      expect(() =>
        controller.getGroupedTotals(mockReq, "payee", undefined, "notadate"),
      ).toThrow(BadRequestException);
      expect(() =>
        controller.getGroupedTotals(
          mockReq,
          "payee",
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
  });

  describe("getTagKeyBreakdown()", () => {
    it("delegates to service.getTagKeyBreakdown with the key and parsed filters", async () => {
      const expected = [
        { id: "usa", name: "usa", currencyCode: "CAD", total: 200, count: 2 },
      ];
      mockService.getTagKeyBreakdown.mockResolvedValue(expected);

      const result = await controller.getTagKeyBreakdown(
        mockReq,
        "country",
        `${uuid1},${uuid2}`,
        "2024-01-01",
        "2024-12-31",
        undefined,
        uuid3,
        undefined,
        "coffee",
        "-500",
        "0",
        "25",
      );

      expect(result).toBe(expected);
      expect(mockService.getTagKeyBreakdown).toHaveBeenCalledWith(
        "user-1",
        "country",
        {
          accountIds: [uuid1, uuid2],
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          categoryIds: undefined,
          payeeIds: [uuid3],
          tagIds: undefined,
          search: "coffee",
          amountFrom: -500,
          amountTo: 0,
          limit: 25,
        },
      );
    });

    it("rejects a missing key", () => {
      expect(() => controller.getTagKeyBreakdown(mockReq, "  ")).toThrow(
        BadRequestException,
      );
      expect(() => controller.getTagKeyBreakdown(mockReq)).toThrow(
        BadRequestException,
      );
    });
  });

  describe("getRecurringCharges()", () => {
    it("delegates to service.getRecurringCharges with parsed payeeIds", async () => {
      const expected = [{ payeeName: "Netflix", frequency: "monthly" }];
      mockService.getRecurringCharges.mockResolvedValue(expected);

      const result = await controller.getRecurringCharges(
        mockReq,
        `${uuid1},${uuid2}`,
        "2024-01-01",
        "2024-12-31",
      );

      expect(result).toEqual(expected);
      expect(mockService.getRecurringCharges).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        [uuid1, uuid2],
      );
    });

    it("rejects missing payeeIds or dates", () => {
      expect(() =>
        controller.getRecurringCharges(
          mockReq,
          undefined,
          "2024-01-01",
          "2024-12-31",
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        controller.getRecurringCharges(mockReq, uuid1, undefined, "2024-12-31"),
      ).toThrow(BadRequestException);
      expect(() =>
        controller.getRecurringCharges(mockReq, uuid1, "2024-01-01"),
      ).toThrow(BadRequestException);
    });

    it("rejects an invalid payee UUID", () => {
      expect(() =>
        controller.getRecurringCharges(
          mockReq,
          "not-a-uuid",
          "2024-01-01",
          "2024-12-31",
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe("findAll() amount filters", () => {
    it("parses amountFrom and amountTo as floats", async () => {
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
        undefined,
        undefined,
        "-100.50",
        "500.25",
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
        undefined,
        undefined,
        -100.5,
        500.25,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it("passes undefined when amountFrom and amountTo are not provided", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(mockReq);

      const call = mockService.findAll.mock.calls[0];
      expect(call[11]).toBeUndefined(); // amountFrom
      expect(call[12]).toBeUndefined(); // amountTo
    });

    it("rejects non-numeric amountFrom", async () => {
      await expect(
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
          undefined,
          "not-a-number",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-numeric amountTo", async () => {
      await expect(
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
          undefined,
          undefined,
          "not-a-number",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows only amountFrom without amountTo", async () => {
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
        undefined,
        undefined,
        "50",
      );

      const call = mockService.findAll.mock.calls[0];
      expect(call[11]).toBe(50); // amountFrom
      expect(call[12]).toBeUndefined(); // amountTo
    });

    it("allows only amountTo without amountFrom", async () => {
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
        undefined,
        undefined,
        undefined,
        "200",
      );

      const call = mockService.findAll.mock.calls[0];
      expect(call[11]).toBeUndefined(); // amountFrom
      expect(call[12]).toBe(200); // amountTo
    });
  });

  describe("findAll() tag key filter", () => {
    const callWithTagKey = (
      tagKey?: string,
      tagKeyOp?: string,
      tagKeyValue?: string,
    ) =>
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tagKey,
        tagKeyOp,
        tagKeyValue,
      );

    it("builds a hasValue filter and passes it to the service (arg 17)", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });
      await callWithTagKey("country", "hasValue");
      expect(mockService.findAll.mock.calls[0][17]).toEqual({
        key: "country",
        op: "hasValue",
        value: undefined,
      });
    });

    it("builds a contains filter with the value", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });
      await callWithTagKey("country", "contains", "usa");
      expect(mockService.findAll.mock.calls[0][17]).toEqual({
        key: "country",
        op: "contains",
        value: "usa",
      });
    });

    it("defaults the op to hasValue when omitted", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });
      await callWithTagKey("country");
      expect(mockService.findAll.mock.calls[0][17]).toEqual({
        key: "country",
        op: "hasValue",
        value: undefined,
      });
    });

    it("passes undefined when no tagKey is given", async () => {
      mockService.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll(mockReq);
      expect(mockService.findAll.mock.calls[0][17]).toBeUndefined();
    });

    it("rejects an invalid op", async () => {
      await expect(callWithTagKey("country", "bogus")).rejects.toThrow();
    });

    it("requires a value for contains / notContains", async () => {
      await expect(callWithTagKey("country", "contains")).rejects.toThrow();
      await expect(callWithTagKey("country", "notContains")).rejects.toThrow();
    });
  });

  describe("getMonthlyTotals() amount filters", () => {
    it("parses amountFrom and amountTo as floats for monthly totals", async () => {
      mockService.getMonthlyTotals = jest.fn().mockResolvedValue([]);

      await controller.getMonthlyTotals(
        mockReq,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "-50",
        "1000",
      );

      expect(mockService.getMonthlyTotals).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        -50,
        1000,
        undefined,
      );
    });

    it("rejects non-numeric amountFrom in monthly totals", async () => {
      await expect(
        controller.getMonthlyTotals(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "abc",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-numeric amountTo in monthly totals", async () => {
      await expect(
        controller.getMonthlyTotals(
          mockReq,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "xyz",
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getFxFeeSummary()", () => {
    it("delegates to service.getFxFeeSummary with userId and accountId", async () => {
      const expected = [
        { month: "2026-01", currencyCode: "EUR", feeTotal: 12.5, count: 3 },
      ];
      mockService.getFxFeeSummary.mockResolvedValue(expected);

      const result = await controller.getFxFeeSummary(mockReq, uuid1);

      expect(result).toEqual(expected);
      expect(mockService.getFxFeeSummary).toHaveBeenCalledWith(
        "user-1",
        uuid1,
      );
    });

    it("returns empty for a delegate without READ access to the account", async () => {
      const delegateReq = {
        user: { id: "user-1", isActing: true, delegationId: "delegation-1" },
      };

      const result = await controller.getFxFeeSummary(delegateReq, uuid1);

      expect(result).toEqual([]);
      expect(mockService.getFxFeeSummary).not.toHaveBeenCalled();
    });
  });
});
