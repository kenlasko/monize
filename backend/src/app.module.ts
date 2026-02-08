import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { CsrfGuard } from './common/guards/csrf.guard';
import { CsrfRefreshInterceptor } from './common/interceptors/csrf-refresh.interceptor';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AccountsModule } from './accounts/accounts.module';
import { TransactionsModule } from './transactions/transactions.module';
import { CategoriesModule } from './categories/categories.module';
import { CurrenciesModule } from './currencies/currencies.module';
import { SecuritiesModule } from './securities/securities.module';
import { PayeesModule } from './payees/payees.module';
import { ScheduledTransactionsModule } from './scheduled-transactions/scheduled-transactions.module';
import { ReportsModule } from './reports/reports.module';
import { DatabaseModule } from './database/database.module';
import { ImportModule } from './import/import.module';
import { NetWorthModule } from './net-worth/net-worth.module';
import { BuiltInReportsModule } from './built-in-reports/built-in-reports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../.env',
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DATABASE_HOST'),
        port: configService.get('DATABASE_PORT'),
        username: configService.get('DATABASE_USER'),
        password: configService.get('DATABASE_PASSWORD'),
        database: configService.get('DATABASE_NAME'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: false, // Use migrations in production
        logging: ['error'],
        ssl: configService.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
      }),
    }),

    // Rate limiting - multiple tiers
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute for general API
      },
      {
        name: 'auth',
        ttl: 900000, // 15 minutes
        limit: 5, // 5 attempts per 15 minutes for auth endpoints (brute force protection)
      },
    ]),

    // Scheduled tasks
    ScheduleModule.forRoot(),

    // Feature modules
    HealthModule,
    AuthModule,
    UsersModule,
    AccountsModule,
    TransactionsModule,
    CategoriesModule,
    PayeesModule,
    CurrenciesModule,
    SecuritiesModule,
    ScheduledTransactionsModule,
    ReportsModule,
    DatabaseModule,
    ImportModule,
    NetWorthModule,
    BuiltInReportsModule,
    NotificationsModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_INTERCEPTOR, useClass: CsrfRefreshInterceptor },
  ],
})
export class AppModule {}
