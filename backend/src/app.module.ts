import { Module } from "@nestjs/common";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  Reflector,
} from "@nestjs/core";
import { ClassSerializerInterceptor } from "@nestjs/common";
import { GlobalExceptionFilter } from "./common/filters/http-exception.filter";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { PostgresThrottlerStorage } from "./common/throttler/postgres-throttler-storage";
import { ThrottlerStorageModule } from "./common/throttler/throttler-storage.module";
import { CLUSTER_MODE, ClusterMode } from "./common/cluster/cluster-mode";
import { rateLimit } from "./common/throttle.util";
import { CsrfGuard } from "./common/guards/csrf.guard";
import { DemoModeGuard } from "./common/guards/demo-mode.guard";
import { MustChangePasswordGuard } from "./auth/guards/must-change-password.guard";
import { PatScopeGuard } from "./auth/guards/pat-scope.guard";
import { CsrfRefreshInterceptor } from "./common/interceptors/csrf-refresh.interceptor";
import { RequestContextInterceptor } from "./common/interceptors/request-context.interceptor";
import { parseRlsMode, resolveRlsDatabaseAuth } from "./common/db/rls-config";
import { ClusterModule } from "./common/cluster/cluster.module";
import { APPLICATION_NAME } from "./common/cluster/instance-id";
import { DemoModeModule } from "./common/demo-mode.module";
import { EventBusModule } from "./common/events/event-bus.module";
import { JobClaimModule } from "./common/jobs/job-claim.module";
import { BankSyncModule } from "./bank-sync/bank-sync.module";

