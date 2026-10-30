import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import { AccountsService } from "@/accounts/accounts.service";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

describe("TransactionsService (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const account = await createTestAccount(dataSource, userId, {
      openingBalance: 1000,
      currentBalance: 1000,
    });
    accountId = account.id;
  });

  describe("create()", () => {
    it("should create a transaction and update account balance atomically", async () => {
      const result = await withUserContext(userId, () =>
        service.create(userId, {
          accountId,
          transactionDate: "2026-01-15",
          amount: -50,
          currencyCode: "USD",
        }),
      );

      expect(result.id).toBeDefined();
      expect(Number(result.amount)).toBe(-50);
      expect(result.accountId).toBe(accountId);
      expect(result.status).toBe(TransactionStatus.UNRECONCILED);

      // Verify balance was updated atomically
      const account = await dataSource.manager.findOne(Account, {
        where: { id: accountId },
      });
      expect(account!.currentBalance).toBe(950);
    });

    it("should create a transaction with splits and store split records", async () => {
      const category1 = await createTestCategory(dataSource, userId, {
        name: "Groceries",
      });
      const category2 = await createTestCategory(dataSource, userId, {
        name: "Dining",
      });

      const result = await withUserContext(userId, () =>
        service.create(userId, {
          accountId,
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          isSplit: true,
          splits: [
            { categoryId: category1.id, amount: -60 },
            { categoryId: category2.id, amount: -40 },
          ],
        }),
      );

      expect(result.isSplit).toBe(true);
      expect(result.categoryId).toBeNull();
      expect(result.splits).toHaveLength(2);

      const splitAmounts = result.splits
        .map((s) => Number(s.amount))
        .sort((a, b) => a - b);
      expect(splitAmounts).toEqual([-60, -40]);

      // Verify balance updated
      const account = await dataSource.manager.findOne(Account, {
        where: { id: accountId },
      });
      expect(account!.currentBalance).toBe(900);
    });

    it("should NOT update balance when status is VOID", async () => {
      const result = await withUserContext(userId, () =>
        service.create(userId, {
          accountId,
          transactionDate: "2026-01-15",
          amount: -200,
          currencyCode: "USD",
          status: TransactionStatus.VOID,
        }),
      );

      expect(result.status).toBe(TransactionStatus.VOID);

      // Balance should remain unchanged
      const account = await dataSource.manager.findOne(Account, {
        where: { id: accountId },
      });
      expect(account!.currentBalance).toBe(1000);
    });
  });

  describe("update()", () => {
    it("should apply the correct balance delta when amount changes", async () => {
      const tx = await withUserContext(userId, () =>
        service.create(userId, {
          accountId,
          transactionDate: "2026-01-15",
          amount: -50,
          currencyCode: "USD",
        }),
      );

      // Balance is now 950
      const updated = await withUserContext(userId, () =>
        service.update(userId, tx.id, {
          amount: -80,
        }),
      );

      expect(Number(updated.amount)).toBe(-80);

      // Balance should be 1000 - 80 = 920
      const account = await dataSource.manager.findOne(Account, {
        where: { id: accountId },
      });
      expect(account!.currentBalance).toBe(920);
    });
  });

  describe("remove()", () => {
    it("should reverse the balance and delete the transaction", async () => {
      const tx = await withUserContext(userId, () =>
        service.create(userId, {
          accountId,
          transactionDate: "2026-01-15",
          amount: -75,
          currencyCode: "USD",
        }),
      );

      // Balance is now 925
      await withUserContext(userId, () => service.remove(userId, tx.id));

      // Balance should be restored to 1000
      const account = await dataSource.manager.findOne(Account, {
        where: { id: accountId },
      });
      expect(account!.currentBalance).toBe(1000);

      // Transaction should no longer exist
      await expect(
        withUserContext(userId, () => service.findOne(userId, tx.id)),
      ).rejects.toThrow("not found");
    });
  });

  describe("findAll() running-balance anchor", () => {
    /**
     * The register draws its balance column by walking down from the
     * `startingBalance` the backend returns for the page, skipping VOID rows
     * because they do not move a balance. The anchor for page 2 and beyond used
     * a plain `SUM(amount)` over the rows above the page, voids included, so
     * every earlier page was off by their total: a Money import carrying 31
     * voided cheques put an account's oldest row $73.22 out.
     *
     * Four transactions, two per page: page 2 holds the two oldest, and its
     * anchor must be the balance *before* them -- opening 1000, plus the two
     * newer rows, with the void contributing nothing.
     */
    it("excludes VOID rows from the page-2 anchor, as the balance does", async () => {
      const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
      for (const [index, transactionDate] of dates.entries()) {
        await withUserContext(userId, () =>
          service.create(userId, {
            accountId,
            transactionDate,
            amount: -10,
            currencyCode: "USD",
            // The newest row is voided: it sits above page 2 and must not
            // count toward what page 2 starts from.
            status:
              index === 3 ? TransactionStatus.VOID : TransactionStatus.CLEARED,
          }),
        );
      }

      const page2 = await withUserContext(userId, () =>
        service.findAll(
          userId,
          [accountId],
          undefined,
          undefined,
          undefined,
          undefined,
          2,
          2,
        ),
      );

      expect(page2.data.map((tx) => tx.transactionDate)).toEqual([
        "2026-01-02",
        "2026-01-01",
      ]);

      // Page 1 holds the void and Jan 3, so page 2 starts from the balance
      // after Jan 2: 1000 - 10 - 10 = 980. Counting the void as well -- the
      // defect -- made it 990.
      expect(page2.startingBalance).toBe(980);

      // What the user sees: the register walks down from that anchor, and the
      // oldest row lands on the opening balance plus its own amount.
      const oldestRowBalance = page2.startingBalance! - -10;
      expect(oldestRowBalance).toBe(990);
      expect(oldestRowBalance - -10).toBe(1000);
    });
  });

  describe("findOne()", () => {
    it("should load relations correctly", async () => {
      const category = await createTestCategory(dataSource, userId, {
        name: "Utilities",
      });

      const tx = await withUserContext(userId, () =>
        service.create(userId, {
          accountId,
          transactionDate: "2026-01-15",
          amount: -30,
          currencyCode: "USD",
          categoryId: category.id,
          description: "Electric bill",
        }),
      );

      const found = await withUserContext(userId, () =>
        service.findOne(userId, tx.id),
      );

      expect(found.account).toBeDefined();
      expect(found.account.id).toBe(accountId);
      expect(found.category).toBeDefined();
      expect(found.category!.id).toBe(category.id);
      expect(found.category!.name).toBe("Utilities");
      expect(found.description).toBe("Electric bill");
    });
  });
  describe("AccountsService.findAll() lastReconciledDate", () => {
    /**
     * The accounts list's Last Reconciled column: the statement date the
     * reconcile stamped, not the newest reconciled row's own date, and the
     * row's date for one reconciled without a stamp.
     */
    it("reports the statement date reconciled to, the row date without one, and null when never", async () => {
      const accounts = module.get(AccountsService);
      const stamped = await createTestAccount(dataSource, userId, {
        name: "Stamped",
        openingBalance: 0,
        currentBalance: 0,
      });
      const never = await createTestAccount(dataSource, userId, {
        name: "Never",
        openingBalance: 0,
        currentBalance: 0,
      });

      await withUserContext(userId, async () => {
        const onStatement = await service.create(userId, {
          accountId: stamped.id,
          transactionDate: "2026-09-10",
          amount: -25,
          currencyCode: "USD",
        });
        await service.bulkReconcile(
          userId,
          stamped.id,
          [onStatement.id],
          "2026-09-15",
        );
        // Imported already reconciled, with no statement date of its own.
        await service.create(userId, {
          accountId,
          transactionDate: "2026-08-01",
          amount: -10,
          currencyCode: "USD",
          status: TransactionStatus.RECONCILED,
        });
        await service.create(userId, {
          accountId: never.id,
          transactionDate: "2026-09-01",
          amount: -5,
          currencyCode: "USD",
          status: TransactionStatus.CLEARED,
        });
      });

      const list = await withUserContext(userId, () =>
        accounts.findAll(userId),
      );
      const byId = new Map(list.map((a) => [a.id, a.lastReconciledDate]));
      expect(byId.get(stamped.id)).toBe("2026-09-15");
      expect(byId.get(accountId)).toBe("2026-08-01");
      expect(byId.get(never.id)).toBeNull();
    });
  });
  describe("stale reconciliation after a row dated past its statement", () => {
    /**
     * The reconcile screen lists rows dated after the statement date, so one
     * can be reconciled on an earlier statement. The account counts as
     * reconciled through that statement date, not through the row's own
     * later date: an outstanding row between the two belongs to the next
     * statement and is not "missed". Dated in 2020 so the outstanding row is
     * past the overdue window whatever day the suite runs.
     */
    it("measures missed rows from the statement date, not the late row's own date", async () => {
      await withUserContext(userId, async () => {
        const onStatement = await service.create(userId, {
          accountId,
          transactionDate: "2020-09-10",
          amount: -25,
          currencyCode: "USD",
        });
        const pastStatement = await service.create(userId, {
          accountId,
          transactionDate: "2020-09-20",
          amount: -15,
          currencyCode: "USD",
        });
        await service.bulkReconcile(
          userId,
          accountId,
          [onStatement.id, pastStatement.id],
          "2020-09-15",
        );
        // Outstanding, dated between the statement and the late row.
        await service.create(userId, {
          accountId,
          transactionDate: "2020-09-17",
          amount: -5,
          currencyCode: "USD",
        });
      });

      const data = await withUserContext(userId, () =>
        service.getReconciliationData(userId, accountId, "2020-10-15", 0),
      );
      expect(data.lastReconciledDate).toBe("2020-09-15");

      const summary = await withUserContext(userId, () =>
        service.getStaleUnreconciled(userId),
      );
      const account = summary.accounts.find((a) => a.accountId === accountId);
      expect(account).toMatchObject({
        lastReconciledDate: "2020-09-15",
        count: 1,
        missedCount: 0,
        overdueCount: 1,
      });
    });

    it("keeps a row reconciled without a statement at its own date", async () => {
      await withUserContext(userId, async () => {
        // Imported already reconciled: no reconciled_date.
        await service.create(userId, {
          accountId,
          transactionDate: "2020-08-01",
          amount: -10,
          currencyCode: "USD",
          status: TransactionStatus.RECONCILED,
        });
        await service.create(userId, {
          accountId,
          transactionDate: "2020-07-20",
          amount: -5,
          currencyCode: "USD",
        });
      });

      const summary = await withUserContext(userId, () =>
        service.getStaleUnreconciled(userId),
      );
      const account = summary.accounts.find((a) => a.accountId === accountId);
      expect(account).toMatchObject({
        lastReconciledDate: "2020-08-01",
        missedCount: 1,
      });
    });
  });
});
