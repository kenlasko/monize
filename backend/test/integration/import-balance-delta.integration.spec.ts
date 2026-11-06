import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { Account } from "@/accounts/entities/account.entity";
import { updateAccountBalance } from "@/import/import-context";
import { ImportEntityCreatorService } from "@/import/import-entity-creator.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The import's per-row balance write against a real `decimal(20,4)` column.
 *
 * Mechanism under test: `updateAccountBalance`
 * (`backend/src/import/import-context.ts`), one atomic delta statement --
 * `UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric)
 * + $1, 4) WHERE id = $2` -- which is row 1 of
 * `docs/concurrency-and-idempotency.md` section 2 and the same statement
 * `AccountsService.updateBalance` issues.
 *
 * It used to be a `findOne` followed by an absolute `update` of a sum computed
 * in JavaScript and rounded to 2dp. Two properties only a real database can
 * decide are asserted here: the imported amounts land at the column's 4dp
 * precision, and two deltas on two connections compose instead of one
 * overwriting the other.
 */
describe("import balance writes (integration, CONC-001)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  const OPENING = 1000;

  // An imported file's amounts, including two that a 2dp rounding would have
  // destroyed and two rows hitting the same account.
  const IMPORTED_AMOUNTS = [-50, 123.4567, 0.0025, 25];
  const IMPORTED_SUM =
    IMPORTED_AMOUNTS.reduce(
      (sum, amount) => sum + Math.round(amount * 10000),
      0,
    ) / 10000;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
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

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const account = await createTestAccount(dataSource, userId, {
      name: "Imported Chequing",
      openingBalance: OPENING,
      currentBalance: OPENING,
    });
    accountId = account.id;
  });

  async function storedBalance(): Promise<number> {
    const account = await dataSource.manager.findOneOrFail(Account, {
      where: { id: accountId },
    });
    return Number(account.currentBalance);
  }

  it("leaves the balance at opening plus the sum of the imported amounts", async () => {
    await withUserContext(userId, () =>
      withScopedDb(dataSource, async (m) => {
        // One import transaction, one call per imported row, exactly as the QIF
        // and investment processors drive it.
        for (const amount of IMPORTED_AMOUNTS) {
          await updateAccountBalance(m, accountId, amount, 4);
        }
      }),
    );

    expect(IMPORTED_SUM).toBe(98.4592);
    expect(await storedBalance()).toBe(OPENING + IMPORTED_SUM);
  });

  it("composes two deltas written on two connections", async () => {
    // Held open across the second writer's statement: with the atomic delta the
    // second `UPDATE` blocks on the row lock and then adds to the committed
    // value. A read-modify-write would have read the pre-commit balance first
    // and written it back, discarding the first delta.
    let releaseFirst!: () => void;
    const firstCanCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstApplied!: () => void;
    const firstApplied = new Promise<void>((resolve) => {
      signalFirstApplied = resolve;
    });

    const firstDone = withUserContext(userId, () =>
      withScopedDb(dataSource, async (m) => {
        await updateAccountBalance(m, accountId, 40.25, 4);
        signalFirstApplied();
        await firstCanCommit;
      }),
    );

    await firstApplied;

    const secondDone = withUserContext(userId, () =>
      withScopedDb(dataSource, (m) =>
        updateAccountBalance(m, accountId, -15.5, 4),
      ),
    );

    await waitForBlockedBackends(1);
    releaseFirst();
    await Promise.all([firstDone, secondDone]);

    expect(await storedBalance()).toBe(OPENING + 24.75);
  });

  it("applies a file's opening balance as a 4dp delta that keeps a concurrent movement (A26-M13, A26-S10-05)", async () => {
    // The import reads the account in its own transaction, before the row
    // writes; a -100.00 posting commits on another connection after that read.
    const snapshot = await dataSource.manager.findOneOrFail(Account, {
      where: { id: accountId },
    });
    await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, status)
       VALUES ($1, $2, CURRENT_DATE, -100, 'USD', 'UNRECONCILED')`,
      [userId, accountId],
    );
    await dataSource.query(
      `UPDATE accounts SET current_balance = current_balance - 100 WHERE id = $1`,
      [accountId],
    );

    await withUserContext(userId, () =>
      withScopedDb(dataSource, (m) =>
        new ImportEntityCreatorService().applyOpeningBalance(
          m,
          accountId,
          snapshot,
          100.1234,
        ),
      ),
    );

    const account = await dataSource.manager.findOneOrFail(Account, {
      where: { id: accountId },
    });
    expect(Number(account.openingBalance)).toBe(100.1234);
    // Opening 100.1234 plus the ledger's -100.00.
    expect(Number(account.currentBalance)).toBe(0.1234);
  });

  /**
   * Poll until `expected` backends in this database are parked on a lock. The
   * second delta is guaranteed to park on the first transaction's row lock, so
   * this always resolves; the attempt cap is a safety net against a wiring
   * mistake, never the timing source.
   */
  async function waitForBlockedBackends(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows: { c: number }[] = await dataSource.query(
        `SELECT count(*)::int AS c
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
      );
      if (rows[0].c >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${expected} lock-blocked backend(s); the race was ` +
        "never set up, so the test would prove nothing.",
    );
  }
});
