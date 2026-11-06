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
      "transaction_split_tags",
      "transaction_tags",
      "tags",
      "user_preferences",
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

  it.each([
    ["less than", -30],
    ["the whole of", -100],
  ])(
    "removing a line for %s the parent that addSplit added to a plain transaction moves nothing back",
    async (_label, lineAmount) => {
      const plain = await withUserContext(userId, () =>
        service.create(userId, {
          accountId: chequingId,
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          categoryId: groceriesId,
        } as never),
      );
      const line = await withUserContext(userId, () =>
        service.addSplit(userId, plain.id, {
          amount: lineAmount,
          categoryId: groceriesId,
        } as never),
      );
      expect(await balanceOf(chequingId)).toBe(900);

      await removeSplit(plain.id, line.id);

      const parent = await dataSource.manager.findOneByOrFail(Transaction, {
        id: plain.id,
      });
      expect(Number(parent.amount)).toBe(-100);
      expect(await balanceOf(chequingId)).toBe(900);
      await expectBalancesMatchLedger();
    },
  );

  /**
   * Issue #2039: the counterpart in Savings is a row in another account, so a
   * reconciled one answers the strict lock its parent answers. Removing either
   * line touches it -- the transfer line's removal deletes it, the category
   * line's collapse relinks it -- and replacing the set deletes it.
   */
  describe("a reconciled counterpart under the strict lock", () => {
    async function lockReconciledLeg(savingsLegId: string): Promise<void> {
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
         VALUES ($1, true)
         ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = true`,
        [userId],
      );
      await dataSource.query(
        `UPDATE transactions SET status = 'RECONCILED' WHERE id = $1`,
        [savingsLegId],
      );
    }

    async function expectUntouched(
      parentId: string,
      savingsLegId: string,
    ): Promise<void> {
      const parent = await dataSource.manager.findOneByOrFail(Transaction, {
        id: parentId,
      });
      expect(Number(parent.amount)).toBe(-100);
      expect(parent.isSplit).toBe(true);
      expect(parent.linkedTransactionId).toBeNull();
      const leg = await dataSource.manager.findOneByOrFail(Transaction, {
        id: savingsLegId,
      });
      expect(Number(leg.amount)).toBe(40);
      expect(leg.linkedTransactionId).toBe(parentId);
      expect(
        await dataSource.manager.count(TransactionSplit, {
          where: { transactionId: parentId },
        }),
      ).toBe(2);
      expect(await balanceOf(chequingId)).toBe(900);
      expect(await balanceOf(savingsId)).toBe(40);
    }

    it("refuses to remove the transfer line, which would delete it", async () => {
      const { parentId, transferLineId, savingsLegId } = await createSplit();
      await lockReconciledLeg(savingsLegId);

      await expect(removeSplit(parentId, transferLineId)).rejects.toThrow(
        /reconciled/i,
      );

      await expectUntouched(parentId, savingsLegId);
    });

    it("refuses to remove the category line, whose collapse would relink it", async () => {
      const { parentId, groceriesLineId, savingsLegId } = await createSplit();
      await lockReconciledLeg(savingsLegId);

      await expect(removeSplit(parentId, groceriesLineId)).rejects.toThrow(
        /reconciled/i,
      );

      await expectUntouched(parentId, savingsLegId);
    });

    it("refuses to replace the split set, which would delete it", async () => {
      const { parentId, savingsLegId } = await createSplit();
      await lockReconciledLeg(savingsLegId);

      await expect(
        withUserContext(userId, () =>
          service.updateSplits(userId, parentId, [
            { amount: -50, categoryId: groceriesId },
            { amount: -50, categoryId: groceriesId },
          ] as never),
        ),
      ).rejects.toThrow(/reconciled/i);

      await expectUntouched(parentId, savingsLegId);
    });
  });

  /**
   * Issue #2039: the parent becomes its last line, so what the line carried
   * stays with the parent rather than going with the line's row.
   */
  it.each([
    ["a category line", "transfer"],
    ["a transfer line", "groceries"],
  ])(
    "collapsing into %s keeps its tags and memo on the parent",
    async (_label, removed) => {
      const { parentId, groceriesLineId, transferLineId } = await createSplit();
      const keptLineId =
        removed === "transfer" ? groceriesLineId : transferLineId;
      const [{ id: lineTagId }] = await dataSource.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, 'Holiday') RETURNING id`,
        [userId],
      );
      const [{ id: parentTagId }] = await dataSource.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, 'Family') RETURNING id`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO transaction_split_tags (transaction_split_id, tag_id)
         VALUES ($1, $2)`,
        [keptLineId, lineTagId],
      );
      await dataSource.query(
        `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
        [parentId, parentTagId],
      );
      await dataSource.query(
        `UPDATE transaction_splits SET memo = 'Weekend trip' WHERE id = $1`,
        [keptLineId],
      );

      await removeSplit(
        parentId,
        removed === "transfer" ? transferLineId : groceriesLineId,
      );

      const tagIds = (
        await dataSource.query(
          `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1`,
          [parentId],
        )
      ).map((row: { tag_id: string }) => row.tag_id);
      expect(tagIds.sort()).toEqual([lineTagId, parentTagId].sort());
      const parent = await dataSource.manager.findOneByOrFail(Transaction, {
        id: parentId,
      });
      expect(parent.description).toBe("Weekend trip");
      expect(parent.isSplit).toBe(false);
    },
  );

  it("a collapse leaves a description the parent already has", async () => {
    const { parentId, groceriesLineId, transferLineId } = await createSplit();
    await dataSource.query(
      `UPDATE transactions SET description = 'Saturday shop' WHERE id = $1`,
      [parentId],
    );
    await dataSource.query(
      `UPDATE transaction_splits SET memo = 'Produce' WHERE id = $1`,
      [groceriesLineId],
    );

    await removeSplit(parentId, transferLineId);

    const parent = await dataSource.manager.findOneByOrFail(Transaction, {
      id: parentId,
    });
    expect(parent.description).toBe("Saturday shop");
  });

  /**
   * Issue #2039: the edit of a split-transfer leg's amount re-totals the parent
   * through the helper removal uses, so both hold the balance to the ledger.
   */
  it("re-totals the parent through the shared helper when a line is removed after a leg edit", async () => {
    const { parentId, groceriesLineId, savingsLegId } = await createSplit();

    await withUserContext(userId, () =>
      service.updateTransfer(userId, savingsLegId, { amount: 50 } as never),
    );
    const edited = await dataSource.manager.findOneByOrFail(Transaction, {
      id: parentId,
    });
    expect(Number(edited.amount)).toBe(-110);
    expect(await balanceOf(chequingId)).toBe(890);

    await removeSplit(parentId, groceriesLineId);

    const parent = await dataSource.manager.findOneByOrFail(Transaction, {
      id: parentId,
    });
    expect(Number(parent.amount)).toBe(-50);
    expect(await balanceOf(chequingId)).toBe(950);
    expect(await balanceOf(savingsId)).toBe(50);
    await expectBalancesMatchLedger();
  });

  /**
   * Issue #2039: adding a line to a whole set is the mirror of removing one.
   * The -100.00 split grows by the line, so the lines still add up to it and
   * Chequing moves by exactly the line's amount.
   */
  it.each([
    ["of its own sign", -10, -110, 890],
    ["of the opposite sign", 10, -90, 910],
  ])(
    "adding a line %s to a whole set re-totals the parent and moves Chequing",
    async (_label, lineAmount, parentAmount, chequing) => {
      const { parentId } = await createSplit();

      await withUserContext(userId, () =>
        service.addSplit(userId, parentId, {
          amount: lineAmount,
          categoryId: groceriesId,
        } as never),
      );

      const parent = await dataSource.manager.findOneByOrFail(Transaction, {
        id: parentId,
      });
      expect(Number(parent.amount)).toBe(parentAmount);
      const lines = await dataSource.manager.find(TransactionSplit, {
        where: { transactionId: parentId },
      });
      expect(
        lines.reduce(
          (sum, line) => sum + Math.round(Number(line.amount) * 10000),
          0,
        ) / 10000,
      ).toBe(parentAmount);
      expect(await balanceOf(chequingId)).toBe(chequing);
      await expectBalancesMatchLedger();
    },
  );
});
