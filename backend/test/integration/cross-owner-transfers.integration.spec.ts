import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { DelegationService } from "@/delegation/delegation.service";
import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { User } from "@/users/entities/user.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext, withDelegateContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Q1 of the cross-owner-transfers plan: two real users plus delegation
 * fixtures, exercising the whole lifecycle -- create from both contexts,
 * grant gating, the frozen link after unshare, the STATELESS reshare
 * reconnect (no writes in between), the own-leg frozen delete, and the
 * fail-closed scope cuts.
 */
describe("Cross-owner transfers (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let delegationService: DelegationService;
  let history: ActionHistoryService;
  let dataSource: DataSource;

  let ownerId: string; // "A" -- shares an account
  let delegateId: string; // "B" -- has their own account too
  let ownerAccountId: string;
  let delegateAccountId: string;
  let delegationId: string;

  const actorB = () => ({
    effectiveUserId: delegateId,
    realUserId: delegateId,
  });

  async function createDelegation(): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [ownerId, delegateId],
    );
    return row.id;
  }

  async function grantOwnerAccount(flags: {
    create?: boolean;
    edit?: boolean;
    del?: boolean;
  }): Promise<void> {
    // The synchronize-built test schema lacks the (delegation_id, account_id)
    // unique constraint, so replace-then-insert instead of ON CONFLICT.
    await dataSource.query(
      `DELETE FROM account_delegate_grants
        WHERE delegation_id = $1 AND account_id = $2`,
      [delegationId, ownerAccountId],
    );
    await dataSource.query(
      `INSERT INTO account_delegate_grants
         (delegation_id, account_id, can_read, can_create, can_edit, can_delete)
       VALUES ($1, $2, true, $3, $4, $5)`,
      [
        delegationId,
        ownerAccountId,
        flags.create ?? false,
        flags.edit ?? false,
        flags.del ?? false,
      ],
    );
  }

  /** Hard-delete the delegation, exactly like revoke does (FK removes grants). */
  async function unshare(): Promise<void> {
    await dataSource.query(`DELETE FROM account_delegates WHERE id = $1`, [
      delegationId,
    ]);
  }

  /** Reshare from scratch: new delegation + grant rows, nothing else touched. */
  async function reshare(flags: {
    create?: boolean;
    edit?: boolean;
    del?: boolean;
  }): Promise<void> {
    delegationId = await createDelegation();
    await grantOwnerAccount(flags);
  }

  async function loadAccount(id: string): Promise<Account> {
    return (await dataSource.manager.findOne(Account, { where: { id } }))!;
  }

  async function loadTx(id: string): Promise<Transaction | null> {
    return dataSource.manager.findOne(Transaction, { where: { id } });
  }

  /** B creates the canonical cross-owner transfer B -> A from their own context. */
  async function createCrossOwnerTransfer(amount = 500) {
    return withUserContext(delegateId, () =>
      service.createTransfer(
        delegateId,
        {
          fromAccountId: delegateAccountId,
          toAccountId: ownerAccountId,
          transactionDate: "2026-01-15",
          amount,
          fromCurrencyCode: "USD",
        },
        actorB(),
      ),
    );
  }

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    delegationService = module.get(DelegationService);
    history = module.get(ActionHistoryService, { strict: false });
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "account_delegate_grants",
      "account_delegates",
      "tags",
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
    const owner = await createTestUserDirect(dataSource, {
      firstName: "Alice",
      lastName: "Owner",
    });
    ownerId = owner.id;
    const delegate = await createTestUserDirect(dataSource, {
      firstName: "Bob",
      lastName: "Delegate",
    });
    delegateId = delegate.id;

    ownerAccountId = (
      await createTestAccount(dataSource, ownerId, {
        name: "Owner Chequing",
        openingBalance: 5000,
        currentBalance: 5000,
      })
    ).id;
    delegateAccountId = (
      await createTestAccount(dataSource, delegateId, {
        name: "Delegate Savings",
        openingBalance: 2000,
        currentBalance: 2000,
      })
    ).id;

    delegationId = await createDelegation();
  });

  describe("create", () => {
    it("B (own context) transfers to A's granted account: per-leg user_id and both balances", async () => {
      await grantOwnerAccount({ create: true });

      const result = await createCrossOwnerTransfer(500);

      expect(result.fromTransaction.userId).toBe(delegateId);
      expect(result.toTransaction.userId).toBe(ownerId);
      expect(Number(result.fromTransaction.amount)).toBe(-500);
      expect(Number(result.toTransaction.amount)).toBe(500);
      expect(result.fromTransaction.linkedTransactionId).toBe(
        result.toTransaction.id,
      );
      expect(result.toTransaction.linkedTransactionId).toBe(
        result.fromTransaction.id,
      );

      expect((await loadAccount(delegateAccountId)).currentBalance).toBe(1500);
      expect((await loadAccount(ownerAccountId)).currentBalance).toBe(5500);

      // One history record per leg owner; the counterpart owner's entry
      // masks the foreign account name.
      const history = await dataSource.query(
        `SELECT user_id, description FROM action_history ORDER BY user_id`,
      );
      expect(history).toHaveLength(2);
      const ownerEntry = history.find(
        (h: { user_id: string }) => h.user_id === ownerId,
      );
      const delegateEntry = history.find(
        (h: { user_id: string }) => h.user_id === delegateId,
      );
      expect(ownerEntry.description).toContain("Shared account");
      expect(ownerEntry.description).not.toContain("Delegate Savings");
      expect(delegateEntry.description).toContain("Delegate Savings");
      expect(delegateEntry.description).toContain("Owner Chequing");
    });

    it("B acting as A can name their own account as the other leg", async () => {
      await grantOwnerAccount({ create: true });

      const result = await withDelegateContext(ownerId, delegateId, () =>
        service.createTransfer(
          ownerId,
          {
            fromAccountId: ownerAccountId,
            toAccountId: delegateAccountId,
            transactionDate: "2026-01-15",
            amount: 250,
            fromCurrencyCode: "USD",
          },
          { effectiveUserId: ownerId, realUserId: delegateId },
        ),
      );

      expect(result.fromTransaction.userId).toBe(ownerId);
      expect(result.toTransaction.userId).toBe(delegateId);
      expect((await loadAccount(ownerAccountId)).currentBalance).toBe(4750);
      expect((await loadAccount(delegateAccountId)).currentBalance).toBe(2250);
    });

    it("403s without the create grant, 404s without read", async () => {
      await grantOwnerAccount({}); // read-only
      await expect(createCrossOwnerTransfer()).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      await dataSource.query(
        `DELETE FROM account_delegate_grants WHERE delegation_id = $1`,
        [delegationId],
      );
      await expect(createCrossOwnerTransfer()).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("unshare (frozen link)", () => {
    it("keeps both legs, hides the counterpart, locks structural edits, allows presentational ones", async () => {
      await grantOwnerAccount({ create: true, edit: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);

      await unshare();

      // Both users keep their legs, still linked.
      expect((await loadTx(fromTransaction.id))!.linkedTransactionId).toBe(
        toTransaction.id,
      );
      expect((await loadTx(toTransaction.id))!.linkedTransactionId).toBe(
        fromTransaction.id,
      );

      // The counterpart is no longer readable.
      const linked = await withUserContext(delegateId, () =>
        service.getLinkedTransaction(delegateId, fromTransaction.id, actorB()),
      );
      expect(linked).toBeNull();

      // Structural edit -> frozen lock.
      await expect(
        withUserContext(delegateId, () =>
          service.updateTransfer(
            delegateId,
            fromTransaction.id,
            { amount: 999 },
            actorB(),
          ),
        ),
      ).rejects.toThrow(/locked/);

      // Presentational own-leg edit works and does not touch the counterpart.
      await withUserContext(delegateId, () =>
        service.updateTransfer(
          delegateId,
          fromTransaction.id,
          { description: "mine only" },
          actorB(),
        ),
      );
      expect((await loadTx(fromTransaction.id))!.description).toBe("mine only");
      expect((await loadTx(toTransaction.id))!.description).toBeNull();
    });

    it("frozen delete removes the own leg only and reverses only the own balance", async () => {
      await grantOwnerAccount({ create: true, del: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);
      await unshare();

      await withUserContext(delegateId, () =>
        service.removeTransfer(delegateId, fromTransaction.id, actorB()),
      );

      expect(await loadTx(fromTransaction.id)).toBeNull();
      const survivor = await loadTx(toTransaction.id);
      expect(survivor).not.toBeNull();
      expect(survivor!.linkedTransactionId).toBeNull(); // FK SET NULL detach
      expect((await loadAccount(delegateAccountId)).currentBalance).toBe(2000);
      expect((await loadAccount(ownerAccountId)).currentBalance).toBe(5500);
    });
  });

  describe("undo after an edit of a connected transfer", () => {
    it("is refused for both owners, who each keep their leg", async () => {
      await grantOwnerAccount({ create: true, edit: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);
      await settlePendingHistoryWrites();

      await withUserContext(delegateId, () =>
        service.updateTransfer(
          delegateId,
          fromTransaction.id,
          { amount: 700 },
          actorB(),
        ),
      );
      await settlePendingHistoryWrites();

      for (const userId of [delegateId, ownerId]) {
        await expect(
          withUserContext(userId, () => history.undo(userId)),
        ).rejects.toMatchObject({
          response: { errorCode: "UNDO_TRANSFER_CHANGE_NOT_SUPPORTED" },
        });
      }
      expect(await loadTx(fromTransaction.id)).not.toBeNull();
      expect(await loadTx(toTransaction.id)).not.toBeNull();
      expect((await loadAccount(delegateAccountId)).currentBalance).toBe(1300);
      expect((await loadAccount(ownerAccountId)).currentBalance).toBe(5700);
    });
  });

  describe("reshare (stateless reconnect)", () => {
    it("a full cross-leg edit works again with no writes in between", async () => {
      await grantOwnerAccount({ create: true, edit: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);

      await unshare();
      await expect(
        withUserContext(delegateId, () =>
          service.updateTransfer(
            delegateId,
            fromTransaction.id,
            { amount: 700 },
            actorB(),
          ),
        ),
      ).rejects.toThrow(/locked/);

      await reshare({ edit: true });

      await withUserContext(delegateId, () =>
        service.updateTransfer(
          delegateId,
          fromTransaction.id,
          { amount: 700 },
          actorB(),
        ),
      );

      expect(Number((await loadTx(fromTransaction.id))!.amount)).toBe(-700);
      expect(Number((await loadTx(toTransaction.id))!.amount)).toBe(700);
      expect((await loadAccount(delegateAccountId)).currentBalance).toBe(1300);
      expect((await loadAccount(ownerAccountId)).currentBalance).toBe(5700);
    });

    it("connected edits mirror structure but never the per-ledger status", async () => {
      await grantOwnerAccount({ create: true, edit: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);

      await withUserContext(delegateId, () =>
        service.updateTransfer(
          delegateId,
          fromTransaction.id,
          { description: "both sides", status: "CLEARED" as never },
          actorB(),
        ),
      );

      const fromLeg = (await loadTx(fromTransaction.id))!;
      const toLeg = (await loadTx(toTransaction.id))!;
      expect(fromLeg.description).toBe("both sides");
      expect(toLeg.description).toBe("both sides");
      expect(fromLeg.status).toBe("CLEARED");
      expect(toLeg.status).toBe("UNRECONCILED");
    });

    // Design decision 4 of docs/specs/provisional-amounts.md, across
    // the ownership boundary: the flag is a fact about the amount, which a
    // connected edit mirrors, so it is cleared on the other owner's leg when
    // an amount is stated for that leg, and by no other edit.
    it("a connected edit confirms the other owner's provisional leg only by stating a different amount for it", async () => {
      await grantOwnerAccount({ create: true, edit: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);
      // Only the importer sets the column; no request path can.
      await dataSource.query(
        `UPDATE transactions SET amount_is_provisional = true WHERE id = $1`,
        [toTransaction.id],
      );

      await withUserContext(delegateId, () =>
        service.updateTransfer(
          delegateId,
          fromTransaction.id,
          { description: "", amount: 500, toAmount: 500 },
          actorB(),
        ),
      );
      expect((await loadTx(toTransaction.id))!.amountIsProvisional).toBe(true);

      await withUserContext(delegateId, () =>
        service.updateTransfer(
          delegateId,
          fromTransaction.id,
          { amount: 600, toAmount: 600 },
          actorB(),
        ),
      );
      const toLeg = (await loadTx(toTransaction.id))!;
      expect(Number(toLeg.amount)).toBe(600);
      expect(toLeg.amountIsProvisional).toBe(false);
      expect((await loadTx(fromTransaction.id))!.amountIsProvisional).toBe(
        false,
      );
    });
  });

  describe("revoke safety", () => {
    it("never deletes a delegate who owns accounts", async () => {
      await grantOwnerAccount({ create: true });
      await createCrossOwnerTransfer(100);

      await withUserContext(ownerId, () =>
        delegationService.revokeDelegate(ownerId, delegationId),
      );

      const delegate = await dataSource.manager.findOne(User, {
        where: { id: delegateId },
      });
      expect(delegate).not.toBeNull();
      // Their leg survives too.
      const legs = await dataSource.query(
        `SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`,
        [delegateId],
      );
      expect(legs[0].n).toBe(1);
    });
  });

  describe("scope cuts fail closed", () => {
    it("a split transfer naming a foreign account 404s", async () => {
      await grantOwnerAccount({ create: true, edit: true, del: true });

      await expect(
        withUserContext(delegateId, () =>
          service.create(delegateId, {
            accountId: delegateAccountId,
            transactionDate: "2026-01-15",
            amount: -100,
            currencyCode: "USD",
            splits: [
              { amount: -50, transferAccountId: ownerAccountId },
              { amount: -50, transferAccountId: ownerAccountId },
            ],
          } as never),
        ),
      ).rejects.toThrow(/not found/i);
    });

    it("bulk tag updates never write onto the foreign counterpart", async () => {
      await grantOwnerAccount({ create: true, edit: true });
      const { fromTransaction, toTransaction } =
        await createCrossOwnerTransfer(500);

      const [tag] = await dataSource.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, 'shared-trip') RETURNING id`,
        [delegateId],
      );

      await withUserContext(delegateId, () =>
        service.bulkUpdate(delegateId, {
          mode: "ids",
          transactionIds: [fromTransaction.id],
          tagIds: [tag.id],
        } as never),
      );

      const tagged = await dataSource.query(
        `SELECT transaction_id FROM transaction_tags`,
      );
      const taggedIds = tagged.map(
        (r: { transaction_id: string }) => r.transaction_id,
      );
      expect(taggedIds).toContain(fromTransaction.id);
      expect(taggedIds).not.toContain(toTransaction.id);
    });
  });
});
