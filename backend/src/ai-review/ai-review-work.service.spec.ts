import { ConflictException, NotFoundException } from "@nestjs/common";
import { RECEIPT_PARSED_INSTRUCTION } from "../email-receipts/pipeline/receipt-instructions";
import { DataSource } from "typeorm";
import { Currency } from "../currencies/entities/currency.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { EmailReceipt } from "../email-receipts/entities/email-receipt.entity";
import { AiReviewRequest } from "./ai-review-request.entity";
import { AiReviewWorkService } from "./ai-review-work.service";
import {
  AI_REVIEW_EMAIL_TEXT_MAX_CHARS,
  AI_REVIEW_PARSER_EMAIL_TEXT_MAX_CHARS,
  ASSISTANT_CLAIM_KEY,
} from "./ai-review-work.types";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const REQ = "30000000-0000-4000-8000-000000000001";
const TX = "10000000-0000-4000-8000-000000000001";
const RULE = "20000000-0000-4000-8000-000000000001";
const RECEIPT = "40000000-0000-4000-8000-000000000001";

function request(over: Partial<AiReviewRequest> = {}): AiReviewRequest {
  return Object.assign(new AiReviewRequest(), {
    id: REQ,
    userId: USER,
    transactionId: TX,
    ruleId: RULE,
    kind: "transaction_review",
    instruction: "Split by the order items",
    status: "claimed",
    claimedBy: "agent-1",
    claimedAt: new Date("2026-09-29T09:00:00Z"),
    proposal: null,
    createdAt: new Date("2026-09-29T08:00:00Z"),
    updatedAt: new Date("2026-09-29T09:00:00Z"),
    // Far in the future: the service compares expiry with the real clock, so a
    // fixed date near today expires the fixture and fails every "proposed" case.
    expiresAt: new Date("2099-10-29T08:00:00Z"),
    ...over,
  });
}

const preview = { transactionId: TX, amount: -50 };
const card = (id = "a1") =>
  ({
    actionId: id,
    type: "update_transaction",
    preview: { splits: [] },
    descriptor: { type: "update_transaction", aiReviewRequestId: REQ },
  }) as never;

function setup() {
  const txRepo = { find: jest.fn().mockResolvedValue([]) };
  const ruleRepo = { find: jest.fn().mockResolvedValue([]) };
  const receiptRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
  // `loadCurrencyPlaces`: no row reads as the fiat default (four places).
  const currencyRepo = { find: jest.fn().mockResolvedValue([]) };
  const { dataSource, manager } = createScopedDbMocks([
    [Currency, currencyRepo],
    [Transaction, txRepo],
    [TransactionRule, ruleRepo],
    [EmailReceipt, receiptRepo],
  ]);
  // The ledger check (`findTradeInLedger`) and the user's timezone: none by default.
  manager.query.mockResolvedValue([]);
  const requests = {
    listForUser: jest.fn().mockResolvedValue([]),
    getForUser: jest.fn().mockResolvedValue(request()),
    claimNext: jest.fn(),
    claimById: jest.fn(),
    submitProposal: jest.fn(),
    release: jest.fn(),
    dismiss: jest.fn(),
  };
  const transactions = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: TX, amount: -50, isTransfer: false }),
    getLlmTransactionById: jest
      .fn()
      .mockResolvedValue([{ id: TX, amount: -50 }]),
  };
  const prep = {
    prepareUpdate: jest
      .fn()
      .mockResolvedValue({ kind: "standard", preview, splits: [{ x: 1 }] }),
  };
  const builder = {
    buildUpdateTransaction: jest.fn().mockReturnValue(card()),
    buildCreateInvestmentTransaction: jest.fn().mockReturnValue(card()),
  };
  const investments = { previewCreateInvestmentTransaction: jest.fn() };
  const securities = { resolveByTradeSymbol: jest.fn() };
  const accounts = { resolveBrokerageByNameOrId: jest.fn() };
  const scheduled = {
    findInvestmentOccurrenceForTrade: jest.fn().mockResolvedValue(null),
  };
  const service = new AiReviewWorkService(
    dataSource as unknown as DataSource,
    requests as never,
    transactions as never,
    prep as never,
    builder as never,
    investments as never,
    securities as never,
    scheduled as never,
    accounts as never,
  );
  return {
    service,
    requests,
    transactions,
    prep,
    builder,
    investments,
    securities,
    scheduled,
    accounts,
    txRepo,
    ruleRepo,
    receiptRepo,
    currencyRepo,
    manager,
  };
}

const lines = [
  { categoryName: "Books", amount: -30 },
  { categoryName: "Toys", amount: -20 },
];

describe("AiReviewWorkService.list", () => {
  it("asks for open, unexpired requests and says whether the page was cut", async () => {
    const { service, requests } = setup();
    requests.listForUser.mockResolvedValue([
      request({ status: "pending", claimedBy: null }),
      request({ id: "b", status: "claimed" }),
      request({ id: "c", status: "proposed" }),
    ]);

    const list = await service.list(USER, "agent-1", 2);

    expect(requests.listForUser).toHaveBeenCalledWith(USER, {
      statuses: ["pending", "claimed", "proposed"],
      unexpiredOnly: true,
      limit: 3,
    });
    expect(list.requests).toHaveLength(2);
    expect(list.truncated).toBe(true);
    expect(list.requests[1].claimedByYou).toBe(true);
    // The claim key itself never reaches a model.
    expect(JSON.stringify(list)).not.toContain('"claimedBy"');
  });

  it("clamps the limit to the tool ceiling", async () => {
    const { service, requests } = setup();
    await service.list(USER, "agent-1", 9999);
    expect(requests.listForUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ limit: 51 }),
    );
  });
});

