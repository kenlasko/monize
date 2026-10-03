import { ConflictException, NotFoundException } from "@nestjs/common";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceipt } from "../entities/email-receipt.entity";
import type { EmailReceiptPipelineService } from "../pipeline/email-receipt-pipeline.service";
import {
  deriveDisplayState,
  EmailReceiptsService,
} from "./email-receipts.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const ID = "receipt-1";

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  from_address: "orders@shop.example.com",
  from_domain: "shop.example.com",
  subject: "Your order",
  received_at: new Date("2026-09-10T10:00:00Z"),
  created_at: new Date("2026-09-10T10:05:00Z"),
  status: "review",
  status_reason: null,
  match_kind: "order_id",
  parser_id: "p1",
  parser_name: "Shop",
  ai_review_request_id: "rq1",
  request_status: "proposed",
  request_expired: false,
  request_note: null,
  transaction_id: "t1",
  tx_date: "2026-09-11",
  tx_amount: "-37.9700",
  tx_currency: "USD",
  tx_payee: "Shop",
  ...over,
});

function setup() {
  const receiptRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
  ]);
  const pipeline = {
    process: jest.fn(),
  } as unknown as jest.Mocked<EmailReceiptPipelineService>;
  const service = new EmailReceiptsService(dataSource as never, pipeline);
  return { service, manager, receiptRepo, pipeline };
}

const locked = (over: Partial<EmailReceipt> = {}) =>
  Object.assign(new EmailReceipt(), {
    id: ID,
    userId: USER,
    status: "review",
    transactionId: "t1",
    aiReviewRequestId: "rq1",
    ...over,
  });

describe("deriveDisplayState", () => {
  it.each([
    ["proposed", false, "proposed"],
    ["proposed", true, "expired"],
    ["applied", false, "applied"],
    ["rejected", false, "dismissed"],
    ["expired", false, "expired"],
    ["pending", false, "pending_ai"],
    ["claimed", false, "pending_ai"],
    ["pending", true, "expired"],
  ])("a %s request (expired %s) is %s", (status, expired, expected) => {
    expect(deriveDisplayState("review", { status, expired })).toBe(expected);
  });

  it("a review receipt with no request row is request_missing", () => {
    expect(deriveDisplayState("review", null)).toBe("request_missing");
  });

  it.each([
    "pending",
    "skipped",
    "no_parser",
    "parse_failed",
    "unmatched",
    "ambiguous",
    "review_conflict",
    "ignored",
  ] as const)("a %s receipt shows no request state", (status) => {
    expect(
      deriveDisplayState(status, { status: "proposed", expired: false }),
    ).toBeNull();
  });
});

describe("EmailReceiptsService.list", () => {
  it("lists newest first without the text, deriving the state and the transaction", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row(),
      row({
        id: "receipt-2",
        status: "unmatched",
        request_status: null,
        ai_review_request_id: null,
        transaction_id: null,
        tx_date: null,
        tx_amount: null,
        tx_currency: null,
        tx_payee: null,
        received_at: "2026-09-09T10:00:00.000Z",
      }),
    ]);

    const items = await service.list(USER, { status: "review", limit: 20 });

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("ORDER BY r.received_at DESC");
    expect(sql).not.toContain("body_text");
    expect(params).toEqual([USER, "review", 20]);
    expect(items[0]).toEqual({
      id: ID,
      fromAddress: "orders@shop.example.com",
      fromDomain: "shop.example.com",
      subject: "Your order",
      receivedAt: "2026-09-10T10:00:00.000Z",
      status: "review",
      statusReason: null,
      matchKind: "order_id",
      parserId: "p1",
      parserName: "Shop",
      aiReviewRequestId: "rq1",
      displayState: "proposed",
      requestNote: null,
      transaction: {
        id: "t1",
        date: "2026-09-11",
        amount: -37.97,
        currencyCode: "USD",
        payeeName: "Shop",
      },
      createdAt: "2026-09-10T10:05:00.000Z",
    });
    expect(items[1]).toMatchObject({
      displayState: null,
      transaction: null,
      receivedAt: "2026-09-09T10:00:00.000Z",
    });
    expect(Object.keys(items[0])).not.toContain("bodyText");
  });

  it("scopes by the JWT user only and clamps the limit", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.list(USER);
    expect(manager.query.mock.calls[0][1]).toEqual([USER, null, 50]);
    await service.list(USER, { limit: 9999 });
    expect(manager.query.mock.calls[1][1][2]).toBe(200);
    await service.list(USER, { limit: 0 });
    expect(manager.query.mock.calls[2][1][2]).toBe(1);
  });

  it("carries why a request was closed", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row({ request_status: "rejected", request_note: "lines do not add up" }),
    ]);
    const [item] = await service.list(USER);
    expect(item).toMatchObject({
      displayState: "dismissed",
      requestNote: "lines do not add up",
    });
  });
});

