import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

describe("TransactionsService transfers (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let fromAccountId: string;
  let toAccountId: string;

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

    const fromAccount = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: 5000,
      currentBalance: 5000,
    });
    fromAccountId = fromAccount.id;

    const toAccount = await createTestAccount(dataSource, userId, {
      name: "Savings",
      openingBalance: 2000,
      currentBalance: 2000,
    });
    toAccountId = toAccount.id;
  });

  describe("createTransfer()", () => {
    it("should create linked transactions and update both balances", async () => {
      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId,
          transactionDate: "2026-01-15",
          amount: 500,
          fromCurrencyCode: "USD",
        }),
      );

      // Verify two linked transactions created
      expect(result.fromTransaction).toBeDefined();
      expect(result.toTransaction).toBeDefined();
      expect(Number(result.fromTransaction.amount)).toBe(-500);
      expect(Number(result.toTransaction.amount)).toBe(500);
      expect(result.fromTransaction.isTransfer).toBe(true);
      expect(result.toTransaction.isTransfer).toBe(true);
      expect(result.fromTransaction.linkedTransactionId).toBe(
        result.toTransaction.id,
      );
      expect(result.toTransaction.linkedTransactionId).toBe(
        result.fromTransaction.id,
      );

      // Verify balances
      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const toAccount = await dataSource.manager.findOne(Account, {
        where: { id: toAccountId },
      });
      expect(fromAccount!.currentBalance).toBe(4500);
      expect(toAccount!.currentBalance).toBe(2500);
    });

    it("should apply exchange rate for cross-currency transfers", async () => {
      const cadAccount = await createTestAccount(dataSource, userId, {
        name: "CAD Account",
        currencyCode: "CAD",
        openingBalance: 0,
        currentBalance: 0,
      });

      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId: cadAccount.id,
          transactionDate: "2026-01-15",
          amount: 100,
          fromCurrencyCode: "USD",
          toCurrencyCode: "CAD",
          exchangeRate: 1.35,
        }),
      );

      expect(Number(result.fromTransaction.amount)).toBe(-100);
      expect(Number(result.toTransaction.amount)).toBe(135);
      expect(result.toTransaction.currencyCode).toBe("CAD");

      // Verify balances
      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const cadAccountUpdated = await dataSource.manager.findOne(Account, {
        where: { id: cadAccount.id },
      });
      expect(fromAccount!.currentBalance).toBe(4900);
      expect(cadAccountUpdated!.currentBalance).toBe(135);
    });
  });

  /**
   * The generic row update is not a transfer route (A26-M10, MON-H11 server
   * residual). A transfer leg's amount, account, date or rate is a property of
   * the PAIR, so `update()` refuses a change to it on one leg rather than
   * writing that leg alone; presentational fields, and an unchanged figure
   * re-sent by a form, stay accepted.
   */
  describe("update() on a transfer leg", () => {
    const amounts = async (ids: string[]) => {
      const rows = await dataSource.manager.find(Transaction, {
        where: ids.map((id) => ({ id })),
      });
      return Object.fromEntries(rows.map((r) => [r.id, Number(r.amount)]));
    };
    const balances = async () => {
      const from = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const to = await dataSource.manager.findOne(Account, {
        where: { id: toAccountId },
      });
      return [Number(from!.currentBalance), Number(to!.currentBalance)];
    };
    const createPair = () =>
      withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId,
          transactionDate: "2026-01-15",
          amount: 100,
          fromCurrencyCode: "USD",
        }),
      );

    it.each(["fromTransaction", "toTransaction"] as const)(
      "refuses an amount change on the %s leg and writes nothing",
      async (leg) => {
        const pair = await createPair();
        const ids = [pair.fromTransaction.id, pair.toTransaction.id];

        await expect(
          withUserContext(userId, () =>
            service.update(userId, pair[leg].id, { amount: 150 }),
          ),
        ).rejects.toThrow(/Transfers can't be edited here/);

        expect(await amounts(ids)).toEqual({ [ids[0]]: -100, [ids[1]]: 100 });
        expect(await balances()).toEqual([4900, 2100]);
      },
    );

    it("refuses moving one leg to another account", async () => {
      const pair = await createPair();
      const other = await createTestAccount(dataSource, userId, {
        name: "Other",
        openingBalance: 0,
        currentBalance: 0,
      });

      await expect(
        withUserContext(userId, () =>
          service.update(userId, pair.toTransaction.id, {
            accountId: other.id,
          }),
        ),
      ).rejects.toThrow(/Transfers can't be edited here/);

      const leg = await dataSource.manager.findOne(Transaction, {
        where: { id: pair.toTransaction.id },
      });
      expect(leg!.accountId).toBe(toAccountId);
    });

    it("refuses an amount change on a split-transfer leg", async () => {
      const parentId = "ffffffff-0000-4000-8000-0000000000a1";
      const legId = "00000000-0000-4000-8000-0000000000a1";
      await dataSource.query(
        `INSERT INTO transactions
           (id, user_id, account_id, transaction_date, amount, currency_code,
            exchange_rate, is_split, is_transfer, status)
         VALUES ($1, $2, $3, DATE '2026-01-15', -100, 'USD', 1, true, false,
                 'UNRECONCILED')`,
        [parentId, userId, fromAccountId],
      );
      await dataSource.query(
        `INSERT INTO transactions
           (id, user_id, account_id, transaction_date, amount, currency_code,
            exchange_rate, is_split, is_transfer, status, linked_transaction_id)
         VALUES ($1, $2, $3, DATE '2026-01-15', 100, 'USD', 1, false, true,
                 'UNRECONCILED', $4)`,
        [legId, userId, toAccountId, parentId],
      );
      await dataSource.query(
        `INSERT INTO transaction_splits
           (id, transaction_id, kind, amount, transfer_account_id,
            linked_transaction_id)
         VALUES ($1, $2, 'transfer', -100, $3, $4)`,
        ["aaaaaaaa-1111-4000-8000-0000000000a1", parentId, toAccountId, legId],
      );

      await expect(
        withUserContext(userId, () =>
          service.update(userId, legId, { amount: 150 }),
        ),
      ).rejects.toThrow(/Transfers can't be edited here/);

      expect(await amounts([parentId, legId])).toEqual({
        [parentId]: -100,
        [legId]: 100,
      });
    });

    it("accepts a description edit that re-sends the unchanged figures", async () => {
      const pair = await createPair();

      const saved = await withUserContext(userId, () =>
        service.update(userId, pair.toTransaction.id, {
          amount: 100,
          accountId: toAccountId,
          transactionDate: "2026-01-15",
          exchangeRate: 1,
          description: "Rent float",
        }),
      );

      expect(saved.description).toBe("Rent float");
      expect(await balances()).toEqual([4900, 2100]);
    });
  });

  describe("removeAny() (the generic DELETE /transactions/:id path)", () => {
    it("deletes both legs and reverses both balances when given one transfer leg", async () => {
      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId,
          transactionDate: "2026-01-15",
          amount: 300,
          fromCurrencyCode: "USD",
        }),
      );

      await withUserContext(userId, () =>
        service.removeAny(userId, result.toTransaction.id),
      );

      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const toAccount = await dataSource.manager.findOne(Account, {
        where: { id: toAccountId },
      });
      expect(fromAccount!.currentBalance).toBe(5000);
      expect(toAccount!.currentBalance).toBe(2000);
      const remaining = await dataSource.manager.find(Transaction, {
        where: { userId },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  describe("removeTransfer()", () => {
    it("should delete both transactions and reverse both balances", async () => {
      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId,
          transactionDate: "2026-01-15",
          amount: 300,
          fromCurrencyCode: "USD",
        }),
      );

      // Balances: from=4700, to=2300
      await withUserContext(userId, () =>
        service.removeTransfer(userId, result.fromTransaction.id),
      );

      // Balances should be restored
      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const toAccount = await dataSource.manager.findOne(Account, {
        where: { id: toAccountId },
      });
      expect(fromAccount!.currentBalance).toBe(5000);
      expect(toAccount!.currentBalance).toBe(2000);

      // Both transactions should be deleted
      const remaining = await dataSource.manager.find(Transaction, {
        where: { userId },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  /**
   * Lock ordering across the paths that touch a split parent and its legs
   * (audit RV4-005).
   *
   * This is a liveness property of PostgreSQL, not of the service: two
   * transactions that acquire the same two rows in opposite orders get `40P01`
   * and one of them is aborted. The ids are chosen so the leg sorts *before* the
   * parent, which is the case a single sorted batch over parent-plus-legs gets
   * wrong -- `removeSplit` cannot know a leg id before reading the split, so it
   * necessarily locks the parent first, and the rule has to be "parent before
   * legs" rather than "ascending id".
   */
  describe("split parent and leg lock ordering", () => {
    /**
     * A split parent whose transfer leg's UUID sorts before its own, so
     * ascending-id order and parent-first order genuinely disagree.
     */
    const PARENT_ID = "ffffffff-0000-4000-8000-000000000001";
    const LEG_ID = "00000000-0000-4000-8000-000000000001";
    const SPLIT_ID = "aaaaaaaa-1111-4000-8000-000000000001";

    beforeEach(async () => {
      // Built with raw SQL: the service would allocate its own UUIDs, and the
      // adversarial ordering is the whole point of the fixture.
      await dataSource.query(
        `INSERT INTO transactions
           (id, user_id, account_id, transaction_date, amount, currency_code,
            exchange_rate, is_split, is_transfer, status)
         VALUES ($1, $2, $3, DATE '2026-01-15', -100, 'USD', 1, true, false,
                 'UNRECONCILED')`,
        [PARENT_ID, userId, fromAccountId],
      );
      await dataSource.query(
        `INSERT INTO transactions
           (id, user_id, account_id, transaction_date, amount, currency_code,
            exchange_rate, is_split, is_transfer, status, linked_transaction_id)
         VALUES ($1, $2, $3, DATE '2026-01-15', 100, 'USD', 1, false, true,
                 'UNRECONCILED', $4)`,
        [LEG_ID, userId, toAccountId, PARENT_ID],
      );
      await dataSource.query(
        `INSERT INTO transaction_splits
           (id, transaction_id, kind, amount, transfer_account_id,
            linked_transaction_id)
         VALUES ($1, $2, 'transfer', -100, $3, $4)`,
        [SPLIT_ID, PARENT_ID, toAccountId, LEG_ID],
      );
    });

    it("removes the split and the counterpart concurrently without deadlocking", async () => {
      // Both directions at once. Before the ordering fix one of these took the
      // parent then the leg while the other took the leg then the parent, and
      // PostgreSQL aborted whichever it picked.
      const outcomes = await Promise.allSettled([
        withUserContext(userId, () =>
          service.removeSplit(userId, PARENT_ID, SPLIT_ID),
        ),
        withUserContext(userId, () => service.removeTransfer(userId, LEG_ID)),
      ]);

      for (const outcome of outcomes) {
        if (outcome.status !== "rejected") continue;
        const message = String(
          (outcome.reason as { message?: string })?.message ?? outcome.reason,
        );
        // Losing the race is legitimate -- the row may already be gone, and a
        // 404 is the honest answer. A deadlock is not.
        expect(message).not.toMatch(/deadlock/i);
        expect((outcome.reason as { code?: string })?.code).not.toBe("40P01");
      }
    });

    it("does not deadlock when both directions are run repeatedly", async () => {
      // One pass can pass by luck: whichever request happens to finish before the
      // other starts never contends at all. Several rounds over fresh fixtures
      // make the interleaving actually happen.
      for (let round = 0; round < 5; round += 1) {
        if (round > 0) {
          await dataSource.query(
            `DELETE FROM transactions WHERE id IN ($1, $2)`,
            [PARENT_ID, LEG_ID],
          );
          await dataSource.query(
            `INSERT INTO transactions
               (id, user_id, account_id, transaction_date, amount, currency_code,
                exchange_rate, is_split, is_transfer, status)
             VALUES ($1, $2, $3, DATE '2026-01-15', -100, 'USD', 1, true, false,
                     'UNRECONCILED')`,
            [PARENT_ID, userId, fromAccountId],
          );
          await dataSource.query(
            `INSERT INTO transactions
               (id, user_id, account_id, transaction_date, amount, currency_code,
                exchange_rate, is_split, is_transfer, status,
                linked_transaction_id)
             VALUES ($1, $2, $3, DATE '2026-01-15', 100, 'USD', 1, false, true,
                     'UNRECONCILED', $4)`,
            [LEG_ID, userId, toAccountId, PARENT_ID],
          );
          await dataSource.query(
            `INSERT INTO transaction_splits
               (id, transaction_id, kind, amount, transfer_account_id,
                linked_transaction_id)
             VALUES ($1, $2, 'transfer', -100, $3, $4)`,
            [SPLIT_ID, PARENT_ID, toAccountId, LEG_ID],
          );
        }

        const outcomes = await Promise.allSettled([
          withUserContext(userId, () =>
            service.removeSplit(userId, PARENT_ID, SPLIT_ID),
          ),
          withUserContext(userId, () => service.removeTransfer(userId, LEG_ID)),
        ]);

        for (const outcome of outcomes) {
          if (outcome.status !== "rejected") continue;
          expect(
            String(
              (outcome.reason as { message?: string })?.message ??
                outcome.reason,
            ),
          ).not.toMatch(/deadlock/i);
        }
      }
    });
  });
});
