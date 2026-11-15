import { NotFoundException } from "@nestjs/common";
import { In, IsNull, Not } from "typeorm";

import {
  LIST_PAGE_SIZE,
  NotificationService,
  RETENTION_DAYS,
  TITLE_MAX_LENGTH,
  DEDUPE_KEY_MAX_LENGTH,
  TARGET_MAX_LENGTH,
} from "./notification.service";
import { STATE_KEYED_FORGET_DAYS } from "./notification-bounds";
import {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  SYSTEM_NOTIFICATION_TYPES,
} from "./entities/notification.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: (_userId: string, fn: () => unknown) => fn(),
}));

function row(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    userId: "user-1",
    budgetId: null,
    budget: null,
    budgetCategoryId: null,
    budgetCategory: null,
    type: NotificationType.THRESHOLD_WARNING,
    severity: NotificationSeverity.WARNING,
    title: "Groceries at 80%",
    message: "You have spent 80% of your groceries budget",
    data: {},
    target: null,
    isRead: false,
    isEmailSent: false,
    periodStart: "2026-02-01",
    createdAt: new Date("2026-02-15"),
    dismissedAt: null,
    dedupeKey: null,
    ...overrides,
  };
}

describe("NotificationService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let notifications: Record<string, jest.Mock>;
  let service: NotificationService;

  /** The INSERTs the door issued, as [sql, params]. */
  const inserts = () =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO notifications"),
    );

  /**
   * One insert's parameters keyed by the column the statement names, so an
   * assertion pins the column rather than a position in the writer's own
   * column order.
   */
  const inserted = (index = 0): Record<string, unknown> => {
    const [sql, params] = inserts()[index];
    const columns = /INSERT INTO notifications\s*\(([^)]*)\)/.exec(String(sql));
    if (!columns) throw new Error(`no column list in: ${String(sql)}`);
    return Object.fromEntries(
      columns[1]
        .split(",")
        .map((name, i) => [name.trim(), (params as unknown[])[i]]),
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    notifications = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((entity: unknown) => entity),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const mocks = createScopedDbMocks([[Notification, notifications]]);
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([{ id: "n-new" }]);
    service = new NotificationService(dataSource as never);
  });

  describe("create", () => {
    it("writes the row and returns the stored state, not the input", async () => {
      const stored = row({ id: "n-new" });
      notifications.findOne.mockResolvedValue(stored);

      const created = await service.create("user-1", {
        type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        title: "Groceries is over budget",
        message: "You have spent 120%",
        data: { budgeted: 500 },
        target: "/budgets/b-1",
        budgetId: "b-1",
        budgetCategoryId: "bc-1",
        periodStart: "2026-02-01",
      });

      // The defaults, the trigger-stamped timestamps and the truncations all
      // live in the database, so the caller is handed what was read back.
      expect(created).toBe(stored);
      expect(notifications.findOne).toHaveBeenCalledWith({
        where: { id: "n-new" },
      });
      expect(inserted()).toMatchObject({
        user_id: "user-1",
        budget_id: "b-1",
        budget_category_id: "bc-1",
        alert_type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        target: "/budgets/b-1",
        period_start: "2026-02-01",
      });
    });

    it("insert and read-back share one transaction", async () => {
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));

      await service.create("user-1", {
        type: NotificationType.BILL_DUE,
        severity: NotificationSeverity.INFO,
        title: "Netflix due",
        message: "15.99 due",
      });

      // Reading the row back in a second transaction would let another writer
      // dismiss or purge it in between, and the caller would email about a row
      // that no longer says what it says.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("reports a conflict as null rather than raising", async () => {
      // Every replica runs every cron, so losing the race is the normal case:
      // the loser holds no row and therefore sends nothing.
      manager.query.mockResolvedValue([]);

      await expect(
        service.create("user-1", {
          type: NotificationType.BACKUP_FAILED,
          severity: NotificationSeverity.CRITICAL,
          title: "Backup failed",
          message: "boom",
          dedupeKey: "BACKUP_FAILED:user-1:2026-08-30",
        }),
      ).resolves.toBeNull();
      expect(notifications.findOne).not.toHaveBeenCalled();
    });

    it("lets one conflict clause cover both unique indexes", async () => {
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));

      await service.create("user-1", {
        type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        title: "t",
        message: "m",
        budgetId: "b-1",
      });

      // Naming a conflict target would arbitrate one index and raise on the
      // other -- the fingerprint for a budget notification, the dedupe key for
      // a system one, and a producer does not know which applies.
      const [sql] = inserts()[0];
      expect(String(sql)).toContain("ON CONFLICT DO NOTHING");
      expect(String(sql)).toContain("RETURNING id");
    });

    it("defaults the period to today and leaves the optional columns null", async () => {
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));

      await service.create("user-1", {
        type: NotificationType.SMTP_FAILURE,
        severity: NotificationSeverity.CRITICAL,
        title: "SMTP failing",
        message: "boom",
      });

      const written = inserted();
      expect(written.period_start).toBe(new Date().toISOString().slice(0, 10));
      expect(written.budget_id).toBeNull();
      expect(written.budget_category_id).toBeNull();
      expect(written.target).toBeNull();
      expect(written.dedupe_key).toBeNull();
      expect(written.data).toBe("{}");
    });

    describe("column bounds", () => {
      beforeEach(() => {
        notifications.findOne.mockResolvedValue(row({ id: "n-new" }));
        jest
          .spyOn(service["logger"], "warn")
          .mockImplementation(() => undefined);
        jest
          .spyOn(service["logger"], "error")
          .mockImplementation(() => undefined);
      });

      // PostgreSQL raises 22001 on an over-long value, a producer's
      // never-throws catch swallows it, and the notification silently never
      // exists -- for SCHEDULED_POST_FAILED that means the user is never told
      // their money did not move.
      it("truncates an over-long title with an ellipsis", async () => {
        await service.create("user-1", {
          type: NotificationType.SCHEDULED_POST_FAILED,
          severity: NotificationSeverity.CRITICAL,
          title: `${"N".repeat(400)} could not be posted`,
          message: "m",
        });

        const title = String(inserted().title);
        expect(title).toHaveLength(TITLE_MAX_LENGTH);
        expect(title.endsWith("…")).toBe(true);
      });

      it("truncates an over-long dedupe key deterministically", async () => {
        const key = "K".repeat(DEDUPE_KEY_MAX_LENGTH + 40);

        await service.create("user-1", {
          type: NotificationType.BACKUP_FAILED,
          severity: NotificationSeverity.CRITICAL,
          title: "t",
          message: "m",
          dedupeKey: key,
        });

        expect(inserted().dedupe_key).toBe(key.slice(0, DEDUPE_KEY_MAX_LENGTH));
      });

      // A truncated path points somewhere else. Dropping the link is worse
      // than the right link and better than navigating to the wrong page.
      it("drops an over-long target rather than cutting it", async () => {
        await service.create("user-1", {
          type: NotificationType.BILL_DUE,
          severity: NotificationSeverity.INFO,
          title: "t",
          message: "m",
          target: `/scheduled-transactions/${"x".repeat(TARGET_MAX_LENGTH)}`,
        });

        expect(inserted().target).toBeNull();
      });

      it("leaves values inside the columns alone", async () => {
        await service.create("user-1", {
          type: NotificationType.BILL_DUE,
          severity: NotificationSeverity.INFO,
          title: "Netflix due tomorrow",
          message: "m",
          target: "/scheduled-transactions/st-1",
          dedupeKey: "BILL:st-1",
        });

        expect(inserted()).toMatchObject({
          title: "Netflix due tomorrow",
          target: "/scheduled-transactions/st-1",
          dedupe_key: "BILL:st-1",
        });
      });
    });
  });

  describe("markEmailSent", () => {
    it("sets the flag on that row alone", async () => {
      await service.markEmailSent("user-1", "n-1");

      const [sql, params] = manager.query.mock.calls[0];
      expect(String(sql)).toContain("SET is_email_sent = true");
      expect(params).toEqual(["n-1", "user-1"]);
    });

    // At RLS_MODE=off nothing outside this statement scopes it, so the owner has
    // to be IN it: an id-only UPDATE would flip whichever account's row carries
    // that id.
    it("restricts the update to the owner as well as the id", async () => {
      await service.markEmailSent("user-1", "n-1");

      const [sql] = manager.query.mock.calls[0];
      expect(String(sql)).toMatch(/WHERE\s+id = \$1\s+AND\s+user_id = \$2/);
    });
  });

  describe("list", () => {
    it("returns the newest live notifications, with their derived category", async () => {
      notifications.find.mockResolvedValue([
        row({ type: NotificationType.BILL_DUE }),
      ]);

      const result = await service.list("user-1");

      expect(notifications.find).toHaveBeenCalledWith({
        where: { userId: "user-1", dismissedAt: IsNull() },
        order: { createdAt: "DESC" },
        take: LIST_PAGE_SIZE,
      });
      // Derived, never stored: a reader gets the category without the table
      // holding a second answer to what the type already says.
      expect(result[0].category).toBe(NotificationCategory.PAYMENTS);
    });

    it("narrows to unread when asked", async () => {
      notifications.find.mockResolvedValue([row()]);

      await service.list("user-1", { unreadOnly: true });

      expect(notifications.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isRead: false, dismissedAt: IsNull() },
        order: { createdAt: "DESC" },
        take: LIST_PAGE_SIZE,
      });
    });

    it("returns nothing rather than failing when there is nothing", async () => {
      notifications.find.mockResolvedValue([]);

      await expect(service.list("user-1")).resolves.toEqual([]);
    });
  });

  describe("markRead", () => {
    it("marks the row read and reports it back", async () => {
      notifications.findOne.mockResolvedValue(row());

      const result = await service.markRead("user-1", "n-1");

      expect(result.isRead).toBe(true);
      expect(result.category).toBe(NotificationCategory.BUDGETS);
    });

    it("reads and writes inside one transaction", async () => {
      notifications.findOne.mockResolvedValue(row());

      await service.markRead("user-1", "n-1");

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["no such notification", null],
      ["one belonging to somebody else", null],
    ])("404s on %s", async (_case, found) => {
      notifications.findOne.mockResolvedValue(found);

      await expect(service.markRead("user-1", "n-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("scopes the lookup to the caller and to live rows", async () => {
      notifications.findOne.mockResolvedValue(row());

      await service.markRead("user-1", "n-1");

      expect(notifications.findOne).toHaveBeenCalledWith({
        where: { id: "n-1", userId: "user-1", dismissedAt: IsNull() },
      });
    });
  });

  describe("dismiss", () => {
    it("soft-dismisses rather than deleting", async () => {
      notifications.findOne.mockResolvedValue(row());

      await service.dismiss("user-1", "n-1");

      expect(notifications.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "n-1", dismissedAt: expect.any(Date) }),
      );
      expect(notifications.delete).not.toHaveBeenCalled();
    });

    it("404s on a row that is not the caller's live row", async () => {
      notifications.findOne.mockResolvedValue(null);

      await expect(service.dismiss("user-1", "n-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("markAllRead", () => {
    it("reports how many rows moved", async () => {
      notifications.update.mockResolvedValue({ affected: 5 });

      await expect(service.markAllRead("user-1")).resolves.toEqual({
        updated: 5,
      });
      expect(notifications.update).toHaveBeenCalledWith(
        { userId: "user-1", isRead: false, dismissedAt: IsNull() },
        { isRead: true },
      );
    });

    it("reports zero rather than nothing when there was nothing to read", async () => {
      notifications.update.mockResolvedValue({ affected: 0 });

      await expect(service.markAllRead("user-1")).resolves.toEqual({
        updated: 0,
      });
    });
  });

  describe("dismissAll", () => {
    it("dismisses every live row when no filter is given", async () => {
      notifications.update.mockResolvedValue({ affected: 7 });

      await expect(service.dismissAll("user-1")).resolves.toEqual({
        dismissed: 7,
      });
      expect(notifications.update).toHaveBeenCalledWith(
        { userId: "user-1", dismissedAt: IsNull() },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("restricts the write to the requested severity", async () => {
      notifications.update.mockResolvedValue({ affected: 2 });

      await service.dismissAll("user-1", {
        severity: NotificationSeverity.CRITICAL,
      });

      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          severity: NotificationSeverity.CRITICAL,
        },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("restricts category=system to the system types", async () => {
      notifications.update.mockResolvedValue({ affected: 1 });

      await service.dismissAll("user-1", { category: "system" });

      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          type: In([...SYSTEM_NOTIFICATION_TYPES]),
        },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("restricts category=financial to everything outside that set", async () => {
      notifications.update.mockResolvedValue({ affected: 3 });

      await service.dismissAll("user-1", { category: "financial" });

      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          type: Not(In([...SYSTEM_NOTIFICATION_TYPES])),
        },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("applies severity and category together", async () => {
      notifications.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.dismissAll("user-1", {
          severity: NotificationSeverity.WARNING,
          category: "financial",
        }),
      ).resolves.toEqual({ dismissed: 0 });
      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          severity: NotificationSeverity.WARNING,
          type: Not(In([...SYSTEM_NOTIFICATION_TYPES])),
        },
        { dismissedAt: expect.any(Date) },
      );
    });
  });

  describe("purgeOld", () => {
    const purgeSql = () =>
      manager.query.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes("DELETE FROM notifications"));

    it("drops dismissed rows past the retention window", async () => {
      manager.query.mockResolvedValue([[], 5]);

      await service.purgeOld();

      const [dismissed] = purgeSql();
      expect(dismissed).toContain("dismissed_at < $1");
      expect(manager.query.mock.calls[0][1][0]).toBeInstanceOf(Date);
    });

    it("drops read rows the reader left alone, and only those", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await service.purgeOld();

      const [, read] = purgeSql();
      // An unread row is the only record the user has that something happened,
      // so it is never purged however old it is.
      expect(read).toContain("is_read = true");
      expect(read).toContain("dismissed_at IS NULL");
      expect(read).toContain("created_at < $1");
    });

    it("spares a read row that an active reminder still nags about", async () => {
      // The FK is ON DELETE SET NULL and the cron's sweep stops an orphaned
      // reminder, so deleting the source on day 31 would silently end a
      // schedule the user set up. A dismissed source needs no such guard: the
      // dismissal already stopped its reminder.
      manager.query.mockResolvedValue([[], 0]);

      await service.purgeOld();

      const [dismissed, read] = purgeSql();
      expect(read).toContain("NOT EXISTS");
      expect(read).toContain("notification_reminders");
      expect(read).toContain("source_notification_id = n.id");
      expect(read).toContain("stopped_at IS NULL");
      expect(dismissed).not.toContain("notification_reminders");
    });

    it("keeps the state-keyed bond rows: the dedupe row is the only memory that the event was raised", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await service.purgeOld();

      const calls = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("DELETE FROM notifications"),
      );
      const [[dismissed, dismissedArgs], [read, readArgs]] = calls;
      // Parameterized, never concatenated into the statement.
      expect(String(dismissed)).not.toContain("bond:");
      expect(String(read)).not.toContain("bond:");
      expect(String(dismissed)).toContain("starts_with(");
      expect(String(read)).toContain("starts_with(");
      expect(String(dismissed)).not.toContain("LIKE");
      // `gem:` too: the GEM signal-change row is the only memory that a
      // period's change was announced, and the period outlives the window
      // (A26-L24). `relay:cred:` is the memory that a credential was announced.
      expect(dismissedArgs[1]).toEqual([
        "bond:unbooked:",
        "bond:missing:",
        "gem:",
        "relay:cred:",
      ]);
      expect(readArgs[1]).toEqual([
        "bond:unbooked:",
        "bond:missing:",
        "gem:",
        "relay:cred:",
      ]);
    });

    it("forgets a dismissed state-keyed row only after the long window", async () => {
      const before = Date.now();
      manager.query.mockResolvedValue([[], 0]);

      await service.purgeOld();

      const [[dismissed, args]] = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("DELETE FROM notifications"),
      );
      expect(String(dismissed)).toContain("OR (dismissed_at < $3");
      // A relay credential row is the memory it was announced: never forgotten.
      expect(String(dismissed)).toContain(
        "NOT starts_with(COALESCE(dedupe_key, ''), $4)",
      );
      expect(args[3]).toBe("relay:cred:");
      const expected = before - STATE_KEYED_FORGET_DAYS * 24 * 60 * 60 * 1000;
      expect(Math.abs((args[2] as Date).getTime() - expected)).toBeLessThan(
        60_000,
      );
    });

    it("keeps the cutoff at the documented retention window", async () => {
      const before = Date.now();
      manager.query.mockResolvedValue([[], 0]);

      await service.purgeOld();

      const cutoff = (manager.query.mock.calls[0][1][0] as Date).getTime();
      const expected = before - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expected)).toBeLessThan(60_000);
    });

    it("swallows a failure rather than ending the nightly run", async () => {
      manager.query.mockRejectedValue(new Error("DB error"));
      jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await expect(service.purgeOld()).resolves.not.toThrow();
    });
  });
});
