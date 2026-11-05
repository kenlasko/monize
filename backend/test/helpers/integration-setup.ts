import { Test, TestingModule } from "@nestjs/testing";
import { Global, Module } from "@nestjs/common";
import type { Provider, Type } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import { POLISH_BOND_ADAPTER } from "@/bonds/adapters/pl/index";
import { FIXTURE_CATALOG } from "@/bonds/adapters/pl/pl-test-input";
import { fetchSeries } from "@/bonds/adapters/us/series/fetch-series";
import {
  fakeFetch,
  fixtureJson,
  fixtureText,
  treasuryAnswers,
} from "@/bonds/adapters/us/series/fixture-helpers";
import type { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondProgramId } from "@/bonds/bond-instrument-id";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext } from "@/common/db/with-context";
import { User } from "@/users/entities/user.entity";
import { NetWorthService } from "@/net-worth/net-worth.service";
import type { TypeOrmModuleOptions } from "@nestjs/typeorm";
import * as bcrypt from "bcryptjs";
import {
  applyRlsPolicies,
  TEST_APP_ROLE,
  TEST_APP_ROLE_PASSWORD,
} from "./rls-setup";
import { settlePendingPriceWrites } from "@/securities/security-price.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { settlePendingAccountRecalcs } from "@/net-worth/net-worth.service";
import { DatabaseStorageProvider } from "@/attachments/storage/database-storage.provider";
import type { AttachmentStorageProvider } from "@/attachments/storage/attachment-storage.interface";
import { ATTACHMENT_STORAGE_PROVIDER } from "@/attachments/storage/attachment-storage.interface";
import { AttachmentStorageRegistry } from "@/attachments/storage/attachment-storage.registry";
import { CLUSTER_MODE } from "@/common/cluster/cluster-mode";
import { ReplicaCensusService } from "@/common/cluster/replica-census.service";

/**
 * Shared PostgreSQL connection options for integration suites. Specs that need
 * a real database with a schema synchronized from the entities use this instead
 * of copying the env-var defaults, so a config change lives in one place.
 *
 * **`dropSchema` means suites using this cannot run concurrently.** Every suite
 * drops and rebuilds the schema of the one shared `monize_test` database, so a
 * second worker starting up pulls the tables out from under a running suite --
 * which surfaces as "connection terminated" from an unrelated spec rather than
 * as anything resembling its cause. `test/jest-e2e.json` therefore pins
 * `maxWorkers: 1`; keep it there rather than relying on a `--runInBand` flag at
 * a call site, since the config is what every entry point shares.
 */
export const INTEGRATION_TYPEORM_OPTIONS: TypeOrmModuleOptions = {
  type: "postgres",
  host: process.env.DATABASE_HOST || "localhost",
  port: parseInt(process.env.DATABASE_PORT || "5432"),
  username: process.env.DATABASE_USER || "monize_user",
  password: process.env.DATABASE_PASSWORD || "monize_password",
  database: process.env.DATABASE_NAME || "monize_test",
  entities: [__dirname + "/../../src/**/*.entity{.ts,.js}"],
  synchronize: true,
  dropSchema: true,
  // Derived-state writes are fire-and-forget by design (undo entries, net-worth
  // recalcs, price backfills), so a fixture that writes a handful of rows per
  // test leaves several transactions still draining when the test body starts.
  // The node-postgres default pool of 10 is too small to absorb that, and its
  // default `connectionTimeoutMillis` of 0 means a caller that cannot get a
  // connection waits FOREVER -- which surfaces as jest's 30s per-test timeout
  // with nothing naming the pool. A finite acquire timeout turns that into
  // "timeout exceeded when trying to connect", which says what happened.
  extra: { max: 20, connectionTimeoutMillis: 10000 },
};

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
 * What the app's `@Global` `ClusterModule` supplies, without it: that module
 * reads `CLUSTER_MODE` from the environment and, in `multi`, builds a `LISTEN`
 * connection. Integration suites run as one `single` process, so the mode is
 * the literal and the replica census is the real class over the suite's own
 * `DataSource` (it opens nothing until it is asked). `SystemAlertMonitorService`
 * injects both, so every suite that reaches `SystemAlertsModule` needs them.
 */
@Global()
@Module({
  providers: [
    { provide: CLUSTER_MODE, useValue: "single" },
    ReplicaCensusService,
  ],
  exports: [CLUSTER_MODE, ReplicaCensusService],
})
class TestClusterModule {}

