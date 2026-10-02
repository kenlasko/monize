/**
 * The notification type partition, and the one thing that must stay derived.
 *
 * `notificationCategoryOf` answers "what is this notification about" from
 * `alert_type` alone. That is a design decision, not an implementation detail:
 * a stored `category` column would be a second answer to the same question,
 * true only while every producer remembers to write it -- and the raw
 * `INSERT INTO notifications` in `budgets/budget-alert.service.ts` names its
 * columns, so it would have inherited whatever default the column carried. So
 * the absence of the column is asserted here, against `schema.sql`, rather than
 * left as a paragraph in the migration.
 */
import * as fs from "fs";
import * as path from "path";

import {
  BALANCE_NOTIFICATION_TYPES,
  BANK_SYNC_ACTIVITY_NOTIFICATION_TYPES,
  BANK_SYNC_NOTIFICATION_TYPES,
  INVESTMENT_NOTIFICATION_TYPES,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  STRATEGY_NOTIFICATION_TYPES,
  SYSTEM_NOTIFICATION_TYPES,
  notificationCategoryOf,
} from "./entities/notification.entity";
import {
  DEDUPE_KEY_MAX_LENGTH,
  TARGET_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./notification.service";

const SCHEMA_SQL = path.join(__dirname, "../../../database/schema.sql");

/** The `CREATE TABLE notifications (...)` body, as written in schema.sql. */
function notificationsTableSql(): string {
  const sql = fs.readFileSync(SCHEMA_SQL, "utf8");
  const start = sql.indexOf("CREATE TABLE notifications (");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("\n);", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** The declared length of a `VARCHAR(n)` column in that table. */
function varcharLength(column: string): number {
  const match = new RegExp(`^\\s*${column}\\s+VARCHAR\\((\\d+)\\)`, "im").exec(
    notificationsTableSql(),
  );
  expect(match).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

const ALL_TYPES = Object.values(NotificationType);

describe("notification type partition", () => {
  it("every type fits the alert_type column", () => {
    const limit = varcharLength("alert_type");
    const tooLong = ALL_TYPES.filter((t) => t.length > limit);
    expect(tooLong).toEqual([]);
  });

  it("every severity fits the severity column", () => {
    const limit = varcharLength("severity");
    const tooLong = Object.values(NotificationSeverity).filter(
      (s) => s.length > limit,
    );
    expect(tooLong).toEqual([]);
  });

  it("the system list holds real types, once each", () => {
    expect(new Set(SYSTEM_NOTIFICATION_TYPES).size).toBe(
      SYSTEM_NOTIFICATION_TYPES.length,
    );
    const unknown = SYSTEM_NOTIFICATION_TYPES.filter(
      (t) => !ALL_TYPES.includes(t),
    );
    expect(unknown).toEqual([]);
  });

  /**
   * Two classifications of one type now travel to the client: the fine
   * `category` a per-category preference will key on, and the coarse
   * system-vs-financial split the list's filter and the dismiss-all command
   * already use. Both derive from `SYSTEM_NOTIFICATION_TYPES`, so they cannot
   * drift by accident -- but `notificationCategoryOf` special-cases BILL_DUE and
   * SCHEDULED_POST_FAILED to PAYMENTS FIRST, so a type both special-cased there
   * AND left in the system set would be financial to one reader and SYSTEM to the
   * other, and a filtered delete-all would remove rows the filter never showed.
   * Keeping them out of the system set is what holds the two in agreement.
   */
  it("agrees with the coarse split the filters use", () => {
    for (const type of ALL_TYPES) {
      const fine = notificationCategoryOf(type) === NotificationCategory.SYSTEM;
      const coarse = SYSTEM_NOTIFICATION_TYPES.includes(type);
      expect({ type, fine }).toEqual({ type, fine: coarse });
    }
  });

  it("categorizes every type, and only into declared categories", () => {
    const categories = Object.values(NotificationCategory);
    const uncategorized = ALL_TYPES.filter(
      (t) => !categories.includes(notificationCategoryOf(t)),
    );
    expect(uncategorized).toEqual([]);
  });

  it("splits every category from its declared type set, with BUDGETS the remainder", () => {
    const byCategory = Object.fromEntries(
      Object.values(NotificationCategory).map((c) => [
        c,
        [] as NotificationType[],
      ]),
    ) as Record<NotificationCategory, NotificationType[]>;
    for (const type of ALL_TYPES) {
      byCategory[notificationCategoryOf(type)].push(type);
    }

    // BILL_DUE and SCHEDULED_POST_FAILED are both about a scheduled payment.
    expect(byCategory[NotificationCategory.PAYMENTS].sort()).toEqual(
      [
        NotificationType.BILL_DUE,
        NotificationType.SCHEDULED_POST_FAILED,
      ].sort(),
    );
    expect(byCategory[NotificationCategory.SYSTEM].sort()).toEqual(
      [...SYSTEM_NOTIFICATION_TYPES].sort(),
    );
    // Each financial-detail category maps exactly its own declared type set --
    // the inverse of `notificationCategoryOf` derived from the one list per set.
    expect(byCategory[NotificationCategory.BALANCES].sort()).toEqual(
      [...BALANCE_NOTIFICATION_TYPES].sort(),
    );
    expect(byCategory[NotificationCategory.INVESTMENTS].sort()).toEqual(
      [...INVESTMENT_NOTIFICATION_TYPES].sort(),
    );
    expect(byCategory[NotificationCategory.STRATEGIES].sort()).toEqual(
      [...STRATEGY_NOTIFICATION_TYPES].sort(),
    );
    // Bank sync: what needs the user's action, and what only reports.
    expect(byCategory[NotificationCategory.BANK_SYNC].sort()).toEqual(
      [
        NotificationType.BANK_SYNC_CONSENT_EXPIRING,
        NotificationType.BANK_SYNC_CONSENT_EXPIRED,
        NotificationType.BANK_SYNC_FAILED,
      ].sort(),
    );
    expect(byCategory[NotificationCategory.BANK_SYNC].sort()).toEqual(
      [...BANK_SYNC_NOTIFICATION_TYPES].sort(),
    );
    expect(byCategory[NotificationCategory.BANK_SYNC_ACTIVITY]).toEqual([
      NotificationType.BANK_SYNC_IMPORTED,
    ]);
    expect(byCategory[NotificationCategory.BANK_SYNC_ACTIVITY]).toEqual([
      ...BANK_SYNC_ACTIVITY_NOTIFICATION_TYPES,
    ]);
    // BUDGETS is the remainder: everything not in one of the explicit sets
    // above -- never a second list, so this arm proves the partition is total.
    expect(byCategory[NotificationCategory.BUDGETS].sort()).toEqual(
      ALL_TYPES.filter(
        (t) =>
          t !== NotificationType.BILL_DUE &&
          t !== NotificationType.SCHEDULED_POST_FAILED &&
          !SYSTEM_NOTIFICATION_TYPES.includes(t) &&
          !BALANCE_NOTIFICATION_TYPES.includes(t) &&
          !INVESTMENT_NOTIFICATION_TYPES.includes(t) &&
          !STRATEGY_NOTIFICATION_TYPES.includes(t) &&
          !BANK_SYNC_NOTIFICATION_TYPES.includes(t) &&
          !BANK_SYNC_ACTIVITY_NOTIFICATION_TYPES.includes(t),
      ).sort(),
    );
  });

  /**
   * The write door truncates on these three numbers, and truncating at the wrong
   * width is not a smaller version of the same behaviour: too low silently
   * shortens copy the column would have accepted, and too high hands PostgreSQL
   * a value it refuses with 22001 -- inside a producer's never-throws catch, so
   * the notification silently never exists. That is the exact failure the
   * truncation was written to prevent, which makes an unchecked constant the one
   * way to reintroduce it.
   */
  it.each([
    ["title", () => TITLE_MAX_LENGTH],
    ["dedupe_key", () => DEDUPE_KEY_MAX_LENGTH],
    ["target", () => TARGET_MAX_LENGTH],
  ])("the door's bound for %s is the column's own width", (column, bound) => {
    expect(bound()).toBe(varcharLength(column));
  });

  it("every category fits the notification_preferences.category column", () => {
    const sql = fs.readFileSync(SCHEMA_SQL, "utf8");
    const start = sql.indexOf("CREATE TABLE notification_preferences (");
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf("\n);", start));
    const match = /^\s*category\s+VARCHAR\((\d+)\)/im.exec(body);
    expect(match).not.toBeNull();
    const limit = Number((match as RegExpExecArray)[1]);
    const tooLong = Object.values(NotificationCategory).filter(
      (c) => c.length > limit,
    );
    expect(tooLong).toEqual([]);
  });

  it("has no stored category column to disagree with the derivation", () => {
    // Migration 179 deliberately does not add one; see its header. A column
    // here would make this function advisory, and the first producer to forget
    // it would file a budget alert under SYSTEM with nothing failing.
    expect(notificationsTableSql()).not.toMatch(/^\s*category\s+/im);
  });
});
