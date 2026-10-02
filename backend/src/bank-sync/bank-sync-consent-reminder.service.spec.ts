import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRequestContext } from "../common/request-context";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BankSyncConsentReminderService } from "./bank-sync-consent-reminder.service";
import { CONNECTION_ID, OTHER_USER_ID, USER_ID } from "./bank-sync-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const OTHER_CONNECTION = "c0c0c0c0-0000-4000-8000-000000000002";

interface Candidate {
  id: string;
  user_id: string;
  institution_name: string;
  status: "active" | "expired";
  valid_until: Date;
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: CONNECTION_ID,
  user_id: USER_ID,
  institution_name: "Test Bank",
  status: "active",
  valid_until: new Date("2027-03-30T10:00:00.000Z"),
  ...over,
});

/** The daily run, 06:23 UTC. */
const runAt = (day: string) => new Date(`${day}T06:23:00.000Z`);

describe("BankSyncConsentReminderService", () => {
  const { manager, dataSource } = createScopedDbMocks();
  const dispatch = { notify: jest.fn() };
  let service: BankSyncConsentReminderService;

  let connections: Candidate[];
  /** user id -> [timezone, last_client_timezone] */
  let zones: Record<string, [string | null, string | null]>;
  let markExpiredRows: number;

  beforeEach(async () => {
    jest.clearAllMocks();
    connections = [candidate()];
    zones = { [USER_ID]: ["UTC", null], [OTHER_USER_ID]: ["UTC", null] };
    markExpiredRows = 1;
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM bank_sync_connections")) return connections;
      if (text.includes("FROM users u")) {
        return Object.entries(zones).map(([user_id, [timezone, cached]]) => ({
          user_id,
          timezone,
          last_client_timezone: cached,
        }));
      }
      if (text.includes("UPDATE bank_sync_connections")) {
        return Array.from({ length: markExpiredRows }, () => ({
          id: CONNECTION_ID,
        }));
      }
      return [];
    });
    dispatch.notify.mockResolvedValue({ id: "n1" });
    const module = await Test.createTestingModule({
      providers: [
        BankSyncConsentReminderService,
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(BankSyncConsentReminderService);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  /** What the run wrote, as [user, type, dedupe key]. */
  const written = () =>
    dispatch.notify.mock.calls.map((call) => [
      call[0],
      call[1].type,
      call[1].dedupeKey,
    ]);

  const key = (mark: number) => `bsc:exp:${CONNECTION_ID}:2027-03-30:${mark}`;
  const EXPIRED_KEY = `bsc:expd:${CONNECTION_ID}:2027-03-30`;

  describe("the schedule", () => {
    it("is a daily cron at 06:23 UTC", () => {
      const source = readFileSync(
        join(__dirname, "bank-sync-consent-reminder.service.ts"),
        "utf8",
      );
      expect(source).toContain('@Cron("23 6 * * *", { timeZone: "UTC" })');
    });

    it("reads as candidates the connections ending between a week ago and 32 days ahead, a superset of the 30-day mark", async () => {
      const now = runAt("2027-03-01");
      await service.evaluate(now);
      const call = manager.query.mock.calls.find((c) =>
        String(c[0]).includes("FROM bank_sync_connections"),
      ) as [string, [Date, Date]];
      expect(String(call[0])).toContain("status IN ('active', 'expired')");
      expect(String(call[0])).toContain("valid_until BETWEEN $1 AND $2");
      expect(call[1][0].toISOString()).toBe("2027-02-22T06:23:00.000Z");
      expect(call[1][1].toISOString()).toBe("2027-04-02T06:23:00.000Z");
    });

    it("runs through the cron handler with the real clock and never throws", async () => {
      manager.query.mockRejectedValue(new Error("db down"));
      await expect(service.handleDailyReminders()).resolves.toBeUndefined();
      expect(service["logger"].error).toHaveBeenCalledTimes(1);
    });
  });

  describe("the thresholds, day by day (spec section 4's example)", () => {
    // Consent valid until 2027-03-30 10:00 UTC, the user counting in UTC.
    it.each([
      ["2027-02-27", null], // 31 days left: nothing yet
      ["2027-02-28", 30],
      ["2027-03-01", 30],
      ["2027-03-15", 30],
      ["2027-03-16", 14],
      ["2027-03-22", 14],
      ["2027-03-23", 7],
      ["2027-03-26", 7],
      ["2027-03-27", 3],
      ["2027-03-28", 2],
      ["2027-03-29", 1],
      ["2027-03-30", 0],
    ] as const)("on %s the mark owed is %s", async (day, mark) => {
      await service.evaluate(runAt(day));
      expect(written()).toEqual(
        mark === null
          ? []
          : [[USER_ID, NotificationType.BANK_SYNC_CONSENT_EXPIRING, key(mark)]],
      );
    });

    it("says the consent has ended on the day after, once", async () => {
      await service.evaluate(runAt("2027-03-31"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.BANK_SYNC_CONSENT_EXPIRED, EXPIRED_KEY],
      ]);
    });

    it("fires only the latest mark after a missed run, not the skipped ones", async () => {
      // The run on 03-23 (7) is the last before an outage; the next is 03-29.
      await service.evaluate(runAt("2027-03-29"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.BANK_SYNC_CONSENT_EXPIRING, key(1)],
      ]);
    });

    it("fires the same key on every day of one mark, which the dedupe index turns into one row", async () => {
      for (const day of ["2027-03-23", "2027-03-24", "2027-03-25"]) {
        await service.evaluate(runAt(day));
      }
      expect(new Set(written().map((w) => w[2]))).toEqual(new Set([key(7)]));
      expect(dispatch.notify).toHaveBeenCalledTimes(3);
    });

    it("carries the mark and the end date as facts, the severity of the mark, and the target", async () => {
      await service.evaluate(runAt("2027-03-27"));
      const input = dispatch.notify.mock.calls[0][1];
      expect(input).toMatchObject({
        severity: NotificationSeverity.WARNING,
        target: "/settings/bank-sync",
        periodStart: "2027-03-27",
        data: {
          connectionId: CONNECTION_ID,
          institutionName: "Test Bank",
          validUntil: "2027-03-30",
          threshold: 3,
        },
      });
    });
  });

  describe("renewal", () => {
    it("starts new keys: the old period fires nothing more and the next mark is the new period's", async () => {
      await service.evaluate(runAt("2027-03-25"));
      // Renewed that day to 2027-09-21; the connection is active again.
      connections = [
        candidate({ valid_until: new Date("2027-09-21T10:00:00.000Z") }),
      ];
      await service.evaluate(runAt("2027-03-26"));
      await service.evaluate(runAt("2027-08-22"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.BANK_SYNC_CONSENT_EXPIRING, key(7)],
        // 03-26 is 179 days from the new end: nothing, and the candidate query
        // would not even return it. The next reminder is 30 days out.
        [
          USER_ID,
          NotificationType.BANK_SYNC_CONSENT_EXPIRING,
          `bsc:exp:${CONNECTION_ID}:2027-09-21:30`,
        ],
      ]);
    });
  });

  describe("an ended consent", () => {
    it("moves an elapsed active connection to expired with a conditional UPDATE, then notifies", async () => {
      connections = [
        candidate({ valid_until: new Date("2027-03-29T10:00:00.000Z") }),
      ];
      const tally = await service.evaluate(runAt("2027-03-30"));

      const update = manager.query.mock.calls.find((c) =>
        String(c[0]).includes("UPDATE bank_sync_connections"),
      ) as [string, unknown[]];
      expect(String(update[0])).toContain("status = 'active'");
      expect(String(update[0])).toContain("valid_until < now()");
      expect(update[1]).toEqual([CONNECTION_ID, USER_ID]);
      expect(tally).toEqual({ written: 1, expired: 1 });
      expect(written()).toEqual([
        [
          USER_ID,
          NotificationType.BANK_SYNC_CONSENT_EXPIRED,
          `bsc:expd:${CONNECTION_ID}:2027-03-29`,
        ],
      ]);
    });

    it("does not call a consent that ended hours ago 'ends today'", async () => {
      // 05:00 UTC today is before the 06:23 run: the calendar day says 0 days,
      // the instant says it is over. The instant decides.
      connections = [
        candidate({ valid_until: new Date("2027-03-30T05:00:00.000Z") }),
      ];
      await service.evaluate(runAt("2027-03-30"));
      expect(written().map((w) => w[1])).toEqual([
        NotificationType.BANK_SYNC_CONSENT_EXPIRED,
      ]);
    });

    it("counts a connection another replica already moved, and still writes the notice only once through the dedupe key", async () => {
      markExpiredRows = 0;
      connections = [
        candidate({ valid_until: new Date("2027-03-29T10:00:00.000Z") }),
      ];
      const tally = await service.evaluate(runAt("2027-03-30"));
      expect(tally.expired).toBe(0);
      expect(dispatch.notify).toHaveBeenCalledTimes(1);
    });

    it("notifies an already-expired connection without touching its status", async () => {
      connections = [candidate({ status: "expired" })];
      await service.evaluate(runAt("2027-03-31"));
      expect(
        manager.query.mock.calls.some((c) =>
          String(c[0]).includes("UPDATE bank_sync_connections"),
        ),
      ).toBe(false);
      expect(written()).toEqual([
        [USER_ID, NotificationType.BANK_SYNC_CONSENT_EXPIRED, EXPIRED_KEY],
      ]);
    });

    it("tells of a consent the bank ended early, with the same key the daily sync uses", async () => {
      // Still 10 days from its stated end, but the connection is `expired`.
      connections = [candidate({ status: "expired" })];
      await service.evaluate(runAt("2027-03-20"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.BANK_SYNC_CONSENT_EXPIRED, EXPIRED_KEY],
      ]);
    });

    it("counts only what this replica wrote: a lost insert is the other replica's", async () => {
      dispatch.notify.mockResolvedValue(null);
      const tally = await service.evaluate(runAt("2027-03-27"));
      expect(tally).toEqual({ written: 0, expired: 0 });
    });
  });

  describe("days are counted in the user's timezone", () => {
    // Ends 23:30 UTC on 03-30, which is already 03-31 in Warsaw (UTC+2 after
    // the 03-28 change): 8 days from 03-23 there, 7 in UTC.
    const lateEnd = new Date("2027-03-30T23:30:00.000Z");

    it("uses the stored timezone, and says the date the user lives", async () => {
      connections = [candidate({ valid_until: lateEnd })];
      zones[USER_ID] = ["Europe/Warsaw", null];
      await service.evaluate(runAt("2027-03-23"));
      const input = dispatch.notify.mock.calls[0][1];
      expect(input.dedupeKey).toBe(key(14));
      expect(input.data).toMatchObject({
        validUntil: "2027-03-31",
        threshold: 14,
      });
    });

    it("counts in UTC for a user whose zone is the browser sentinel and unknown", async () => {
      connections = [candidate({ valid_until: lateEnd })];
      zones[USER_ID] = ["browser", null];
      await service.evaluate(runAt("2027-03-23"));
      expect(written()[0][2]).toBe(key(7));
    });

    it("falls back to the last seen client zone", async () => {
      connections = [candidate({ valid_until: lateEnd })];
      zones[USER_ID] = ["browser", "Europe/Warsaw"];
      await service.evaluate(runAt("2027-03-23"));
      expect(written()[0][2]).toBe(key(14));
    });

    it("counts in UTC rather than skipping when the stored zone does not resolve", async () => {
      connections = [candidate({ valid_until: lateEnd })];
      zones[USER_ID] = ["Mars/Olympus", null];
      await service.evaluate(runAt("2027-03-23"));
      expect(written()[0][2]).toBe(key(7));
    });

    it("keys the period on the UTC date, so a zone change does not repeat a reminder", async () => {
      connections = [candidate({ valid_until: lateEnd })];
      zones[USER_ID] = ["Europe/Warsaw", null];
      await service.evaluate(runAt("2027-03-24"));
      zones[USER_ID] = ["UTC", null];
      await service.evaluate(runAt("2027-03-24"));
      // Both runs name the 03-30 period; only the mark can differ.
      expect(
        written().every((w) => (w[2] as string).includes("2027-03-30")),
      ).toBe(true);
    });
  });

  describe("identity and isolation", () => {
    it("writes each notice under its owner's identity", async () => {
      connections = [
        candidate(),
        candidate({ id: OTHER_CONNECTION, user_id: OTHER_USER_ID }),
      ];
      const seen: Array<[string, string | undefined]> = [];
      dispatch.notify.mockImplementation(async (userId: string) => {
        seen.push([userId, getRequestContext()?.userId]);
        return { id: "n" };
      });
      await service.evaluate(runAt("2027-03-27"));
      expect(seen).toEqual([
        [USER_ID, USER_ID],
        [OTHER_USER_ID, OTHER_USER_ID],
      ]);
    });

    it("groups a user's connections under one identity and goes on after one fails", async () => {
      connections = [
        candidate(),
        candidate({ id: OTHER_CONNECTION }),
        candidate({
          id: "c0c0c0c0-0000-4000-8000-000000000003",
          user_id: OTHER_USER_ID,
        }),
      ];
      dispatch.notify.mockRejectedValueOnce(new Error("first fails"));
      await service.evaluate(runAt("2027-03-27"));
      // The first connection's write threw; the second of the same user and the
      // other user's were still written.
      expect(dispatch.notify).toHaveBeenCalledTimes(3);
      expect(service["logger"].error).toHaveBeenCalledTimes(1);
    });

    it("goes on to the next user when the whole of one user's pass fails", async () => {
      connections = [
        candidate(),
        candidate({ id: OTHER_CONNECTION, user_id: OTHER_USER_ID }),
      ];
      // The first user's connection fails inside the loop; isolation is per
      // connection, so the other user still gets theirs.
      dispatch.notify.mockImplementation(async (userId: string) => {
        if (userId === USER_ID) throw new Error("boom");
        return { id: "n" };
      });
      await service.evaluate(runAt("2027-03-27"));
      expect(dispatch.notify).toHaveBeenCalledTimes(2);
    });

    it("writes nothing for a connection outside the window the query returns", async () => {
      connections = [
        candidate({ valid_until: new Date("2027-06-01T00:00:00.000Z") }),
      ];
      await service.evaluate(runAt("2027-03-01"));
      expect(dispatch.notify).not.toHaveBeenCalled();
    });
  });
});
