import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { ActionHistory } from "./entities/action-history.entity";
import { RULE_RUN_ENTITY_TYPE, undoRuleRun } from "./rule-run-undo";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { Account } from "../accounts/entities/account.entity";
import { withResolvedMortgageTypeProperty } from "../accounts/legacy-mortgage-type.util";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import {
  acquisitionCost,
  applyActionToQuantity,
  isQuantityOnlyAction,
  INVESTMENT_REPLAY_ORDER_SQL,
} from "../securities/investment-replay.util";
import { Security } from "../securities/entities/security.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Budget } from "../budgets/entities/budget.entity";
import { CustomReport } from "../reports/entities/custom-report.entity";
import { withSystemContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import {
  lockAccountsForBalanceWrite,
  lockHoldingScope,
} from "../common/db/locks";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";
import { invalidatePortfolioSummary } from "../securities/portfolio-summary-memo";

export interface RecordActionParams {
  entityType: string;
  entityId: string | null;
  action: "create" | "update" | "delete" | "bulk_update" | "bulk_delete";
  beforeData?: Record<string, any> | null;
  afterData?: Record<string, any> | null;
  relatedEntities?: Record<string, any>[] | null;
  /** English source string, kept as a fallback for clients/rows without a key. */
  description: string;
  /**
   * Stable, locale-independent key (e.g. "createdPayee") the client maps to a
   * translated template under `layout.actionHistory.descriptions`, plus the
   * values to interpolate into it. Supplying these lets the history render in
   * the viewer's current language instead of the frozen `description` above.
   */
  descriptionKey?: string | null;
  descriptionParams?: Record<string, any> | null;
}

export interface UndoRedoResult {
  action: ActionHistory;
  description: string;
}

const MAX_HISTORY_PER_USER = 100;
export const MAX_JSONB_SIZE_BYTES = 512 * 1024; // 500 KB

// Whitelist of allowed table names and column names for reinsertEntity()
// to prevent SQL injection via crafted JSONB keys
const ALLOWED_COLUMNS: Record<string, Set<string>> = {
  categories: new Set([
    "id",
    "user_id",
    "parent_id",
    "name",
    "description",
    "icon",
    "color",
    "is_income",
    "is_system",
    "created_at",
  ]),
  payees: new Set([
    "id",
    "user_id",
    "name",
    "default_category_id",
    "notes",
    "website",
    "address",
    "email",
    "phone",
    "is_active",
    "created_at",
  ]),
  tags: new Set([
    "id",
    "user_id",
    "name",
    "color",
    "icon",
    "created_at",
    "updated_at",
  ]),
  accounts: new Set([
    "id",
    "user_id",
    "account_type",
    "name",
    "description",
    "currency_code",
    "account_number",
    "institution",
    "opening_balance",
    "current_balance",
    "credit_limit",
    "interest_rate",
    "statement_due_day",
    "statement_settlement_day",
    "is_closed",
    "closed_date",
    "is_favourite",
    "exclude_from_net_worth",
    "account_sub_type",
    "linked_account_id",
    "payment_amount",
    "payment_frequency",
    "payment_start_date",
    "source_account_id",
    "principal_category_id",
    "interest_category_id",
    "asset_category_id",
    "date_acquired",
    "mortgage_type",
    "prepayment_mode",
    "term_months",
    "term_end_date",
    "amortization_months",
    "original_principal",
    "scheduled_transaction_id",
    "created_at",
    "updated_at",
  ]),
  scheduled_transactions: new Set([
    "id",
    "user_id",
    "account_id",
    "name",
    "payee_id",
    "payee_name",
    "category_id",
    "amount",
    "currency_code",
    "description",
    "frequency",
    "next_due_date",
    "start_date",
    "end_date",
    "occurrences_remaining",
    "total_occurrences",
    "is_active",
    "auto_post",
    "reminder_days_before",
    "last_posted_date",
    "is_split",
    "is_transfer",
    "transfer_account_id",
    "tag_ids",
    "created_at",
    "updated_at",
  ]),
  securities: new Set([
    "id",
    "user_id",
    "symbol",
    "name",
    "security_type",
    "exchange",
    "currency_code",
    "is_active",
    "skip_price_updates",
    "sector",
    "industry",
    "sector_weightings",
    "sector_data_updated_at",
    "created_at",
    "updated_at",
  ]),
  investment_transactions: new Set([
    "id",
    "user_id",
    "account_id",
    "transaction_id",
    "security_id",
    "funding_account_id",
    "action",
    "transaction_date",
    "quantity",
    "price",
    "commission",
    "total_amount",
    "description",
    "created_at",
    "updated_at",
  ]),
  budgets: new Set([
    "id",
    "user_id",
    "name",
    "description",
    "budget_type",
    "period_start",
    "period_end",
    "base_income",
    "income_linked",
    "strategy",
    "is_active",
    "currency_code",
    "config",
    "created_at",
    "updated_at",
  ]),
  custom_reports: new Set([
    "id",
    "user_id",
    "name",
    "description",
    "icon",
    "background_color",
    "view_type",
    "timeframe_type",
    "group_by",
    "filters",
    "config",
    "is_favourite",
    "sort_order",
    "created_at",
    "updated_at",
  ]),
};
const MAX_HISTORY_AGE_DAYS = 30;

/**
 * History writes that were started without anybody waiting for them.
 *
 * Every one of the ~20 `actionHistoryService.record(...)` call sites invokes it
 * without `await` -- deliberately, because a missing undo entry must never fail
 * the operation the user actually asked for. The write that lands afterwards is
 * still a write, and it arrives with no relationship to the request that caused
 * it.
 *
 * Harmless in a running server. Not harmless against a database being torn
 * down: an integration suite that truncates `users ... CASCADE` while one of
 * these is inserting into `action_history` gets a foreign key violation against
 * a user that no longer exists, and a suite whose fixture writes several rows
 * per test starts the next test body while those chains still hold pooled
 * connections. Both read as a bug in the code under test.
 *
 * Module scope rather than instance state, for the same reason
 * `pendingPriceWrites` is (`securities/security-price.service.ts`): the thing
 * that needs to wait is a test helper holding a `DataSource`, not a consumer of
 * this service. Nothing in `src/` waits on this; production keeps exactly the
 * fire-and-forget behaviour it had.
 */
const pendingHistoryWrites = new Set<Promise<unknown>>();

/**
 * Resolves once every history write started so far has finished, in either
 * direction. Call this before truncating or dropping the tables one references.
 *
 * Settled, not successful: a failed write has also stopped touching the
 * database, which is the only property a teardown needs.
 */
export async function settlePendingHistoryWrites(): Promise<void> {
  // Snapshotted because a settling promise removes itself from the set, and a
  // write may start another before it finishes.
  while (pendingHistoryWrites.size > 0) {
    await Promise.allSettled([...pendingHistoryWrites]);
  }
}

/** Register a background history write so `settlePendingHistoryWrites` sees it. */
function trackHistoryWrite<T>(work: Promise<T>): Promise<T> {
  pendingHistoryWrites.add(work);
  // `finally` keeps the returned promise's own settlement untouched, so a
  // caller that does await this still sees the original result or rejection.
  return work.finally(() => pendingHistoryWrites.delete(work));
}

@Injectable()
export class ActionHistoryService {
  private readonly logger = new Logger(ActionHistoryService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Record an undo entry. Callers do not await this -- see `pendingHistoryWrites`
   * above -- so the promise is registered before it is handed back, which is the
   * only way a teardown can tell the write is still running.
   */
  record(
    userId: string,
    params: RecordActionParams,
  ): Promise<ActionHistory | null> {
    return trackHistoryWrite(this.recordNow(userId, params));
  }

  private async recordNow(
    userId: string,
    params: RecordActionParams,
  ): Promise<ActionHistory | null> {
    try {
      // Check JSONB payload size to prevent oversized records
      const jsonSize =
        (params.beforeData ? JSON.stringify(params.beforeData).length : 0) +
        (params.afterData ? JSON.stringify(params.afterData).length : 0) +
        (params.relatedEntities
          ? JSON.stringify(params.relatedEntities).length
          : 0);

      if (jsonSize > MAX_JSONB_SIZE_BYTES) {
        this.logger.warn(
          `Action history payload too large (${jsonSize} bytes) for ${params.action} on ${params.entityType}, skipping`,
        );
        return null;
      }

      // Clearing the redo stack and writing the new entry are one unit: a
      // partially applied pair would leave a redo stack that no longer matches
      // the head of the undo stack.
      //
      // This joins the caller's transaction when there is one, and that is
      // deliberate despite the swallow below being dangerous to nest. Escaping
      // it with `runOutsideActiveScopedManager` was tried and reverted: on its
      // own connection this cannot see anything the caller has not committed, so
      // a history row written about a just-created user fails its `user_id`
      // foreign key. The contract stays "callers record after their own
      // transaction commits", enforced by the source scan in
      // `common/db/derived-state-writers.guard.spec.ts`.
      //
      // That scan reads one file at a time, so it does not see a caller two
      // service hops up: `ScheduledTransactionsService` posting a non-transfer
      // occurrence calls `TransactionsService.create` inside its transaction,
      // and `create` records history. Closing that needs the money write and the
      // history split apart in `create`, the way `createTransfer` now is -- not a
      // change to this method.
      const saved = await withScopedDb(this.dataSource, async (manager) => {
        const repo = manager.getRepository(ActionHistory);

        // Clear redo stack when a new action is recorded
        await repo.delete({
          userId,
          isUndone: true,
        });

        const action = repo.create({
          userId,
          entityType: params.entityType,
          entityId: params.entityId,
          action: params.action,
          beforeData: params.beforeData ?? null,
          afterData: params.afterData ?? null,
          relatedEntities: params.relatedEntities ?? null,
          description: params.description,
          descriptionKey: params.descriptionKey ?? null,
          descriptionParams: params.descriptionParams ?? null,
        });

        return repo.save(action);
      });

      // Prune old records beyond limit
      await this.pruneUserHistory(userId);

      return saved;
    } catch (error) {
      // Best-effort by design: recording an undo entry must never fail the
      // operation the user actually asked for, and every caller invokes this
      // AFTER its own transaction committed (a source-scan guard in
      // common/db/derived-state-writers.guard.spec.ts keeps it that way -- called
      // inside a transaction, this swallow would hide the abort and the caller's
      // next statement would die with 25P02).
      //
      // But `error`, not `warn`: the operation succeeded and its undo entry did
      // not, so the user will look for an undo that is not there. Name the entity
      // so the gap can be tied to what happened.
      this.logger.error(
        `Failed to record action history for ${params.action} on ${params.entityType} ${params.entityId} (the operation itself succeeded; it cannot be undone): ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  async getHistory(
    userId: string,
    limit: number = 50,
  ): Promise<ActionHistory[]> {
    return withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ActionHistory).find({
        where: { userId },
        order: { createdAt: "DESC" },
        take: limit,
      }),
    );
  }

  async undo(userId: string): Promise<UndoRedoResult> {
    const action = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ActionHistory).findOne({
        where: { userId, isUndone: false },
        order: { createdAt: "DESC" },
      }),
    );

    if (!action) {
      throw new NotFoundException(
        tr("errors.actionHistory.nothingToUndo", "Nothing to undo"),
      );
    }

    await withScopedDb(this.dataSource, async (manager) => {
      await this.executeUndo(action, manager);
      await manager.update(ActionHistory, action.id, {
        isUndone: true,
      });
    });

    // After the commit, like every other derived-state invalidation here: a
    // replay that rolled back must not have dropped the memo that still
    // describes the committed state.
    invalidatePortfolioSummary(userId);

    return { action, description: `Undone: ${action.description}` };
  }

  async redo(userId: string): Promise<UndoRedoResult> {
    const action = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ActionHistory).findOne({
        where: { userId, isUndone: true },
        order: { createdAt: "ASC" },
      }),
    );

    if (!action) {
      throw new NotFoundException(
        tr("errors.actionHistory.nothingToRedo", "Nothing to redo"),
      );
    }

    await withScopedDb(this.dataSource, async (manager) => {
      await this.executeRedo(action, manager);
      await manager.update(ActionHistory, action.id, {
        isUndone: false,
      });
    });

    invalidatePortfolioSummary(userId);

    return { action, description: `Redone: ${action.description}` };
  }

  private async executeUndo(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    switch (action.entityType) {
      case "transaction":
        await this.undoTransaction(action, manager);
        break;
      case "transfer":
        await this.undoTransfer(action, manager);
        break;
      case "category":
        await this.undoSimpleEntity(action, manager, Category, "categories");
        break;
      case "payee":
        await this.undoSimpleEntity(action, manager, Payee, "payees");
        break;
      case "tag":
        await this.undoSimpleEntity(action, manager, Tag, "tags");
        break;
      case "account":
        await this.undoSimpleEntity(action, manager, Account, "accounts");
        break;
      case "scheduled_transaction":
        await this.undoSimpleEntity(
          action,
          manager,
          ScheduledTransaction,
          "scheduled_transactions",
        );
        break;
      case "security":
        await this.undoSimpleEntity(action, manager, Security, "securities");
        break;
      case "investment_transaction":
        await this.undoInvestmentTransaction(action, manager);
        break;
      case "budget":
        await this.undoSimpleEntity(action, manager, Budget, "budgets");
        break;
      case "custom_report":
        await this.undoSimpleEntity(
          action,
          manager,
          CustomReport,
          "custom_reports",
        );
        break;
      case "bulk_transaction":
        await this.undoBulkTransaction(action, manager);
        break;
      case RULE_RUN_ENTITY_TYPE:
        await undoRuleRun(action, manager);
        break;
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.undoNotSupportedForEntityType",
            `Undo not supported for entity type: ${action.entityType}`,
            { entityType: action.entityType },
          ),
        );
    }
  }

  private async executeRedo(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    // Redo is the inverse of undo: swap before/after and flip the action
    const invertedAction: ActionHistory = {
      ...action,
      beforeData: action.afterData,
      afterData: action.beforeData,
      action: this.invertAction(action.action),
    };
    await this.executeUndo(invertedAction, manager);
  }

  private invertAction(action: string): string {
    switch (action) {
      case "create":
        return "delete";
      case "delete":
        return "create";
      case "update":
        return "update";
      case "bulk_delete":
        return "bulk_delete";
      case "bulk_update":
        return "bulk_update";
      default:
        return action;
    }
  }

  // --- Transaction undo handlers ---

  private async undoTransaction(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        await this.undoTransactionCreate(action, manager);
        break;
      case "update":
        await this.undoTransactionUpdate(action, manager);
        break;
      case "delete":
        await this.undoTransactionDelete(action, manager);
        break;
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.unsupportedTransactionAction",
            `Unsupported transaction action: ${action.action}`,
            { action: action.action },
          ),
        );
    }
  }

  private async undoTransactionCreate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.entityId) return;

    const transaction = await manager.findOne(Transaction, {
      where: { id: action.entityId, userId: action.userId },
      relations: ["splits"],
    });
    if (!transaction) return;

    // Delete splits first
    if (transaction.splits && transaction.splits.length > 0) {
      await manager.delete(TransactionSplit, {
        transactionId: transaction.id,
      });
    }

    // Delete tag associations
    await manager.query(
      `DELETE FROM transaction_tags WHERE transaction_id = $1`,
      [transaction.id],
    );

    const accountId = transaction.accountId;

    await manager.remove(transaction);

    // Reverse balance
    await this.recalculateBalance(action.userId, accountId, manager);
  }

  private async undoTransactionUpdate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.entityId || !action.beforeData) return;

    const transaction = await manager.findOne(Transaction, {
      where: { id: action.entityId, userId: action.userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!transaction) {
      throw new ConflictException(
        tr(
          "errors.actionHistory.undoTransactionGone",
          "Cannot undo: transaction no longer exists",
        ),
      );
    }

    // INV-RECONCILE-001: undo/redo of an edit rewrites this row's stored fields
    // (redo reaches here too, via `executeRedo` inverting the action), so a
    // reconciled locked row refuses -- an undo is no more allowed to alter it
    // than the original edit was. Runs after the row lock above and before the
    // write below, so a refusal reverses nothing.
    await assertReconciledRowsMutable(manager, action.userId, [transaction]);

    const before = action.beforeData;

    // Restore transaction fields
    const updateFields: Partial<Transaction> = {};
    const fieldKeys = [
      "accountId",
      "transactionDate",
      "amount",
      "currencyCode",
      "exchangeRate",
      "payeeId",
      "payeeName",
      "categoryId",
      "description",
      "referenceNumber",
      "status",
      "isSplit",
    ];
    for (const key of fieldKeys) {
      if (key in before) {
        (updateFields as any)[key] = before[key];
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await manager.update(Transaction, action.entityId, updateFields);
    }

    // Restore splits if they were captured
    if (before.splits !== undefined) {
      await manager.delete(TransactionSplit, {
        transactionId: action.entityId,
      });

      if (Array.isArray(before.splits) && before.splits.length > 0) {
        for (const splitData of before.splits) {
          const split = manager.create(TransactionSplit, {
            id: splitData.id,
            transactionId: action.entityId,
            categoryId: splitData.categoryId,
            transferAccountId: splitData.transferAccountId || null,
            linkedTransactionId: splitData.linkedTransactionId || null,
            amount: splitData.amount,
            memo: splitData.memo || null,
          });
          await manager.save(split);
        }
      }
    }

    // Restore tags if captured
    if (before.tagIds !== undefined) {
      await manager.query(
        `DELETE FROM transaction_tags WHERE transaction_id = $1`,
        [action.entityId],
      );
      if (Array.isArray(before.tagIds)) {
        for (const tagId of before.tagIds) {
          await manager.query(
            `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [action.entityId, tagId],
          );
        }
      }
    }

    // Recalculate balances for affected accounts
    const accountIds = new Set<string>();
    if (before.accountId) accountIds.add(before.accountId);
    accountIds.add(transaction.accountId);

    for (const accountId of accountIds) {
      await this.recalculateBalance(action.userId, accountId, manager);
    }
  }

  private async undoTransactionDelete(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.beforeData) return;

    const before = action.beforeData;

    // Verify account still exists
    const account = await manager.findOne(Account, {
      where: { id: before.accountId, userId: action.userId },
    });
    if (!account) {
      throw new ConflictException(
        tr(
          "errors.actionHistory.undoAccountGone",
          "Cannot undo: the account no longer exists",
        ),
      );
    }

    // Re-insert the transaction
    await manager.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date, amount, currency_code, exchange_rate,
        payee_id, payee_name, category_id, description, reference_number, status, is_split,
        parent_transaction_id, is_transfer, linked_transaction_id, reconciled_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        before.id,
        action.userId,
        before.accountId,
        before.transactionDate,
        before.amount,
        before.currencyCode,
        before.exchangeRate ?? 1,
        before.payeeId ?? null,
        before.payeeName ?? null,
        before.categoryId ?? null,
        before.description ?? null,
        before.referenceNumber ?? null,
        before.status ?? "UNRECONCILED",
        before.isSplit ?? false,
        before.parentTransactionId ?? null,
        before.isTransfer ?? false,
        before.linkedTransactionId ?? null,
        before.reconciledDate ?? null,
        before.createdAt ?? new Date(),
      ],
    );

    // Re-insert splits
    if (Array.isArray(before.splits) && before.splits.length > 0) {
      for (const splitData of before.splits) {
        await manager.query(
          `INSERT INTO transaction_splits (id, transaction_id, category_id, transfer_account_id, linked_transaction_id, amount, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            splitData.id,
            before.id,
            splitData.categoryId ?? null,
            splitData.transferAccountId ?? null,
            splitData.linkedTransactionId ?? null,
            splitData.amount,
            splitData.memo ?? null,
          ],
        );
      }
    }

    // Re-insert tags
    if (Array.isArray(before.tagIds)) {
      for (const tagId of before.tagIds) {
        await manager.query(
          `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [before.id, tagId],
        );
      }
    }

    await this.recalculateBalance(action.userId, before.accountId, manager);
  }

  // --- Transfer undo handlers ---

  private async undoTransfer(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        await this.undoTransferCreate(action, manager);
        break;
      case "delete":
        await this.undoTransferDelete(action, manager);
        break;
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.unsupportedTransferAction",
            `Unsupported transfer action: ${action.action}`,
            { action: action.action },
          ),
        );
    }
  }

  private async undoTransferCreate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.afterData) return;

    const { fromTransactionId, toTransactionId, fromAccountId, toAccountId } =
      action.afterData;

    // Delete both linked transactions
    for (const txId of [fromTransactionId, toTransactionId]) {
      if (!txId) continue;
      const tx = await manager.findOne(Transaction, {
        where: { id: txId, userId: action.userId },
      });
      if (tx) {
        await manager.query(
          `DELETE FROM transaction_tags WHERE transaction_id = $1`,
          [txId],
        );
        // Unlink before deleting to avoid FK constraint
        await manager.update(Transaction, txId, {
          linkedTransactionId: null,
        });
      }
    }

    for (const txId of [fromTransactionId, toTransactionId]) {
      if (!txId) continue;
      await manager.delete(Transaction, { id: txId });
    }

    if (fromAccountId) {
      await this.recalculateBalance(action.userId, fromAccountId, manager);
    }
    if (toAccountId) {
      await this.recalculateBalance(action.userId, toAccountId, manager);
    }
  }

  private async undoTransferDelete(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.beforeData) return;

    const { fromTransaction, toTransaction } = action.beforeData;
    if (!fromTransaction || !toTransaction) return;

    // Re-insert both transactions without linked IDs first
    for (const txData of [fromTransaction, toTransaction]) {
      await manager.query(
        `INSERT INTO transactions (id, user_id, account_id, transaction_date, amount, currency_code, exchange_rate,
          payee_id, payee_name, category_id, description, reference_number, status, is_split,
          is_transfer, linked_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL, $16)`,
        [
          txData.id,
          action.userId,
          txData.accountId,
          txData.transactionDate,
          txData.amount,
          txData.currencyCode,
          txData.exchangeRate ?? 1,
          txData.payeeId ?? null,
          txData.payeeName ?? null,
          txData.categoryId ?? null,
          txData.description ?? null,
          txData.referenceNumber ?? null,
          txData.status ?? "UNRECONCILED",
          txData.isSplit ?? false,
          txData.isTransfer ?? true,
          txData.createdAt ?? new Date(),
        ],
      );
    }

    // Re-link the transactions
    await manager.update(Transaction, fromTransaction.id, {
      linkedTransactionId: toTransaction.id,
    });
    await manager.update(Transaction, toTransaction.id, {
      linkedTransactionId: fromTransaction.id,
    });

    await this.recalculateBalance(
      action.userId,
      fromTransaction.accountId,
      manager,
    );
    await this.recalculateBalance(
      action.userId,
      toTransaction.accountId,
      manager,
    );
  }

  // --- Investment transaction undo ---

  private async undoInvestmentTransaction(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        await this.undoInvestmentCreate(action, manager);
        break;
      case "delete":
        await this.undoInvestmentDelete(action, manager);
        break;
      case "update":
        await this.undoInvestmentUpdate(action, manager);
        break;
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.unsupportedInvestmentAction",
            `Unsupported investment action: ${action.action}`,
            { action: action.action },
          ),
        );
    }
  }

  private async undoInvestmentUpdate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    const before = action.beforeData;
    const linkedBefore = before?.linkedTransferLeg as
      | Record<string, any>
      | undefined;

    // Only linked security-transfer edits capture both legs' pre-edit state,
    // which is what we need to reverse. Regular investment edits remain
    // non-undoable (they would also need the cash side restored).
    if (!before || !linkedBefore) {
      throw new ConflictException(
        tr(
          "errors.actionHistory.unsupportedInvestmentAction",
          `Unsupported investment action: ${action.action}`,
          { action: action.action },
        ),
      );
    }

    const accountIds = new Set<string>();
    for (const legBefore of [before, linkedBefore]) {
      // Capture the leg's current (post-edit) account before we overwrite it so
      // holdings are rebuilt for both the old and the new account.
      const current = await manager.findOne(InvestmentTransaction, {
        where: { id: legBefore.id, userId: action.userId },
      });
      if (current) accountIds.add(current.accountId);

      await manager.update(
        InvestmentTransaction,
        { id: legBefore.id, userId: action.userId },
        {
          accountId: legBefore.accountId,
          securityId: legBefore.securityId ?? null,
          action: legBefore.action,
          transactionDate: legBefore.transactionDate,
          quantity: legBefore.quantity ?? 0,
          price: legBefore.price ?? null,
          commission: legBefore.commission ?? 0,
          totalAmount: legBefore.totalAmount ?? 0,
          description: legBefore.description ?? null,
          linkedTransactionId: legBefore.linkedTransactionId ?? null,
        },
      );
      accountIds.add(legBefore.accountId);
    }

    // Rebuild holdings for every account either leg moved out of or into.
    for (const accountId of accountIds) {
      await this.rebuildHoldings(action.userId, accountId, manager);
    }
  }

  private async undoInvestmentCreate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.entityId) return;

    const invTx = await manager.findOne(InvestmentTransaction, {
      where: { id: action.entityId, userId: action.userId },
    });
    if (!invTx) return;

    // A security transfer is two linked legs (TRANSFER_OUT <-> TRANSFER_IN);
    // undoing the create must remove both so holdings can't be left half-moved.
    const linkedTx = invTx.linkedTransactionId
      ? await manager.findOne(InvestmentTransaction, {
          where: { id: invTx.linkedTransactionId, userId: action.userId },
        })
      : null;

    const legs = linkedTx ? [invTx, linkedTx] : [invTx];
    const accountIds = new Set<string>();

    for (const leg of legs) {
      accountIds.add(leg.accountId);

      // Delete linked cash transaction
      if (leg.transactionId) {
        const cashTx = await manager.findOne(Transaction, {
          where: { id: leg.transactionId },
        });
        if (cashTx) {
          await manager.query(
            `DELETE FROM transaction_tags WHERE transaction_id = $1`,
            [cashTx.id],
          );
          await manager.remove(cashTx);
          await this.recalculateBalance(
            action.userId,
            cashTx.accountId,
            manager,
          );
        }
      }
    }

    // Break the mutual link before deleting so neither row's self-FK points at
    // a row that is about to disappear.
    for (const leg of legs) {
      if (leg.linkedTransactionId) {
        await manager.update(InvestmentTransaction, leg.id, {
          linkedTransactionId: null,
        });
        leg.linkedTransactionId = null;
      }
    }

    for (const leg of legs) {
      await manager.remove(leg);
    }

    // Rebuild holdings for every affected account.
    for (const accountId of accountIds) {
      await this.rebuildHoldings(action.userId, accountId, manager);
    }
  }

  private async undoInvestmentDelete(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.beforeData) return;

    // The transfer-create afterData (fed here on redo) is the nested
    // {transferOut, transferIn} shape; normalize it to the flat
    // leg + linkedTransferLeg shape used by the delete beforeData.
    const raw = action.beforeData;
    const before = raw.transferOut
      ? { ...raw.transferOut, linkedTransferLeg: raw.transferIn }
      : raw;
    const linkedLeg = before.linkedTransferLeg as
      | Record<string, any>
      | undefined;

    // Re-insert linked cash transaction first (investment_transactions.transaction_id references it)
    if (before.linkedCashTransaction) {
      const cashTx = before.linkedCashTransaction;
      await manager.query(
        `INSERT INTO transactions (id, user_id, account_id, transaction_date, amount, currency_code, exchange_rate,
          description, status, is_transfer, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          cashTx.id,
          action.userId,
          cashTx.accountId,
          cashTx.transactionDate,
          cashTx.amount,
          cashTx.currencyCode,
          cashTx.exchangeRate ?? 1,
          cashTx.description ?? null,
          cashTx.status ?? "UNRECONCILED",
          cashTx.isTransfer ?? false,
          cashTx.createdAt ?? new Date(),
        ],
      );
      await this.recalculateBalance(action.userId, cashTx.accountId, manager);
    }

    // Re-insert the investment transaction
    // Only reference the cash transaction FK if we actually restored it above;
    // older action history records may not have linkedCashTransaction captured.
    const restoredTransactionId = before.linkedCashTransaction
      ? (before.transactionId ?? null)
      : null;
    await this.reinsertInvestmentTransaction(
      manager,
      action.userId,
      before,
      restoredTransactionId,
    );

    // Restore the paired transfer leg and the mutual link between the two legs.
    // The self-FK is set after both rows exist to avoid an ordering violation.
    if (linkedLeg) {
      await this.reinsertInvestmentTransaction(
        manager,
        action.userId,
        linkedLeg,
        null,
      );
      await manager.update(InvestmentTransaction, before.id, {
        linkedTransactionId: linkedLeg.id,
      });
      await manager.update(InvestmentTransaction, linkedLeg.id, {
        linkedTransactionId: before.id,
      });
    }

    // Rebuild holdings for every affected account.
    const accountIds = new Set<string>([before.accountId]);
    if (linkedLeg) accountIds.add(linkedLeg.accountId);
    for (const accountId of accountIds) {
      await this.rebuildHoldings(action.userId, accountId, manager);
    }
  }

  private async reinsertInvestmentTransaction(
    manager: EntityManager,
    userId: string,
    data: Record<string, any>,
    transactionId: string | null,
  ): Promise<void> {
    // linked_transaction_id is intentionally not set here; for a transfer it is
    // restored by the caller once both legs exist, and for a single leg the
    // original delete already nulled the survivor's pointer.
    // ON CONFLICT DO NOTHING keeps the reinsert idempotent: a client retry or a
    // partial-residue id collision must not abort the whole undo/redo with a
    // duplicate-key error. price preserves NULL (a leg with no price differs
    // from a 0-cost leg in cost-basis replays) and exchange_rate is restored so
    // undeleting a foreign-currency transaction doesn't reset its rate to 1.
    await manager.query(
      `INSERT INTO investment_transactions (id, user_id, account_id, transaction_id, security_id,
        funding_account_id, action, transaction_date, quantity, price, commission, total_amount, exchange_rate, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO NOTHING`,
      [
        data.id,
        userId,
        data.accountId,
        transactionId,
        data.securityId ?? null,
        data.fundingAccountId ?? null,
        data.action,
        data.transactionDate,
        data.quantity ?? 0,
        data.price ?? null,
        data.commission ?? 0,
        data.totalAmount ?? 0,
        data.exchangeRate ?? 1,
        data.description ?? null,
        data.createdAt ?? new Date(),
      ],
    );
  }

  // --- Bulk transaction undo ---

  private async undoBulkTransaction(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    switch (action.action) {
      case "bulk_delete":
        await this.undoBulkDelete(action, manager);
        break;
      case "bulk_update":
        await this.undoBulkUpdate(action, manager);
        break;
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.unsupportedBulkAction",
            `Unsupported bulk action: ${action.action}`,
            { action: action.action },
          ),
        );
    }
  }

  private async undoBulkDelete(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.beforeData || !Array.isArray(action.beforeData.transactions))
      return;

    const accountIds = new Set<string>();

    for (const txData of action.beforeData.transactions) {
      await manager.query(
        `INSERT INTO transactions (id, user_id, account_id, transaction_date, amount, currency_code, exchange_rate,
          payee_id, payee_name, category_id, description, reference_number, status, is_split,
          is_transfer, linked_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO NOTHING`,
        [
          txData.id,
          action.userId,
          txData.accountId,
          txData.transactionDate,
          txData.amount,
          txData.currencyCode,
          txData.exchangeRate ?? 1,
          txData.payeeId ?? null,
          txData.payeeName ?? null,
          txData.categoryId ?? null,
          txData.description ?? null,
          txData.referenceNumber ?? null,
          txData.status ?? "UNRECONCILED",
          txData.isSplit ?? false,
          txData.isTransfer ?? false,
          txData.linkedTransactionId ?? null,
          txData.createdAt ?? new Date(),
        ],
      );
      accountIds.add(txData.accountId);
    }

    for (const accountId of accountIds) {
      await this.recalculateBalance(action.userId, accountId, manager);
    }
  }

  private async undoBulkUpdate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.beforeData || !Array.isArray(action.beforeData.transactions))
      return;

    const accountIds = new Set<string>();

    for (const txData of action.beforeData.transactions) {
      const updateFields: Record<string, any> = {};
      const fieldKeys = [
        "accountId",
        "transactionDate",
        "amount",
        "payeeId",
        "payeeName",
        "categoryId",
        "description",
        "status",
      ];
      for (const key of fieldKeys) {
        if (key in txData) {
          updateFields[key] = txData[key];
        }
      }

      if (Object.keys(updateFields).length > 0) {
        await manager.update(Transaction, txData.id, updateFields);
      }

      // Restore tags if captured
      if (Array.isArray(txData.tagIds)) {
        await manager.query(
          `DELETE FROM transaction_tags WHERE transaction_id = $1`,
          [txData.id],
        );
        for (const tagId of txData.tagIds) {
          await manager.query(
            `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [txData.id, tagId],
          );
        }
      }

      // Restore split-line categories if captured (bulk recategorization).
      // transaction_splits has no user_id, so the write is scoped through its
      // parent transaction (invariant I3, docs/future-plans/split-bulk-update.md).
      if (Array.isArray(txData.splits)) {
        for (const split of txData.splits) {
          await manager.query(
            `UPDATE transaction_splits SET category_id = $1
              WHERE id = $2
                AND EXISTS (
                  SELECT 1 FROM transactions t
                   WHERE t.id = transaction_splits.transaction_id
                     AND t.user_id = $3
                )`,
            [split.categoryId ?? null, split.id, action.userId],
          );
        }
      }

      accountIds.add(txData.accountId);
    }

    for (const accountId of accountIds) {
      await this.recalculateBalance(action.userId, accountId, manager);
    }
  }

  // --- Simple entity undo (categories, payees, tags, accounts) ---

  private async undoSimpleEntity(
    action: ActionHistory,
    manager: EntityManager,
    entityClass: any,
    tableName: string,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        if (action.entityId) {
          await manager.delete(entityClass, {
            id: action.entityId,
          });
        }
        break;
      case "update":
        if (action.entityId && action.beforeData) {
          const updateFields = this.replayableSnapshot(
            tableName,
            action.beforeData,
          );
          // Remove fields that shouldn't be directly updated
          delete updateFields.id;
          delete updateFields.userId;
          delete updateFields.createdAt;
          delete updateFields.updatedAt;

          // Filter out relation properties that can't be used in UPDATE queries.
          // Only keep fields whose snake_case names are in the ALLOWED_COLUMNS whitelist.
          const allowedCols = ALLOWED_COLUMNS[tableName];
          if (allowedCols) {
            for (const key of Object.keys(updateFields)) {
              const col = this.toSnakeCase(key);
              if (!allowedCols.has(col)) {
                delete updateFields[key];
              }
            }
          }

          if (Object.keys(updateFields).length > 0) {
            await manager.update(entityClass, action.entityId, updateFields);
          }
        }
        break;
      case "delete":
        if (action.beforeData) {
          const data = this.replayableSnapshot(tableName, action.beforeData);
          // Ensure userId is set from the action
          data.userId = action.userId;
          await this.reinsertEntity(manager, tableName, data);
        }
        break;
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.unsupportedSimpleAction",
            `Unsupported action: ${action.action}`,
            { action: action.action },
          ),
        );
    }
  }

  // --- Utility methods ---

  /**
   * A copy of a snapshot in today's column shape. An account snapshot recorded
   * before the mortgage-type contract migration carries the dropped legacy
   * flags and a null or missing type, which the NOT NULL column refuses; it is
   * replayed with the type the migration would have given it.
   */
  private replayableSnapshot(
    tableName: string,
    snapshot: Record<string, any>,
  ): Record<string, any> {
    return tableName === "accounts"
      ? withResolvedMortgageTypeProperty(snapshot)
      : { ...snapshot };
  }

  private async recalculateBalance(
    userId: string,
    accountId: string,
    manager: EntityManager,
  ): Promise<void> {
    // Lock the account before reading the ledger, like every other absolute
    // balance writer.
    //
    // This is the same protocol boundary as AccountsService.recalculateCurrentBalance
    // (audit P4-005): the SELECT and the UPDATE below are separate statement
    // snapshots under READ COMMITTED, so without the lock an ordinary
    // transaction committing between them is overwritten by a total that never
    // saw it -- and an undo is precisely when a user is watching the balance.
    //
    // Owner-scoped like every own-context balance-write lock: an undo only ever
    // touches the acting user's own accounts, so the lock must never land on a
    // row that is not theirs (maintainer review, PR #1095).
    await lockAccountsForBalanceWrite(manager, [accountId], userId);

    // Use the same recalculation logic as AccountsService
    const result = await manager.query(
      `SELECT a.opening_balance, COALESCE(SUM(t.amount), 0) as tx_sum
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
         AND ${LEDGER_MOVEMENT_PREDICATE}
         AND t.transaction_date <= CURRENT_DATE
       WHERE a.id = $1
       GROUP BY a.id, a.opening_balance`,
      [accountId],
    );

    if (result.length > 0) {
      const balance =
        Math.round(
          (Number(result[0].opening_balance || 0) +
            Number(result[0].tx_sum || 0)) *
            10000,
        ) / 10000;
      await manager.query(
        `UPDATE accounts SET current_balance = $1 WHERE id = $2`,
        [balance, accountId],
      );
    }
  }

  private async rebuildHoldings(
    userId: string,
    accountId: string,
    manager: EntityManager,
  ): Promise<void> {
    // Same lock namespace every holdings writer takes, before the ledger is
    // read. A rebuild replays investment_transactions and replaces the holdings
    // derived from them, so what it must not lose is a *trade* -- an insert no
    // holdings row locks (audit P4-006).
    await lockHoldingScope(manager, [accountId]);

    // Delete existing holdings for this account
    await manager.query(`DELETE FROM holdings WHERE account_id = $1`, [
      accountId,
    ]);

    // Rebuild from investment transactions
    const invTransactions = await manager.query(
      `SELECT * FROM investment_transactions
       WHERE account_id = $1 AND user_id = $2 AND transaction_date <= CURRENT_DATE
         AND status != 'VOID'
       ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
      [accountId, userId],
    );

    const holdings = new Map<string, { quantity: number; totalCost: number }>();

    for (const tx of invTransactions) {
      const securityId = tx.security_id;
      if (!securityId) continue;

      const current = holdings.get(securityId) || {
        quantity: 0,
        totalCost: 0,
      };
      const qty = Number(tx.quantity || 0);

      // Quantity folds through the shared reducer so an undo cannot rebuild a
      // different position than the canonical holdings rebuild would. This copy
      // multiplied by a SPLIT ratio without the `> 0` guard, so a ratio of 0
      // silently destroyed the position; and it left the acquisition commission
      // out of the basis, so undoing an action could also change the cost basis
      // the holdings page reports.
      // Basis treatment mirrors `computeHoldingsMap` exactly, over-sells
      // included: the canonical fold carries an over-sold position as
      // NEGATIVE (its own comment calls an over-sell "history"), so a clamp
      // here made an undo rebuild a different position than the next
      // canonical rebuild restores -- BUY 10, SELL 15, BUY 10 stores 5 shares
      // canonically and stored 10 through this fold.
      const quantityChange =
        applyActionToQuantity(0, tx.action, qty) < 0 ? -qty : qty;
      if (tx.action === "SPLIT") {
        // Total basis is preserved across a split.
      } else if (isQuantityOnlyAction(tx.action)) {
        // ADD_SHARES / REMOVE_SHARES: quantity only, no cost basis change.
      } else if (quantityChange > 0) {
        // Raw select: commission comes back as a string, and the row is
        // denominated in the security's currency like the rest of this fold.
        const cost = acquisitionCost({
          quantity: tx.quantity,
          price: tx.price,
          commission: tx.commission,
          // Snake_case: this is the raw row, not the entity.
          totalAmount: tx.total_amount,
        });
        if (cost !== null) current.totalCost += cost;
      } else if (current.quantity > 0) {
        const avgCost = current.totalCost / current.quantity;
        const relieved = Math.min(Math.abs(quantityChange), current.quantity);
        current.totalCost -= relieved * avgCost;
      }

      current.quantity = applyActionToQuantity(
        current.quantity,
        tx.action,
        qty,
      );

      // Snap near-zero to exactly zero, as the canonical fold does.
      if (Math.abs(current.quantity) < 0.0001) {
        current.quantity = 0;
        current.totalCost = 0;
      }

      holdings.set(securityId, current);
    }

    // Insert rebuilt holdings. Negative (over-sold) positions are written as
    // the canonical rebuild writes them; only a genuinely empty position is
    // skipped.
    for (const [securityId, data] of holdings) {
      if (Math.abs(data.quantity) < 0.00000001) continue;
      const avgCost =
        data.quantity > 0
          ? Math.round((data.totalCost / data.quantity) * 1000000) / 1000000
          : 0;

      await manager.query(
        `INSERT INTO holdings (id, account_id, security_id, quantity, average_cost)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4)
         ON CONFLICT (account_id, security_id) DO UPDATE SET quantity = $3, average_cost = $4`,
        [accountId, securityId, data.quantity, avgCost],
      );
    }
  }

  private async reinsertEntity(
    manager: EntityManager,
    tableName: string,
    data: Record<string, any>,
  ): Promise<void> {
    const allowedCols = ALLOWED_COLUMNS[tableName];
    if (!allowedCols) {
      throw new ConflictException(
        tr(
          "errors.actionHistory.unsupportedTableForReinsert",
          `Unsupported table for re-insert: ${tableName}`,
          { tableName },
        ),
      );
    }

    const keys = Object.keys(data).filter(
      (k) => data[k] !== undefined && k !== "updatedAt",
    );
    if (keys.length === 0) return;

    const columns: string[] = [];
    const values: any[] = [];
    for (const k of keys) {
      const col = this.toSnakeCase(k);
      if (!allowedCols.has(col)) {
        this.logger.warn(
          `Skipping disallowed column "${col}" for table "${tableName}"`,
        );
        continue;
      }
      columns.push(col);
      values.push(data[k]);
    }

    if (columns.length === 0) return;

    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const quotedCols = columns.map((c) => `"${c}"`);

    await manager.query(
      `INSERT INTO "${tableName}" (${quotedCols.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (id) DO NOTHING`,
      values,
    );
  }

  private toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  private async pruneUserHistory(userId: string): Promise<void> {
    try {
      await withScopedDb(this.dataSource, async (manager) => {
        const repo = manager.getRepository(ActionHistory);

        // Keep only the most recent MAX_HISTORY_PER_USER records
        const countResult = await repo.count({
          where: { userId },
        });

        if (countResult > MAX_HISTORY_PER_USER) {
          const oldest = await repo.find({
            where: { userId },
            order: { createdAt: "DESC" },
            skip: MAX_HISTORY_PER_USER,
            select: ["id"],
          });

          if (oldest.length > 0) {
            const idsToDelete = oldest.map((a) => a.id);
            await repo.delete(idsToDelete);
          }
        }
      });
    } catch (error) {
      this.logger.warn(
        `Failed to prune action history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron("0 3 * * *")
  async cleanupExpiredHistory(): Promise<void> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - MAX_HISTORY_AGE_DAYS);

      // RLS (task C2): cross-user bulk cleanup -- runs under a system context.
      const result = await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          manager
            .getRepository(ActionHistory)
            .createQueryBuilder()
            .delete()
            .where("created_at < :cutoff", { cutoff })
            .execute(),
        ),
      );

      if (result.affected && result.affected > 0) {
        this.logger.log(
          `Cleaned up ${result.affected} expired action history records`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to cleanup action history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
