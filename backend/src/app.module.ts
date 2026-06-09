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
import { rateLimit } from "./common/throttle.util";
import { CsrfGuard } from "./common/guards/csrf.guard";
import { DemoModeGuard } from "./common/guards/demo-mode.guard";
import { MustChangePasswordGuard } from "./auth/guards/must-change-password.guard";
import { PatScopeGuard } from "./auth/guards/pat-scope.guard";
import { CsrfRefreshInterceptor } from "./common/interceptors/csrf-refresh.interceptor";
import { RequestContextInterceptor } from "./common/interceptors/request-context.interceptor";
import { DemoModeModule } from "./common/demo-mode.module";
import { UserPreference } from "./users/entities/user-preference.entity";
import { User } from "./users/entities/user.entity";

import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { AccountsModule } from "./accounts/accounts.module";
import { TransactionsModule } from "./transactions/transactions.module";
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
import { HealthModule } from "./health/health.module";
import { AdminModule } from "./admin/admin.module";
import { AiModule } from "./ai/ai.module";
import { McpModule } from "./mcp/mcp.module";
import { OAuthModule } from "./oauth/oauth.module";
import { BudgetsModule } from "./budgets/budgets.module";
import { TagsModule } from "./tags/tags.module";
import { BackupModule } from "./backup/backup.module";
import { ActionHistoryModule } from "./action-history/action-history.module";
import { UpdatesModule } from "./updates/updates.module";
import { MonteCarloModule } from "./monte-carlo/monte-carlo.module";
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
      useFactory: (configService: ConfigService) => ({
        type: "postgres",
        host: configService.get("DATABASE_HOST"),
        port: configService.get("DATABASE_PORT"),
        username: configService.get("DATABASE_USER"),
        password: configService.get("DATABASE_PASSWORD"),
        database: configService.get("DATABASE_NAME"),
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
      }),
    }),

    // Rate limiting — global default; auth endpoints override with stricter limits
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60000, // 1 minute
        limit: rateLimit(100), // 100 requests per minute for general API
      },
    ]),

    // Scheduled tasks
    ScheduleModule.forRoot(),

    // Demo mode (global — available to all modules)
    DemoModeModule,

    // i18n (global — exception messages, validation, email content)
    I18nModule,

    // UserPreference + User repos for RequestContextInterceptor (resolves the
    // authenticated user's timezone and updates last_activity_at on every
    // authenticated request).
    TypeOrmModule.forFeature([UserPreference, User]),

    // Feature modules
    HealthModule,
    AuthModule,
    UsersModule,
    AccountsModule,
    TransactionsModule,
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
    AdminModule,
    AiModule,
    McpModule,
    OAuthModule,
    BudgetsModule,
    TagsModule,
    BackupModule,
    ActionHistoryModule,
    UpdatesModule,
    MonteCarloModule,
    DelegationModule,
    EmergencyAccessModule,
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
