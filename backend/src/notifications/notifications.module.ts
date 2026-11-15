import { SecurityPriceAlertService } from "../notification-center/security-price-alert.service";
import { Module, forwardRef } from "@nestjs/common";
import { EmailService } from "./email.service";
import { BillReminderService } from "./bill-reminder.service";
import { ProviderOutageAlertService } from "./provider-outage-alert.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { SecurityNoticeService } from "./security-notice.service";
import { NotificationReminderCronService } from "./notification-reminder-cron.service";
import { NotificationsController } from "./notifications.controller";
import { UsersModule } from "../users/users.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module";
import { NotificationCenterModule } from "../notification-center/notification-center.module";
import { PushModule } from "../push/push.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { PortfolioMovementAlertService } from "../notification-center/portfolio-movement-alert.service";
import { BalanceThresholdAlertService } from "../notification-center/balance-threshold-alert.service";

@Module({
  imports: [
    UsersModule,
    // For ScheduledEffectiveAmountService: a bill reminder quotes the amount the
    // posting will use, not the persisted snapshot (issue #1247). `forwardRef`
    // because that module reaches AccountsModule and DelegationModule, both of
    // which import this one -- see `src/module-graph.spec.ts`.
    forwardRef(() => ScheduledTransactionsModule),
    // For SystemAlertService: ProviderOutageAlertService raises the in-app
    // companion rows beside its emails. `forwardRef` because SystemAlertsModule
    // imports this module back for EmailService.
    forwardRef(() => SystemAlertsModule),
    // For NotificationPreferenceService: the bill reminder gates its email on
    // the PAYMENTS channel matrix. No forwardRef -- NotificationCenterModule
    // depends on nothing but the connection, so it cannot cycle back.
    NotificationCenterModule,
    // For PushSubscriptionService: the Phase 5 dispatch fans a notification out
    // to the user's devices. PushModule is a leaf (EncryptionModule only), so no
    // forwardRef and no cycle (INV-MODULE, module-graph.spec).
    PushModule,
    // For the portfolio-movement cron: PortfolioService (today's value) and the
    // exchange-rate service (converting the day's external flow). Both can reach
    // NotificationsModule back through the module graph, so both are deferred
    // (module-graph.spec).
    forwardRef(() => SecuritiesModule),
    forwardRef(() => CurrenciesModule),
  ],
  providers: [
    EmailService,
    BillReminderService,
    ProviderOutageAlertService,
    NotificationDispatchService,
    // OAuth grant and relay first-use notices (SECURITY category).
    SecurityNoticeService,
    // The reminder cron re-emits through the dispatch, so it lives on the
    // delivery side; the reminder CRUD stays in NotificationCenterModule.
    NotificationReminderCronService,
    // Daily investment-value movement (INVESTMENTS category). It reads
    // PortfolioService and the exchange-rate service, so it lives here where the
    // dispatch is, not in NotificationCenterModule (which stays connection-only).
    PortfolioMovementAlertService,
    SecurityPriceAlertService,
    // Event-driven balance-threshold crossings (BALANCES category). Triggered
    // from the post-commit balance-invalidation seam (NetWorthService), so it is
    // exported for that module to call.
    BalanceThresholdAlertService,
  ],
  controllers: [NotificationsController],
  exports: [
    EmailService,
    NotificationDispatchService,
    SecurityNoticeService,
    BalanceThresholdAlertService,
  ],
})
export class NotificationsModule {}
