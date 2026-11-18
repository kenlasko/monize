import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
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
import { KMY_SOURCE_PARSER } from "@/import/mny/model/import-source";
import { KmyParserService } from "@/import/kmy/kmy-parser.service";
import { KmyImportController } from "@/import/kmy/kmy-import.controller";
import { readKmyFixture } from "@/import/kmy/__fixtures__/kmy-fixtures";
import {
  kmyAccount,
  kmyFile,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";
import { readMnyFixture } from "@/import/mny/__fixtures__/mny-fixtures";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * A KMyMoney file through the real pipeline: bytes -> reader -> mapper ->
 * commit -> verification, against PostgreSQL. The expected numbers are the
 * reference's section 18 ground truth, not anything the importer printed.
 */
describe("kmy import (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let importService: MnyImportService;
  let staging: MnyStagingService;
  let jobs: MnyImportJobService;

  const TABLES = [
    "holdings",
    "investment_transactions",
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
    "payees",
    "exchange_rates",
  ];

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
        { provide: KMY_SOURCE_PARSER, useExisting: KmyParserService },
        // Real: its balance recalculation is the cross-check the verification
        // report compares against.
        ImportPostProcessingService,
        // Real: the import creates tags through its find-or-create, and the
        // `transaction_tags` writes below are what this suite is for. Its
        // history recorder only needs the DataSource and ModuleRef.
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
    await cleanTables(dataSource, TABLES);
  });

  const stage = (bytes: Buffer, filename = "books.kmy", format = "kmy") =>
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
    extra?: Parameters<typeof importService.start>[1]["options"],
  ): Promise<ImportJob> {
    const options = { bills: [1], ...extra };
    const staged = await stage(bytes);
    const started = await withUserContext(userId, () =>
      importService.start(userId, {
        stagedFileId: staged.id,
        options,
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

  describe("the reference's section 18 file", () => {
    it("reproduces the ground truth with every verification delta 0", async () => {
      const job = await runKmy(readKmyFixture("syntheticKmy"));

      expect(job).toMatchObject({ status: "completed", dataCommitted: true });
      expect(job.sourceFormat).toBe("kmy");
      const result = job.result!;
      for (const line of result.verification) {
        expect(line.delta).toBe(0);
        expect(line.matches).toBe(true);
        expect(line.mappedBalance).toBe(line.expectedBalance);
      }
      expect(result.holdings.every((h) => h.matches && h.delta === 0)).toBe(
        true,
      );

      expect(await balanceOf("Checking")).toBe(2804.5);
      expect(await balanceOf("EUR Savings")).toBe(1000);
      expect(await balanceOf("Brokerage Account - Cash")).toBe(647.5);
      expect(await balanceOf("Old Savings")).toBe(0);
      expect(await balanceOf("Brokerage Account - Brokerage")).toBe(0);
    });

    it("holds 15 shares at a total cost of 378.75 after the canonical fold", async () => {
      await runKmy(readKmyFixture("syntheticKmy"));
      const rows: { quantity: string; average_cost: string; symbol: string }[] =
        await dataSource.query(
          `SELECT h.quantity, h.average_cost, s.symbol
             FROM holdings h
             JOIN accounts a ON a.id = h.account_id
             JOIN securities s ON s.id = h.security_id
            WHERE a.user_id = $1 AND h.quantity <> 0`,
          [userId],
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].symbol).toBe("EXC");
      expect(Number(rows[0].quantity)).toBe(15);
      expect(
        Number(rows[0].quantity) * Number(rows[0].average_cost),
      ).toBeCloseTo(378.75, 4);
    });

    it("writes the expected rows, prices, rate, reconcile dates and closed account", async () => {
      const job = await runKmy(readKmyFixture("syntheticKmy"));
      const result = job.result!;

      expect(result.accountsCreated).toBe(5);
      expect(result.investmentTransactionsCreated).toBe(4);
      expect(result.transfersLinked).toBe(3);
      expect(result.billsCreated).toBe(1);
      expect(result.pricesImported).toBeGreaterThan(0);

      const investmentActions: { action: string }[] = await dataSource.query(
        `SELECT action FROM investment_transactions WHERE user_id = $1
          ORDER BY transaction_date, created_at`,
        [userId],
      );
      expect(investmentActions.map((r) => r.action).sort()).toEqual(
        ["BUY", "DIVIDEND", "SELL", "SPLIT"].sort(),
      );

      const prices: { source: string }[] = await dataSource.query(
        `SELECT p.source FROM security_prices p JOIN securities s ON s.id = p.security_id
          WHERE s.symbol = 'EXC'`,
      );
      expect(prices.length).toBeGreaterThanOrEqual(2);
      expect(new Set(prices.map((p) => p.source))).toEqual(
        new Set(["kmy_import"]),
      );

      const rates: {
        from_currency: string;
        to_currency: string;
        rate: string;
        source: string;
      }[] = await dataSource.query(
        `SELECT from_currency, to_currency, rate, source FROM exchange_rates`,
      );
      expect(rates).toHaveLength(1);
      expect(rates[0]).toMatchObject({
        from_currency: "EUR",
        to_currency: "USD",
        source: "kmy_import",
      });
      expect(Number(rates[0].rate)).toBeCloseTo(1.1, 8);

      const eurLeg: { exchange_rate: string; amount: string }[] =
        await dataSource.query(
          `SELECT t.exchange_rate, t.amount FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.user_id = $1 AND a.name = 'EUR Savings'`,
          [userId],
        );
      expect(eurLeg).toHaveLength(1);
      expect(Number(eurLeg[0].amount)).toBe(1000);
      // Spec 5.6.4: the receiving leg carries roundFxRate(1000 / 1100).
      expect(Number(eurLeg[0].exchange_rate)).toBeCloseTo(0.9090909091, 10);

      const reconciled: { n: string }[] = await dataSource.query(
        `SELECT count(*) AS n FROM transactions
          WHERE user_id = $1 AND reconciled_date = '2024-01-31'`,
        [userId],
      );
      expect(Number(reconciled[0].n)).toBeGreaterThan(0);

      const old = await dataSource
        .getRepository(Account)
        .findOneOrFail({ where: { userId, name: "Old Savings" } });
      expect(old.isClosed).toBe(true);
    });

    it("tags the job and staged row kmy and removes the staged bytes", async () => {
      const staged = await stage(readKmyFixture("syntheticKmy"));
      const row = await dataSource
        .getRepository(ImportStagedFile)
        .findOneOrFail({ where: { id: staged.id } });
      expect(row.sourceFormat).toBe("kmy");

      const started = await withUserContext(userId, () =>
        importService.start(userId, {
          stagedFileId: staged.id,
          sourceFormat: "kmy",
        }),
      );
      const job = await awaitJob(started.id);
      const stored = await dataSource
        .getRepository(ImportJob)
        .findOneOrFail({ where: { id: job.id } });
      expect(stored.sourceFormat).toBe("kmy");
      expect(
        await dataSource
          .getRepository(ImportStagedFile)
          .count({ where: { userId } }),
      ).toBe(0);
    });

    it("refuses a re-upload of the same bytes while the rows exist", async () => {
      expect((await runKmy(readKmyFixture("syntheticKmy"))).status).toBe(
        "completed",
      );
      const again = await stage(readKmyFixture("syntheticKmy"));
      const refusal = withUserContext(userId, () =>
        importService.start(userId, {
          stagedFileId: again.id,
          sourceFormat: "kmy",
        }),
      );
      await expect(refusal).rejects.toThrow(ConflictException);
      await expect(refusal).rejects.toThrow(/already imported/i);
    });

    it("lets the same bytes in again when the start replaces existing data", async () => {
      expect((await runKmy(readKmyFixture("syntheticKmy"))).status).toBe(
        "completed",
      );
      // `deleteData` is stubbed here, so the stub removes the imported rows
      // (not the job and staged rows the running import needs).
      jest
        .mocked(module.get(UsersService).deleteData)
        .mockImplementation(async () => {
          await cleanTables(
            dataSource,
            TABLES.filter(
              (table) =>
                table !== "import_jobs" && table !== "import_staged_files",
            ),
          );
          return undefined as never;
        });
      const second = await runKmy(readKmyFixture("syntheticKmy"), {
        wipeExistingData: true,
      });
      expect(second).toMatchObject({
        status: "completed",
        dataCommitted: true,
      });
    });

    it("is refused by the other format's start, in both directions", async () => {
      const money = await stage(
        readMnyFixture("money2008"),
        "money2008.mny",
        "mny",
      );
      await expect(
        withUserContext(userId, () =>
          importService.start(userId, {
            stagedFileId: money.id,
            sourceFormat: "kmy",
          }),
        ),
      ).rejects.toThrow(NotFoundException);

      const kmy = await stage(readKmyFixture("syntheticKmy"));
      await expect(
        withUserContext(userId, () =>
          importService.start(userId, { stagedFileId: kmy.id }),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("the controller 404s a Money staged id on discard and leaves it in place", async () => {
      const controller = new KmyImportController(
        staging,
        module.get(KmyParserService),
        jobs,
        importService,
      );
      const money = await stage(
        readMnyFixture("money2008"),
        "money2008.mny",
        "mny",
      );
      await expect(
        withUserContext(userId, () =>
          controller.discard({ user: { id: userId } }, money.id),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(
        await dataSource
          .getRepository(ImportStagedFile)
          .count({ where: { id: money.id } }),
      ).toBe(1);
    });
  });

  describe("a builder file", () => {
    it("imports a three-level category tree and a loan payment with matching counts", async () => {
      const xml = kmyFile({
        accounts: [
          kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
          kmyAccount({
            id: "A000002",
            name: "Car Loan",
            type: 5,
            parentaccount: "AStd::Liability",
          }),
          kmyAccount({
            id: "A000003",
            name: "Home",
            type: 13,
            parentaccount: "AStd::Expense",
          }),
          kmyAccount({
            id: "A000004",
            name: "Utilities",
            type: 13,
            parentaccount: "A000003",
          }),
          kmyAccount({
            id: "A000005",
            name: "Water",
            type: 13,
            parentaccount: "A000004",
          }),
          kmyAccount({
            id: "A000006",
            name: "Loan Interest",
            type: 13,
            parentaccount: "AStd::Expense",
          }),
          kmyAccount(
            {
              id: "A000007",
              name: "Opening Balances",
              type: 16,
              parentaccount: "AStd::Equity",
            },
            { kvp: { OpeningBalanceAccount: "Yes" } },
          ),
        ],
        transactions: [
          kmyTransaction(
            [
              kmySplit({
                id: "S0001",
                account: "A000001",
                value: "1000/1",
                shares: "1000/1",
              }),
              kmySplit({
                id: "S0002",
                account: "A000007",
                value: "-1000/1",
                shares: "-1000/1",
              }),
            ],
            { id: kmyTxId(1), postdate: "2024-01-01" },
          ),
          kmyTransaction(
            [
              kmySplit({
                id: "S0001",
                account: "A000001",
                value: "-40/1",
                shares: "-40/1",
              }),
              kmySplit({
                id: "S0002",
                account: "A000005",
                value: "40/1",
                shares: "40/1",
              }),
            ],
            { id: kmyTxId(2), postdate: "2024-01-10" },
          ),
          // Loan payment: 100 from Checking = 90 principal + 10 interest.
          kmyTransaction(
            [
              kmySplit({
                id: "S0001",
                account: "A000001",
                value: "-100/1",
                shares: "-100/1",
              }),
              kmySplit({
                id: "S0002",
                account: "A000002",
                value: "90/1",
                shares: "90/1",
              }),
              kmySplit({
                id: "S0003",
                account: "A000006",
                value: "10/1",
                shares: "10/1",
              }),
            ],
            { id: kmyTxId(3), postdate: "2024-02-10" },
          ),
        ],
      });

      const job = await runKmy(toKmyBytes(xml, "gzip"));
      expect(job.status).toBe("completed");
      const result = job.result!;
      expect(result.categoriesCreated).toBe(4);
      expect(result.transactionsCreated).toBe(3);
      for (const line of result.verification) {
        expect(line.delta).toBe(0);
      }
      expect(await balanceOf("Checking")).toBe(860);

      const tree: { name: string; parent: string | null }[] =
        await dataSource.query(
          `SELECT c.name, p.name AS parent FROM categories c
             LEFT JOIN categories p ON p.id = c.parent_id
            WHERE c.user_id = $1`,
          [userId],
        );
      const byName = new Map(tree.map((c) => [c.name, c.parent]));
      expect(byName.get("Water")).toBe("Utilities");
      expect(byName.get("Utilities")).toBe("Home");
      expect(byName.get("Home")).toBeNull();
    });
  });
});
