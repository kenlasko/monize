import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRequestContext } from "../common/request-context";
import { JobClaimService } from "../common/jobs/job-claim.service";
import {
  createJobClaimMock,
  JobClaimMock,
} from "../test-helpers/job-claim-testing";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BankSyncCronService } from "./bank-sync-cron.service";
import { BankSyncOutcomeNotifier } from "./bank-sync-outcome-notifier.service";
import type { BankSyncConnectionOutcome } from "./bank-sync-outcome-notifier.service";
import { BankSyncService } from "./bank-sync.service";
import type { BankSyncAccountFailure, BankSyncResult } from "./bank-sync.types";
import { OTHER_USER_ID, USER_ID } from "./bank-sync-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const ID_A = "b0b0b0b0-0000-4000-8000-00000000000a";
const ID_B = "b0b0b0b0-0000-4000-8000-00000000000b";
const ID_C = "b0b0b0b0-0000-4000-8000-00000000000c";

const CONNECTION_1 = "c0c0c0c0-0000-4000-8000-000000000001";
const CONNECTION_2 = "c0c0c0c0-0000-4000-8000-000000000002";
const CONFIRMED = new Date("2026-09-20T05:00:00.000Z");

const result = (bankAccountId: string, imported = 0): BankSyncResult => ({
  bankAccountId,
  imported,
  skipped: 0,
  excluded: 0,
  refused: {
    missing_date: 0,
    future_date: 0,
    invalid_amount: 0,
    unknown_direction: 0,
    currency_mismatch: 0,
  },
  pending: 0,
  beforeCutoff: 0,
  bankBalance: null,
});

const failure = (
  bankAccountId: string,
  code: string,
): BankSyncAccountFailure => ({
  bankAccountId,
  error: { code, message: `${code} message` },
});

/** One row of the linked-accounts query, as the database returns it. */
interface AccountRow {
  id: string;
  connection_id: string;
  account_id: string;
  last_success_at: Date | null;
  display_name: string | null;
  identifier_masked: string | null;
  institution_name: string;
  notify_success: string;
  valid_until: Date | null;
}

const accountRow = (
  id: string,
  over: Partial<AccountRow> = {},
): AccountRow => ({
  id,
  connection_id: CONNECTION_1,
  account_id: `m-${id}`,
  last_success_at: CONFIRMED,
  display_name: "Main account",
  identifier_masked: "**** 1234",
  institution_name: "Test Bank",
  notify_success: "when_imported",
  valid_until: new Date("2027-01-01T00:00:00.000Z"),
  ...over,
});