/**
 * Creates a NestJS TestingModule wired to a real PostgreSQL database.
 * Uses `synchronize: true` and `dropSchema: true` so each test suite
 * starts with a clean schema derived from entity metadata.
 *
 * The module graph is the production one: `ScheduledTransactionsModule` is the
 * real module wherever a suite's imports reach it, resolved through the same
 * `forwardRef` edges the app uses (Transactions -> Accounts ->
 * ScheduledTransactions -> Transactions). It used to be replaced by a stub
 * whose services were empty objects, so the real `post()`, the auto-post cron
 * and every consumer of the occurrence services could not run in any suite
 * (A26-M42).
 *
 * NetWorthService.triggerDebouncedRecalc is mocked to a no-op to prevent
 * timer leaks in tests.
 */
export interface IntegrationModuleOptions {
  /**
   * Connection overrides merged over `INTEGRATION_TYPEORM_OPTIONS`. The one
   * caller today is the enforcement harness below, which points the module at
   * the unprivileged runtime role after an owner connection has built the
   * schema.
   */
  typeOrmOptions?: Record<string, unknown>;
  /**
   * Whether to install the RLS objects on the module's own connection. Off for
   * a connection that is not the table owner: `provisionAppRole` and the policy
   * migrations are owner work, and a caller that passes `false` has already
   * done it on the owner connection.
   */
  applyRls?: boolean;
}

export async function createIntegrationModule(
  modules: any[],
  { typeOrmOptions = {}, applyRls = true }: IntegrationModuleOptions = {},
): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      TestI18nModule,
      TestClusterModule,
      TypeOrmModule.forRoot({
        ...INTEGRATION_TYPEORM_OPTIONS,
        ...typeOrmOptions,
      } as never),
      ...modules,
    ],
  }).compile();

  // Bring the synchronize-built schema up to the real database's shape: runtime
  // role + grants, RLS helper functions and policies, updated_at triggers (T1).
  // Policies ship without ENABLE, so this is inert for suites that do not opt
  // into enforcement -- see rls-setup.ts.
  if (applyRls) await applyRlsPolicies(module.get(DataSource));

  // Mock triggerDebouncedRecalc to prevent timer leaks.
  //
  // Only when the graph actually holds one. A suite that imports no application
  // module -- `createIntegrationModule([])`, which the push chart token spec
  // uses because it wants a DataSource and constructs its own service -- has no
  // debounced recalc to leak, and `get` THROWS for an absent provider rather
  // than returning undefined. The catch is narrow on purpose: a
  // NetWorthService that is present resolves, so this only swallows the
  // "nobody asked for it" case and never a broken provider.
  let netWorthService: NetWorthService | null;
  try {
    netWorthService = module.get(NetWorthService, { strict: false });
  } catch {
    netWorthService = null;
  }
  if (netWorthService) {
    jest
      .spyOn(netWorthService, "triggerDebouncedRecalc")
      .mockImplementation(() => {});
  }

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
  // Creating a security or an investment transaction starts a price fetch that
  // nobody awaits, and the write it eventually makes has outlived the request
  // that caused it. Truncating `securities ... CASCADE` underneath one takes
  // the same locks in the opposite order -- a deadlock reported against
  // whichever spec happened to be running -- and when the truncate wins
  // instead, the insert fails as an orphan foreign key. Both look like a bug
  // in the test rather than in its housekeeping.
  //
  // So the tables are only emptied once the database is quiet. This waits on
  // work that has started, not on a duration, so it costs nothing when there
  // is none.
  await settlePendingPriceWrites();
  // The same problem for undo entries: `record` is never awaited by its
  // callers, so a history INSERT can be in flight against the `users` row
  // this truncate is about to remove.
  await settlePendingHistoryWrites();
  // And for account recomputes: the post-import pass starts one per account
  // without awaiting it, and its reads of `transactions` deadlocked against
  // this truncate (ofx-import-fitid, "deadlock detected" in cleanTables).
  await settlePendingAccountRecalcs();
  const tables = tableNames.join(", ");
  await dataSource.query(`TRUNCATE ${tables} CASCADE`);
}

/**
 * Runs a DELETE on `bond_instruments` with its immutability trigger disabled,
 * for a test that has to prove another guard (a foreign key) or tidy a row it
 * created. The trigger is always re-enabled, whether or not the DELETE fails.
 * Sequential suites only: DISABLE TRIGGER takes a table lock and the setting is
 * visible to every connection while it lasts.
 */
export async function deleteBondInstrumentBypassingImmutability(
  dataSource: DataSource,
  deleteSql: string,
  params: unknown[],
): Promise<void> {
  await dataSource.query(
    `ALTER TABLE bond_instruments DISABLE TRIGGER trg_bond_instruments_immutable`,
  );
  try {
    await dataSource.query(deleteSql, params);
  } finally {
    await dataSource.query(
      `ALTER TABLE bond_instruments ENABLE TRIGGER trg_bond_instruments_immutable`,
    );
  }
}

