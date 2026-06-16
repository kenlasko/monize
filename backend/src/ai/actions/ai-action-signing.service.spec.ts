import { ConfigService } from "@nestjs/config";
import { AiActionSigningService } from "./ai-action-signing.service";
import { CreateTransactionDescriptor } from "./ai-action.types";

describe("AiActionSigningService", () => {
  let service: AiActionSigningService;

  const baseDescriptor: CreateTransactionDescriptor = {
    type: "create_transaction",
    userId: "user-1",
    actionId: "action-1",
    expiresAt: 1_900_000_000_000,
    accountId: "acc-1",
    amount: -12.5,
    transactionDate: "2026-01-15",
    payeeId: null,
    payeeName: "Starbucks",
    categoryId: "cat-1",
    description: null,
    currencyCode: "USD",
  };

  beforeEach(() => {
    const config = {
      get: jest
        .fn()
        .mockReturnValue("test-secret-key-at-least-32-chars-long!!"),
    } as unknown as ConfigService;
    service = new AiActionSigningService(config);
  });

  it("produces a deterministic signature regardless of key order", () => {
    const sig1 = service.sign(baseDescriptor);
    const reordered = {
      currencyCode: "USD",
      description: null,
      categoryId: "cat-1",
      payeeName: "Starbucks",
      payeeId: null,
      transactionDate: "2026-01-15",
      amount: -12.5,
      accountId: "acc-1",
      expiresAt: 1_900_000_000_000,
      actionId: "action-1",
      userId: "user-1",
      type: "create_transaction",
    } as CreateTransactionDescriptor;
    expect(service.sign(reordered)).toBe(sig1);
  });

  it("verifies a correctly signed descriptor", () => {
    const sig = service.sign(baseDescriptor);
    expect(service.verify(baseDescriptor, sig)).toBe(true);
  });

  it("rejects a tampered amount", () => {
    const sig = service.sign(baseDescriptor);
    expect(service.verify({ ...baseDescriptor, amount: -9999 }, sig)).toBe(
      false,
    );
  });

  it("rejects a descriptor minted for another user (userId binding)", () => {
    const sig = service.sign(baseDescriptor);
    expect(service.verify({ ...baseDescriptor, userId: "user-2" }, sig)).toBe(
      false,
    );
  });

  it("rejects malformed or empty signatures", () => {
    expect(service.verify(baseDescriptor, "")).toBe(false);
    expect(service.verify(baseDescriptor, "not-hex-zz")).toBe(false);
    expect(service.verify(baseDescriptor, "abcd")).toBe(false);
  });
});
