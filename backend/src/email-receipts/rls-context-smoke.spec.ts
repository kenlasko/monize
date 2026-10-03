import { Logger } from "@nestjs/common";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import { MISSING_CONTEXT_MESSAGE } from "../common/db/scoped-db";
import { JobClaimService } from "../common/jobs/job-claim.service";
import {
  getRequestContext,
  requestContextStorage,
  type RequestContext,
} from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { User } from "../users/entities/user.entity";
import { EmailReceiptMailbox } from "./entities/email-receipt-mailbox.entity";
import { EmailReceiptParser } from "./entities/email-receipt-parser.entity";
import { EmailReceipt } from "./entities/email-receipt.entity";
import { EmailReceiptMailboxService } from "./mailbox/email-receipt-mailbox.service";
import { EmailReceiptPipelineService } from "./pipeline/email-receipt-pipeline.service";
import { EmailReceiptPollService } from "./poll/email-receipt-poll.service";

/**
 * Identity smoke for the receipts poll, run against the REAL `withScopedDb`, the
 * real lease (`JobClaimService`), the real mailbox service and the real pipeline
 * over a mock connection (pattern: `src/delegation/rls-context-smoke.spec.ts`).
 *
 * `email-receipt-poll.service.spec.ts` mocks `withScopedDb` away, which is right
 * for what the poll does and structurally blind to which identity each statement
 * runs under. The poll is a cron with no request behind it, so it must seed its
 * own: the fan-out under the system bypass, everything else, the lease included
 * (a lease is database access too), under the mailbox owner's own identity. A
 * missing wrapper anywhere on the path surfaces here as the missing-context error
 * `withScopedDb` throws, which the cron would only log.
 */