/**
 * Stores the curated October 2026 series (the unit tests' fixture terms, which
 * the adapter no longer ships: spec bond-program-securities.md 2.6) through the
 * catalog's `storeEntry`, as a fetch would, with the benchmark rows they read.
 * `seriesCodes` limits it to those series; absent, all eight. The program's
 * currency must exist or is created inactive by the catalog.
 */
export async function storeFixtureSeries(
  dataSource: DataSource,
  catalog: BondCatalogService,
  seriesCodes?: readonly string[],
): Promise<void> {
  await withSystemContext(() =>
    withScopedDb(dataSource, async (m) => {
      for (const entry of FIXTURE_CATALOG) {
        const code = (entry.terms as { instrument: { seriesCode: string } })
          .instrument.seriesCode;
        if (seriesCodes && !seriesCodes.includes(code)) continue;
        const outcome = await catalog.storeEntry(m, entry);
        if (outcome.kind !== "inserted" && outcome.kind !== "unchanged") {
          throw new Error(
            `Fixture series ${code} was not stored: ${outcome.kind}`,
          );
        }
      }
      await catalog.seedBenchmarkSeries([POLISH_BOND_ADAPTER]);
    }),
  );
}

/** The constructed Treasury fixtures of `adapters/us/series/fixtures/`, by product. */
export const US_FIXTURE_SERIES = {
  BILL: {
    seriesCode: "912797WM5261001",
    cusip: "912797WM5",
    records: "ta-ws-912797WM5.json",
    results: { "R_20260929_1.xml": "R_20260929_1.xml" },
  },
  NOTE: {
    seriesCode: "91282CZK0",
    cusip: "91282CZK0",
    records: "ta-ws-91282CZK0.json",
    results: {
      "R_20260928_1.xml": "R_20260928_1.xml",
      "R_20261027_1.xml": "R_20260928_1.xml",
    },
  },
  TIPS: {
    seriesCode: "912810FQ6",
    cusip: "912810FQ6",
    records: "ta-ws-912810FQ6.json",
    results: { "R_20011025_1.xml": "R_20011025_1.xml" },
  },
} as const;

/**
 * Stores one US Treasury fixture series (a bill, a note or a TIPS) as a fetch
 * would: the adapter's own `fetchSeries` over the saved answers, then the
 * catalog's `storeEntry`. No network. The currency USD must exist.
 */
export async function storeUsFixtureSeries(
  dataSource: DataSource,
  catalog: BondCatalogService,
  product: keyof typeof US_FIXTURE_SERIES,
): Promise<void> {
  const fixture = US_FIXTURE_SERIES[product];
  const answers = treasuryAnswers(
    fixture.cusip,
    fixtureJson(fixture.records),
    Object.fromEntries(
      Object.entries(fixture.results).map(([served, file]) => [
        served,
        fixtureText(file),
      ]),
    ),
  );
  const { entry } = await fetchSeries(
    fixture.seriesCode,
    fakeFetch(answers),
    () => new Date("2026-11-04T10:00:00.000Z"),
  );
  await withSystemContext(() =>
    withScopedDb(dataSource, async (m) => {
      const outcome = await catalog.storeEntry(m, entry);
      if (outcome.kind !== "inserted" && outcome.kind !== "unchanged") {
        throw new Error(
          `Fixture series ${fixture.seriesCode} was not stored: ${outcome.kind}`,
        );
      }
    }),
  );
}

/**
 * Inserts a bond program (the product a series belongs to) under its
 * deterministic id and returns the id, for a test that inserts a bond
 * instrument by hand: `bond_instruments.bond_program_id` is NOT NULL. A program
 * already there is left as it is (`bond_programs` is insert only). The currency
 * must exist.
 */
export async function insertBondProgram(
  dataSource: DataSource,
  programCode = "EDO",
  currencyCode = "PLN",
  issuerCountryCode = "PL",
  issuerCode = "PL_MF",
): Promise<string> {
  const id = bondProgramId(issuerCountryCode, issuerCode, programCode);
  await dataSource.query(
    `INSERT INTO bond_programs (id, issuer_country_code, issuer_code, program_code, currency_code)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (issuer_country_code, issuer_code, program_code) DO NOTHING`,
    [id, issuerCountryCode, issuerCode, programCode, currencyCode],
  );
  return id;
}

/**
 * Runs a DELETE on `bond_programs` with its immutability trigger disabled, as
 * `deleteBondInstrumentBypassingImmutability` does for instruments.
 */
