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
 * The AI-assistant batch delete and the MCP bulk delete remove each selected
 * row with `removeAny`. Deleting one leg of a transfer removes its mirror, so
 * a selection holding BOTH legs failed on the second row with a 404 after the
 * first had already written. The callers now skip the mirror leg of an
 * earlier selected row (`findMirrorLegIds`), as the REST bulk delete does.
 */
describe("Delete of both legs of one transfer in a selection (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let aId: string;
  let bId: string;

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
  });

  async function balanceOf(accountId: string): Promise<number> {
    const account = await dataSource.manager.findOne(Account, {
      where: { id: accountId },
    });
    return Number(account!.currentBalance);
  }

  async function createTransfer() {
    const r = await withUserContext(userId, () =>
      service.createTransfer(userId, {
        fromAccountId: aId,
        toAccountId: bId,
        transactionDate: "2026-01-15",
        amount: 100,
        fromCurrencyCode: "USD",
      }),
    );
    return [r.fromTransaction.id, r.toTransaction.id];
  }

  /** The caller loop of the AI batch delete and the MCP bulk delete. */
  function deleteSelection(ids: string[]) {
    return withUserContext(userId, async () => {
      const mirrors = await service.findMirrorLegIds(userId, ids);
      for (const id of ids) {
        if (mirrors.has(id)) continue;
        await service.removeAny(userId, id);
      }
    });
  }

  it.each([
    ["from leg first", false],
    ["to leg first", true],
  ])(
    "deletes a transfer once when both legs are selected (%s)",
    async (_n, reverse) => {
      const [fromId, toId] = await createTransfer();
      const ids = reverse ? [toId, fromId] : [fromId, toId];
      expect(await balanceOf(aId)).toBe(900);

      await deleteSelection(ids);

      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`,
        [userId],
      );
      expect(n).toBe(0);
      expect(await balanceOf(aId)).toBe(1000);
      expect(await balanceOf(bId)).toBe(0);
    },
  );

  it("deletes an unrelated selected transfer leg beside a full pair", async () => {
    const [fromId, toId] = await createTransfer();
    const [from2, to2] = await createTransfer();

    await deleteSelection([fromId, from2, toId]);

    const rows = await dataSource.query(
      `SELECT id FROM transactions WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([]);
    expect(to2).toBeDefined();
  });
});