describe("AiReviewWorkService.claim", () => {
  it("claims for the caller and returns the transaction through the LLM read path", async () => {
    const { service, requests, transactions } = setup();
    requests.claimNext.mockResolvedValue(request());

    const claimed = await service.claim(USER, "agent-1");

    expect(requests.claimNext).toHaveBeenCalledWith(USER, "agent-1");
    expect(transactions.getLlmTransactionById).toHaveBeenCalledWith(USER, TX);
    expect(claimed.request?.id).toBe(REQ);
    expect(claimed.transaction).toEqual([{ id: TX, amount: -50 }]);
  });

  it("claims the named request by id, not the oldest, and reads it the same way", async () => {
    const { service, requests, transactions } = setup();
    requests.claimById.mockResolvedValue(request());

    const claimed = await service.claim(USER, "assistant", REQ);

    expect(requests.claimById).toHaveBeenCalledWith(USER, REQ, "assistant");
    expect(requests.claimNext).not.toHaveBeenCalled();
    expect(transactions.getLlmTransactionById).toHaveBeenCalledWith(USER, TX);
    expect(claimed.request?.id).toBe(REQ);
  });

  it("returns no request when the named one is not pending, expired or not the user's", async () => {
    const { service, requests, transactions } = setup();
    requests.claimById.mockResolvedValue(null);
    expect(await service.claim(USER, "assistant", REQ)).toEqual({
      request: null,
    });
    expect(requests.claimNext).not.toHaveBeenCalled();
    expect(transactions.getLlmTransactionById).not.toHaveBeenCalled();
  });

  it("returns no request when nothing is pending", async () => {
    const { service, requests, transactions } = setup();
    requests.claimNext.mockResolvedValue(null);
    expect(await service.claim(USER, "agent-1")).toEqual({ request: null });
    expect(transactions.getLlmTransactionById).not.toHaveBeenCalled();
  });

  it("gives the request back rather than stranding it when the transaction cannot be read", async () => {
    const { service, requests, transactions } = setup();
    requests.claimNext.mockResolvedValue(request());
    transactions.getLlmTransactionById.mockRejectedValue(new Error("boom"));

    await expect(service.claim(USER, "agent-1")).rejects.toThrow("boom");

    expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
      final: false,
      note: expect.any(String),
    });
  });

  it("surfaces a previous agent's note", async () => {
    const { service, requests } = setup();
    requests.claimNext.mockResolvedValue(
      request({
        proposal: { agentNote: { reason: "no order id", at: "2026-09-28" } },
      }),
    );
    const claimed = await service.claim(USER, "agent-1");
    expect(claimed.request?.agentNote).toEqual({
      reason: "no order id",
      at: "2026-09-28",
    });
  });

  describe("a request of kind email_receipt", () => {
    const emailRequest = () =>
      request({
        kind: "email_receipt",
        ruleId: null,
        emailReceiptId: RECEIPT,
      });
    const receipt = (over: Record<string, unknown> = {}) =>
      Object.assign(new EmailReceipt(), {
        id: RECEIPT,
        fromAddress: "orders@shop.example.com",
        subject: "Your order #123",
        receivedAt: new Date("2026-09-29T07:30:00Z"),
        bodyText: "Order total: 49.99",
        ...over,
      });

    it("returns the email with the claim, and names it on the request", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(emailRequest());
      receiptRepo.findOne.mockResolvedValue(receipt());

      const claimed = await service.claim(USER, "agent-1");

      expect(claimed.request).toMatchObject({
        kind: "email_receipt",
        emailReceiptId: RECEIPT,
        ruleId: null,
      });
      expect(claimed.emailReceipt).toEqual({
        fromAddress: "orders@shop.example.com",
        subject: "Your order #123",
        receivedAt: "2026-09-29T07:30:00.000Z",
        text: "Order total: 49.99",
      });
    });

    it("reads the email by id AND owner, so another user's email is absent", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(emailRequest());

      const claimed = await service.claim(USER, "agent-1");

      expect(receiptRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RECEIPT, userId: USER } }),
      );
      expect(claimed.emailReceipt).toBeUndefined();
      expect(claimed.request?.id).toBe(REQ);
    });

    it("cuts the text to the claim's limit", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(emailRequest());
      receiptRepo.findOne.mockResolvedValue(
        receipt({ bodyText: "x".repeat(AI_REVIEW_EMAIL_TEXT_MAX_CHARS + 500) }),
      );

      const claimed = await service.claim(USER, "agent-1");

      expect(AI_REVIEW_EMAIL_TEXT_MAX_CHARS).toBe(20_000);
      expect(claimed.emailReceipt?.text).toHaveLength(
        AI_REVIEW_EMAIL_TEXT_MAX_CHARS,
      );
    });

    it("selects only the fields it hands out", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(emailRequest());

      await service.claim(USER, "agent-1");

      expect(receiptRepo.findOne.mock.calls[0][0].select).toEqual({
        id: true,
        fromAddress: true,
        subject: true,
        receivedAt: true,
        bodyText: true,
      });
    });

    it("gives the request back when the email cannot be read", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(emailRequest());
      receiptRepo.findOne.mockRejectedValue(new Error("db down"));

      await expect(service.claim(USER, "agent-1")).rejects.toThrow("db down");

      expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
        final: false,
        note: expect.any(String),
      });
    });

    it("carries no email for a request whose email was deleted", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(
        request({ kind: "email_receipt", ruleId: null, emailReceiptId: null }),
      );

      const claimed = await service.claim(USER, "agent-1");

      expect(receiptRepo.findOne).not.toHaveBeenCalled();
      expect(claimed).not.toHaveProperty("emailReceipt");
    });
  });

  describe("a request of kind email_parser_draft", () => {
    const R1 = "40000000-0000-4000-8000-0000000000a1";
    const R2 = "40000000-0000-4000-8000-0000000000a2";
    const R3 = "40000000-0000-4000-8000-0000000000a3";
    const draftRequest = (over: Partial<AiReviewRequest> = {}) =>
      request({
        kind: "email_parser_draft",
        transactionId: null,
        ruleId: null,
        emailReceiptId: null,
        emailReceiptIds: [R1, R2, R3],
        parserDomain: "shop.example.com",
        ...over,
      });
    const email = (id: string, over: Record<string, unknown> = {}) =>
      Object.assign(new EmailReceipt(), {
        id,
        fromAddress: "orders@shop.example.com",
        subject: `Order ${id.slice(-2)}`,
        receivedAt: new Date("2026-09-29T07:30:00Z"),
        originalSentAt: null,
        bodyText: "Order total: 49.99",
        ...over,
      });

    it("returns the emails, in the order the request names them, and no transaction", async () => {
      const { service, requests, receiptRepo, transactions } = setup();
      requests.claimNext.mockResolvedValue(draftRequest());
      receiptRepo.find.mockResolvedValue([email(R3), email(R1), email(R2)]);

      const claimed = await service.claim(USER, "agent-1");

      expect(claimed.request).toMatchObject({
        kind: "email_parser_draft",
        transactionId: null,
        emailReceiptIds: [R1, R2, R3],
        parserDomain: "shop.example.com",
      });
      expect(claimed.emailReceipts?.map((e) => e.id)).toEqual([R1, R2, R3]);
      expect(claimed.emailReceipts?.[0]).toEqual({
        id: R1,
        fromAddress: "orders@shop.example.com",
        subject: "Order a1",
        effectiveDate: "2026-09-29T07:30:00.000Z",
        text: "Order total: 49.99",
      });
      expect(claimed).not.toHaveProperty("transaction");
      expect(claimed).not.toHaveProperty("emailReceipt");
      expect(transactions.getLlmTransactionById).not.toHaveBeenCalled();
    });

    it("dates an email by the shop's day when a forward carried it", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(
        draftRequest({ emailReceiptIds: [R1] }),
      );
      receiptRepo.find.mockResolvedValue([
        email(R1, { originalSentAt: new Date("2026-08-10T10:15:00Z") }),
      ]);

      const claimed = await service.claim(USER, "agent-1");

      expect(claimed.emailReceipts?.[0].effectiveDate).toBe(
        "2026-08-10T10:15:00.000Z",
      );
    });

    it("cuts each email's text to 12,000 characters", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(
        draftRequest({ emailReceiptIds: [R1] }),
      );
      receiptRepo.find.mockResolvedValue([
        email(R1, {
          bodyText: "x".repeat(AI_REVIEW_PARSER_EMAIL_TEXT_MAX_CHARS + 500),
        }),
      ]);

      const claimed = await service.claim(USER, "agent-1");

      expect(AI_REVIEW_PARSER_EMAIL_TEXT_MAX_CHARS).toBe(12_000);
      expect(claimed.emailReceipts?.[0].text).toHaveLength(12_000);
    });

    it("reads the emails by id AND owner, so another user's email is absent, and skips a deleted one", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(draftRequest());
      receiptRepo.find.mockResolvedValue([email(R2)]);

      const claimed = await service.claim(USER, "agent-1");

      const where = receiptRepo.find.mock.calls[0][0].where;
      expect(where.userId).toBe(USER);
      expect(where.id._value).toEqual([R1, R2, R3]);
      expect(claimed.emailReceipts?.map((e) => e.id)).toEqual([R2]);
    });

    it("selects only the fields it hands out", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(draftRequest());

      await service.claim(USER, "agent-1");

      expect(receiptRepo.find.mock.calls[0][0].select).toEqual({
        id: true,
        fromAddress: true,
        subject: true,
        receivedAt: true,
        originalSentAt: true,
        bodyText: true,
      });
    });

    it("claims it by id like any other request", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimById.mockResolvedValue(draftRequest());
      receiptRepo.find.mockResolvedValue([email(R1)]);

      const claimed = await service.claim(USER, "assistant", REQ);

      expect(requests.claimById).toHaveBeenCalledWith(USER, REQ, "assistant");
      expect(claimed.request?.id).toBe(REQ);
    });

    it("gives the request back when its emails cannot be read", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(draftRequest());
      receiptRepo.find.mockRejectedValue(new Error("db down"));

      await expect(service.claim(USER, "agent-1")).rejects.toThrow("db down");

      expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
        final: false,
        note: expect.any(String),
      });
    });

    it("carries no emails when the request names none", async () => {
      const { service, requests, receiptRepo } = setup();
      requests.claimNext.mockResolvedValue(
        draftRequest({ emailReceiptIds: null }),
      );

      const claimed = await service.claim(USER, "agent-1");

      expect(receiptRepo.find).not.toHaveBeenCalled();
      expect(claimed.emailReceipts).toEqual([]);
    });

    it("is listed for a model with its emails' ids and sender, and no transaction id", async () => {
      const { service, requests } = setup();
      requests.listForUser.mockResolvedValue([
        draftRequest({ status: "pending", claimedBy: null }),
      ]);

      const list = await service.list(USER, "agent-1");

      expect(list.requests[0]).toMatchObject({
        kind: "email_parser_draft",
        transactionId: null,
        emailReceiptIds: [R1, R2, R3],
        parserDomain: "shop.example.com",
      });
    });

    it("refuses the generic submit: this kind is answered with email_receipt_parsers", async () => {
      const { service, requests, builder } = setup();
      requests.getForUser.mockResolvedValue(
        draftRequest({ claimedBy: "agent-1" }),
      );

      await expect(
        service.submit(USER, "agent-1", REQ, { description: "x" }),
      ).rejects.toThrow(/email_receipt_parsers/);

      expect(requests.submitProposal).not.toHaveBeenCalled();
      expect(builder.buildUpdateTransaction).not.toHaveBeenCalled();
    });

    it("can be given back or closed like any other request", async () => {
      const { service, requests } = setup();
      requests.getForUser.mockResolvedValue(
        draftRequest({ claimedBy: "agent-1" }),
      );
      requests.release.mockResolvedValue(
        draftRequest({ status: "rejected", claimedBy: null }),
      );

      const released = await service.reject(
        USER,
        "agent-1",
        REQ,
        "no readable emails",
        true,
      );

      expect(released.status).toBe("rejected");
    });
  });

  it("never reads an email for an ordinary review request", async () => {
    const { service, requests, receiptRepo } = setup();
    requests.claimNext.mockResolvedValue(request());

    const claimed = await service.claim(USER, "agent-1");

    expect(receiptRepo.findOne).not.toHaveBeenCalled();
    expect(claimed).not.toHaveProperty("emailReceipt");
    expect(claimed.request?.emailReceiptId).toBeNull();
  });
});