import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { AccountsModule } from "./accounts/accounts.module";
import { TransactionsModule } from "./transactions/transactions.module";
import { AttachmentsModule } from "./attachments/attachments.module";
import { CategoriesModule } from "./categories/categories.module";
import { CurrenciesModule } from "./currencies/currencies.module";
import { SecuritiesModule } from "./securities/securities.module";
import { PayeesModule } from "./payees/payees.module";
import { InstitutionsModule } from "./institutions/institutions.module";
import { ScheduledTransactionsModule } from "./scheduled-transactions/scheduled-transactions.module";
import { ReportsModule } from "./reports/reports.module";
import { InvestmentReportsModule } from "./investment-reports/investment-reports.module";
import { DatabaseModule } from "./database/database.module";
import { ImportModule } from "./import/import.module";
import { NetWorthModule } from "./net-worth/net-worth.module";
import { BuiltInReportsModule } from "./built-in-reports/built-in-reports.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { NotificationCenterModule } from "./notification-center/notification-center.module";
import { NotificationApiModule } from "./notification-center/notification-api.module";
import { SystemAlertsModule } from "./system-alerts/system-alerts.module";
import { ProviderHealthModule } from "./provider-health/provider-health.module";
import { PushModule } from "./push/push.module";
import { HealthModule } from "./health/health.module";
import { AdminModule } from "./admin/admin.module";
import { AiModule } from "./ai/ai.module";
import { AiRelayModule } from "./ai/relay/ai-relay.module";
import { McpModule } from "./mcp/mcp.module";
import { OAuthModule } from "./oauth/oauth.module";
import { BudgetsModule } from "./budgets/budgets.module";
import { CalendarModule } from "./calendar/calendar.module";
import { TagsModule } from "./tags/tags.module";
import { TransactionRulesModule } from "./transaction-rules/transaction-rules.module";
import { AiReviewModule } from "./ai-review/ai-review.module";
import { AiReviewQueueModule } from "./ai-review/ai-review-queue.module";
import { LoanScenariosModule } from "./loan-scenarios/loan-scenarios.module";
import { LoanRateChangesModule } from "./loan-rate-changes/loan-rate-changes.module";
import { BackupModule } from "./backup/backup.module";
import { ActionHistoryModule } from "./action-history/action-history.module";
import { UpdatesModule } from "./updates/updates.module";
import { MonteCarloModule } from "./monte-carlo/monte-carlo.module";
import { StrategiesModule } from "./strategies/strategies.module";
import { DelegationModule } from "./delegation/delegation.module";
import { EmergencyAccessModule } from "./emergency-access/emergency-access.module";
import { I18nModule } from "./i18n/i18n.module";

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: "../.env",
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // RLS runtime mode selects both GUC emission and the DB role. Both
        // parses throw on misconfiguration (invalid mode, or enforce without
        // DATABASE_APP_PASSWORD), which refuses the boot -- the safe outcome.
        // At off/shadow the runtime keeps the owner credentials, so the image
        // is deployable before the monize_app role exists and a revert is one
        // flag flip. No pool-size change: connections are held only for each
        // short tenant transaction (see the RLS design doc, Phase 1).
        const rlsMode = parseRlsMode(configService.get("RLS_MODE"));
        const { username, password } = resolveRlsDatabaseAuth({
          mode: rlsMode,
          databaseUser: configService.get("DATABASE_USER"),
          databasePassword: configService.get("DATABASE_PASSWORD"),
          appUser: configService.get("DATABASE_APP_USER"),
          appPassword: configService.get("DATABASE_APP_PASSWORD"),
        });
        return {
          type: "postgres",
          host: configService.get("DATABASE_HOST"),
          port: configService.get("DATABASE_PORT"),
          username,
          password,
          database: configService.get("DATABASE_NAME"),
          // PostgreSQL's `application_name` on every pooled session: this
          // process's id and start time, so `pg_stat_activity` can attribute a
          // session to a process and `ReplicaCensusService` can count how many
          // backend processes share the database (CLUSTER_MODE=single is an
          // assertion the process otherwise cannot check). Observation only.
          applicationName: APPLICATION_NAME,
          entities: [__dirname + "/**/*.entity{.ts,.js}"],
          synchronize: false, // Use migrations in production
          logging: ["error"],
          ssl:
            configService.get("DATABASE_SSL") === "true"
              ? {
                  rejectUnauthorized:
                    configService.get("DATABASE_SSL_REJECT_UNAUTHORIZED") !==
                    "false",
                }
              : false,
        };
      },
    }),

    // Rate limiting — global default; auth endpoints override with stricter limits.
    //
    // `storage` is set only in CLUSTER_MODE=multi, where the library's
    // in-process Map would enforce every cap once per replica. In `single` the
    // option is absent entirely, so the default object is untouched and a
    // single-replica deployment pays no write per request. The storage class is
    // a provider either way (Nest has to be able to construct it to inject it),
    // but in `single` nothing calls it.
    ThrottlerModule.forRootAsync({
      // forRootAsync resolves `inject` inside the dynamic module it builds, so
      // the storage has to be exported by a module it imports -- a provider
      // declared beside it in AppModule is out of scope there. CLUSTER_MODE
      // needs no import: ClusterModule is @Global.
      imports: [ThrottlerStorageModule],
      inject: [CLUSTER_MODE, PostgresThrottlerStorage],
      useFactory: (mode: ClusterMode, storage: PostgresThrottlerStorage) => ({
        throttlers: [
          {
            name: "default",
            ttl: 60000, // 1 minute
            limit: rateLimit(100), // 100 requests per minute for general API
          },
        ],
        ...(mode === "multi" ? { storage } : {}),
      }),
    }),

    // Scheduled tasks
    ScheduleModule.forRoot(),

    // Demo mode (global — available to all modules)
    DemoModeModule,
    JobClaimModule,

    // Cluster mode and, in multi, the LISTEN/NOTIFY connection (global)
    ClusterModule,

    // Cross-replica wake-ups (global — a hint channel, never a data channel)
    EventBusModule,

    // i18n (global — exception messages, validation, email content)
    I18nModule,

    // Feature modules
    HealthModule,
    AuthModule,
    UsersModule,
    AccountsModule,
    TransactionsModule,
    AttachmentsModule,
    CategoriesModule,
    PayeesModule,
    InstitutionsModule,
    CurrenciesModule,
    SecuritiesModule,
    ScheduledTransactionsModule,
    ReportsModule,
    InvestmentReportsModule,
    DatabaseModule,
    ImportModule,
    NetWorthModule,
    BuiltInReportsModule,
    NotificationsModule,
    NotificationCenterModule,
    NotificationApiModule,
    SystemAlertsModule,
    ProviderHealthModule,
    PushModule,
    AdminModule,
    AiModule,
    AiRelayModule,
    McpModule,
    OAuthModule,
    BudgetsModule,
    CalendarModule,
    TagsModule,
    TransactionRulesModule,
    AiReviewModule,
    AiReviewQueueModule,
    LoanScenariosModule,
    LoanRateChangesModule,
    BackupModule,
    ActionHistoryModule,
    UpdatesModule,
    MonteCarloModule,
    StrategiesModule,
    DelegationModule,
    EmergencyAccessModule,
    BankSyncModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    { provide: APP_GUARD, useClass: PatScopeGuard },
    { provide: APP_GUARD, useClass: DemoModeGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: CsrfRefreshInterceptor },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector) =>
        new ClassSerializerInterceptor(reflector),
      inject: [Reflector],
    },
  ],
})
export class AppModule {}