describe("BankSyncCronService", () => {
  const { manager, dataSource } = createScopedDbMocks();
  const bankSync: jest.Mocked<Pick<BankSyncService, "syncAccountEntry">> = {
    syncAccountEntry: jest.fn(),
  };
  const notifier: jest.Mocked<Pick<BankSyncOutcomeNotifier, "report">> = {
    report: jest.fn(),
  };
  let jobClaims: JobClaimMock;
  let service: BankSyncCronService;

  /** The users the fan-out finds, and each user's linked bank accounts. */
  let users: string[];
  let accountsByUser: Record<string, AccountRow[]>;

  beforeEach(async () => {
    jest.useFakeTimers({
      now: new Date("2026-09-30T05:17:00.000Z"),
      doNotFake: [
        "nextTick",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "hrtime",
        "performance",
      ],
    });
    jest.clearAllMocks();
    jobClaims = createJobClaimMock();
    users = [USER_ID, OTHER_USER_ID];
    accountsByUser = {
      [USER_ID]: [accountRow(ID_A), accountRow(ID_B)],
      [OTHER_USER_ID]: [accountRow(ID_C, { connection_id: CONNECTION_2 })],
    };
    manager.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (String(sql).includes("SELECT DISTINCT c.user_id")) {
          return users.map((user_id) => ({ user_id }));
        }
        if (String(sql).includes("SELECT a.id, a.connection_id")) {
          return accountsByUser[params![0] as string] ?? [];
        }
        return [];
      },
    );
    bankSync.syncAccountEntry.mockImplementation(async (_user, id) =>
      result(id),
    );
    notifier.report.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncCronService,
        { provide: DataSource, useValue: dataSource },
        { provide: JobClaimService, useValue: jobClaims },
        { provide: BankSyncService, useValue: bankSync },
        { provide: BankSyncOutcomeNotifier, useValue: notifier },
      ],
    }).compile();
    service = module.get(BankSyncCronService);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The outcomes handed to the notifier, in order. */
  const reported = (): BankSyncConnectionOutcome[] =>
    notifier.report.mock.calls.map((call) => call[1]);

  it("lists users with an active, auto-sync connection that has a linked bank account", async () => {
    await service.handleDailySync();
    const sql = String(manager.query.mock.calls[0][0]);
    expect(sql).toContain("SELECT DISTINCT c.user_id");
    expect(sql).toContain("c.status = 'active'");
    expect(sql).toContain("c.auto_sync = true");
    expect(sql).toContain("a.account_id IS NOT NULL");
  });

  it("claims each user once for the UTC day, then syncs their linked accounts unattended, in order", async () => {
    await service.handleDailySync();

    expect(jobClaims.claimOnce.mock.calls).toEqual([
      ["bank_sync_daily", USER_ID, "2026-09-30"],
      ["bank_sync_daily", OTHER_USER_ID, "2026-09-30"],
    ]);
    expect(bankSync.syncAccountEntry.mock.calls).toEqual([
      [USER_ID, ID_A, null],
      [USER_ID, ID_B, null],
      [OTHER_USER_ID, ID_C, null],
    ]);
  });

  it("runs each user's claim and syncs under that user's own identity", async () => {
    const seen: Array<[string, string | undefined]> = [];
    jobClaims.claimOnce.mockImplementation(async (_type, userId) => {
      seen.push(["claim", getRequestContext()?.userId]);
      expect(getRequestContext()?.userId).toBe(userId);
      return true;
    });
    bankSync.syncAccountEntry.mockImplementation(async (userId, id) => {
      seen.push(["sync", getRequestContext()?.userId]);
      expect(getRequestContext()?.userId).toBe(userId);
      return result(id);
    });
    notifier.report.mockImplementation(async (userId) => {
      seen.push(["report", getRequestContext()?.userId]);
      expect(getRequestContext()?.userId).toBe(userId);
    });

    await service.handleDailySync();

    expect(seen.map(([, user]) => user)).toEqual([
      USER_ID,
      USER_ID,
      USER_ID,
      USER_ID,
      OTHER_USER_ID,
      OTHER_USER_ID,
      OTHER_USER_ID,
    ]);
  });

  it("syncs nobody a second replica already claimed for the day", async () => {
    jobClaims.claimOnce.mockResolvedValue(false);
    await service.handleDailySync();
    expect(bankSync.syncAccountEntry).not.toHaveBeenCalled();
    expect(notifier.report).not.toHaveBeenCalled();
  });

  it("claims once per user per day: a second run the same day syncs nothing", async () => {
    const claimed = new Set<string>();
    jobClaims.claimOnce.mockImplementation(async (type, userId, key) => {
      const id = `${type}:${userId}:${key}`;
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    });

    await service.handleDailySync();
    expect(bankSync.syncAccountEntry).toHaveBeenCalledTimes(3);

    await service.handleDailySync();
    expect(bankSync.syncAccountEntry).toHaveBeenCalledTimes(3);

    // The next UTC day is a new key.
    jest.setSystemTime(new Date("2026-10-01T05:17:00.000Z"));
    await service.handleDailySync();
    expect(bankSync.syncAccountEntry).toHaveBeenCalledTimes(6);
  });

  it("does not hand the claim back when accounts fail: a retry would spend the bank's allowance", async () => {
    bankSync.syncAccountEntry.mockImplementation(async (_user, id) =>
      failure(id, "unavailable"),
    );
    await service.handleDailySync();
    expect(jobClaims.releasePermanentClaim).not.toHaveBeenCalled();
    expect(jobClaims.releaseLease).not.toHaveBeenCalled();
  });

  it("carries on with the user's next account after one fails", async () => {
    bankSync.syncAccountEntry.mockImplementation(async (_user, id) =>
      id === ID_A ? failure(id, "unavailable") : result(id),
    );
    await service.handleDailySync();
    expect(bankSync.syncAccountEntry.mock.calls.map((call) => call[1])).toEqual(
      [ID_A, ID_B, ID_C],
    );
  });

  it("isolates a failing user, pre-checks included: the claim itself may throw", async () => {
    jobClaims.claimOnce.mockImplementation(async (_type, userId) => {
      if (userId === USER_ID) throw new Error("claim failed");
      return true;
    });
    await service.handleDailySync();
    expect(bankSync.syncAccountEntry.mock.calls).toEqual([
      [OTHER_USER_ID, ID_C, null],
    ]);
  });

  it("isolates a user whose account list cannot be read", async () => {
    manager.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (String(sql).includes("SELECT DISTINCT c.user_id")) {
          return users.map((user_id) => ({ user_id }));
        }
        if (params![0] === USER_ID) throw new Error("db hiccup");
        return [accountRow(ID_C, { connection_id: CONNECTION_2 })];
      },
    );
    await service.handleDailySync();
    expect(bankSync.syncAccountEntry.mock.calls).toEqual([
      [OTHER_USER_ID, ID_C, null],
    ]);
  });

  it("logs and stops when the fan-out itself fails, without throwing", async () => {
    manager.query.mockRejectedValue(new Error("db down"));
    await expect(service.handleDailySync()).resolves.toBeUndefined();
    expect(jobClaims.claimOnce).not.toHaveBeenCalled();
    expect(service["logger"].error).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no user has a connection to sync", async () => {
    users = [];
    await service.handleDailySync();
    expect(jobClaims.claimOnce).not.toHaveBeenCalled();
    expect(service["logger"].log).not.toHaveBeenCalled();
  });

  describe("a bank account that still needs its preview (spec section 7a)", () => {
    it("is never read: the daily sync skips it, the others sync, and nothing is imported for it", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A),
        accountRow(ID_B, { last_success_at: null }),
      ];
      await service.handleDailySync();

      expect(
        bankSync.syncAccountEntry.mock.calls.map((call) => call[1]),
      ).toEqual([ID_A, ID_C]);
      // Skipped, not failed: the person has not been asked to repair anything.
      expect(reported()[0].failures).toEqual([]);
      expect(reported()[0].synced).toHaveLength(1);
    });

    it("syncs nothing for a user whose every account is unconfirmed, and says nothing about it", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A, { last_success_at: null }),
        accountRow(ID_B, { last_success_at: null }),
      ];
      accountsByUser[OTHER_USER_ID] = [];
      await service.handleDailySync();
      expect(bankSync.syncAccountEntry).not.toHaveBeenCalled();
      expect(reported().every((o) => o.synced.length === 0)).toBe(true);
      expect(reported().every((o) => o.failures.length === 0)).toBe(true);
    });
  });

  describe("outcomes (docs/specs/bank-sync-notifications.md section 5)", () => {
    it("reports one outcome per connection, after all its accounts were tried", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A, { notify_success: "always" }),
        accountRow(ID_B, { notify_success: "always" }),
      ];
      bankSync.syncAccountEntry.mockImplementation(async (_u, id) =>
        result(id, id === ID_A ? 2 : 3),
      );
      await service.handleDailySync();

      expect(notifier.report.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        [USER_ID, "2026-09-30"],
        [OTHER_USER_ID, "2026-09-30"],
      ]);
      expect(reported()[0]).toEqual({
        connectionId: CONNECTION_1,
        institutionName: "Test Bank",
        notifySuccess: "always",
        validUntil: new Date("2027-01-01T00:00:00.000Z"),
        synced: [
          { imported: 2, skipped: 0 },
          { imported: 3, skipped: 0 },
        ],
        failures: [],
      });
    });

    it("keeps a connection's accounts together and its connections apart", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A),
        accountRow(ID_B, { connection_id: CONNECTION_2 }),
        accountRow(ID_C),
      ];
      await service.handleDailySync();
      const mine = reported().filter((o) => o.synced.length > 0);
      expect(mine.map((o) => [o.connectionId, o.synced.length])).toEqual([
        [CONNECTION_1, 2],
        [CONNECTION_2, 1],
        [CONNECTION_2, 1],
      ]);
    });

    it("names a failed account by the bank's label, else its masked identifier, with the failure's code", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A),
        accountRow(ID_B, { display_name: null }),
      ];
      bankSync.syncAccountEntry.mockImplementation(async (_u, id) =>
        failure(id, "rate_limited"),
      );
      await service.handleDailySync();
      expect(reported()[0].failures).toEqual([
        { bankAccountId: ID_A, label: "Main account", code: "rate_limited" },
        { bankAccountId: ID_B, label: "**** 1234", code: "rate_limited" },
      ]);
      expect(JSON.stringify(reported())).not.toMatch(
        /[A-Z]{2}\d{2}[A-Z0-9]{10,}/,
      );
    });

    it("says nothing about an account another sync is running, while a real failure beside it is still reported", async () => {
      accountsByUser[USER_ID] = [accountRow(ID_A), accountRow(ID_B)];
      bankSync.syncAccountEntry.mockImplementation(async (_u, id) =>
        failure(id, id === ID_A ? "sync_running" : "unavailable"),
      );
      await service.handleDailySync();

      // A is a manual sync's to report: not a failure, not a success.
      expect(reported()[0].failures).toEqual([
        { bankAccountId: ID_B, label: "Main account", code: "unavailable" },
      ]);
      expect(reported()[0].synced).toEqual([]);
      expect(service["logger"].log).toHaveBeenCalledWith(
        expect.stringContaining(`${ID_A}: another sync of it is running`),
      );
      expect(service["logger"].warn).not.toHaveBeenCalled();
    });

    it("reports nothing at all for a connection whose only account is being synced by hand", async () => {
      accountsByUser[USER_ID] = [accountRow(ID_A)];
      bankSync.syncAccountEntry.mockImplementation(async (_u, id) =>
        failure(id, "sync_running"),
      );
      await service.handleDailySync();
      expect(reported()[0]).toMatchObject({ synced: [], failures: [] });
    });

    it("never puts a label shaped like an account number into the outcome", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A, {
          display_name: "PL61109010140000071219812874",
          identifier_masked: "PL61 **** 2874",
        }),
      ];
      bankSync.syncAccountEntry.mockImplementation(async (_u, id) =>
        failure(id, "unavailable"),
      );
      await service.handleDailySync();
      expect(reported()[0].failures).toEqual([
        { bankAccountId: ID_A, label: "PL61 **** 2874", code: "unavailable" },
      ]);
    });

    it("stops reading a connection once the bank says the session is gone", async () => {
      accountsByUser[USER_ID] = [
        accountRow(ID_A),
        accountRow(ID_B),
        accountRow(ID_C, { connection_id: CONNECTION_2 }),
      ];
      bankSync.syncAccountEntry.mockImplementation(async (_u, id) =>
        id === ID_A ? failure(id, "session_expired") : result(id),
      );
      await service.handleDailySync();

      // B shares A's connection, so it is not attempted (it would be refused for
      // the same reason); C is another connection and still syncs.
      expect(
        bankSync.syncAccountEntry.mock.calls
          .filter((c) => c[0] === USER_ID)
          .map((c) => c[1]),
      ).toEqual([ID_A, ID_C]);
      expect(reported()[0].failures).toEqual([
        expect.objectContaining({
          bankAccountId: ID_A,
          code: "session_expired",
        }),
      ]);
    });

    it("still reports the day when the notifier throws, and goes on to the next user", async () => {
      notifier.report.mockRejectedValueOnce(new Error("notify down"));
      await service.handleDailySync();
      expect(notifier.report).toHaveBeenCalledTimes(2);
      expect(
        bankSync.syncAccountEntry.mock.calls.map((call) => call[1]),
      ).toEqual([ID_A, ID_B, ID_C]);
    });
  });
});