describe("AiReviewWorkService.submit", () => {
  it("builds the card through the update_transaction preparation and stores it, writing no transaction", async () => {
    const { service, requests, prep, builder, transactions } = setup();
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));

    const result = await service.submit(USER, "agent-1", REQ, {
      splits: lines,
      description: "Allegro order",
    });

    expect(prep.prepareUpdate).toHaveBeenCalledWith(USER, {
      transactionId: TX,
      splits: lines,
      categoryName: undefined,
      payeeName: undefined,
      description: "Allegro order",
    });
    expect(builder.buildUpdateTransaction).toHaveBeenCalledWith(
      USER,
      preview,
      [{ x: 1 }],
      undefined,
      { aiReviewRequestId: REQ },
    );
    expect(requests.submitProposal).toHaveBeenCalledWith(
      USER,
      REQ,
      "agent-1",
      expect.objectContaining({
        input: { splits: lines, description: "Allegro order" },
        action: card(),
      }),
    );
    expect(result.action).toEqual(card());
    expect(result.request.status).toBe("proposed");
    // Reading is all it did to the ledger.
    expect(Object.keys(transactions)).toEqual([
      "findOne",
      "getLlmTransactionById",
    ]);
  });

  it("refuses lines that do not add up, naming the difference, before storing anything", async () => {
    const { service, requests, prep } = setup();

    await expect(
      service.submit(USER, "agent-1", REQ, {
        splits: [
          { categoryName: "Books", amount: -30 },
          { categoryName: "Toys", amount: -17.5 },
        ],
      }),
    ).rejects.toThrow(
      /add up to -47.5 but the transaction is -50: -2.5 is not assigned/,
    );

    expect(prep.prepareUpdate).not.toHaveBeenCalled();
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it("compares a coin transaction's lines at the coin's eight places", async () => {
    const { service, transactions, currencyRepo, requests } = setup();
    transactions.findOne.mockResolvedValue({
      id: TX,
      amount: -0.000025,
      currencyCode: "BTC",
      isTransfer: false,
    });
    currencyRepo.find.mockResolvedValue([{ code: "BTC", decimalPlaces: 8 }]);
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));

    await service.submit(USER, "agent-1", REQ, {
      splits: [
        { categoryName: "Transfer fee", amount: -0.00002 },
        { categoryName: "Network fee", amount: -0.000005 },
      ],
    });
    expect(requests.submitProposal).toHaveBeenCalled();

    // One satoshi short is a leftover at eight places (fiat's four would hide it).
    await expect(
      service.submit(USER, "agent-1", REQ, {
        splits: [
          { categoryName: "Transfer fee", amount: -0.00002 },
          { categoryName: "Network fee", amount: -0.00000499 },
        ],
      }),
    ).rejects.toThrow(/not assigned/);
  });

  it.each([
    ["not found", () => null, 404],
    ["pending", () => request({ status: "pending", claimedBy: null }), 409],
    ["claimed by another agent", () => request({ claimedBy: "agent-2" }), 409],
    ["already proposed", () => request({ status: "proposed" }), 409],
    ["dismissed", () => request({ status: "rejected", claimedBy: null }), 409],
  ])(
    "refuses a request that is %s, before building or storing",
    async (_n, make, status) => {
      const { service, requests, prep } = setup();
      requests.getForUser.mockResolvedValue(make());

      await expect(
        service.submit(USER, "agent-1", REQ, { description: "x" }),
      ).rejects.toMatchObject({ status });

      expect(prep.prepareUpdate).not.toHaveBeenCalled();
      expect(requests.submitProposal).not.toHaveBeenCalled();
    },
  );

  it("refuses when the claim is lost between the check and the conditional update", async () => {
    const { service, requests } = setup();
    requests.submitProposal.mockResolvedValue(null);
    await expect(
      service.submit(USER, "agent-1", REQ, { description: "x" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a proposal with no change, and splits together with a category", async () => {
    const { service, requests } = setup();
    await expect(
      service.submit(USER, "agent-1", REQ, {}),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.submit(USER, "agent-1", REQ, {
        splits: lines,
        categoryName: "Books",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it("refuses a transfer", async () => {
    const { service, requests, transactions } = setup();
    transactions.findOne.mockResolvedValue({
      id: TX,
      amount: -50,
      isTransfer: true,
    });
    await expect(
      service.submit(USER, "agent-1", REQ, { description: "x" }),
    ).rejects.toThrow(/transfer cannot be reviewed/);
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it("passes a preparation refusal (unknown category) through unchanged", async () => {
    const { service, requests, prep } = setup();
    prep.prepareUpdate.mockRejectedValue(new Error("Unknown category: Nope"));
    await expect(
      service.submit(USER, "agent-1", REQ, { categoryName: "Nope" }),
    ).rejects.toThrow("Unknown category: Nope");
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });
});

describe("AiReviewWorkService.reject", () => {
  it("returns a request to the queue by default", async () => {
    const { service, requests } = setup();
    requests.release.mockResolvedValue(
      request({ status: "pending", claimedBy: null }),
    );

    const released = await service.reject(
      USER,
      "agent-1",
      REQ,
      "no order id",
      false,
    );

    expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
      final: false,
      note: "no order id",
    });
    expect(released.status).toBe("pending");
  });

  it("closes a request that cannot be done", async () => {
    const { service, requests } = setup();
    requests.release.mockResolvedValue(
      request({ status: "rejected", claimedBy: null }),
    );
    await service.reject(USER, "agent-1", REQ, "not an order", true);
    expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
      final: true,
      note: "not an order",
    });
  });

  it("refuses an agent that does not hold the claim, releasing nothing", async () => {
    const { service, requests } = setup();
    await expect(
      service.reject(USER, "agent-2", REQ, "x", false),
    ).rejects.toMatchObject({ status: 409 });
    expect(requests.release).not.toHaveBeenCalled();
  });

  it("keys the assistant on its own claim key", () => {
    expect(ASSISTANT_CLAIM_KEY).toBe("assistant");
  });
});

describe("AiReviewWorkService inbox", () => {
  const tx = {
    id: TX,
    transactionDate: "2026-09-01",
    amount: "-50.0000",
    currencyCode: "PLN",
    payeeName: "ALLEGRO",
    description: null,
    accountId: "acc-1",
    account: { name: "Checking" },
    category: null,
    isSplit: false,
  };

  it("lists newest first with a transaction summary and the rule's name", async () => {
    const { service, requests, txRepo, ruleRepo } = setup();
    requests.listForUser.mockResolvedValue([
      request({ status: "pending", claimedBy: null }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    ruleRepo.find.mockResolvedValue([{ id: RULE, name: "Allegro" }]);

    const items = await service.listInbox(USER);

    expect(requests.listForUser).toHaveBeenCalledWith(USER, {
      statuses: ["pending", "claimed", "proposed", "expired"],
      limit: 50,
      order: "DESC",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: REQ,
      ruleName: "Allegro",
      transaction: {
        id: TX,
        date: "2026-09-01",
        amount: -50,
        accountName: "Checking",
        payeeName: "ALLEGRO",
      },
    });
    expect(items[0].proposal).toBeUndefined();
    expect(items[0]).not.toHaveProperty("claimedBy");
  });

  it("shows the sender and subject of an email receipt request, never its text", async () => {
    const { service, requests, txRepo, receiptRepo } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "pending",
        claimedBy: null,
        kind: "email_receipt",
        ruleId: null,
        emailReceiptId: RECEIPT,
      }),
      request({ id: "other", status: "pending", claimedBy: null }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    receiptRepo.find.mockResolvedValue([
      Object.assign(new EmailReceipt(), {
        id: RECEIPT,
        fromAddress: "orders@shop.example.com",
        forwardedBy: null,
        subject: "Your order #123",
        receivedAt: new Date("2026-09-29T07:30:00Z"),
      }),
    ]);

    const items = await service.listInbox(USER);

    expect(items[0]).toMatchObject({
      kind: "email_receipt",
      ruleName: null,
      emailReceipt: {
        id: RECEIPT,
        fromAddress: "orders@shop.example.com",
        forwardedBy: null,
        subject: "Your order #123",
        receivedAt: "2026-09-29T07:30:00.000Z",
      },
    });
    expect(items[0].emailReceipt).not.toHaveProperty("bodyText");
    expect(items[0].emailReceipt).not.toHaveProperty("text");
    expect(items[1].emailReceipt).toBeNull();
    const where = receiptRepo.find.mock.calls[0][0];
    expect(where.where.userId).toBe(USER);
    expect(where.select).toEqual({
      id: true,
      fromAddress: true,
      forwardedBy: true,
      subject: true,
      receivedAt: true,
    });
  });

  it("names who forwarded an email, since the sender it is read as is a claim of its text (A26-H02)", async () => {
    const { service, requests, txRepo, receiptRepo } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        kind: "email_trade",
        ruleId: null,
        transactionId: null,
        emailReceiptId: RECEIPT,
      }),
    ]);
    txRepo.find.mockResolvedValue([]);
    receiptRepo.find.mockResolvedValue([
      Object.assign(new EmailReceipt(), {
        id: RECEIPT,
        fromAddress: "notifications@broker.example.com",
        forwardedBy: "receipts@example.com",
        subject: "Your order has been filled",
        receivedAt: new Date("2026-09-29T07:30:00Z"),
      }),
    ]);

    const [item] = await service.listInbox(USER);

    expect(item.emailReceipt).toMatchObject({
      fromAddress: "notifications@broker.example.com",
      forwardedBy: "receipts@example.com",
    });
  });

  it("reads no emails when no request names one, and shows null for one that was deleted", async () => {
    const { service, requests, txRepo, receiptRepo } = setup();
    requests.listForUser.mockResolvedValue([request({ status: "pending" })]);
    txRepo.find.mockResolvedValue([tx]);
    const plain = await service.listInbox(USER);
    expect(receiptRepo.find).not.toHaveBeenCalled();
    expect(plain[0].emailReceipt).toBeNull();

    requests.listForUser.mockResolvedValue([
      request({ kind: "email_receipt", ruleId: null, emailReceiptId: RECEIPT }),
    ]);
    const gone = await service.listInbox(USER);
    expect(gone[0].emailReceipt).toBeNull();
  });

  it("names a receipt request's fixed instruction so the inbox can translate it, never a rule's own words", async () => {
    const { service, requests, txRepo } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        kind: "email_receipt",
        ruleId: null,
        instruction: RECEIPT_PARSED_INSTRUCTION,
      }),
      request({
        id: "unknown",
        kind: "email_receipt",
        ruleId: null,
        instruction: "An older wording",
      }),
      // A rule's instruction that happens to equal the fixed text is still its own words.
      request({ id: "rule", instruction: RECEIPT_PARSED_INSTRUCTION }),
    ]);
    txRepo.find.mockResolvedValue([tx]);

    const items = await service.listInbox(USER);

    expect(items.map((item) => item.instructionKey)).toEqual([
      "parsed",
      null,
      null,
    ]);
  });

  describe("a parser draft request", () => {
    const draft = (over: Partial<AiReviewRequest> = {}) =>
      request({
        kind: "email_parser_draft",
        transactionId: null,
        ruleId: null,
        emailReceiptId: null,
        emailReceiptIds: ["r1", "r2", "r3"],
        parserDomain: "shop.example.com",
        status: "pending",
        claimedBy: null,
        ...over,
      });

    it("shows the domain and how many emails, with no transaction, and reads no transaction", async () => {
      const { service, requests, txRepo, receiptRepo } = setup();
      requests.listForUser.mockResolvedValue([draft()]);

      const [item] = await service.listInbox(USER);

      expect(item).toMatchObject({
        id: REQ,
        kind: "email_parser_draft",
        transactionId: null,
        transaction: null,
        emailReceipt: null,
        ruleName: null,
        parserDraft: {
          domain: "shop.example.com",
          emailCount: 3,
          parserId: null,
          parserIds: [],
        },
      });
      expect(txRepo.find).not.toHaveBeenCalled();
      expect(receiptRepo.find).not.toHaveBeenCalled();
    });

    it("names the parser an agent saved once the request is proposed, and builds no card", async () => {
      const { service, requests, builder } = setup();
      requests.listForUser.mockResolvedValue([
        draft({
          status: "proposed",
          claimedBy: "assistant",
          proposal: { parserId: "p1", proposedAt: "2026-10-03T10:00:00Z" },
        }),
      ]);

      const [item] = await service.listInbox(USER);

      expect(item.parserDraft?.parserId).toBe("p1");
      expect(item.parserDraft?.parserIds).toEqual(["p1"]);
      expect(item.proposal).toBeUndefined();
      expect(builder.buildUpdateTransaction).not.toHaveBeenCalled();
    });

    it("lists every parser a multi-sender request holds, in save order, with the first as parserId", async () => {
      const { service, requests } = setup();
      requests.listForUser.mockResolvedValue([
        draft({
          status: "proposed",
          claimedBy: "assistant",
          proposal: {
            parserId: "p1",
            parserIds: ["p1", "p2", "p3"],
            proposedAt: "2026-10-03T10:00:00Z",
          },
        }),
      ]);

      const [item] = await service.listInbox(USER);

      expect(item.parserDraft?.parserId).toBe("p1");
      expect(item.parserDraft?.parserIds).toEqual(["p1", "p2", "p3"]);
    });

    it("lists it beside ordinary requests without crashing, each with its own shape", async () => {
      const { service, requests, txRepo } = setup();
      requests.listForUser.mockResolvedValue([
        draft(),
        request({ id: "other", status: "pending", claimedBy: null }),
      ]);
      txRepo.find.mockResolvedValue([
        {
          id: TX,
          transactionDate: "2026-09-01",
          amount: "-50.0000",
          currencyCode: "PLN",
          payeeName: "ALLEGRO",
          description: null,
          accountId: "acc-1",
          account: { name: "Checking" },
          category: null,
          isSplit: false,
        },
      ]);

      const items = await service.listInbox(USER);

      expect(items[0].parserDraft).not.toBeNull();
      expect(items[1].parserDraft).toBeNull();
      expect(items[1].transaction?.id).toBe(TX);
      expect(txRepo.find.mock.calls[0][0].where.id._value).toEqual([TX]);
    });

    it("can be dismissed like any other request", async () => {
      const { service, requests } = setup();
      requests.dismiss.mockResolvedValue(draft({ status: "rejected" }));

      const item = await service.dismiss(USER, REQ);

      expect(item.status).toBe("rejected");
      expect(item.parserDraft?.emailCount).toBe(3);
    });

    it("shows an expired request too", async () => {
      const { service, requests } = setup();
      requests.listForUser.mockResolvedValue([draft({ status: "expired" })]);

      const [item] = await service.listInbox(USER);

      expect(item.status).toBe("expired");
      expect(item.parserDraft?.domain).toBe("shop.example.com");
    });
  });

  it("rebuilds the card of a proposed request against the transaction as it is now", async () => {
    const { service, requests, txRepo, prep } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        proposal: { input: { description: "x" }, action: card("old") },
      }),
    ]);
    txRepo.find.mockResolvedValue([tx]);

    const items = await service.listInbox(USER);

    expect(prep.prepareUpdate).toHaveBeenCalled();
    expect(items[0].proposal).toEqual({ action: card() });
  });

  it("shows why a proposal can no longer be built instead of failing the list", async () => {
    const { service, requests, txRepo, transactions } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        proposal: { input: { splits: lines } },
      }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    transactions.findOne.mockResolvedValue({
      id: TX,
      amount: -80,
      isTransfer: false,
    });

    const items = await service.listInbox(USER);

    expect(items[0].proposal).toEqual({
      error: expect.stringMatching(/not assigned/),
    });
  });

  it("does not turn an internal error into a proposal's reason", async () => {
    const { service, requests, txRepo, prep } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        proposal: { input: { description: "x" } },
      }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    prep.prepareUpdate.mockRejectedValue(new Error("connection reset"));
    await expect(service.listInbox(USER)).rejects.toThrow("connection reset");
  });

  it("marks a transaction that no longer exists as null", async () => {
    const { service, requests } = setup();
    requests.listForUser.mockResolvedValue([request({ status: "pending" })]);
    const items = await service.listInbox(USER);
    expect(items[0].transaction).toBeNull();
    expect(items[0].ruleName).toBeNull();
  });

  it("returns an empty list without touching the transactions", async () => {
    const { service, txRepo } = setup();
    expect(
      await service.listInbox(USER, { status: "applied", limit: 5 }),
    ).toEqual([]);
    expect(txRepo.find).not.toHaveBeenCalled();
  });

  it("dismisses an open request and answers with its inbox entry", async () => {
    const { service, requests, txRepo } = setup();
    requests.dismiss.mockResolvedValue(
      request({ status: "rejected", claimedBy: null }),
    );
    txRepo.find.mockResolvedValue([tx]);
    const item = await service.dismiss(USER, REQ);
    expect(requests.dismiss).toHaveBeenCalledWith(USER, REQ);
    expect(item.status).toBe("rejected");
  });

  it("answers 404 for a request that is not the user's and 409 for one no longer open", async () => {
    const { service, requests } = setup();
    requests.dismiss.mockResolvedValue(null);
    requests.getForUser.mockResolvedValue(null);
    await expect(service.dismiss(USER, REQ)).rejects.toMatchObject({
      status: 404,
    });
    requests.getForUser.mockResolvedValue(request({ status: "applied" }));
    await expect(service.dismiss(USER, REQ)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("AiReviewWorkService.submit with tag names (email-receipts design 5.5)", () => {
  it("hands the tag names to the update preparation, which previews them as additions", async () => {
    const { service, requests, prep } = setup();
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));

    await service.submit(USER, "agent-1", REQ, {
      splits: lines,
      tagNames: ["Allegro"],
    });

    expect(prep.prepareUpdate).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ tagNames: ["Allegro"], splits: lines }),
    );
    expect(requests.submitProposal).toHaveBeenCalledWith(
      USER,
      REQ,
      "agent-1",
      expect.objectContaining({
        input: { splits: lines, tagNames: ["Allegro"] },
      }),
    );
  });

  it("hands a reference number to the update preparation and accepts one alone", async () => {
    const { service, requests, prep } = setup();
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));
    await expect(
      service.submit(USER, "agent-1", REQ, { referenceNumber: "EX-1" }),
    ).resolves.toBeDefined();
    expect(prep.prepareUpdate).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ referenceNumber: "EX-1" }),
    );
  });

  it("accepts a proposal that only adds a tag", async () => {
    const { service, requests } = setup();
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));
    await expect(
      service.submit(USER, "agent-1", REQ, { tagNames: ["Allegro"] }),
    ).resolves.toBeDefined();
  });

  it("still refuses a proposal with no change: an empty tag list is none", async () => {
    const { service, requests, prep } = setup();
    await expect(
      service.submit(USER, "agent-1", REQ, { tagNames: [] }),
    ).rejects.toThrow(/at least one change/);
    expect(prep.prepareUpdate).not.toHaveBeenCalled();
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it.each([
    ["too many names", ["a", "b", "c", "d", "e", "f"]],
    ["a blank name", ["  "]],
    ["a name over 50 characters", ["x".repeat(51)]],
    ["a control character", ["tag\nname"]],
    ["a non-string name", [5 as unknown as string]],
  ])(
    "refuses %s before anything is prepared or stored",
    async (_label, tagNames) => {
      const { service, requests, prep } = setup();
      await expect(
        service.submit(USER, "agent-1", REQ, { splits: lines, tagNames }),
      ).rejects.toThrow(/tags/);
      expect(prep.prepareUpdate).not.toHaveBeenCalled();
      expect(requests.submitProposal).not.toHaveBeenCalled();
    },
  );

  it("accepts five names of fifty characters", async () => {
    const { service, requests } = setup();
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));
    await expect(
      service.submit(USER, "agent-1", REQ, {
        splits: lines,
        tagNames: Array.from({ length: 5 }, (_, i) =>
          `${i}`.repeat(50).slice(0, 50),
        ),
      }),
    ).resolves.toBeDefined();
  });
});

