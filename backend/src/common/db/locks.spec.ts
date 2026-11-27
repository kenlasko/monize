import { EntityManager } from "typeorm";
import {
  LockScope,
  acquireAdvisoryLock,
  acquireAdvisoryLocks,
  lockAccountsForBalanceWrite,
  lockCategoryOwnerExclusive,
  lockCategoryOwnerShared,
  lockHoldingScope,
  lockTokenFamily,
  lockTransactionRow,
  lockTransactionRows,
  lockWarrantyRow,
} from "./locks";
import { locksMockModule } from "../../test-helpers/locks-testing";

/**
 * These specs assert the SQL each helper emits and the order it emits it in.
 *
 * Whether the locks actually exclude anything is a question only two real
 * connections can answer, and the integration suites cover that. What a unit
 * spec can pin down is the part that goes wrong silently: a lock that ends up
 * *after* the read it was meant to protect, or a set of ids locked in whatever
 * order the query returned them, which is how two writers deadlock on each
 * other's second lock.
 */
describe("common/db/locks", () => {
  let manager: { query: jest.Mock };

  beforeEach(() => {
    manager = { query: jest.fn().mockResolvedValue([]) };
  });

  const asManager = () => manager as unknown as EntityManager;

  describe("category-owner lock", () => {
    it("takes the shared form for a write and the exclusive form for a type change, on one key", async () => {
      await lockCategoryOwnerShared(asManager(), "user-1");
      await lockCategoryOwnerExclusive(asManager(), "user-1");

      expect(manager.query.mock.calls).toEqual([
        [
          "SELECT pg_advisory_xact_lock_shared($1::int, hashtext($2))",
          [LockScope.CategoryOwner, "user-1"],
        ],
        [
          "SELECT pg_advisory_xact_lock($1::int, hashtext($2))",
          [LockScope.CategoryOwner, "user-1"],
        ],
      ]);
    });

    it("uses the namespace the database triggers hard-code", () => {
      // database/schema.sql: pg_advisory_xact_lock_shared(10, hashtext(owner)).
      expect(LockScope.CategoryOwner).toBe(10);
    });
  });

  describe("advisory locks", () => {
    it("keys the lock on a namespace and a hashed id", async () => {
      await acquireAdvisoryLock(asManager(), LockScope.Holdings, "acc-1");

      expect(manager.query).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock($1::int, hashtext($2))",
        [LockScope.Holdings, "acc-1"],
      );
    });

    it("locks a set in ascending order, de-duplicated", async () => {
      // The deadlock guard: a transfer locking two accounts and a rebuild
      // locking the same two must take them in the same order, or each can end
      // up holding the other's next lock.
      await acquireAdvisoryLocks(asManager(), LockScope.Holdings, [
        "acc-c",
        "acc-a",
        "acc-b",
        "acc-a",
      ]);

      expect(manager.query.mock.calls.map((c) => c[1][1])).toEqual([
        "acc-a",
        "acc-b",
        "acc-c",
      ]);
    });

    it("gives each kind of lock its own namespace", async () => {
      // Two different kinds of lock must not be able to collide on a hashed id.
      await lockHoldingScope(asManager(), ["x"]);
      await lockTokenFamily(asManager(), "x");

      const namespaces = manager.query.mock.calls.map((c) => c[1][0]);
      expect(new Set(namespaces).size).toBe(2);
    });
  });

  describe("lockAccountsForBalanceWrite", () => {
    it("row-locks the accounts in ascending id order, scoped to the owner", async () => {
      await lockAccountsForBalanceWrite(asManager(), ["b", "a", "b"], "user-1");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FROM accounts");
      expect(sql).toContain("ORDER BY id");
      expect(sql).toContain("FOR UPDATE");
      // Owner-scoped like the transaction lock helpers, so a balance-write lock
      // can never land on an account that is not the caller's.
      expect(sql).toContain("user_id = $2");
      expect(params).toEqual([["a", "b"], "user-1"]);
    });

    it("locks without an owner predicate for a genuinely cross-user caller", async () => {
      // The hourly future-dated fold runs under withSystemContext across every
      // owner in a timezone bucket and passes no userId; it must still lock, just
      // unscoped -- the one deliberate exception to owner-scoping.
      await lockAccountsForBalanceWrite(asManager(), ["b", "a"]);

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FOR UPDATE");
      expect(sql).not.toContain("user_id");
      expect(params).toEqual([["a", "b"]]);
    });

    it("issues nothing for an empty set", async () => {
      await lockAccountsForBalanceWrite(asManager(), [], "user-1");

      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe("lockTransactionRow", () => {
    it("selects FOR UPDATE, scoped to the owner", async () => {
      manager.query.mockResolvedValue([
        {
          id: "tx-1",
          account_id: "acc-1",
          amount: "-20.0000",
          transaction_date: "2026-01-15",
          status: "CLEARED",
          is_split: false,
          linked_transaction_id: null,
          parent_transaction_id: null,
          payee_id: "payee-1",
          payee_name: "Corner Store",
        },
      ]);

      const row = await lockTransactionRow(asManager(), "tx-1", "user-1");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FOR UPDATE");
      expect(sql).toContain("user_id = $2");
      expect(sql).toContain("payee_id");
      expect(sql).toContain("payee_name");
      expect(params).toEqual(["tx-1", "user-1"]);
      // The amount arrives as a decimal string from the driver and must reach
      // the caller as a number -- a balance delta computed from a string
      // concatenates. payee_id/payee_name are carried so a split's counterpart
      // and embedded investment rows are built from the locked parent, not a
      // stale snapshot (audit FV4-002).
      expect(row).toEqual({
        id: "tx-1",
        accountId: "acc-1",
        amount: -20,
        transactionDate: "2026-01-15",
        status: "CLEARED",
        isSplit: false,
        linkedTransactionId: null,
        parentTransactionId: null,
        payeeId: "payee-1",
        payeeName: "Corner Store",
      });
    });

    it("selects the date as text, not as a Date", async () => {
      // A raw select bypasses the entity transformer, so a DATE column comes back
      // as a JS Date parsed in UTC -- and reading it can shift the day. See the
      // raw-select rule in docs/backend/entities-and-dtos.md.
      await lockTransactionRow(asManager(), "tx-1", "user-1");

      expect(manager.query.mock.calls[0][0]).toContain(
        "TO_CHAR(transaction_date, 'YYYY-MM-DD')",
      );
    });

    it("returns null when no row matched", async () => {
      manager.query.mockResolvedValue([]);

      expect(
        await lockTransactionRow(asManager(), "tx-1", "user-1"),
      ).toBeNull();
    });
  });

  describe("lockWarrantyRow", () => {
    it("selects FOR UPDATE, scoped to the owner", async () => {
      manager.query.mockResolvedValue([{ id: "wty-1" }]);

      const row = await lockWarrantyRow(asManager(), "wty-1", "user-1");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FROM warranties");
      expect(sql).toContain("FOR UPDATE");
      expect(sql).toContain("user_id = $2");
      expect(params).toEqual(["wty-1", "user-1"]);
      expect(row).toEqual({ id: "wty-1" });
    });

    it("returns null when no row matched", async () => {
      manager.query.mockResolvedValue([]);

      expect(await lockWarrantyRow(asManager(), "wty-1", "user-1")).toBeNull();
    });
  });

  describe("lockTransactionRows", () => {
    it("locks in ascending id order and returns what it found", async () => {
      manager.query.mockResolvedValue([
        {
          id: "tx-a",
          account_id: "acc-1",
          amount: "10.0000",
          transaction_date: "2026-01-15",
          status: null,
          is_split: false,
          linked_transaction_id: null,
          parent_transaction_id: null,
          payee_id: "payee-a",
          payee_name: "Store A",
        },
      ]);

      const found = await lockTransactionRows(
        asManager(),
        ["tx-b", "tx-a", "tx-b"],
        "user-1",
      );

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("ORDER BY id");
      expect(sql).toContain("FOR UPDATE");
      expect(sql).toContain("payee_id");
      expect(sql).toContain("payee_name");
      expect(params).toEqual([["tx-a", "tx-b"], "user-1"]);
      // A row that is gone is absent, not zero-valued: a caller must be able to
      // tell "no longer there" from "there with amount 0", because reversing a
      // balance for a row another request already deleted is the double-delete
      // corruption in P4-003.
      expect([...found.keys()]).toEqual(["tx-a"]);
      expect(found.get("tx-a")!.amount).toBe(10);
      // The parent's payee travels with the locked row so a split counterpart is
      // built from it and not a stale snapshot (audit FV4-002).
      expect(found.get("tx-a")!.payeeId).toBe("payee-a");
      expect(found.get("tx-a")!.payeeName).toBe("Store A");
    });

    it("refuses a batch that mixes a split parent with its own leg", async () => {
      // Ascending-id order cannot honour "parent before leg" (audit RV4-005): if
      // the leg's UUID sorts first, this call would take them in the forbidden
      // order and deadlock against a lockTransactionRow parent-then-leg path. The
      // misuse must fail fast rather than deadlock in production.
      manager.query.mockResolvedValue([
        {
          id: "parent-tx",
          account_id: "acc-1",
          amount: "0",
          transaction_date: "2026-01-15",
          status: null,
          is_split: true,
          linked_transaction_id: null,
          parent_transaction_id: null,
          payee_id: null,
          payee_name: null,
        },
        {
          id: "leg-tx",
          account_id: "acc-1",
          amount: "10.0000",
          transaction_date: "2026-01-15",
          status: null,
          is_split: false,
          linked_transaction_id: null,
          parent_transaction_id: "parent-tx",
          payee_id: null,
          payee_name: null,
        },
      ]);

      await expect(
        lockTransactionRows(asManager(), ["parent-tx", "leg-tx"], "user-1"),
      ).rejects.toThrow(/split parent and its leg/);
    });

    it("issues nothing for an empty set", async () => {
      const found = await lockTransactionRows(asManager(), [], "user-1");

      expect(manager.query).not.toHaveBeenCalled();
      expect(found.size).toBe(0);
    });
  });

  describe("locksMockModule (test-double drift guard)", () => {
    it("exposes exactly the runtime module's exports", () => {
      // A new export added to locks.ts but not to the mock factory would resolve
      // to `undefined` in every spec that mocks this module -- a silent hole. Pin
      // the mock's key set to the real module's runtime exports so the two cannot
      // drift.
      const real = jest.requireActual("./locks") as Record<string, unknown>;
      const mock = locksMockModule() as Record<string, unknown>;
      expect(Object.keys(mock).sort()).toEqual(Object.keys(real).sort());
    });
  });
});
