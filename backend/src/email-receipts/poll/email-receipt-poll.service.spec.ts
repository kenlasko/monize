import { Logger, NotFoundException } from "@nestjs/common";
import { getRequestContext } from "../../common/request-context";
import type { JobClaimService } from "../../common/jobs/job-claim.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { EmailReceiptAiService } from "../ai/email-receipt-ai.service";
import type {
  FetchSinceResult,
  ImapMailboxClient,
} from "../imap/imap-mailbox-client";
import { extractMailText } from "../imap/mail-text.util";
import type {
  EmailReceiptMailboxService,
  LoadedEmailReceiptMailbox,
} from "../mailbox/email-receipt-mailbox.service";
import type { EmailReceiptMailboxView } from "../mailbox/email-receipt-mailbox.view";
import type { EmailReceiptPipelineService } from "../pipeline/email-receipt-pipeline.service";
import {
  EmailReceiptPollService,
  MAX_PROCESSED_PER_POLL,
  MAX_REMATCHED_PER_POLL,
  pickReceivedAt,
  POLL_LEASE_MS,
} from "./email-receipt-poll.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);
jest.mock("../imap/mail-text.util", () => ({
  extractMailText: jest.fn(),
}));

const USER = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";
const OTHER = "7d1f3c22-5b7e-4a5e-8c3c-2f6f7d1e9a22";
const MAILBOX = "mb-1";
const PASSWORD = "app-password-123";
const TOKEN = "lease-token-1";

const loaded = (
  over: Partial<LoadedEmailReceiptMailbox> = {},
): LoadedEmailReceiptMailbox => ({
  mailboxId: MAILBOX,
  connection: {
    host: "imap.example.com",
    port: 993,
    security: "tls",
    username: "receipts@example.com",
    auth: { kind: "password", password: PASSWORD },
    folder: "INBOX",
    allowPrivateHost: false,
  },
  secrets: [PASSWORD, "receipts@example.com"],
  cursor: { uidValidity: "77", lastUid: "40" },
  enabled: true,
  aiMode: "off",
  autoApply: false,
  ...over,
});

const fetched = (over: Partial<FetchSinceResult> = {}): FetchSinceResult => ({
  uidValidity: "77",
  messages: [],
  skipped: [],
  highestUid: null,
  ...over,
});

const message = (uid: string, internalDate = "2026-09-10T10:00:00Z") => ({
  uid,
  source: Buffer.from(`message ${uid}`),
  internalDate: new Date(internalDate),
  size: 100,
});

const mail = (over: Record<string, unknown> = {}) => ({
  messageId: "<m@shop.example.com>",
  fromAddress: "orders@shop.example.com",
  fromDomain: "shop.example.com",
  subject: "Your order",
  date: new Date("2026-09-09T08:00:00Z"),
  text: "Order total: 15.00",
  ...over,
});

const view = (over: Partial<EmailReceiptMailboxView> = {}) =>
  ({ id: MAILBOX, enabled: true, ...over }) as EmailReceiptMailboxView;