describe("EmailReceiptsService.get", () => {
  it("returns the text, the parse and the candidates in the stored order", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([
        {
          ...row({ status: "ambiguous", ai_review_request_id: null }),
          body_text: "Order total: 9.99",
          parsed: { total: 99900 },
          candidate_transaction_ids: ["t2", "t1", "gone"],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "t1",
          date: "2026-09-11",
          amount: "-9.9900",
          currency_code: "USD",
          payee_name: null,
          description: "CARD",
        },
        {
          id: "t2",
          date: "2026-09-10",
          amount: "-9.9900",
          currency_code: "USD",
          payee_name: "Shop",
          description: null,
        },
      ]);

    const detail = await service.get(USER, ID);

    expect(detail.bodyText).toBe("Order total: 9.99");
    expect(detail.parsed).toEqual({ total: 99900 });
    expect(detail.candidates.map((c) => c.id)).toEqual(["t2", "t1"]);
    expect(detail.candidates[0]).toMatchObject({
      amount: -9.99,
      payeeName: "Shop",
    });
    expect(manager.query.mock.calls[1][1]).toEqual([
      USER,
      ["t2", "t1", "gone"],
    ]);
  });

  it("does not look for candidates when there are none", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      { ...row(), body_text: "", parsed: null, candidate_transaction_ids: [] },
    ]);
    await service.get(USER, ID);
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it("is a 404 for an email that is not the user's", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await expect(service.get(USER, ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("EmailReceiptsService.reprocess and link", () => {
  it("reprocess runs the pipeline under the JWT user and returns the fresh detail", async () => {
    const { service, manager, pipeline } = setup();
    manager.query.mockResolvedValueOnce([
      { ...row(), body_text: "", parsed: null, candidate_transaction_ids: [] },
    ]);
    const detail = await service.reprocess(USER, ID);
    expect(pipeline.process).toHaveBeenCalledWith(USER, ID);
    expect(detail.id).toBe(ID);
  });

  it("link hands the pipeline the transaction, which checks it in the writing transaction", async () => {
    const { service, manager, pipeline } = setup();
    manager.query.mockResolvedValueOnce([
      { ...row(), body_text: "", parsed: null, candidate_transaction_ids: [] },
    ]);
    await service.link(USER, ID, "t9");
    expect(pipeline.process).toHaveBeenCalledWith(USER, ID, {
      link: { transactionId: "t9" },
    });
  });

  it("a refusal from the pipeline propagates and nothing is read after it", async () => {
    const { service, manager, pipeline } = setup();
    pipeline.process.mockRejectedValue(new ConflictException("applied"));
    await expect(service.link(USER, ID, "t9")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptsService.ignore", () => {
  it("dismisses the receipt's open requests and marks it ignored, under the row lock", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked());
    manager.query.mockImplementation(async (sql: string) =>
      sql.includes("SELECT status FROM ai_review_requests")
        ? [{ status: "proposed" }]
        : sql.includes("FROM email_receipts r")
          ? [
              {
                ...row({ status: "ignored", ai_review_request_id: null }),
                body_text: "",
                parsed: null,
                candidate_transaction_ids: [],
              },
            ]
          : [],
    );

    const detail = await service.ignore(USER, ID);

    expect(receiptRepo.findOne).toHaveBeenCalledWith({
      where: { id: ID, userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    const sqls = manager.query.mock.calls.map((c) => String(c[0]));
    const advisory = sqls.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const close = sqls.findIndex((s) => s.includes("SET status = 'rejected'"));
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(advisory);
    expect(receiptRepo.update).toHaveBeenCalledWith(
      { id: ID, userId: USER },
      { status: "ignored", statusReason: null, aiReviewRequestId: null },
    );
    expect(detail.status).toBe("ignored");
  });

  it("refuses an applied receipt and writes nothing", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked());
    manager.query.mockResolvedValue([{ status: "applied" }]);
    await expect(service.ignore(USER, ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(receiptRepo.update).not.toHaveBeenCalled();
    expect(
      manager.query.mock.calls.some((c) =>
        String(c[0]).includes("SET status = 'rejected'"),
      ),
    ).toBe(false);
  });

  it("refuses a skipped receipt and writes nothing", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked({ status: "skipped" }));
    await expect(service.ignore(USER, ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(receiptRepo.update).not.toHaveBeenCalled();
  });

  it("ignoring an ignored receipt is a no-op", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked({ status: "ignored" }));
    manager.query.mockResolvedValue([
      { ...row(), body_text: "", parsed: null, candidate_transaction_ids: [] },
    ]);
    await service.ignore(USER, ID);
    expect(receiptRepo.update).not.toHaveBeenCalled();
  });

  it("is a 404 for another user's email", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(null);
    await expect(service.ignore(USER, ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("EmailReceiptsService.remove", () => {
  it("dismisses the open request and deletes the email in one transaction", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked());
    manager.query.mockResolvedValue([]);

    await service.remove(USER, ID);

    const dismiss = manager.query.mock.calls.find((c) =>
      String(c[0]).includes("SET status = 'rejected'"),
    );
    expect(dismiss?.[1]).toEqual([USER, ID]);
    expect(receiptRepo.delete).toHaveBeenCalledWith({ id: ID, userId: USER });
    expect(
      dismiss && receiptRepo.delete.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      manager.query.mock.invocationCallOrder[
        manager.query.mock.calls.indexOf(dismiss)
      ],
    );
  });

  it("a missing email deletes nothing and closes nothing", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(null);
    await expect(service.remove(USER, ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(receiptRepo.delete).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });
});
