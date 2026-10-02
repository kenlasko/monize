import {
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  notificationCategoryOf,
} from "../notification-center/entities/notification.entity";
import { DEDUPE_KEY_MAX_LENGTH } from "../notification-center/notification-bounds";
import {
  CONSENT_REMINDER_THRESHOLDS,
  buildConsentExpiredNotification,
  buildConsentExpiringNotification,
  buildSyncFailedNotification,
  buildSyncImportedNotification,
  consentExpiredDedupeKey,
  consentExpiringDedupeKey,
  consentPeriodKey,
  consentReminderSeverity,
  consentReminderThreshold,
  daysBetweenYMD,
  notificationAccountLabel,
  notificationFailureCode,
  shouldNotifyImported,
} from "./bank-sync-notifications";
import { BANK_SYNC_NOTIFY_SUCCESS_MODES } from "./bank-sync.constants";

const CONNECTION = "c0c0c0c0-0000-4000-8000-000000000001";
const VALID_UNTIL = new Date("2027-03-30T10:00:00.000Z");

describe("consentReminderThreshold", () => {
  // Spec section 4: the smallest mark the days left are at or under. Written
  // out day by day, 31 down to -1, so a change to the rule fails on its day.
  const TABLE: Array<[number, number | null]> = [
    [31, null],
    [30, 30],
    [29, 30],
    [20, 30],
    [15, 30],
    [14, 14],
    [13, 14],
    [10, 14],
    [8, 14],
    [7, 7],
    [6, 7],
    [5, 7],
    [4, 7],
    [3, 3],
    [2, 2],
    [1, 1],
    [0, 0],
    [-1, null],
  ];

  it.each(TABLE)("%i days left owes the %s mark", (days, mark) => {
    expect(consentReminderThreshold(days)).toBe(mark);
  });

  it("never owes a mark below the days left, and a mark only ever shrinks as the days do", () => {
    let previous = Infinity;
    for (let days = 30; days >= 0; days -= 1) {
      const mark = consentReminderThreshold(days) as number;
      expect(mark).toBeGreaterThanOrEqual(days);
      expect(mark).toBeLessThanOrEqual(previous);
      previous = mark;
    }
  });

  it("fires only the latest mark reached after missed days, never the skipped ones", () => {
    // A run on 8 days left owes 14; the next run is after an outage and finds 2
    // days left. It owes the 2-day mark alone: 7 and 3 are not fired late.
    expect(consentReminderThreshold(8)).toBe(14);
    expect(consentReminderThreshold(2)).toBe(2);
    // And the marks a consent passes through on consecutive days are the ones
    // from the spec's example (valid until 2027-03-30).
    const marks = [30, 16, 14, 7, 6, 4, 3, 2, 1, 0].map((days) =>
      consentReminderThreshold(days),
    );
    expect(marks).toEqual([30, 30, 14, 7, 7, 7, 3, 2, 1, 0]);
  });

  it("never fires on mere observation: a day inside an already-fired mark has the same mark", () => {
    // 6, 5 and 4 days left are all the 7-day mark, so they share one dedupe key.
    const keys = [6, 5, 4].map((days) =>
      consentExpiringDedupeKey(
        CONNECTION,
        VALID_UNTIL,
        consentReminderThreshold(days) as 7,
      ),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it.each([NaN, Infinity, -Infinity, 1.5, 0.5])(
    "owes nothing for a day count that is not a whole number (%s)",
    (days) => {
      expect(consentReminderThreshold(days)).toBeNull();
    },
  );
});

describe("consentReminderSeverity", () => {
  it.each([
    [30, NotificationSeverity.INFO],
    [14, NotificationSeverity.INFO],
    [7, NotificationSeverity.WARNING],
    [3, NotificationSeverity.WARNING],
    [2, NotificationSeverity.WARNING],
    [1, NotificationSeverity.WARNING],
    [0, NotificationSeverity.CRITICAL],
  ] as const)("the %s-day mark is %s", (mark, severity) => {
    expect(consentReminderSeverity(mark)).toBe(severity);
  });
});

describe("daysBetweenYMD", () => {
  it("counts calendar days", () => {
    expect(daysBetweenYMD("2027-02-28", "2027-03-30")).toBe(30);
    expect(daysBetweenYMD("2027-03-30", "2027-03-30")).toBe(0);
    expect(daysBetweenYMD("2027-03-31", "2027-03-30")).toBe(-1);
  });

  it("is exact across a DST change and a year end", () => {
    // 2027-03-28 is the European spring-forward day (23 hours long).
    expect(daysBetweenYMD("2027-03-27", "2027-03-29")).toBe(2);
    expect(daysBetweenYMD("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetweenYMD("2027-10-30", "2027-11-01")).toBe(2);
  });
});

describe("dedupe keys", () => {
  it("name the connection, the consent period and the mark", () => {
    expect(consentExpiringDedupeKey(CONNECTION, VALID_UNTIL, 7)).toBe(
      `bsc:exp:${CONNECTION}:2027-03-30:7`,
    );
    expect(consentExpiredDedupeKey(CONNECTION, VALID_UNTIL)).toBe(
      `bsc:expd:${CONNECTION}:2027-03-30`,
    );
  });

  it("use the UTC date of the end, so a timezone change does not start a new period", () => {
    // 23:30 UTC on the 30th is already the 31st in Warsaw; the key stays the 30th.
    expect(consentPeriodKey(new Date("2027-03-30T23:30:00.000Z"))).toBe(
      "2027-03-30",
    );
  });

  it("start new keys for a renewed consent and keep the old period's untouched", () => {
    const renewed = new Date("2027-09-21T10:00:00.000Z");
    expect(consentExpiringDedupeKey(CONNECTION, renewed, 30)).not.toBe(
      consentExpiringDedupeKey(CONNECTION, VALID_UNTIL, 30),
    );
    expect(consentExpiredDedupeKey(CONNECTION, renewed)).not.toBe(
      consentExpiredDedupeKey(CONNECTION, VALID_UNTIL),
    );
  });

  it("name a consent without an end 'none', and distinguish one mark from the next", () => {
    expect(consentExpiredDedupeKey(CONNECTION, null)).toBe(
      `bsc:expd:${CONNECTION}:none`,
    );
    const keys = CONSENT_REMINDER_THRESHOLDS.map((mark) =>
      consentExpiringDedupeKey(CONNECTION, VALID_UNTIL, mark),
    );
    expect(new Set(keys).size).toBe(CONSENT_REMINDER_THRESHOLDS.length);
  });

  it("fit the dedupe_key column for every notification bank sync writes", () => {
    const inputs = [
      ...CONSENT_REMINDER_THRESHOLDS.map((mark) =>
        buildConsentExpiringNotification(
          {
            connectionId: CONNECTION,
            institutionName: "B",
            validUntil: VALID_UNTIL,
          },
          mark,
          "2027-03-30",
          "2027-03-23",
        ),
      ),
      buildConsentExpiredNotification(
        { connectionId: CONNECTION, institutionName: "B", validUntil: null },
        "2027-03-31",
      ),
      buildSyncFailedNotification(
        { connectionId: CONNECTION, institutionName: "B" },
        [],
        "2027-03-31",
      ),
      buildSyncImportedNotification(
        {
          connectionId: CONNECTION,
          institutionName: "B",
          imported: 1,
          skipped: 0,
          accounts: 1,
        },
        "2027-03-31",
      ),
    ];
    for (const input of inputs) {
      expect((input.dedupeKey ?? "").length).toBeLessThanOrEqual(
        DEDUPE_KEY_MAX_LENGTH,
      );
      expect(input.dedupeKey).toMatch(/^bsc:/);
    }
  });
});

describe("the notifications", () => {
  const facts = { connectionId: CONNECTION, institutionName: "Test Bank" };

  it("a consent reminder carries the mark and the end date as facts, never 'in N days' text", () => {
    const input = buildConsentExpiringNotification(
      { ...facts, validUntil: VALID_UNTIL },
      7,
      "2027-03-31",
      "2027-03-24",
    );
    expect(input).toMatchObject({
      type: NotificationType.BANK_SYNC_CONSENT_EXPIRING,
      severity: NotificationSeverity.WARNING,
      target: "/settings/bank-sync",
      periodStart: "2027-03-24",
      data: {
        connectionId: CONNECTION,
        institutionName: "Test Bank",
        validUntil: "2027-03-31",
        threshold: 7,
      },
    });
    expect(Object.keys(input.data ?? {}).sort()).toEqual([
      "connectionId",
      "institutionName",
      "threshold",
      "validUntil",
    ]);
    expect(input.title).toContain("within 7 days");
    expect(input.dedupeKey).toBe(`bsc:exp:${CONNECTION}:2027-03-30:7`);
  });

  it.each([
    [0, "ends today"],
    [1, "ends within 1 day"],
    [14, "ends within 14 days"],
  ] as const)(
    "words the %s-day mark in its English fallback",
    (mark, words) => {
      expect(
        buildConsentExpiringNotification(
          { ...facts, validUntil: VALID_UNTIL },
          mark,
          "2027-03-30",
          "2027-03-30",
        ).title,
      ).toContain(words);
    },
  );

  it("the expiry notice is critical, on the period's key, with the UTC end date", () => {
    const input = buildConsentExpiredNotification(
      { ...facts, validUntil: VALID_UNTIL },
      "2027-03-31",
    );
    expect(input).toMatchObject({
      type: NotificationType.BANK_SYNC_CONSENT_EXPIRED,
      severity: NotificationSeverity.CRITICAL,
      target: "/settings/bank-sync",
      data: { validUntil: "2027-03-30" },
      dedupeKey: `bsc:expd:${CONNECTION}:2027-03-30`,
    });
    expect(
      buildConsentExpiredNotification({ ...facts, validUntil: null }, "x").data,
    ).toMatchObject({ validUntil: null });
  });

  it("a failure notice lists each account by label and code, under the UTC day's key", () => {
    const input = buildSyncFailedNotification(
      facts,
      [
        { bankAccountId: "b1", label: "Main account", code: "rate_limited" },
        { bankAccountId: "b2", label: null, code: "unauthorized" },
      ],
      "2027-03-31",
    );
    expect(input).toMatchObject({
      type: NotificationType.BANK_SYNC_FAILED,
      severity: NotificationSeverity.WARNING,
      target: "/settings/bank-sync",
      periodStart: "2027-03-31",
      dedupeKey: `bsc:fail:${CONNECTION}:2027-03-31`,
      data: {
        failures: [
          { bankAccountId: "b1", label: "Main account", code: "rate_limited" },
          // A rejected application and unreadable credentials are one repair.
          { bankAccountId: "b2", label: null, code: "credentials" },
        ],
      },
    });
    expect(input.message).toContain("Main account");
  });

  it("an imported notice is a success on the UTC day's key and says none when none", () => {
    const some = buildSyncImportedNotification(
      { ...facts, imported: 3, skipped: 1, accounts: 2 },
      "2027-03-31",
    );
    expect(some).toMatchObject({
      type: NotificationType.BANK_SYNC_IMPORTED,
      severity: NotificationSeverity.SUCCESS,
      target: "/settings/bank-sync",
      dedupeKey: `bsc:imp:${CONNECTION}:2027-03-31`,
      data: { imported: 3, skipped: 1, accounts: 2 },
    });
    expect(some.title).toContain("new transactions imported");
    const none = buildSyncImportedNotification(
      { ...facts, imported: 0, skipped: 4, accounts: 1 },
      "2027-03-31",
    );
    expect(none.title).toContain("no new transactions");
    expect(
      buildSyncImportedNotification(
        { ...facts, imported: 1, skipped: 0, accounts: 1 },
        "d",
      ).message,
    ).toContain("1 transaction from");
  });

  it("files every type under the category the spec names", () => {
    expect(
      notificationCategoryOf(NotificationType.BANK_SYNC_CONSENT_EXPIRING),
    ).toBe(NotificationCategory.BANK_SYNC);
    expect(
      notificationCategoryOf(NotificationType.BANK_SYNC_CONSENT_EXPIRED),
    ).toBe(NotificationCategory.BANK_SYNC);
    expect(notificationCategoryOf(NotificationType.BANK_SYNC_FAILED)).toBe(
      NotificationCategory.BANK_SYNC,
    );
    expect(notificationCategoryOf(NotificationType.BANK_SYNC_IMPORTED)).toBe(
      NotificationCategory.BANK_SYNC_ACTIVITY,
    );
  });
});

describe("shouldNotifyImported (spec section 3)", () => {
  // The truth table: mode x (imported rows | nothing).
  it.each([
    ["always", 5, true],
    ["always", 0, true],
    ["when_imported", 5, true],
    ["when_imported", 0, false],
    ["never", 5, false],
    ["never", 0, false],
  ] as const)("%s with %i imported -> %s", (mode, imported, expected) => {
    expect(shouldNotifyImported(mode, imported)).toBe(expected);
  });

  it("answers for every mode there is", () => {
    for (const mode of BANK_SYNC_NOTIFY_SUCCESS_MODES) {
      expect(typeof shouldNotifyImported(mode, 1)).toBe("boolean");
    }
  });
});

describe("notificationFailureCode", () => {
  it("folds a rejected application into the credentials code and leaves the rest", () => {
    expect(notificationFailureCode("unauthorized")).toBe("credentials");
    expect(notificationFailureCode("credentials")).toBe("credentials");
    expect(notificationFailureCode("rate_limited")).toBe("rate_limited");
  });
});

describe("notificationAccountLabel", () => {
  it("uses the bank's own label for the account", () => {
    expect(notificationAccountLabel("Main account", "**** 1234")).toBe(
      "Main account",
    );
    expect(notificationAccountLabel("  Savings pot ", null)).toBe(
      "Savings pot",
    );
  });

  it("falls back to the masked identifier, and to nothing when there is neither", () => {
    expect(notificationAccountLabel(null, "PL12 **** 3456")).toBe(
      "PL12 **** 3456",
    );
    expect(notificationAccountLabel("", "PL12 **** 3456")).toBe(
      "PL12 **** 3456",
    );
    expect(notificationAccountLabel(null, null)).toBeNull();
    expect(notificationAccountLabel("  ", " ")).toBeNull();
  });

  it.each([
    "PL61109010140000071219812874",
    "PL61 1090 1014 0000 0712 1981 2874",
    "GB29-NWBK-6016-1331-9268-19",
    "Account 12345678",
    "12 34 56 78",
  ])("never carries a label shaped like an account number: %s", (label) => {
    expect(notificationAccountLabel(label, "**** 3456")).toBe("**** 3456");
    expect(notificationAccountLabel(label, null)).toBeNull();
  });

  it("keeps a label with a few digits in it", () => {
    expect(notificationAccountLabel("Card 2 of 3", null)).toBe("Card 2 of 3");
    expect(notificationAccountLabel("Savings 2027", null)).toBe("Savings 2027");
  });
});