function setup() {
  const { manager, dataSource } = createScopedDbMocks();
  const state = { inTransaction: false, events: [] as string[] };
  const baseTransaction = dataSource.transaction.getMockImplementation();
  dataSource.transaction.mockImplementation(async (...args: unknown[]) => {
    state.inTransaction = true;
    state.events.push("begin");
    try {
      const result = await (baseTransaction as (...a: unknown[]) => unknown)(
        ...args,
      );
      state.events.push("commit");
      return result;
    } catch (error) {
      state.events.push("rollback");
      throw error;
    } finally {
      state.inTransaction = false;
    }
  });

  const pending: string[] = [];
  const rematch: string[] = [];
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("INSERT INTO email_receipts")) {
      state.events.push("insert");
      return [{ id: "new" }];
    }
    if (text.includes("status = 'pending'"))
      return pending.map((id) => ({ id }));
    if (text.includes("r.status = 'unmatched'")) {
      return rematch.map((id) => ({ id }));
    }
    return [];
  });

  const mailbox = {
    listEnabledMailboxes: jest.fn(async () => [{ id: MAILBOX, userId: USER }]),
    loadConnection: jest.fn(
      async () => loaded() as LoadedEmailReceiptMailbox | null,
    ),
    advanceCursor: jest.fn(async () => {
      state.events.push(
        state.inTransaction ? "cursor(in tx)" : "cursor(outside)",
      );
    }),
    recordPollSuccess: jest.fn(async () => undefined),
    recordPollFailure: jest.fn(async () => "Could not sign in"),
    getView: jest.fn(async () => view() as EmailReceiptMailboxView | null),
  } as unknown as jest.Mocked<EmailReceiptMailboxService>;
  const imap = {
    testConnection: jest.fn(),
    fetchSince: jest.fn(async () => fetched()),
  } as unknown as jest.Mocked<ImapMailboxClient>;
  const jobClaims = {
    claimLease: jest.fn(async () => TOKEN as string | null),
    releaseLease: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<JobClaimService>;
  const pipeline = {
    process: jest.fn(async () => ({ unchanged: false }) as never),
  } as unknown as jest.Mocked<EmailReceiptPipelineService>;
  const ai = {
    runAutomaticStep: jest.fn(async () => ({
      proposed: 0,
      failed: 0,
      drafted: 0,
    })),
  } as unknown as jest.Mocked<EmailReceiptAiService>;

  const service = new EmailReceiptPollService(
    dataSource as never,
    mailbox,
    imap,
    jobClaims,
    pipeline,
    ai,
  );
  return {
    service,
    manager,
    dataSource,
    state,
    pending,
    rematch,
    mailbox,
    imap,
    jobClaims,
    pipeline,
    ai,
  };
}

const poll = (h: ReturnType<typeof setup>) =>
  h.service.pollMailbox(USER, MAILBOX, { requireEnabled: true });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe("the cron", () => {
  it("lists the mailboxes under the system identity and polls each under its owner's", async () => {
    const h = setup();
    const seen: Array<{ op: string; ctx: unknown }> = [];
    h.mailbox.listEnabledMailboxes.mockImplementation(async () => {
      seen.push({ op: "list", ctx: getRequestContext() });
      return [{ id: MAILBOX, userId: USER }];
    });
    h.jobClaims.claimLease.mockImplementation(async () => {
      seen.push({ op: "claim", ctx: getRequestContext() });
      return TOKEN;
    });
    h.jobClaims.releaseLease.mockImplementation(async () => {
      seen.push({ op: "release", ctx: getRequestContext() });
    });

    await h.service.pollAll();

    expect(seen).toEqual([
      { op: "list", ctx: { system: true } },
      { op: "claim", ctx: { userId: USER } },
      { op: "release", ctx: { userId: USER } },
    ]);
  });

  it("one user's failure does not stop the next user", async () => {
    const h = setup();
    h.mailbox.listEnabledMailboxes.mockResolvedValue([
      { id: "mb-a", userId: USER },
      { id: "mb-b", userId: OTHER },
    ]);
    h.jobClaims.claimLease
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(TOKEN);
    h.mailbox.loadConnection.mockResolvedValue(loaded({ mailboxId: "mb-b" }));

    await h.service.pollAll();

    expect(h.imap.fetchSince).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(`user=${USER}`),
    );
  });

  it("drops an overlapping tick on this replica and is ready again afterwards", async () => {
    const h = setup();
    let release!: () => void;
    h.imap.fetchSince.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(fetched());
        }),
    );
    const first = h.service.pollAll();
    await new Promise((r) => setImmediate(r));
    await h.service.pollAll();
    expect(h.mailbox.listEnabledMailboxes).toHaveBeenCalledTimes(1);
    release();
    await first;
    await h.service.pollAll();
    expect(h.mailbox.listEnabledMailboxes).toHaveBeenCalledTimes(2);
  });

  it("a failure listing the mailboxes is logged, not thrown, and the flag is cleared", async () => {
    const h = setup();
    h.mailbox.listEnabledMailboxes.mockRejectedValueOnce(new Error("db down"));
    await expect(h.service.pollAll()).resolves.toBeUndefined();
    await h.service.pollAll();
    expect(h.mailbox.listEnabledMailboxes).toHaveBeenCalledTimes(2);
  });

  it("skips a mailbox switched off since it was listed", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockResolvedValue(loaded({ enabled: false }));
    await h.service.pollAll();
    expect(h.imap.fetchSince).not.toHaveBeenCalled();
    expect(h.jobClaims.releaseLease).toHaveBeenCalledTimes(1);
  });
});

