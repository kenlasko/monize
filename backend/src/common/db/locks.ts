import { EntityManager } from "typeorm";

/**
 * The serialization primitives every writer of derived financial state shares.
 *
 * Two protocols maintain derived state in this codebase and they are not
 * compatible with each other:
 *
 *   1. an atomic delta -- `current_balance = current_balance + $1`;
 *   2. an absolute recomputation -- read the ledger, write the total.
 *
 * (1) is safe against another (1): the `UPDATE` re-reads the row after it wins
 * the row lock, so two deltas compose. (1) is *not* safe against (2): under
 * `READ COMMITTED` the recomputation's `SELECT` and its `UPDATE` are separate
 * statement snapshots, so a delta that commits between them is silently
 * overwritten with a total that never saw it (audit P4-005).
 *
 * The fix is not to pick one protocol -- it is to make every writer take the
 * same lock before it reads the inputs it will write back:
 *
 *   - `lockAccountsForBalanceWrite` for `accounts.current_balance`. A real row
 *     lock, which is what makes (1) and (2) compose: an absolute writer holding
 *     it forces a concurrent delta to wait, and the delta's `+ $1` then applies
 *     to the total the recomputation just committed. Conversely a recomputation
 *     that arrives second blocks on the row, and its ledger `SELECT` -- issued
 *     after the lock, so on a fresh snapshot -- sees the delta's ledger row.
 *
 *   - `lockHoldingScope` for `holdings`. A holding cannot always be row-locked
 *     (the row may not exist yet) and a rebuild must serialize against
 *     *investment_transactions inserts*, not just against holding rows, so the
 *     lock is an advisory one keyed by account.
 *
 *   - `lockTokenFamily` for a refresh-token family, whose members are inserted
 *     concurrently with the revocation that has to cover them (P4-011).
 *
 * Ordering rule, to keep these deadlock-free: **advisory locks are always taken
 * before row locks**, and a set of ids is always locked in ascending order.
 * `lockHoldingScope` and `lockAccountsForBalanceWrite` both sort; a caller that
 * needs both takes the advisory one first.
 *
 * **An investment write transaction therefore opens with
 * `lockHoldingScope`**, naming every account whose position it will re-derive,
 * before it saves a row or moves a balance. The rebuild at the end of such a
 * transaction takes the same lock, and a `pg_advisory_xact_lock` is re-entrant,
 * so the opening call adds a wait and never a second acquisition. Without it
 * the ledger write takes its `accounts` row lock first and the advisory one
 * last, the exact opposite of a status change reaching the same rows through
 * `applyParentStatusToEmbeddedRows`, and two concurrent writers deadlock
 * (`40P01`).
 *
 * **For `transactions` rows there is one more rule, and it is by role rather than
 * by id: a split parent is locked before any of its legs.** Ascending-id order
 * cannot be the whole answer here, because a caller cannot know a leg id until it
 * has read the split -- `removeSplit` necessarily locks the parent and only then
 * the leg. A batch that sorted parent and leg together would take them in the
 * opposite order whenever the leg's UUID sorts first, and two requests in
 * opposite orders is a `40P01` for both (audit RV4-005). With the parent always
 * first it becomes the serialization point: any two paths touching the same
 * parent's legs have already queued behind it, so their order among the legs
 * cannot matter. Legs are still batched ascending, which covers the paths that
 * lock several with no parent involved -- the two legs of an ordinary transfer,
 * including the cross-owner pair, where each side names its own leg and so must
 * sort rather than start from the one it was given.
 *
 * Every helper takes an `EntityManager` and must be called inside a
 * `withScopedDb` callback -- `pg_advisory_xact_lock` and `FOR UPDATE` are both
 * released by the enclosing transaction, which is the point: there is no
 * unlock to forget.
 */

