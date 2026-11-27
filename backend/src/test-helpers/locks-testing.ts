import type { LockedTransactionRow } from "../common/db/locks";

/**
 * Unit-test harness for the row/advisory locks in `common/db/locks`.
 *
 * The real helpers issue `SELECT pg_advisory_xact_lock(...)` and
 * `SELECT ... FOR UPDATE` through the manager. In a unit test that manager is a
 * jest mock whose `query` is usually driven by a `mockResolvedValueOnce` chain,
 * so a lock statement would silently eat one of the spec's queued answers and
 * shift every assertion after it -- a failure that looks like a logic bug and is
 * not one.
 *
 * So specs mock the module instead:
 *
 *   jest.mock("../common/db/locks", () =>
 *     jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
 *   );
 *
 * and stub the readers they depend on with `stubLockedTransaction`. Whether the
 * locks are actually *taken* is not a question a mocked manager can answer -- the
 * two-connection integration specs cover that, and `locks.spec.ts` covers the
 * SQL each helper emits.
 */

/** A `LockedTransactionRow` with sensible defaults; override what matters. */
export function lockedTransactionRow(
  overrides: Partial<LockedTransactionRow> = {},
): LockedTransactionRow {
  return {
    id: "tx-1",
    accountId: "acc-1",
    amount: 0,
    transactionDate: "2026-01-15",
    status: "UNRECONCILED",
    isSplit: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName: null,
    ...overrides,
  };
}

/**
 * Module factory for `jest.mock` of `src/common/db/locks`.
 *
 * The advisory/row-lock acquirers resolve to nothing, which is what they do for
 * real. The two readers default to "row not found" so a spec that forgets to
 * stub them fails loudly with the service's own NotFound rather than proceeding
 * on `undefined`.
 */
export function locksMockModule() {
  const actual = jest.requireActual("../common/db/locks");
  return {
    LockScope: actual.LockScope,
    acquireAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    acquireAdvisoryLocks: jest.fn().mockResolvedValue(undefined),
    lockHoldingScope: jest.fn().mockResolvedValue(undefined),
    lockTokenFamily: jest.fn().mockResolvedValue(undefined),
    lockTransactionRuleList: jest.fn().mockResolvedValue(undefined),
    lockCategoryOwnerShared: jest.fn().mockResolvedValue(undefined),
    lockCategoryOwnerExclusive: jest.fn().mockResolvedValue(undefined),
    lockAccountsForBalanceWrite: jest.fn().mockResolvedValue(undefined),
    lockTransactionRow: jest.fn().mockResolvedValue(null),
    lockTransactionRows: jest.fn().mockResolvedValue(new Map()),
    lockWarrantyRow: jest.fn().mockResolvedValue(null),
    lockInvestmentTransactionRow: jest.fn().mockResolvedValue(null),
  };
}

/**
 * Point the mocked `lockTransactionRow`/`lockTransactionRows` at these rows.
 *
 * Pass the rows a spec's scenario has; both readers are stubbed together because
 * a service usually uses whichever fits and a spec should not have to know which.
 */
export function stubLockedTransactions(
  locks: {
    lockTransactionRow: jest.Mock;
    lockTransactionRows: jest.Mock;
  },
  rows: LockedTransactionRow[],
): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  locks.lockTransactionRow.mockImplementation(
    async (_m, id: string) => byId.get(id) ?? null,
  );
  locks.lockTransactionRows.mockImplementation(
    async (_m, ids: readonly string[]) =>
      new Map(
        [...new Set(ids)]
          .filter((id) => byId.has(id))
          .map((id) => [id, byId.get(id)!]),
      ),
  );
}