describe("the lease (INV-RECEIPT-006)", () => {
  it("is claimed per mailbox for ten minutes and released by its token", async () => {
    const h = setup();
    await poll(h);
    expect(h.jobClaims.claimLease).toHaveBeenCalledWith(
      "email_receipt_poll",
      USER,
      MAILBOX,
      POLL_LEASE_MS,
    );
    expect(POLL_LEASE_MS).toBe(10 * 60_000);
    expect(h.jobClaims.releaseLease).toHaveBeenCalledWith(
      "email_receipt_poll",
      USER,
      MAILBOX,
      TOKEN,
    );
  });

  it("a second concurrent poll that loses the claim does nothing at all", async () => {
    const h = setup();
    h.jobClaims.claimLease.mockResolvedValue(null);
    const outcome = await poll(h);
    expect(outcome).toMatchObject({ busy: true, fetched: 0, processed: 0 });
    expect(h.mailbox.loadConnection).not.toHaveBeenCalled();
    expect(h.imap.fetchSince).not.toHaveBeenCalled();
    expect(h.pipeline.process).not.toHaveBeenCalled();
    expect(h.ai.runAutomaticStep).not.toHaveBeenCalled();
    expect(h.jobClaims.releaseLease).not.toHaveBeenCalled();
  });

  it("two polls racing for one lease: only the winner reads the mailbox", async () => {
    const h = setup();
    h.jobClaims.claimLease
      .mockResolvedValueOnce(TOKEN)
      .mockResolvedValueOnce(null);
    const [a, b] = await Promise.all([poll(h), poll(h)]);
    expect([a.busy, b.busy].sort()).toEqual([false, true]);
    expect(h.imap.fetchSince).toHaveBeenCalledTimes(1);
  });

  it("is released even when the poll throws", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockRejectedValue(new Error("x"));
    h.mailbox.recordPollFailure.mockRejectedValue(new Error("db down"));
    await expect(poll(h)).rejects.toThrow("db down");
    expect(h.jobClaims.releaseLease).toHaveBeenCalledWith(
      "email_receipt_poll",
      USER,
      MAILBOX,
      TOKEN,
    );
  });

  it("a failed release is logged and does not fail the poll", async () => {
    const h = setup();
    h.jobClaims.releaseLease.mockRejectedValue(new Error("db down"));
    await expect(poll(h)).resolves.toMatchObject({ ok: true });
  });
});

describe("reading the mailbox", () => {
  it("reads from the stored cursor, from 30 days ago on a first sync, within the limits", async () => {
    const h = setup();
    const before = Date.now();
    await poll(h);
    const [connection, cursor, options] = h.imap.fetchSince.mock.calls[0];
    expect(connection.host).toBe("imap.example.com");
    expect(cursor).toEqual({ uidValidity: "77", lastUid: "40" });
    const days = (before - options.sinceDate.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    expect(options.maxMessages).toBe(50);
    expect(options.maxBytes).toBe(2_000_000);
  });

  it("a mailbox that was deleted and recreated since it was listed is left alone", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockResolvedValue(
      loaded({ mailboxId: "mb-other" }),
    );
    await poll(h);
    expect(h.imap.fetchSince).not.toHaveBeenCalled();
  });

  it("a mailbox that is gone is left alone", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockResolvedValue(null);
    await expect(poll(h)).resolves.toMatchObject({ ok: true, fetched: 0 });
  });

  it("a stored password that cannot be decrypted is recorded as the mailbox's error, with no secrets", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockRejectedValue(new Error("cannot decrypt"));
    const outcome = await poll(h);
    expect(outcome).toMatchObject({ ok: false, error: "Could not sign in" });
    expect(h.mailbox.recordPollFailure).toHaveBeenCalledWith(
      USER,
      MAILBOX,
      expect.any(Error),
    );
    expect(h.imap.fetchSince).not.toHaveBeenCalled();
  });
});

