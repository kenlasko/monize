import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { NotificationService } from "@/notification-center/notification.service";
import {
  Notification,
  NotificationType,
} from "@/notification-center/entities/notification.entity";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { reportingEntities } from "@/accruals/reporting-query";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";

describe("bill reminders with accrual reporting enabled (enforced RLS)", () => {
  jest.setTimeout(120000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture([BudgetsModule]);
  });
  beforeEach(async () => {
    await f.reset();
    // Freeze Date only; PostgreSQL and notification delivery keep real timers.
    jest.useFakeTimers({
      now: new Date("2026-10-15T12:00:00Z"),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(async () => f?.close());

  async function seedBill(basis: "cash" | "accrual") {
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,reporting_basis) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET reporting_basis=EXCLUDED.reporting_basis",
      [f.user, basis],
    );
    const repo = f.h.owner.getRepository(ScheduledTransaction);
    return repo.save(
      repo.create({
        userId: f.user,
        accountId: f.account,
        name: "Reminder regression",
        payeeName: "Reminder regression",
        amount: -25,
        currencyCode: "USD",
        categoryId: f.root,
        frequency: "ONCE",
        startDate: "2026-10-15",
        nextDueDate: "2026-10-15",
        isActive: true,
        autoPost: false,
        reminderDaysBefore: 3,
      }),
    );
  }

  it.each(["cash", "accrual"] as const)(
    "materializes and reads a due reminder once in %s mode",
    async (basis) => {
      const bill = await seedBill(basis);
      const budgets = f.h.module.get(BudgetsService);
      const notifications = f.h.module.get(NotificationService);
      // This is the producer/list sequence used by GET /notifications. The real
      // query must execute: a permissive query-builder mock hid ba.source_transaction_id.
      const read = () =>
        f.as(async () => {
          await budgets.ensureBillDueNotifications(f.user);
          return notifications.list(f.user, { unreadOnly: false });
        });
      const first = await read();
      expect(first).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: NotificationType.BILL_DUE,
            data: expect.objectContaining({ billId: bill.id }),
          }),
        ]),
      );
      const second = await read();
      expect(
        second.filter((row) => row.type === NotificationType.BILL_DUE),
      ).toHaveLength(1);
      expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    },
  );

  it("leaves non-transaction entity reads unprojected even in accrual mode", async () => {
    await seedBill("cash");
    await f.as(() =>
      f.h.module.get(BudgetsService).ensureBillDueNotifications(f.user),
    );
    await f.h.owner.query(
      "UPDATE user_preferences SET reporting_basis='accrual' WHERE user_id=$1",
      [f.user],
    );
    const rows = await f.as(() =>
      withScopedDb(f.h.app, (manager) =>
        reportingEntities(
          manager,
          f.user,
          manager
            .getRepository(Notification)
            .createQueryBuilder("ba")
            .where("ba.userId = :userId", { userId: f.user }),
        ),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(NotificationType.BILL_DUE);
    expect(rows[0]).not.toHaveProperty("reportingProvenance");
  });
});
