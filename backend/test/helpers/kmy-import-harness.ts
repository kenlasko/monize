import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { Account } from "@/accounts/entities/account.entity";
import { Category } from "@/categories/entities/category.entity";
import { Payee } from "@/payees/entities/payee.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { UsersService } from "@/users/users.service";
import { CurrenciesService } from "@/currencies/currencies.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { SecuritiesService } from "@/securities/securities.service";
import { SecurityPriceService } from "@/securities/security-price.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { Security } from "@/securities/entities/security.entity";
import { SecurityPrice } from "@/securities/entities/security-price.entity";
import { Holding } from "@/securities/entities/holding.entity";
import { InvestmentTransaction } from "@/securities/entities/investment-transaction.entity";
import { HoldingsService } from "@/securities/holdings.service";
import { TransactionRulesApplierService } from "@/transaction-rules/transaction-rules-applier.service";
import { ExchangeRate } from "@/currencies/entities/exchange-rate.entity";
import { Tag } from "@/tags/entities/tag.entity";
import { TransactionTag } from "@/tags/entities/transaction-tag.entity";
import { TransactionSplitTag } from "@/tags/entities/transaction-split-tag.entity";
import { TagsService } from "@/tags/tags.service";
import { ActionHistoryService } from "@/action-history/action-history.service";
import { ImportPostProcessingService } from "@/import/import-post-processing.service";
import { RateHistoryCatchUpService } from "@/currencies/rate-history-catch-up.service";
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { ImportStagedFile } from "@/import/mny/entities/import-staged-file.entity";
import { MnyImportJobService } from "@/import/mny/mny-import-job.service";
import { MnyImportService } from "@/import/mny/mny-import.service";
import { MnyParserService } from "@/import/mny/mny-parser.service";
import { MnyMarketRateService } from "@/import/mny/mny-market-rates.service";
import { MnyStagingService } from "@/import/mny/mny-staging.service";
import {
  KMY_SOURCE_PARSER,
  type ImportSourceParser,
} from "@/import/mny/model/import-source";
import { KmyParserService } from "@/import/kmy/kmy-parser.service";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "./integration-setup";

/** Every table a KMyMoney import writes, in delete order. */
export const KMY_TABLES = [
  "holdings",
  "investment_transactions",
  "transaction_split_tags",
  "transaction_tags",
  "transaction_splits",
  "transactions",
  "scheduled_transaction_splits",
  "scheduled_transactions",
  "security_prices",
  "securities",
  "import_jobs",
  "import_staged_files",
  "accounts",
  "categories",
  "payee_aliases",
  "payees",
  "tags",
  "exchange_rates",
];

export interface KmyHarnessOptions {
  /**
   * Wraps the real parser. Default: the real `KmyParserService` itself. A
   * wrapper lets a case alter what the parser returns while the real reader
   * and mapper still run.
   */
  readonly wrapParser?: (real: KmyParserService) => ImportSourceParser;
}

export type KmyStartOptions = NonNullable<
  Parameters<MnyImportService["start"]>[1]["options"]
>;

export interface KmyHarness {
  readonly module: TestingModule;
  readonly dataSource: DataSource;
  readonly userId: string;
  readonly importService: MnyImportService;
  readonly staging: MnyStagingService;
  readonly jobs: MnyImportJobService;
  ensureCurrency(code: string): Promise<void>;
  stage(
    bytes: Buffer,
    filename?: string,
    format?: string,
  ): ReturnType<MnyStagingService["stage"]>;
  awaitJob(jobId: string): Promise<ImportJob>;
  runKmy(bytes: Buffer, extra?: KmyStartOptions): Promise<ImportJob>;
  balanceOf(name: string): Promise<number>;
  /** Stubs `UsersService.deleteData` to truncate the imported rows. */
  stubWipe(): void;
}

/**
 * Registers the Nest module, user and per-test clean-up of a KMyMoney import
 * suite in the calling `describe`, and returns the handles. The values are
 * filled by `beforeAll`, so read them inside a test or hook, never at the
 * `describe` level.
 */
