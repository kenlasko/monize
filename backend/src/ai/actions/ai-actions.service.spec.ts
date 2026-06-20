import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiActionsService } from "./ai-actions.service";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiWriteLimiter, AI_DAILY_WRITE_LIMIT } from "./ai-write-limiter";
import {
  CategorizeTransactionDescriptor,
  CreatePayeeDescriptor,
  CreateSecurityDescriptor,
  CreateTransactionDescriptor,
  CreateInvestmentTransactionDescriptor,
  CreateTransactionsDescriptor,
  CreateInvestmentTransactionsDescriptor,
  UpdateTransactionDescriptor,
  DeleteTransactionDescriptor,
  UpdateInvestmentTransactionDescriptor,
  DeleteInvestmentTransactionDescriptor,
  TransactionRowDescriptor,
  InvestmentTransactionRowDescriptor,
  AiActionDescriptor,
} from "./ai-action.types";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";

const USER = "user-1";
const ACC = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const TX = "33333333-3333-4333-8333-333333333333";
const PAYEE = "44444444-4444-4444-8444-444444444444";
const SEC = "55555555-5555-4555-8555-555555555555";
const PAYEE2 = "77777777-7777-4777-8777-777777777777";

describe("AiActionsService", () => {
  let service: AiActionsService;
  let signing: AiActionSigningService;
  let limiter: AiWriteLimiter;
  let transactions: Record<string, jest.Mock>;
  let payees: Record<string, jest.Mock>;
  let investments: Record<string, jest.Mock>;
  let securities: Record<string, jest.Mock>;

  beforeEach(() => {
    const config = {
      get: jest
        .fn()
        .mockReturnValue("test-secret-key-at-least-32-chars-long!!"),
    } as unknown as ConfigService;
    signing = new AiActionSigningService(config);
    limiter = new AiWriteLimiter();
    transactions = {
      create: jest.fn().mockResolvedValue({ id: "tx-new" }),
      update: jest.fn().mockResolvedValue({ id: TX }),
      remove: jest.fn().mockResolvedValue(undefined),
      removeAny: jest.fn().mockResolvedValue(undefined),
      createBulk: jest.fn(),
      createTransfer: jest.fn().mockResolvedValue({
        fromTransaction: { id: "tf-1" },
        toTransaction: { id: "tf-2" },
      }),
      updateTransfer: jest.fn().mockResolvedValue({
        fromTransaction: { id: TX },
        toTransaction: { id: "tf-2" },
      }),
    };
    payees = {
      create: jest.fn().mockResolvedValue({ id: "payee-new" }),
      update: jest.fn().mockResolvedValue({ id: "payee-1" }),
      remove: jest.fn().mockResolvedValue(undefined),
      findOrCreate: jest.fn().mockResolvedValue({ id: PAYEE2 }),
    };
    investments = {
      create: jest.fn().mockResolvedValue({ id: "inv-tx-new" }),
      update: jest.fn().mockResolvedValue({ id: TX }),
      remove: jest.fn().mockResolvedValue(undefined),
      createBulk: jest.fn(),
    };
    securities = {
      create: jest.fn().mockResolvedValue({ id: "sec-new" }),
      update: jest.fn().mockResolvedValue({ id: "sec-1" }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    service = new AiActionsService(
      transactions as never,
      payees as never,
      investments as never,
      securities as never,
      signing,
      limiter,
    );
  });

  function createTxDescriptor(
    overrides: Partial<CreateTransactionDescriptor> = {},
  ): CreateTransactionDescriptor {
    return {
      type: "create_transaction",
      userId: USER,
      actionId: "act-create",
      expiresAt: Date.now() + 60_000,
      accountId: ACC,
      amount: -12.5,
      transactionDate: "2026-01-15",
      payeeId: null,
      payeeName: "Starbucks",
      createPayee: false,
      categoryId: CAT,
      description: null,
      currencyCode: "USD",
      ...overrides,
    };
  }

  function createInvestmentDescriptor(
    overrides: Partial<CreateInvestmentTransactionDescriptor> = {},
  ): CreateInvestmentTransactionDescriptor {
    return {
      type: "create_investment_transaction",
      userId: USER,
      actionId: "act-create-inv",
      expiresAt: Date.now() + 60_000,
      accountId: ACC,
      action: InvestmentAction.BUY,
      transactionDate: "2026-01-15",
      securityId: SEC,
      fundingAccountId: null,
      quantity: 10,
      price: 150,
      commission: 4.99,
      exchangeRate: 1,
      description: null,
      ...overrides,
    };
  }

  function dtoFor(descriptor: AiActionDescriptor): ConfirmAiActionDto {
    return {
      actionId: descriptor.actionId,
      signature: signing.sign(descriptor),
      descriptor: descriptor as unknown as Record<string, unknown>,
    };
  }

  it("creates a transaction on a valid confirmation", async () => {
    const descriptor = createTxDescriptor();
    const result = await service.confirm(USER, dtoFor(descriptor));

    expect(transactions.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        accountId: ACC,
        amount: -12.5,
        currencyCode: "USD",
        transactionDate: "2026-01-15",
      }),
      { createPayeeIfMissing: false },
    );
    expect(result).toEqual({ type: "create_transaction", id: "tx-new" });
  });

  it("links the resolved payee when the descriptor carries a payeeId", async () => {
    const descriptor = createTxDescriptor({ payeeId: PAYEE });
    await service.confirm(USER, dtoFor(descriptor));

    expect(transactions.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ payeeId: PAYEE }),
      { createPayeeIfMissing: false },
    );
  });

  it("creates a payee for an unmatched name when the descriptor sets createPayee", async () => {
    const descriptor = createTxDescriptor({
      payeeId: null,
      payeeName: "Brand New Store",
      createPayee: true,
    });
    await service.confirm(USER, dtoFor(descriptor));

    expect(transactions.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ payeeName: "Brand New Store" }),
      { createPayeeIfMissing: true },
    );
  });

  it("categorizes a transaction on a valid confirmation", async () => {
    const descriptor: CategorizeTransactionDescriptor = {
      type: "categorize_transaction",
      userId: USER,
      actionId: "act-cat",
      expiresAt: Date.now() + 60_000,
      transactionId: TX,
      categoryId: CAT,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(transactions.update).toHaveBeenCalledWith(USER, TX, {
      categoryId: CAT,
    });
    expect(result).toEqual({ type: "categorize_transaction", id: TX });
  });

  it("creates a payee on a valid confirmation", async () => {
    const descriptor: CreatePayeeDescriptor = {
      type: "create_payee",
      userId: USER,
      actionId: "act-payee",
      expiresAt: Date.now() + 60_000,
      name: "Acme",
      defaultCategoryId: CAT,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(payees.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ name: "Acme", defaultCategoryId: CAT }),
    );
    expect(result).toEqual({ type: "create_payee", id: "payee-new" });
  });

  it("updates a payee on a valid confirmation", async () => {
    const descriptor = {
      type: "update_payee" as const,
      userId: USER,
      actionId: "act-payee-upd",
      expiresAt: Date.now() + 60_000,
      payeeId: "payee-1",
      name: "Acme Inc",
      defaultCategoryId: CAT,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(payees.update).toHaveBeenCalledWith(
      USER,
      "payee-1",
      expect.objectContaining({ name: "Acme Inc", defaultCategoryId: CAT }),
    );
    expect(result).toEqual({ type: "update_payee", id: "payee-1" });
  });

  it("deletes a payee on a valid confirmation", async () => {
    const descriptor = {
      type: "delete_payee" as const,
      userId: USER,
      actionId: "act-payee-del",
      expiresAt: Date.now() + 60_000,
      payeeId: "payee-1",
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(payees.remove).toHaveBeenCalledWith(USER, "payee-1");
    expect(result).toEqual({ type: "delete_payee", id: "payee-1" });
  });

  it("creates a security on a valid confirmation", async () => {
    const descriptor: CreateSecurityDescriptor = {
      type: "create_security",
      userId: USER,
      actionId: "act-sec",
      expiresAt: Date.now() + 60_000,
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      currencyCode: "USD",
      isFavourite: false,
      quoteProvider: "yahoo",
      msnInstrumentId: null,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(securities.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        currencyCode: "USD",
      }),
    );
    expect(result).toEqual({ type: "create_security", id: "sec-new" });
  });

  it("updates a security on a valid confirmation", async () => {
    const descriptor = {
      type: "update_security" as const,
      userId: USER,
      actionId: "act-sec-upd",
      expiresAt: Date.now() + 60_000,
      securityId: "sec-1",
      securityType: "ETF",
      exchange: "NYSE",
      currencyCode: "USD",
      isFavourite: true,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(securities.update).toHaveBeenCalledWith(
      USER,
      "sec-1",
      expect.objectContaining({ securityType: "ETF", isFavourite: true }),
    );
    expect(result).toEqual({ type: "update_security", id: "sec-1" });
  });

  it("deletes a security on a valid confirmation", async () => {
    const descriptor = {
      type: "delete_security" as const,
      userId: USER,
      actionId: "act-sec-del",
      expiresAt: Date.now() + 60_000,
      securityId: "sec-1",
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(securities.remove).toHaveBeenCalledWith(USER, "sec-1");
    expect(result).toEqual({ type: "delete_security", id: "sec-1" });
  });

  it("executes a batch_actions create_payee envelope", async () => {
    const descriptor = {
      type: "batch_actions" as const,
      userId: USER,
      actionId: "act-batch-cp",
      expiresAt: Date.now() + 60_000,
      operation: "create_payee" as const,
      rows: [{ name: "Acme", defaultCategoryId: CAT }],
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(payees.create).toHaveBeenCalled();
    expect(result).toMatchObject({ type: "batch_actions", count: 1 });
  });

  it("executes a batch_actions update_payee envelope", async () => {
    const descriptor = {
      type: "batch_actions" as const,
      userId: USER,
      actionId: "act-batch-up",
      expiresAt: Date.now() + 60_000,
      operation: "update_payee" as const,
      rows: [{ payeeId: "payee-1", name: "Acme Inc", defaultCategoryId: CAT }],
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(payees.update).toHaveBeenCalledWith(
      USER,
      "payee-1",
      expect.any(Object),
    );
    expect(result).toMatchObject({ type: "batch_actions", count: 1 });
  });

  it("executes a batch_actions delete_payee envelope", async () => {
    const descriptor = {
      type: "batch_actions" as const,
      userId: USER,
      actionId: "act-batch-dp",
      expiresAt: Date.now() + 60_000,
      operation: "delete_payee" as const,
      rows: [{ payeeId: "payee-1" }],
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(payees.remove).toHaveBeenCalledWith(USER, "payee-1");
    expect(result).toMatchObject({ type: "batch_actions", count: 1 });
  });

  it("executes a batch_actions create_security envelope", async () => {
    const descriptor = {
      type: "batch_actions" as const,
      userId: USER,
      actionId: "act-batch-cs",
      expiresAt: Date.now() + 60_000,
      operation: "create_security" as const,
      rows: [
        {
          symbol: "AAPL",
          name: "Apple Inc.",
          securityType: "STOCK",
          exchange: "NASDAQ",
          currencyCode: "USD",
          isFavourite: false,
          quoteProvider: "yahoo" as const,
          msnInstrumentId: null,
        },
      ],
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(securities.create).toHaveBeenCalled();
    expect(result).toMatchObject({ type: "batch_actions", count: 1 });
  });

  it("executes a batch_actions update_security envelope", async () => {
    const descriptor = {
      type: "batch_actions" as const,
      userId: USER,
      actionId: "act-batch-us",
      expiresAt: Date.now() + 60_000,
      operation: "update_security" as const,
      rows: [
        {
          securityId: "sec-1",
          securityType: "ETF",
          exchange: "NYSE",
          currencyCode: "USD",
          isFavourite: true,
        },
      ],
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(securities.update).toHaveBeenCalledWith(
      USER,
      "sec-1",
      expect.any(Object),
    );
    expect(result).toMatchObject({ type: "batch_actions", count: 1 });
  });

  it("executes a batch_actions delete_security envelope", async () => {
    const descriptor = {
      type: "batch_actions" as const,
      userId: USER,
      actionId: "act-batch-ds",
      expiresAt: Date.now() + 60_000,
      operation: "delete_security" as const,
      rows: [{ securityId: "sec-1" }],
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(securities.remove).toHaveBeenCalledWith(USER, "sec-1");
    expect(result).toMatchObject({ type: "batch_actions", count: 1 });
  });

  it("creates an investment transaction on a valid confirmation", async () => {
    const descriptor = createInvestmentDescriptor();
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(investments.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        accountId: ACC,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityId: SEC,
        quantity: 10,
        price: 150,
        commission: 4.99,
        exchangeRate: 1,
      }),
    );
    expect(result).toEqual({
      type: "create_investment_transaction",
      id: "inv-tx-new",
    });
  });

  it("omits security and funding ids for a cash-only investment action", async () => {
    const descriptor = createInvestmentDescriptor({
      action: InvestmentAction.INTEREST,
      securityId: null,
      quantity: null,
      price: 25,
      commission: 0,
    });
    await service.confirm(USER, dtoFor(descriptor));
    const dto = investments.create.mock.calls[0][1];
    expect(dto.securityId).toBeUndefined();
    expect(dto.fundingAccountId).toBeUndefined();
    expect(dto.action).toBe(InvestmentAction.INTEREST);
  });

  it("updates a transaction on a valid confirmation", async () => {
    const descriptor: UpdateTransactionDescriptor = {
      type: "update_transaction",
      userId: USER,
      actionId: "act-update",
      expiresAt: Date.now() + 60_000,
      transactionId: TX,
      accountId: ACC,
      amount: -30,
      transactionDate: "2026-02-01",
      payeeId: PAYEE,
      payeeName: "Store",
      createPayee: false,
      categoryId: CAT,
      description: null,
      currencyCode: "USD",
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(transactions.update).toHaveBeenCalledWith(
      USER,
      TX,
      expect.objectContaining({ amount: -30, currencyCode: "USD" }),
      { createPayeeIfMissing: false },
    );
    expect(result).toEqual({ type: "update_transaction", id: TX });
  });

  it("deletes a transaction on a valid confirmation", async () => {
    const descriptor: DeleteTransactionDescriptor = {
      type: "delete_transaction",
      userId: USER,
      actionId: "act-delete",
      expiresAt: Date.now() + 60_000,
      transactionId: TX,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(transactions.removeAny).toHaveBeenCalledWith(USER, TX);
    expect(result).toEqual({ type: "delete_transaction", id: TX });
  });

  it("updates an investment transaction (account id is not forwarded)", async () => {
    const descriptor: UpdateInvestmentTransactionDescriptor = {
      type: "update_investment_transaction",
      userId: USER,
      actionId: "act-update-inv",
      expiresAt: Date.now() + 60_000,
      transactionId: TX,
      accountId: ACC,
      action: InvestmentAction.SELL,
      transactionDate: "2026-02-01",
      securityId: SEC,
      fundingAccountId: null,
      quantity: 5,
      price: 160,
      commission: 0,
      exchangeRate: 1,
      description: null,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(investments.update).toHaveBeenCalledWith(
      USER,
      TX,
      expect.objectContaining({
        action: InvestmentAction.SELL,
        securityId: SEC,
        quantity: 5,
      }),
    );
    expect(investments.update.mock.calls[0][2].accountId).toBeUndefined();
    expect(result).toEqual({ type: "update_investment_transaction", id: TX });
  });

  it("deletes an investment transaction on a valid confirmation", async () => {
    const descriptor: DeleteInvestmentTransactionDescriptor = {
      type: "delete_investment_transaction",
      userId: USER,
      actionId: "act-delete-inv",
      expiresAt: Date.now() + 60_000,
      transactionId: TX,
    };
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(investments.remove).toHaveBeenCalledWith(USER, TX);
    expect(result).toEqual({
      type: "delete_investment_transaction",
      id: TX,
    });
  });

  it("rejects a bad signature", async () => {
    const descriptor = createTxDescriptor();
    const dto = dtoFor(descriptor);
    dto.signature = "deadbeef";
    await expect(service.confirm(USER, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transactions.create).not.toHaveBeenCalled();
  });

  it("rejects a tampered descriptor (signature no longer matches)", async () => {
    const descriptor = createTxDescriptor();
    const dto = dtoFor(descriptor);
    (dto.descriptor as Record<string, unknown>).amount = -99999;
    await expect(service.confirm(USER, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transactions.create).not.toHaveBeenCalled();
  });

  it("rejects an expired descriptor", async () => {
    const descriptor = createTxDescriptor({ expiresAt: Date.now() - 1000 });
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a malformed descriptor (not an object)", async () => {
    await expect(
      service.confirm(USER, {
        actionId: "x",
        signature: "y",
        descriptor: null as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an unknown descriptor type", async () => {
    const descriptor = createTxDescriptor();
    const dto = dtoFor(descriptor);
    (dto.descriptor as Record<string, unknown>).type = "not_a_real_action";
    await expect(service.confirm(USER, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when the descriptor actionId does not match the dto", async () => {
    const descriptor = createTxDescriptor();
    const dto = dtoFor(descriptor);
    dto.actionId = "different-action-id";
    await expect(service.confirm(USER, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects a descriptor minted for another user", async () => {
    // Signed for a different user; the caller is USER.
    const descriptor = createTxDescriptor({ userId: "other-user" });
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transactions.create).not.toHaveBeenCalled();
  });

  it("rejects a replayed action id", async () => {
    const descriptor = createTxDescriptor();
    await service.confirm(USER, dtoFor(descriptor));
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transactions.create).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a failed write (action id released)", async () => {
    const descriptor = createTxDescriptor();
    transactions.create.mockRejectedValueOnce(new Error("db down"));
    await expect(service.confirm(USER, dtoFor(descriptor))).rejects.toThrow();
    // Same descriptor can be retried because the id was released on failure.
    const result = await service.confirm(USER, dtoFor(descriptor));
    expect(result).toEqual({ type: "create_transaction", id: "tx-new" });
  });

  it("rejects when the daily write limit is reached", async () => {
    for (let i = 0; i < AI_DAILY_WRITE_LIMIT; i++) {
      limiter.record(USER, "create_transaction");
    }
    await expect(
      service.confirm(USER, dtoFor(createTxDescriptor())),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transactions.create).not.toHaveBeenCalled();
  });

  it("rejects when descriptor fields fail DTO validation", async () => {
    const descriptor = createTxDescriptor({ currencyCode: "not-a-currency" });
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transactions.create).not.toHaveBeenCalled();
  });

  describe("bulk create_transactions", () => {
    function bulkTxDescriptor(
      overrides: Partial<CreateTransactionsDescriptor> = {},
    ): CreateTransactionsDescriptor {
      const row = (amount: number): TransactionRowDescriptor => ({
        accountId: ACC,
        amount,
        transactionDate: "2026-01-15",
        payeeId: null,
        payeeName: "Store",
        createPayee: false,
        categoryId: CAT,
        description: null,
        currencyCode: "USD",
      });
      return {
        type: "create_transactions",
        userId: USER,
        actionId: "act-bulk",
        expiresAt: Date.now() + 60_000,
        rows: [row(-10), row(-20)],
        ...overrides,
      };
    }

    it("creates all valid rows best-effort and returns ids/count/skipped", async () => {
      transactions.createBulk.mockResolvedValue({
        created: [{ id: "tx-1" }, { id: "tx-2" }],
        skipped: [],
      });
      const descriptor = bulkTxDescriptor();
      const result = await service.confirm(USER, dtoFor(descriptor));

      expect(transactions.createBulk).toHaveBeenCalledTimes(1);
      const passedRows = transactions.createBulk.mock.calls[0][1];
      expect(passedRows).toHaveLength(2);
      expect(passedRows[0]).toMatchObject({ createPayeeIfMissing: false });
      expect(result).toEqual({
        type: "create_transactions",
        id: "tx-1",
        ids: ["tx-1", "tx-2"],
        count: 2,
        skipped: [],
      });
    });

    it("reports rows the service skipped, remapped to original indices", async () => {
      // Row 1 (index 1) fails inside createBulk.
      transactions.createBulk.mockResolvedValue({
        created: [{ id: "tx-1" }],
        skipped: [{ index: 1, reason: "Insufficient funds" }],
      });
      const result = await service.confirm(USER, dtoFor(bulkTxDescriptor()));
      expect(result.count).toBe(1);
      expect(result.skipped).toEqual([
        { index: 1, reason: "Insufficient funds" },
      ]);
    });

    it("skips a row that fails re-validation without aborting the batch", async () => {
      transactions.createBulk.mockResolvedValue({
        created: [{ id: "tx-1" }],
        skipped: [],
      });
      // Second row has an invalid currency -> dropped before createBulk.
      const descriptor = bulkTxDescriptor();
      descriptor.rows[1] = {
        ...descriptor.rows[1],
        currencyCode: "not-a-currency",
      };
      const result = await service.confirm(USER, dtoFor(descriptor));

      // Only the valid row reaches the service.
      expect(transactions.createBulk.mock.calls[0][1]).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.skipped?.some((s) => s.index === 1)).toBe(true);
    });

    it("records one write per created row against the daily cap", async () => {
      transactions.createBulk.mockResolvedValue({
        created: [{ id: "tx-1" }, { id: "tx-2" }],
        skipped: [],
      });
      await service.confirm(USER, dtoFor(bulkTxDescriptor()));
      expect(limiter.checkLimit(USER).currentCount).toBe(2);
    });

    it("rejects the batch when it would exceed the daily cap", async () => {
      for (let i = 0; i < AI_DAILY_WRITE_LIMIT - 1; i++) {
        limiter.record(USER, "create_transaction");
      }
      // Two rows + 49 existing = 51 > 50 cap.
      await expect(
        service.confirm(USER, dtoFor(bulkTxDescriptor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactions.createBulk).not.toHaveBeenCalled();
    });

    it("cannot be replayed after a best-effort confirm", async () => {
      transactions.createBulk.mockResolvedValue({
        created: [{ id: "tx-1" }, { id: "tx-2" }],
        skipped: [],
      });
      const descriptor = bulkTxDescriptor();
      await service.confirm(USER, dtoFor(descriptor));
      await expect(
        service.confirm(USER, dtoFor(descriptor)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactions.createBulk).toHaveBeenCalledTimes(1);
    });
  });

  describe("bulk create_investment_transactions", () => {
    it("creates all valid rows and returns ids/count", async () => {
      investments.createBulk.mockResolvedValue({
        created: [{ id: "inv-1" }, { id: "inv-2" }],
        skipped: [],
      });
      const row = (): InvestmentTransactionRowDescriptor => ({
        accountId: ACC,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityId: SEC,
        fundingAccountId: null,
        quantity: 10,
        price: 150,
        commission: 0,
        exchangeRate: 1,
        description: null,
      });
      const descriptor: CreateInvestmentTransactionsDescriptor = {
        type: "create_investment_transactions",
        userId: USER,
        actionId: "act-bulk-inv",
        expiresAt: Date.now() + 60_000,
        rows: [row(), row()],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(investments.createBulk).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        type: "create_investment_transactions",
        id: "inv-1",
        ids: ["inv-1", "inv-2"],
        count: 2,
      });
    });
  });

  const ACC2 = "66666666-6666-4666-8666-666666666666";

  describe("transfer and batch actions", () => {
    function createTransferDescriptor() {
      const d: import("./ai-action.types").CreateTransferDescriptor = {
        type: "create_transfer",
        userId: USER,
        actionId: "act-xfer",
        expiresAt: Date.now() + 60_000,
        fromAccountId: ACC,
        toAccountId: ACC2,
        amount: 100,
        transactionDate: "2026-01-15",
        fromCurrencyCode: "USD",
        toCurrencyCode: "USD",
        exchangeRate: 1,
        toAmount: 100,
        description: null,
        payeeId: PAYEE,
        payeeName: "Custom transfer label",
        createPayee: false,
      };
      return d;
    }

    it("executes create_transfer passing the matched payeeId without find-or-create", async () => {
      const descriptor = createTransferDescriptor();
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(payees.findOrCreate).not.toHaveBeenCalled();
      expect(transactions.createTransfer).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          fromAccountId: ACC,
          toAccountId: ACC2,
          amount: 100,
          payeeId: PAYEE,
          payeeName: "Custom transfer label",
        }),
      );
      expect(result.type).toBe("create_transfer");
      expect(result.id).toBe("tf-1");
    });

    it("create_transfer find-or-creates the payee for an unmatched label and links the new id", async () => {
      const descriptor = createTransferDescriptor();
      descriptor.payeeId = null;
      descriptor.createPayee = true;
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(payees.findOrCreate).toHaveBeenCalledWith(
        USER,
        "Custom transfer label",
      );
      expect(transactions.createTransfer).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          payeeId: PAYEE2,
          payeeName: "Custom transfer label",
        }),
      );
      expect(result.type).toBe("create_transfer");
    });

    it("executes update_transfer passing the matched payeeId", async () => {
      const descriptor: import("./ai-action.types").UpdateTransferDescriptor = {
        type: "update_transfer",
        userId: USER,
        actionId: "act-xfer-up",
        expiresAt: Date.now() + 60_000,
        transactionId: TX,
        fromAccountId: ACC,
        toAccountId: ACC2,
        amount: 200,
        transactionDate: "2026-02-01",
        exchangeRate: 1,
        toAmount: 200,
        description: null,
        payeeId: PAYEE,
        payeeName: "Edited transfer label",
        createPayee: false,
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(payees.findOrCreate).not.toHaveBeenCalled();
      expect(transactions.updateTransfer).toHaveBeenCalledWith(
        USER,
        TX,
        expect.objectContaining({
          amount: 200,
          payeeId: PAYEE,
          payeeName: "Edited transfer label",
        }),
      );
      expect(result.type).toBe("update_transfer");
    });

    it("update_transfer find-or-creates the payee for an unmatched label", async () => {
      const descriptor: import("./ai-action.types").UpdateTransferDescriptor = {
        type: "update_transfer",
        userId: USER,
        actionId: "act-xfer-up2",
        expiresAt: Date.now() + 60_000,
        transactionId: TX,
        fromAccountId: ACC,
        toAccountId: ACC2,
        amount: 200,
        transactionDate: "2026-02-01",
        exchangeRate: 1,
        toAmount: 200,
        description: null,
        payeeId: null,
        payeeName: "Brand new edit label",
        createPayee: true,
      };
      await service.confirm(USER, dtoFor(descriptor));
      expect(payees.findOrCreate).toHaveBeenCalledWith(
        USER,
        "Brand new edit label",
      );
      expect(transactions.updateTransfer).toHaveBeenCalledWith(
        USER,
        TX,
        expect.objectContaining({ payeeId: PAYEE2 }),
      );
    });

    it("executes batch_actions(delete) best-effort, collecting skips", async () => {
      transactions.removeAny
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("nope"));
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch",
        expiresAt: Date.now() + 60_000,
        operation: "delete",
        rows: [{ transactionId: TX }, { transactionId: ACC2 }],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(result.type).toBe("batch_actions");
      expect(result.count).toBe(1);
      expect(result.skipped).toHaveLength(1);
    });

    it("executes batch_actions(update) for each row", async () => {
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-upd",
        expiresAt: Date.now() + 60_000,
        operation: "update",
        rows: [
          {
            transactionId: TX,
            accountId: ACC,
            amount: -25,
            transactionDate: "2026-01-15",
            payeeId: null,
            payeeName: null,
            createPayee: false,
            categoryId: CAT,
            description: null,
            currencyCode: "USD",
          },
        ],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(transactions.update).toHaveBeenCalled();
      expect(result).toMatchObject({ type: "batch_actions", count: 1 });
    });

    it("executes batch_actions(create) for each row", async () => {
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-create",
        expiresAt: Date.now() + 60_000,
        operation: "create",
        rows: [
          {
            accountId: ACC,
            amount: -25,
            transactionDate: "2026-01-15",
            payeeId: null,
            payeeName: null,
            createPayee: false,
            categoryId: CAT,
            description: null,
            currencyCode: "USD",
          },
        ],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(transactions.create).toHaveBeenCalled();
      expect(result).toMatchObject({ type: "batch_actions", count: 1 });
    });

    it("executes batch_actions(create_transfer) for each row", async () => {
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-xfer",
        expiresAt: Date.now() + 60_000,
        operation: "create_transfer",
        rows: [
          {
            fromAccountId: ACC,
            toAccountId: ACC2,
            amount: 50,
            transactionDate: "2026-01-15",
            fromCurrencyCode: "USD",
            toCurrencyCode: "USD",
            exchangeRate: 1,
            toAmount: 50,
            description: null,
            payeeId: null,
            payeeName: null,
            createPayee: false,
          },
        ],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(transactions.createTransfer).toHaveBeenCalledTimes(1);
      expect(result.count).toBe(1);
    });

    it("batch_actions(create_transfer) find-or-creates the payee for an unmatched label", async () => {
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-xfer2",
        expiresAt: Date.now() + 60_000,
        operation: "create_transfer",
        rows: [
          {
            fromAccountId: ACC,
            toAccountId: ACC2,
            amount: 50,
            transactionDate: "2026-01-15",
            fromCurrencyCode: "USD",
            toCurrencyCode: "USD",
            exchangeRate: 1,
            toAmount: 50,
            description: null,
            payeeId: null,
            payeeName: "Batch new label",
            createPayee: true,
          },
        ],
      };
      await service.confirm(USER, dtoFor(descriptor));
      expect(payees.findOrCreate).toHaveBeenCalledWith(USER, "Batch new label");
      expect(transactions.createTransfer).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ payeeId: PAYEE2 }),
      );
    });

    it("executes batch_actions(update_investment) via investmentTransactions.update (no accountId forwarded)", async () => {
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-inv-up",
        expiresAt: Date.now() + 60_000,
        operation: "update_investment",
        rows: [
          {
            transactionId: TX,
            accountId: ACC,
            action: InvestmentAction.SELL,
            transactionDate: "2026-02-01",
            securityId: SEC,
            fundingAccountId: null,
            quantity: 5,
            price: 160,
            commission: 0,
            exchangeRate: 1,
            description: null,
          },
        ],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(investments.update).toHaveBeenCalledWith(
        USER,
        TX,
        expect.objectContaining({
          action: InvestmentAction.SELL,
          securityId: SEC,
          quantity: 5,
        }),
      );
      expect(investments.update.mock.calls[0][2].accountId).toBeUndefined();
      expect(result.type).toBe("batch_actions");
      expect(result.count).toBe(1);
      expect(result.ids).toEqual([TX]);
    });

    it("executes batch_actions(delete_investment) via investmentTransactions.remove, collecting skips", async () => {
      investments.remove
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("nope"));
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-inv-del",
        expiresAt: Date.now() + 60_000,
        operation: "delete_investment",
        rows: [{ transactionId: TX }, { transactionId: SEC }],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(investments.remove).toHaveBeenCalledWith(USER, TX);
      expect(result.type).toBe("batch_actions");
      expect(result.count).toBe(1);
      expect(result.skipped).toHaveLength(1);
    });

    it("batch_actions(update_investment) skips a row whose update fails", async () => {
      investments.update.mockRejectedValueOnce(new Error("boom"));
      const descriptor: import("./ai-action.types").BatchActionsDescriptor = {
        type: "batch_actions",
        userId: USER,
        actionId: "act-batch-inv-up-skip",
        expiresAt: Date.now() + 60_000,
        operation: "update_investment",
        rows: [
          {
            transactionId: TX,
            accountId: ACC,
            action: InvestmentAction.BUY,
            transactionDate: "2026-02-01",
            securityId: SEC,
            fundingAccountId: null,
            quantity: 1,
            price: 10,
            commission: 0,
            exchangeRate: 1,
            description: null,
          },
        ],
      };
      const result = await service.confirm(USER, dtoFor(descriptor));
      expect(result.count).toBe(0);
      expect(result.skipped).toHaveLength(1);
    });
  });
});
