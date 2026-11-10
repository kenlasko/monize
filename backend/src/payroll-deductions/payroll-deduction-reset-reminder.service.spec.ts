import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  type Notification,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { PayrollDeductionResetReminderService } from "./payroll-deduction-reset-reminder.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_USER_ID = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const RULE_ID = "3d4e5f60-7182-4c9d-8e0f-2a3b4c5d6e7f";
const OTHER_RULE = "4e5f6071-8293-4d0e-9f1a-3b4c5d6e7f80";

interface Row {
  id: string;
  user_id: string;
  reset_date: string;
  yearly_maximum: string;
  category_name: string;
  scheduled_name: string;
  currency_code: string;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: RULE_ID,
  user_id: USER_ID,
  reset_date: "2026-01-01",
  yearly_maximum: "1077.4800",
  category_name: "EI",
  scheduled_name: "Paycheque",
  currency_code: "CAD",
  ...over,
});

const runAt = (day: string) => new Date(`${day}T06:23:00.000Z`);

describe("PayrollDeductionResetReminderService", () => {
  const { manager, dataSource } = createScopedDbMocks();
  const dispatch = {
    notify: jest.fn<
      Promise<Notification | null>,
      [string, CreateNotificationInput]
    >(),
  };
  let service: PayrollDeductionResetReminderService;
  let rules: Row[];
  let zones: Record<string, [string | null, string | null]>;

  beforeEach(async () => {
    jest.clearAllMocks();
    rules = [row()];
    zones = { [USER_ID]: ["UTC", null], [OTHER_USER_ID]: ["UTC", null] };
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM payroll_deduction_rules")) return rules;
      if (text.includes("FROM users u")) {
        return Object.entries(zones).map(([user_id, [timezone, cached]]) => ({
          user_id,
          timezone,
          last_client_timezone: cached,
        }));
      }
      return [];
    });
    dispatch.notify.mockResolvedValue({ id: "n1" } as Notification);
    const module = await Test.createTestingModule({
      providers: [
        PayrollDeductionResetReminderService,
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(PayrollDeductionResetReminderService);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  const written = () =>
    dispatch.notify.mock.calls.map((call) => [
      call[0],
      call[1].type,
      call[1].dedupeKey,
    ]);

  it("is a daily cron at 06:23 UTC on run()", () => {
    const source = readFileSync(
      join(__dirname, "payroll-deduction-reset-reminder.service.ts"),
      "utf8",
    );
    expect(source).toContain(
      '@Cron("23 6 * * *", { timeZone: "UTC" })\n  async run()',
    );
  });

  it("names the maximum entered for the period the reset starts (spec section 11)", async () => {
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM payroll_deduction_rule_periods")) {
        return [
          {
            rule_id: RULE_ID,
            period_start: "2027-01-01",
            yearly_maximum: "1123.0700",
            expected_per_paycheque: null,
          },
        ];
      }
      if (text.includes("FROM payroll_deduction_rules")) return rules;
      if (text.includes("FROM users u")) {
        return [
          { user_id: USER_ID, timezone: "UTC", last_client_timezone: null },
        ];
      }
      return [];
    });
    await service.evaluate(runAt("2026-11-10"));
    expect(dispatch.notify.mock.calls[0][1].data).toMatchObject({
      resetOn: "2027-01-01",
      yearlyMaximum: 1123.07,
    });
  });

  it("writes nothing before the window opens", async () => {
    await expect(service.evaluate(runAt("2026-10-31"))).resolves.toEqual({
      written: 0,
    });
    expect(dispatch.notify).not.toHaveBeenCalled();
  });

  it("writes one reminder inside the window, keyed on the rule and the reset date", async () => {
    await expect(service.evaluate(runAt("2026-11-01"))).resolves.toEqual({
      written: 1,
    });
    expect(written()).toEqual([
      [
        USER_ID,
        NotificationType.PAYROLL_DEDUCTION_RESET_DUE,
        `pdr:reset:${RULE_ID}:2027-01-01`,
      ],
    ]);
    const input = dispatch.notify.mock.calls[0][1];
    expect(input.data).toMatchObject({
      categoryName: "EI",
      scheduledTransactionName: "Paycheque",
      resetOn: "2027-01-01",
      yearlyMaximum: 1077.48,
      currencyCode: "CAD",
    });
    expect(input.periodStart).toBe("2026-11-01");
  });

  it("counts a lost insert as the other replica's", async () => {
    dispatch.notify.mockResolvedValue(null);
    await expect(service.evaluate(runAt("2026-12-15"))).resolves.toEqual({
      written: 0,
    });
    expect(dispatch.notify).toHaveBeenCalledTimes(1);
  });

  it("judges the window in each owner's own calendar", async () => {
    // 2026-11-01 06:23 UTC is still 31 October in Los Angeles.
    zones = { [USER_ID]: ["America/Los_Angeles", null] };
    await expect(service.evaluate(runAt("2026-11-01"))).resolves.toEqual({
      written: 0,
    });
    zones = { [USER_ID]: [null, null] };
    await expect(service.evaluate(runAt("2026-11-01"))).resolves.toEqual({
      written: 1,
    });
  });

  it("goes on past one rule or one user that fails", async () => {
    rules = [
      row(),
      row({ id: OTHER_RULE, user_id: OTHER_USER_ID, reset_date: "2027-01-01" }),
    ];
    dispatch.notify
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce({ id: "n2" } as Notification);
    await expect(service.evaluate(runAt("2026-11-10"))).resolves.toEqual({
      written: 1,
    });
    expect(service["logger"].error).toHaveBeenCalledTimes(1);
  });

  it("runs through the cron handler and never throws", async () => {
    manager.query.mockRejectedValue(new Error("db down"));
    await expect(service.run()).resolves.toBeUndefined();
    expect(service["logger"].error).toHaveBeenCalledTimes(1);
  });

  it("logs what this replica wrote", async () => {
    rules = [];
    await service.run();
    expect(service["logger"].log).not.toHaveBeenCalled();
    rules = [row({ reset_date: nextMonthFirst() })];
    await service.run();
    expect(service["logger"].log).toHaveBeenCalledWith(
      "Payroll deduction reset reminders: 1 written by this replica",
    );
  });
});

/** The first of next month: always inside a two-month window from today. */
function nextMonthFirst(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 2;
  const y = month > 12 ? year + 1 : year;
  const m = month > 12 ? month - 12 : month;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}