/**
 * Advisory-lock namespaces. The first `pg_advisory_xact_lock` argument, so two
 * different kinds of lock cannot collide on a hashed id.
 *
 * Values are permanent: changing one silently stops serializing against every
 * other replica still running the old code during a rolling deploy.
 */
export enum LockScope {
  /** All holdings and investment-ledger work for one account. */
  Holdings = 1,
  /** One refresh-token family (rotation vs. revocation). */
  TokenFamily = 2,
  /** One user's import slot, held across a destructive wipe + import. */
  UserImport = 3,
  /** One user's transaction-rule list (positions, the per-user cap). */
  TransactionRules = 4,
  /**
   * The open review requests of one transaction (id = the transaction's id): a
   * request with no rule is outside the partial unique index, so queueing one
   * serializes here instead.
   */
  AiReviewRequests = 5,
}

/**
 * Take a transaction-scoped advisory lock on `(scope, id)`.
 *
 * `hashtext` maps the uuid onto the int4 the second lock argument needs. A hash
 * collision costs two unrelated ids one shared lock -- extra waiting, never a
 * missed exclusion -- which is the right direction for the failure to go.
 */
export async function acquireAdvisoryLock(
  manager: EntityManager,
  scope: LockScope,
  id: string,
): Promise<void> {
  await manager.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [
    scope,
    id,
  ]);
}

/**
 * Take advisory locks on every id, in ascending order.
 *
 * The ordering is the deadlock guard: a transfer locking two accounts and a
 * rebuild locking the same two in the order the query returned them would
 * otherwise be able to hold one another's next lock.
 */
export async function acquireAdvisoryLocks(
  manager: EntityManager,
  scope: LockScope,
  ids: readonly string[],
): Promise<void> {
  const ordered = [...new Set(ids)].sort();
  for (const id of ordered) {
    await acquireAdvisoryLock(manager, scope, id);
  }
}

/**
 * Serialize all holdings work for these accounts against every other holdings
 * writer -- incremental trades, splits, transfers and full rebuilds alike.
 *
 * A rebuild reads the investment ledger and then replaces the holdings derived
 * from it. A row lock on `holdings` cannot protect that: the trade it must not
 * lose inserts an `investment_transactions` row, which no holdings row locks.
 * So both sides take this lock before their first read instead.
 */
export function lockHoldingScope(
  manager: EntityManager,
  accountIds: readonly string[],
): Promise<void> {
  return acquireAdvisoryLocks(manager, LockScope.Holdings, accountIds);
}

/**
 * Serialize every write to one user's transaction-rule list. Create's
 * `max + 1`, the per-user cap, delete's compaction and reorder each read the
 * whole list and then write it; a row lock on one rule cannot stop a
 * concurrent insert of another, so the list is locked as a whole.
 */
export function lockTransactionRuleList(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  return acquireAdvisoryLock(manager, LockScope.TransactionRules, userId);
}

/** Serialize refresh-token rotation against family revocation. */
export function lockTokenFamily(
  manager: EntityManager,
  familyId: string,
): Promise<void> {
  return acquireAdvisoryLock(manager, LockScope.TokenFamily, familyId);
}

/**
 * Row-lock these accounts for a balance write, in ascending id order.
 *
 * Call this as the first statement of a transaction that will compute a balance
 * from the ledger and write it back absolutely. Holding it from before the
 * ledger `SELECT` until commit is what stops an atomic delta committing into
 * the gap; see the protocol note at the top of this file.
 *
 * Returns nothing: the lock is the effect. Rows that do not exist -- or that
 * are not `userId`'s when one is given -- are simply not locked, and the
 * caller's own `NotFound` handling still applies.
 *
 * Pass `userId` for an own-context balance write. It scopes the lock the same
 * way `lockTransactionRow`/`lockTransactionRows` do -- owner-scoping that holds
 * at every `RLS_MODE`, not only under enforcement, so a caller can never take a
 * balance-write lock on an account that is not the one it is authorised for.
 * Pass the id that owns the account (the account's own `user_id`); for a joint
 * account written in the owner's scope that is the owner, exactly as the
 * surrounding read uses.
 *
 * `userId` is omitted only by a *genuinely* cross-user caller: the hourly
 * future-dated fold runs under `withSystemContext` over every user in a
 * timezone bucket, so it locks accounts across owners by construction and cannot
 * name one. That is the sole exception; every own-context call site passes its
 * `userId`.
 */
