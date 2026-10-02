import { Test } from "@nestjs/testing";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  BankSyncOutcomeNotifier,
  CONSENT_GONE_CODE,
} from "./bank-sync-outcome-notifier.service";
import type { BankSyncConnectionOutcome } from "./bank-sync-outcome-notifier.service";
import { CONNECTION_ID, USER_ID } from "./bank-sync-testing";

const DAY = "2026-09-30";

const outcome = (
  over: Partial<BankSyncConnectionOutcome> = {},
): BankSyncConnectionOutcome => ({
  connectionId: CONNECTION_ID,
  institutionName: "Test Bank",
  notifySuccess: "when_imported",
  validUntil: new Date("2027-01-01T00:00:00.000Z"),
  synced: [{ imported: 2, skipped: 1 }],
  failures: [],
  ...over,
});

describe("BankSyncOutcomeNotifier", () => {
  const dispatch = { notify: jest.fn() };
  let notifier: BankSyncOutcomeNotifier;

  beforeEach(async () => {
    jest.clearAllMocks();
    dispatch.notify.mockResolvedValue({ id: "n1" });
    const module = await Test.createTestingModule({
      providers: [
        BankSyncOutcomeNotifier,
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    notifier = module.get(BankSyncOutcomeNotifier);
    jest.spyOn(notifier["logger"], "error").mockImplementation(() => undefined);
  });

  const written = () =>
    dispatch.notify.mock.calls.map((call) => call[1] as { type: string });
  const types = () => written().map((input) => input.type);

  describe("the success mode (spec section 3)", () => {
    // mode x (rows imported | nothing imported); a run in which an account synced.
    it.each([
      ["always", 3, [NotificationType.BANK_SYNC_IMPORTED]],
      ["always", 0, [NotificationType.BANK_SYNC_IMPORTED]],
      ["when_imported", 3, [NotificationType.BANK_SYNC_IMPORTED]],
      ["when_imported", 0, []],
      ["never", 3, []],
      ["never", 0, []],
    ] as const)(
      "%s with %i imported writes %j",
      async (mode, imported, expected) => {
        await notifier.report(
          USER_ID,
          outcome({ notifySuccess: mode, synced: [{ imported, skipped: 0 }] }),
          DAY,
        );
        expect(types()).toEqual(expected);
      },
    );

    it("adds the accounts' counts together into one notification per connection", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          synced: [
            { imported: 2, skipped: 1 },
            { imported: 5, skipped: 0 },
          ],
        }),
        DAY,
      );
      expect(dispatch.notify).toHaveBeenCalledTimes(1);
      const [userId, input] = dispatch.notify.mock.calls[0];
      expect(userId).toBe(USER_ID);
      expect(input).toMatchObject({
        type: NotificationType.BANK_SYNC_IMPORTED,
        severity: NotificationSeverity.SUCCESS,
        data: {
          connectionId: CONNECTION_ID,
          institutionName: "Test Bank",
          imported: 7,
          skipped: 1,
          accounts: 2,
        },
        dedupeKey: `bsc:imp:${CONNECTION_ID}:${DAY}`,
      });
    });

    it("does not call a run in which no account synced a success, even for 'always'", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          notifySuccess: "always",
          synced: [],
          failures: [
            { bankAccountId: "b1", label: "Main", code: "unavailable" },
          ],
        }),
        DAY,
      );
      expect(types()).toEqual([NotificationType.BANK_SYNC_FAILED]);
    });

    it("writes no failure for an account skipped because another sync was running, but still reports a real failure", async () => {
      // The cron leaves a lease-refused account out of `failures`, so an outcome
      // with only that account is empty and one with a real failure beside it
      // carries just the real one.
      await notifier.report(
        USER_ID,
        outcome({ notifySuccess: "always", synced: [], failures: [] }),
        DAY,
      );
      expect(dispatch.notify).not.toHaveBeenCalled();
      await notifier.report(
        USER_ID,
        outcome({
          synced: [],
          failures: [
            { bankAccountId: "b2", label: "Savings", code: "unavailable" },
          ],
        }),
        DAY,
      );
      expect(types()).toEqual([NotificationType.BANK_SYNC_FAILED]);
    });

    it("writes nothing for a connection whose accounts were all skipped", async () => {
      await notifier.report(
        USER_ID,
        outcome({ notifySuccess: "always", synced: [], failures: [] }),
        DAY,
      );
      expect(dispatch.notify).not.toHaveBeenCalled();
    });
  });

  describe("failures", () => {
    it("lists the failed accounts by label and code, never an account number", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          synced: [],
          failures: [
            {
              bankAccountId: "b1",
              label: "Main account",
              code: "rate_limited",
            },
            { bankAccountId: "b2", label: "**** 1234", code: "unavailable" },
          ],
        }),
        DAY,
      );
      expect(dispatch.notify).toHaveBeenCalledTimes(1);
      const input = dispatch.notify.mock.calls[0][1];
      expect(input).toMatchObject({
        type: NotificationType.BANK_SYNC_FAILED,
        severity: NotificationSeverity.WARNING,
        data: {
          failures: [
            {
              bankAccountId: "b1",
              label: "Main account",
              code: "rate_limited",
            },
            { bankAccountId: "b2", label: "**** 1234", code: "unavailable" },
          ],
        },
        dedupeKey: `bsc:fail:${CONNECTION_ID}:${DAY}`,
      });
    });

    it("writes a failure with the credentials code when the credentials cannot be used", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          synced: [],
          failures: [{ bankAccountId: "b1", label: null, code: "credentials" }],
        }),
        DAY,
      );
      expect(dispatch.notify.mock.calls[0][1]).toMatchObject({
        type: NotificationType.BANK_SYNC_FAILED,
        data: { failures: [{ code: "credentials" }] },
      });
    });

    it("reports both what synced and what failed when a connection is half and half", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          failures: [
            { bankAccountId: "b2", label: "Savings", code: "refused" },
          ],
        }),
        DAY,
      );
      expect(types()).toEqual([
        NotificationType.BANK_SYNC_FAILED,
        NotificationType.BANK_SYNC_IMPORTED,
      ]);
    });
  });

  describe("an ended consent", () => {
    it("writes the expiry notice under the reminder service's key, and not a failure for the account that hit it", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          synced: [],
          failures: [
            { bankAccountId: "b1", label: "Main", code: CONSENT_GONE_CODE },
          ],
        }),
        DAY,
      );
      expect(dispatch.notify).toHaveBeenCalledTimes(1);
      expect(dispatch.notify.mock.calls[0][1]).toMatchObject({
        type: NotificationType.BANK_SYNC_CONSENT_EXPIRED,
        severity: NotificationSeverity.CRITICAL,
        dedupeKey: `bsc:expd:${CONNECTION_ID}:2027-01-01`,
      });
    });

    it("still reports the other accounts' failures beside the expiry notice", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          synced: [],
          failures: [
            { bankAccountId: "b1", label: "Main", code: CONSENT_GONE_CODE },
            { bankAccountId: "b2", label: "Other", code: "unavailable" },
          ],
        }),
        DAY,
      );
      expect(types()).toEqual([
        NotificationType.BANK_SYNC_CONSENT_EXPIRED,
        NotificationType.BANK_SYNC_FAILED,
      ]);
      expect(dispatch.notify.mock.calls[1][1].data.failures).toEqual([
        { bankAccountId: "b2", label: "Other", code: "unavailable" },
      ]);
    });

    it("keys a connection that reported no end on 'none'", async () => {
      await notifier.report(
        USER_ID,
        outcome({
          validUntil: null,
          synced: [],
          failures: [
            { bankAccountId: "b1", label: null, code: CONSENT_GONE_CODE },
          ],
        }),
        DAY,
      );
      expect(dispatch.notify.mock.calls[0][1].dedupeKey).toBe(
        `bsc:expd:${CONNECTION_ID}:none`,
      );
    });
  });

  it("never throws and goes on to the next notification when one cannot be written", async () => {
    dispatch.notify.mockRejectedValueOnce(new Error("db down"));
    await expect(
      notifier.report(
        USER_ID,
        outcome({
          failures: [
            { bankAccountId: "b2", label: "Savings", code: "refused" },
          ],
        }),
        DAY,
      ),
    ).resolves.toBeUndefined();
    // The failure notice threw; the success notice was still attempted.
    expect(dispatch.notify).toHaveBeenCalledTimes(2);
    expect(notifier["logger"].error).toHaveBeenCalledTimes(1);
  });

  it("treats a lost insert (null) as the other replica's, not an error", async () => {
    dispatch.notify.mockResolvedValue(null);
    await expect(
      notifier.report(USER_ID, outcome(), DAY),
    ).resolves.toBeUndefined();
    expect(notifier["logger"].error).not.toHaveBeenCalled();
  });
});
