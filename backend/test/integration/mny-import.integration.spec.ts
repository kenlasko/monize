import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";

import { Account } from "@/accounts/entities/account.entity";
import { Category } from "@/categories/entities/category.entity";
import { Payee } from "@/payees/entities/payee.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
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
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { ImportStagedFile } from "@/import/mny/entities/import-staged-file.entity";
import { MnyImportJobService } from "@/import/mny/mny-import-job.service";
import { MnyImportService } from "@/import/mny/mny-import.service";
import { MnyParserService } from "@/import/mny/mny-parser.service";
import { MnyMarketRateService } from "@/import/mny/mny-market-rates.service";
import { MnyStagingService } from "@/import/mny/mny-staging.service";
import {
  MNY_FIXTURES,
  MnyFixtureName,
  readMnyFixture,
} from "@/import/mny/__fixtures__/mny-fixtures";
import { decryptMsisamInPlace } from "@/import/mny/msisam/msisam-decrypt";
import {
  billData,
  investmentData,
  mnyAccount,
  mnyBill,
  mnyCategory,
  mnyClassification,
  mnyCurrency,
  mnyDefaults,
  mnyPayee,
  mnyInvestmentDetail,
  mnySecurity,
  mnySplit,
  mnyTransaction,
  mnyTransfer,
  referenceData,
  transactionData,
} from "@/import/mny/__fixtures__/mny-row-builders";
import {
  cashKeyByAccountKey,
  currencyCodesByHandle,
  mapAccounts,
  mapCategories,
  mapPayees,
} from "@/import/mny/map/map-reference";
import { mapTransactions } from "@/import/mny/map/map-transactions";
import { mapClassificationTags } from "@/import/mny/map/map-classifications";
import { writeTags } from "@/import/mny/writers/write-tags";
import { mapBills } from "@/import/mny/map/map-bills";
import { mapLoans } from "@/import/mny/map/map-loans";
import { mapSecurities } from "@/import/mny/map/map-securities";
import { mapInvestments } from "@/import/mny/map/map-investments";
import {
  applyInvestmentCashSources,
  tradesByHandle,
} from "@/import/mny/map/investment-cash";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "@/import/mny/model/mny-import-options";
import { MNY_ACTION } from "@/import/mny/model/mny-actions";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "@/import/mny/writers/write-reference";
import {
  writeAccountBalances,
  writeTransactions,
} from "@/import/mny/writers/write-transactions";
import {
  writeInvestments,
  writeSecurities,
} from "@/import/mny/writers/write-investments";
import { ExchangeRateRow } from "@/import/mny/writers/write-prices";
import { writeBills } from "@/import/mny/writers/write-bills";
import { writeLoans } from "@/import/mny/writers/write-loans";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The writers against a real database.
 *
 * Two halves, for two different reasons. The writer specs drive the mappers'
 * real output through the real INSERT path, because that is where foreign keys,
 * check constraints and the self-referencing transfer link actually bite -- and
 * the committed `.mny` fixtures contain no banking transactions at all, so the
 * interesting cases (transfer pairs, loan splits) can only come from plain-object
 * rows. The end-to-end half then imports a real fixture through
 * `MnyImportService` so the whole chain, verification report included, is
 * exercised on real bytes.
 */
