import { readFileSync } from "fs";
import { join } from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { I18nModule, I18nService } from "nestjs-i18n";
import { LOCALE_BASES, SUPPORTED_LOCALE_CODES } from "../i18n/config";
import { emailTranslator, englishEmailT } from "../i18n/email-translator";
import { i18nFormatter } from "../i18n/i18n-formatter";
import { NotificationType } from "../notification-center/entities/notification.entity";
import {
  notificationEmailCopy,
  composeLocalizedNotificationCopy,
} from "./notification-email-copy";
import { NOTIFICATION_EMAIL_MESSAGES } from "./notification-email-messages";
import { notificationImmediateTemplate } from "./email-templates";

// Producer-shaped facts, including zero and negative money. PACE_WARNING has
// no producer or payload contract; its explicit legacy fallback is tested below.
const examples = {
  OVER_BUDGET: {
    categoryName: "Food",
    amount: 120,
    limit: 100,
    percent: 120,
    currencyCode: "USD",
  },
  THRESHOLD_CRITICAL: {
    categoryName: "Food",
    amount: 95,
    limit: 100,
    percent: 95,
    currencyCode: "USD",
  },
  THRESHOLD_WARNING: {
    categoryName: "Food",
    amount: 80,
    limit: 100,
    percent: 80,
    currencyCode: "USD",
  },
  PROJECTED_OVERSPEND: {
    categoryName: "Food",
    projectedTotal: 140,
    budgeted: 100,
    currencyCode: "USD",
  },
  FLEX_GROUP_WARNING: {
    flexGroup: "Living",
    totalSpent: 950,
    totalBudgeted: 1000,
    percent: 95,
    currencyCode: "EUR",
  },
  INCOME_SHORTFALL: {
    actualIncome: 0,
    expectedIncome: 1000,
    ratio: 0,
    currencyCode: "PLN",
  },
  POSITIVE_MILESTONE: { periodProgress: 60, percentUsed: 25.5 },
  SEASONAL_SPIKE: {
    categoryName: "Heating",
    highMonth: 12,
    typicalIncrease: 1.7,
  },
  BILL_DUE: {
    payeeName: "Rent",
    amount: 500,
    amountComplete: true,
    currencyCode: "EUR",
    dueDate: "2026-09-07",
  },
  BACKUP_FAILED: {
    system: true,
    affectedUserEmail: "owner@example.com",
    error: "ENOSPC",
  },
  BACKUP_PARTIAL: {
    system: true,
    affectedUserId: "u1",
    reason: "attachments",
    missingAttachments: 0,
    inconsistentAttachments: 2,
    expectedAttachments: 5,
  },
  ENCRYPTION_KEY_MISSING: { system: true },
  JWT_SECRET_WEAK: { system: true, reason: "placeholder" },
  SMTP_FAILURE: { system: true, lastError: "ECONNREFUSED" },
  PROVIDER_OUTAGE: { system: true, providerLabel: "Yahoo Finance" },
  PROVIDER_RECOVERED: { system: true, providerLabel: "Yahoo Finance" },
  SCHEDULED_POST_FAILED: {
    system: true,
    scheduledName: "Rent",
    dueDate: "2026-09-07",
    error: "FX unavailable",
  },
  BALANCE_BELOW_THRESHOLD: {
    accountName: "Current",
    balance: -25,
    threshold: 0,
    currencyCode: "PLN",
  },
  BALANCE_ABOVE_THRESHOLD: {
    accountName: "Savings",
    balance: 1234.567,
    threshold: 1000,
    currencyCode: "BHD",
  },
  SECURITY_PRICE_MOVEMENT: { symbol: "AAPL", changePercent: -5.25 },
  PORTFOLIO_MOVEMENT: {
    direction: "down",
    changePercent: -3.25,
    movementValue: -325,
    baselineValue: 10_000,
    currentValue: 9_675,
    externalFlow: 0,
    baselineDate: "2026-09-04",
    valuationDate: "2026-09-07",
    currencyCode: "EUR",
  },
  GEM_SIGNAL_CHANGED: {
    strategyName: "GEM",
    kind: "risk",
    fromState: "RISK_ON",
    toState: "RISK_OFF",
  },
  BANK_SYNC_CONSENT_EXPIRING: {
    connectionId: "c1",
    institutionName: "Test Bank",
    validUntil: "2027-03-30",
    threshold: 7,
  },
  BANK_SYNC_CONSENT_EXPIRED: {
    connectionId: "c1",
    institutionName: "Test Bank",
    validUntil: "2027-03-30",
  },
  BANK_SYNC_FAILED: {
    connectionId: "c1",
    institutionName: "Test Bank",
    failures: [{ bankAccountId: "b1", label: "Main account", code: "refused" }],
  },
  BANK_SYNC_IMPORTED: {
    connectionId: "c1",
    institutionName: "Test Bank",
    imported: 1234,
    skipped: 1,
    accounts: 2,
  },
} satisfies Record<
  Exclude<NotificationType, NotificationType.PACE_WARNING>,
  Record<string, unknown>