export async function deleteBondProgramBypassingImmutability(
  dataSource: DataSource,
  deleteSql: string,
  params: unknown[],
): Promise<void> {
  await dataSource.query(
    `ALTER TABLE bond_programs DISABLE TRIGGER trg_bond_programs_immutable`,
  );
  try {
    await dataSource.query(deleteSql, params);
  } finally {
    await dataSource.query(
      `ALTER TABLE bond_programs ENABLE TRIGGER trg_bond_programs_immutable`,
    );
  }
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

/**
 * A module whose services run against a database that is actually enforcing
 * row-level security.
 *
 * Two connections, because production has two roles and one of them cannot do
 * the other's job. `owner` builds the schema, installs the policies and the
 * enable, and seeds -- it is the table owner, so RLS never filters it, which is
 * what makes a fixture writable at all. The module's own connection is the
 * unprivileged `monize_app` role, exactly as `RLS_MODE=enforce` configures the
 * runtime, so every service call through `withScopedDb` is filtered by the same
 * policies that ship.
 *
 * `RLS_MODE` is set to `enforce` for the harness's lifetime: at `off` no
 * identity GUC is emitted, and a policied query from a role with no
 * `app.current_user_id` returns zero rows -- a suite that forgot this reads as
 * a scoping bug in every assertion at once.
 *
 * Seed through `owner`. A fixture written through the module's connection has
 * to satisfy the same `WITH CHECK` the code under test does, which makes the
 * fixture evidence of the thing it is meant to be independent of.
 */
export interface EnforcedIntegrationHarness {
  module: TestingModule;
  /** The table owner: builds the schema, seeds, cleans. Not filtered by RLS. */
  owner: DataSource;
  /** The module's connection, as the unprivileged runtime role. */
  app: DataSource;
  /** Closes both connections and restores `RLS_MODE`. */
  close: () => Promise<void>;
}

export async function createEnforcedIntegrationModule(
  modules: any[],
): Promise<EnforcedIntegrationHarness> {
  const owner = new DataSource({
    ...INTEGRATION_TYPEORM_OPTIONS,
  } as never);
  await owner.initialize();
  await applyRlsPolicies(owner, { includeEnable: true });

  const previousMode = process.env.RLS_MODE;
  process.env.RLS_MODE = "enforce";

  let module: TestingModule;
  try {
    module = await createIntegrationModule(modules, {
      typeOrmOptions: {
        username: TEST_APP_ROLE,
        password: TEST_APP_ROLE_PASSWORD,
        // The owner connection above already built the schema and dropped the
        // previous one. A second synchronize would race it, and the runtime
        // role has no privilege to do either.
        synchronize: false,
        dropSchema: false,
      },
      applyRls: false,
    });
  } catch (err) {
    restoreRlsMode(previousMode);
    await owner.destroy();
    throw err;
  }

  return {
    module,
    owner,
    app: module.get(DataSource),
    close: async () => {
      await module.close();
      restoreRlsMode(previousMode);
      if (owner.isInitialized) await owner.destroy();
    },
  };
}

function restoreRlsMode(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.RLS_MODE;
  } else {
    process.env.RLS_MODE = previous;
  }
}

/**
 * The attachment-storage providers an integration module needs to resolve
 * `AttachmentsService` and the backup export.
 *
 * Three suites spelled out the same pair (`DatabaseStorageProvider` plus the
 * `ATTACHMENT_STORAGE_PROVIDER` token) and all three broke together the moment a
 * third provider -- `AttachmentStorageRegistry`, which resolves a row's own
 * backend rather than the bound one -- joined the graph. Nest resolves these at
 * run time, so `tsc` cannot see the gap and only the database-backed job does:
 * one helper is what keeps the next suite from finding that out in CI.
 *
 * `database` because it is the provider whose bytes the export actually judges,
 * and it needs no filesystem or bucket configuration. The registry is the real
 * class over that one provider, so a row naming any other backend resolves to
 * `null` here exactly as it would in a deployment that has not configured it.
 */
export function attachmentStorageProviders(
  options: { provider?: Type<AttachmentStorageProvider> } = {},
): Provider[] {
  // A suite whose subject is an external provider (`local` over a real
  // directory) names the class here, so the token and the registry still come
  // from this one list rather than a second copy in the suite.
  const bound = options.provider ?? DatabaseStorageProvider;
  return [
    bound,
    {
      provide: ATTACHMENT_STORAGE_PROVIDER,
      useExisting: bound,
    },
    {
      provide: AttachmentStorageRegistry,
      useFactory: (provider: AttachmentStorageProvider) =>
        new AttachmentStorageRegistry(provider, [provider]),
      inject: [bound],
    },
  ];
}
