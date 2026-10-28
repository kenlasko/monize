import {
  Injectable,
  BadRequestException,
  Inject,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplitService } from "./transaction-split.service";
import {
  assertVoidTransitionAllowedOnRow,
  applyVoidTransitionToMirrorLeg,
} from "./void-status-transition.util";
import { AccountsService } from "../accounts/accounts.service";
import {
  isTransactionInFuture,
  formatDateYMDLocal,
  todayYMD,
} from "../common/date-utils";
import {
  STALE_UNRECONCILED_DAYS,
  staleCutoffDate,
  type StaleUnreconciledSummary,
} from "./stale-reconciliation";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTransactionRow } from "../common/db/locks";
import { verifySourceAccrualEdit } from "../accruals/accrual-source-edit";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";
import {
  assertReconciledRowsMutable,
  isReconciledUndo,
  reconciledLockedError,
} from "./reconciled-lock.util";

/** What a transition resolver returns, or it throws to refuse the transition. */
interface ResolvedTransition {
  readonly status: TransactionStatus;
  /** Wipe `reconciled_date`, for the transition that undoes a reconciliation. */
  readonly clearReconciledDate?: boolean;
}

@Injectable()
export class TransactionReconciliationService {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionSplitService))
    private splitService: TransactionSplitService,
    private dataSource: DataSource,
  ) {}

  /**
   * Apply one status transition as a compare-and-set against the row's own
   * committed status.
   *
   * Every guard these entry points apply -- "not already reconciled", "not
   * void", "must currently be reconciled" -- is a decision about the *current*
   * status, and so is the balance adjustment: crossing into or out of `VOID` is
   * the only transition that moves money. Reading that status from a snapshot
   * loaded before the transaction made both wrong at once. A request holding a
   * `RECONCILED` snapshot could unreconcile a row another request had since
   * voided: `wasVoid` computed from the snapshot said false, `isVoid` said
   * false, so no balance adjustment ran -- while the row went from VOID back to
   * CLEARED, putting its amount back in the ledger with nothing putting it back
   * in the balance.
   *
   * So the resolver runs here, inside the transaction, against the locked row.
   * `oldStatus` is the version this write actually replaces, and a guard that
   * refuses does so before anything is written.
   */
  private async applyStatusTransition(
    userId: string,
    transactionId: string,
    resolve: (current: TransactionStatus) => ResolvedTransition,
    /** Inside the transaction, after the row lock, before any write. */
    beforeWrite?: (m: EntityManager) => Promise<void>,
    accrualImpactFingerprint?: string,
  ): Promise<{
    accountId: string;
    balanceMoved: boolean;
    /** Accounts a counterpart or split propagation moved besides the row's own. */
    counterpartAccountIds: string[];
  }> {
    // Securities of embedded investment rows that crossed the VOID boundary
    // with a split parent, repriced by the bond engine after the commit
    // (INV-BOND-005, INV-CACHE-001).
    const touchedSecurityIds = new Set<string>();
    const result = await withScopedDb(this.dataSource, async (m) => {
      // First lock of the transaction: advisory before row locks
      // (`common/db/locks.ts`). If this row is a split parent whose legs carry
      // embedded investment rows, those rows are rebuilt under the holdings
      // advisory lock, and `InvestmentTransactionsService.update()` reaches the
      // same parent the other way round -- advisory lock first, then this
      // parent's `FOR UPDATE`. Taking the advisory lock after the row lock left
      // the two paths each holding the other's next lock (40P01).
      //
      // Unconditional, and before the row is read: what the row is cannot be
      // known without locking it, and the ids come from an unlocked `SELECT`
      // inside the helper, which takes no lock and so may precede the advisory
      // one. A row with no embedded investment legs locks nothing.
      await this.splitService.lockEmbeddedInvestmentScopes(m, userId, [
        transactionId,
      ]);

      const locked = await lockTransactionRow(m, transactionId, userId);
      if (!locked) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transactionId} not found`,
            { id: transactionId },
          ),
        );
      }

      if (beforeWrite) await beforeWrite(m);
      const oldStatus = locked.status as TransactionStatus;

      // Strict reconciled lock. A status change away from RECONCILED is an
      // alteration of a reconciled row, so it is refused here alongside edits
      // and deletes -- otherwise "unreconcile, then edit" is the lock's own
      // bypass, one click from the row it protects.
      //
      // The exception is the row the user reconciled seconds ago: a click is
      // not settled history, and with the lock on the very next click used to
      // be refused, so a misclick on the register's status cell was permanent
      // and the way out was disabling the lock for the whole ledger. The window
      // is asked of the row (`isWithinReconciledUndoWindow`), never of the
      // request, so it is the same ten seconds wherever the click came from.
      const { undoWindowOpen } = await assertReconciledRowsMutable(
        m,
        userId,
        [locked],
        { undoWindowFor: transactionId },
      );

      const { status, clearReconciledDate } = resolve(oldStatus);

      // Inside the window the lock yields to an undo and to nothing else. A
      // VOID moves money, and a ten-second door into it is not what "press it
      // again to take the reconcile back" asked for.
      if (undoWindowOpen && !isReconciledUndo(oldStatus, status)) {
        throw reconciledLockedError();
      }

      const wasVoid = oldStatus === TransactionStatus.VOID;
      const isVoid = status === TransactionStatus.VOID;
      const balanceMoved = wasVoid !== isVoid;

      // A VOID boundary changes recognized income/expense as well as cash.
      // Validate the same source preview as ordinary edits under this lock,
      // before balances or statuses move. Clearing/reconciling only changes
      // metadata and can refresh without a financial-impact confirmation.
      if (balanceMoved || accrualImpactFingerprint !== undefined) {
        await verifySourceAccrualEdit(
          m,
          userId,
          transactionId,
          { status },
          accrualImpactFingerprint,
        );
      }

      // Crossing the VOID boundary carries the same obligations here as on
      // every other route: a split-transfer counterpart leg is refused (the
      // pairing belongs to the parent), a mirror transfer leg takes its
      // counterpart with it, and a split parent takes its children's
      // counterparts. Leaving this endpoint without them made
      // PATCH /transactions/:id/status the one door into the divergent-pair
      // states the transfer, split and bulk routes refuse.
      const counterpartAccountIds: string[] = [];
      if (balanceMoved) {
        await assertVoidTransitionAllowedOnRow(m, transactionId);
      }

      const fields: Partial<Transaction> = { status };
      if (
        status === TransactionStatus.RECONCILED &&
        oldStatus !== TransactionStatus.RECONCILED
      ) {
        fields.reconciledDate = formatDateYMDLocal(new Date());
      } else if (clearReconciledDate) {
        fields.reconciledDate = null;
      }

      if (isTransactionInFuture(locked.transactionDate)) {
        await m.update(Transaction, transactionId, fields);
        if (balanceMoved) {
          await this.accountsService.recalculateCurrentBalance(
            userId,
            locked.accountId,
          );
        }
      } else {
        if (wasVoid && !isVoid) {
          await this.accountsService.updateBalance(
            locked.accountId,
            locked.amount,
          );
        } else if (!wasVoid && isVoid) {
          await this.accountsService.updateBalance(
            locked.accountId,
            -locked.amount,
          );
        }
        await m.update(Transaction, transactionId, fields);
      }

      if (balanceMoved) {
        if (locked.isSplit) {
          for (const affected of await this.splitService.applyParentStatusToTransferCounterparts(
            m,
            transactionId,
            userId,
            status,
            touchedSecurityIds,
          )) {
            counterpartAccountIds.push(affected);
          }
        } else {
          counterpartAccountIds.push(
            ...(await applyVoidTransitionToMirrorLeg(
              m,
              this.accountsService,
              userId,
              locked,
              status,
            )),
          );
        }
      }

      await refreshSourceAccruals(m, userId, transactionId);

      return {
        accountId: locked.accountId,
        balanceMoved,
        counterpartAccountIds,
      };
    });
    await this.splitService.recomputeBondPricesAfterWrite(
      userId,
      touchedSecurityIds,
    );
    return result;
  }

  async updateStatus(
    userId: string,
    transactionId: string,
    status: TransactionStatus,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
    accrualImpactFingerprint?: string,
  ): Promise<Transaction> {
    const { accountId, balanceMoved, counterpartAccountIds } =
      await this.applyStatusTransition(
        userId,
        transactionId,
        () => ({
          status,
        }),
        undefined,
        accrualImpactFingerprint,
      );

    if (balanceMoved) {
      triggerNetWorthRecalc(accountId, userId);
      for (const affected of new Set(counterpartAccountIds)) {
        if (affected !== accountId) triggerNetWorthRecalc(affected, userId);
      }
    }

    return findOne(userId, transactionId);
  }

  async markCleared(
    userId: string,
    transactionId: string,
    isCleared: boolean,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
    beforeWrite?: (m: EntityManager) => Promise<void>,
  ): Promise<Transaction> {
    const { accountId, balanceMoved } = await this.applyStatusTransition(
      userId,
      transactionId,
      (current) => {
        if (
          current === TransactionStatus.RECONCILED ||
          current === TransactionStatus.VOID
        ) {
          throw new BadRequestException(
            tr(
              "errors.transactions.cannotChangeClearedStatusOfReconciledOrVoid",
              "Cannot change cleared status of reconciled or void transactions",
            ),
          );
        }
        return {
          status: isCleared
            ? TransactionStatus.CLEARED
            : TransactionStatus.UNRECONCILED,
        };
      },
      beforeWrite,
    );

    if (balanceMoved) {
      triggerNetWorthRecalc(accountId, userId);
    }

    return findOne(userId, transactionId);
  }

  async reconcile(
    userId: string,
    transactionId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    const { accountId, balanceMoved } = await this.applyStatusTransition(
      userId,
      transactionId,
      (current) => {
        if (current === TransactionStatus.RECONCILED) {
          throw new BadRequestException(
            tr(
              "errors.transactions.alreadyReconciled",
              "Transaction is already reconciled",
            ),
          );
        }
        if (current === TransactionStatus.VOID) {
          throw new BadRequestException(
            tr(
              "errors.transactions.cannotReconcileVoid",
              "Cannot reconcile a void transaction",
            ),
          );
        }
        return { status: TransactionStatus.RECONCILED };
      },
    );

    if (balanceMoved) {
      triggerNetWorthRecalc(accountId, userId);
    }

    return findOne(userId, transactionId);
  }

  async unreconcile(
    userId: string,
    transactionId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    await this.applyStatusTransition(userId, transactionId, (current) => {
      if (current !== TransactionStatus.RECONCILED) {
        throw new BadRequestException(
          tr(
            "errors.transactions.notReconciled",
            "Transaction is not reconciled",
          ),
        );
      }
      return { status: TransactionStatus.CLEARED, clearReconciledDate: true };
    });

    return findOne(userId, transactionId);
  }

  /**
   * Every account the user reconciles that has register rows left outstanding.
   *
   * Scoped to accounts with at least one RECONCILED row -- reconciliation is
   * opt-in per account, and an account nobody reconciles has no overdue rows
   * (`stale-reconciliation.ts` has the reasoning and the two reasons).
   *
   * The counts are disjoint by arithmetic rather than by a second predicate:
   * `missed_count` is the one comparison the database makes, and `overdue` is
   * whatever is left of the selection. That keeps `classifyStaleRow`'s rule --
   * missed wins over overdue -- from having to be written twice in two
   * languages that cannot be diffed.
   *
   * Closed accounts are excluded: their balances are settled and there is
   * nothing the user can act on.
   */
  async getStaleUnreconciled(
    userId: string,
  ): Promise<StaleUnreconciledSummary> {
    const overdueBefore = staleCutoffDate(todayYMD(), STALE_UNRECONCILED_DAYS);

    const rows: {
      account_id: string;
      account_name: string;
      currency_code: string;
      count: string;
      oldest_date: string;
      last_reconciled_date: string;
      missed_count: string;
    }[] = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `WITH reconciled AS (
           SELECT account_id, MAX(transaction_date) AS last_reconciled_date
             FROM transactions
            WHERE user_id = $1
              AND status = $2
              AND parent_transaction_id IS NULL
            GROUP BY account_id
         )
         SELECT a.id AS account_id,
                a.name AS account_name,
                a.currency_code,
                COUNT(*)::text AS count,
                TO_CHAR(MIN(t.transaction_date), 'YYYY-MM-DD') AS oldest_date,
                TO_CHAR(r.last_reconciled_date, 'YYYY-MM-DD') AS last_reconciled_date,
                COUNT(*) FILTER (
                  WHERE t.transaction_date <= r.last_reconciled_date
                )::text AS missed_count
           FROM transactions t
           JOIN reconciled r ON r.account_id = t.account_id
           JOIN accounts a ON a.id = t.account_id
          WHERE t.user_id = $1
            AND t.parent_transaction_id IS NULL
            AND t.status <> $2
            AND t.status <> $3
            AND a.is_closed = false
            AND (
              t.transaction_date <= r.last_reconciled_date
              OR t.transaction_date < $4::date
            )
          GROUP BY a.id, a.name, a.currency_code, r.last_reconciled_date
          ORDER BY MIN(t.transaction_date) ASC`,
        [
          userId,
          TransactionStatus.RECONCILED,
          TransactionStatus.VOID,
          overdueBefore,
        ],
      ),
    );

    const accounts = rows.map((row) => {
      // Raw selects bypass the entity transformers, so every aggregate arrives
      // as a string and the dates are already TO_CHAR'd above.
      const count = Number(row.count);
      const missedCount = Number(row.missed_count);
      return {
        accountId: row.account_id,
        accountName: row.account_name,
        currencyCode: row.currency_code,
        count,
        oldestDate: row.oldest_date,
        lastReconciledDate: row.last_reconciled_date,
        missedCount,
        overdueCount: count - missedCount,
      };
    });

    return {
      staleAfterDays: STALE_UNRECONCILED_DAYS,
      overdueBefore,
      accounts,
      totalCount: accounts.reduce((sum, account) => sum + account.count, 0),
    };
  }

  async getReconciliationData(
    userId: string,
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ): Promise<{
    transactions: Transaction[];
    reconciledBalance: number;
    clearedBalance: number;
    difference: number;
    /**
     * The account's most recent reconciled date, or null when it has never
     * been reconciled. The client classifies each listed row against it with
     * the same `classifyStaleRow` rule the reminder count uses, so the row
     * highlight and the badge cannot disagree about what "overdue" means.
     */
    lastReconciledDate: string | null;
    staleAfterDays: number;
    overdueBefore: string;
  }> {
    const overdueBefore = staleCutoffDate(todayYMD(), STALE_UNRECONCILED_DAYS);
    const [account, transactions, reconciledResult, clearedResult, lastRow] =
      await withScopedDb(this.dataSource, async (m) => {
        const owned = await this.accountsService.findOne(userId, accountId);
        const listed = await m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .leftJoinAndSelect("transaction.payee", "payee")
          .leftJoinAndSelect("transaction.category", "category")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status IN (:...statuses)", {
            statuses: [
              TransactionStatus.UNRECONCILED,
              TransactionStatus.CLEARED,
            ],
          })
          .andWhere("transaction.transactionDate <= :statementDate", {
            statementDate,
          })
          .orderBy("transaction.transactionDate", "ASC")
          .addOrderBy("transaction.createdAt", "ASC")
          .getMany();
        const reconciled = await m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .select("SUM(transaction.amount)", "sum")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status = :status", {
            status: TransactionStatus.RECONCILED,
          })
          .getRawOne();
        const cleared = await m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .select("SUM(transaction.amount)", "sum")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status = :status", {
            status: TransactionStatus.CLEARED,
          })
          .andWhere("transaction.transactionDate <= :statementDate", {
            statementDate,
          })
          .getRawOne();
        // TO_CHAR rather than the entity's DATE transformer: a raw select
        // hands back a driver `Date`, which would serialize as an instant.
        const last: { last_reconciled_date: string | null }[] = await m.query(
          `SELECT TO_CHAR(MAX(transaction_date), 'YYYY-MM-DD') AS last_reconciled_date
               FROM transactions
              WHERE user_id = $1
                AND account_id = $2
                AND status = $3
                AND parent_transaction_id IS NULL`,
          [userId, accountId, TransactionStatus.RECONCILED],
        );
        return [owned, listed, reconciled, cleared, last] as const;
      });

    const reconciledSum = Number(reconciledResult?.sum) || 0;
    const reconciledBalance = Number(account.openingBalance) + reconciledSum;

    const clearedSum = Number(clearedResult?.sum) || 0;
    const clearedBalance = reconciledBalance + clearedSum;

    const difference = statementBalance - clearedBalance;

    return {
      transactions,
      reconciledBalance,
      clearedBalance,
      difference,
      lastReconciledDate: lastRow[0]?.last_reconciled_date ?? null,
      staleAfterDays: STALE_UNRECONCILED_DAYS,
      overdueBefore,
    };
  }

  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ): Promise<{ reconciled: number }> {
    await this.accountsService.findOne(userId, accountId);

    if (transactionIds.length === 0) {
      return { reconciled: 0 };
    }

    return withScopedDb(this.dataSource, async (m) => {
      // Locked in ascending id order and re-checked here: the VOID exclusion
      // below is a refusal, so it has to be evaluated against the status this
      // statement is about to overwrite, not against one read a moment earlier.
      const transactions = await m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .where("transaction.id IN (:...ids)", { ids: transactionIds })
        .andWhere("transaction.userId = :userId", { userId })
        .andWhere("transaction.accountId = :accountId", { accountId })
        .orderBy("transaction.id", "ASC")
        .setLock("pessimistic_write")
        .getMany();

      if (transactions.length !== transactionIds.length) {
        throw new BadRequestException(
          tr(
            "errors.transactions.bulkReconcileNotFound",
            "Some transactions were not found or do not belong to the specified account",
          ),
        );
      }

      // Strict reconciled lock. Nothing the reconcile screen offers reaches an
      // already-RECONCILED row -- getReconciliationData does not list them --
      // but the endpoint takes ids, and re-reconciling one would move its
      // reconciled_date. A refusal that only holds for the ids the UI happens
      // to send is not a refusal.
      await assertReconciledRowsMutable(m, userId, transactions);

      const voidTransactions = transactions.filter(
        (t) => t.status === TransactionStatus.VOID,
      );
      if (voidTransactions.length > 0) {
        throw new BadRequestException(
          tr(
            "errors.transactions.cannotReconcileVoidPlural",
            "Cannot reconcile void transactions",
          ),
        );
      }

      await m
        .getRepository(Transaction)
        .createQueryBuilder()
        .update(Transaction)
        .set({
          status: TransactionStatus.RECONCILED,
          reconciledDate: reconciledDate,
        })
        .where("id IN (:...ids)", { ids: transactionIds })
        .andWhere("userId = :userId", { userId })
        .execute();

      return { reconciled: transactions.length };
    });
  }
}
