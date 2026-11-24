import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Account } from "@/accounts/entities/account.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-H05 (A26-S13-03): a split-transfer leg links to its split PARENT, not to
 * a mirror leg. The bulk delete used to queue that parent as "the other leg",
 * delete it, and let `transaction_splits` cascade -- leaving every sibling leg
 * standing with its money and a NULL link. With A 1,000.00 and a -100.00 split
 * to B (60.00) and C (40.00), bulk-deleting B's leg left A 1,000.00, B 0.00,
 * C 40.00: 40.00 created, agreeing with C's own ledger, so no recompute
 * repaired it.
 *
 * The case runs on the schema's own foreign-key actions (CASCADE on the split
 * row's parent, SET NULL on a link), asserted first, because the defect is in
 * what those actions leave behind.
 */
describe("Bulk delete of a split-transfer leg (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let aId: string;
  let bId: string;
  let cId: string;

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
      "monthly_account_balances",
      "users",
    ]);
    userId = (await createTestUserDirect(dataSource)).id;
    aId = (
      await createTestAccount(dataSource, userId, {
        name: "A",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    bId = (
      await createTestAccount(dataSource, userId, {
        name: "B",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    cId = (
      await createTestAccount(dataSource, userId, {
        name: "C",
        openingBalance: 0,
        currentBalance: 0,
      })
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

  async function rowCount(): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`,
      [userId],
    );
    return row.n;
  }

  async function createSplitTransfer(): Promise<{
    parentId: string;
    bLegId: string;
    cLegId: string;
  }> {
    const parent = await withUserContext(userId, () =>
      service.create(userId, {
        accountId: aId,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: [
          { amount: -60, transferAccountId: bId },
          { amount: -40, transferAccountId: cId },
        ],
      } as never),
    );
    const legs: { id: string; account_id: string }[] = await dataSource.query(
      `SELECT id, account_id FROM transactions WHERE user_id = $1 AND id <> $2`,
      [userId, parent.id],
    );
    const legIn = (accountId: string) =>
      legs.find((l) => l.account_id === accountId)!.id;
    expect(await balanceOf(aId)).toBe(900);
    expect(await balanceOf(bId)).toBe(60);
    expect(await balanceOf(cId)).toBe(40);
    return { parentId: parent.id, bLegId: legIn(bId), cLegId: legIn(cId) };
  }

  function bulkDelete(ids: string[]) {
    return withUserContext(userId, () =>
      service.bulkDelete(userId, { mode: "ids", transactionIds: ids } as never),
    );
  }

  async function expectPreTransferState(): Promise<void> {
    expect(await balanceOf(aId)).toBe(1000);
    expect(await balanceOf(bId)).toBe(0);
    expect(await balanceOf(cId)).toBe(0);
    expect(await rowCount()).toBe(0);
    for (const id of [aId, bId, cId]) {
      expect(await balanceOf(id)).toBe(await ledgerOf(id));
    }
  }

  it("runs on the schema's foreign-key actions for split rows and links", async () => {
    const rules: { table: string; column: string; rule: string }[] =
      await dataSource.query(
        `SELECT tc.table_name AS table, kcu.column_name AS column,
                rc.delete_rule AS rule
           FROM information_schema.referential_constraints rc
           JOIN information_schema.table_constraints tc
             ON tc.constraint_name = rc.constraint_name
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = rc.constraint_name
          WHERE tc.table_name IN ('transactions', 'transaction_splits')
            AND kcu.column_name IN ('transaction_id', 'linked_transaction_id')`,
      );
    const ruleOf = (table: string, column: string) =>
      rules.find((r) => r.table === table && r.column === column)?.rule;
    expect(ruleOf("transactions", "linked_transaction_id")).toBe("SET NULL");
    expect(ruleOf("transaction_splits", "linked_transaction_id")).toBe(
      "SET NULL",
    );
    expect(ruleOf("transaction_splits", "transaction_id")).toBe("CASCADE");
  });

  // Changed with #2366 (maintainer chose Option 1): a leg alone is one line of
  // its split, so only B's line goes and the split collapses into a plain A->C
  // transfer. The balance == ledger check is the #2283 orphan guard and stays.
  it("deleting one leg removes only B's line and leaves a plain A to C transfer", async () => {
    const { parentId, cLegId } = await createSplitTransfer();
    const bLeg: { id: string }[] = await dataSource.query(
      `SELECT id FROM transactions WHERE user_id = $1 AND account_id = $2`,
      [userId, bId],
    );

    const result = await bulkDelete([bLeg[0].id]);

    expect(result.deleted).toBe(1);
    expect(await balanceOf(aId)).toBe(960);
    expect(await balanceOf(bId)).toBe(0);
    expect(await balanceOf(cId)).toBe(40);
    expect(await rowCount()).toBe(2);
    const [parent] = await dataSource.query(
      `SELECT amount::float8 AS amount, is_split, is_transfer, linked_transaction_id
         FROM transactions WHERE id = $1`,
      [parentId],
    );
    expect(parent).toMatchObject({
      amount: -40,
      is_split: false,
      is_transfer: true,
      linked_transaction_id: cLegId,
    });
    const [cLeg] = await dataSource.query(
      `SELECT linked_transaction_id FROM transactions WHERE id = $1`,
      [cLegId],
    );
    expect(cLeg.linked_transaction_id).toBe(parentId);
    for (const id of [aId, bId, cId]) {
      expect(await balanceOf(id)).toBe(await ledgerOf(id));
    }
  });

  it("deleting the split parent removes every leg", async () => {
    const { parentId } = await createSplitTransfer();

    await bulkDelete([parentId]);

    await expectPreTransferState();
  });

  it("deleting both legs removes the parent and both legs once", async () => {
    const { bLegId, cLegId } = await createSplitTransfer();

    const result = await bulkDelete([bLegId, cLegId]);

    expect(result.deleted).toBe(2);
    await expectPreTransferState();
  });

  it("deleting the parent and a leg together reverses each row once", async () => {
    const { parentId, cLegId } = await createSplitTransfer();

    await bulkDelete([cLegId, parentId]);

    await expectPreTransferState();
  });

  it("deleting a plain transfer leg still removes its mirror", async () => {
    await withUserContext(userId, () =>
      service.createTransfer(userId, {
        fromAccountId: aId,
        toAccountId: bId,
        transactionDate: "2026-01-15",
        amount: 25,
        fromCurrencyCode: "USD",
      }),
    );
    const [leg] = await dataSource.query(
      `SELECT id FROM transactions WHERE account_id = $1`,
      [bId],
    );

    await bulkDelete([leg.id]);

    expect(await balanceOf(aId)).toBe(1000);
    expect(await balanceOf(bId)).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  it("a cross-owner leg: the own account is restored and the other owner's stays equal to its ledger", async () => {
    const otherId = (await createTestUserDirect(dataSource)).id;
    const otherAccountId = (
      await createTestAccount(dataSource, otherId, {
        name: "Theirs",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    // The pair as the cross-owner writer leaves it: two linked legs, one per
    // owner, each balance moved by its own leg.
    const [own] = await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, is_transfer, status)
       VALUES ($1, $2, '2026-01-15', -30, 'USD', true, 'UNRECONCILED')
       RETURNING id`,
      [userId, aId],
    );
    const [theirs] = await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, is_transfer, status,
                                 linked_transaction_id)
       VALUES ($1, $2, '2026-01-15', 30, 'USD', true, 'UNRECONCILED', $3)
       RETURNING id`,
      [otherId, otherAccountId, own.id],
    );
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $1 WHERE id = $2`,
      [theirs.id, own.id],
    );
    await dataSource.query(
      `UPDATE accounts SET current_balance = current_balance - 30 WHERE id = $1`,
      [aId],
    );
    await dataSource.query(
      `UPDATE accounts SET current_balance = current_balance + 30 WHERE id = $1`,
      [otherAccountId],
    );

    await bulkDelete([own.id]);

    expect(await balanceOf(aId)).toBe(1000);
    expect(await balanceOf(aId)).toBe(await ledgerOf(aId));
    expect(await balanceOf(otherAccountId)).toBe(
      await ledgerOf(otherAccountId),
    );
  });
});