export async function lockAccountsForBalanceWrite(
  manager: EntityManager,
  accountIds: readonly string[],
  userId?: string,
): Promise<void> {
  const ordered = [...new Set(accountIds)].sort();
  if (ordered.length === 0) return;
  if (userId === undefined) {
    await manager.query(
      `SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [ordered],
    );
    return;
  }
  await manager.query(
    `SELECT id FROM accounts WHERE id = ANY($1) AND user_id = $2 ORDER BY id FOR UPDATE`,
    [ordered, userId],
  );
}

/**
 * Row-lock one transaction and return the columns a balance delta is derived
 * from, or null when it is gone or not this user's.
 *
 * The whole point of this helper is *where* it is called: inside the write
 * transaction, so the "old" amount a delta reverses is the version the write
 * actually replaces. A snapshot loaded before the transaction is a different
 * claim -- that nothing changed in between -- and two concurrent updates each
 * reversing the same stale amount is the corruption in P4-003.
 */
export interface LockedTransactionRow {
  id: string;
  accountId: string;
  amount: number;
  transactionDate: string;
  status: string | null;
  isSplit: boolean;
  linkedTransactionId: string | null;
  parentTransactionId: string | null;
  /**
   * The parent's payee, carried for the same reason as `accountId` and
   * `transactionDate`: a split's transfer counterpart and its embedded
   * investment rows are *built* from the parent's fields, so building them from
   * the caller's snapshot writes a counterpart describing a parent that has
   * since moved account, date or payee (audit FV4-002).
   */
  payeeId: string | null;
  payeeName: string | null;
}

export async function lockTransactionRow(
  manager: EntityManager,
  id: string,
  userId: string,
): Promise<LockedTransactionRow | null> {
  const rows: {
    id: string;
    account_id: string;
    amount: string;
    transaction_date: string;
    status: string | null;
    is_split: boolean;
    linked_transaction_id: string | null;
    parent_transaction_id: string | null;
    payee_id: string | null;
    payee_name: string | null;
  }[] = await manager.query(
    `SELECT id,
            account_id,
            amount,
            TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date,
            status,
            COALESCE(is_split, false) AS is_split,
            linked_transaction_id,
            parent_transaction_id,
            payee_id,
            payee_name
       FROM transactions
      WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
    [id, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    amount: Number(row.amount),
    transactionDate: row.transaction_date,
    status: row.status,
    isSplit: row.is_split,
    linkedTransactionId: row.linked_transaction_id,
    parentTransactionId: row.parent_transaction_id,
    payeeId: row.payee_id,
    payeeName: row.payee_name,
  };
}

/**
 * Row-lock several transactions at once, ascending by id, and return what was
 * found keyed by id. Missing ids are simply absent -- a bulk caller has to
 * decide whether that is a 404 or a row another request already deleted.
 */
export async function lockTransactionRows(
  manager: EntityManager,
  ids: readonly string[],
  userId: string,
): Promise<Map<string, LockedTransactionRow>> {
  const ordered = [...new Set(ids)].sort();
  const found = new Map<string, LockedTransactionRow>();
  if (ordered.length === 0) return found;
  const rows: {
    id: string;
    account_id: string;
    amount: string;
    transaction_date: string;
    status: string | null;
    is_split: boolean;
    linked_transaction_id: string | null;
    parent_transaction_id: string | null;
    payee_id: string | null;
    payee_name: string | null;
  }[] = await manager.query(
    `SELECT id,
            account_id,
            amount,
            TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date,
            status,
            COALESCE(is_split, false) AS is_split,
            linked_transaction_id,
            parent_transaction_id,
            payee_id,
            payee_name
       FROM transactions
      WHERE id = ANY($1) AND user_id = $2
      ORDER BY id
        FOR UPDATE`,
    [ordered, userId],
  );
  for (const row of rows) {
    found.set(row.id, {
      id: row.id,
      accountId: row.account_id,
      amount: Number(row.amount),
      transactionDate: row.transaction_date,
      status: row.status,
      isSplit: row.is_split,
      linkedTransactionId: row.linked_transaction_id,
      parentTransactionId: row.parent_transaction_id,
      payeeId: row.payee_id,
      payeeName: row.payee_name,
    });
  }
  // A split parent must be locked before any of its legs (see the ordering rule
  // at the top of this file), and a single id-sorted batch cannot honour that:
  // if a leg's UUID sorts before its parent's, this call takes them in the
  // forbidden order and deadlocks against a `lockTransactionRow` parent-then-leg
  // path (audit RV4-005). So refuse a batch that mixes a parent with one of its
  // own legs -- such a caller must lock the parent first with
  // `lockTransactionRow`, then the leg. The throw rolls back the transaction,
  // releasing the locks this statement just took.
  for (const row of found.values()) {
    if (row.parentTransactionId && found.has(row.parentTransactionId)) {
      throw new Error(
        `lockTransactionRows must not lock a split parent and its leg in one ` +
          `call (parent ${row.parentTransactionId}, leg ${row.id}); lock the ` +
          `parent first with lockTransactionRow`,
      );
    }
  }
  return found;
}

/**
 * Row-lock one investment transaction and return the columns its holdings and
 * cash effects are derived from, or null when it is gone or not this user's.
 * Same P4-003 doctrine as `lockTransactionRow`: the status a transition is
 * refused or applied on, and the quantities a reversal is derived from, must
 * be the locked row's, not a snapshot loaded before the transaction.
 */
export interface LockedInvestmentTransactionRow {
  id: string;
  accountId: string;
  securityId: string | null;
  fundingAccountId: string | null;
  transactionId: string | null;
  transactionSplitId: string | null;
  linkedTransactionId: string | null;
  action: string;
  transactionDate: string;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number;
  exchangeRate: number;
  status: string;
}

export async function lockInvestmentTransactionRow(
  manager: EntityManager,
  id: string,
  userId: string,
): Promise<LockedInvestmentTransactionRow | null> {
  const rows: {
    id: string;
    account_id: string;
    security_id: string | null;
    funding_account_id: string | null;
    transaction_id: string | null;
    transaction_split_id: string | null;
    linked_transaction_id: string | null;
    action: string;
    transaction_date: string;
    quantity: string | null;
    price: string | null;
    commission: string | null;
    total_amount: string;
    exchange_rate: string;
    status: string;
  }[] = await manager.query(
    // includes VOID rows: records read -- a lock loads the row whatever its
    // status; the caller decides what the status means.
    `SELECT id,
            account_id,
            security_id,
            funding_account_id,
            transaction_id,
            transaction_split_id,
            linked_transaction_id,
            action,
            TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date,
            quantity,
            price,
            commission,
            total_amount,
            exchange_rate,
            status
       FROM investment_transactions
      WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
    [id, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    securityId: row.security_id,
    fundingAccountId: row.funding_account_id,
    transactionId: row.transaction_id,
    transactionSplitId: row.transaction_split_id,
    linkedTransactionId: row.linked_transaction_id,
    action: row.action,
    transactionDate: row.transaction_date,
    quantity: row.quantity === null ? null : Number(row.quantity),
    price: row.price === null ? null : Number(row.price),
    commission: Number(row.commission ?? 0),
    totalAmount: Number(row.total_amount),
    exchangeRate: Number(row.exchange_rate),
    status: row.status,
  };
}