describe("ingestion (INV-RECEIPT-002)", () => {
  it("stores every message and advances the cursor in ONE transaction, cursor last", async () => {
    const h = setup();
    mockMailText(mail());
    h.imap.fetchSince.mockResolvedValue(
      fetched({
        messages: [message("41"), message("42")],
        highestUid: "42",
      }),
    );

    const outcome = await poll(h);

    expect(outcome).toMatchObject({ fetched: 2, skipped: 0 });
    // one begin/commit around the two inserts and the cursor: nothing between
    expect(h.state.events.slice(0, 5)).toEqual([
      "begin",
      "insert",
      "insert",
      "cursor(in tx)",
      "commit",
    ]);
    expect(h.mailbox.advanceCursor).toHaveBeenCalledWith(USER, MAILBOX, {
      uidValidity: "77",
      lastUid: "42",
    });
  });

  it("inserts idempotently on the unique key, with the values of the email", async () => {
    const h = setup();
    mockMailText(mail());
    h.imap.fetchSince.mockResolvedValue(
      fetched({ messages: [message("41")], highestUid: "41" }),
    );
    await poll(h);
    const insert = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO email_receipts"),
    ) as [string, unknown[]];
    expect(insert[0]).toContain(
      "ON CONFLICT (mailbox_id, uid_validity, uid) DO NOTHING",
    );
    expect(insert[1]).toEqual([
      USER,
      MAILBOX,
      "77",
      "41",
      "<m@shop.example.com>",
      "orders@shop.example.com",
      "shop.example.com",
      "Your order",
      new Date("2026-09-09T08:00:00Z"),
      "Order total: 15.00",
      "pending",
      null,
    ]);
  });

  it("a UID already stored is not counted and does not stop the cursor", async () => {
    const h = setup();
    mockMailText(mail());
    h.manager.query.mockImplementation(async (sql: string) =>
      String(sql).includes("INSERT INTO email_receipts") ? [] : [],
    );
    h.imap.fetchSince.mockResolvedValue(
      fetched({ messages: [message("41")], highestUid: "41" }),
    );
    const outcome = await poll(h);
    expect(outcome.fetched).toBe(0);
    expect(h.mailbox.advanceCursor).toHaveBeenCalled();
  });

  it("stores a too-large message and an undecodable one as skipped so their UIDs are consumed", async () => {
    const h = setup();
    (extractMailText as jest.Mock).mockRejectedValue(new Error("bad mime"));
    h.imap.fetchSince.mockResolvedValue(
      fetched({
        messages: [message("42")],
        skipped: [{ uid: "41", reason: "too_large" }],
        highestUid: "42",
      }),
    );
    const outcome = await poll(h);
    expect(outcome).toMatchObject({ fetched: 0, skipped: 2 });
    const inserts = h.manager.query.mock.calls
      .filter((c) => String(c[0]).includes("INSERT INTO email_receipts"))
      .map((c) => c[1] as unknown[]);
    expect(inserts.map((p) => [p[3], p[5], p[7], p[9], p[10], p[11]])).toEqual([
      ["42", "", "", "", "skipped", "undecodable"],
      ["41", "", "", "", "skipped", "too_large"],
    ]);
  });

  it("a failure storing rolls back the cursor with the rows and records the error", async () => {
    const h = setup();
    mockMailText(mail());
    h.manager.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("INSERT INTO email_receipts")) {
        h.state.events.push("insert");
        throw new Error("disk full");
      }
      return [];
    });
    h.imap.fetchSince.mockResolvedValue(
      fetched({ messages: [message("41")], highestUid: "41" }),
    );

    const outcome = await poll(h);

    expect(outcome).toMatchObject({ ok: false, error: "Could not sign in" });
    expect(h.mailbox.advanceCursor).not.toHaveBeenCalled();
    expect(h.state.events.slice(0, 3)).toEqual(["begin", "insert", "rollback"]);
    expect(h.mailbox.recordPollSuccess).not.toHaveBeenCalled();
    expect(h.mailbox.recordPollFailure).toHaveBeenCalledWith(
      USER,
      MAILBOX,
      expect.any(Error),
      [PASSWORD, "receipts@example.com"],
    );
  });

  it("an empty poll still moves the UIDVALIDITY (and never a lower UID)", async () => {
    const h = setup();
    await poll(h);
    expect(h.mailbox.advanceCursor).toHaveBeenCalledWith(USER, MAILBOX, {
      uidValidity: "77",
      lastUid: null,
    });
  });

  it("dates an email by its header unless that is in the future", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const internal = new Date("2026-09-29T09:00:00Z");
    expect(
      pickReceivedAt(new Date("2026-09-01T00:00:00Z"), internal, now),
    ).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(
      pickReceivedAt(new Date("2026-10-15T00:00:00Z"), internal, now),
    ).toEqual(internal);
    expect(pickReceivedAt(null, internal, now)).toEqual(internal);
    expect(pickReceivedAt(null, new Date("nope"), now)).toEqual(now);
  });
});

