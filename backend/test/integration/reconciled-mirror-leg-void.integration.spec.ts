import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Account } from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Issue #2072: a VOID sent for the unreconciled leg of a transfer writes its
 * mirror leg too, so a RECONCILED mirror under the strict lock refuses it.
 * The status route and the generic update used to ask the lock of the named
 * leg alone, then void the reconciled Savings leg (reconciled date kept) and
 * take 100.00 off the balance Savings was reconciled to.
 */
describe("Voiding a transfer leg whose mirror is reconciled (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let savingsId: string;

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
      "user_preferences",
      "transaction_splits",
      "transactions",
      "accounts",
      "monthly_account_balances",
      "users",
    ]);
    userId = (await createTestUserDirect(dataSource)).id;
    chequingId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, {
        name: "Savings",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
  });

  async function balanceOf(accountId: string): Promise<number> {
    const account = await dataSource.manager.findOneByOrFail(Account, {
      id: accountId,
    });
    return Number(account.currentBalance);
  }

  async function rowOf(id: string): Promise<Transaction> {
    return dataSource.manager.findOneByOrFail(Transaction, { id });
  }

  /** A 100.00 Chequing -> Savings transfer with the Savings leg reconciled. */
  async function createReconciledPair(lock: boolean) {
    const { fromTransaction, toTransaction } = await withUserContext(
      userId,
      () =>
        service.createTransfer(userId, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 100,
          fromCurrencyCode: "USD",
        } as never),
    );
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = $2`,
      [userId, lock],
    );
    await dataSource.query(
      `UPDATE transactions
          SET status = 'RECONCILED', reconciled_date = '2026-01-31'
        WHERE id = $1`,
      [toTransaction.id],
    );
    expect(await balanceOf(chequingId)).toBe(900);
    expect(await balanceOf(savingsId)).toBe(1100);
    return {
      chequingLegId: fromTransaction.id,
      savingsLegId: toTransaction.id,
    };
  }

  async function expectUntouched(
    chequingLegId: string,
    savingsLegId: string,
  ): Promise<void> {
    const chequingLeg = await rowOf(chequingLegId);
    expect(chequingLeg.status).not.toBe(TransactionStatus.VOID);
    const savingsLeg = await rowOf(savingsLegId);
    expect(savingsLeg.status).toBe(TransactionStatus.RECONCILED);
    expect(String(savingsLeg.reconciledDate)).toContain("2026-01-31");
    expect(await balanceOf(chequingId)).toBe(900);
    expect(await balanceOf(savingsId)).toBe(1100);
  }

  it("refuses PATCH /transactions/:id/status and writes nothing", async () => {
    const { chequingLegId, savingsLegId } = await createReconciledPair(true);

    await expect(
      withUserContext(userId, () =>
        service.updateStatus(userId, chequingLegId, TransactionStatus.VOID),
      ),
    ).rejects.toThrow(/reconciled and locked/i);

    await expectUntouched(chequingLegId, savingsLegId);
  });

  it("refuses PATCH /transactions/:id with a VOID status and writes nothing", async () => {
    const { chequingLegId, savingsLegId } = await createReconciledPair(true);

    await expect(
      withUserContext(userId, () =>
        service.update(userId, chequingLegId, {
          status: TransactionStatus.VOID,
        }),
      ),
    ).rejects.toThrow(/reconciled and locked/i);

    await expectUntouched(chequingLegId, savingsLegId);
  });

  it("still voids the pair with the lock off", async () => {
    const { chequingLegId, savingsLegId } = await createReconciledPair(false);

    await withUserContext(userId, () =>
      service.updateStatus(userId, chequingLegId, TransactionStatus.VOID),
    );

    expect((await rowOf(chequingLegId)).status).toBe(TransactionStatus.VOID);
    expect((await rowOf(savingsLegId)).status).toBe(TransactionStatus.VOID);
    expect(await balanceOf(chequingId)).toBe(1000);
    expect(await balanceOf(savingsId)).toBe(1000);
  });
});
