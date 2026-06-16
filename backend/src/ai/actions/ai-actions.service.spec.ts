import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiActionsService } from "./ai-actions.service";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiWriteLimiter, AI_DAILY_WRITE_LIMIT } from "./ai-write-limiter";
import {
  CategorizeTransactionDescriptor,
  CreatePayeeDescriptor,
  CreateTransactionDescriptor,
} from "./ai-action.types";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";

const USER = "user-1";
const ACC = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const TX = "33333333-3333-4333-8333-333333333333";
const PAYEE = "44444444-4444-4444-8444-444444444444";

describe("AiActionsService", () => {
  let service: AiActionsService;
  let signing: AiActionSigningService;
  let limiter: AiWriteLimiter;
  let transactions: Record<string, jest.Mock>;
  let payees: Record<string, jest.Mock>;

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
    };
    payees = {
      create: jest.fn().mockResolvedValue({ id: "payee-new" }),
    };
    service = new AiActionsService(
      transactions as never,
      payees as never,
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

  function dtoFor(
    descriptor:
      | CreateTransactionDescriptor
      | CategorizeTransactionDescriptor
      | CreatePayeeDescriptor,
  ): ConfirmAiActionDto {
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
});