describe("mny writers (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;

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

  /** Stands in for CurrenciesService.ensureCurrencyForUser, whose row the FKs require. */
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
    await ensureCurrency("GBP");
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, TABLES);
  });

  /** Runs `fn` in a user-scoped transaction, as the import itself does. */
  const inTransaction = <T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> => withUserContext(userId, () => withScopedDb(dataSource, fn));

  // -------------------------------------------------------------------------
  // Reference writers
  // -------------------------------------------------------------------------

  describe("writeAccounts", () => {
    const accountsFrom = (rows: Parameters<typeof mnyAccount>[0][]) =>
      mapAccounts(
        referenceData({
          currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
          defaults: mnyDefaults({ defaultCurrency: 1 }),
          accounts: rows.map((row) => mnyAccount(row)),
        }),
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );

    it("creates accounts with their type, currency and opening balance", async () => {
      const mapped = accountsFrom([
        { handle: 1, type: 1, name: "Visa", creditLimit: 3000 },
        { handle: 2, type: 0, name: "Chequing", openingBalance: 1200.5 },
      ]);

      const written = await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      expect(written.created).toBe(2);
      const rows = await dataSource
        .getRepository(Account)
        .find({ where: { userId }, order: { name: "ASC" } });
      expect(
        rows.map((row) => [row.name, row.accountType, row.creditLimit]),
      ).toEqual([
        ["Chequing", "CHEQUING", null],
        ["Visa", "CREDIT_CARD", 3000],
      ]);
      expect(rows.find((row) => row.name === "Chequing")!.openingBalance).toBe(
        1200.5,
      );
    });

    it("cross-links an investment pair in both directions", async () => {
      const mapped = accountsFrom([{ handle: 1, type: 5, name: "TFSA" }]);

      await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      const rows = await dataSource
        .getRepository(Account)
        .find({ where: { userId } });
      const cash = rows.find((row) => row.name === "TFSA - Cash")!;
      const brokerage = rows.find((row) => row.name === "TFSA - Brokerage")!;
      expect(cash.linkedAccountId).toBe(brokerage.id);
      expect(brokerage.linkedAccountId).toBe(cash.id);
      expect(cash.accountSubType).toBe("INVESTMENT_CASH");
      expect(brokerage.accountSubType).toBe("INVESTMENT_BROKERAGE");
    });

    it("reuses an account the user already has, rather than duplicating it", async () => {
      const mapped = accountsFrom([{ handle: 1, name: "Chequing" }]);
      await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      const second = await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      expect(second.created).toBe(0);
      expect(second.reused).toBe(1);
      expect(
        await dataSource.getRepository(Account).count({ where: { userId } }),
      ).toBe(1);
    });

    it("leaves an account open until closures are applied deliberately", async () => {
      // A closed account rejects balance updates, so closure has to come last.
      const mapped = accountsFrom([
        { handle: 1, name: "Old", closed: true, closedOn: "2020-06-30" },
      ]);

      const written = await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );
      const beforeClosure = await dataSource
        .getRepository(Account)
        .findOne({ where: { userId, name: "Old" } });
      expect(beforeClosure!.isClosed).toBe(false);

      await inTransaction((manager) =>
        applyDeferredClosures(
          manager,
          userId,
          mapped.accounts,
          written.idByKey,
        ),
      );

      const afterClosure = await dataSource
        .getRepository(Account)
        .findOne({ where: { userId, name: "Old" } });
      expect(afterClosure!.isClosed).toBe(true);
      expect(String(afterClosure!.closedDate)).toContain("2020-06-30");
    });
  });

  describe("writeCategories", () => {
    const treeFrom = (rows: Parameters<typeof mnyCategory>[0][]) =>
      mapCategories(
        referenceData({
          categories: [
            mnyCategory({
              handle: 130,
              name: "INCOME",
              level: 0,
              categoryType: -1,
            }),
            mnyCategory({
              handle: 131,
              name: "EXPENSE",
              level: 0,
              categoryType: -1,
            }),
            ...rows.map((row) => mnyCategory(row)),
          ].sort((a, b) => a.level - b.level),
        }),
        null,
      );

    it("creates a parent and child, keeping Money's income flag", async () => {
      const mapped = treeFrom([
        { handle: 200, name: "Salary", level: 1, parent: 130, categoryType: 2 },
        { handle: 201, name: "Bonus", level: 2, parent: 200, categoryType: 2 },
        { handle: 202, name: "Rent", level: 1, parent: 131, categoryType: 0 },
      ]);

      const written = await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      expect(written.created).toBe(3);
      const rows = await dataSource
        .getRepository(Category)
        .find({ where: { userId } });
      const salary = rows.find((row) => row.name === "Salary")!;
      const bonus = rows.find((row) => row.name === "Bonus")!;
      const rent = rows.find((row) => row.name === "Rent")!;
      expect(bonus.parentId).toBe(salary.id);
      expect(salary.isIncome).toBe(true);
      // The QIF entity creator hardcodes isIncome false; this pipeline must not.
      expect(rent.isIncome).toBe(false);
    });

    it("reuses an existing category with the same name and parent", async () => {
      const mapped = treeFrom([
        { handle: 200, name: "Utilities", level: 1, parent: 131 },
      ]);
      await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      const second = await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      expect(second.created).toBe(0);
      expect(
        await dataSource.getRepository(Category).count({ where: { userId } }),
      ).toBe(1);
    });

    it("keeps same-named children under different parents distinct", async () => {
      const mapped = treeFrom([
        { handle: 200, name: "Car A", level: 1, parent: 131 },
        { handle: 201, name: "Car B", level: 1, parent: 131 },
        { handle: 202, name: "Fuel", level: 2, parent: 200 },
        { handle: 203, name: "Fuel", level: 2, parent: 201 },
      ]);

      const written = await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      expect(written.created).toBe(4);
      expect(
        await dataSource
          .getRepository(Category)
          .count({ where: { userId, name: "Fuel" } }),
      ).toBe(2);
    });
  });

  describe("writePayees", () => {
    it("creates payees and reuses them on a second run", async () => {
      const mapped = mapPayees(
        [
          mnyPayee({ handle: 1, name: "Costco" }),
          mnyPayee({ handle: 2, name: "#" }),
        ],
        null,
      );

      const first = await inTransaction((manager) =>
        writePayees(manager, userId, mapped.payees),
      );
      const second = await inTransaction((manager) =>
        writePayees(manager, userId, mapped.payees),
      );

      expect(first.created).toBe(1);
      expect(second.created).toBe(0);
      const rows = await dataSource
        .getRepository(Payee)
        .find({ where: { userId } });
      expect(rows.map((row) => row.name)).toEqual(["Costco"]);
    });
  });

  // -------------------------------------------------------------------------
  // Transaction writer
  // -------------------------------------------------------------------------

  describe("writeTransactions", () => {
    /** Maps rows, writes the reference data, and returns what the writer needs. */
    async function setup(data: ReturnType<typeof transactionData>) {
      const reference = referenceData({
        currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
        defaults: mnyDefaults({ defaultCurrency: 1 }),
        accounts: [
          mnyAccount({ handle: 1, name: "Chequing" }),
          mnyAccount({ handle: 2, name: "Savings" }),
          mnyAccount({ handle: 9, type: 6, name: "Mortgage" }),
        ],
        payees: [mnyPayee({ handle: 30, name: "Bank" })],
        categories: [
          mnyCategory({
            handle: 131,
            name: "EXPENSE",
            level: 0,
            categoryType: -1,
          }),
          mnyCategory({ handle: 60, name: "Interest", level: 1, parent: 131 }),
          mnyCategory({ handle: 61, name: "Groceries", level: 1, parent: 131 }),
          // A classification item shares the table: Money's real shape, from
          // the maintainer's file.
          mnyCategory({
            handle: 552,
            name: "20 Spring Apartment",
            level: 0,
            parent: null,
            classification: 1,
            categoryType: -1,
          }),
        ],
        classifications: [mnyClassification({ handle: 1, name: "Properties" })],
      });
      const accounts = mapAccounts(
        reference,
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );
      const transactions = mapTransactions({
        transactions: data,
        accountKeyByHandle: accounts.keyByHandle,
        currencyByHandle: accounts.currencyByHandle,
        bills: [],
        cashKeyByAccountKey: cashKeyByAccountKey(accounts),
        tradesByHandle: new Map(),
      });
      const categories = mapCategories(reference, null);
      const payees = mapPayees(reference.payees, null);
      const tags = mapClassificationTags(
        reference,
        transactions.referencedTags,
      );

      const written = await inTransaction(async (manager) => {
        const writtenAccounts = await writeAccounts(
          manager,
          userId,
          accounts.accounts,
        );
        const writtenCategories = await writeCategories(
          manager,
          userId,
          categories.categories,
        );
        const writtenPayees = await writePayees(manager, userId, payees.payees);
        const writtenTags = await writeTags(
          manager,
          module.get(TagsService),
          userId,
          tags.tags,
        );
        return {
          writtenAccounts,
          writtenCategories,
          writtenPayees,
          writtenTags,
        };
      });

      return {
        accounts,
        transactions,
        categories,
        payees,
        tags,
        writtenTags: written.writtenTags,
        input: {
          transactions: transactions.transactions,
          accountIdByKey: written.writtenAccounts.idByKey,
          categoryIdByHandle: new Map(
            [...categories.byHandle].map(([handle, category]) => [
              handle,
              written.writtenCategories.idByFullName.get(category.fullName)!,
            ]),
          ),
          payeeIdByHandle: new Map(
            [...payees.nameByHandle].map(([handle, name]) => [
              handle,
              written.writtenPayees.idByName.get(name)!,
            ]),
          ),
          payeeNameByHandle: payees.nameByHandle,
          tagIdByHandle: written.writtenTags.idByHandle,
        },
      };
    }

    it("writes a plain transaction with its payee, category and reference", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({
              handle: 1,
              account: 1,
              amount: -42.5,
              date: "2024-03-04",
              payee: 30,
              category: 61,
              memo: "Weekly shop",
              reference: "1042",
              clearedStatus: 1,
            }),
          ],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.transactionsCreated).toBe(1);
      const row = await dataSource.getRepository(Transaction).findOne({
        where: { userId },
        relations: { payee: true, category: true },
      });
      expect(row).toMatchObject({
        amount: "-42.50000000",
        transactionDate: "2024-03-04",
        description: "Weekly shop",
        referenceNumber: "1042",
        status: "CLEARED",
        payeeName: "Bank",
      });
      expect(row!.payee!.name).toBe("Bank");
      expect(row!.category!.name).toBe("Groceries");
    });

    it("tags a classified row and a classified split leg with the classification's key:value tag", async () => {
      const { tags, writtenTags, input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({
              handle: 1,
              account: 1,
              amount: -100,
              classification1: 552,
            }),
            mnyTransaction({
              handle: 2,
              account: 1,
              amount: -70,
              category: 61,
              classification1: 552,
            }),
            mnyTransaction({
              handle: 3,
              account: 1,
              amount: -30,
              category: 60,
            }),
            mnyTransaction({ handle: 4, account: 2, amount: 5 }),
          ],
          splits: [
            mnySplit({ parent: 1, child: 2, position: 0 }),
            mnySplit({ parent: 1, child: 3, position: 1 }),
          ],
        }),
      );

      expect(tags.tags).toEqual([
        { handle: 552, name: "Properties:20 Spring Apartment" },
      ]);
      expect(writtenTags.created).toBe(1);

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );
      expect(written.tagLinksApplied).toBe(2);

      const tag = await dataSource
        .getRepository(Tag)
        .findOneByOrFail({ userId, name: "Properties:20 Spring Apartment" });
      const rowLinks = await dataSource
        .getRepository(TransactionTag)
        .find({ where: { tagId: tag.id }, relations: { transaction: true } });
      expect(rowLinks.map((link) => link.transaction.amount)).toEqual([
        "-100.00000000",
      ]);
      const legLinks = await dataSource
        .getRepository(TransactionSplitTag)
        .find({
          where: { tagId: tag.id },
          relations: { transactionSplit: true },
        });
      expect(legLinks.map((link) => link.transactionSplit.amount)).toEqual([
        "-70.00000000",
      ]);
      // The item itself is never a category.
      expect(
        await dataSource
          .getRepository(Category)
          .findOneBy({ userId, name: "20 Spring Apartment" }),
      ).toBeNull();

      // A second import finds the tag instead of creating a twin.
      const again = await inTransaction((manager) =>
        writeTags(manager, module.get(TagsService), userId, tags.tags),
      );
      expect(again.created).toBe(0);
      expect(again.idByHandle.get(552)).toBe(tag.id);
    });

    it("cross-links a transfer pair, which a per-row insert could not do", async () => {
      // linked_transaction_id is a self-referencing FK, so whichever side went
      // first would fail without the back-patch pass.
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -250 }),
            mnyTransaction({ handle: 2, account: 2, amount: 250 }),
          ],
          transfers: [mnyTransfer({ from: 1, to: 2 })],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.linksApplied).toBe(2);
      const rows = await dataSource
        .getRepository(Transaction)
        .find({ where: { userId }, order: { amount: "ASC" } });
      const [out, back] = rows;
      expect(out.isTransfer).toBe(true);
      expect(out.linkedTransactionId).toBe(back.id);
      expect(back.linkedTransactionId).toBe(out.id);
    });

    it("writes a loan payment as a transfer split plus its loan-side row", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -1500, payee: 30 }),
            mnyTransaction({ handle: 2, account: 1, amount: -400 }),
            mnyTransaction({
              handle: 3,
              account: 1,
              amount: -1100,
              category: 60,
              memo: "Interest",
            }),
            mnyTransaction({ handle: 4, account: 9, amount: 400 }),
          ],
          splits: [
            mnySplit({ parent: 1, child: 2, position: 0 }),
            mnySplit({ parent: 1, child: 3, position: 1 }),
          ],
          transfers: [mnyTransfer({ from: 2, to: 4 })],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.transactionsCreated).toBe(2);
      expect(written.splitsCreated).toBe(2);

      const payment = await dataSource
        .getRepository(Transaction)
        .findOne({ where: { userId, amount: -1500 as never } });
      const loanSide = await dataSource
        .getRepository(Transaction)
        .findOne({ where: { userId, amount: 400 as never } });
      const splits = await dataSource.getRepository(TransactionSplit).find({
        where: { transactionId: payment!.id },
        order: { amount: "ASC" },
      });
      const mortgage = await dataSource
        .getRepository(Account)
        .findOne({ where: { userId, name: "Mortgage" } });

      expect(payment!.isSplit).toBe(true);
      const principal = splits.find(
        (split) => split.kind === SplitKind.TRANSFER,
      )!;
      expect(principal).toMatchObject({
        transferAccountId: mortgage!.id,
        linkedTransactionId: loanSide!.id,
        categoryId: null,
      });
      // The far side points back at the parent payment, as it does for a
      // hand-entered transfer split.
      expect(loanSide!.linkedTransactionId).toBe(payment!.id);
      expect(loanSide!.isTransfer).toBe(true);
    });

    it("keeps a voided transaction, so nothing silently disappears", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({
              handle: 1,
              account: 1,
              amount: -99,
              flags: 0x100,
            }),
          ],
        }),
      );

      await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      const row = await dataSource.getRepository(Transaction).findOne({
        where: { userId },
      });
      expect(row!.status).toBe("VOID");
    });

    // The bug this guards: 0x80 was read as the void bit, but it marks a row in
    // a loan or mortgage account -- so every loan payment reached the database
    // VOID and `computeExpectedBalances` then skipped it, freezing each debt
    // account at its opening balance. Asserted here, at the writer, because the
    // status that matters is the one the row is stored with.
    it("stores a loan-account row as a normal posting, not voided", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -99, flags: 0x80 }),
          ],
        }),
      );

      await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      const row = await dataSource.getRepository(Transaction).findOne({
        where: { userId },
      });
      expect(row!.status).not.toBe("VOID");
    });

    // The sibling bug, and the same shape of mistake: 0x80 also decided whether
    // `szId` was a reference, so a loan row's payment number was dropped and the
    // register's Ref # column was empty for every payment of every loan
    // (issue #1174). Asserted here rather than at the mapper because Ref # reads
    // `transactions.reference_number`, and that column is what has to hold it.
    it("stores a loan-account row's payment number in reference_number", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({
              handle: 1,
              account: 9,
              amount: 412.6,
              flags: 0x80,
              // Money's packed form: kind digit `0`, then the number Money's
              // loan register shows as Pmt Num, right-aligned.
              reference: "0          14",
            }),
          ],
        }),
      );

      await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      const row = await dataSource.getRepository(Transaction).findOne({
        where: { userId },
      });
      expect(row!.referenceNumber).toBe("14");
    });

    it("writes more rows than one chunk holds", async () => {
      const rows = Array.from({ length: 1200 }, (_, index) =>
        mnyTransaction({
          handle: index + 1,
          account: 1,
          amount: -1,
          date: "2024-01-02",
        }),
      );
      const { input } = await setup(transactionData({ transactions: rows }));
      const progress: Array<[number, number]> = [];

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, {
          ...input,
          onProgress: async (processed, total) => {
            progress.push([processed, total]);
          },
        }),
      );

      expect(written.transactionsCreated).toBe(1200);
      expect(
        await dataSource
          .getRepository(Transaction)
          .count({ where: { userId } }),
      ).toBe(1200);
      // 500-row chunks, so three progress reports ending at the total.
      expect(progress).toEqual([
        [500, 1200],
        [1000, 1200],
        [1200, 1200],
      ]);
    });

    it("reports the accounts it touched, for post-import processing", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -10 }),
            mnyTransaction({ handle: 2, account: 2, amount: -20 }),
          ],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.affectedAccountIds.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // A trade whose cash a banking row already records (issues #1211, #1212)
  // -------------------------------------------------------------------------

  describe("a trade paid for from outside its own cash sleeve", () => {
    /**
     * The half a mocked writer cannot prove. `transaction_splits` has a
     * kind-exclusivity CHECK that an investment leg has to satisfy, and both
     * `investment_transactions.transaction_split_id` and `.transaction_id` are
     * foreign keys -- so "the writer passed the right value" and "the database
     * accepted it" are two different claims, and only this one tests the second.
     */
    const CHEQUING = 1;
    const BROKERAGE = 5;
    const SLEEVE = 6;
    const SECURITY_HANDLE = 9;
    const PURCHASE = 2_400;

    const reference = () =>
      referenceData({
        currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
        defaults: mnyDefaults({ defaultCurrency: 1 }),
        accounts: [
          mnyAccount({ handle: CHEQUING, type: 0, name: "Chequing" }),
          mnyAccount({
            handle: BROKERAGE,
            type: 5,
            name: "Brokerage",
            relatedAccount: SLEEVE,
          }),
          mnyAccount({
            handle: SLEEVE,
            type: 0,
            name: "Brokerage (Cash)",
            relatedAccount: BROKERAGE,
          }),
        ],
      });

    /** Money's `TRN_INV` detail for the one purchase every case here makes. */
    const detail = (handle: number) =>
      investmentData({
        securities: [mnySecurity({ handle: SECURITY_HANDLE, symbol: "VOO" })],
        investmentDetails: [
          mnyInvestmentDetail({
            transaction: handle,
            price: 240,
            quantity: 10,
          }),
        ],
      });

    /** The real mapper chain, in the parser's order, then the real writers. */
    async function importRows(
      rows: ReturnType<typeof transactionData>,
      investmentTables: ReturnType<typeof investmentData>,
      overrides: {
        referenceRows?: ReturnType<typeof reference>;
        exchangeRates?: readonly ExchangeRateRow[];
      } = {},
    ) {
      const referenceRows = overrides.referenceRows ?? reference();
      const accounts = mapAccounts(
        referenceRows,
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );
      const securities = mapSecurities({
        securities: investmentTables.securities,
        currencyByHandle: currencyCodesByHandle(referenceRows),
        baseCurrency: "USD",
        activeHandles: new Set([SECURITY_HANDLE]),
      });
      const mappedInvestments = mapInvestments({
        transactions: rows,
        investments: investmentTables,
        accounts,
        securities,
        bills: [],
        exchangeRates: overrides.exchangeRates ?? [],
      });
      const transactions = mapTransactions({
        transactions: rows,
        accountKeyByHandle: accounts.keyByHandle,
        currencyByHandle: accounts.currencyByHandle,
        bills: [],
        cashKeyByAccountKey: cashKeyByAccountKey(accounts),
        tradesByHandle: tradesByHandle(mappedInvestments),
      });
      const investments = applyInvestmentCashSources(
        mappedInvestments,
        transactions.investmentCashSources,
      );

      return inTransaction(async (manager) => {
        const writtenAccounts = await writeAccounts(
          manager,
          userId,
          accounts.accounts,
        );
        const writtenSecurities = await writeSecurities(
          manager,
          userId,
          securities.securities,
        );
        const writtenTransactions = await writeTransactions(manager, userId, {
          transactions: transactions.transactions,
          accountIdByKey: writtenAccounts.idByKey,
          categoryIdByHandle: new Map(),
          payeeIdByHandle: new Map(),
          payeeNameByHandle: new Map(),
          tagIdByHandle: new Map(),
        });
        await writeInvestments(manager, userId, {
          transactions: investments.transactions,
          accountIdByKey: writtenAccounts.idByKey,
          securityIdByHandle: writtenSecurities.idByHandle,
          categoryIdByHandle: new Map(),
          payeeIdByHandle: new Map(),
          payeeNameByHandle: new Map(),
          symbolByHandle: new Map([[SECURITY_HANDLE, "VOO"]]),
          writtenTransactionIds: writtenTransactions.writtenTransactionIds,
          writtenSplitIds: writtenTransactions.writtenSplitIds,
          tagIdByHandle: new Map(),
        });
        return { accountIdByKey: writtenAccounts.idByKey };
      });
    }

    const rowsIn = async (accountId: string) =>
      dataSource
        .getRepository(Transaction)
        .find({ where: { userId, accountId } });

    it("makes the paying account's row the trade's cash leg (#1212)", async () => {
      const { accountIdByKey } = await importRows(
        transactionData({
          transactions: [
            mnyTransaction({
              handle: 20,
              account: CHEQUING,
              amount: -PURCHASE,
            }),
            mnyTransaction({
              handle: 21,
              account: BROKERAGE,
              amount: PURCHASE,
              security: SECURITY_HANDLE,
              action: MNY_ACTION.BUY,
            }),
          ],
          transfers: [mnyTransfer({ from: 20, to: 21 })],
        }),
        detail(21),
      );

      const chequing = await rowsIn(accountIdByKey.get("acct-1")!);
      expect(chequing).toHaveLength(1);
      expect(chequing[0]).toMatchObject({
        amount: "-2400.00000000",
        isTransfer: false,
        linkedTransactionId: null,
      });
      // The sleeve holds nothing: no cash ever arrived there or left it.
      expect(await rowsIn(accountIdByKey.get("acct-6")!)).toHaveLength(0);

      const trade = await dataSource
        .getRepository(InvestmentTransaction)
        .findOneOrFail({ where: { userId } });
      expect(trade.transactionId).toBe(chequing[0].id);
      expect(trade.fundingAccountId).toBe(accountIdByKey.get("acct-1"));
      expect(trade.transactionSplitId).toBeNull();
    });

    it("embeds the trade in a split leg the CHECK constraint accepts (#1211)", async () => {
      const { accountIdByKey } = await importRows(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 20, account: CHEQUING, amount: -2_500 }),
            mnyTransaction({
              handle: 21,
              account: CHEQUING,
              amount: -PURCHASE,
            }),
            mnyTransaction({ handle: 22, account: CHEQUING, amount: -100 }),
            mnyTransaction({
              handle: 23,
              account: BROKERAGE,
              amount: PURCHASE,
              security: SECURITY_HANDLE,
              action: MNY_ACTION.BUY,
            }),
          ],
          splits: [
            mnySplit({ parent: 20, child: 21, position: 0 }),
            mnySplit({ parent: 20, child: 22, position: 1 }),
          ],
          transfers: [mnyTransfer({ from: 21, to: 23 })],
        }),
        detail(23),
      );

      const chequing = await rowsIn(accountIdByKey.get("acct-1")!);
      expect(chequing).toHaveLength(1);
      expect(await rowsIn(accountIdByKey.get("acct-6")!)).toHaveLength(0);

      const splits = await dataSource
        .getRepository(TransactionSplit)
        .find({ where: { transactionId: chequing[0].id } });
      const investmentLeg = splits.find(
        (split) => split.kind === SplitKind.INVESTMENT,
      );
      expect(investmentLeg).toMatchObject({
        categoryId: null,
        transferAccountId: null,
        linkedTransactionId: null,
        amount: "-2400.00000000",
      });

      const trade = await dataSource
        .getRepository(InvestmentTransaction)
        .findOneOrFail({ where: { userId } });
      expect(trade.transactionSplitId).toBe(investmentLeg!.id);
      expect(trade.transactionId).toBeNull();
      expect(trade.fundingAccountId).toBeNull();
    });

    describe("across currencies", () => {
      const crossCurrencyReference = (accountCurrency: number) =>
        referenceData({
          currencies: [
            mnyCurrency({ handle: 1, isoCode: "EUR" }),
            mnyCurrency({ handle: 2, isoCode: "USD" }),
            mnyCurrency({ handle: 3, isoCode: "CAD" }),
          ],
          defaults: mnyDefaults({ defaultCurrency: 2 }),
          accounts: [
            mnyAccount({
              handle: CHEQUING,
              type: 0,
              name: "Chequing",
              currency: 1,
            }),
            mnyAccount({
              handle: BROKERAGE,
              type: 5,
              name: "Brokerage",
              relatedAccount: SLEEVE,
              currency: accountCurrency,
            }),
            mnyAccount({
              handle: SLEEVE,
              type: 0,
              name: "Brokerage (Cash)",
              relatedAccount: BROKERAGE,
              currency: accountCurrency,
            }),
          ],
        });

      it("credits the USD sleeve with the investment side's own amount", async () => {
        await ensureCurrency("EUR");
        // A transfer into the brokerage that adds shares and moves no trade
        // cash: the sleeve row is the only record of the money arriving. Money
        // stores EUR 2400 out of chequing and USD 2640 on the investment side.
        const { accountIdByKey } = await importRows(
          transactionData({
            transactions: [
              mnyTransaction({
                handle: 20,
                account: CHEQUING,
                amount: -2_400,
              }),
              mnyTransaction({
                handle: 21,
                account: BROKERAGE,
                amount: 2_640,
                security: SECURITY_HANDLE,
                action: MNY_ACTION.ADD_SHARES,
              }),
            ],
            transfers: [mnyTransfer({ from: 20, to: 21 })],
          }),
          detail(21),
          { referenceRows: crossCurrencyReference(2) },
        );

        const bank = await rowsIn(accountIdByKey.get("acct-1")!);
        const sleeve = await rowsIn(accountIdByKey.get("acct-6")!);
        expect(bank).toHaveLength(1);
        expect(bank[0]).toMatchObject({
          amount: "-2400.00000000",
          currencyCode: "EUR",
        });
        expect(sleeve).toHaveLength(1);
        expect(sleeve[0]).toMatchObject({
          amount: "2640.00000000",
          currencyCode: "USD",
          linkedTransactionId: bank[0].id,
        });
      });

      it("stores a USD-quoted trade in a CAD account in USD with its rate", async () => {
        await ensureCurrency("CAD");
        const { accountIdByKey } = await importRows(
          transactionData({
            transactions: [
              mnyTransaction({
                handle: 21,
                account: BROKERAGE,
                amount: -1_250,
                date: "2026-03-02",
                security: SECURITY_HANDLE,
                action: MNY_ACTION.BUY,
              }),
            ],
          }),
          investmentData({
            securities: [
              mnySecurity({
                handle: SECURITY_HANDLE,
                symbol: "VOO",
                currency: 2,
              }),
            ],
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 21,
                price: 125,
                quantity: 10,
              }),
            ],
          }),
          {
            referenceRows: crossCurrencyReference(3),
            exchangeRates: [
              {
                fromCurrency: "CAD",
                toCurrency: "USD",
                rate: 0.8,
                rateDate: "2026-03-02",
              },
            ],
          },
        );

        const trade = await dataSource
          .getRepository(InvestmentTransaction)
          .findOneOrFail({ where: { userId } });
        expect(Number(trade.price)).toBe(100);
        expect(Number(trade.totalAmount)).toBe(1000);
        expect(Number(trade.exchangeRate)).toBe(1.25);

        const cash = await rowsIn(accountIdByKey.get("acct-6")!);
        expect(cash).toHaveLength(1);
        expect(cash[0]).toMatchObject({
          amount: "-1250.00000000",
          currencyCode: "CAD",
        });
        expect(trade.transactionId).toBe(cash[0].id);
      });
    });
  });

  describe("writeAccountBalances", () => {
    it("writes each account's balance in one pass", async () => {
      const mapped = mapAccounts(
        referenceData({
          currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
          defaults: mnyDefaults({ defaultCurrency: 1 }),
          accounts: [
            mnyAccount({ handle: 1, name: "A" }),
            mnyAccount({ handle: 2, name: "B" }),
          ],
        }),
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );

      const written = await inTransaction(async (manager) => {
        const accounts = await writeAccounts(manager, userId, mapped.accounts);
        await writeAccountBalances(
          manager,
          new Map([
            [accounts.idByKey.get("acct-1")!, 1234.5678],
            [accounts.idByKey.get("acct-2")!, -99.99],
          ]),
        );
        return accounts;
      });

      const rows = await dataSource
        .getRepository(Account)
        .find({ where: { userId }, order: { name: "ASC" } });
      expect(rows.map((row) => row.currentBalance)).toEqual([
        1234.5678, -99.99,
      ]);
      expect(written.created).toBe(2);
    });

    it("does nothing for an empty balance set", async () => {
      await expect(
        inTransaction((manager) => writeAccountBalances(manager, new Map())),
      ).resolves.toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Bills and loan terms
  // -------------------------------------------------------------------------

  describe("writeBills and writeLoans", () => {
    /**
     * A mortgage payment as Money records it: a split in the chequing account
     * with a transfer leg for principal and a category leg for interest, plus
     * an active `BILL` series whose template is that same shape.
     */
    async function setup(nextDue: string) {
      const reference = referenceData({
        currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
        defaults: mnyDefaults({ defaultCurrency: 1 }),
        accounts: [
          mnyAccount({ handle: 1, name: "Chequing" }),
          mnyAccount({ handle: 9, type: 6, name: "Mortgage" }),
        ],
        payees: [mnyPayee({ handle: 30, name: "Bank" })],
        categories: [
          mnyCategory({
            handle: 131,
            name: "EXPENSE",
            level: 0,
            categoryType: -1,
          }),
          mnyCategory({ handle: 60, name: "Interest", level: 1, parent: 131 }),
        ],
      });

      // htrn 1..3: a posted payment. htrn 10..12: the bill's template.
      const data = transactionData({
        transactions: [
          mnyTransaction({ handle: 1, account: 1, amount: -1500, payee: 30 }),
          mnyTransaction({ handle: 2, account: 1, amount: -1000 }),
          mnyTransaction({
            handle: 3,
            account: 1,
            amount: -500,
            category: 60,
            memo: "interest",
          }),
          mnyTransaction({ handle: 4, account: 9, amount: 1000 }),
          mnyTransaction({
            handle: 10,
            account: 1,
            amount: -1500,
            payee: 30,
            frequency: 3,
            date: null,
          }),
          mnyTransaction({
            handle: 11,
            account: 1,
            amount: -1000,
            frequency: 3,
            date: null,
          }),
          mnyTransaction({
            handle: 12,
            account: 1,
            amount: -500,
            category: 60,
            frequency: 3,
            date: null,
          }),
          mnyTransaction({
            handle: 13,
            account: 9,
            amount: 1000,
            frequency: 3,
            date: null,
          }),
        ],
        splits: [
          mnySplit({ parent: 1, child: 2, position: 0 }),
          mnySplit({ parent: 1, child: 3, position: 1 }),
          mnySplit({ parent: 10, child: 11, position: 0 }),
          mnySplit({ parent: 10, child: 12, position: 1 }),
        ],
        transfers: [
          mnyTransfer({ from: 2, to: 4 }),
          mnyTransfer({ from: 11, to: 13 }),
        ],
      });

      const bills = billData({
        bills: [
          mnyBill({
            handle: 7,
            series: 7,
            frequency: 3,
            nextDue,
            templateTransaction: 10,
          }),
        ],
      });

      const accounts = mapAccounts(
        reference,
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );
      const transactions = mapTransactions({
        transactions: data,
        accountKeyByHandle: accounts.keyByHandle,
        currencyByHandle: accounts.currencyByHandle,
        bills: bills.bills,
        cashKeyByAccountKey: cashKeyByAccountKey(accounts),
        tradesByHandle: new Map(),
      });
      const securities = mapSecurities({
        securities: [],
        currencyByHandle: new Map(),
        baseCurrency: "USD",
        activeHandles: new Set<number>(),
      });
      const mappedBills = mapBills({
        bills,
        transactions: data,
        investments: investmentData(),
        accounts,
        securities,
        payees: reference.payees,
        asOf: nextDue,
      });
      const loans = mapLoans({
        accounts,
        transactions,
        bills: mappedBills.bills,
      });
      const categories = mapCategories(reference, null);
      const payees = mapPayees(reference.payees, null);

      const written = await inTransaction(async (manager) => {
        const writtenAccounts = await writeAccounts(
          manager,
          userId,
          accounts.accounts,
        );
        const writtenCategories = await writeCategories(
          manager,
          userId,
          categories.categories,
        );
        const writtenPayees = await writePayees(manager, userId, payees.payees);
        return { writtenAccounts, writtenCategories, writtenPayees };
      });

      const categoryIdByHandle = new Map(
        [...categories.byHandle].map(([handle, category]) => [
          handle,
          written.writtenCategories.idByFullName.get(category.fullName)!,
        ]),
      );

      return {
        mappedBills,
        loans,
        accountIdByKey: written.writtenAccounts.idByKey,
        categoryIdByHandle,
        billInput: {
          accountIdByKey: written.writtenAccounts.idByKey,
          payeeIdByHandle: new Map(
            [...payees.nameByHandle].map(([handle, name]) => [
              handle,
              written.writtenPayees.idByName.get(name)!,
            ]),
          ),
          payeeNameByHandle: payees.nameByHandle,
          categoryIdByHandle,
          securityIdByHandle: new Map<number, string>(),
          linkedKeyByKey: new Map<string, string>(),
          tagIdByHandle: new Map<number, string>(),
        },
      };
    }

    it("writes a selected bill as an active, non-auto-posting schedule with its splits", async () => {
      const { mappedBills, billInput } = await setup("2026-08-01");
      expect(mappedBills.bills.map((bill) => bill.handle)).toEqual([7]);

      const written = await inTransaction((manager) =>
        writeBills(manager, userId, {
          ...billInput,
          bills: mappedBills.bills,
        }),
      );

      expect(written.created).toBe(1);
      const schedules = await dataSource
        .getRepository(ScheduledTransaction)
        .find({ where: { userId } });
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        name: "Bank",
        isActive: true,
        autoPost: false,
        isSplit: true,
        frequency: "MONTHLY",
        nextDueDate: "2026-08-01",
      });

      const splits = await dataSource
        .getRepository(ScheduledTransactionSplit)
        .find({ where: { scheduledTransactionId: schedules[0].id } });
      expect(splits).toHaveLength(2);
      // The principal leg keeps its transfer nature all the way to the row.
      expect(
        splits.some(
          (split) =>
            split.kind === SplitKind.TRANSFER &&
            split.transferAccountId !== null,
        ),
      ).toBe(true);
    });

    it("leaves an unticked bill out of the database entirely", async () => {
      // Not inactive -- absent. PR #192 created all 1,844 and deactivated them.
      const { billInput } = await setup("2026-08-01");

      const written = await inTransaction((manager) =>
        writeBills(manager, userId, { ...billInput, bills: [] }),
      );

      expect(written.created).toBe(0);
      await expect(
        dataSource
          .getRepository(ScheduledTransaction)
          .count({ where: { userId } }),
      ).resolves.toBe(0);
    });

    it("configures the mortgage from its payments and its bill", async () => {
      const { loans, accountIdByKey, categoryIdByHandle } =
        await setup("2026-08-01");

      const written = await inTransaction((manager) =>
        writeLoans(manager, userId, {
          loans: loans.loans,
          accountIdByKey,
          categoryIdByHandle,
        }),
      );

      expect(written.updated).toBe(1);
      const mortgage = await dataSource.getRepository(Account).findOne({
        where: { id: accountIdByKey.get("acct-9")!, userId },
      });
      expect(mortgage).toMatchObject({
        interestBookingMode: "SPLIT",
        interestCategoryId: categoryIdByHandle.get(60),
        sourceAccountId: accountIdByKey.get("acct-1"),
        paymentFrequency: "MONTHLY",
      });
      expect(Number(mortgage!.paymentAmount)).toBe(1500);
    });

    it("does not re-create the schedule on a second import of the same file", async () => {
      const { mappedBills, billInput } = await setup("2026-08-01");

      await inTransaction((manager) =>
        writeBills(manager, userId, { ...billInput, bills: mappedBills.bills }),
      );
      const second = await inTransaction((manager) =>
        writeBills(manager, userId, { ...billInput, bills: mappedBills.bills }),
      );

      expect(second).toEqual({ created: 0, reused: 1 });
      await expect(
        dataSource
          .getRepository(ScheduledTransaction)
          .count({ where: { userId } }),
      ).resolves.toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // End to end, on real Money bytes
  // -------------------------------------------------------------------------

  describe("MnyImportService on a real fixture", () => {
    let importService: MnyImportService;
    let staging: MnyStagingService;
    let jobs: MnyImportJobService;
    let parser: MnyParserService;

    beforeAll(() => {
      importService = module.get(MnyImportService);
      staging = module.get(MnyStagingService);
      jobs = module.get(MnyImportJobService);
      parser = module.get(MnyParserService);
    });

    /**
     * The bytes the controller actually stages.
     *
     * `POST /parse` decrypts the upload in place and stages *that* buffer, so
     * staging holds plaintext and the password is spent once (ADR-2, ADR-7).
     * Staging a raw fixture instead -- which this suite did for three phases --
     * makes the job's decrypt the only decrypt, and hides the fact that the
     * real path decrypts twice and re-encrypts the file.
     */
    function stagedBytes(fixture: MnyFixtureName): Buffer {
      return decryptMsisamInPlace(
        readMnyFixture(fixture),
        MNY_FIXTURES[fixture].password,
      ).buffer;
    }

    async function runImport(
      fixture: "money2002" | "money2008" | "sampleCdRedemption",
      options?: Parameters<typeof importService.start>[1]["options"],
    ) {
      const staged = await withUserContext(userId, () =>
        staging.stage(userId, {
          filename: `${fixture}.mny`,
          data: stagedBytes(fixture),
        }),
      );
      const job = await withUserContext(userId, () =>
        importService.start(userId, { stagedFileId: staged.id, options }),
      );

      // start() runs the body unawaited; wait for the row to settle.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await withUserContext(userId, () =>
          jobs.findOne(userId, job.id),
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

    it("imports money2008.mny and reconciles every account", async () => {
      const job = await runImport("money2008");

      expect(job.status).toBe("completed");
      // One Money investment account -> one linked Monize pair.
      expect(job.result!.accountsCreated).toBe(2);
      expect(job.result!.verification).toHaveLength(2);
      for (const account of job.result!.verification) {
        expect(account.matches).toBe(true);
        expect(account.delta).toBe(0);
      }
    });

    it("reports the imported balance the database actually holds", async () => {
      const job = await runImport("money2002");

      const accounts = await dataSource
        .getRepository(Account)
        .find({ where: { userId } });
      for (const line of job.result!.verification) {
        const stored = accounts.find(
          (account) => account.id === line.accountId,
        );
        expect(stored).toBeDefined();
        expect(line.importedBalance).toBe(Number(stored!.currentBalance));
      }
    });

    it("imports the buffer the parse endpoint actually stages", async () => {
      // The controller's exact sequence, and the one no test performed for
      // three phases: parse the upload -- which decrypts it in place -- then
      // stage that same buffer and import it. Because RC4 is symmetric, the
      // job decrypting a second time re-encrypted the file, and every import
      // through the real wizard died with "contents could not be read" while
      // every fixture-staging test passed.
      const uploaded = readMnyFixture("money2008");
      const preview = parser.parse({
        buffer: uploaded,
        userDefaultCurrency: "USD",
      });
      expect(preview.accounts.accounts.length).toBeGreaterThan(0);

      const staged = await withUserContext(userId, () =>
        staging.stage(userId, { filename: "money2008.mny", data: uploaded }),
      );
      const started = await withUserContext(userId, () =>
        importService.start(userId, { stagedFileId: staged.id }),
      );

      let job = await withUserContext(userId, () =>
        jobs.findOne(userId, started.id),
      );
      for (let attempt = 0; attempt < 100 && job; attempt += 1) {
        if (job.status !== "pending" && job.status !== "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = await withUserContext(userId, () =>
          jobs.findOne(userId, started.id),
        );
      }

      expect(job).toMatchObject({ status: "completed", errorKey: null });
      expect(job!.result!.accountsCreated).toBe(
        preview.accounts.accounts.length,
      );
    });

    it("deletes the staged file once the import completes", async () => {
      const before = await dataSource
        .getRepository(ImportStagedFile)
        .count({ where: { userId } });
      await runImport("money2008");
      const after = await dataSource
        .getRepository(ImportStagedFile)
        .count({ where: { userId } });

      expect(before).toBe(0);
      expect(after).toBe(0);
    });

    it("refuses to start a second import while one is in flight", async () => {
      const staged = await withUserContext(userId, () =>
        staging.stage(userId, {
          filename: "money2008.mny",
          data: stagedBytes("money2008"),
        }),
      );
      await withUserContext(userId, () =>
        jobs.create(userId, staged.id, DEFAULT_MNY_IMPORT_OPTIONS),
      );

      await expect(
        withUserContext(userId, () =>
          importService.start(userId, { stagedFileId: staged.id }),
        ),
      ).rejects.toThrow(/already running/i);
    });

    /**
     * Two `start` calls issued together, as two overlapping HTTP requests are.
     *
     * The advisory `hasActiveJob` count cannot separate them -- neither has
     * committed a row when the other reads -- so what is being exercised is the
     * partial unique index underneath `jobs.create`. Before it, both requests
     * created a job and both imported the same bytes; because every parse
     * generates fresh transaction UUIDs, the second run duplicated the file's
     * entire history and doubled every balance.
     */
    async function raceTwoStarts(
      stagedFileId: string,
      options?: Parameters<typeof importService.start>[1]["options"],
    ) {
      const settled = await Promise.allSettled([
        withUserContext(userId, () =>
          importService.start(userId, { stagedFileId, options }),
        ),
        withUserContext(userId, () =>
          importService.start(userId, { stagedFileId, options }),
        ),
      ]);

      return {
        started: settled
          .filter((result) => result.status === "fulfilled")
          .map((result) => (result as PromiseFulfilledResult<ImportJob>).value),
        refused: settled
          .filter((result) => result.status === "rejected")
          .map((result) => (result as PromiseRejectedResult).reason),
      };
    }

    /** Polls a job row until it leaves pending/running. */
    async function awaitJob(jobId: string): Promise<ImportJob> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
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

    describe("two starts racing", () => {
      async function stageFixture(): Promise<string> {
        const staged = await withUserContext(userId, () =>
          staging.stage(userId, {
            filename: "money2008.mny",
            data: stagedBytes("money2008"),
          }),
        );
        return staged.id;
      }

      it("creates one job and refuses the other", async () => {
        const { started, refused } = await raceTwoStarts(await stageFixture());

        expect(started).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(String(refused[0])).toMatch(/already running/i);
        await awaitJob(started[0].id);

        const rows = await dataSource
          .getRepository(ImportJob)
          .find({ where: { userId } });
        expect(rows).toHaveLength(1);
      });

      it("imports the file's rows once, not twice", async () => {
        // The assertion the job-row count cannot make: what actually landed in
        // the user's ledger.
        const { started } = await raceTwoStarts(await stageFixture());
        const job = await awaitJob(started[0].id);

        expect(job.status).toBe("completed");
        const transactions = await dataSource
          .getRepository(Transaction)
          .count({ where: { userId } });
        const accounts = await dataSource
          .getRepository(Account)
          .find({ where: { userId } });

        expect(transactions).toBe(job.result!.transactionsCreated);
        expect(accounts).toHaveLength(job.result!.accountsCreated);
        for (const line of job.result!.verification) {
          const stored = accounts.find(
            (account) => account.id === line.accountId,
          );
          expect(stored).toBeDefined();
          // A second import over the same file would land here: the balances
          // reconcile against the file only if every row was written once.
          expect(Number(stored!.currentBalance)).toBe(line.expectedBalance);
        }
      });

      it("wipes at most once, because the wipe is behind the same lock", async () => {
        // `deleteData` is the destructive path. It used to run before the job
        // row existed, so both racing requests could reach it.
        const usersService = module.get(UsersService) as unknown as {
          deleteData: jest.Mock;
        };
        usersService.deleteData.mockClear();

        const { started, refused } = await raceTwoStarts(await stageFixture(), {
          wipeExistingData: true,
        });

        expect(started).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(usersService.deleteData).toHaveBeenCalledTimes(1);
        await awaitJob(started[0].id);
      });
    });

    it("releases the import slot when the wipe is refused", async () => {
      // A rejected start must not leave the user holding a slot for a job that
      // will never run -- the stale reap only clears it once it has been stale
      // for JOB_STALE_AFTER_MS, and every import started in between is refused.
      const usersService = module.get(UsersService) as unknown as {
        deleteData: jest.Mock;
      };
      usersService.deleteData.mockRejectedValueOnce(new Error("bad password"));
      const staged = await withUserContext(userId, () =>
        staging.stage(userId, {
          filename: "money2008.mny",
          data: stagedBytes("money2008"),
        }),
      );

      await expect(
        withUserContext(userId, () =>
          importService.start(userId, {
            stagedFileId: staged.id,
            options: { wipeExistingData: true },
          }),
        ),
      ).rejects.toThrow("bad password");

      expect(
        await dataSource.getRepository(ImportJob).count({ where: { userId } }),
      ).toBe(0);
      const retried = await withUserContext(userId, () =>
        importService.start(userId, { stagedFileId: staged.id }),
      );
      expect(retried.status).toBe("pending");
      await awaitJob(retried.id);
    });

    it("refuses to start when the staged file is gone", async () => {
      await expect(
        withUserContext(userId, () =>
          importService.start(userId, {
            stagedFileId: "11111111-1111-4111-8111-111111111111",
          }),
        ),
      ).rejects.toThrow(/no longer available/i);
    });

    /**
     * A failure after `writeAll` committed (A26-H08). The fixture's figures are
     * the finding's: Sample Deposit Account 5000.00, investment cash 4061.00,
     * 1000 shares. Before the fix the job said "Nothing was saved", the staged
     * id survived, and a second start (or a re-upload of the same bytes) took
     * them to 10000.00, 8122.00 and 2000 shares.
     */
    describe("a committed import", () => {
      async function ledgerSnapshot() {
        const accounts = await dataSource
          .getRepository(Account)
          .find({ where: { userId }, order: { name: "ASC" } });
        const holdings: { quantity: string }[] = await dataSource.query(
          `SELECT h.quantity FROM holdings h
             JOIN accounts a ON a.id = h.account_id
            WHERE a.user_id = $1 AND h.quantity <> 0`,
          [userId],
        );
        return {
          transactions: await dataSource
            .getRepository(Transaction)
            .count({ where: { userId } }),
          investmentRows: await dataSource
            .getRepository(InvestmentTransaction)
            .count({ where: { userId } }),
          balances: accounts.map(
            (account) => `${account.name}=${Number(account.currentBalance)}`,
          ),
          shares: holdings
            .map((holding) => Number(holding.quantity))
            .sort((a, b) => a - b),
        };
      }

      async function stageFixture(): Promise<string> {
        const staged = await withUserContext(userId, () =>
          staging.stage(userId, {
            filename: "sample-cd-redemption.mny",
            data: stagedBytes("sampleCdRedemption"),
          }),
        );
        return staged.id;
      }

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it("reports a failure after the commit as committed and refuses a second start", async () => {
        const post = module.get(ImportPostProcessingService);
        jest
          .spyOn(post, "run")
          .mockRejectedValueOnce(new Error("failpoint after commit"));
        const stagedFileId = await stageFixture();

        const job = await awaitJob(
          (
            await withUserContext(userId, () =>
              importService.start(userId, { stagedFileId }),
            )
          ).id,
        );

        const before = await ledgerSnapshot();
        expect(job).toMatchObject({
          status: "failed",
          dataCommitted: true,
          retryable: false,
          errorKey: "mnyImportFailedAfterCommit",
        });
        expect(before.balances).toContain("Sample Deposit Account=5000");
        expect(before.balances).toContain(
          "Sample Investment Account - Cash=4061",
        );
        expect(before.shares).toEqual([1000]);

        // The API path: the staged id survived the failure.
        await expect(
          withUserContext(userId, () =>
            importService.start(userId, { stagedFileId }),
          ),
        ).rejects.toThrow(ConflictException);
        expect(await ledgerSnapshot()).toEqual(before);
      });

      it("refuses a re-upload of the same bytes while the first import's rows exist", async () => {
        const first = await awaitJob(
          (
            await withUserContext(userId, async () =>
              importService.start(userId, {
                stagedFileId: await stageFixture(),
              }),
            )
          ).id,
        );
        expect(first.status).toBe("completed");
        const before = await ledgerSnapshot();

        // The UI path: start over and upload the same file again.
        const again = await stageFixture();
        const refusal = withUserContext(userId, () =>
          importService.start(userId, { stagedFileId: again }),
        );
        await expect(refusal).rejects.toThrow(ConflictException);
        await expect(refusal).rejects.toThrow(/already imported/i);
        expect(await ledgerSnapshot()).toEqual(before);
        expect(
          await dataSource
            .getRepository(ImportJob)
            .count({ where: { userId } }),
        ).toBe(1);
      });

      it("lets the same bytes in again when the start replaces existing data", async () => {
        const first = await awaitJob(
          (
            await withUserContext(userId, async () =>
              importService.start(userId, {
                stagedFileId: await stageFixture(),
              }),
            )
          ).id,
        );
        expect(first.status).toBe("completed");

        // `deleteData` is stubbed in this suite, so the rows do not actually
        // go; what is asserted is that the wipe-and-import is not refused and
        // that its own commit is not refused by the first job's content key.
        const second = await awaitJob(
          (
            await withUserContext(userId, async () =>
              importService.start(userId, {
                stagedFileId: await stageFixture(),
                options: { wipeExistingData: true },
              }),
            )
          ).id,
        );
        expect(second).toMatchObject({
          status: "completed",
          dataCommitted: true,
        });
      });
    });

    /*
     * money2002.mny is the investment fixture: 86 `SEC` rows, 60 `act` 15
     * transactions and 60 open `LOT` rows across 30 securities. That makes it
     * the one file in the corpus where the holdings a real import produces can
     * be checked against Money's own tax-lot record end to end.
     *
     * **30 of the 86 are imported.** The other 56 are the Amex and Dow index
     * rows Money ships as its quote watch list, which no `TRN` row and no `LOT`
     * references; the activity filter in `mapSecurities` leaves them behind
     * along with their price history.
     */
    describe("investments", () => {
      it("imports a CD redemption with accrued interest as one activity", async () => {
        const job = await runImport("sampleCdRedemption");

        expect(job.status).toBe("completed");
        const security = await dataSource
          .getRepository(Security)
          .findOneByOrFail({ userId, name: "Sample 3-month CD" });
        const rows = await dataSource
          .getRepository(InvestmentTransaction)
          .find({
            where: { userId, securityId: security.id },
            order: { transactionDate: "ASC", createdAt: "ASC" },
          });

        expect(rows).toHaveLength(6);
        expect(
          rows.slice(0, 4).map((row) => ({
            action: row.action,
            quantity: row.quantity,
            totalAmount: row.totalAmount,
          })),
        ).toEqual([
          { action: "BUY", quantity: 5000, totalAmount: 5000 },
          { action: "REINVEST_INTEREST", quantity: 20, totalAmount: 20 },
          { action: "REINVEST_INTEREST", quantity: 20, totalAmount: 20 },
          { action: "REINVEST_INTEREST", quantity: 20, totalAmount: 20 },
        ]);

        const redemption = rows.find((row) => row.action === "REDEEM");
        const accruedInterest = rows.find((row) => row.action === "INTEREST");
        expect(redemption).toMatchObject({
          quantity: 5060,
          price: 1,
          totalAmount: 5060,
          transactionSplitId: null,
          linkedTransactionId: accruedInterest?.id,
        });
        expect(accruedInterest).toMatchObject({
          quantity: null,
          price: 1,
          totalAmount: 1,
          transactionId: null,
          transactionSplitId: null,
          linkedTransactionId: redemption?.id,
        });

        const cashRow = await dataSource
          .getRepository(Transaction)
          .findOneByOrFail({ id: redemption!.transactionId! });
        expect(cashRow).toMatchObject({
          isSplit: false,
          isTransfer: false,
        });
        expect(Number(cashRow.amount)).toBe(5061);
      });

      it("creates the securities the file shows activity for", async () => {
        const job = await runImport("money2002");

        expect(job.result!.securitiesCreated).toBe(30);
        const securities = await dataSource
          .getRepository(Security)
          .find({ where: { userId } });
        expect(securities).toHaveLength(30);
        // A currency pseudo-security would arrive with a `/GBPUS`-shaped symbol.
        expect(
          securities.filter((security) => security.symbol.startsWith("/")),
        ).toHaveLength(0);
      });

      it("gives every security a unique symbol rather than collapsing funds", async () => {
        await runImport("money2002");

        const symbols = (
          await dataSource.getRepository(Security).find({ where: { userId } })
        ).map((security) => security.symbol.toUpperCase());

        expect(new Set(symbols).size).toBe(symbols.length);
      });

      it("writes the investment transactions", async () => {
        const job = await runImport("money2002");

        expect(job.result!.investmentTransactionsCreated).toBe(60);
        const rows = await dataSource
          .getRepository(InvestmentTransaction)
          .find({ where: { userId } });
        expect(rows).toHaveLength(60);
        // Every row in this file is an act=15 with no cash side.
        expect(rows.every((row) => row.action === "ADD_SHARES")).toBe(true);
        expect(rows.every((row) => row.securityId !== null)).toBe(true);
      });

      // The acceptance criterion for M2.4: what Monize holds must equal what
      // Money's open lots say, with no negative positions anywhere. PR #192
      // produced both wrong share counts and negative holdings.
      it("produces holdings equal to the LOT-derived positions", async () => {
        const job = await runImport("money2002");

        const holdings = await dataSource.getRepository(Holding).find();
        expect(holdings).toHaveLength(30);
        expect(holdings.every((holding) => Number(holding.quantity) > 0)).toBe(
          true,
        );

        expect(job.result!.holdings).toHaveLength(30);
        for (const line of job.result!.holdings) {
          expect(line.lotQuantity).toBeGreaterThan(0);
          expect(line.importedQuantity).toBe(line.lotQuantity);
          expect(line.matches).toBe(true);
        }
        expect(
          job
            .result!.warnings.map((warning) => warning.code)
            .includes("holdingsMismatch"),
        ).toBe(false);
      });

      it("imports the price history, deduped on (security, date)", async () => {
        const job = await runImport("money2002");

        expect(job.result!.pricesImported).toBe(60);
        const prices = await dataSource.getRepository(SecurityPrice).find();
        expect(prices).toHaveLength(60);
        expect(prices.every((price) => price.source === "mny_import")).toBe(
          true,
        );
      });

      it("imports the exchange-rate history additively", async () => {
        const job = await runImport("money2002");

        expect(job.result!.exchangeRatesImported).toBeGreaterThan(0);
        const rates = await dataSource.getRepository(ExchangeRate).find();
        expect(rates.length).toBe(job.result!.exchangeRatesImported);

        // A second import of the same file must converge, not duplicate. Only a
        // start that replaces existing data may import the same bytes again
        // (A26-H08); `deleteData` is stubbed here, so the global rate rows the
        // first run wrote are still present for the second to collide with.
        await runImport("money2002", { wipeExistingData: true });
        const after = await dataSource.getRepository(ExchangeRate).find();
        expect(after.length).toBe(rates.length);
      });

      it("leaves prices and rates alone when the toggles are off", async () => {
        const job = await runImport("money2002", {
          importPrices: false,
          importExchangeRates: false,
        });

        expect(job.status).toBe("completed");
        expect(await dataSource.getRepository(SecurityPrice).count()).toBe(0);
        expect(await dataSource.getRepository(ExchangeRate).count()).toBe(0);
        // Securities and investment rows are not price history and still land.
        expect(job.result!.securitiesCreated).toBe(30);
      });
    });
  });
});
