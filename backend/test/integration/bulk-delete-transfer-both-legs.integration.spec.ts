import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Account } from "@/accounts/entities/account.entity";
import { AiActionsService } from "@/ai/actions/ai-actions.service";
import type { BatchActionsDescriptor } from "@/ai/actions/ai-action.types";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The AI-assistant batch delete (and the MCP bulk and individual deletes, which
 * run the same rule) remove each selected row with `removeAny`. Deleting one
 * leg of a transfer removes its mirror, so a selection holding BOTH legs failed
 * on the second row with a 404 after the first had already written. `removeAny`
 * now returns the ids that are gone, and the caller skips a selected row that
 * is in that set, as the REST bulk delete does.
 *
 * The real `AiActionsService.executeBatchActions` is driven; only its
 * constructor is skipped (it pulls half the write surface and none of it takes
 * part in this property).
 */
describe("Delete of both legs of one transfer in a selection (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let ai: {
    executeBatchActions: (
      userId: string,
      descriptor: BatchActionsDescriptor,
    ) => Promise<{ count: number; ids: string[]; skipped: unknown[] }>;
  };
  let dataSource: DataSource;
  let userId: string;
  let aId: string;
  let bId: string;
  let cId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
    ai = Object.assign(Object.create(AiActionsService.prototype), {
      transactionsService: service,
    });
  });

  afterAll(async () => {
    await module.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
    const make = async (name: string, balance: number) =>
      (
        await createTestAccount(dataSource, userId, {
          name,
          openingBalance: balance,
          currentBalance: balance,
        })
      ).id;
    aId = await make("A", 1000);
    bId = await make("B", 0);
    cId = await make("C", 0);
  });

  async function balanceOf(accountId: string): Promise<number> {
    const account = await dataSource.manager.findOne(Account, {
      where: { id: accountId },
    });
    return Number(account!.currentBalance);
  }

  async function remainingIds(): Promise<string[]> {
    const rows: { id: string }[] = await dataSource.query(
      `SELECT id FROM transactions WHERE user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.id);
  }

  async function createTransfer(): Promise<[string, string]> {
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

  async function createSplitTransfer() {
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
    return { parentId: parent.id, bLegId: legIn(bId), cLegId: legIn(cId) };
  }

  function deleteSelection(ids: string[]) {
    return withUserContext(userId, () =>
      ai.executeBatchActions(userId, {
        type: "batch_actions",
        userId,
        actionId: "44444444-4444-4444-8444-444444444444",
        expiresAt: Date.now() + 60_000,
        operation: "delete",
        rows: ids.map((transactionId) => ({ transactionId })),
      } as BatchActionsDescriptor),
    );
  }

  async function expectNothingLeft() {
    expect(await remainingIds()).toEqual([]);
    expect(await balanceOf(aId)).toBe(1000);
    expect(await balanceOf(bId)).toBe(0);
    expect(await balanceOf(cId)).toBe(0);
  }

  it.each([
    ["from leg first", false],
    ["to leg first", true],
  ])(
    "deletes a transfer once when both legs are selected (%s)",
    async (_n, reverse) => {
      const [fromId, toId] = await createTransfer();
      expect(await balanceOf(aId)).toBe(900);

      const result = await deleteSelection(
        reverse ? [toId, fromId] : [fromId, toId],
      );

      expect(result.count).toBe(2);
      expect(result.skipped).toEqual([]);
      await expectNothingLeft();
    },
  );

  it("deletes a second transfer selected beside a full pair", async () => {
    const [fromId, toId] = await createTransfer();
    const [from2, to2] = await createTransfer();

    const result = await deleteSelection([fromId, from2, toId]);

    expect(result.count).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(await remainingIds()).not.toContain(to2);
    await expectNothingLeft();
  });

  it("still deletes the mirror leg when the first leg's delete failed", async () => {
    const [fromId, toId] = await createTransfer();
    const real = service.removeAny.bind(service);
    jest
      .spyOn(service, "removeAny")
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(real);

    const result = await deleteSelection([fromId, toId]);

    expect(result.count).toBe(1);
    expect(result.skipped).toHaveLength(1);
    await expectNothingLeft();
  });

  it("deletes a mirror the first delete did not remove (unlinked meanwhile)", async () => {
    const [fromId, toId] = await createTransfer();
    // The mirror was unlinked after the selection was prepared: the first
    // delete cannot reach it, so it is deleted on its own.
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = NULL, is_transfer = false
        WHERE id IN ($1, $2)`,
      [fromId, toId],
    );

    const result = await deleteSelection([fromId, toId]);

    expect(result.count).toBe(2);
    expect(await remainingIds()).toEqual([]);
  });

  it("counts a split's transfer leg as removed with its selected parent", async () => {
    const { parentId, bLegId } = await createSplitTransfer();

    const result = await deleteSelection([parentId, bLegId]);

    expect(result.count).toBe(2);
    expect(result.skipped).toEqual([]);
    await expectNothingLeft();
  });

  it("deletes a split's leg then its parent", async () => {
    const { parentId, bLegId } = await createSplitTransfer();

    const result = await deleteSelection([bLegId, parentId]);

    expect(result.count).toBe(2);
    expect(result.skipped).toEqual([]);
    await expectNothingLeft();
  });

  it("deletes every leg of a split selected without its parent", async () => {
    const { bLegId, cLegId } = await createSplitTransfer();

    const result = await deleteSelection([bLegId, cLegId]);

    expect(result.count).toBe(2);
    expect(result.skipped).toEqual([]);
    await expectNothingLeft();
  });
});
