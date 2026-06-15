import { Test, TestingModule } from "@nestjs/testing";
import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import { User } from "@/users/entities/user.entity";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "@/scheduled-transactions/entities/scheduled-transaction-override.entity";
import { Account } from "@/accounts/entities/account.entity";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { ScheduledTransactionOverrideService } from "@/scheduled-transactions/scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "@/scheduled-transactions/scheduled-transaction-loan.service";
import * as bcrypt from "bcryptjs";

/**
 * Provides a lightweight I18nService globally to the integration test graph.
 * Several services (email senders, etc.) inject I18nService; the app supplies it
 * via the global nestjs-i18n module, but the integration TestingModule builds
 * feature modules in isolation. A stub avoids pulling in the real I18nModule
 * (whose `watch: true` file watcher would leak a handle and hang Jest). The
 * stub returns the English `defaultValue`, matching production behaviour for the
 * default locale.
 */
@Global()
@Module({
  providers: [
    {
      provide: I18nService,
      useValue: {
        translate: (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key,
        t: (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key,
      },
    },
  ],
  exports: [I18nService],
})
class TestI18nModule {}

/**
 * Creates a NestJS TestingModule wired to a real PostgreSQL database.
 * Uses `synchronize: true` and `dropSchema: true` so each test suite
 * starts with a clean schema derived from entity metadata.
 *
 * Replaces ScheduledTransactionsModule with a stub to break the
 * circular dependency (Transactions -> Accounts -> ScheduledTransactions -> Transactions).
 *
 * NetWorthService.triggerDebouncedRecalc is mocked to a no-op to prevent
 * timer leaks in tests.
 */
export async function createIntegrationModule(
  modules: any[],
): Promise<TestingModule> {
  const moduleBuilder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      TestI18nModule,
      TypeOrmModule.forRoot({
        type: "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        port: parseInt(process.env.DATABASE_PORT || "5432"),
        username: process.env.DATABASE_USER || "monize_user",
        password: process.env.DATABASE_PASSWORD || "monize_password",
        database: process.env.DATABASE_NAME || "monize_test",
        entities: [__dirname + "/../../src/**/*.entity{.ts,.js}"],
        synchronize: true,
        dropSchema: true,
      }),
      ...modules,
    ],
  })
    // Replace ScheduledTransactionsModule to break circular dependency.
    // AccountsModule imports ScheduledTransactionsModule (forwardRef),
    // which imports TransactionsModule (no forwardRef), causing undefined
    // in the circular chain. We stub it with just the entity registrations
    // and mock services.
    .overrideModule(ScheduledTransactionsModule)
    .useModule({
      module: class StubScheduledTransactionsModule {},
      imports: [
        TypeOrmModule.forFeature([
          ScheduledTransaction,
          ScheduledTransactionSplit,
          ScheduledTransactionOverride,
          Account,
        ]),
      ],
      providers: [
        {
          provide: ScheduledTransactionsService,
          useValue: {},
        },
        {
          provide: ScheduledTransactionOverrideService,
          useValue: {},
        },
        {
          provide: ScheduledTransactionLoanService,
          useValue: {},
        },
      ],
      exports: [ScheduledTransactionsService],
    });

  const module = await moduleBuilder.compile();

  // Mock triggerDebouncedRecalc to prevent timer leaks
  const netWorthService = module.get(NetWorthService);
  jest
    .spyOn(netWorthService, "triggerDebouncedRecalc")
    .mockImplementation(() => {});

  return module;
}

/**
 * Truncates the given tables (with CASCADE) for inter-test cleanup.
 * Table names should be the SQL table names (snake_case).
 */
export async function cleanTables(
  dataSource: DataSource,
  tableNames: string[],
): Promise<void> {
  const tables = tableNames.join(", ");
  await dataSource.query(`TRUNCATE ${tables} CASCADE`);
}

/**
 * Inserts a user directly via DataSource, bypassing AuthModule.
 * Returns the saved User entity with a generated UUID.
 */
export async function createTestUserDirect(
  dataSource: DataSource,
  overrides: Partial<{
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  }> = {},
): Promise<User> {
  const passwordHash = await bcrypt.hash("TestPassword123!", 4); // low rounds for speed
  const user = dataSource.manager.create(User, {
    email:
      overrides.email ||
      `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    firstName: overrides.firstName || "Test",
    lastName: overrides.lastName || "User",
    passwordHash,
    authProvider: "local",
    role: overrides.role || "user",
    isActive: true,
    emailVerified: true,
  });
  return dataSource.manager.save(user);
}