describe("the mailbox result", () => {
  it("stamps a success only when the mailbox was read", async () => {
    const h = setup();
    await poll(h);
    expect(h.mailbox.recordPollSuccess).toHaveBeenCalledWith(USER, MAILBOX);
    expect(h.mailbox.recordPollFailure).not.toHaveBeenCalled();
  });

  it("records a read failure with the secrets to redact, leaves the cursor, and still processes what is stored", async () => {
    const h = setup();
    h.imap.fetchSince.mockRejectedValue(
      new Error(`login failed for ${PASSWORD}`),
    );
    h.pending.push("r1");

    const outcome = await poll(h);

    expect(outcome).toMatchObject({
      ok: false,
      error: "Could not sign in",
      processed: 1,
    });
    expect(h.mailbox.advanceCursor).not.toHaveBeenCalled();
    expect(h.mailbox.recordPollFailure).toHaveBeenCalledWith(
      USER,
      MAILBOX,
      expect.any(Error),
      [PASSWORD, "receipts@example.com"],
    );
    const logged = (Logger.prototype.warn as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).toContain("Could not sign in");
    expect(logged).not.toContain(PASSWORD);
  });
});

describe("processing and rematching", () => {
  it("runs the pipeline over the pending emails, bounded, guarded by status", async () => {
    const h = setup();
    h.pending.push("r1", "r2");
    const outcome = await poll(h);
    expect(h.pipeline.process).toHaveBeenCalledTimes(2);
    expect(h.pipeline.process).toHaveBeenCalledWith(USER, "r1", {
      onlyWhenStatusIn: ["pending"],
    });
    expect(outcome.processed).toBe(2);
    const select = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("status = 'pending'"),
    ) as [string, unknown[]];
    expect(select[1]).toEqual([USER, MAILBOX, MAX_PROCESSED_PER_POLL]);
    expect(MAX_PROCESSED_PER_POLL).toBe(100);
  });

  it("re-matches unmatched emails of the last 30 days and review emails whose request is gone, but not ones just processed", async () => {
    const h = setup();
    h.pending.push("r1");
    h.rematch.push("r1", "r2", "r3");
    await poll(h);
    const ids = h.pipeline.process.mock.calls.map((c) => [c[1], c[2]]);
    expect(ids).toEqual([
      ["r1", { onlyWhenStatusIn: ["pending"] }],
      ["r2", { onlyWhenStatusIn: ["unmatched", "review"] }],
      ["r3", { onlyWhenStatusIn: ["unmatched", "review"] }],
    ]);
    const select = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("r.status = 'unmatched'"),
    ) as [string, unknown[]];
    expect(select[0]).toContain("r.status = 'review'");
    expect(select[0]).toContain("NOT EXISTS");
    expect(select[0]).toContain("r.transaction_id IS NULL");
    expect(select[1]).toEqual([USER, MAILBOX, MAX_REMATCHED_PER_POLL, 30]);
  });

  it("an email the pipeline left alone is not counted as processed", async () => {
    const h = setup();
    h.pending.push("r1", "r2");
    h.pipeline.process
      .mockResolvedValueOnce({ unchanged: true } as never)
      .mockResolvedValueOnce({ unchanged: false } as never);
    await expect(poll(h)).resolves.toMatchObject({ processed: 1 });
  });

  it("one email failing does not stop the rest", async () => {
    const h = setup();
    h.pending.push("r1", "r2");
    h.pipeline.process
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ unchanged: false } as never);
    await expect(poll(h)).resolves.toMatchObject({ ok: true, processed: 1 });
    expect(h.pipeline.process).toHaveBeenCalledTimes(2);
  });
});

