import { SharedExpensesModule } from "../shared-expenses/shared-expenses.module";
import { Module } from "@nestjs/common";

import { NotificationCenterModule } from "./notification-center.module";
import { NotificationController } from "./notification.controller";
import { BudgetsModule } from "../budgets/budgets.module";

/**
 * The notification centre's HTTP surface, in its own module because it is the
 * one part that needs a producer: bill reminders are materialized when the list
 * is read, so the controller calls `BudgetsService` on the way in.
 *
 * Nothing imports this module except `AppModule`, which is what makes the edge
 * to `BudgetsModule` safe to take bare. Put that same edge on
 * `NotificationCenterModule` and every producer of a notification -- budgets,
 * system alerts, backups, scheduled transactions -- lands on a require cycle
 * with budgets, which is exactly what `src/module-graph.spec.ts` reported when
 * this was one module.
 */
@Module({
  imports: [NotificationCenterModule, BudgetsModule, SharedExpensesModule],
  controllers: [NotificationController],
})
export class NotificationApiModule {}
