import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRequestContext } from "../common/request-context";
import { JobClaimService } from "../common/jobs/job-claim.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BankSyncConsentReminderService } from "./bank-sync-consent-reminder.service";
import { BankSyncCronService } from "./bank-sync-cron.service";
import { BankSyncOutcomeNotifier } from "./bank-sync-outcome-notifier.service";
import { BankSyncService } from "./bank-sync.service";
import type { BankSyncResult } from "./bank-sync.types";
import { USER_ID } from "./bank-sync-testing";

/**
 * RLS smoke for the bank-sync crons (docs/specs/bank-sync.md section 11,
 * docs/specs/bank-sync-notifications.md section 8).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the
 * real implementation runs, so every database access on the cron path must find
 * the ambient identity its wrappers seed, or `withScopedDb` throws its
 * "DB access outside request/user/system context" error. `JobClaimService` is
 * the real one too, because a job claim is database access and the wrapper has
 * to go around it, not only around the body.
 */
describe("bank sync RLS context smoke (real withScopedDb)", () => {
  const BANK_ACCOUNT_ID = "b0b0b0b0-0000-4000-8000-000000000001";
  const CONNECTION_ID = "c0c0c0c0-0000-4000-8000-000000000001";
  const syncResult: BankSyncResult = {
    bankAccountId: BANK_ACCOUNT_ID,
    imported: 0,
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
  };

  /** Where a statement or a notification ran: system, or as which user. */
  interface Seen {
    what: string;
    system: boolean;
    userId?: string;
  }

  async function build() {
    const { manager, dataSource } = createScopedDbMocks();
    const seen: Seen[] = [];
    const record = (what: string) => {
      const context = getRequestContext();
      seen.push({
        what,
        system: context?.system === true,
        userId: context?.userId,
      });
    };
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      record(text);
      if (text.includes("SELECT DISTINCT c.user_id")) {
        return [{ user_id: USER_ID }];
      }
      if (text.includes("INSERT INTO job_claims")) return [{ id: "c1" }];
      if (text.includes("SELECT a.id, a.connection_id")) {
        return [
          {
            id: BANK_ACCOUNT_ID,
            connection_id: CONNECTION_ID,
            account_id: "m1",
            last_success_at: new Date("2026-09-20T05:00:00.000Z"),
            display_name: "Main account",
            identifier_masked: null,
            institution_name: "Test Bank",
            notify_success: "always",
            valid_until: null,
          },
        ];
      }
      if (text.includes("FROM bank_sync_connections")) {
        return [
          {
            id: CONNECTION_ID,
            user_id: USER_ID,
            institution_name: "Test Bank",
            status: "expired",
            valid_until: new Date(),
          },
        ];
      }
      if (text.includes("FROM users u")) {
        return [
          {
            user_id: USER_ID,
            timezone: "Europe/Warsaw",
            last_client_timezone: null,
          },
        ];
      }
      return [];
    });
    const dispatch = {
      notify: jest.fn(async (userId: string, input: { type: string }) => {
        record(`notify ${input.type}`);
        expect(getRequestContext()?.userId).toBe(userId);
        return null;
      }),
    };
    const bankSync: jest.Mocked<Pick<BankSyncService, "syncAccountEntry">> = {
      syncAccountEntry: jest.fn().mockResolvedValue(syncResult),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncCronService,
        BankSyncOutcomeNotifier,
        BankSyncConsentReminderService,
        JobClaimService,
        { provide: DataSource, useValue: dataSource },
        { provide: BankSyncService, useValue: bankSync },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    const cron = module.get(BankSyncCronService);
    const reminders = module.get(BankSyncConsentReminderService);
    const errorSpies = [
      cron,
      reminders,
      module.get(BankSyncOutcomeNotifier),
    ].map((service) =>
      jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined),
    );
    jest.spyOn(cron["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(reminders["logger"], "log").mockImplementation(() => undefined);
    return { cron, reminders, seen, errorSpies, bankSync, dispatch };
  }

  it("runs the daily sync's fan-out under the system context and each user's claim, reads and notifications under that user", async () => {
    const { cron, seen, errorSpies, bankSync, dispatch } = await build();

    await cron.handleDailySync();

    // A missing wrapper would surface as a logged "DB access outside ... context".
    for (const spy of errorSpies) expect(spy).not.toHaveBeenCalled();
    expect(
      seen.map((s) => [
        s.what.includes("job_claims")
          ? "claim"
          : s.what.startsWith("notify")
            ? s.what
            : "read",
        s.system,
        s.userId,
      ]),
    ).toEqual([
      ["read", true, undefined],
      ["claim", false, USER_ID],
      ["read", false, USER_ID],
      ["notify BANK_SYNC_IMPORTED", false, USER_ID],
    ]);
    expect(seen[0].what).toContain("SELECT DISTINCT c.user_id");
    expect(bankSync.syncAccountEntry).toHaveBeenCalledWith(
      USER_ID,
      BANK_ACCOUNT_ID,
      null,
    );
    expect(dispatch.notify).toHaveBeenCalledTimes(1);
  });

  it("runs the reminder fan-out and the timezone read under the system context, the expiry write and the notice under the user", async () => {
    const { reminders, seen, errorSpies, dispatch } = await build();

    await reminders.evaluate(new Date());

    for (const spy of errorSpies) expect(spy).not.toHaveBeenCalled();
    expect(
      seen.map((s) => [
        s.what.startsWith("notify") ? s.what : "read",
        s.system,
        s.userId,
      ]),
    ).toEqual([
      // The connections, then every user's effective timezone: cross-user.
      ["read", true, undefined],
      ["read", true, undefined],
      // The conditional `active` -> `expired` UPDATE is skipped for a connection
      // that is already `expired`; the notice itself is the user's.
      ["notify BANK_SYNC_CONSENT_EXPIRED", false, USER_ID],
    ]);
    expect(dispatch.notify).toHaveBeenCalledTimes(1);
  });

  it("refuses the same paths without their context wrappers", async () => {
    const { cron, reminders } = await build();
    await expect(cron["usersToSync"]()).rejects.toThrow(
      /outside request\/user\/system context/,
    );
    await expect(cron["syncUser"](USER_ID, "2026-09-30")).rejects.toThrow(
      /outside request\/user\/system context/,
    );
    await expect(reminders["candidates"](new Date())).rejects.toThrow(
      /outside request\/user\/system context/,
    );
    await expect(reminders["timezones"]()).rejects.toThrow(
      /outside request\/user\/system context/,
    );
    await expect(
      reminders["markExpired"]({
        id: CONNECTION_ID,
        userId: USER_ID,
        institutionName: "Test Bank",
        status: "active",
        validUntil: new Date(),
      }),
    ).rejects.toThrow(/outside request\/user\/system context/);
  });
});
