import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionConversionService } from "@/transactions/transaction-conversion.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Confirming a provisional amount (design decision 4, P2, P3 and P6 of
 * docs/future-plans/provisional-amounts.md; test matrix rows 6 and 9 and the
 * split half of row 10).
 *
 * 100 USD left Chequing and the importer estimated +80 in the other account.
 * That account is in ZZZ, a currency no provider quotes, so every amount here
 * is a stated one and nothing depends on the network. No request path can set
 * the column, so the fixture flags the leg the way only the importer does.
 */
describe("Confirming a provisional amount (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let conversion: TransactionConversionService;
  let history: ActionHistoryService;
  let userId: string;
  let usdId: string;
  let foreignId: string;
  let categoryId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    conversion = module.get(TransactionConversionService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "action_history",
      "transaction_splits",
      "transactions",
      "exchange_rates",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('USD', 'US Dollar', '$', 2),
         ('ZZZ', 'Unrated Test Currency', 'Z', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    usdId = (
      await createTestAccount(db, userId, {
        name: "Chequing",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    foreignId = (
      await createTestAccount(db, userId, {
        name: "Foreign Savings",
        currencyCode: "ZZZ",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    categoryId = (await createTestCategory(db, userId, { name: "Groceries" }))
      .id;
  });

  const flag = (id: string) =>
    db.query(
      `UPDATE transactions SET amount_is_provisional = true WHERE id = $1`,
      [id],
    );
  const row = (id: string) => db.manager.findOneByOrFail(Transaction, { id });
  const balance = async (accountId: string) =>
    Number(
      (await db.manager.findOneByOrFail(Account, { id: accountId }))
        .currentBalance,
    );

  /** A plain transfer whose destination leg the importer estimated at 80. */
  async function provisionalTransfer(): Promise<{ from: string; to: string }> {
    const { fromTransaction, toTransaction } = await asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: usdId,
        toAccountId: foreignId,
        transactionDate: "2026-01-15",
        amount: 100,
        fromCurrencyCode: "USD",
        toCurrencyCode: "ZZZ",
        exchangeRate: 0.8,
        toAmount: 80,
        description: "Imported",
      }),
    );
    await flag(toTransaction.id);
    return { from: fromTransaction.id, to: toTransaction.id };
  }

  /** A split whose transfer line's counterpart the importer estimated at 35.5. */
  async function provisionalSplitLeg(): Promise<string> {
    await asUser(() =>
      transactions.create(userId, {
        accountId: usdId,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: [
          { categoryId, amount: -60 },
          {
            transferAccountId: foreignId,
            amount: -40,
            transferTargetAmount: 35.5,
            memo: "Imported",
          },
        ],
      }),
    );
    const leg = await db.manager.findOneOrFail(Transaction, {
      where: { accountId: foreignId },
    });
    await flag(leg.id);
    return leg.id;
  }

  describe("row 6: an edit that states no different amount leaves it provisional", () => {
    it("a transfer edit that resends the stored amounts and clears the description", async () => {
      const { to } = await provisionalTransfer();

      await asUser(() =>
        transactions.updateTransfer(userId, to, {
          fromAccountId: usdId,
          toAccountId: foreignId,
          amount: 100,
          toAmount: 80,
          exchangeRate: 0.8,
          description: "",
          status: TransactionStatus.CLEARED,
        }),
      );

      const leg = await row(to);
      expect(leg.description).toBe("");
      expect(leg.amountIsProvisional).toBe(true);
      expect(await balance(foreignId)).toBe(80);
    });

    it("a transfer edit that restates only the other side", async () => {
      const { from, to } = await provisionalTransfer();

      await asUser(() =>
        transactions.updateTransfer(userId, from, {
          amount: 110,
          toAmount: 80,
        }),
      );

      expect(Number((await row(from)).amount)).toBe(-110);
      expect((await row(to)).amountIsProvisional).toBe(true);
    });

    it("the generic row update and a bulk update of description, payee, category and status", async () => {
      const { to } = await provisionalTransfer();

      await asUser(() =>
        transactions.update(userId, to, {
          description: "Edited",
          payeeName: "Someone",
          categoryId,
        }),
      );
      expect((await row(to)).amountIsProvisional).toBe(true);

      await asUser(() =>
        transactions.bulkUpdate(userId, {
          mode: "ids",
          transactionIds: [to],
          description: null,
          status: TransactionStatus.CLEARED,
        }),
      );
      const leg = await row(to);
      expect(leg.description).toBeNull();
      expect(leg.amountIsProvisional).toBe(true);
    });
  });

  describe("row 9: the reader confirms by hand", () => {
    it("the action clears the flag and moves no amount, no rate and no balance; undo and redo follow it", async () => {
      const { from, to } = await provisionalTransfer();
      const before = await row(to);

      const confirmed = await asUser(() =>
        transactions.confirmAmount(userId, to),
      );

      expect(confirmed.amountIsProvisional).toBe(false);
      const after = await row(to);
      expect(after.amountIsProvisional).toBe(false);
      expect(Number(after.amount)).toBe(80);
      // Open question 3's default: the rate stays as the importer wrote it.
      expect(Number(after.exchangeRate)).toBe(Number(before.exchangeRate));
      expect(Number((await row(from)).amount)).toBe(-100);
      expect(await balance(usdId)).toBe(900);
      expect(await balance(foreignId)).toBe(80);

      await settlePendingHistoryWrites();
      await asUser(() => history.undo(userId));
      expect((await row(to)).amountIsProvisional).toBe(true);
      expect(Number((await row(to)).amount)).toBe(80);
      expect(await balance(foreignId)).toBe(80);

      await asUser(() => history.redo(userId));
      expect((await row(to)).amountIsProvisional).toBe(false);
      expect(await balance(foreignId)).toBe(80);
    });

    it("undoing a confirmation does not put back an amount a later transfer edit replaced", async () => {
      const { to } = await provisionalTransfer();
      await asUser(() => transactions.confirmAmount(userId, to));
      await settlePendingHistoryWrites();
      // A transfer edit records no history entry, so the confirmation is
      // still the newest undoable action.
      await asUser(() =>
        transactions.updateTransfer(userId, to, { amount: 100, toAmount: 90 }),
      );

      await asUser(() => history.undo(userId));

      const leg = await row(to);
      expect(Number(leg.amount)).toBe(90);
      expect(leg.amountIsProvisional).toBe(true);
      expect(await balance(foreignId)).toBe(90);
    });

    it("refuses a row that is not provisional and a row that is not the caller's, writing nothing", async () => {
      const { from, to } = await provisionalTransfer();

      await expect(
        asUser(() => transactions.confirmAmount(userId, from)),
      ).rejects.toBeInstanceOf(BadRequestException);

      const stranger = (await createTestUserDirect(db)).id;
      await expect(
        withUserContext(stranger, () =>
          transactions.confirmAmount(stranger, to),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((await row(to)).amountIsProvisional).toBe(true);

      await asUser(() => transactions.confirmAmount(userId, to));
      await expect(
        asUser(() => transactions.confirmAmount(userId, to)),
      ).rejects.toBeInstanceOf(BadRequestException);
      await settlePendingHistoryWrites();
      const entries = await db.query(
        `SELECT 1 FROM action_history
          WHERE user_id = $1 AND description_key = 'confirmedTransactionAmount'`,
        [userId],
      );
      expect(entries).toHaveLength(1);
    });

    it("a transfer edit that states a different amount for the leg confirms it and moves the balance by the difference", async () => {
      const { from, to } = await provisionalTransfer();

      await asUser(() =>
        transactions.updateTransfer(userId, to, { amount: 100, toAmount: 90 }),
      );

      const leg = await row(to);
      expect(Number(leg.amount)).toBe(90);
      expect(leg.amountIsProvisional).toBe(false);
      expect((await row(from)).amountIsProvisional).toBe(false);
      expect(await balance(foreignId)).toBe(90);
      expect(await balance(usdId)).toBe(900);
    });
  });

  it("P3: a leg converted to an ordinary transaction is no longer provisional", async () => {
    const { from, to } = await provisionalTransfer();

    await asUser(() =>
      conversion.convertToTransaction(userId, to, { categoryId }),
    );

    const plain = await row(to);
    expect(plain.isTransfer).toBe(false);
    expect(plain.linkedTransactionId).toBeNull();
    expect(plain.amountIsProvisional).toBe(false);
    expect(await db.manager.findOneBy(Transaction, { id: from })).toBeNull();
  });

  describe("row 10: the counterpart of a split's transfer line", () => {
    it("stays provisional through a description edit and a resend of its stored amount", async () => {
      const leg = await provisionalSplitLeg();

      await asUser(() =>
        transactions.updateTransfer(userId, leg, { description: "" }),
      );
      await asUser(() =>
        transactions.updateTransfer(userId, leg, {
          toAmount: 35.5,
          description: "Edited",
        }),
      );

      const after = await row(leg);
      expect(after.description).toBe("Edited");
      expect(after.amountIsProvisional).toBe(true);
      expect(await balance(foreignId)).toBe(35.5);
    });

    it("is confirmed by a different amount stated for it, moving its balance by the difference", async () => {
      const leg = await provisionalSplitLeg();

      await asUser(() =>
        transactions.updateTransfer(userId, leg, { toAmount: 36 }),
      );

      const after = await row(leg);
      expect(Number(after.amount)).toBe(36);
      expect(after.amountIsProvisional).toBe(false);
      expect(await balance(foreignId)).toBe(36);
    });

    it("is confirmed by the action, with no amount and no balance moved", async () => {
      const leg = await provisionalSplitLeg();

      await asUser(() => transactions.confirmAmount(userId, leg));

      const after = await row(leg);
      expect(Number(after.amount)).toBe(35.5);
      expect(after.amountIsProvisional).toBe(false);
      expect(await balance(foreignId)).toBe(35.5);
      expect(await balance(usdId)).toBe(900);
    });
  });
});
