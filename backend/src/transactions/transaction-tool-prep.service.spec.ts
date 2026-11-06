import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { TransactionToolPrepService } from "./transaction-tool-prep.service";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "./transactions.service";
import { TransactionTransferService } from "./transaction-transfer.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { TransactionSplitService } from "./transaction-split.service";

describe("TransactionToolPrepService", () => {
  let service: TransactionToolPrepService;
  let accounts: Record<string, jest.Mock>;
  let transactions: Record<string, jest.Mock>;
  let transfer: Record<string, jest.Mock>;
  let analytics: Record<string, jest.Mock>;
  let splitService: Record<string, jest.Mock>;

  const userId = "user-1";

  const createPreview = {
    accountId: "a1",
    accountName: "Checking",
    amount: -10,
    transactionDate: "2026-01-15",
    payeeId: null,
    payeeName: "Store",
    payeeMatched: false,
    payeeWillBeCreated: true,
    categoryId: "c1",
    categoryName: "Dining",
    description: null,
    currencyCode: "USD",
  };

  beforeEach(async () => {
    accounts = {
      resolveByName: jest.fn(async (_u: string, name: string) =>
        name.toLowerCase() === "checking"
          ? { id: "a1", name: "Checking", currencyCode: "USD" }
          : name.toLowerCase() === "savings"
            ? { id: "a2", name: "Savings", currencyCode: "USD" }
            : undefined,
      ),
    };
    transactions = {
      previewCreate: jest.fn().mockResolvedValue(createPreview),
      previewUpdate: jest.fn().mockResolvedValue({
        transactionId: "t1",
        accountId: "a1",
        accountName: "Checking",
        amount: -30,
        transactionDate: "2026-02-01",
        payeeId: "p1",
        payeeName: "Store",
        payeeMatched: true,
        payeeWillBeCreated: false,
        categoryId: "c1",
        categoryName: "Dining",
        description: null,
        currencyCode: "USD",
      }),
      previewDelete: jest.fn().mockResolvedValue({
        transactionId: "t1",
        accountName: "Checking",
        amount: -30,
        transactionDate: "2026-02-01",
        payeeName: "Store",
        categoryName: "Dining",
        description: null,
        currencyCode: "USD",
      }),
      findOne: jest.fn().mockResolvedValue({
        id: "t1",
        isTransfer: false,
        linkedTransactionId: null,
      }),
    };
    transfer = {
      isTransfer: jest.fn(
        (t: { isTransfer?: boolean }) => t.isTransfer === true,
      ),
      previewCreateTransfer: jest.fn().mockResolvedValue({
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        description: null,
      }),
      previewUpdateTransfer: jest.fn().mockResolvedValue({
        transactionId: "t1",
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        description: null,
      }),
    };
    analytics = {
      resolveLlmCategoryIds: jest
        .fn()
        .mockResolvedValue({ categoryIds: ["c1"], unresolved: [] }),
    };
    splitService = {
      validateSplitsInCurrency: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionToolPrepService,
        { provide: AccountsService, useValue: accounts },
        { provide: TransactionsService, useValue: transactions },
        { provide: TransactionTransferService, useValue: transfer },
        { provide: TransactionAnalyticsService, useValue: analytics },
        { provide: TransactionSplitService, useValue: splitService },
      ],
    }).compile();

    service = module.get(TransactionToolPrepService);
  });

  describe("prepareCreate", () => {
    it("resolves names and builds previews, skipping unknown accounts", async () => {
      const result = await service.prepareCreate(userId, [
        { accountName: "Checking", amount: -10, date: "2026-01-15" },
        { accountName: "Ghost", amount: -5, date: "2026-01-15" },
      ]);
      expect(result.okPreviews).toHaveLength(1);
      expect(result.okIndex).toEqual([0]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("Unknown account");
      expect(result.previewRows).toHaveLength(2);
    });

    it("skips a row with an unknown category", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Nope"],
      });
      const result = await service.prepareCreate(userId, [
        {
          accountName: "Checking",
          amount: -10,
          date: "2026-01-15",
          categoryName: "Nope",
        },
      ]);
      expect(result.okPreviews).toHaveLength(0);
      expect(result.skipped[0].reason).toContain("Unknown category");
    });

    it("skips a row when previewCreate throws (best-effort catch)", async () => {
      transactions.previewCreate.mockRejectedValueOnce(
        new BadRequestException("Amount out of range"),
      );
      const result = await service.prepareCreate(userId, [
        { accountName: "Checking", amount: -10, date: "2026-01-15" },
      ]);
      expect(result.okPreviews).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("Amount out of range");
      expect(result.previewRows[0].status).toBe("error");
    });
  });

  describe("prepareCreateSingle", () => {
    it("throws on unknown account", async () => {
      await expect(
        service.prepareCreateSingle(userId, {
          accountName: "Ghost",
          amount: -1,
          date: "2026-01-15",
        }),
      ).rejects.toThrow(/Unknown account/);
    });

    it("throws on an unknown category", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Nope"],
      });
      await expect(
        service.prepareCreateSingle(userId, {
          accountName: "Checking",
          amount: -1,
          date: "2026-01-15",
          categoryName: "Nope",
        }),
      ).rejects.toThrow(/Unknown category/);
    });

    it("resolves a category and threads createPayeeIfMissing=false", async () => {
      const result = await service.prepareCreateSingle(userId, {
        accountName: "Checking",
        amount: -1,
        date: "2026-01-15",
        categoryName: "Dining",
        createPayeeIfMissing: false,
      });
      expect(result.createPayee).toBe(false);
      expect(transactions.previewCreate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          categoryId: "c1",
          createPayeeIfMissing: false,
        }),
      );
    });

    it("resolves split categories, validates the sum, and omits a single category", async () => {
      const result = await service.prepareCreateSingle(userId, {
        accountName: "Checking",
        amount: -100,
        date: "2026-01-15",
        splits: [
          { categoryName: "Dining", amount: -60 },
          { categoryName: "Dining", amount: -40, memo: "tip" },
        ],
      });
      expect(result.splits).toEqual([
        { categoryId: "c1", categoryName: "Dining", amount: -60, memo: null },
        { categoryId: "c1", categoryName: "Dining", amount: -40, memo: "tip" },
      ]);
      // Sum validated against the transaction amount via the domain rule.
      expect(splitService.validateSplitsInCurrency).toHaveBeenCalledWith(
        expect.any(Array),
        -100,
        "USD",
      );
      // A split parent carries no single category.
      expect(transactions.previewCreate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryId: undefined, hasSplits: true }),
      );
    });

    it("propagates a validateSplits failure", async () => {
      splitService.validateSplitsInCurrency.mockRejectedValueOnce(
        new Error("bad sum"),
      );
      await expect(
        service.prepareCreateSingle(userId, {
          accountName: "Checking",
          amount: -100,
          date: "2026-01-15",
          splits: [
            { categoryName: "Dining", amount: -60 },
            { categoryName: "Dining", amount: -10 },
          ],
        }),
      ).rejects.toThrow(/bad sum/);
    });
  });

  describe("prepareCreateTransfer", () => {
    it("resolves both accounts and builds a preview", async () => {
      const result = await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
        },
      ]);
      expect(result.okPreviews).toHaveLength(1);
      expect(transfer.previewCreateTransfer).toHaveBeenCalled();
    });

    it("skips when the destination account is unknown", async () => {
      const result = await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Ghost",
          amount: 100,
          date: "2026-01-15",
        },
      ]);
      expect(result.okPreviews).toHaveLength(0);
      expect(result.skipped[0].reason).toContain("Unknown account: Ghost");
    });

    it("passes a custom payeeName and default createPayeeIfMissing through to previewCreateTransfer", async () => {
      await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
          payeeName: "Shared rent",
        },
      ]);
      expect(transfer.previewCreateTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          payeeName: "Shared rent",
          createPayeeIfMissing: true,
        }),
      );
    });

    it("threads createPayeeIfMissing=false to previewCreateTransfer", async () => {
      await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
          payeeName: "Shared rent",
          createPayeeIfMissing: false,
        },
      ]);
      expect(transfer.previewCreateTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ createPayeeIfMissing: false }),
      );
    });

    it("resolves a categoryName and threads the categoryId to previewCreateTransfer", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: ["cat-1"],
        unresolved: [],
      });
      await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
          categoryName: "Savings Goal",
        },
      ]);
      expect(analytics.resolveLlmCategoryIds).toHaveBeenCalledWith(userId, [
        "Savings Goal",
      ]);
      expect(transfer.previewCreateTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryId: "cat-1" }),
      );
    });

    it("skips a row with an unknown categoryName", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Nope"],
      });
      const result = await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
          categoryName: "Nope",
        },
      ]);
      expect(result.okPreviews).toHaveLength(0);
      expect(result.skipped[0].reason).toContain("Unknown category: Nope");
      expect(transfer.previewCreateTransfer).not.toHaveBeenCalled();
    });

    it("skips when the source account is unknown", async () => {
      const result = await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Ghost",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
        },
      ]);
      expect(result.okPreviews).toHaveLength(0);
      expect(result.skipped[0].reason).toContain("Unknown account: Ghost");
      expect(transfer.previewCreateTransfer).not.toHaveBeenCalled();
    });

    it("skips a row when previewCreateTransfer throws (best-effort catch)", async () => {
      transfer.previewCreateTransfer.mockRejectedValueOnce(
        new BadRequestException("Transfer amount must be positive"),
      );
      const result = await service.prepareCreateTransfer(userId, [
        {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
        },
      ]);
      expect(result.okPreviews).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("must be positive");
      expect(result.previewRows[0].status).toBe("error");
    });
  });

  describe("prepareCreateTransferSingle", () => {
    it("resolves both accounts and returns a preview", async () => {
      const preview = await service.prepareCreateTransferSingle(userId, {
        fromAccountName: "Checking",
        toAccountName: "Savings",
        amount: 100,
        date: "2026-01-15",
      });
      expect(preview.fromAccountId).toBe("a1");
      expect(transfer.previewCreateTransfer).toHaveBeenCalled();
    });

    it("resolves a categoryName and threads the categoryId to previewCreateTransfer", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: ["cat-1"],
        unresolved: [],
      });
      await service.prepareCreateTransferSingle(userId, {
        fromAccountName: "Checking",
        toAccountName: "Savings",
        amount: 100,
        date: "2026-01-15",
        categoryName: "Savings Goal",
      });
      expect(transfer.previewCreateTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryId: "cat-1" }),
      );
    });

    it("throws on an unknown categoryName", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Nope"],
      });
      await expect(
        service.prepareCreateTransferSingle(userId, {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
          categoryName: "Nope",
        }),
      ).rejects.toThrow(/Unknown category: Nope/);
    });

    it("throws on an unknown source account", async () => {
      await expect(
        service.prepareCreateTransferSingle(userId, {
          fromAccountName: "Ghost",
          toAccountName: "Savings",
          amount: 100,
          date: "2026-01-15",
        }),
      ).rejects.toThrow(/Unknown account: Ghost/);
    });

    it("throws on an unknown destination account", async () => {
      await expect(
        service.prepareCreateTransferSingle(userId, {
          fromAccountName: "Checking",
          toAccountName: "Ghost",
          amount: 100,
          date: "2026-01-15",
        }),
      ).rejects.toThrow(/Unknown account: Ghost/);
    });
  });

  describe("prepareUpdate", () => {
    it("returns a standard preview and resolves the category", async () => {
      const result = await service.prepareUpdate(userId, {
        transactionId: "t1",
        categoryName: "Dining",
      });
      expect(result.kind).toBe("standard");
      expect(analytics.resolveLlmCategoryIds).toHaveBeenCalledWith(userId, [
        "Dining",
      ]);
      // No splits on the item: previewUpdate must know none accompany the
      // edit, so it can refuse category/amount changes on an existing split.
      expect(transactions.previewUpdate).toHaveBeenCalledWith(
        userId,
        "t1",
        expect.objectContaining({ splitsAccompany: false }),
      );
    });

    it("marks a single category the AI chose on the preview, and never otherwise", async () => {
      const marked = await service.prepareUpdate(userId, {
        transactionId: "t1",
        categoryName: "Dining",
        categorySource: "ai",
      });
      expect(marked.kind === "standard" && marked.preview.categorySource).toBe(
        "ai",
      );
      const plain = await service.prepareUpdate(userId, {
        transactionId: "t1",
        categoryName: "Dining",
      });
      expect(plain.kind === "standard" && plain.preview).not.toHaveProperty(
        "categorySource",
      );
    });

    it("carries the AI mark of a split line to its resolved line, for the card", async () => {
      const result = await service.prepareUpdate(userId, {
        transactionId: "t1",
        splits: [
          { categoryName: "Dining", amount: -20, categorySource: "ai" },
          { categoryName: "Dining", amount: -10 },
        ],
      });
      expect(result.kind === "standard" && result.splits?.[0]).toMatchObject({
        categorySource: "ai",
      });
      expect(
        result.kind === "standard" && result.splits?.[1],
      ).not.toHaveProperty("categorySource");
    });

    it("hands the tag names to the preview, which decides which of them are additions", async () => {
      await service.prepareUpdate(userId, {
        transactionId: "t1",
        description: "x",
        tagNames: ["Allegro"],
      });
      expect(transactions.previewUpdate).toHaveBeenCalledWith(
        userId,
        "t1",
        expect.objectContaining({ tagNames: ["Allegro"] }),
      );
    });

    it("resolves splits against the effective amount and clears the category", async () => {
      const result = await service.prepareUpdate(userId, {
        transactionId: "t1",
        splits: [
          { categoryName: "Dining", amount: -20 },
          { categoryName: "Dining", amount: -10 },
        ],
      });
      expect(result.kind).toBe("standard");
      if (result.kind !== "standard") throw new Error("expected standard");
      expect(result.splits).toHaveLength(2);
      // previewUpdate amount is -30, used as the split sum target.
      expect(splitService.validateSplitsInCurrency).toHaveBeenCalledWith(
        expect.any(Array),
        -30,
        expect.any(String),
      );
      expect(transactions.previewUpdate).toHaveBeenCalledWith(
        userId,
        "t1",
        expect.objectContaining({
          categoryId: undefined,
          // The complete replacement set accompanies the edit, which is what
          // permits category/amount changes on an existing split.
          splitsAccompany: true,
        }),
      );
    });

    it("surfaces previewUpdate's actionable refusal of a category-only edit on an existing split", async () => {
      transactions.previewUpdate.mockRejectedValueOnce(
        new BadRequestException(
          "This is a split transaction: its categories live on its split lines, not on the parent.",
        ),
      );
      await expect(
        service.prepareUpdate(userId, {
          transactionId: "t1",
          categoryName: "Dining",
        }),
      ).rejects.toThrow(/categories live on its split lines/);
    });

    it("rejects splits on a transfer", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: true,
        linkedTransactionId: "t2",
      });
      await expect(
        service.prepareUpdate(userId, {
          transactionId: "t1",
          splits: [
            { categoryName: "Dining", amount: -20 },
            { categoryName: "Dining", amount: -10 },
          ],
        }),
      ).rejects.toThrow(/transfer cannot be converted/i);
    });

    it("auto-detects a transfer and returns a transfer preview", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: true,
        linkedTransactionId: "t2",
      });
      const result = await service.prepareUpdate(userId, {
        transactionId: "t1",
        amount: 100,
      });
      expect(result.kind).toBe("transfer");
      expect(transfer.previewUpdateTransfer).toHaveBeenCalled();
      // createPayeeIfMissing defaults to true and is threaded to the preview.
      expect(transfer.previewUpdateTransfer).toHaveBeenCalledWith(
        userId,
        "t1",
        expect.objectContaining({ createPayeeIfMissing: true }),
        expect.anything(),
      );
    });

    it("throws on an unknown category", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Nope"],
      });
      await expect(
        service.prepareUpdate(userId, {
          transactionId: "t1",
          categoryName: "Nope",
        }),
      ).rejects.toThrow(/Unknown category/);
    });

    it("resolves a category name and threads its id into a transfer edit", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: true,
        linkedTransactionId: "t2",
      });
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: ["c1"],
        unresolved: [],
      });
      const result = await service.prepareUpdate(userId, {
        transactionId: "t1",
        categoryName: "Investments: IKE",
      });
      expect(result.kind).toBe("transfer");
      expect(transfer.previewUpdateTransfer).toHaveBeenCalledWith(
        userId,
        "t1",
        expect.objectContaining({ categoryId: "c1" }),
        expect.anything(),
      );
    });

    it("rejects an unknown category on a transfer edit", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: true,
        linkedTransactionId: "t2",
      });
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Nope"],
      });
      await expect(
        service.prepareUpdate(userId, {
          transactionId: "t1",
          categoryName: "Nope",
        }),
      ).rejects.toThrow(/Unknown category/);
    });

    it("passes categoryId undefined to a transfer edit when none is given", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: true,
        linkedTransactionId: "t2",
      });
      await service.prepareUpdate(userId, {
        transactionId: "t1",
        amount: 100,
      });
      expect(transfer.previewUpdateTransfer).toHaveBeenCalledWith(
        userId,
        "t1",
        expect.objectContaining({ categoryId: undefined }),
        expect.anything(),
      );
    });
  });

  describe("prepareUpdateBulk", () => {
    it("maps standard edits to batch rows and skips transfers", async () => {
      transactions.findOne
        .mockResolvedValueOnce({ id: "t1", isTransfer: false })
        .mockResolvedValueOnce({
          id: "t2",
          isTransfer: true,
          linkedTransactionId: "t3",
        });
      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", amount: -5 },
        { transactionId: "t2", amount: 5 },
      ]);
      expect(result.okRows).toHaveLength(1);
      expect(result.skipped).toHaveLength(1);
    });

    it("carries each row's own split set, clearing the parent category", async () => {
      // The capability this exists for: recategorizing a line inside several
      // split transactions used to need one request per transaction, because
      // batch rows dropped the splits and the tool layer refused them.
      transactions.findOne
        .mockResolvedValueOnce({ id: "t1", isTransfer: false })
        .mockResolvedValueOnce({ id: "t2", isTransfer: false });

      const result = await service.prepareUpdateBulk(userId, [
        {
          transactionId: "t1",
          splits: [
            { categoryName: "Dining", amount: -20 },
            { categoryName: "Dining", amount: -10 },
          ],
        },
        {
          transactionId: "t2",
          splits: [
            { categoryName: "Dining", amount: -25 },
            { categoryName: "Dining", amount: -5 },
          ],
        },
      ]);

      expect(result.okRows).toHaveLength(2);
      for (const row of result.okRows) {
        expect(row.splits).toHaveLength(2);
        // Splits and a parent category are mutually exclusive.
        expect(row.categoryId).toBeNull();
      }
      // Each row is validated against its own amount, not the first row's.
      expect(splitService.validateSplitsInCurrency).toHaveBeenCalledTimes(2);
      expect(result.previewRows[0].splits).toHaveLength(2);
      expect(result.previewRows[0].categoryName).toBeNull();
    });

    it("leaves a parent-field edit without splits alone", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: false,
      });

      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", date: "2026-03-03" },
      ]);

      expect(result.okRows[0].splits).toBeUndefined();
      expect(result.previewRows[0].splits).toBeUndefined();
    });

    it("skips a row whose prepare throws a 4xx, surfacing the date when present", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: false,
      });
      transactions.previewUpdate.mockRejectedValueOnce(
        new BadRequestException("No fields to update"),
      );
      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", date: "2026-03-03" },
      ]);
      expect(result.okRows).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("No fields to update");
      expect(result.previewRows[0]).toMatchObject({
        status: "error",
        transactionDate: "2026-03-03",
      });
    });

    it("skips a row with a generic reason for a 5xx error and no date", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: false,
      });
      transactions.previewUpdate.mockRejectedValueOnce(
        new InternalServerErrorException("boom"),
      );
      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", amount: -1 },
      ]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe("Could not be prepared.");
      expect(result.previewRows[0].transactionDate).toBeUndefined();
    });

    it("falls back to a generic reason for a non-Error rejection", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: "t1",
        isTransfer: false,
      });
      transactions.previewUpdate.mockRejectedValueOnce("string failure");
      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", amount: -1 },
      ]);
      expect(result.skipped[0].reason).toBe("Could not be prepared.");
    });

    it("maps a split parent's parent-field edit to a batch row with a null category and unchanged amount", async () => {
      // A split parent's preview carries categoryId null (categories live on
      // the lines) and the stored amount; the batch row must not invent
      // either. This edit resends no splits, so the row carries none and the
      // existing lines are left exactly as they are.
      transactions.previewUpdate.mockResolvedValueOnce({
        transactionId: "t1",
        accountId: "a1",
        accountName: "Checking",
        amount: -30,
        transactionDate: "2026-02-01",
        payeeId: "p1",
        payeeName: "New Payee",
        payeeMatched: true,
        payeeWillBeCreated: false,
        categoryId: null,
        categoryName: null,
        description: null,
        currencyCode: "USD",
      });
      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", payeeName: "New Payee" },
      ]);
      expect(result.okRows).toHaveLength(1);
      expect(result.okRows[0].categoryId).toBeNull();
      expect(result.okRows[0].amount).toBe(-30);
      // An edit that did not resend splits must not carry any: a row with an
      // empty or invented set would rewrite the lines it was asked to leave.
      expect(result.okRows[0]).not.toHaveProperty("splits");
    });

    it("skips a category-only split row with the actionable resend-splits reason", async () => {
      transactions.previewUpdate.mockRejectedValueOnce(
        new BadRequestException(
          "This is a split transaction: its categories live on its split lines, not on the parent. Read the transaction's current split lines first, then resend the update with the complete splits array.",
        ),
      );
      const result = await service.prepareUpdateBulk(userId, [
        { transactionId: "t1", categoryName: "Dining" },
      ]);
      expect(result.okRows).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain(
        "resend the update with the complete splits array",
      );
      expect(result.previewRows[0].status).toBe("error");
    });
  });

  describe("prepareDelete / prepareDeleteBulk", () => {
    it("previews a single delete", async () => {
      const preview = await service.prepareDelete(userId, "t1");
      expect(preview.transactionId).toBe("t1");
    });

    it("builds batch delete rows best-effort", async () => {
      transactions.previewDelete
        .mockResolvedValueOnce({
          transactionId: "t1",
          accountName: "Checking",
          amount: -1,
          transactionDate: "2026-01-15",
          payeeName: null,
          categoryName: null,
          description: null,
          currencyCode: "USD",
        })
        .mockRejectedValueOnce(
          new BadRequestException("Transaction not found"),
        );
      const result = await service.prepareDeleteBulk(userId, ["t1", "t2"]);
      expect(result.okRows).toEqual([{ transactionId: "t1" }]);
      expect(result.skipped).toHaveLength(1);
    });
  });

  describe("cross-owner transfer refusal (both AI and MCP surfaces)", () => {
    // The transfer's counterpart leg is not the effective user's row: the
    // owner-scoped findOne of the linked id misses.
    const crossOwnerTransfer = () => {
      transactions.findOne.mockImplementation(
        async (_u: string, id: string) => {
          if (id === "t1") {
            return { id: "t1", isTransfer: true, linkedTransactionId: "t2" };
          }
          throw new NotFoundException("Transaction not found");
        },
      );
    };

    it("prepareUpdate refuses a cross-owner transfer with a clear error", async () => {
      crossOwnerTransfer();
      await expect(
        service.prepareUpdate(userId, { transactionId: "t1", amount: 100 }),
      ).rejects.toThrow(/another user's account/);
      expect(transfer.previewUpdateTransfer).not.toHaveBeenCalled();
    });

    it("prepareDelete refuses a cross-owner transfer with the same error", async () => {
      crossOwnerTransfer();
      await expect(service.prepareDelete(userId, "t1")).rejects.toThrow(
        /another user's account/,
      );
      expect(transactions.previewDelete).not.toHaveBeenCalled();
    });

    it("still previews a same-owner transfer update", async () => {
      transactions.findOne.mockImplementation(async (_u: string, id: string) =>
        id === "t1"
          ? { id: "t1", isTransfer: true, linkedTransactionId: "t2" }
          : { id: "t2", isTransfer: true, linkedTransactionId: "t1" },
      );
      const result = await service.prepareUpdate(userId, {
        transactionId: "t1",
        amount: 100,
      });
      expect(result.kind).toBe("transfer");
    });

    it("still previews a same-owner transfer delete", async () => {
      transactions.findOne.mockImplementation(async (_u: string, id: string) =>
        id === "t1"
          ? { id: "t1", isTransfer: true, linkedTransactionId: "t2" }
          : { id: "t2", isTransfer: true, linkedTransactionId: "t1" },
      );
      const preview = await service.prepareDelete(userId, "t1");
      expect(preview.transactionId).toBe("t1");
    });
  });

  describe("transferToBatchRow", () => {
    it("maps a transfer preview to a batch row descriptor", () => {
      const row = service.transferToBatchRow({
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        description: null,
        payeeId: "payee-1",
        payeeName: "Custom label",
        payeeMatched: true,
        payeeWillBeCreated: false,
        categoryId: "cat-1",
        categoryName: "Savings Goal",
      });
      expect(row).toMatchObject({
        fromAccountId: "a1",
        toAccountId: "a2",
        amount: 100,
        toAmount: 100,
        payeeId: "payee-1",
        payeeName: "Custom label",
        createPayee: false,
        categoryId: "cat-1",
      });
    });

    it("carries createPayee from payeeWillBeCreated for an unmatched label", () => {
      const row = service.transferToBatchRow({
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        description: null,
        payeeId: null,
        payeeName: "New label",
        payeeMatched: false,
        payeeWillBeCreated: true,
        categoryId: null,
        categoryName: null,
      });
      expect(row.payeeId).toBeNull();
      expect(row.createPayee).toBe(true);
    });
  });
});