describe("email receipts module RLS identity smoke (real withScopedDb)", () => {
  const USER = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";
  const MAILBOX = "5c2f1a90-6f4f-4a2e-8f2a-1b7c9d0e3a55";
  const RECEIPT = "7a1e4b22-8c3d-4f61-9b0a-2e5d6c8f4711";
  const LEASE = "1d9b7e40-2c55-4a18-9f3c-6b0d8e2a4417";

  const originalMode = process.env.RLS_MODE;
  interface Seen {
    op: string;
    ctx: RequestContext | undefined;
  }
  let seen: Seen[];
  let service: EmailReceiptPollService;
  let warn: jest.SpyInstance;

  const mailboxRow = Object.assign(new EmailReceiptMailbox(), {
    id: MAILBOX,
    userId: USER,
    host: "8.8.8.8",
    port: 993,
    security: "tls",
    username: "receipts@example.com",
    passwordEnc: "cipher",
    folder: "INBOX",
    enabled: true,
    aiMode: "off",
    autoApply: false,
    uidValidity: "77",
    lastUid: "40",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  });

  beforeEach(() => {
    process.env.RLS_MODE = "enforce";
    seen = [];
    const record = (op: string) => seen.push({ op, ctx: getRequestContext() });

    const { manager, dataSource } = createScopedDbMocks();
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("set_config")) return [];
      if (text.includes("INSERT INTO job_claims")) {
        record("lease claim");
        return [{ lease_token: LEASE }];
      }
      if (text.includes("DELETE FROM job_claims")) {
        record("lease release");
        return [];
      }
      if (text.includes("INSERT INTO email_receipts")) {
        record("insert receipt");
        return [{ id: RECEIPT }];
      }
      if (text.includes("UPDATE email_receipt_mailboxes")) {
        record("advance cursor");
        return [];
      }
      if (text.includes("status = 'pending'")) {
        record("select pending");
        return [{ id: RECEIPT }];
      }
      if (text.includes("r.status = 'unmatched'")) {
        record("select rematch");
        return [];
      }
      if (text.includes("SET status = 'rejected'")) {
        record("close requests");
        return [[], 0];
      }
      return [];
    });

    const repo = (name: string, extra: Record<string, jest.Mock> = {}) => ({
      find: jest.fn(async () => {
        record(`${name}.find`);
        return [];
      }),
      findOne: jest.fn(async () => {
        record(`${name}.findOne`);
        return null;
      }),
      update: jest.fn(async () => {
        record(`${name}.update`);
        return { affected: 1 };
      }),
      ...extra,
    });
    const mailboxRepo = repo("mailbox", {
      find: jest.fn(async () => {
        record("list mailboxes");
        return [{ id: MAILBOX, userId: USER }];
      }),
      findOne: jest.fn(async () => {
        record("mailbox.findOne");
        return mailboxRow;
      }),
      createQueryBuilder: jest.fn(() => {
        const chain = {
          addSelect: () => chain,
          where: () => chain,
          getOne: async () => {
            record("read mailbox");
            return mailboxRow;
          },
        };
        return chain;
      }),
    });
    const receiptRepo = repo("receipt", {
      findOne: jest.fn(async () => {
        record("lock receipt");
        return Object.assign(new EmailReceipt(), {
          id: RECEIPT,
          userId: USER,
          mailboxId: MAILBOX,
          fromDomain: "shop.example.com",
          subject: "Your order",
          bodyText: "Order total: 15.00",
          receivedAt: new Date("2026-09-10T10:00:00Z"),
          status: "pending",
          aiReviewRequestId: null,
        });
      }),
    });
    const repos = new Map<unknown, unknown>([
      [EmailReceiptMailbox, mailboxRepo],
      [EmailReceipt, receiptRepo],
      [EmailReceiptParser, repo("parser")],
      [
        User,
        repo("user", {
          findOne: jest.fn(async () => {
            record("read owner");
            return { id: USER, role: "user" };
          }),
        }),
      ],
    ]);
    manager.getRepository.mockImplementation((entity: unknown) => {
      const found = repos.get(entity);
      if (!found) throw new Error(`no mock repository for ${String(entity)}`);
      return found;
    });

    const mailbox = new EmailReceiptMailboxService(
      dataSource as never,
      {
        decrypt: jest.fn(() => "app-password"),
        encrypt: jest.fn(),
        isConfigured: jest.fn(() => true),
      } as never,
      { testConnection: jest.fn(), fetchSince: jest.fn() } as never,
      { obtain: jest.fn() } as never,
    );
    const imap = {
      testConnection: jest.fn(),
      fetchSince: jest.fn(async () => ({
        uidValidity: "77",
        messages: [
          {
            uid: "41",
            source: Buffer.from(
              "From: Shop <orders@shop.example.com>\r\nSubject: Your order\r\nDate: Wed, 9 Sep 2026 08:00:00 +0000\r\n\r\nOrder total: 15.00\r\n",
            ),
            internalDate: new Date("2026-09-09T08:00:00Z"),
            size: 120,
          },
        ],
        skipped: [],
        highestUid: "41",
      })),
    };
    const jobClaims = new JobClaimService(dataSource as never);
    const pipeline = new EmailReceiptPipelineService(
      dataSource as never,
      new AiReviewRequestsService(dataSource as never),
      { submit: jest.fn() } as never,
      { confirm: jest.fn() } as never,
    );
    service = new EmailReceiptPollService(
      dataSource as never,
      mailbox,
      imap as never,
      jobClaims,
      pipeline,
      { runAutomaticStep: jest.fn() } as never,
    );
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
    if (originalMode === undefined) delete process.env.RLS_MODE;
    else process.env.RLS_MODE = originalMode;
  });

  it("the cron lists under the system identity and does everything else, the lease included, as the owner", async () => {
    await service.pollAll();

    // A missing wrapper would have been logged as a failed poll.
    expect(
      warn.mock.calls.filter((c) => /Receipt poll/.test(String(c[0]))),
    ).toEqual([]);
    expect(seen.map((s) => s.op)).toEqual([
      "list mailboxes",
      "lease claim",
      "read mailbox",
      "read owner",
      "insert receipt",
      "advance cursor",
      "mailbox.update",
      "select pending",
      "lock receipt",
      "mailbox.findOne",
      "parser.find",
      "close requests",
      "receipt.update",
      "select rematch",
      "lease release",
    ]);
    const [list, ...rest] = seen;
    expect(list.ctx).toEqual({ system: true });
    for (const step of rest) {
      expect({ op: step.op, ctx: step.ctx }).toEqual({
        op: step.op,
        ctx: { userId: USER },
      });
    }
  });

  it("Poll now spends the request's own identity and seeds none of its own", async () => {
    const outcome = await requestContextStorage.run({ userId: USER }, () =>
      service.pollNow(USER),
    );
    expect(outcome).toMatchObject({ ok: true, fetched: 1, processed: 1 });
    expect(seen.length).toBeGreaterThan(5);
    for (const step of seen) {
      expect({ op: step.op, ctx: step.ctx }).toEqual({
        op: step.op,
        ctx: { userId: USER },
      });
    }
  });

  it("Poll now outside any identity is refused by withScopedDb, not run as somebody", async () => {
    await expect(service.pollNow(USER)).rejects.toThrow(
      MISSING_CONTEXT_MESSAGE,
    );
    expect(seen).toEqual([]);
  });
});