describe("AiReviewWorkService.buildApprovalCard (bulk approval)", () => {
  const proposed = (over: Partial<AiReviewRequest> = {}) =>
    request({
      status: "proposed",
      proposal: {
        input: { splits: lines },
        action: card("stale"),
        proposedAt: "2026-09-29T09:30:00Z",
      },
      ...over,
    });

  it("rebuilds the card from the stored proposal against the transaction as it is now", async () => {
    const { service, requests, prep, builder } = setup();
    requests.getForUser.mockResolvedValue(proposed());
    builder.buildUpdateTransaction.mockReturnValue(card("fresh"));

    const result = await service.buildApprovalCard(USER, REQ);

    expect(requests.getForUser).toHaveBeenCalledWith(USER, REQ);
    expect(prep.prepareUpdate).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ transactionId: TX, splits: lines }),
    );
    expect(result).toEqual({ action: card("fresh") });
  });

  it("says a request that is not the user's is not found (another user's reads as absent)", async () => {
    const { service, requests, builder } = setup();
    requests.getForUser.mockResolvedValue(null);
    const result = await service.buildApprovalCard(USER, REQ);
    expect(result).toEqual({ error: expect.stringContaining("not found") });
    expect(builder.buildUpdateTransaction).not.toHaveBeenCalled();
  });

  it.each(["pending", "claimed", "applied", "rejected", "expired"] as const)(
    "refuses a request that is %s: only a proposed one waits for approval",
    async (status) => {
      const { service, requests, builder } = setup();
      requests.getForUser.mockResolvedValue(proposed({ status }));
      const result = await service.buildApprovalCard(USER, REQ);
      expect(result).toEqual({
        error: expect.stringContaining("no longer waiting for approval"),
      });
      expect(builder.buildUpdateTransaction).not.toHaveBeenCalled();
    },
  );

  it("refuses a proposed request whose life ran out", async () => {
    const { service, requests } = setup();
    requests.getForUser.mockResolvedValue(
      proposed({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const result = await service.buildApprovalCard(USER, REQ);
    expect(result).toEqual({
      error: expect.stringContaining("no longer waiting for approval"),
    });
  });

  it("refuses a parser draft: it has no card to approve here", async () => {
    const { service, requests } = setup();
    requests.getForUser.mockResolvedValue(
      proposed({
        kind: "email_parser_draft",
        transactionId: null,
        proposal: { parserId: "p1" },
      }),
    );
    const result = await service.buildApprovalCard(USER, REQ);
    expect(result).toEqual({
      error: expect.stringContaining("no proposal to approve"),
    });
  });

  it("returns the refusal as the reason when the transaction no longer admits the proposal", async () => {
    const { service, requests, transactions } = setup();
    requests.getForUser.mockResolvedValue(proposed());
    transactions.findOne.mockResolvedValue({
      id: TX,
      amount: -60,
      isTransfer: false,
    });
    const result = await service.buildApprovalCard(USER, REQ);
    expect(result).toEqual({
      error: expect.stringMatching(/add up to -50 but the transaction is -60/),
    });
  });

  it("lets an internal error propagate instead of showing it as a proposal's refusal", async () => {
    const { service, requests, prep } = setup();
    requests.getForUser.mockResolvedValue(proposed());
    prep.prepareUpdate.mockRejectedValue(new Error("db down"));
    await expect(service.buildApprovalCard(USER, REQ)).rejects.toThrow(
      "db down",
    );
  });
});

describe("AiReviewWorkService trade requests (email_trade)", () => {
  const ACCOUNT = "50000000-0000-4000-8000-000000000001";
  const SECURITY = "60000000-0000-4000-8000-000000000001";
  const trade = {
    accountId: ACCOUNT,
    action: "BUY" as const,
    symbol: "XCNS",
    quantity: 75.9878,
    totalAmount: 2000,
    commission: 0,
    date: "2026-10-15",
    description: "Email receipt: Your order has been filled",
  };
  const tradeRequest = (over: Partial<AiReviewRequest> = {}) =>
    request({
      kind: "email_trade",
      transactionId: null,
      ruleId: null,
      emailReceiptId: RECEIPT,
      claimedBy: "email-receipts",
      ...over,
    });
  const tradeCard = {
    actionId: "trade-1",
    type: "create_investment_transaction",
    preview: {},
    descriptor: {
      type: "create_investment_transaction",
      aiReviewRequestId: REQ,
    },
  } as never;

  function tradeSetup() {
    const h = setup();
    h.securities.resolveByTradeSymbol.mockResolvedValue({
      match: { id: SECURITY, symbol: "XCNS.TO", currencyCode: "CAD" },
      candidates: [],
    });
    h.investments.previewCreateInvestmentTransaction.mockResolvedValue({
      accountId: ACCOUNT,
    });
    h.builder.buildCreateInvestmentTransaction.mockReturnValue(tradeCard);
    return h;
  }

  it("builds a create_investment_transaction card from the executed total and the user's own security", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "email-receipts" }),
    );
    h.requests.submitProposal.mockResolvedValue(
      tradeRequest({ status: "proposed" }),
    );

    const result = await h.service.submitTrade(
      USER,
      "email-receipts",
      REQ,
      trade,
    );

    // The account decides between listings in two currencies.
    expect(h.securities.resolveByTradeSymbol).toHaveBeenCalledWith(
      USER,
      "XCNS",
      ACCOUNT,
      null,
    );
    // The resolved symbol, not the email's text, goes to the preview; the total
    // is passed as the fact and no price is supplied (INV-TRADE-001).
    expect(
      h.investments.previewCreateInvestmentTransaction,
    ).toHaveBeenCalledWith(USER, {
      accountId: ACCOUNT,
      action: "BUY",
      transactionDate: "2026-10-15",
      securityQuery: "XCNS.TO",
      quantity: 75.9878,
      totalAmount: 2000,
      commission: 0,
      description: "Email receipt: Your order has been filled",
    });
    expect(h.builder.buildCreateInvestmentTransaction).toHaveBeenCalledWith(
      USER,
      { accountId: ACCOUNT },
      { aiReviewRequestId: REQ },
    );
    expect(h.requests.submitProposal).toHaveBeenCalledWith(
      USER,
      REQ,
      "email-receipts",
      expect.objectContaining({ trade, action: tradeCard }),
    );
    expect(result.action).toBe(tradeCard);
  });

  it("marks the scheduled bill it pays on the card, looked up with the resolved security and the schedule's commission rules", async () => {
    const h = tradeSetup();
    h.investments.previewCreateInvestmentTransaction.mockResolvedValue({
      accountId: ACCOUNT,
      securityId: SECURITY,
      action: "BUY",
    });
    h.scheduled.findInvestmentOccurrenceForTrade.mockResolvedValue({
      id: "sch-1",
      name: "Monthly XCNS",
      dueDate: "2026-10-16",
      fundingAccountId: "chequing-1",
    });
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "email-receipts" }),
    );
    h.requests.submitProposal.mockResolvedValue(
      tradeRequest({ status: "proposed" }),
    );
    await h.service.submitTrade(USER, "email-receipts", REQ, trade);
    // Posting the occurrence settles through the schedule's funding account, so
    // the card is previewed with it: what it shows is what is written.
    expect(
      h.investments.previewCreateInvestmentTransaction,
    ).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ fundingAccountId: "chequing-1" }),
    );
    expect(h.scheduled.findInvestmentOccurrenceForTrade).toHaveBeenCalledWith(
      USER,
      {
        accountId: ACCOUNT,
        securityId: SECURITY,
        action: "BUY",
        date: "2026-10-15",
        commission: 0,
      },
    );
    expect(h.builder.buildCreateInvestmentTransaction).toHaveBeenCalledWith(
      USER,
      expect.anything(),
      {
        aiReviewRequestId: REQ,
        scheduled: {
          id: "sch-1",
          name: "Monthly XCNS",
          dueDate: "2026-10-16",
        },
      },
    );
  });

  it("refuses a trade the ledger already holds on a row no other email accounts for, storing nothing", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "email-receipts" }),
    );
    h.manager.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM investment_transactions")
        ? [{ id: "it-1", claimed: false }]
        : [],
    );
    await expect(
      h.service.submitTrade(USER, "email-receipts", REQ, trade),
    ).rejects.toBeInstanceOf(ConflictException);
    const ledger = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM investment_transactions"),
    );
    // By the resolved security, and this email's own row is not "another's".
    expect(ledger?.[1]).toEqual(
      expect.arrayContaining([SECURITY, RECEIPT, ACCOUNT, "2026-10-15"]),
    );
    expect(h.requests.submitProposal).not.toHaveBeenCalled();
  });

  it("refuses an email whose amounts name another currency than the security's", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "email-receipts" }),
    );
    await expect(
      h.service.submitTrade(USER, "email-receipts", REQ, {
        ...trade,
        currency: "USD",
      }),
    ).rejects.toThrow(/in USD, but your security XCNS\.TO trades in CAD/);
    expect(
      h.investments.previewCreateInvestmentTransaction,
    ).not.toHaveBeenCalled();
  });

  it("has no approvable card once the scheduled occurrence the proposal paid was posted", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({
        status: "proposed",
        proposal: {
          trade,
          action: {
            descriptor: {
              type: "create_investment_transaction",
              scheduledTransactionId: "sch-1",
              scheduledDueDate: "2026-10-16",
            },
          },
        },
      }),
    );
    // The schedule moved on: the rebuild finds no occurrence.
    h.scheduled.findInvestmentOccurrenceForTrade.mockResolvedValue(null);
    const out = await h.service.buildApprovalCard(USER, REQ);
    expect(out).toEqual({
      error: expect.stringMatching(/has been posted or changed/),
    });
  });

  it("refuses a ticker that is none of the user's securities, storing nothing", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "email-receipts" }),
    );
    h.securities.resolveByTradeSymbol.mockResolvedValue({
      match: null,
      candidates: [],
    });
    await expect(
      h.service.submitTrade(USER, "email-receipts", REQ, trade),
    ).rejects.toThrow(/no security with the ticker "XCNS"/);
    expect(h.requests.submitProposal).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous ticker, naming the candidates", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "email-receipts" }),
    );
    h.securities.resolveByTradeSymbol.mockResolvedValue({
      match: null,
      candidates: [{ symbol: "XCNS.TO" }, { symbol: "XCNS.V" }],
    });
    await expect(
      h.service.submitTrade(USER, "email-receipts", REQ, trade),
    ).rejects.toThrow(/XCNS\.TO, XCNS\.V/);
  });

  it("answers only a request of its own kind", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      request({ claimedBy: "email-receipts" }),
    );
    await expect(
      h.service.submitTrade(USER, "email-receipts", REQ, trade),
    ).rejects.toThrow(/not a trade request/);
  });

  describe("answered by an agent (Recognize as a trade)", () => {
    const agentTrade = {
      accountName: "RRSP",
      action: "BUY" as const,
      symbol: "XCNS",
      quantity: 75.9878,
      totalAmount: 2000,
      date: "2026-10-15",
    };

    it("finds the account by name and stores the same card a profile's trade gets", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      const result = await h.service.submit(USER, "agent-1", REQ, {
        trade: agentTrade,
      });
      expect(h.accounts.resolveBrokerageByNameOrId).toHaveBeenCalledWith(
        USER,
        "RRSP",
      );
      expect(
        h.investments.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          accountId: ACCOUNT,
          totalAmount: 2000,
          commission: 0,
          transactionDate: "2026-10-15",
        }),
      );
      expect(result.action).toBe(tradeCard);
    });

    it("keeps the agent's description and checks the currency it read against the security's", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      await h.service.submit(USER, "agent-1", REQ, {
        trade: { ...agentTrade, currency: "cad", description: "XCNS buy" },
      });
      expect(h.securities.resolveByTradeSymbol).toHaveBeenCalledWith(
        USER,
        "XCNS",
        ACCOUNT,
        "CAD",
      );
      expect(
        h.investments.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ description: "XCNS buy" }),
      );

      h.requests.submitProposal.mockClear();
      await expect(
        h.service.submit(USER, "agent-1", REQ, {
          trade: { ...agentTrade, currency: "USD" },
        }),
      ).rejects.toThrow(/amounts are in USD/);
      expect(h.requests.submitProposal).not.toHaveBeenCalled();
    });

    it("dates the trade by the email when the agent gives no date", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1", emailReceiptId: RECEIPT }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      h.receiptRepo.findOne.mockResolvedValue({
        receivedAt: new Date("2026-10-16T09:00:00Z"),
        originalSentAt: new Date("2026-10-15T12:00:00Z"),
      });
      await h.service.submit(USER, "agent-1", REQ, {
        trade: { ...agentTrade, date: undefined },
      });
      expect(
        h.investments.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ transactionDate: "2026-10-15" }),
      );
    });

    it("refuses an unknown or ambiguous account, storing nothing", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: undefined,
        candidates: [],
      });
      await expect(
        h.service.submit(USER, "agent-1", REQ, { trade: agentTrade }),
      ).rejects.toThrow(/Unknown account/);
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: undefined,
        candidates: [
          { id: "a", name: "RRSP 1" },
          { id: "b", name: "RRSP 2" },
        ],
      });
      await expect(
        h.service.submit(USER, "agent-1", REQ, { trade: agentTrade }),
      ).rejects.toThrow(/RRSP 1, RRSP 2/);
      expect(h.requests.submitProposal).not.toHaveBeenCalled();
    });

    it("refuses a trade that does not have the required shape, storing nothing", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      for (const bad of [
        { ...agentTrade, action: "HOLD" },
        { ...agentTrade, quantity: -1 },
        { ...agentTrade, date: "15/10/2026" },
        // Not a calendar day, and finer than the confirm stores: refused
        // before a card the approval would then refuse.
        { ...agentTrade, date: "2026-02-31" },
        { ...agentTrade, quantity: 1.123456789 },
        { ...agentTrade, totalAmount: 2000.00001 },
        { accountName: "RRSP" },
        // Only a cash dividend may leave the shares out.
        { ...agentTrade, quantity: undefined },
        { ...agentTrade, action: "REINVEST", quantity: null },
      ]) {
        await expect(
          h.service.submit(USER, "agent-1", REQ, { trade: bad }),
        ).rejects.toThrow(
          /accountName, action \(BUY, SELL, DIVIDEND or REINVEST\)/,
        );
      }
      expect(h.accounts.resolveBrokerageByNameOrId).not.toHaveBeenCalled();
      expect(h.requests.submitProposal).not.toHaveBeenCalled();
    });

    it("reads numbers a hand-written tool call sends as text", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      await h.service.submit(USER, "agent-1", REQ, {
        trade: { ...agentTrade, quantity: "75.9878", totalAmount: "2000" },
      });
      expect(
        h.investments.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ quantity: 75.9878, totalAmount: 2000 }),
      );
    });

    it("previews an agent's cash dividend without shares, as a DIVIDEND", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      await h.service.submit(USER, "agent-1", REQ, {
        trade: {
          ...agentTrade,
          action: "DIVIDEND",
          quantity: null,
          totalAmount: 12.34,
        },
      });
      expect(
        h.investments.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          action: "DIVIDEND",
          quantity: undefined,
          totalAmount: 12.34,
        }),
      );
    });

    it("previews a reinvestment at the price its total implies, as its row carries no cash total", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      await h.service.submit(USER, "agent-1", REQ, {
        trade: {
          ...agentTrade,
          action: "REINVEST",
          quantity: 0.5,
          totalAmount: 12.34,
          commission: 0.34,
        },
      });
      const [, input] =
        h.investments.previewCreateInvestmentTransaction.mock.calls[0];
      expect(input).toMatchObject({
        action: "REINVEST",
        quantity: 0.5,
        price: 24,
        commission: 0.34,
      });
      expect(input.totalAmount).toBeUndefined();
    });

    it("takes an agent's 0 shares of a cash dividend as none", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1" }),
      );
      h.requests.submitProposal.mockResolvedValue(
        tradeRequest({ status: "proposed" }),
      );
      h.accounts.resolveBrokerageByNameOrId.mockResolvedValue({
        match: { id: ACCOUNT, name: "RRSP", currencyCode: "CAD" },
        candidates: [],
      });
      await h.service.submit(USER, "agent-1", REQ, {
        trade: {
          ...agentTrade,
          action: "DIVIDEND",
          quantity: 0,
          totalAmount: 5,
        },
      });
      const [, input] =
        h.investments.previewCreateInvestmentTransaction.mock.calls[0];
      expect(input.quantity).toBeUndefined();
      expect(input.totalAmount).toBe(5);
    });

    it("refuses the trade field on an ordinary request", async () => {
      const h = tradeSetup();
      h.requests.getForUser.mockResolvedValue(request());
      await expect(
        h.service.submit(USER, "agent-1", REQ, { trade: agentTrade }),
      ).rejects.toThrow(/trade request only/);
    });

    it("claims a trade request with the email and no transaction", async () => {
      const h = tradeSetup();
      h.requests.claimById.mockResolvedValue(
        tradeRequest({ claimedBy: "agent-1", emailReceiptId: RECEIPT }),
      );
      h.receiptRepo.findOne.mockResolvedValue({
        fromAddress: "a@b.example",
        subject: "Your order has been filled",
        receivedAt: new Date("2026-10-15T16:00:00Z"),
        bodyText: "Symbol: XCNS",
      });
      const claimed = await h.service.claim(USER, "agent-1", REQ);
      expect(claimed.transaction).toBeUndefined();
      expect(claimed.emailReceipt?.subject).toBe("Your order has been filled");
      expect(h.transactions.getLlmTransactionById).not.toHaveBeenCalled();
    });
  });

  it("refuses a submit with no trade field for this kind", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ claimedBy: "agent-1" }),
    );
    await expect(
      h.service.submit(USER, "agent-1", REQ, { description: "x" }),
    ).rejects.toThrow(/answered with the trade field/);
  });

  it("shows the trade in the inbox and rebuilds its card from the stored trade", async () => {
    const h = tradeSetup();
    h.requests.listForUser.mockResolvedValue([
      tradeRequest({
        status: "proposed",
        proposal: { trade, action: "stale" },
      }),
    ]);
    const [item] = await h.service.listInbox(USER);
    expect(item).toMatchObject({
      kind: "email_trade",
      transactionId: null,
      transaction: null,
      trade,
      proposal: { action: tradeCard },
    });
    expect(h.prep.prepareUpdate).not.toHaveBeenCalled();
  });

  it("shows why the card can no longer be built (the account was closed) instead of failing the list", async () => {
    const h = tradeSetup();
    h.requests.listForUser.mockResolvedValue([
      tradeRequest({ status: "proposed", proposal: { trade } }),
    ]);
    h.investments.previewCreateInvestmentTransaction.mockRejectedValue(
      new NotFoundException("Account not found"),
    );
    const [item] = await h.service.listInbox(USER);
    expect(item.proposal).toEqual({ error: "Account not found" });
  });

  it("does not turn an internal error into a proposal's reason", async () => {
    const h = tradeSetup();
    h.requests.listForUser.mockResolvedValue([
      tradeRequest({ status: "proposed", proposal: { trade } }),
    ]);
    h.investments.previewCreateInvestmentTransaction.mockRejectedValue(
      new Error("connection reset"),
    );
    await expect(h.service.listInbox(USER)).rejects.toThrow("connection reset");
  });

  it("rebuilds the card for an approval from the stored trade, and refuses a request with none", async () => {
    const h = tradeSetup();
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ status: "proposed", proposal: { trade } }),
    );
    expect(await h.service.buildApprovalCard(USER, REQ)).toEqual({
      action: tradeCard,
    });
    h.requests.getForUser.mockResolvedValue(
      tradeRequest({ status: "proposed", proposal: null }),
    );
    expect(await h.service.buildApprovalCard(USER, REQ)).toEqual({
      error: expect.stringMatching(/no proposal to approve/),
    });
  });
});
