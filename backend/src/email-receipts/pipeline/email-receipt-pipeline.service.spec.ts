import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PendingAiAction } from "../../ai/actions/ai-action.types";
import type { AiActionsService } from "../../ai/actions/ai-actions.service";
import { AiReviewRequest } from "../../ai-review/ai-review-request.entity";
import type { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import type { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import type { AiReviewSubmitResult } from "../../ai-review/ai-review-work.types";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import {
  autoApplyAllowed,
  describeFailure,
  EmailReceiptPipelineService,
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CHAT_INSTRUCTION,
  type AutoApplyFacts,
  type ProcessReceiptOptions,
} from "./email-receipt-pipeline.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const RECEIPT = "receipt-1";
const TX = "tx-1";
const PAYEE = "payee-1";
const CAT_BOOKS = "11111111-1111-4111-8111-111111111111";
const CAT_SHIPPING = "22222222-2222-4222-8222-222222222222";

const DEFINITION = {
  version: 1,
  orderId: ["Order number: {orderid}"],
  total: ["Order total: {amount}"],
  shipping: ["Shipping: {amount}"],
  items: {
    startAfter: "Items",
    stopAt: "Subtotal",
    patterns: ["{name} {amount}"],
  },
  defaultCategoryId: CAT_BOOKS,
  shippingCategoryId: CAT_SHIPPING,
};

/** Items 12.00 plus shipping 3.00 is the total 15.00: a complete parse. */
const BODY = [
  "Order number: ABCD1234",
  "Items",
  "Widget 12.00",
  "Subtotal 12.00",
  "Shipping: 3.00",
  "Order total: 15.00",
].join("\n");

const receiptRow = (over: Partial<EmailReceipt> = {}): EmailReceipt =>
  Object.assign(new EmailReceipt(), {
    id: RECEIPT,
    userId: USER,
    mailboxId: "mb-1",
    fromAddress: "orders@shop.example.com",
    fromDomain: "shop.example.com",
    subject: "Your order ABCD1234",
    receivedAt: new Date("2026-09-10T10:00:00Z"),
    bodyText: BODY,
    status: "pending",
    statusReason: null,
    parserId: null,
    parsed: null,
    transactionId: null,
    candidateTransactionIds: [],
    matchKind: null,
    aiReviewRequestId: null,
    ...over,
  });

const parserRow = (
  over: Partial<EmailReceiptParser> = {},
): EmailReceiptParser =>
  Object.assign(new EmailReceiptParser(), {
    id: "parser-1",
    userId: USER,
    name: "Shop",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition: DEFINITION,
    status: "approved",
    source: "manual",
    revision: 1,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  });

const mailboxRow = (over: Partial<EmailReceiptMailbox> = {}) =>
  Object.assign(new EmailReceiptMailbox(), {
    id: "mb-1",
    userId: USER,
    aiMode: "off",
    autoApply: false,
    ...over,
  });

const candidate = (over: Record<string, unknown> = {}) => ({
  id: TX,
  transaction_date: "2026-09-11",
  amount: "-15.0000",
  payee_id: null,
  payee_name: null,
  description: "CARD PURCHASE ORDER ABCD1234",
  reference_number: null,
  ...over,
});

const action: PendingAiAction = {
  actionId: "action-1",
  type: "update_transaction",
  preview: {} as PendingAiAction["preview"],
  descriptor: { type: "update_transaction" } as PendingAiAction["descriptor"],
  signature: "sig-1",
  expiresAt: 1_900_000_000_000,
};

const submitted = (): AiReviewSubmitResult => ({
  request: {} as AiReviewSubmitResult["request"],
  action,
});

const request = (id = "rq-1"): AiReviewRequest =>
  Object.assign(new AiReviewRequest(), { id });

interface World {
  receipt: EmailReceipt | null;
  mailbox: EmailReceiptMailbox;
  parsers: EmailReceiptParser[];
  payee: Partial<Payee> | null;
  candidates: Array<Record<string, unknown>>;
  linkRow: Record<string, unknown> | null;
  requestStatus: string | null;
}

function setup(over: Partial<World> = {}) {
  const world: World = {
    receipt: receiptRow(),
    mailbox: mailboxRow(),
    parsers: [parserRow()],
    payee: null,
    candidates: [candidate()],
    linkRow: null,
    requestStatus: null,
    ...over,
  };
  const receiptRepo = {
    findOne: jest.fn(async () => world.receipt),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mailboxRepo = { findOne: jest.fn(async () => world.mailbox) };
  const parserRepo = { find: jest.fn(async () => world.parsers) };
  const payeeRepo = { findOne: jest.fn(async () => world.payee) };
  const categoryRepo = {
    find: jest.fn(async () => [
      { id: CAT_BOOKS, name: "Books", parentId: null },
      { id: CAT_SHIPPING, name: "Shipping", parentId: null },
    ]),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
    [EmailReceiptMailbox, mailboxRepo],
    [EmailReceiptParser, parserRepo],
    [Payee, payeeRepo],
    [Category, categoryRepo],
  ]);
  const order: string[] = [];
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("pg_advisory_xact_lock")) {
      order.push("advisory");
      return [];
    }
    if (text.includes("SET status = 'rejected'")) {
      order.push("close");
      return [[], 0];
    }
    if (text.includes("SELECT status FROM ai_review_requests")) {
      return world.requestStatus === null
        ? []
        : [{ status: world.requestStatus }];
    }
    if (text.includes("JOIN accounts a")) return world.candidates;
    if (text.includes("WHERE t.id = $1")) {
      return world.linkRow === null ? [] : [world.linkRow];
    }
    return [];
  });

  const requests = {
    enqueueClaimed: jest.fn(async () => {
      order.push("enqueue");
      return request() as AiReviewRequest | null;
    }),
    enqueuePendingForReceipt: jest.fn(async () => {
      order.push("enqueuePending");
      return request("rq-ai") as AiReviewRequest | null;
    }),
    release: jest.fn(async () => null),
  } as unknown as jest.Mocked<AiReviewRequestsService>;
  const work = {
    submit: jest.fn(async () => submitted()),
  } as unknown as jest.Mocked<AiReviewWorkService>;
  const actions = {
    confirm: jest.fn(async () => ({ type: "update_transaction", id: TX })),
  } as unknown as jest.Mocked<AiActionsService>;

  const service = new EmailReceiptPipelineService(
    dataSource as never,
    requests,
    work,
    actions,
  );
  return {
    service,
    world,
    manager,
    receiptRepo,
    requests,
    work,
    actions,
    order,
    lastUpdate: () =>
      receiptRepo.update.mock.calls[receiptRepo.update.mock.calls.length - 1],
  };
}

