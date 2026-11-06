import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
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

/**
 * Issue #2025: `DELETE /transactions/:id/splits/:splitId` on a -100.00 split in
 * Chequing of -60.00 Groceries and -40.00 transferred to Savings.
 *
 * Removing the Groceries line used to delete the Savings leg the request never
 * named (Savings down 40.00) and leave a -100.00 parent with no category and no
 * transfer. Removing the transfer line deleted the leg, as asked, but left the
 * parent a -100.00 Groceries transaction: 40.00 had left Chequing and arrived
 * nowhere. Each case here holds the stored balances against the ledger.
 */
describe("Removing one split line (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let groceriesId: string;

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
      "categories",
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
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
  });

  async function balanceOf(accountId: string): Promise<number> {
    const account = await dataSource.manager.findOne(Account, {
      where: { id: accountId },
    });
    return Number(account!.currentBalance);
  }

  /** Opening balance plus every non-VOID row: what the stored balance must equal. */
  async function ledgerOf(accountId: string): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT (a.opening_balance + COALESCE(SUM(t.amount)
                 FILTER (WHERE t.status IS DISTINCT FROM 'VOID'), 0))::float8 AS v
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.opening_balance`,
      [accountId],
    );
    return Number(row.v);
  }

  async function createSplit(): Promise<{
    parentId: string;
    groceriesLineId: string;
    transferLineId: string;
    savingsLegId: string;
  }> {
    const parent = await withUserContext(userId, () =>
      service.create(userId, {
        accountId: chequingId,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: [
          { amount: -60, categoryId: groceriesId },
          { amount: -40, transferAccountId: savingsId },
        ],
      } as never),
    );
    const lines = await dataSource.manager.find(TransactionSplit, {
      where: { transactionId: parent.id },
    });
    const transferLine = lines.find((l) => l.transferAccountId === savingsId)!;
    expect(await balanceOf(chequingId)).toBe(900);
    expect(await balanceOf(savingsId)).toBe(40);
    return {
      parentId: parent.id,
      groceriesLineId: lines.find((l) => l.categoryId === groceriesId)!.id,
      transferLineId: transferLine.id,
      savingsLegId: transferLine.linkedTransactionId!,
    };
  }

  function removeSplit(parentId: string, splitId: string) {
    return withUserContext(userId, () =>
      service.removeSplit(userId, parentId, splitId),
    );
  }

  async function expectBalancesMatchLedger(): Promise<void> {
    for (const id of [chequingId, savingsId]) {
      expect(await balanceOf(id)).toBe(await ledgerOf(id));
    }
  }

  it("removing the category line leaves the parent a -40.00 transfer and keeps the Savings leg", async () => {
    const { parentId, groceriesLineId, savingsLegId } = await createSplit();

    await removeSplit(parentId, groceriesLineId);

    const parent = await dataSource.manager.findOneByOrFail(Transaction, {
      id: parentId,
    });
    expect(Number(parent.amount)).toBe(-40);
    expect(parent.isSplit).toBe(false);
    expect(parent.isTransfer).toBe(true);
    expect(parent.categoryId).toBeNull();
    expect(parent.linkedTransactionId).toBe(savingsLegId);

    const leg = await dataSource.manager.findOneBy(Transaction, {
      id: savingsLegId,
    });
    expect(leg).not.toBeNull();
    expect(Number(leg!.amount)).toBe(40);
    expect(leg!.linkedTransactionId).toBe(parentId);

    expect(
      await dataSource.manager.count(TransactionSplit, {
        where: { transactionId: parentId },
      }),
    ).toBe(0);
    expect(await balanceOf(chequingId)).toBe(960);
    expect(await balanceOf(savingsId)).toBe(40);
    await expectBalancesMatchLedger();
  });

  it("removing the transfer line leaves a -60.00 Groceries transaction and Chequing 40.00 higher", async () => {
    const { parentId, transferLineId, savingsLegId } = await createSplit();

    await removeSplit(parentId, transferLineId);

    const parent = await dataSource.manager.findOneByOrFail(Transaction, {
      id: parentId,
    });
    expect(Number(parent.amount)).toBe(-60);
    expect(parent.isSplit).toBe(false);
    expect(parent.isTransfer).toBe(false);
    expect(parent.categoryId).toBe(groceriesId);
    expect(
      await dataSource.manager.findOneBy(Transaction, { id: savingsLegId }),
    ).toBeNull();

    expect(await balanceOf(chequingId)).toBe(940);
    expect(await balanceOf(savingsId)).toBe(0);
    await expectBalancesMatchLedger();
  });
});