>;

const now = new Date("2026-09-05T23:59:59Z");
const source = (
  type: NotificationType,
  data: Record<string, unknown> | null,
) => ({
  type,
  data,
  title: "Stored title",
  message: "Stored message",
});

describe("notification email copy", () => {
  let module: TestingModule;
  let i18n: I18nService;
  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: "en",
          fallbacks: { ...LOCALE_BASES },
          formatter: i18nFormatter,
          loaderOptions: {
            path: join(__dirname, "../i18n/locales"),
            watch: false,
          },
        }),
      ],
    }).compile();
    await module.init();
    i18n = module.get(I18nService);
  });
  afterAll(async () => {
    await module.close();
  });

  it.each(Object.entries(examples))(
    "renders %s through real nestjs-i18n without an HTTP locale",
    (type, data) => {
      const row = source(type as NotificationType, data);
      const en = notificationEmailCopy(row, emailTranslator(i18n, "en"), "en", {
        now,
      });
      const xx = notificationEmailCopy(row, emailTranslator(i18n, "xx"), "xx", {
        now,
      });
      expect(en.title).not.toBe(row.title);
      expect(en.message).not.toBe(row.message);
      expect(en).toEqual(
        notificationEmailCopy(row, englishEmailT, "en", { now }),
      );
      expect(xx.title).toContain("[XX-");
      expect(xx.message).toContain("[XX-");
      expect(JSON.stringify(xx)).not.toMatch(/\{\{|undefined|NaN/);
    },
  );

  it("keeps every English fallback and catalog key in agreement", () => {
    const catalog = JSON.parse(
      readFileSync(join(__dirname, "../i18n/locales/en/emails.json"), "utf8"),
    ).notificationCopy;
    const flatten = (
      value: Record<string, unknown>,
      prefix = "",
    ): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          typeof item === "string"
            ? [[prefix + key, item]]
            : Object.entries(
                flatten(item as Record<string, unknown>, `${prefix}${key}.`),
              ),
        ),
      );
    expect(flatten(catalog)).toEqual(NOTIFICATION_EMAIL_MESSAGES);
  });

  it.each(["en-US", "en-GB", "en-CA", "invalid_locale"])(
    "falls back per key for %s",
    (lang) => {
      const row = source(
        NotificationType.BALANCE_BELOW_THRESHOLD,
        examples.BALANCE_BELOW_THRESHOLD,
      );
      const copy = notificationEmailCopy(
        row,
        emailTranslator(i18n, lang),
        lang,
        { now },
      );
      expect(copy.title).toBe("Current is below your threshold");
      expect(copy.message).toContain("Current dropped to");
      expect(copy.message).not.toContain("{{");
    },
  );

  it("formats money, percentages and calendar dates in the recipient's language", () => {
    expect(
      notificationEmailCopy(
        source(
          NotificationType.BALANCE_BELOW_THRESHOLD,
          examples.BALANCE_BELOW_THRESHOLD,
        ),
        englishEmailT,
        "pl",
      ).message,
    ).toContain("-25,00");
    expect(
      notificationEmailCopy(
        source(
          NotificationType.PORTFOLIO_MOVEMENT,
          examples.PORTFOLIO_MOVEMENT,
        ),
        englishEmailT,
        "pl",
      ).title,
    ).toContain("3,25%");
    expect(
      notificationEmailCopy(
        source(NotificationType.BILL_DUE, examples.BILL_DUE),
        englishEmailT,
        "pl",
        { now },
      ).message,
    ).toContain("7 wrz 2026");
    expect(
      notificationEmailCopy(
        source(NotificationType.SEASONAL_SPIKE, examples.SEASONAL_SPIKE),
        englishEmailT,
        "pl",
      ).message,
    ).toContain("grudzień");
  });

  it("names the period a portfolio movement was measured over, not the run day", () => {
    // A Monday run measures from Friday; "today" claimed a day the figure was
    // never about (issue #1391). Both boundary dates come from the producer's
    // `data`, so the copy can name them in the reader's language.
    const message = notificationEmailCopy(
      source(NotificationType.PORTFOLIO_MOVEMENT, examples.PORTFOLIO_MOVEMENT),
      englishEmailT,
      "en",
    ).message;
    expect(message).toContain("Sep 4, 2026");
    expect(message).toContain("Sep 7, 2026");
    expect(message).not.toContain("today");
  });

  it("falls back whole for a movement row written before the dates were carried", () => {
    // Rolling deploy: no invented period, and no relabelling of an old row.
    const { baselineDate, valuationDate, ...older } =
      examples.PORTFOLIO_MOVEMENT;
    expect(baselineDate && valuationDate).toBeTruthy();
    const copy = notificationEmailCopy(
      source(NotificationType.PORTFOLIO_MOVEMENT, older),
      englishEmailT,
      "en",
    );
    expect(copy).toEqual({ title: "Stored title", message: "Stored message" });
  });

  it("lets an explicit numberFormat decide the figures, and the language the dates", () => {
    // The two preferences are independent (issue #1316): an English UI with
    // Polish grouping is a supported choice, and reading the figure off `lang`
    // is exactly what put `zl18,812.71` inside translated copy. The calendar
    // date stays in the LANGUAGE, because which language a month is spelled in
    // is not the number preference.
    const copy = notificationEmailCopy(
      source(NotificationType.BILL_DUE, {
        ...examples.BILL_DUE,
        amount: 123.45,
      }),
      englishEmailT,
      "en",
      { now, numberFormat: "pl-PL" },
    );
    expect(copy.message).toContain("123,45");
    expect(copy.message).not.toContain("123.45");
    expect(copy.message).toContain("Sep 7, 2026");
  });

  it("falls back to the language when numberFormat is absent or follows the browser", () => {
    // `"browser"` cannot be resolved on a server, and a caller with no
    // preferences row to hand passes nothing -- both mean "use the language",
    // which is what `numberFormatterFor` already encodes.
    const polish = (numberFormat?: string) =>
      notificationEmailCopy(
        source(NotificationType.BILL_DUE, {
          ...examples.BILL_DUE,
          amount: 123.45,
        }),
        englishEmailT,
        "pl",
        { now, numberFormat },
      ).message;
    expect(polish()).toContain("123,45");
    expect(polish("browser")).toContain("123,45");
  });

  it.each([
    [-1, "overdue"],
    [0, "due today"],
    [1, "due tomorrow"],
    [2, "due in 2 days"],
  ])("recomputes a bill headline %s days from delivery", (offset, expected) => {
    const dueDate = `2026-09-${String(5 + Number(offset)).padStart(2, "0")}`;
    expect(
      notificationEmailCopy(
        source(NotificationType.BILL_DUE, { ...examples.BILL_DUE, dueDate }),
        englishEmailT,
        "en",
        { now },
      ).title,
    ).toBe(`Rent ${expected}`);
  });

  it.each([{ amount: null }, { amount: 999, amountComplete: false }])(
    "withholds an unavailable bill amount: %j",
    (over) => {
      const copy = notificationEmailCopy(
        source(NotificationType.BILL_DUE, { ...examples.BILL_DUE, ...over }),
        englishEmailT,
        "en",
        { now },
      );
      expect(copy.message).toContain("Amount unavailable");
      expect(copy.message).not.toContain("999");
    },
  );

  it.each(["promotion", "retention"])(
    "keeps the cause of a partial-backup %s failure",
    (reason) => {
      const copy = notificationEmailCopy(
        source(NotificationType.BACKUP_PARTIAL, {
          system: true,
          affectedUserId: "u1",
          reason,
          error: "EACCES",
        }),
      );
      expect(copy.message).toContain("EACCES");
      expect(copy.message).toContain("u1");
      expect(copy.message).not.toBe("Stored message");
    },
  );

  it.each([
    [{ toSymbol: "VWCE", toRole: "EX_US_EQUITY" }, "VWCE"],
    [{ toSymbol: null, toRole: "SAFE" }, "Safe asset"],
    [{ toSymbol: null, toRole: null }, "changed its target"],
  ])(
    "renders GEM allocation including unmapped or absent winners: %j",
    (target, expected) => {
      const copy = notificationEmailCopy(
        source(NotificationType.GEM_SIGNAL_CHANGED, {
          strategyName: "GEM",
          kind: "allocation",
          ...target,
        }),
      );
      expect(copy.message).toContain(expected);
    },
  );

  it("preserves untrusted text without re-interpolating it and escapes the final HTML once", () => {
    const row = source(NotificationType.BACKUP_FAILED, {
      ...examples.BACKUP_FAILED,
      error: "<script>x</script> & {{ user }}",
    });
    const copy = notificationEmailCopy(row, emailTranslator(i18n, "en"), "en");
    expect(copy.message).toContain("<script>x</script> & {{ user }}");
    const html = notificationImmediateTemplate({
      ...copy,
      severity: "critical",
      url: "https://example.com",
    });
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; {{ user }}");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("&amp;lt;");
  });

  it.each([
    [
      NotificationType.OVER_BUDGET,
      { ...examples.OVER_BUDGET, currencyCode: undefined },
    ],
    [
      NotificationType.BALANCE_BELOW_THRESHOLD,
      { ...examples.BALANCE_BELOW_THRESHOLD, balance: NaN },
    ],
    [
      NotificationType.BALANCE_ABOVE_THRESHOLD,
      { ...examples.BALANCE_ABOVE_THRESHOLD, currencyCode: "bad-currency" },
    ],
    [
      NotificationType.PORTFOLIO_MOVEMENT,
      { direction: "unknown", changePercent: 5 },
    ],
    [
      NotificationType.PORTFOLIO_MOVEMENT,
      { direction: "down", changePercent: Infinity },
    ],
    [
      NotificationType.GEM_SIGNAL_CHANGED,
      { ...examples.GEM_SIGNAL_CHANGED, toState: "UNKNOWN" },
    ],
    [
      NotificationType.GEM_SIGNAL_CHANGED,
      { strategyName: "GEM", kind: "allocation", toRole: "__proto__" },
    ],
    [
      NotificationType.BACKUP_PARTIAL,
      { ...examples.BACKUP_PARTIAL, inconsistentAttachments: undefined },
    ],
    [
      NotificationType.BILL_DUE,
      { ...examples.BILL_DUE, dueDate: "2026-02-30" },
    ],
    [NotificationType.BILL_DUE, { ...examples.BILL_DUE, amount: undefined }],
    [
      NotificationType.SEASONAL_SPIKE,
      { ...examples.SEASONAL_SPIKE, highMonth: 13 },
    ],
    [
      NotificationType.BANK_SYNC_CONSENT_EXPIRING,
      { ...examples.BANK_SYNC_CONSENT_EXPIRING, threshold: 5 },
    ],
    [
      NotificationType.BANK_SYNC_CONSENT_EXPIRING,
      { ...examples.BANK_SYNC_CONSENT_EXPIRING, validUntil: "2027-02-30" },
    ],
    [
      NotificationType.BANK_SYNC_CONSENT_EXPIRING,
      { ...examples.BANK_SYNC_CONSENT_EXPIRING, institutionName: "" },
    ],
    [NotificationType.BANK_SYNC_CONSENT_EXPIRED, { connectionId: "c1" }],
    [
      NotificationType.BANK_SYNC_FAILED,
      { ...examples.BANK_SYNC_FAILED, failures: [] },
    ],
    [
      NotificationType.BANK_SYNC_FAILED,
      { ...examples.BANK_SYNC_FAILED, failures: [{ label: "x" }] },
    ],
    [NotificationType.BANK_SYNC_FAILED, { institutionName: "Test Bank" }],
    [
      NotificationType.BANK_SYNC_IMPORTED,
      { ...examples.BANK_SYNC_IMPORTED, imported: -1 },
    ],
    [
      NotificationType.BANK_SYNC_IMPORTED,
      { ...examples.BANK_SYNC_IMPORTED, imported: 1.5 },
    ],
    [
      NotificationType.BANK_SYNC_IMPORTED,
      { institutionName: "Test Bank", imported: undefined },
    ],
  ])(
    "retains the entire stored copy for incomplete or malformed %s data",
    (type, data) => {
      const row = source(
        type as NotificationType,
        data as Record<string, unknown>,
      );
      expect(notificationEmailCopy(row)).toEqual({
        title: row.title,
        message: row.message,
      });
    },
  );

  it.each(Object.values(NotificationType))(
    "preserves legacy %s rows without data",
    (type) => {
      expect(
        composeLocalizedNotificationCopy(
          { type, data: null },
          englishEmailT,
          "en",
        ),
      ).toBeNull();
    },
  );

  it("retains the legacy PACE_WARNING and unknown future types", () => {
    for (const type of [
      NotificationType.PACE_WARNING,
      "FUTURE" as NotificationType,
    ]) {
      expect(notificationEmailCopy(source(type, {}))).toEqual({
        title: "Stored title",
        message: "Stored message",
      });
    }
  });

  describe("bank sync copy", () => {
    const copyOf = (
      type: NotificationType,
      data: Record<string, unknown>,
      lang = "en",
    ) =>
      notificationEmailCopy(
        source(type, data),
        emailTranslator(i18n, lang),
        lang,
        { now },
      );

    it.each([
      [30, "Test Bank: bank access ends within 30 days"],
      [14, "Test Bank: bank access ends within 14 days"],
      [3, "Test Bank: bank access ends within 3 days"],
      [1, "Test Bank: bank access ends within 1 day"],
      [0, "Test Bank: bank access ends today"],
    ])(
      "words the %s-day consent reminder from the stored mark",
      (mark, title) => {
        const copy = copyOf(NotificationType.BANK_SYNC_CONSENT_EXPIRING, {
          ...examples.BANK_SYNC_CONSENT_EXPIRING,
          threshold: mark,
        });
        expect(copy.title).toBe(title);
        // The end is a stored date, rendered in the reader's language.
        expect(copy.message).toContain("Mar 30, 2027");
      },
    );

    it("renders the reminder from the stored facts, whatever day it is delivered", () => {
      // The mark and the date are the producer's; nothing counts from `now`.
      const row = source(
        NotificationType.BANK_SYNC_CONSENT_EXPIRING,
        examples.BANK_SYNC_CONSENT_EXPIRING,
      );
      const later = notificationEmailCopy(row, englishEmailT, "en", {
        now: new Date("2027-03-29T12:00:00Z"),
      });
      expect(later).toEqual(
        notificationEmailCopy(row, englishEmailT, "en", { now }),
      );
    });

    it("names the reader's language for the date and the list of accounts", () => {
      const pl = copyOf(
        NotificationType.BANK_SYNC_CONSENT_EXPIRING,
        examples.BANK_SYNC_CONSENT_EXPIRING,
        "pl",
      );
      expect(pl.message).toContain("30 mar 2027");
      const failed = copyOf(NotificationType.BANK_SYNC_FAILED, {
        institutionName: "Test Bank",
        failures: [
          { bankAccountId: "b1", label: "Main", code: "refused" },
          { bankAccountId: "b2", label: "Savings", code: "refused" },
          { bankAccountId: "b3", label: null, code: "rate_limited" },
        ],
      });
      expect(failed.message).toContain("Main, Savings, and an account");
    });

    it("says one thing when every failure is the credentials", () => {
      const copy = copyOf(NotificationType.BANK_SYNC_FAILED, {
        institutionName: "Test Bank",
        failures: [
          { bankAccountId: "b1", label: "Main", code: "credentials" },
          { bankAccountId: "b2", label: null, code: "credentials" },
        ],
      });
      expect(copy.message).toContain("credentials");
      expect(copy.message).not.toContain("Main");
    });

    it("formats the imported count in the recipient's number format and reports none as none", () => {
      const row = source(
        NotificationType.BANK_SYNC_IMPORTED,
        examples.BANK_SYNC_IMPORTED,
      );
      expect(
        notificationEmailCopy(row, englishEmailT, "en", {
          now,
          numberFormat: "pl-PL",
        }).message,
      ).toContain("1234");
      expect(
        notificationEmailCopy(row, englishEmailT, "en", {
          now,
          numberFormat: "en-US",
        }).message,
      ).toContain("1,234");
      const none = copyOf(NotificationType.BANK_SYNC_IMPORTED, {
        ...examples.BANK_SYNC_IMPORTED,
        imported: 0,
      });
      expect(none.title).toBe("Test Bank: no new transactions");
      expect(none.message).not.toMatch(/\b0\b/);
    });

    it("keeps an institution name literal and the template escapes it once", () => {
      const copy = copyOf(NotificationType.BANK_SYNC_CONSENT_EXPIRED, {
        institutionName: "<img src=x> & {{ days }}",
      });
      expect(copy.message).toContain("<img src=x> & {{ days }}");
      const html = notificationImmediateTemplate({
        ...copy,
        severity: "critical",
        url: "https://example.com",
      });
      expect(html).toContain("&lt;img src=x&gt; &amp; {{ days }}");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("&amp;lt;");
    });
  });

  it.each(SUPPORTED_LOCALE_CODES)(
    "all active types have translated titles and bodies in %s",
    (lang) => {
      for (const [type, data] of Object.entries(examples)) {
        const copy = notificationEmailCopy(
          source(type as NotificationType, data),
          emailTranslator(i18n, lang),
          lang,
          { now },
        );
        expect(copy.title).not.toBe("Stored title");
        expect(copy.message).not.toBe("Stored message");
        expect(JSON.stringify(copy)).not.toMatch(/\{\{|undefined|NaN/);
        if (!lang.startsWith("en") && lang !== "xx") {
          const english = notificationEmailCopy(
            source(type as NotificationType, data),
            englishEmailT,
            lang,
            { now },
          );
          expect(copy.title).not.toBe(english.title);
          expect(copy.message).not.toBe(english.message);
        }
      }
    },
  );
});