const run = (
  h: ReturnType<typeof setup>,
  options: ProcessReceiptOptions = {},
) => h.service.process(USER, RECEIPT, options);

describe("EmailReceiptPipelineService.process", () => {
  describe("the row and who may touch it", () => {
    it("locks the receipt row first and is a 404 for an email that is not the user's", async () => {
      const h = setup({ receipt: null });
      await expect(run(h)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.receiptRepo.findOne).toHaveBeenCalledWith({
        where: { id: RECEIPT, userId: USER },
        lock: { mode: "pessimistic_write" },
      });
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("leaves a row alone when a person's command changed its status since the poll chose it", async () => {
      const h = setup({ receipt: receiptRow({ status: "ignored" }) });
      const result = await run(h, { onlyWhenStatusIn: ["pending"] });
      expect(result).toMatchObject({ status: "ignored", unchanged: true });
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("refuses a skipped email with a 409 and writes nothing", async () => {
      const h = setup({ receipt: receiptRow({ status: "skipped" }) });
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("refuses to reprocess or link an email whose proposal was applied, and writes nothing", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "applied",
      });
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
      await expect(
        run(h, { link: { transactionId: TX } }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
      expect(h.order).not.toContain("close");
    });

    it("the poll leaves an applied email alone instead of failing", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "applied",
      });
      const result = await run(h, { onlyWhenStatusIn: ["review"] });
      expect(result.unchanged).toBe(true);
    });

    it("refuses to link an ignored email, but reprocess brings it back", async () => {
      const h = setup({ receipt: receiptRow({ status: "ignored" }) });
      await expect(
        run(h, { link: { transactionId: TX } }),
      ).rejects.toBeInstanceOf(ConflictException);
      const result = await run(h);
      expect(result.status).toBe("review");
    });
  });

  describe("no_parser and parse_failed", () => {
    it("no approved parser for the sender is no_parser, with everything else cleared", async () => {
      const h = setup({
        parsers: [parserRow({ fromDomains: ["other.example.org"] })],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "no_parser",
        transactionId: null,
        requestId: null,
      });
      expect(h.lastUpdate()).toEqual([
        { id: RECEIPT, userId: USER },
        {
          status: "no_parser",
          statusReason: null,
          parserId: null,
          parsed: null,
          transactionId: null,
          candidateTransactionIds: [],
          matchKind: null,
          aiReviewRequestId: null,
        },
      ]);
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("loads only approved parsers, for the user", async () => {
      const h = setup();
      await run(h);
      const repo = h.manager.getRepository.mock.results.find(
        (r) => r.value.find && !r.value.update,
      )?.value;
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, status: "approved" },
        }),
      );
    });

    it("a parser whose definition is invalid (a restored {}) is parse_failed parser_invalid", async () => {
      const h = setup({ parsers: [parserRow({ definition: {} })] });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "parser_invalid",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parserId: "parser-1",
        parsed: null,
      });
    });

    it("no total and no order id is parse_failed with the parser's reason, keeping what was read", async () => {
      const h = setup({
        receipt: receiptRow({ bodyText: "hello\nnothing here" }),
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "no_total",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parserId: "parser-1",
        parsed: expect.objectContaining({ total: null, orderId: null }),
      });
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("an order id alone is enough to go on matching", async () => {
      const h = setup({
        receipt: receiptRow({ bodyText: "Order number: ABCD1234" }),
      });
      const result = await run(h);
      expect(result.status).toBe("review");
      expect(result.matchKind).toBe("order_id");
    });
  });

  describe("matching", () => {
    it("loads the candidates in one query and says unmatched when none fit", async () => {
      const h = setup({ candidates: [] });
      const result = await run(h);
      expect(result.status).toBe("unmatched");
      const candidateQueries = h.manager.query.mock.calls.filter((c) =>
        String(c[0]).includes("JOIN accounts a"),
      );
      expect(candidateQueries).toHaveLength(1);
      const [sql, params] = candidateQueries[0];
      expect(sql).toContain("is_transfer = false");
      expect(sql).toContain("!= 'VOID'");
      expect(sql).toContain("investment_transactions");
      expect(sql).toContain("applied.status = 'applied'");
      expect(sql).toContain("open_request.rule_id IS NULL");
      expect(params).toEqual([USER, "2026-09-07", "2026-09-24", RECEIPT, 200]);
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "unmatched",
        transactionId: null,
        candidateTransactionIds: [],
        parsed: expect.objectContaining({ total: 150000 }),
      });
    });

    it("two candidates with the same amount and no order id are ambiguous, and their ids are stored", async () => {
      const h = setup({
        receipt: receiptRow({
          bodyText: "Order total: 15.00",
        }),
        candidates: [
          candidate({ id: "tx-b", description: "A" }),
          candidate({ id: "tx-a", description: "B" }),
        ],
      });
      const result = await run(h);
      expect(result.status).toBe("ambiguous");
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "ambiguous",
        transactionId: null,
        candidateTransactionIds: ["tx-a", "tx-b"],
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("stores the parse with every outcome that got that far", async () => {
      const h = setup({ candidates: [] });
      await run(h);
      expect(h.lastUpdate()?.[1].parsed).toMatchObject({
        orderId: "ABCD1234",
        complete: true,
      });
    });
  });

  describe("proposing", () => {
    it("a match is proposed through the queue and stored as review, all in one transaction", async () => {
      const h = setup();
      const result = await run(h);

      expect(result).toMatchObject({
        status: "review",
        transactionId: TX,
        matchKind: "order_id",
        requestId: "rq-1",
        autoApplied: false,
        unchanged: false,
      });
      expect(h.requests.enqueueClaimed).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        {
          transactionId: TX,
          kind: "email_receipt",
          emailReceiptId: RECEIPT,
          instruction: expect.any(String),
          claimedBy: "email-receipts",
        },
      );
      expect(h.work.submit).toHaveBeenCalledTimes(1);
      const [userArg, claimKey, requestId, input] = h.work.submit.mock.calls[0];
      expect([userArg, claimKey, requestId]).toEqual([
        USER,
        "email-receipts",
        "rq-1",
      ]);
      expect(input.splits).toEqual([
        { categoryName: "Books", amount: -12, memo: "Widget" },
        { categoryName: "Shipping", amount: -3 },
      ]);
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "review",
        statusReason: null,
        parserId: "parser-1",
        transactionId: TX,
        matchKind: "order_id",
        aiReviewRequestId: "rq-1",
      });
      // one transaction for every read and write
      expect(h.manager.query).toBeDefined();
    });

    it("opens one scoped transaction for the whole decision and never a second", async () => {
      const h = setup();
      const { withScopedDb } = jest.requireMock("../../common/db/scoped-db");
      withScopedDb.mockClear();
      await run(h);
      expect(withScopedDb).toHaveBeenCalledTimes(1);
    });

    it("takes the advisory lock and closes the receipt's own open requests before enqueueing", async () => {
      const h = setup();
      await run(h);
      expect(h.order).toEqual(["advisory", "close", "enqueue"]);
    });

    it("takes the receipt row lock before the advisory lock", async () => {
      const h = setup();
      await run(h);
      expect(h.receiptRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        h.manager.query.mock.invocationCallOrder[
          h.manager.query.mock.calls.findIndex((c) =>
            String(c[0]).includes("pg_advisory_xact_lock"),
          )
        ],
      );
    });

    it("an open request somebody else raised for the transaction is review_conflict", async () => {
      const h = setup();
      h.requests.enqueueClaimed.mockResolvedValue(null);
      const result = await run(h);
      expect(result).toMatchObject({
        status: "review_conflict",
        transactionId: TX,
        requestId: null,
      });
      expect(h.work.submit).not.toHaveBeenCalled();
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "review_conflict",
        aiReviewRequestId: null,
        matchKind: "order_id",
      });
    });

    it("a proposal with nothing in it is parse_failed nothing_to_propose, keeping the match", async () => {
      // Incomplete parse whose summary the transaction already carries.
      const h = setup({
        receipt: receiptRow({
          bodyText: "Order number: ABCD1234\nOrder total: 15.00",
        }),
        candidates: [candidate({ description: "Shop ABCD1234 order" })],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "nothing_to_propose",
        transactionId: TX,
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("a description-only proposal names its reason", async () => {
      // The email says 15.00, the transaction is 14.00: the lines cannot be proposed.
      const h = setup({
        candidates: [
          candidate({ amount: "-14.0000", description: "ABCD1234" }),
        ],
      });
      const result = await run(h);
      expect(result.statusReason).toBe("amount_differs");
      const input = h.work.submit.mock.calls[0][3];
      expect(input.splits).toBeUndefined();
      expect(input.description).toContain("Shop ABCD1234");
    });

    it("the parser payee's name is proposed only when the transaction has no payee", async () => {
      const h = setup({
        parsers: [parserRow({ payeeId: PAYEE })],
        payee: { id: PAYEE, name: "Acme Books", defaultCategoryId: null },
        candidates: [candidate({ payee_id: null })],
      });
      await run(h);
      expect(h.work.submit.mock.calls[0][3].payeeName).toBe("Acme Books");

      const other = setup({
        parsers: [parserRow({ payeeId: PAYEE })],
        payee: { id: PAYEE, name: "Acme Books", defaultCategoryId: null },
        candidates: [candidate({ payee_id: "other" })],
      });
      await run(other);
      expect(other.work.submit.mock.calls[0][3].payeeName).toBeUndefined();
    });

    it("rethrows anything that is not a refusal, so the transaction rolls back", async () => {
      const h = setup();
      h.work.submit.mockRejectedValue(new Error("connection lost"));
      await expect(run(h)).rejects.toThrow("connection lost");
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("a refused proposal", () => {
    it("falls back once to the description only", async () => {
      const h = setup();
      h.work.submit
        .mockRejectedValueOnce(new BadRequestException("lines do not add up"))
        .mockResolvedValueOnce(submitted());
      const result = await run(h);
      expect(h.work.submit).toHaveBeenCalledTimes(2);
      const fallback = h.work.submit.mock.calls[1][3];
      expect(fallback.splits).toBeUndefined();
      expect(fallback.categoryName).toBeUndefined();
      expect(fallback.description).toContain("Shop ABCD1234");
      expect(result).toMatchObject({
        status: "review",
        statusReason: "proposal_fallback",
        requestId: "rq-1",
      });
      expect(h.requests.release).not.toHaveBeenCalled();
    });

    it("a refused fallback closes the request as rejected with the reason and says proposal_refused", async () => {
      const h = setup();
      h.work.submit
        .mockRejectedValueOnce(new BadRequestException("lines do not add up"))
        .mockRejectedValueOnce(new NotFoundException("category deleted"));
      const result = await run(h);
      expect(h.requests.release).toHaveBeenCalledWith(
        USER,
        "rq-1",
        "email-receipts",
        { final: true, note: "category deleted" },
      );
      expect(result).toMatchObject({
        status: "review",
        statusReason: "proposal_refused",
        requestId: "rq-1",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        statusReason: "proposal_refused",
        aiReviewRequestId: "rq-1",
      });
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("a description-only proposal that is refused is not retried with itself", async () => {
      const h = setup({ candidates: [candidate({ amount: "-14.0000" })] });
      h.work.submit.mockRejectedValue(new ConflictException("not claimed"));
      const result = await run(h);
      expect(h.work.submit).toHaveBeenCalledTimes(1);
      expect(h.requests.release).toHaveBeenCalledWith(
        USER,
        "rq-1",
        "email-receipts",
        { final: true, note: "not claimed" },
      );
      expect(result.statusReason).toBe("proposal_refused");
    });

    it("bounds the note a refusal leaves", async () => {
      const h = setup({ candidates: [candidate({ amount: "-14.0000" })] });
      h.work.submit.mockRejectedValue(
        new BadRequestException("x".repeat(2000)),
      );
      await run(h);
      expect(
        h.requests.release.mock.calls[0][3].note.length,
      ).toBeLessThanOrEqual(400);
    });
  });

  describe("the AI path", () => {
    const incomplete = BODY.replace("Shipping: 3.00\n", "");

    it("in mode automatic an incomplete parse queues a pending request for the AI and submits nothing", async () => {
      const h = setup({
        mailbox: mailboxRow({ aiMode: "automatic" }),
        receipt: receiptRow({ bodyText: incomplete }),
        candidates: [candidate({ amount: "-12.0000" })],
      });
      const result = await run(h);
      expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        {
          transactionId: TX,
          emailReceiptId: RECEIPT,
          instruction: RECEIPT_AUTOMATIC_AI_INSTRUCTION,
        },
      );
      expect(RECEIPT_AUTOMATIC_AI_INSTRUCTION.length).toBeLessThanOrEqual(1000);
      expect(RECEIPT_CHAT_INSTRUCTION.length).toBeLessThanOrEqual(1000);
      // The poll tells its own requests from the chat's by this text.
      expect(RECEIPT_CHAT_INSTRUCTION).not.toBe(
        RECEIPT_AUTOMATIC_AI_INSTRUCTION,
      );
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(h.work.submit).not.toHaveBeenCalled();
      expect(h.order).toEqual(["advisory", "close", "enqueuePending"]);
      expect(result).toMatchObject({
        status: "review",
        requestId: "rq-ai",
        statusReason: "items_unbalanced",
      });
    });

    it("asks the AI even when the deterministic proposal would be empty", async () => {
      const h = setup({
        mailbox: mailboxRow({ aiMode: "automatic" }),
        receipt: receiptRow({ bodyText: "Order number: ABCD1234" }),
        candidates: [candidate({ description: "Shop ABCD1234 ABCD1234" })],
      });
      const result = await run(h);
      expect(result.status).toBe("review");
      expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalled();
    });

    it("an open request somebody else raised is review_conflict on this path too", async () => {
      const h = setup({
        mailbox: mailboxRow({ aiMode: "automatic" }),
        receipt: receiptRow({ bodyText: incomplete }),
        candidates: [candidate({ amount: "-12.0000" })],
      });
      h.requests.enqueuePendingForReceipt.mockResolvedValue(null);
      const result = await run(h);
      expect(result.status).toBe("review_conflict");
    });

    it.each(["off", "on_demand"] as const)(
      "in mode %s the same receipt takes the deterministic path",
      async (aiMode) => {
        const h = setup({
          mailbox: mailboxRow({ aiMode }),
          receipt: receiptRow({ bodyText: incomplete }),
          candidates: [candidate({ amount: "-12.0000" })],
        });
        await run(h);
        expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
        expect(h.requests.enqueueClaimed).toHaveBeenCalled();
      },
    );

    it("in mode automatic a complete parse needs no AI", async () => {
      const h = setup({ mailbox: mailboxRow({ aiMode: "automatic" }) });
      await run(h);
      expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
      expect(h.requests.enqueueClaimed).toHaveBeenCalled();
    });
  });

  describe("a person links a transaction", () => {
    const linkRow = (over: Record<string, unknown> = {}) => ({
      id: "tx-9",
      amount: "-15.0000",
      description: "CARD",
      payee_id: null,
      is_transfer: false,
      status: "UNRECONCILED",
      plain: true,
      ...over,
    });

    it("proposes for that transaction with match kind manual and loads no candidates", async () => {
      const h = setup({ linkRow: linkRow() });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(result).toMatchObject({
        status: "review",
        transactionId: "tx-9",
        matchKind: "manual",
      });
      expect(
        h.manager.query.mock.calls.some((c) =>
          String(c[0]).includes("JOIN accounts a"),
        ),
      ).toBe(false);
      expect(h.requests.enqueueClaimed.mock.calls[0][2].transactionId).toBe(
        "tx-9",
      );
    });

    it("reads the transaction by id and owner, inside the writing transaction", async () => {
      const h = setup({ linkRow: linkRow() });
      await run(h, { link: { transactionId: "tx-9" } });
      const call = h.manager.query.mock.calls.find((c) =>
        String(c[0]).includes("WHERE t.id = $1"),
      );
      expect(call?.[1]).toEqual(["tx-9", USER]);
    });

    it.each([
      ["not the user's (or absent)", null, NotFoundException],
      ["a transfer", linkRow({ is_transfer: true }), BadRequestException],
      ["VOID", linkRow({ status: "VOID" }), BadRequestException],
      ["an investment row", linkRow({ plain: false }), BadRequestException],
    ])(
      "refuses a transaction that is %s and writes nothing",
      async (_n, row, error) => {
        const h = setup({ linkRow: row });
        await expect(
          run(h, { link: { transactionId: "tx-9" } }),
        ).rejects.toBeInstanceOf(error);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
        expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
        expect(h.order).not.toContain("close");
      },
    );

    it("proposes even when the parser read no total and no order id", async () => {
      const h = setup({
        linkRow: linkRow(),
        receipt: receiptRow({ bodyText: "Widget\nnothing else" }),
      });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(result.status).toBe("review");
      expect(result.matchKind).toBe("manual");
    });

    it("keeps the link when no parser reads the email, so the AI can be asked about it", async () => {
      const h = setup({ linkRow: linkRow(), parsers: [] });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(result).toMatchObject({
        status: "no_parser",
        transactionId: "tx-9",
        matchKind: "manual",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        transactionId: "tx-9",
        matchKind: "manual",
      });
    });

    it("a manual link never auto-applies", async () => {
      const h = setup({
        linkRow: linkRow(),
        mailbox: mailboxRow({ autoApply: true }),
      });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(h.actions.confirm).not.toHaveBeenCalled();
      expect(result.autoApplied).toBe(false);
    });
  });

  describe("reprocessing starts from the top", () => {
    it("a receipt that ends with no request of its own closes the ones it had", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "proposed",
        candidates: [],
      });
      const result = await run(h);
      expect(result.status).toBe("unmatched");
      expect(h.order).toContain("close");
      expect(h.lastUpdate()?.[1].aiReviewRequestId).toBeNull();
    });

    it("a receipt that is proposed again closes its old request before the new one is queued", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "rejected",
      });
      await run(h);
      expect(h.order).toEqual(["advisory", "close", "enqueue"]);
    });

    it("does not close the request it has just created", async () => {
      const h = setup();
      await run(h);
      expect(h.order.filter((s) => s === "close")).toHaveLength(1);
    });
  });

  describe("auto-apply", () => {
    const ready = () =>
      setup({
        mailbox: mailboxRow({ autoApply: true }),
        parsers: [parserRow()],
      });

    it("applies the card it built through confirm when every condition holds", async () => {
      const h = ready();
      const result = await run(h);
      expect(h.actions.confirm).toHaveBeenCalledTimes(1);
      expect(h.actions.confirm).toHaveBeenCalledWith(USER, {
        actionId: "action-1",
        signature: "sig-1",
        descriptor: action.descriptor,
      });
      expect(result).toMatchObject({ status: "review", autoApplied: true });
    });

    it("confirms after the transaction that stored the proposal has committed", async () => {
      const h = ready();
      const { withScopedDb } = jest.requireMock("../../common/db/scoped-db");
      let insideTransaction = false;
      withScopedDb.mockImplementationOnce(
        async (
          ds: { transaction: (fn: (m: unknown) => unknown) => unknown },
          fn: (m: unknown) => unknown,
        ) => {
          insideTransaction = true;
          try {
            return await ds.transaction(fn);
          } finally {
            insideTransaction = false;
          }
        },
      );
      h.actions.confirm.mockImplementation(async () => {
        expect(insideTransaction).toBe(false);
        return { type: "update_transaction", id: TX } as never;
      });
      await run(h);
      expect(h.actions.confirm).toHaveBeenCalled();
    });

    it("applies on an amount-plus-payee match too", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        parsers: [parserRow({ payeeId: PAYEE })],
        payee: { id: PAYEE, name: "Acme", defaultCategoryId: null },
        receipt: receiptRow({
          bodyText: BODY.replace("Order number: ABCD1234\n", ""),
        }),
        candidates: [candidate({ payee_id: PAYEE, description: "CARD" })],
      });
      const result = await run(h);
      expect(result.matchKind).toBe("amount_payee");
      expect(h.actions.confirm).toHaveBeenCalled();
    });

    it("the mailbox has not opted in: nothing is applied", async () => {
      const h = setup({ mailbox: mailboxRow({ autoApply: false }) });
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the match is by amount alone: nothing is applied", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        receipt: receiptRow({
          bodyText: BODY.replace("Order number: ABCD1234\n", ""),
        }),
        candidates: [candidate({ description: "CARD" })],
      });
      const result = await run(h);
      expect(result.matchKind).toBe("amount_only");
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the transaction amount differs from the total: nothing is applied", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        candidates: [candidate({ amount: "-14.0000" })],
      });
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the parse is incomplete: nothing is applied", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        receipt: receiptRow({ bodyText: BODY.replace("Shipping: 3.00\n", "") }),
        candidates: [candidate({ amount: "-12.0000" })],
      });
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the itemized card was refused and the fallback stored: nothing is applied", async () => {
      const h = ready();
      h.work.submit
        .mockRejectedValueOnce(new BadRequestException("no"))
        .mockResolvedValueOnce(submitted());
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("no card was built: nothing is applied", async () => {
      const h = ready();
      h.requests.enqueueClaimed.mockResolvedValue(null);
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("a refusal from confirm leaves the proposal in the inbox, is logged without secrets, and is not thrown", async () => {
      const h = ready();
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      h.actions.confirm.mockRejectedValue(
        new BadRequestException("Daily AI write limit reached."),
      );
      const result = await run(h);
      expect(result).toMatchObject({ status: "review", autoApplied: false });
      expect(h.requests.release).not.toHaveBeenCalled();
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("proposal stays in the inbox");
      expect(line).toContain(
        "BadRequestException: Daily AI write limit reached.",
      );
      expect(line).not.toContain("sig-1");
      warn.mockRestore();
    });

    it("an unexpected error from confirm logs only its class", async () => {
      const h = ready();
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      h.actions.confirm.mockRejectedValue(
        new Error("password authentication failed for user monize_user"),
      );
      await run(h);
      expect(String(warn.mock.calls[0][0])).not.toContain("password");
      expect(String(warn.mock.calls[0][0])).toContain("Error");
      warn.mockRestore();
    });
  });
});