describe("the automatic AI step", () => {
  it("runs only for a mailbox in mode automatic", async () => {
    for (const aiMode of ["off", "on_demand"] as const) {
      const h = setup();
      h.mailbox.loadConnection.mockResolvedValue(loaded({ aiMode }));
      await poll(h);
      expect(h.ai.runAutomaticStep).not.toHaveBeenCalled();
    }
    const h = setup();
    h.mailbox.loadConnection.mockResolvedValue(loaded({ aiMode: "automatic" }));
    await poll(h);
    expect(h.ai.runAutomaticStep).toHaveBeenCalledWith(USER);
  });

  it("runs after the pipeline, so the requests it queued are answered in the same tick", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockResolvedValue(loaded({ aiMode: "automatic" }));
    h.pending.push("r1");
    await poll(h);
    expect(h.pipeline.process.mock.invocationCallOrder[0]).toBeLessThan(
      h.ai.runAutomaticStep.mock.invocationCallOrder[0],
    );
  });

  it("a failure of the step does not fail the poll", async () => {
    const h = setup();
    h.mailbox.loadConnection.mockResolvedValue(loaded({ aiMode: "automatic" }));
    h.ai.runAutomaticStep.mockRejectedValue(new Error("provider down"));
    await expect(poll(h)).resolves.toMatchObject({ ok: true });
  });
});

describe("Poll now", () => {
  it("polls the caller's mailbox under the caller's own identity and returns the counts", async () => {
    const h = setup();
    mockMailText(mail());
    h.imap.fetchSince.mockResolvedValue(
      fetched({ messages: [message("41")], highestUid: "41" }),
    );
    h.pending.push("r1");
    const seen: unknown[] = [];
    h.jobClaims.claimLease.mockImplementation(async () => {
      seen.push(getRequestContext());
      return TOKEN;
    });
    // no identity is seeded by pollNow itself: the request's interceptor did that
    await expect(h.service.pollNow(USER)).resolves.toEqual({
      ok: true,
      busy: false,
      fetched: 1,
      skipped: 0,
      processed: 1,
    });
    expect(seen).toEqual([undefined]);
    expect(h.mailbox.getView).toHaveBeenCalledWith(USER);
    expect(h.jobClaims.claimLease).toHaveBeenCalledWith(
      "email_receipt_poll",
      USER,
      MAILBOX,
      POLL_LEASE_MS,
    );
  });

  it("is a 404 when the user has no mailbox", async () => {
    const h = setup();
    h.mailbox.getView.mockResolvedValue(null);
    await expect(h.service.pollNow(USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.jobClaims.claimLease).not.toHaveBeenCalled();
  });

  it("a switched-off mailbox is an error result, not a poll", async () => {
    const h = setup();
    h.mailbox.getView.mockResolvedValue(view({ enabled: false }));
    await expect(h.service.pollNow(USER)).resolves.toMatchObject({
      ok: false,
      fetched: 0,
      error: expect.stringContaining("switched off"),
    });
    expect(h.jobClaims.claimLease).not.toHaveBeenCalled();
  });

  it("a poll already running (the cron, or another press) is a no-op with a message", async () => {
    const h = setup();
    h.jobClaims.claimLease.mockResolvedValue(null);
    await expect(h.service.pollNow(USER)).resolves.toMatchObject({
      ok: false,
      busy: true,
      error: expect.stringContaining("being read"),
    });
    expect(h.imap.fetchSince).not.toHaveBeenCalled();
  });

  it("returns the mailbox's own error when it cannot be read", async () => {
    const h = setup();
    h.imap.fetchSince.mockRejectedValue(new Error("tls"));
    await expect(h.service.pollNow(USER)).resolves.toMatchObject({
      ok: false,
      error: "Could not sign in",
    });
  });
});

/** Make the mocked mail extraction answer with `value` for every message. */
function mockMailText(value: ReturnType<typeof mail>): void {
  (extractMailText as jest.Mock).mockResolvedValue(value);
}