export function useKmyImportHarness(
  options: KmyHarnessOptions = {},
): KmyHarness {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let importService: MnyImportService;
  let staging: MnyStagingService;
  let jobs: MnyImportJobService;

  async function ensureCurrency(code: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ($1, $1, $1, 2, true) ON CONFLICT (code) DO NOTHING`,
      [code],
    );
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([
          Account,
          Category,
          Payee,
          Transaction,
          TransactionSplit,
          UserPreference,
          ImportJob,
          ImportStagedFile,
          Security,
          SecurityPrice,
          Holding,
          InvestmentTransaction,
          ExchangeRate,
          Tag,
          TransactionTag,
          TransactionSplitTag,
        ]),
      ],
      providers: [
        MnyStagingService,
        MnyParserService,
        MnyMarketRateService,
        MnyImportJobService,
        MnyImportService,
        KmyParserService,
        {
          provide: KMY_SOURCE_PARSER,
          useFactory: (real: KmyParserService): ImportSourceParser =>
            options.wrapParser ? options.wrapParser(real) : real,
          inject: [KmyParserService],
        },
        // Real: its balance recalculation is the cross-check the verification
        // report compares against.
        ImportPostProcessingService,
        // Real: the import creates tags through its find-or-create, and the
        // `transaction_tags` writes are what the tag cases read. Its history
        // recorder only needs the DataSource and ModuleRef.
        TagsService,
        ActionHistoryService,
        // Stubbed: these reach external price and FX providers.
        {
          provide: NetWorthService,
          useValue: { recalculateAccount: async () => undefined },
        },
        {
          provide: SecurityPriceService,
          useValue: {
            backfillHistoricalPrices: async () => undefined,
            backfillTransactionPrices: async () => undefined,
          },
        },
        {
          // Stubbed: the bond-price recompute is not what these cases read.
          provide: SecuritiesService,
          useValue: { recomputeBondPricesOfAccounts: async () => undefined },
        },
        {
          provide: ExchangeRateService,
          // No stored history and nothing from the provider: a trade the file
          // cannot convert stays unconverted, as it did before the lookup.
          useValue: {
            backfillHistoricalRates: async () => undefined,
            resolveStoredRate: async () => ({ rate: null }),
            fillRateWindow: async () => ({ stored: 0, answered: true }),
          },
        },
        {
          // Stubbed: the post-import gap fill reaches the FX provider.
          provide: RateHistoryCatchUpService,
          useValue: { start: () => undefined },
        },
        { provide: UsersService, useValue: { deleteData: jest.fn() } },
        // No rules: the rules pass is covered against the real applier in
        // transaction-rules-import.integration.spec.ts.
        {
          provide: TransactionRulesApplierService,
          useValue: {
            loadRulesFor: async () => [],
            applyToNew: async () => [],
          },
        },
        {
          provide: CurrenciesService,
          useValue: {
            ensureCurrencyForUser: (_userId: string, code: string) =>
              ensureCurrency(code),
          },
        },
        // The real holdings rebuild -- the whole point of the investment half of
        // this suite is that the canonical fold, not an importer's private one,
        // produces the positions. It reaches the database only through the
        // manager it is handed, so the AccountsService/SecuritiesService graph
        // behind it is never touched by `rebuildAccountsFromTransactions`.
        {
          provide: HoldingsService,
          useFactory: (source: DataSource) =>
            new HoldingsService(null as never, null as never, source),
          inject: [DataSource],
        },
      ],
    }).compile();

    dataSource = module.get(DataSource);
    userId = (await createTestUserDirect(dataSource)).id;
    await ensureCurrency("USD");
    await ensureCurrency("EUR");
    importService = module.get(MnyImportService);
    staging = module.get(MnyStagingService);
    jobs = module.get(MnyImportJobService);
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, KMY_TABLES);
  });

  const stage: KmyHarness["stage"] = (
    bytes,
    filename = "books.kmy",
    format = "kmy",
  ) =>
    withUserContext(userId, () =>
      staging.stage(userId, { filename, data: bytes, sourceFormat: format }),
    );

  async function awaitJob(jobId: string): Promise<ImportJob> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await withUserContext(userId, () =>
        jobs.findOne(userId, jobId),
      );
      if (
        current &&
        current.status !== "pending" &&
        current.status !== "running"
      ) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("import job did not finish");
  }

  /**
   * `start` stores the options it is given with `bills: []` when the field is
   * absent, so (as the wizard does) the bill handle is sent explicitly.
   */
  async function runKmy(
    bytes: Buffer,
    extra?: KmyStartOptions,
  ): Promise<ImportJob> {
    const startOptions = { bills: [1], ...extra };
    const staged = await stage(bytes);
    const started = await withUserContext(userId, () =>
      importService.start(userId, {
        stagedFileId: staged.id,
        options: startOptions,
        sourceFormat: "kmy",
      }),
    );
    return awaitJob(started.id);
  }

  const balanceOf = async (name: string): Promise<number> => {
    const account = await dataSource
      .getRepository(Account)
      .findOneOrFail({ where: { userId, name } });
    return Number(account.currentBalance);
  };

  return {
    get module() {
      return module;
    },
    get dataSource() {
      return dataSource;
    },
    get userId() {
      return userId;
    },
    get importService() {
      return importService;
    },
    get staging() {
      return staging;
    },
    get jobs() {
      return jobs;
    },
    ensureCurrency,
    stage,
    awaitJob,
    runKmy,
    balanceOf,
    stubWipe() {
      // `deleteData` is stubbed here, so the stub removes the imported rows
      // (not the job and staged rows the running import needs).
      jest
        .mocked(module.get(UsersService).deleteData)
        .mockImplementation(async () => {
          await cleanTables(
            dataSource,
            KMY_TABLES.filter(
              (table) =>
                table !== "import_jobs" && table !== "import_staged_files",
            ),
          );
          return undefined as never;
        });
    },
  };
}