describe("autoApplyAllowed", () => {
  const parsed = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
    orderId: "ABCD1234",
    total: 150000,
    shipping: null,
    discount: null,
    items: [],
    shippingCategoryId: null,
    discountCategoryId: null,
    complete: true,
    reason: null,
    ...over,
  });
  const facts = (over: Partial<AutoApplyFacts> = {}): AutoApplyFacts => ({
    mailboxAutoApply: true,
    parserStatus: "approved",
    parsed: parsed(),
    transactionAmount: -15,
    matchKind: "order_id",
    proposalKind: "itemized",
    usedFallback: false,
    cardBuilt: true,
    ...over,
  });

  it("holds when every condition does", () => {
    expect(autoApplyAllowed(facts())).toBe(true);
    expect(autoApplyAllowed(facts({ matchKind: "amount_payee" }))).toBe(true);
    expect(autoApplyAllowed(facts({ proposalKind: "single_category" }))).toBe(
      true,
    );
    expect(autoApplyAllowed(facts({ transactionAmount: 15 }))).toBe(true);
  });

  it.each<[string, Partial<AutoApplyFacts>]>([
    ["the mailbox has not opted in", { mailboxAutoApply: false }],
    ["the parser is a draft", { parserStatus: "draft" }],
    [
      "the parse is incomplete",
      { parsed: parsed({ complete: false, reason: "no_items" }) },
    ],
    ["there is no total", { parsed: parsed({ total: null }) }],
    ["the amount differs from the total", { transactionAmount: -14.99 }],
    ["the match is by amount alone", { matchKind: "amount_only" }],
    ["the match is manual", { matchKind: "manual" }],
    ["the proposal is description-only", { proposalKind: "description_only" }],
    ["the fallback was stored", { usedFallback: true }],
    ["no card was built", { cardBuilt: false }],
  ])("is false when %s", (_name, over) => {
    expect(autoApplyAllowed(facts(over))).toBe(false);
  });
});

describe("describeFailure", () => {
  it("names the class, and the message only for an HTTP exception", () => {
    expect(describeFailure(new ConflictException("clash"))).toBe(
      "ConflictException: clash",
    );
    expect(describeFailure(new Error("secret detail"))).toBe("Error");
    expect(describeFailure("text")).toBe("unknown error");
  });
});
