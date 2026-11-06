import { Test, TestingModule } from "@nestjs/testing";
import { Currency } from "../currencies/entities/currency.entity";
import { currencyPlacesRepoMock } from "../test-helpers/currency-places-testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionSplitService } from "./transaction-split.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { SplitKind } from "./entities/split-kind.enum";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { AccountsService } from "../accounts/accounts.service";
import { isTransactionInFuture } from "../common/date-utils";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { lockTransactionRow, lockTransactionRows } from "../common/db/locks";
import type { LockedTransactionRow } from "../common/db/locks";
import {
  lockedTransactionRow,
  stubLockedTransactions,
} from "../test-helpers/locks-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// `addSplit` and `updateSplits` now validate against the parent row they lock,
// not against the entity the caller passed. See test-helpers/locks-testing.
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

jest.mock("../common/date-utils", () => ({
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture =
  isTransactionInFuture as jest.MockedFunction<typeof isTransactionInFuture>;

describe("TransactionSplitService", () => {
  let service: TransactionSplitService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferencesRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;
  let netWorthService: { triggerDebouncedRecalc: jest.Mock };
  // The withScopedDb EntityManager, kept under the legacy `mockQueryRunner.manager`
  // shape so the pre-RLS manager assertions below still read naturally.
  let mockQueryRunner: Record<string, any>;

  const mockTransaction: Partial<Transaction> = {
    id: "tx-1",
    userId: "user-1",
    accountId: "account-1",
    amount: -100,
    currencyCode: "USD",
    transactionDate: "2026-01-15",
    payeeName: "Grocery Store",
    isSplit: true,
    categoryId: null,
  };

  /**
   * Make the locked parent row the service reads inside its transaction agree
   * with the entity this test hands in.
   *
   * The service deliberately no longer trusts the caller's copy -- the split-sum
   * validation has to run against the parent amount the write is serialized
   * against (P4-009) -- so a spec has to say what the committed row holds.
   */
  function lockParent(
    transaction: Partial<Transaction>,
    ...alsoLocked: LockedTransactionRow[]
  ): void {
    stubLocks([
      lockedTransactionRow({
        id: transaction.id ?? "tx-1",
        accountId: transaction.accountId ?? "account-1",
        amount: Number(transaction.amount ?? 0),
        transactionDate: String(transaction.transactionDate ?? "2026-01-15"),
        isSplit: transaction.isSplit ?? false,
        // The counterparts take the LOCKED parent's status, not the caller's
        // copy (A26-M09), so the committed row has to carry it.
        status: transaction.status ?? TransactionStatus.UNRECONCILED,
        // The counterpart rows are built from the locked parent's payee too
        // (FV4-002), so the committed row has to carry it.
        payeeId: transaction.payeeId ?? null,
        payeeName: transaction.payeeName ?? null,
      }),
      ...alsoLocked,
    ]);
  }

  /**
   * Say what the committed rows are for both locked readers.
   *
   * The counterpart-removal paths lock and re-read the legs they delete rather
   * than reading them through the repository first, so a spec describes them
   * here instead of through `transactionsRepository.find`.
   */
  function stubLocks(rows: LockedTransactionRow[]): void {
    stubLockedTransactions(
      {
        lockTransactionRow: lockTransactionRow as jest.Mock,
        lockTransactionRows: lockTransactionRows as jest.Mock,
      },
      rows,
    );
  }

  const mockSplit: Partial<TransactionSplit> = {
    id: "split-1",
    transactionId: "tx-1",
    categoryId: "cat-1",
    transferAccountId: null,
    linkedTransactionId: null,
    amount: -60,
    memo: "Food",
    createdAt: new Date("2026-01-15"),
  };

  const mockSplit2: Partial<TransactionSplit> = {
    id: "split-2",
    transactionId: "tx-1",
    categoryId: "cat-2",
    transferAccountId: null,
    linkedTransactionId: null,
    amount: -40,
    memo: "Drinks",
    createdAt: new Date("2026-01-15"),
  };

  beforeEach(async () => {
    mockedIsTransactionInFuture.mockReturnValue(false);
    // Module-level mocks outlive the testing module, so a spec asserting that a
    // reader was NOT consulted would otherwise see the previous test's calls.
    (lockTransactionRow as jest.Mock).mockClear();
    (lockTransactionRows as jest.Mock).mockClear();

    transactionsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-tx" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "new-tx" })),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    splitsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-split" })),
      save: jest.fn().mockImplementation((data) => {
        if (Array.isArray(data)) {
          return data.map((d: any, i: number) => ({
            ...d,
            id: d.id || `new-split-${i + 1}`,
          }));
        }
        return { ...data, id: data.id || "new-split" };
      }),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    categoriesRepository = {
      findOne: jest.fn().mockResolvedValue({ id: "cat-1", userId: "user-1" }),
    };
    // Transfer children resolve a cross-currency rate rather than posting the
    // parent-currency amount at par (audit P5-002). Same-currency splits never
    // reach the lookup.
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(null),
      getLatestRate: jest.fn().mockResolvedValue(null),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue({
        id: "account-2",
        name: "Savings",
        currencyCode: "USD",
      }),
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };

    // The strict reconciled lock reads the preference only when a candidate
    // row is RECONCILED; off unless a spec turns it on.
    userPreferencesRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const tenantMocks = createScopedDbMocks([
      [Transaction, transactionsRepository],
      [TransactionSplit, splitsRepository],
      [Category, categoriesRepository],
      [UserPreference, userPreferencesRepository],
      // `decimal_places` per currency, for the precision refusals.
      [Currency, currencyPlacesRepoMock({ BTC: 8 })],
    ]);
    mockDataSource = tenantMocks.dataSource;

    const manager = tenantMocks.manager;
    manager.create.mockImplementation((_Entity: any, data: any) => {
      if (_Entity === TransactionSplit) return splitsRepository.create(data);
      if (_Entity === Transaction) return transactionsRepository.create(data);
      return { ...data, id: "new-entity" };
    });
    manager.save.mockImplementation((data: any) => {
      if (Array.isArray(data)) return splitsRepository.save(data);
      if ("userId" in data) return transactionsRepository.save(data);
      return splitsRepository.save(data);
    });
    manager.update.mockImplementation((_Entity: any, id: any, data: any) => {
      if (_Entity === TransactionSplit)
        return splitsRepository.update(id, data);
      if (_Entity === Transaction)
        return transactionsRepository.update(id, data);
      return Promise.resolve(undefined);
    });
    // The real driver reports how many rows a conditional delete removed, and
    // the leg-removal protocol reverses a balance only when that count is 1.
    manager.delete.mockResolvedValue({ affected: 1, raw: [] });
    manager.findOne.mockResolvedValue(null);
    manager.find.mockImplementation((_Entity: any) => {
      if (_Entity === Category) {
        return Promise.resolve([
          { id: "cat-1" },
          { id: "cat-2" },
          { id: "cat-3" },
        ]);
      }
      return Promise.resolve([]);
    });
    manager.remove.mockResolvedValue(undefined);
    manager.query.mockResolvedValue([]);

    mockQueryRunner = { manager };

    const investmentTransactionsService = {
      createEmbeddedForSplit: jest.fn().mockResolvedValue({}),
      reverseAndRemoveEmbedded: jest.fn().mockResolvedValue(undefined),
      // The post-commit bond price recompute of the securities the embedded
      // rows touched (INV-BOND-005).
      recomputeBondPricesAfterSplitWrite: jest
        .fn()
        .mockResolvedValue(undefined),
      // The parent's status propagation asks the investment service to carry
      // the boundary onto embedded rows; an empty set means none were touched.
      applyParentStatusToEmbeddedRows: jest.fn().mockResolvedValue(new Set()),
      // The advisory lock a split-parent write takes before its row locks;
      // the real method returns nothing.
      lockEmbeddedHoldingScopes: jest.fn().mockResolvedValue(undefined),
    };

    netWorthService = {
      triggerDebouncedRecalc: jest.fn(),
    };

    const {
      InvestmentTransactionsService,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("../securities/investment-transactions.service");
    const {
      NetWorthService,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("../net-worth/net-worth.service");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionSplitService,
        {
          // Transfer children resolve a cross-currency rate rather than posting
          // the parent-currency amount at par (audit P5-002). Same-currency
          // splits never reach the lookup.
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
        { provide: AccountsService, useValue: accountsService },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TransactionSplitService>(TransactionSplitService);
  });

  describe("validateSplits", () => {
    it("passes validation for two splits equaling transaction amount", () => {
      const splits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("refuses a received amount on a line that is not a transfer", () => {
      const splits = [
        { amount: -60, categoryId: "cat-1", transferTargetAmount: 44 },
        { amount: -40, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
    });

    describe("at the parent currency's money precision (INV-MONEY-001)", () => {
      const btc = { code: "BTC", decimalPlaces: 8 };
      const cad = { code: "CAD", decimalPlaces: 2 };

      it("balances a BTC network-fee split at eight places", () => {
        const splits = [
          { amount: -0.005, transferAccountId: "chequing" },
          { amount: -0.000025, categoryId: "fees" },
        ];
        expect(() =>
          service.validateSplits(splits, -0.005025, btc),
        ).not.toThrow();
      });

      it("refuses a BTC split a satoshi short of its parent", () => {
        const splits = [
          { amount: -0.005, transferAccountId: "chequing" },
          { amount: -0.000025, categoryId: "fees" },
        ];
        expect(() => service.validateSplits(splits, -0.00502501, btc)).toThrow(
          /must equal transaction amount/,
        );
      });

      it("refuses a BTC line with a ninth place, naming the line", () => {
        const splits = [
          { amount: -0.005, transferAccountId: "chequing" },
          { amount: -0.000025001, categoryId: "fees" },
        ];
        expect(() => service.validateSplits(splits, -0.005025001, btc)).toThrow(
          /splits\[1\]\.amount/,
        );
      });

      it("accepts CAD lines at three places and refuses five", () => {
        expect(() =>
          service.validateSplits(
            [
              { amount: -12.345, categoryId: "cat-1" },
              { amount: -7.655, categoryId: "cat-2" },
            ],
            -20,
            cad,
          ),
        ).not.toThrow();
        expect(() =>
          service.validateSplits(
            [
              { amount: -12.34567, categoryId: "cat-1" },
              { amount: -7.65433, categoryId: "cat-2" },
            ],
            -20,
            cad,
          ),
        ).toThrow(BadRequestException);
      });
    });

    it("passes validation for a single transfer split", () => {
      const splits = [{ amount: -100, transferAccountId: "account-2" }];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("throws when fewer than 2 splits and no transfer", () => {
      const splits = [{ amount: -100, categoryId: "cat-1" }];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        "Split transactions must have at least 2 splits",
      );
    });

    it("throws when split amounts do not equal transaction amount", () => {
      const splits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -30, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        /Split amounts .* must equal transaction amount/,
      );
    });

    it("allows zero amount splits when total matches", () => {
      const splits = [
        { amount: 0, categoryId: "cat-1" },
        { amount: -100, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("handles floating point precision correctly", () => {
      const splits = [
        { amount: -33.3333, categoryId: "cat-1" },
        { amount: -33.3333, categoryId: "cat-2" },
        { amount: -33.3334, categoryId: "cat-3" },
      ];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("passes with multiple splits summing to positive amount", () => {
      const splits = [
        { amount: 50, categoryId: "cat-1" },
        { amount: 30, categoryId: "cat-2" },
        { amount: 20, categoryId: "cat-3" },
      ];
      expect(() => service.validateSplits(splits, 100)).not.toThrow();
    });
  });

  describe("createSplits", () => {
    it("creates category splits without transfer logic", async () => {
      const splits = [
        { amount: -60, categoryId: "cat-1", memo: "Food" },
        { amount: -40, categoryId: "cat-2", memo: "Drinks" },
      ];

      const result = await service.createSplits("tx-1", splits);

      // Regular splits are batch-created and batch-saved
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        TransactionSplit,
        {
          transactionId: "tx-1",
          kind: "category",
          categoryId: "cat-1",
          transferAccountId: null,
          amount: -60,
          memo: "Food",
        },
      );
    });

    it("creates a transfer split with linked transaction when userId and sourceAccountId provided", async () => {
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });

      // The linked transaction save (only transactionsRepository.save call in this flow)
      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });

      // The split save
      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });

      const splits = [
        { amount: -50, transferAccountId: "account-2", memo: "Transfer part" },
      ];

      const result = await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        "Store",
        "payee-uuid-1",
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-2",
      );
      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          accountId: "account-2",
          amount: 50,
          isTransfer: true,
          // The counterpart adopts the parent split's payee UUID (not just the
          // display name) so the target account's leg is filterable by payee.
          payeeId: "payee-uuid-1",
          payeeName: "Store",
          // The counterpart's date is the parent's calendar day as a plain
          // yyyy-MM-dd string, not a Date object that would shift west of UTC.
          transactionDate: "2026-01-15",
        }),
      );
      expect(splitsRepository.update).toHaveBeenCalledWith(
        "split-new",
        expect.objectContaining({ linkedTransactionId: "linked-tx-1" }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "linked-tx-1",
        expect.objectContaining({ linkedTransactionId: "tx-1" }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        50,
      );
      expect(result).toHaveLength(1);
      expect(result[0].linkedTransactionId).toBe("linked-tx-1");
    });

    it("does not move the target balance for a VOID parent, and voids the counterpart", async () => {
      // A VOID transaction is a record of something that did not happen. Its
      // transfer child used to credit the target account anyway and leave an
      // ACTIVE counterpart leg behind it: the parent said nothing happened, the
      // counterpart said it had, and every balance and report predicate excludes
      // the void row while including the counterpart. Money from nowhere.
      //
      // This is the split-path twin of audit P5-001, which the audit did not
      // reach -- `VOID` appeared nowhere in this service.
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });

      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });
      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });

      await service.createSplits(
        "tx-1",
        [
          {
            amount: -50,
            transferAccountId: "account-2",
            memo: "Transfer part",
          },
        ],
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        "Store",
        "payee-uuid-1",
        { parentStatus: TransactionStatus.VOID },
      );

      // The counterpart is written, and written VOID.
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-2",
          status: TransactionStatus.VOID,
        }),
      );
      // And no balance moved, by either mechanism.
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("converts a transfer child into the target account's currency", async () => {
      // Split amounts are in the PARENT account's currency. The counterpart used
      // to be created at exactly `-split.amount` with `exchangeRate: 1` while
      // being labelled with the target's currency, so a 50 USD child credited 50
      // EUR and recorded the pair as if the currencies were at par. That is the
      // transfer-split half of audit P5-002.
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Euro Savings",
          currencyCode: "EUR",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });
      exchangeRateService.getRateForDate.mockResolvedValue(0.9);

      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 45,
      });
      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });

      await service.createSplits(
        "tx-1",
        [
          {
            amount: -50,
            transferAccountId: "account-2",
            memo: "Transfer part",
          },
        ],
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        "Store",
        "payee-uuid-1",
      );

      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "EUR",
        "2026-01-15",
      );
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-2",
          currencyCode: "EUR",
          amount: 45,
          exchangeRate: 0.9,
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        45,
      );
    });

    describe("transferTargetAmount", () => {
      const mockAccounts = (targetCurrency: string) =>
        accountsService.findOne
          .mockResolvedValueOnce({
            id: "account-2",
            name: "Target",
            currencyCode: targetCurrency,
          })
          .mockResolvedValueOnce({
            id: "account-1",
            name: "Checking",
            currencyCode: "USD",
          });

      const createOne = (amount: number, transferTargetAmount: number) => {
        splitsRepository.save.mockResolvedValueOnce({
          id: "split-new",
          transactionId: "tx-1",
          transferAccountId: "account-2",
          amount,
        });
        transactionsRepository.save.mockResolvedValueOnce({
          id: "linked-tx-1",
          accountId: "account-2",
        });
        return service.createSplits(
          "tx-1",
          [{ amount, transferAccountId: "account-2", transferTargetAmount }],
          "user-1",
          "account-1",
          new Date("2026-01-15"),
          "Store",
          "payee-uuid-1",
        );
      };

      it("credits the stated received amount at its implied rate, not the market rate", async () => {
        // The bank settled 50 USD as 44.50 EUR after its FX fee; the market
        // rate (0.9) would have credited 45.00.
        mockAccounts("EUR");
        exchangeRateService.getRateForDate.mockResolvedValue(0.9);

        await createOne(-50, 44.5);

        expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
        expect(transactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "account-2",
            currencyCode: "EUR",
            amount: 44.5,
            exchangeRate: 0.89,
          }),
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-2",
          44.5,
        );
      });

      it("debits the target when the line brings money into the parent", async () => {
        mockAccounts("EUR");

        await createOne(50, 44.5);

        expect(transactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ amount: -44.5, exchangeRate: 0.89 }),
        );
      });

      it("refuses a same-currency received amount that differs from the line", async () => {
        mockAccounts("USD");

        await expect(createOne(-50, 49)).rejects.toThrow(BadRequestException);
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("accepts a same-currency received amount equal to the line", async () => {
        mockAccounts("USD");

        await createOne(-50, 50);

        expect(transactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ amount: 50, exchangeRate: 1 }),
        );
      });

      it("asks for a currency with no row once for the whole operation, not once per line", async () => {
        // ZZZ has no `currencies` row: absent from the map, but already asked for.
        accountsService.findOne.mockImplementation(
          async (_u: string, id: string) => ({
            id,
            name: id,
            currencyCode: "ZZZ",
          }),
        );
        const lines = [-10, -20, -30].map((amount) => ({
          amount,
          transferAccountId: "account-2",
        }));
        const query = mockQueryRunner.manager.getRepository(Currency).query;
        query.mockClear();

        await service.createSplits(
          "tx-1",
          lines,
          "user-1",
          "account-1",
          new Date("2026-01-15"),
          "Store",
          null,
        );

        expect(accountsService.findOne).toHaveBeenCalledTimes(6);
        expect(query).toHaveBeenCalledTimes(1);
      });

      it("converts a CAD line into a BTC wallet at eight places", async () => {
        accountsService.findOne
          .mockResolvedValueOnce({
            id: "account-2",
            name: "Wallet",
            currencyCode: "BTC",
          })
          .mockResolvedValueOnce({
            id: "account-1",
            name: "Chequing",
            currencyCode: "CAD",
          });
        // BTC->CAD 136000.1234567890, read the other way at rate precision.
        exchangeRateService.getRateForDate.mockResolvedValue(0.0000073529);
        splitsRepository.save.mockResolvedValueOnce({
          id: "split-new",
          transactionId: "tx-1",
          transferAccountId: "account-2",
          amount: -1700,
        });
        transactionsRepository.save.mockResolvedValueOnce({
          id: "linked-tx-1",
          accountId: "account-2",
        });

        await service.createSplits(
          "tx-1",
          [{ amount: -1700, transferAccountId: "account-2" }],
          "user-1",
          "account-1",
          new Date("2026-01-15"),
          "Exchange",
          null,
        );

        // 0.01249993, not the 0.0125 four places would round it to.
        expect(transactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ currencyCode: "BTC", amount: 0.01249993 }),
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-2",
          0.01249993,
        );
      });

      it("stores a stated BTC received amount as given and refuses a ninth place", async () => {
        const intoWallet = () =>
          accountsService.findOne
            .mockResolvedValueOnce({
              id: "account-2",
              name: "Wallet",
              currencyCode: "BTC",
            })
            .mockResolvedValueOnce({
              id: "account-1",
              name: "Checking",
              currencyCode: "USD",
            });
        intoWallet();
        await createOne(-1700, 0.01249993);
        expect(transactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: 0.01249993,
            exchangeRate: 0.0000073529,
          }),
        );

        accountsService.updateBalance.mockClear();
        intoWallet();
        await expect(createOne(-1700, 0.012499931)).rejects.toThrow(
          /transferTargetAmount/,
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("refuses a received amount of zero against a non-zero line", async () => {
        mockAccounts("EUR");

        await expect(createOne(-50, 0)).rejects.toThrow(BadRequestException);
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });

    it("refuses a cross-currency transfer child with no determinable rate", async () => {
      // Refusing beats posting at par: 50 USD credited as 50 EUR looks entirely
      // normal and is wrong by the whole FX difference.
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Euro Savings",
          currencyCode: "EUR",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });
      exchangeRateService.getRateForDate.mockResolvedValue(null);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });

      await expect(
        service.createSplits(
          "tx-1",
          [
            {
              amount: -50,
              transferAccountId: "account-2",
              memo: "Transfer part",
            },
          ],
          "user-1",
          "account-1",
          new Date("2026-01-15"),
          "Store",
          "payee-uuid-1",
        ),
      ).rejects.toThrow(/Could not determine an exchange rate/);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("persists a null payee when parentPayeeName is null (issue #1214)", async () => {
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "CAD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "CAD",
        });

      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });
      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
      });

      const splits = [{ amount: -50, transferAccountId: "account-2" }];

      await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        null,
      );

      // Blank stays blank (issue #1214): no stamped "Transfer from
      // <account>" -- the display resolves the label from the linked parent.
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeId: null,
          payeeName: null,
        }),
      );
    });

    it("skips transfer logic when userId is not provided", async () => {
      const splits = [{ amount: -100, transferAccountId: "account-2" }];

      splitsRepository.save.mockResolvedValueOnce([
        {
          id: "split-new",
          transactionId: "tx-1",
          transferAccountId: "account-2",
          amount: -100,
        },
      ]);

      const result = await service.createSplits("tx-1", splits);

      expect(accountsService.findOne).not.toHaveBeenCalled();
      expect(transactionsRepository.create).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it("sets null for optional fields when not provided", async () => {
      const splits = [{ amount: -60 }, { amount: -40 }];

      await service.createSplits("tx-1", splits);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        TransactionSplit,
        {
          transactionId: "tx-1",
          kind: "category",
          categoryId: null,
          transferAccountId: null,
          amount: -60,
          memo: null,
        },
      );
    });
  });

  // The transfer-leg reversal these cases cover used to live in the
  // (now-removed) deleteTransferSplitLinkedTransactions; deleteSplitSideEffects
  // does the same work plus the investment-split reversal.
  describe("applyParentStatusToTransferCounterparts (FR-002)", () => {
    // A split parent and the counterparts its transfer children created are one
    // economic event. `parentStatus` reaches a counterpart when children are
    // created or rebuilt, but a status-only edit does not rebuild them -- so
    // voiding a mixed category/transfer split restored the source balance and
    // left the target holding the transferred amount under an ACTIVE counterpart.
    // The helper now derives the transition and the delta from the LOCKED
    // counterpart row, not a relation read -- an unlocked amount raced a
    // concurrent leg edit (P4-003 shape).
    const transferSplit = {
      id: "split-1",
      transactionId: "tx-1",
      transferAccountId: "account-2",
      linkedTransactionId: "linked-tx-1",
    };
    const counterpartRow = (status: TransactionStatus) =>
      lockedTransactionRow({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 40,
        status,
        transactionDate: "2026-01-15",
      });

    it("voids the counterpart and removes its balance contribution", async () => {
      splitsRepository.find.mockResolvedValue([transferSplit]);
      stubLocks([counterpartRow(TransactionStatus.UNRECONCILED)]);

      await service.applyParentStatusToTransferCounterparts(
        mockQueryRunner.manager as never,
        "tx-1",
        "user-1",
        TransactionStatus.VOID,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "linked-tx-1",
        { status: TransactionStatus.VOID },
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -40,
      );
    });

    it("restores the contribution when the parent leaves VOID", async () => {
      splitsRepository.find.mockResolvedValue([transferSplit]);
      stubLocks([counterpartRow(TransactionStatus.VOID)]);

      await service.applyParentStatusToTransferCounterparts(
        mockQueryRunner.manager as never,
        "tx-1",
        "user-1",
        TransactionStatus.UNRECONCILED,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        40,
      );
    });

    it("does nothing when the inclusion state does not change", async () => {
      splitsRepository.find.mockResolvedValue([transferSplit]);
      stubLocks([counterpartRow(TransactionStatus.UNRECONCILED)]);

      await service.applyParentStatusToTransferCounterparts(
        mockQueryRunner.manager as never,
        "tx-1",
        "user-1",
        TransactionStatus.CLEARED,
      );

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });

    it("leaves a category child's split alone", async () => {
      // Only transfer children have a counterpart row to carry the status to.
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-2",
          transactionId: "tx-1",
          transferAccountId: null,
          categoryId: "cat-1",
          linkedTransactionId: null,
        },
      ]);

      await service.applyParentStatusToTransferCounterparts(
        mockQueryRunner.manager as never,
        "tx-1",
        "user-1",
        TransactionStatus.VOID,
      );

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
  });

  describe("deleteSplitSideEffects transfer legs", () => {
    it("removes linked transactions and reverses balances for transfer splits", async () => {
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
      };

      splitsRepository.find.mockResolvedValue([transferSplit]);
      stubLocks([
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
        }),
      ]);

      await service.deleteSplitSideEffects("tx-1", "user-1");

      expect(splitsRepository.find).toHaveBeenCalledWith({
        where: { transactionId: "tx-1" },
        relations: ["linkedTransaction", "investmentTransaction"],
      });
      // The legs are locked and re-read, not read through the repository: the
      // amount reversed has to be the one the delete removes (FV4-002).
      expect(lockTransactionRows).toHaveBeenCalledWith(
        expect.anything(),
        ["linked-tx-1"],
        "user-1",
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
      );
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-1",
        userId: "user-1",
      });
      expect(transactionsRepository.remove).not.toHaveBeenCalled();
    });

    /**
     * Issue #2039: a leg is a row in another account that the replacement, the
     * edit with splits, the delete and the conversion of its parent all delete,
     * so a reconciled one is refused under the strict lock -- before the
     * embedded rows are reversed or any leg is removed.
     */
    it("refuses a reconciled leg under the strict lock before writing anything", async () => {
      userPreferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        lockReconciledTransactions: true,
      });
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-1",
          transactionId: "tx-1",
          kind: SplitKind.INVESTMENT,
          investmentTransaction: { id: "inv-1", accountId: "brokerage" },
        },
        {
          id: "split-2",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
        },
      ]);
      stubLocks([
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
          status: TransactionStatus.RECONCILED,
        }),
      ]);

      await expect(
        service.deleteSplitSideEffects("tx-1", "user-1"),
      ).rejects.toThrow(/reconciled/i);

      expect(
        (service as any).investmentTransactionsService.reverseAndRemoveEmbedded,
      ).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("skips splits without linkedTransactionId or transferAccountId", async () => {
      const categorySplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.find.mockResolvedValue([categorySplit]);

      await service.deleteSplitSideEffects("tx-1", "user-1");

      expect(lockTransactionRows).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
      );
    });

    it("handles case where linked transaction not found in DB", async () => {
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
      };

      splitsRepository.find.mockResolvedValue([transferSplit]);
      // Nothing locked: another request already removed the leg.
      stubLocks([]);

      await service.deleteSplitSideEffects("tx-1", "user-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
      );
    });

    it("does nothing when no splits exist", async () => {
      splitsRepository.find.mockResolvedValue([]);

      await service.deleteSplitSideEffects("tx-1", "user-1");

      expect(lockTransactionRows).not.toHaveBeenCalled();
    });

    it("handles multiple transfer splits", async () => {
      const splits = [
        {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
        },
        {
          id: "split-2",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-2",
          transferAccountId: "account-3",
        },
      ];

      splitsRepository.find.mockResolvedValue(splits);
      stubLocks([
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 30,
        }),
        lockedTransactionRow({
          id: "linked-tx-2",
          accountId: "account-3",
          amount: 70,
        }),
      ]);

      await service.deleteSplitSideEffects("tx-1", "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-1",
        userId: "user-1",
      });
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-2",
        userId: "user-1",
      });
    });
  });

  describe("getSplits", () => {
    it("returns splits ordered by createdAt ASC with relations", async () => {
      splitsRepository.find.mockResolvedValue([mockSplit, mockSplit2]);

      const result = await service.getSplits("tx-1");

      expect(splitsRepository.find).toHaveBeenCalledWith({
        where: { transactionId: "tx-1" },
        relations: ["category", "transferAccount", "investmentTransaction"],
        order: { createdAt: "ASC" },
      });
      expect(result).toEqual([mockSplit, mockSplit2]);
    });

    it("returns empty array when no splits exist", async () => {
      splitsRepository.find.mockResolvedValue([]);

      const result = await service.getSplits("tx-1");

      expect(result).toEqual([]);
    });
  });

  describe("updateSplits", () => {
    it("validates, deletes old splits, creates new splits, and marks transaction as split", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const newSplits = [
        { amount: -70, categoryId: "cat-1" },
        { amount: -30, categoryId: "cat-2" },
      ];

      // deleteTransferSplitLinkedTransactions mock - no transfer splits
      splitsRepository.find.mockResolvedValue([]);

      const result = await service.updateSplits(
        transaction,
        newSplits,
        "user-1",
      );

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        TransactionSplit,
        { transactionId: "tx-1" },
      );
      // Regular splits are batch-created via queryRunner
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: true, categoryId: null },
      );
      expect(result).toHaveLength(2);
    });

    it("recreates a VOID parent's transfer counterparts as VOID (FR-002 family)", async () => {
      // Replacing the split set of a voided transaction deletes the VOID
      // counterparts and creates fresh ones. `parentStatus` was not threaded
      // through this path -- unlike the create and update paths in
      // `TransactionsService` -- so the new legs came back ACTIVE and credited
      // the target account money the source still showed as not sent. Reachable
      // from `PUT /transactions/:id/splits`, the AI action, and the MCP tool.
      const transaction = {
        ...mockTransaction,
        status: TransactionStatus.VOID,
      } as Transaction;
      lockParent(transaction);

      splitsRepository.find.mockResolvedValue([]);
      accountsService.findOne.mockResolvedValue({
        id: "account-2",
        name: "Savings",
        currencyCode: "USD",
      });

      await service.updateSplits(
        transaction,
        [
          { amount: -60, categoryId: "cat-1" },
          { amount: -40, transferAccountId: "account-2" },
        ],
        "user-1",
      );

      const createdLeg = mockQueryRunner.manager.create.mock.calls.find(
        (call: any) => call[0] === Transaction,
      );
      expect(createdLeg).toBeDefined();
      expect(createdLeg[1].status).toBe(TransactionStatus.VOID);
      // Recorded, not applied: a VOID row moves no balance.
      expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
        "account-2",
        40,
      );
    });

    /**
     * Lock order (`common/db/locks.ts`): advisory locks come before row locks.
     *
     * A replacement reaches the holdings advisory lock twice on the way --
     * `deleteSplitSideEffects` tearing the parent's embedded investment rows
     * down, `createEmbeddedForSplit` building the new ones -- while
     * `InvestmentTransactionsService.update()` takes that advisory lock first
     * and then row-locks the same parent. Advisory A then row P against row P
     * then advisory A is `40P01` for both, so the advisory lock is the first
     * statement of this transaction.
     */
    it("locks the embedded investment scopes before the parent's row lock", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.find.mockResolvedValue([]);
      const lockScopes = jest.spyOn(service, "lockEmbeddedInvestmentScopes");

      await service.updateSplits(
        transaction,
        [
          { amount: -60, categoryId: "cat-1" },
          { amount: -40, categoryId: "cat-2" },
        ],
        "user-1",
      );

      expect(lockScopes).toHaveBeenCalledWith(expect.anything(), "user-1", [
        "tx-1",
      ]);
      expect(lockTransactionRow).toHaveBeenCalled();
      expect(lockScopes.mock.invocationCallOrder[0]).toBeLessThan(
        (lockTransactionRow as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it("throws when splits fail validation", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const invalidSplits = [
        { amount: -50, categoryId: "cat-1" },
        { amount: -30, categoryId: "cat-2" },
      ];

      await expect(
        service.updateSplits(transaction, invalidSplits, "user-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("deletes transfer linked transactions before replacing splits", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const oldTransferSplit = {
        id: "old-split",
        transactionId: "tx-1",
        linkedTransactionId: "old-linked-tx",
        transferAccountId: "account-2",
      };
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "old-linked-tx",
          accountId: "account-2",
          amount: 100,
        }),
      );

      splitsRepository.find.mockResolvedValue([oldTransferSplit]);

      const newSplits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ];

      splitsRepository.save.mockResolvedValueOnce([
        { id: "s1", ...newSplits[0], transactionId: "tx-1" },
        { id: "s2", ...newSplits[1], transactionId: "tx-1" },
      ]);

      await service.updateSplits(transaction, newSplits, "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -100,
      );
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "old-linked-tx",
        userId: "user-1",
      });
    });
  });

  describe("net-worth invalidation for target accounts (RR5-002)", () => {
    it("createSplits reports the transfer target account to the affected set", async () => {
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });
      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });
      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });

      // The counterpart lives in account-2, which the parent transaction never
      // named -- so its net worth went stale because only the parent account was
      // invalidated. createSplits now reports the account it touched.
      const affected = new Set<string>();
      await service.createSplits(
        "tx-1",
        [{ amount: -50, transferAccountId: "account-2", memo: "T" }],
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        "Store",
        "payee-uuid-1",
        undefined,
        affected,
      );

      expect(affected.has("account-2")).toBe(true);
    });

    it("addSplit invalidates the target account after commit", async () => {
      splitsRepository.find.mockResolvedValue([]);
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });
      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 40,
      });
      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
      });

      await service.addSplit(
        {
          id: "tx-1",
          accountId: "account-1",
          amount: -100,
          currencyCode: "USD",
          transactionDate: "2026-01-15",
          status: TransactionStatus.UNRECONCILED,
          payeeName: "Store",
        } as never,
        { amount: -40, transferAccountId: "account-2", memo: "T" },
        "user-1",
      );

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "account-2",
        "user-1",
      );
    });

    it("removeSplit invalidates the target account after commit", async () => {
      splitsRepository.findOne.mockResolvedValue({
        id: "split-1",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        linkedTransactionId: "linked-tx-1",
      });
      // Both the parent and the linked counterpart leg are locked and re-read
      // inside the write transaction (removeLinkedLeg -> lockTransactionRow),
      // never read through the repo mock. The counterpart's account is the one
      // whose net worth must be invalidated after commit.
      lockParent(
        { id: "tx-1", accountId: "account-1", isSplit: true },
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 40,
          status: TransactionStatus.UNRECONCILED,
          transactionDate: "2026-01-15",
        }),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        { id: "split-a", kind: "CATEGORY", categoryId: "cat-1" },
        { id: "split-b", kind: "CATEGORY", categoryId: "cat-2" },
      ]);

      await service.removeSplit(
        { id: "tx-1", accountId: "account-1", isSplit: true } as never,
        "split-1",
        "user-1",
      );

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "account-2",
        "user-1",
      );
    });
  });

  describe("addSplit", () => {
    it("adds a category split to an existing split transaction", async () => {
      const transaction = { ...mockTransaction, isSplit: true } as Transaction;
      lockParent(transaction);
      const existingSplits = [
        { ...mockSplit, amount: -60 },
        { ...mockSplit2, amount: -30 },
      ];

      splitsRepository.find.mockResolvedValue(existingSplits);
      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -10,
        categoryId: "cat-3",
        memo: null,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -10,
        categoryId: "cat-3",
        category: { id: "cat-3", name: "Other" },
        transferAccount: null,
      });

      const result = await service.addSplit(
        transaction,
        { amount: -10, categoryId: "cat-3" },
        "user-1",
      );

      expect(splitsRepository.create).toHaveBeenCalledWith({
        transactionId: "tx-1",
        kind: "category",
        categoryId: "cat-3",
        transferAccountId: null,
        amount: -10,
        memo: null,
      });
      expect(result.id).toBe("new-split-id");
    });

    /**
     * Issue #2039: a whole set -- a parent flagged a split whose lines add up
     * to it -- grows by the added line, the mirror of removeSplit, so the lines
     * still add up to the parent and its account moves by the line.
     */
    describe("on a whole set", () => {
      function stubAdded(amount: number): void {
        splitsRepository.find.mockResolvedValue([
          { ...mockSplit, amount: -60 },
          { ...mockSplit2, amount: -40 },
        ]);
        splitsRepository.findOne.mockResolvedValue({
          id: "new-split",
          transactionId: "tx-1",
          amount,
          categoryId: "cat-3",
        });
      }

      it("grows the parent by a line of its own sign and moves its account", async () => {
        const transaction = { ...mockTransaction } as Transaction;
        lockParent(transaction);
        stubAdded(-10);

        await service.addSplit(
          transaction,
          { amount: -10, categoryId: "cat-3" },
          "user-1",
        );

        expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
          Transaction,
          "tx-1",
          { amount: -110 },
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-1",
          -10,
        );
        expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
          "account-1",
          "user-1",
        );
      });

      it("shrinks the parent by an opposite-signed line rather than leaving it short", async () => {
        const transaction = { ...mockTransaction } as Transaction;
        lockParent(transaction);
        stubAdded(10);

        await service.addSplit(
          transaction,
          { amount: 10, categoryId: "cat-3" },
          "user-1",
        );

        expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
          Transaction,
          "tx-1",
          { amount: -90 },
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-1",
          10,
        );
      });

      it("re-totals a VOID parent without moving its account", async () => {
        const transaction = {
          ...mockTransaction,
          status: TransactionStatus.VOID,
        } as Transaction;
        lockParent(transaction);
        stubAdded(-10);

        await service.addSplit(
          transaction,
          { amount: -10, categoryId: "cat-3" },
          "user-1",
        );

        expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
          Transaction,
          "tx-1",
          { amount: -110 },
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("leaves a set short of its parent at the parent's amount", async () => {
        const transaction = { ...mockTransaction } as Transaction;
        lockParent(transaction);
        splitsRepository.find.mockResolvedValue([
          { ...mockSplit, amount: -60 },
        ]);
        splitsRepository.findOne.mockResolvedValue({
          id: "new-split",
          transactionId: "tx-1",
          amount: -10,
        });

        await service.addSplit(
          transaction,
          { amount: -10, categoryId: "cat-3" },
          "user-1",
        );

        expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
          Transaction,
          "tx-1",
          expect.objectContaining({ amount: expect.anything() }),
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });

    it("throws when adding split would exceed transaction amount", async () => {
      const transaction = { ...mockTransaction, amount: -100 } as Transaction;
      lockParent(transaction);
      const existingSplits = [{ ...mockSplit, amount: -90 }];

      splitsRepository.find.mockResolvedValue(existingSplits);

      await expect(
        service.addSplit(
          transaction,
          { amount: -20, categoryId: "cat-3" },
          "user-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("marks transaction as split when total reaches 2 splits", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: false,
        amount: -100,
      } as Transaction;
      lockParent(transaction);
      const existingSplits = [{ ...mockSplit, amount: -60 }];

      splitsRepository.find.mockResolvedValue(existingSplits);
      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -40,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -40,
        category: null,
        transferAccount: null,
      });

      await service.addSplit(
        transaction,
        { amount: -40, categoryId: "cat-2" },
        "user-1",
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: true,
        categoryId: null,
      });
    });

    it("does not update isSplit when already split", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: true,
        amount: -100,
      } as Transaction;
      lockParent(transaction);
      const existingSplits = [
        { ...mockSplit, amount: -40 },
        { ...mockSplit2, amount: -30 },
      ];

      splitsRepository.find.mockResolvedValue(existingSplits);
      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -30,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -30,
        category: null,
        transferAccount: null,
      });

      await service.addSplit(
        transaction,
        { amount: -30, categoryId: "cat-3" },
        "user-1",
      );

      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });

    it("creates linked transaction for transfer split", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: true,
        amount: -100,
        payeeName: "My Transfer",
      } as Transaction;
      lockParent(transaction);
      const existingSplits = [{ ...mockSplit, amount: -60 }];

      splitsRepository.find.mockResolvedValue(existingSplits);

      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "CAD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "CAD",
        });

      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -40,
      });
      transactionsRepository.save.mockResolvedValue({
        id: "linked-tx-new",
        accountId: "account-2",
        amount: 40,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -40,
        transferAccountId: "account-2",
        linkedTransactionId: "linked-tx-new",
        category: null,
        transferAccount: { id: "account-2", name: "Savings" },
      });

      const result = await service.addSplit(
        transaction,
        { amount: -40, transferAccountId: "account-2" },
        "user-1",
      );

      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          accountId: "account-2",
          amount: 40,
          isTransfer: true,
          payeeName: "My Transfer",
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        40,
      );
      expect(result.linkedTransactionId).toBe("linked-tx-new");
    });

    it("throws NotFoundException when saved split cannot be found with relations", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: true,
        amount: -100,
      } as Transaction;
      lockParent(transaction);

      splitsRepository.find.mockResolvedValue([{ ...mockSplit, amount: -60 }]);
      splitsRepository.save.mockResolvedValue({
        id: "ghost-split",
        transactionId: "tx-1",
        amount: -40,
      });
      splitsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.addSplit(
          transaction,
          { amount: -40, categoryId: "cat-2" },
          "user-1",
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("removeSplit", () => {
    it("removes a category split from a transaction with more than 2 splits", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);
      // -60.00 + -25.00 + -15.00: the set adds up to the -100.00 parent.
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit2, amount: -25 },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -15,
          categoryId: "cat-3",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        splitToRemove,
      );
      // The line's money leaves the parent with it (issue #2025): -100.00 less
      // the -60.00 line, and the account gets the 60.00 back.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { amount: -40 },
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        60,
      );
      // Two lines remain, so the parent stays a split.
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        expect.objectContaining({ isSplit: false }),
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "account-1",
        "user-1",
      );
    });

    it("throws NotFoundException when split not found", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.removeSplit(transaction, "nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("removes linked transaction for transfer split", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
        }),
      );

      splitsRepository.findOne.mockResolvedValue(transferSplit);
      // remaining splits after removal -- still 2+
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-2",
          transactionId: "tx-1",
          amount: -30,
          categoryId: "cat-1",
        },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -20,
          categoryId: "cat-2",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
      );
      // Deleted conditionally, so a second caller reverses nothing (FV4-002).
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-1",
        userId: "user-1",
      });
      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: "linked-tx-1" }),
      );
    });

    it("collapses to non-split when only 1 split remains (category)", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);

      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        categoryId: "cat-2",
        linkedTransactionId: null,
        transferAccountId: null,
        amount: -40,
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: false, categoryId: "cat-2" },
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(lastSplit);
    });

    /**
     * Issue #2025: a -100.00 split of -60.00 Groceries and a -40.00 transfer to
     * Savings. Removing the Groceries line used to delete the Savings leg the
     * request never named and leave a -100.00 parent with no category and no
     * transfer. The parent becomes the -40.00 transfer and the leg stays.
     */
    it("makes the parent the remaining transfer and keeps its leg when the last split is a transfer", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-2",
          accountId: "account-3",
          amount: 40,
        }),
      );
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);

      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        categoryId: null,
        linkedTransactionId: "linked-tx-2",
        transferAccountId: "account-3",
        amount: -40,
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-1", "user-1");

      // The leg in the other account is neither deleted nor reversed.
      expect(mockQueryRunner.manager.delete).not.toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({ id: "linked-tx-2" }),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
        "account-3",
        expect.anything(),
      );
      // Only the removed line's 60.00 comes back to the parent's account.
      expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        60,
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { amount: -40 },
      );
      // The pair links both ways, as a created transfer's legs do.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        {
          isSplit: false,
          isTransfer: true,
          categoryId: null,
          linkedTransactionId: "linked-tx-2",
        },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "linked-tx-2",
        { linkedTransactionId: "tx-1" },
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(lastSplit);
    });

    /**
     * The other half of issue #2025: removing the transfer line deletes the
     * Savings leg, as asked, and the parent becomes a -60.00 Groceries
     * transaction with the 40.00 back in Chequing -- not a -100.00 Groceries
     * transaction whose 40.00 left Chequing and arrived nowhere.
     */
    it("re-totals the parent and returns the line's money when the transfer line is removed", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-2",
        transactionId: "tx-1",
        kind: "TRANSFER",
        categoryId: null,
        linkedTransactionId: "linked-tx-2",
        transferAccountId: "account-3",
        amount: -40,
      };
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-2",
          accountId: "account-3",
          amount: 40,
        }),
      );
      splitsRepository.findOne.mockResolvedValue(transferSplit);
      const lastSplit = {
        ...mockSplit,
        kind: "CATEGORY",
        categoryId: "cat-groceries",
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-2", "user-1");

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-2",
        userId: "user-1",
      });
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-3",
        -40,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        40,
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { amount: -60 },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: false, categoryId: "cat-groceries" },
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(lastSplit);
    });

    it("re-totals a VOID parent without moving its account's balance", async () => {
      const transaction = {
        ...mockTransaction,
        status: TransactionStatus.VOID,
      } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({ ...mockSplit });
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit2 },
        { id: "split-3", transactionId: "tx-1", amount: 0 },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { amount: -40 },
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("recomputes a future-dated parent's account rather than moving it by a delta", async () => {
      mockedIsTransactionInFuture.mockReturnValue(true);
      const transaction = {
        ...mockTransaction,
        transactionDate: "2027-06-15",
      } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({ ...mockSplit });
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit2 },
        { id: "split-3", transactionId: "tx-1", amount: 0 },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("leaves the amount and the balance alone when the removed line is zero", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({ ...mockSplit, amount: 0 });
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit, id: "split-3" },
        { ...mockSplit2 },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    /**
     * A set built line by line through `addSplit` may hold less than the
     * parent, and `addSplit` moved neither the parent's amount nor its account,
     * so removing a line from it moves neither back. Its last line cannot
     * become the parent either: the parent would carry that line's category,
     * or its transfer, for money the line never held.
     */
    it("leaves a parent its lines never added up to, and does not collapse into its last line", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        amount: -30,
      });
      const lastSplit = {
        ...mockSplit2,
        linkedTransactionId: "linked-tx-2",
        transferAccountId: "account-3",
        categoryId: null,
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-1", "user-1");

      // -30.00 and -40.00 never made the -100.00 parent.
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalledWith(
        lastSplit,
      );
      expect(lockTransactionRow).not.toHaveBeenCalledWith(
        expect.anything(),
        "linked-tx-2",
        "user-1",
      );
    });

    /**
     * The review's case: a plain -100.00 row given one -30.00 line through
     * `addSplit` (which flips nothing until a second line), then that line
     * removed. Nothing moved when it was added, so nothing moves back.
     */
    it("moves nothing when the only line of an incomplete set is removed", async () => {
      const transaction = { ...mockTransaction, isSplit: false } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        amount: -30,
      });
      mockQueryRunner.manager.find.mockResolvedValue([]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        expect.objectContaining({ amount: expect.anything() }),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    /**
     * `addSplit` flags the parent a split only at the second line, so a first
     * line equal to the whole parent "covers" it by sum alone. Nothing moved
     * when it was added, so its removal moves nothing back either.
     */
    it("moves nothing when the first addSplit line, equal to the parent, is removed", async () => {
      const transaction = { ...mockTransaction, isSplit: false } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        amount: -100,
      });
      mockQueryRunner.manager.find.mockResolvedValue([]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        expect.objectContaining({ amount: expect.anything() }),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("re-totals the parent to zero when its single pass-through line is removed", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 100,
        }),
      );
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        categoryId: null,
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -100,
      });
      mockQueryRunner.manager.find.mockResolvedValue([]);

      await service.removeSplit(transaction, "split-1", "user-1");

      // The leg goes, as asked, and the 100.00 that left with it comes back.
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -100,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        100,
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { amount: 0 },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: false },
      );
    });

    /**
     * An embedded investment row carries no cash transaction of its own
     * (`transactionId: null`): the parent is its cash side, so the re-total is
     * the only movement of the cash account, once.
     */
    it("re-totals the parent once when an investment line is removed", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const investmentTransaction = {
        id: "inv-1",
        accountId: "brokerage-1",
        transactionId: null,
      };
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        kind: SplitKind.INVESTMENT,
        categoryId: null,
        investmentTransaction,
      });
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit2 },
        { id: "split-3", transactionId: "tx-1", amount: 0 },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(
        (service as any).investmentTransactionsService.reverseAndRemoveEmbedded,
      ).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        "user-1",
        investmentTransaction,
        expect.anything(),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        60,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "brokerage-1",
        "user-1",
      );
    });

    it("refuses to make the parent a transfer whose leg is gone", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      // Only the parent is locked: the remaining line's leg is not there.
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({ ...mockSplit });
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          ...mockSplit2,
          linkedTransactionId: "linked-tx-2",
          transferAccountId: "account-3",
          categoryId: null,
        },
      ]);

      await expect(
        service.removeSplit(transaction, "split-1", "user-1"),
      ).rejects.toThrow(ConflictException);
      expect(netWorthService.triggerDebouncedRecalc).not.toHaveBeenCalled();
    });

    it("sets isSplit false when no splits remain", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);
      splitsRepository.find.mockResolvedValue([]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
      });
    });

    it("handles linked transaction not found gracefully for transfer split removal", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };

      splitsRepository.findOne.mockResolvedValue(transferSplit);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-2",
          transactionId: "tx-1",
          amount: -50,
          categoryId: "cat-1",
        },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -25,
          categoryId: "cat-2",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
        "account-2",
        expect.anything(),
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        transferSplit,
      );
    });

    /**
     * The FV4-002 double reversal, from the losing side.
     *
     * Two `removeSplit` calls for the same transfer split: both lock the leg and
     * read the same amount, one `DELETE` removes the row and the other removes
     * nothing. Before the fix each reversed the amount, so one deleted
     * counterpart moved the target account's balance twice and the ledger and
     * `current_balance` were permanently apart.
     */
    it("reverses nothing when another request already removed the leg", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
        }),
      );
      splitsRepository.findOne.mockResolvedValue(transferSplit);
      mockQueryRunner.manager.find.mockResolvedValue([
        { id: "split-2", transactionId: "tx-1", amount: -30 },
        { id: "split-3", transactionId: "tx-1", amount: -20 },
      ]);
      // The row was already gone when this call's DELETE landed.
      mockQueryRunner.manager.delete.mockImplementation(
        (Entity: any, criteria: any) => {
          if (Entity === Transaction && criteria?.id === "linked-tx-1") {
            return Promise.resolve({ affected: 0, raw: [] });
          }
          return Promise.resolve({ affected: 1, raw: [] });
        },
      );

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-1",
        userId: "user-1",
      });
      expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
        "account-2",
        expect.anything(),
      );
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("reverses a future-dated leg by recomputation, not by a delta", async () => {
      mockedIsTransactionInFuture.mockReturnValue(true);
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
          transactionDate: "2027-06-15",
        }),
      );
      splitsRepository.findOne.mockResolvedValue(transferSplit);
      mockQueryRunner.manager.find.mockResolvedValue([
        { id: "split-2", transactionId: "tx-1", amount: -30 },
        { id: "split-3", transactionId: "tx-1", amount: -20 },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "user-1",
        "account-2",
      );
    });

    it("reverses nothing for a VOID leg, which contributed nothing", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };
      lockParent(
        transaction,
        lockedTransactionRow({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
          status: "VOID",
        }),
      );
      splitsRepository.findOne.mockResolvedValue(transferSplit);
      mockQueryRunner.manager.find.mockResolvedValue([
        { id: "split-2", transactionId: "tx-1", amount: -30 },
        { id: "split-3", transactionId: "tx-1", amount: -20 },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-tx-1",
        userId: "user-1",
      });
      expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
        "account-2",
        expect.anything(),
      );
    });

    /**
     * The split is re-read inside the write transaction, not taken from a read
     * the caller did earlier: a `removeSplit` that arrives after a full
     * replacement has committed must not delete a split id that no longer
     * exists, nor reverse a counterpart the replacement already reversed.
     */
    it("re-reads the split inside the transaction, after the parent lock", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.removeSplit(transaction, "split-1", "user-1"),
      ).rejects.toThrow(NotFoundException);

      expect(
        (lockTransactionRow as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(splitsRepository.findOne.mock.invocationCallOrder[0]);
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses when the parent is gone, before touching any split", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      stubLocks([]);

      await expect(
        service.removeSplit(transaction, "split-1", "user-1"),
      ).rejects.toThrow(NotFoundException);

      expect(splitsRepository.findOne).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
    /**
     * Issue #2039: the removed line's leg is deleted and a collapse's kept leg
     * is relinked, so each is a write in another account and a reconciled one
     * is refused under the strict lock, before the first write.
     */
    describe("a reconciled leg under the strict lock", () => {
      beforeEach(() => {
        userPreferencesRepository.findOne.mockResolvedValue({
          userId: "user-1",
          lockReconciledTransactions: true,
        });
      });

      function expectNothingWritten(): void {
        expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.query).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      }

      it("refuses to remove a transfer line whose leg is reconciled", async () => {
        const transaction = { ...mockTransaction } as Transaction;
        lockParent(
          transaction,
          lockedTransactionRow({
            id: "linked-tx-1",
            accountId: "account-2",
            amount: 40,
            status: TransactionStatus.RECONCILED,
          }),
        );
        splitsRepository.findOne.mockResolvedValue({
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
          amount: -40,
        });
        mockQueryRunner.manager.find.mockResolvedValue([
          { id: "split-2", transactionId: "tx-1", amount: -30 },
          { id: "split-3", transactionId: "tx-1", amount: -30 },
        ]);

        await expect(
          service.removeSplit(transaction, "split-1", "user-1"),
        ).rejects.toThrow(/reconciled/i);

        expectNothingWritten();
      });

      it("refuses to collapse the parent into a transfer line whose leg is reconciled", async () => {
        const transaction = { ...mockTransaction } as Transaction;
        lockParent(
          transaction,
          lockedTransactionRow({
            id: "linked-tx-2",
            accountId: "account-3",
            amount: 40,
            status: TransactionStatus.RECONCILED,
          }),
        );
        splitsRepository.findOne.mockResolvedValue({
          ...mockSplit,
          linkedTransactionId: null,
          transferAccountId: null,
        });
        mockQueryRunner.manager.find.mockResolvedValue([
          {
            id: "split-2",
            transactionId: "tx-1",
            categoryId: null,
            linkedTransactionId: "linked-tx-2",
            transferAccountId: "account-3",
            amount: -40,
          },
        ]);

        await expect(
          service.removeSplit(transaction, "split-1", "user-1"),
        ).rejects.toThrow(/reconciled/i);

        expect(lockTransactionRows).toHaveBeenCalledWith(
          expect.anything(),
          ["linked-tx-2"],
          "user-1",
        );
        expectNothingWritten();
      });
    });

    /**
     * Issue #2039: the parent becomes its last line, so the line's tags join
     * the parent's and its memo fills a blank description, before the line's
     * row is removed and takes them with it.
     */
    it("carries the last line's tags and memo onto the parent when it collapses", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      });
      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        categoryId: "cat-2",
        linkedTransactionId: null,
        transferAccountId: null,
        amount: -40,
        memo: "  Drinks  ",
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-1", "user-1");

      const query = mockQueryRunner.manager.query as jest.Mock;
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "split-2", "user-1"],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(
          /UPDATE transactions SET description[\s\S]*COALESCE\(TRIM\(description\), ''\) = ''/,
        ),
        ["tx-1", "user-1", "Drinks"],
      );
      const lineRemoved = (
        mockQueryRunner.manager.remove as jest.Mock
      ).mock.calls.findIndex(([row]) => row === lastSplit);
      expect(lineRemoved).toBeGreaterThanOrEqual(0);
      expect(Math.max(...query.mock.invocationCallOrder)).toBeLessThan(
        (mockQueryRunner.manager.remove as jest.Mock).mock.invocationCallOrder[
          lineRemoved
        ],
      );
    });

    it("carries the tags but writes no description for a last line without a memo", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      });
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-2",
          transactionId: "tx-1",
          categoryId: "cat-2",
          amount: -40,
          memo: "   ",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      const query = mockQueryRunner.manager.query as jest.Mock;
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "split-2", "user-1"],
      );
    });

    it("carries nothing when two lines remain", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.findOne.mockResolvedValue({
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      });
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit2, amount: -25 },
        { id: "split-3", transactionId: "tx-1", amount: -15, memo: "Tip" },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.query).not.toHaveBeenCalled();
    });
  });

  /**
   * A split's transfer counterpart and its embedded investment rows *describe*
   * the parent -- its account, its date, its payee. Building them from the
   * caller's pre-lock snapshot writes rows describing a parent that has since
   * moved, silently: no error, and nothing to reconcile against (FV4-002).
   */
  describe("counterpart rows are built from the locked parent", () => {
    it("addSplit uses the committed account, date and payee, not the caller's", async () => {
      const stale = {
        ...mockTransaction,
        accountId: "account-stale",
        transactionDate: "2026-01-15",
        payeeName: "Stale Payee",
        payeeId: "payee-stale",
        isSplit: true,
      } as Transaction;
      // What another request committed while this one waited for the row lock.
      stubLocks([
        lockedTransactionRow({
          id: "tx-1",
          accountId: "account-committed",
          amount: -100,
          transactionDate: "2026-03-20",
          isSplit: true,
          payeeId: "payee-committed",
          payeeName: "Committed Payee",
        }),
      ]);
      mockQueryRunner.manager.find.mockResolvedValue([]);
      splitsRepository.find.mockResolvedValue([]);
      splitsRepository.findOne.mockResolvedValue({ id: "new-split" });

      await service.addSplit(
        stale,
        { amount: -40, transferAccountId: "account-2" },
        "user-1",
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-committed",
      );
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionDate: "2026-03-20",
          payeeId: "payee-committed",
          payeeName: "Committed Payee",
        }),
      );
    });

    it("updateSplits builds the replacement from the committed parent", async () => {
      const stale = {
        ...mockTransaction,
        accountId: "account-stale",
        transactionDate: "2026-01-15",
        payeeName: "Stale Payee",
        payeeId: "payee-stale",
        status: TransactionStatus.UNRECONCILED,
      } as Transaction;
      stubLocks([
        lockedTransactionRow({
          id: "tx-1",
          accountId: "account-committed",
          amount: -100,
          transactionDate: "2026-03-20",
          isSplit: true,
          payeeId: "payee-committed",
          payeeName: "Committed Payee",
          // Voided after the caller read it (A26-M09).
          status: TransactionStatus.VOID,
        }),
      ]);
      splitsRepository.find.mockResolvedValue([]);
      const createSplits = jest.spyOn(service, "createSplits");

      await service.updateSplits(
        stale,
        [
          { amount: -60, transferAccountId: "account-2" },
          { amount: -40, categoryId: "cat-1" },
        ],
        "user-1",
      );

      expect(createSplits).toHaveBeenCalledWith(
        "tx-1",
        expect.anything(),
        "user-1",
        "account-committed",
        new Date("2026-03-20"),
        "Committed Payee",
        "payee-committed",
        // The merged call also passes the parent's status option and the
        // touched-accounts set for the post-commit net-worth fan-out. The status
        // is the committed row's VOID, not the caller's UNRECONCILED (A26-M09);
        // the set is incidental to what this test pins down. `carriedSeries` is
        // the parent's embedded rows, read before the rebuild (none here).
        {
          parentStatus: TransactionStatus.VOID,
          carriedSeries: [],
          touchedSecurityIds: expect.any(Set),
        },
        expect.any(Set),
      );
    });
  });

  describe("future-dated transactions", () => {
    describe("createSplits", () => {
      it("does NOT call updateBalance on the transfer account for future-dated transactions", async () => {
        mockedIsTransactionInFuture.mockReturnValue(true);

        accountsService.findOne
          .mockResolvedValueOnce({
            id: "account-2",
            name: "Savings",
            currencyCode: "USD",
          })
          .mockResolvedValueOnce({
            id: "account-1",
            name: "Checking",
            currencyCode: "USD",
          });

        transactionsRepository.save.mockResolvedValueOnce({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
        });

        splitsRepository.save.mockResolvedValueOnce({
          id: "split-new",
          transactionId: "tx-1",
          transferAccountId: "account-2",
          amount: -50,
        });

        const splits = [
          {
            amount: -50,
            transferAccountId: "account-2",
            memo: "Transfer part",
          },
        ];

        await service.createSplits(
          "tx-1",
          splits,
          "user-1",
          "account-1",
          new Date("2027-06-15"),
          "Store",
        );

        expect(transactionsRepository.create).toHaveBeenCalled();
        expect(transactionsRepository.save).toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });

    describe("deleteSplitSideEffects transfer legs", () => {
      it("does NOT call updateBalance when deleting linked transactions with future dates", async () => {
        mockedIsTransactionInFuture.mockReturnValue(true);

        const transferSplit = {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
        };

        splitsRepository.find.mockResolvedValue([transferSplit]);
        stubLocks([
          lockedTransactionRow({
            id: "linked-tx-1",
            accountId: "account-2",
            amount: 50,
            transactionDate: "2027-06-15",
          }),
        ]);

        await service.deleteSplitSideEffects("tx-1", "user-1");

        expect(lockTransactionRows).toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "user-1",
          "account-2",
        );
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "linked-tx-1", userId: "user-1" },
        );
      });

      it("calls updateBalance for past-dated linked transactions but not future-dated ones", async () => {
        mockedIsTransactionInFuture
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true);

        const splits = [
          {
            id: "split-1",
            transactionId: "tx-1",
            linkedTransactionId: "linked-tx-1",
            transferAccountId: "account-2",
          },
          {
            id: "split-2",
            transactionId: "tx-1",
            linkedTransactionId: "linked-tx-2",
            transferAccountId: "account-3",
          },
        ];

        splitsRepository.find.mockResolvedValue(splits);
        stubLocks([
          lockedTransactionRow({
            id: "linked-tx-1",
            accountId: "account-2",
            amount: 30,
            transactionDate: "2026-01-15",
          }),
          lockedTransactionRow({
            id: "linked-tx-2",
            accountId: "account-3",
            amount: 70,
            transactionDate: "2027-06-15",
          }),
        ]);

        await service.deleteSplitSideEffects("tx-1", "user-1");

        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-2",
          -30,
        );
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "user-1",
          "account-3",
        );
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("createSplits atomicity", () => {
    it("runs all its writes inside one tenant transaction", async () => {
      const splits = [
        { amount: -60, categoryId: "cat-1", memo: "Food" },
        { amount: -40, categoryId: "cat-2", memo: "Drinks" },
      ];

      await service.createSplits("tx-1", splits, "user-1", "account-1");

      // A single withScopedDb wraps the category check and both split writes;
      // callers already inside one join it via re-entrancy rather than
      // opening a second connection.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
    });

    it("propagates write failures so the tenant transaction rolls back", async () => {
      splitsRepository.save.mockRejectedValue(new Error("Split save error"));

      const splits = [{ amount: -60, categoryId: "cat-1", memo: "Food" }];

      await expect(
        service.createSplits("tx-1", splits, "user-1", "account-1"),
      ).rejects.toThrow("Split save error");

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("investment splits", () => {
    it("validates that the cash impact matches the split amount for BUY", () => {
      // 75 shares @ $10 = $750 cash out (negative)
      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];
      expect(() => service.validateSplits(splits, 0)).not.toThrow();
    });

    it("rejects when investment split amount does not match computed cash impact", () => {
      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -700, // Wrong: should be -750
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
            // A stated rate makes this a payload-consistency check: the caller
            // says 1:1, so the cash impact and the split amount must agree.
            exchangeRate: 1,
          },
        },
      ];
      expect(() => service.validateSplits(splits, 50)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, 50)).toThrow(
        /does not match the cash impact/,
      );
    });

    // With no rate stated, this check has nothing to compare against: the
    // security's currency is not loaded yet, so it cannot know whether a
    // conversion applies. It used to assume 1, which demanded the UNCONVERTED
    // cash impact -- rejecting the correct amount for a USD security in a CAD
    // account and accepting the wrong one. The real check now happens where the
    // rate is resolved (`createEmbeddedForSplit`).
    it("defers the amount check when no exchange rate is stated", () => {
      const splits = [
        {
          amount: -1012.5, // 75 x 10 USD converted at 1.35
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -1012.5)).not.toThrow();
    });

    it("rejects investment splits that combine with categoryId", () => {
      const splits = [
        { amount: -50, categoryId: "cat-1" },
        {
          amount: -50,
          categoryId: "cat-2",
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 5,
            price: 10,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
    });

    it("rejects disallowed actions inside a split", () => {
      const splits = [
        { amount: -100, categoryId: "cat-1" },
        {
          amount: 0,
          investment: {
            action: "ADD_SHARES" as any,
            securityId: "sec-1",
            quantity: 5,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        /not allowed inside a split transaction/,
      );
    });

    it("requires the parent account to be INVESTMENT_CASH", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "CHECKING",
        linkedAccountId: null,
      });

      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
          },
        },
      ];

      await expect(
        service.createSplits(
          "tx-1",
          splits,
          "user-1",
          "account-1",
          new Date("2026-05-09"),
        ),
      ).rejects.toThrow(/INVESTMENT_CASH/);
    });

    it("creates investment split via embedded path on INVESTMENT_CASH parent", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brokerage-1",
      });

      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];

      const result = await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-05-09"),
      );

      // Two regular splits + one investment split
      expect(result).toHaveLength(3);
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        TransactionSplit,
        expect.objectContaining({
          kind: "investment",
          categoryId: null,
          transferAccountId: null,
          amount: -750,
        }),
      );
    });

    it("rejects investment split when payload is missing", () => {
      const splits = [
        { amount: -100, categoryId: "cat-1" },
        {
          amount: 0,
          splitKind: "investment" as any,
          // no `investment` payload provided
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        /requires an investment payload/,
      );
    });

    it("rejects investment split combined with transferAccountId", () => {
      const splits = [
        { amount: -50, categoryId: "cat-1" },
        {
          amount: -50,
          transferAccountId: "account-2",
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 5,
            price: 10,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
    });

    it("validates with exchangeRate when security currency differs", () => {
      // 75 shares @ $10 USD = $750 USD; with rate 1.35 -> $1012.50 in parent currency
      const splits = [
        { amount: 1350, categoryId: "cat-1" },
        { amount: -337.5, categoryId: "cat-2" },
        {
          amount: -1012.5,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
            exchangeRate: 1.35,
          },
        },
      ];
      expect(() => service.validateSplits(splits, 0)).not.toThrow();
    });

    it("accepts a single investment split as a passthrough", () => {
      const splits = [
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -750)).not.toThrow();
    });

    it("rejects investment splits when userId or sourceAccountId is missing", async () => {
      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
          },
        },
      ];

      await expect(
        service.createSplits("tx-1", splits, undefined, "account-1"),
      ).rejects.toThrow(/known source account/);
    });

    it("rejects when INVESTMENT_CASH parent has no linkedAccountId", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: null,
      });

      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
          },
        },
      ];

      await expect(
        service.createSplits(
          "tx-1",
          splits,
          "user-1",
          "account-1",
          new Date("2026-05-09"),
        ),
      ).rejects.toThrow(/not linked to a brokerage account/);
    });

    it("rejects adding an investment split via addSplit", async () => {
      const transaction = { ...mockTransaction, isSplit: true } as Transaction;
      lockParent(transaction);
      await expect(
        service.addSplit(
          transaction,
          {
            amount: -750,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 75,
              price: 10,
            },
          } as any,
          "user-1",
        ),
      ).rejects.toThrow(/cannot be added incrementally/);
    });

    it("removeSplit reverses holdings via reverseAndRemoveEmbedded for an investment split", async () => {
      const investmentTx = { id: "inv-1", action: "BUY" };
      splitsRepository.findOne.mockResolvedValue({
        id: "split-3",
        transactionId: "tx-1",
        kind: "investment",
        investmentTransaction: investmentTx,
      });
      const remaining = [
        { id: "split-1", kind: "category", categoryId: "cat-1" },
        { id: "split-2", kind: "category", categoryId: "cat-2" },
      ];
      mockQueryRunner.manager.find = jest.fn().mockResolvedValue(remaining);

      const investmentService = (service as any).investmentTransactionsService;

      await service.removeSplit(
        { ...mockTransaction } as Transaction,
        "split-3",
        "user-1",
      );

      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        "user-1",
        investmentTx,
        { touchedSecurityIds: expect.any(Set) },
      );
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("removeSplit keeps isSplit=true when the last remaining split is investment", async () => {
      splitsRepository.findOne.mockResolvedValue({
        id: "split-1",
        transactionId: "tx-1",
        kind: "category",
        categoryId: "cat-1",
      });
      // After removing the category split, an investment split remains alone
      mockQueryRunner.manager.find = jest.fn().mockResolvedValue([
        {
          id: "split-2",
          kind: "investment",
          investmentTransaction: { id: "inv-1" },
        },
      ]);

      await service.removeSplit(
        { ...mockTransaction } as Transaction,
        "split-1",
        "user-1",
      );

      // The collapse path should be skipped: no Transaction update to isSplit=false
      const updateCalls = (mockQueryRunner.manager.update as jest.Mock).mock
        .calls;
      const setIsSplitFalse = updateCalls.find(
        ([entity, _id, data]: any[]) =>
          entity === Transaction && data?.isSplit === false,
      );
      expect(setIsSplitFalse).toBeUndefined();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("deleteSplitSideEffects reverses each investment split", async () => {
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-1",
          kind: "investment",
          investmentTransaction: { id: "inv-a" },
        },
        {
          id: "split-2",
          kind: "investment",
          investmentTransaction: { id: "inv-b" },
        },
        // Without an investmentTransaction relation - skipped
        {
          id: "split-3",
          kind: "investment",
          investmentTransaction: null,
        },
      ]);
      transactionsRepository.find.mockResolvedValue([]);

      const investmentService = (service as any).investmentTransactionsService;
      investmentService.reverseAndRemoveEmbedded.mockClear();

      await service.deleteSplitSideEffects("tx-1", "user-1");

      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledTimes(
        2,
      );
      // The reversal now receives the withScopedDb EntityManager, not a QueryRunner.
      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        "user-1",
        { id: "inv-a" },
        expect.objectContaining({ bondGuard: expect.any(Object) }),
      );
      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        "user-1",
        { id: "inv-b" },
        expect.objectContaining({ bondGuard: expect.any(Object) }),
      );
    });

    it("supports multiple investment splits in one createSplits call", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brokerage-1",
      });

      const splits = [
        { amount: 5000, categoryId: "cat-1" },
        {
          amount: -3000,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 30,
            price: 100,
            commission: 0,
          },
        },
        {
          amount: -2000,
          investment: {
            action: "BUY" as any,
            securityId: "sec-2",
            quantity: 20,
            price: 100,
            commission: 0,
          },
        },
      ];

      const result = await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-05-09"),
      );
      expect(result).toHaveLength(3);

      const investmentService = (service as any).investmentTransactionsService;
      expect(investmentService.createEmbeddedForSplit).toHaveBeenCalledTimes(2);
    });
  });

  describe("the bond price recompute after a split write (INV-BOND-005, INV-CACHE-001)", () => {
    const investmentService = () =>
      (service as any).investmentTransactionsService;
    const embeddedSplit = (id: string, securityId: string) => ({
      id: `split-${id}`,
      kind: "investment",
      investmentTransaction: { id: `inv-${id}`, securityId, accountId: "b-1" },
    });

    it("createSplits collects the security of each embedded row it creates", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brokerage-1",
      });
      investmentService().createEmbeddedForSplit.mockResolvedValueOnce({
        securityId: "sec-1",
      });
      const touchedSecurityIds = new Set<string>();
      await service.createSplits(
        "tx-1",
        [
          {
            amount: -3000,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 30,
              price: 100,
              commission: 0,
            },
          },
        ] as any,
        "user-1",
        "account-1",
        new Date("2026-05-09"),
        undefined,
        undefined,
        { touchedSecurityIds },
      );
      expect([...touchedSecurityIds]).toEqual(["sec-1"]);
    });

    it("deleteSplitSideEffects tracks every embedded security once, removes each row under ONE guard and verifies after the last (a parent holding the BUY and the SELL it covers is not refused half way)", async () => {
      splitsRepository.find.mockResolvedValue([
        embeddedSplit("a", "sec-1"),
        embeddedSplit("b", "sec-1"),
      ]);
      transactionsRepository.find.mockResolvedValue([]);
      investmentService().reverseAndRemoveEmbedded.mockClear();
      const touchedSecurityIds = new Set<string>();

      await service.deleteSplitSideEffects("tx-1", "user-1", {
        touchedSecurityIds,
      });

      const calls = investmentService().reverseAndRemoveEmbedded.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][3].bondGuard).toBeDefined();
      expect(calls[1][3].bondGuard).toBe(calls[0][3].bondGuard);
      expect(calls[0][3].touchedSecurityIds).toBe(touchedSecurityIds);
    });

    it("updateSplits dispatches the recompute for the torn-down and recreated securities AFTER the transaction", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.find.mockResolvedValue([]);
      investmentService().recomputeBondPricesAfterSplitWrite.mockClear();
      investmentService().reverseAndRemoveEmbedded.mockImplementation(
        async (_m: unknown, _u: unknown, _row: unknown, options: any) => {
          options.touchedSecurityIds.add("sec-old");
        },
      );
      splitsRepository.find.mockResolvedValue([embeddedSplit("a", "sec-old")]);

      await service.updateSplits(
        transaction,
        [
          { amount: -70, categoryId: "cat-1" },
          { amount: -30, categoryId: "cat-2" },
        ],
        "user-1",
      );

      expect(
        investmentService().recomputeBondPricesAfterSplitWrite,
      ).toHaveBeenCalledWith("user-1", ["sec-old"]);
      const finalUpdate = mockQueryRunner.manager.update.mock.calls.findIndex(
        ([entity, , data]: any[]) =>
          entity === Transaction && data?.isSplit === true,
      );
      expect(
        mockQueryRunner.manager.update.mock.invocationCallOrder[finalUpdate],
      ).toBeLessThan(
        investmentService().recomputeBondPricesAfterSplitWrite.mock
          .invocationCallOrder[0],
      );
      investmentService().reverseAndRemoveEmbedded.mockResolvedValue(undefined);
    });

    it("updateSplits dispatches nothing when no embedded row was involved", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.find.mockResolvedValue([]);
      investmentService().recomputeBondPricesAfterSplitWrite.mockClear();
      await service.updateSplits(
        transaction,
        [
          { amount: -70, categoryId: "cat-1" },
          { amount: -30, categoryId: "cat-2" },
        ],
        "user-1",
      );
      expect(
        investmentService().recomputeBondPricesAfterSplitWrite,
      ).not.toHaveBeenCalled();
    });

    it("removeSplit dispatches the recompute of the removed embedded row's security after the commit", async () => {
      splitsRepository.findOne.mockResolvedValue({
        id: "split-3",
        transactionId: "tx-1",
        kind: "investment",
        investmentTransaction: { id: "inv-1", securityId: "sec-9" },
      });
      mockQueryRunner.manager.find = jest.fn().mockResolvedValue([
        { id: "split-1", kind: "category", categoryId: "cat-1" },
        { id: "split-2", kind: "category", categoryId: "cat-2" },
      ]);
      investmentService().recomputeBondPricesAfterSplitWrite.mockClear();
      investmentService().reverseAndRemoveEmbedded.mockImplementationOnce(
        async (_m: unknown, _u: unknown, _row: unknown, options: any) => {
          options.touchedSecurityIds.add("sec-9");
        },
      );

      await service.removeSplit(
        { ...mockTransaction } as Transaction,
        "split-3",
        "user-1",
      );

      expect(
        investmentService().recomputeBondPricesAfterSplitWrite,
      ).toHaveBeenCalledWith("user-1", ["sec-9"]);
    });

    it("applyParentStatusToTransferCounterparts hands the collector to the embedded rows' status pass", async () => {
      splitsRepository.find.mockResolvedValue([]);
      const touchedSecurityIds = new Set<string>();
      await service.applyParentStatusToTransferCounterparts(
        mockQueryRunner.manager as any,
        "tx-1",
        "user-1",
        TransactionStatus.VOID,
        touchedSecurityIds,
      );
      expect(
        investmentService().applyParentStatusToEmbeddedRows,
      ).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        "user-1",
        "tx-1",
        TransactionStatus.VOID,
        touchedSecurityIds,
      );
    });
  });

  describe("the bond series of recreated embedded rows (INV-BOND-007)", () => {
    const investment = (quantity: number, securityId = "sec-1") => ({
      action: "BUY" as any,
      securityId,
      quantity,
      price: 100,
      commission: 0,
    });

    it("reads the parent's embedded rows before they are torn down and hands them to createSplits", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      lockParent(transaction);
      splitsRepository.find.mockResolvedValue([]);
      mockQueryRunner.manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          typeof sql === "string" &&
            sql.includes(
              "JOIN transaction_splits ts ON ts.id = it.transaction_split_id",
            )
            ? [
                {
                  security_id: "sec-1",
                  action: "BUY",
                  quantity: "30.00000000",
                  tx_date: "2026-03-20",
                  bond_instrument_id: null,
                },
              ]
            : [],
        ),
      );
      const createSplits = jest.spyOn(service, "createSplits");
      const deleteSideEffects = jest.spyOn(service, "deleteSplitSideEffects");

      await service.updateSplits(
        transaction,
        [
          { amount: -60, categoryId: "cat-1" },
          { amount: -40, categoryId: "cat-2" },
        ],
        "user-1",
      );

      expect(createSplits.mock.calls[0][7]).toEqual({
        parentStatus: TransactionStatus.UNRECONCILED,
        carriedSeries: [
          {
            securityId: "sec-1",
            action: "BUY",
            quantity: 30,
            transactionDate: "2026-03-20",
            bondInstrumentId: null,
          },
        ],
        touchedSecurityIds: expect.any(Set),
      });
      const readOrder = mockQueryRunner.manager.query.mock.calls.findIndex(
        ([sql]: [string]) => String(sql).includes("it.transaction_split_id"),
      );
      expect(readOrder).toBeGreaterThanOrEqual(0);
      expect(
        mockQueryRunner.manager.query.mock.invocationCallOrder[readOrder],
      ).toBeLessThan(deleteSideEffects.mock.invocationCallOrder[0]);
    });

    it("gives each recreated row the series of the row it replaces: same security, action, quantity and date, each predecessor once, NULL included", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brokerage-1",
      });
      const carriedSeries = [
        {
          securityId: "sec-1",
          action: "BUY",
          quantity: 30,
          transactionDate: "2026-05-09",
          bondInstrumentId: "series-A",
        },
        {
          securityId: "sec-1",
          action: "BUY",
          quantity: 30,
          transactionDate: "2026-05-09",
          bondInstrumentId: null,
        },
        {
          // Another date: not the same split.
          securityId: "sec-2",
          action: "BUY",
          quantity: 20,
          transactionDate: "2026-01-01",
          bondInstrumentId: "series-B",
        },
      ];

      await service.createSplits(
        "tx-1",
        [
          { amount: -3000, investment: investment(30) },
          { amount: -3000, investment: investment(30) },
          { amount: -2000, investment: investment(20, "sec-2") },
          { amount: -3000, investment: investment(30) },
        ],
        "user-1",
        "account-1",
        new Date("2026-05-09"),
        undefined,
        undefined,
        { carriedSeries },
      );

      const investmentService = (service as any).investmentTransactionsService;
      const handed = investmentService.createEmbeddedForSplit.mock.calls.map(
        (call: unknown[]) => call[9],
      );
      expect(handed).toEqual([
        expect.objectContaining({ bondInstrumentId: "series-A" }),
        expect.objectContaining({ bondInstrumentId: null }),
        null,
        null,
      ]);
    });
  });

  describe("bulkRecategorizeCategorySplits", () => {
    const selectRows = [
      { id: "split-1", transaction_id: "tx-1", category_id: "cat-old" },
      { id: "split-2", transaction_id: "tx-1", category_id: null },
    ];

    /** Route manager.query by SQL: the FOR UPDATE pre-read returns `rows`. */
    function stageSplitRows(rows: unknown[]): void {
      mockQueryRunner.manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          typeof sql === "string" && sql.includes("FOR UPDATE OF s")
            ? rows
            : [],
        ),
      );
    }

    function findSelectCall(): any[] | undefined {
      return mockQueryRunner.manager.query.mock.calls.find((call: any[]) =>
        String(call[0]).includes("FOR UPDATE OF s"),
      );
    }

    it("recategorizes the proven lines and returns each line's previous category", async () => {
      stageSplitRows(selectRows);

      const result = await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
      );

      // The pre-read's category_id comes back per line, null included -- the
      // caller records it as the undo snapshot.
      expect(result).toEqual([
        {
          splitId: "split-1",
          transactionId: "tx-1",
          previousCategoryId: "cat-old",
        },
        { splitId: "split-2", transactionId: "tx-1", previousCategoryId: null },
      ]);

      // One UPDATE over exactly the ids the locked pre-read proved.
      const updateCall = mockQueryRunner.manager.query.mock.calls.find(
        (call: any[]) => String(call[0]).includes("UPDATE transaction_splits"),
      );
      expect(updateCall).toBeDefined();
      expect(String(updateCall![0])).toContain(
        "SET category_id = $1 WHERE id = ANY($2)",
      );
      expect(updateCall![1]).toEqual(["cat-new", ["split-1", "split-2"]]);
    });

    it("scopes the pre-read to the user's transactions and category-kind lines only", async () => {
      stageSplitRows(selectRows);

      await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
      );

      const selectCall = findSelectCall();
      expect(selectCall).toBeDefined();
      const sql = String(selectCall![0]);
      // I3: transaction_splits has no user_id; the read joins back to
      // transactions on user_id, parameterized as $1.
      expect(sql).toContain("JOIN transactions t ON t.id = s.transaction_id");
      expect(sql).toContain("t.user_id = $1");
      // I2: only category-kind lines; transfer and investment lines are
      // never selected, so they can never be written.
      expect(sql).toContain("s.kind = 'category'");
      expect(selectCall![1]).toEqual(["user-1", ["tx-1"]]);
    });

    it("appends the category restriction as a third parameter when given", async () => {
      stageSplitRows([selectRows[0]]);

      await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
        ["cat-a", "cat-b"],
      );

      const selectCall = findSelectCall();
      expect(String(selectCall![0])).toContain("AND s.category_id = ANY($3)");
      expect(selectCall![1]).toEqual(["user-1", ["tx-1"], ["cat-a", "cat-b"]]);
    });

    it("emits no category restriction when unrestricted", async () => {
      stageSplitRows(selectRows);

      await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
      );

      const selectCall = findSelectCall();
      expect(String(selectCall![0])).not.toContain("s.category_id = ANY($3)");
      expect(selectCall![1]).toEqual(["user-1", ["tx-1"]]);
    });

    it("locks the parent rows before reading the split lines (I6)", async () => {
      stageSplitRows(selectRows);

      await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
      );

      // The same lock updateSplits/addSplit take, so split-set writers
      // serialize on the parent row.
      expect(lockTransactionRows).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        ["tx-1"],
        "user-1",
      );
      const lockOrder = (lockTransactionRows as jest.Mock).mock
        .invocationCallOrder[0];
      const firstQueryOrder =
        mockQueryRunner.manager.query.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(firstQueryOrder);
    });

    it("returns [] for empty parentIds without opening a transaction", async () => {
      const result = await service.bulkRecategorizeCategorySplits(
        "user-1",
        [],
        "cat-new",
      );

      expect(result).toEqual([]);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      expect(lockTransactionRows).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.query).not.toHaveBeenCalled();
    });

    it("returns [] for an explicitly empty restriction without opening a transaction", async () => {
      // An empty restriction set means "no line can match" -- distinct from
      // undefined ("all category lines"), and answered without touching the DB.
      const result = await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
        [],
      );

      expect(result).toEqual([]);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      expect(lockTransactionRows).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.query).not.toHaveBeenCalled();
    });

    it("issues no UPDATE when no lines match", async () => {
      stageSplitRows([]);

      const result = await service.bulkRecategorizeCategorySplits(
        "user-1",
        ["tx-1"],
        "cat-new",
        ["cat-nobody-uses"],
      );

      expect(result).toEqual([]);
      const updateCalls = mockQueryRunner.manager.query.mock.calls.filter(
        (call: any[]) => String(call[0]).includes("UPDATE transaction_splits"),
      );
      expect(updateCalls).toHaveLength(0);
    });
  });
});
