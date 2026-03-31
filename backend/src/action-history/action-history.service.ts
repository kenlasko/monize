import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { ActionHistory } from "./entities/action-history.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Security } from "../securities/entities/security.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Budget } from "../budgets/entities/budget.entity";
import { CustomReport } from "../reports/entities/custom-report.entity";

export interface RecordActionParams {
  entityType: string;
  entityId: string | null;
  action: "create" | "update" | "delete" | "bulk_update" | "bulk_delete";
  beforeData?: Record<string, any> | null;
  afterData?: Record<string, any> | null;
  relatedEntities?: Record<string, any>[] | null;
  description: string;
}

export interface UndoRedoResult {
  action: ActionHistory;
  description: string;
}

const MAX_HISTORY_PER_USER = 100;
const MAX_JSONB_SIZE_BYTES = 512 * 1024; // 500 KB

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
    "is_canadian_mortgage",
    "is_variable_rate",
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

@Injectable()
export class ActionHistoryService {
  private readonly logger = new Logger(ActionHistoryService.name);

  constructor(
    @InjectRepository(ActionHistory)
    private actionHistoryRepository: Repository<ActionHistory>,
    private dataSource: DataSource,
  ) {}

  async record(
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

      // Clear redo stack when a new action is recorded
      await this.actionHistoryRepository.delete({
        userId,
        isUndone: true,
      });

      const action = this.actionHistoryRepository.create({
        userId,
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        beforeData: params.beforeData ?? null,
        afterData: params.afterData ?? null,
        relatedEntities: params.relatedEntities ?? null,
        description: params.description,
      });

      const saved = await this.actionHistoryRepository.save(action);

      // Prune old records beyond limit
      await this.pruneUserHistory(userId);

      return saved;
    } catch (error) {
      // Recording is best-effort -- never fail the original operation
      this.logger.warn(
        `Failed to record action history: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async getHistory(
    userId: string,
    limit: number = 50,
  ): Promise<ActionHistory[]> {
    return this.actionHistoryRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: limit,
    });
  }

  async undo(userId: string): Promise<UndoRedoResult> {
    const action = await this.actionHistoryRepository.findOne({
      where: { userId, isUndone: false },
      order: { createdAt: "DESC" },
    });

    if (!action) {
      throw new NotFoundException("Nothing to undo");
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.executeUndo(action, queryRunner);
      await queryRunner.manager.update(ActionHistory, action.id, {
        isUndone: true,
      });
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return { action, description: `Undone: ${action.description}` };
  }

  async redo(userId: string): Promise<UndoRedoResult> {
    const action = await this.actionHistoryRepository.findOne({
      where: { userId, isUndone: true },
      order: { createdAt: "ASC" },
    });

    if (!action) {
      throw new NotFoundException("Nothing to redo");
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.executeRedo(action, queryRunner);
      await queryRunner.manager.update(ActionHistory, action.id, {
        isUndone: false,
      });
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return { action, description: `Redone: ${action.description}` };
  }

  private async executeUndo(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    switch (action.entityType) {
      case "transaction":
        await this.undoTransaction(action, queryRunner);
        break;
      case "transfer":
        await this.undoTransfer(action, queryRunner);
        break;
      case "category":
        await this.undoSimpleEntity(
          action,
          queryRunner,
          Category,
          "categories",
        );
        break;
      case "payee":
        await this.undoSimpleEntity(action, queryRunner, Payee, "payees");
        break;
      case "tag":
        await this.undoSimpleEntity(action, queryRunner, Tag, "tags");
        break;
      case "account":
        await this.undoSimpleEntity(action, queryRunner, Account, "accounts");
        break;
      case "scheduled_transaction":
        await this.undoSimpleEntity(
          action,
          queryRunner,
          ScheduledTransaction,
          "scheduled_transactions",
        );
        break;
      case "security":
        await this.undoSimpleEntity(
          action,
          queryRunner,
          Security,
          "securities",
        );
        break;
      case "investment_transaction":
        await this.undoInvestmentTransaction(action, queryRunner);
        break;
      case "budget":
        await this.undoSimpleEntity(action, queryRunner, Budget, "budgets");
        break;
      case "custom_report":
        await this.undoSimpleEntity(
          action,
          queryRunner,
          CustomReport,
          "custom_reports",
        );
        break;
      case "bulk_transaction":
        await this.undoBulkTransaction(action, queryRunner);
        break;
      default:
        throw new ConflictException(
          `Undo not supported for entity type: ${action.entityType}`,
        );
    }
  }

  private async executeRedo(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Redo is the inverse of undo: swap before/after and flip the action
    const invertedAction: ActionHistory = {
      ...action,
      beforeData: action.afterData,
      afterData: action.beforeData,
      action: this.invertAction(action.action),
    };
    await this.executeUndo(invertedAction, queryRunner);
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
    queryRunner: QueryRunner,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        await this.undoTransactionCreate(action, queryRunner);
        break;
      case "update":
        await this.undoTransactionUpdate(action, queryRunner);
        break;
      case "delete":
        await this.undoTransactionDelete(action, queryRunner);
        break;
      default:
        throw new ConflictException(
          `Unsupported transaction action: ${action.action}`,
        );
    }
  }

  private async undoTransactionCreate(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.entityId) return;

    const transaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: action.entityId, userId: action.userId },
      relations: ["splits"],
    });
    if (!transaction) return;

    // Delete splits first
    if (transaction.splits && transaction.splits.length > 0) {
      await queryRunner.manager.delete(TransactionSplit, {
        transactionId: transaction.id,
      });
    }

    // Delete tag associations
    await queryRunner.query(
      `DELETE FROM transaction_tags WHERE transaction_id = $1`,
      [transaction.id],
    );

    const accountId = transaction.accountId;

    await queryRunner.manager.remove(transaction);

    // Reverse balance
    await this.recalculateBalance(accountId, queryRunner);
  }

  private async undoTransactionUpdate(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.entityId || !action.beforeData) return;

    const transaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: action.entityId, userId: action.userId },
    });
    if (!transaction) {
      throw new ConflictException("Cannot undo: transaction no longer exists");
    }

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
      await queryRunner.manager.update(
        Transaction,
        action.entityId,
        updateFields,
      );
    }

    // Restore splits if they were captured
    if (before.splits !== undefined) {
      await queryRunner.manager.delete(TransactionSplit, {
        transactionId: action.entityId,
      });

      if (Array.isArray(before.splits) && before.splits.length > 0) {
        for (const splitData of before.splits) {
          const split = queryRunner.manager.create(TransactionSplit, {
            id: splitData.id,
            transactionId: action.entityId,
            categoryId: splitData.categoryId,
            transferAccountId: splitData.transferAccountId || null,
            linkedTransactionId: splitData.linkedTransactionId || null,
            amount: splitData.amount,
            memo: splitData.memo || null,
          });
          await queryRunner.manager.save(split);
        }
      }
    }

    // Restore tags if captured
    if (before.tagIds !== undefined) {
      await queryRunner.query(
        `DELETE FROM transaction_tags WHERE transaction_id = $1`,
        [action.entityId],
      );
      if (Array.isArray(before.tagIds)) {
        for (const tagId of before.tagIds) {
          await queryRunner.query(
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
      await this.recalculateBalance(accountId, queryRunner);
    }
  }

  private async undoTransactionDelete(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.beforeData) return;

    const before = action.beforeData;

    // Verify account still exists
    const account = await queryRunner.manager.findOne(Account, {
      where: { id: before.accountId, userId: action.userId },
    });
    if (!account) {
      throw new ConflictException("Cannot undo: the account no longer exists");
    }

    // Re-insert the transaction
    await queryRunner.query(
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
        await queryRunner.query(
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
        await queryRunner.query(
          `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [before.id, tagId],
        );
      }
    }

    await this.recalculateBalance(before.accountId, queryRunner);
  }

  // --- Transfer undo handlers ---

  private async undoTransfer(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        await this.undoTransferCreate(action, queryRunner);
        break;
      case "delete":
        await this.undoTransferDelete(action, queryRunner);
        break;
      default:
        throw new ConflictException(
          `Unsupported transfer action: ${action.action}`,
        );
    }
  }

  private async undoTransferCreate(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.afterData) return;

    const { fromTransactionId, toTransactionId, fromAccountId, toAccountId } =
      action.afterData;

    // Delete both linked transactions
    for (const txId of [fromTransactionId, toTransactionId]) {
      if (!txId) continue;
      const tx = await queryRunner.manager.findOne(Transaction, {
        where: { id: txId, userId: action.userId },
      });
      if (tx) {
        await queryRunner.query(
          `DELETE FROM transaction_tags WHERE transaction_id = $1`,
          [txId],
        );
        // Unlink before deleting to avoid FK constraint
        await queryRunner.manager.update(Transaction, txId, {
          linkedTransactionId: null,
        });
      }
    }

    for (const txId of [fromTransactionId, toTransactionId]) {
      if (!txId) continue;
      await queryRunner.manager.delete(Transaction, { id: txId });
    }

    if (fromAccountId) {
      await this.recalculateBalance(fromAccountId, queryRunner);
    }
    if (toAccountId) {
      await this.recalculateBalance(toAccountId, queryRunner);
    }
  }

  private async undoTransferDelete(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.beforeData) return;

    const { fromTransaction, toTransaction } = action.beforeData;
    if (!fromTransaction || !toTransaction) return;

    // Re-insert both transactions without linked IDs first
    for (const txData of [fromTransaction, toTransaction]) {
      await queryRunner.query(
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
    await queryRunner.manager.update(Transaction, fromTransaction.id, {
      linkedTransactionId: toTransaction.id,
    });
    await queryRunner.manager.update(Transaction, toTransaction.id, {
      linkedTransactionId: fromTransaction.id,
    });

    await this.recalculateBalance(fromTransaction.accountId, queryRunner);
    await this.recalculateBalance(toTransaction.accountId, queryRunner);
  }

  // --- Investment transaction undo ---

  private async undoInvestmentTransaction(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        await this.undoInvestmentCreate(action, queryRunner);
        break;
      case "delete":
        await this.undoInvestmentDelete(action, queryRunner);
        break;
      default:
        throw new ConflictException(
          `Unsupported investment action: ${action.action}`,
        );
    }
  }

  private async undoInvestmentCreate(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.entityId) return;

    const invTx = await queryRunner.manager.findOne(InvestmentTransaction, {
      where: { id: action.entityId, userId: action.userId },
    });
    if (!invTx) return;

    // Delete linked cash transaction
    if (invTx.transactionId) {
      const cashTx = await queryRunner.manager.findOne(Transaction, {
        where: { id: invTx.transactionId },
      });
      if (cashTx) {
        await queryRunner.query(
          `DELETE FROM transaction_tags WHERE transaction_id = $1`,
          [cashTx.id],
        );
        await queryRunner.manager.remove(cashTx);
        await this.recalculateBalance(cashTx.accountId, queryRunner);
      }
    }

    const accountId = invTx.accountId;
    await queryRunner.manager.remove(invTx);

    // Rebuild holdings for this account
    await this.rebuildHoldings(action.userId, accountId, queryRunner);
  }

  private async undoInvestmentDelete(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.beforeData) return;

    const before = action.beforeData;

    // Re-insert linked cash transaction first (investment_transactions.transaction_id references it)
    if (before.linkedCashTransaction) {
      const cashTx = before.linkedCashTransaction;
      await queryRunner.query(
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
      await this.recalculateBalance(cashTx.accountId, queryRunner);
    }

    // Re-insert the investment transaction
    // Only reference the cash transaction FK if we actually restored it above;
    // older action history records may not have linkedCashTransaction captured.
    const restoredTransactionId = before.linkedCashTransaction
      ? (before.transactionId ?? null)
      : null;
    await queryRunner.query(
      `INSERT INTO investment_transactions (id, user_id, account_id, transaction_id, security_id,
        funding_account_id, action, transaction_date, quantity, price, commission, total_amount, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        before.id,
        action.userId,
        before.accountId,
        restoredTransactionId,
        before.securityId ?? null,
        before.fundingAccountId ?? null,
        before.action,
        before.transactionDate,
        before.quantity ?? 0,
        before.price ?? 0,
        before.commission ?? 0,
        before.totalAmount ?? 0,
        before.description ?? null,
        before.createdAt ?? new Date(),
      ],
    );

    // Rebuild holdings
    await this.rebuildHoldings(action.userId, before.accountId, queryRunner);
  }

  // --- Bulk transaction undo ---

  private async undoBulkTransaction(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    switch (action.action) {
      case "bulk_delete":
        await this.undoBulkDelete(action, queryRunner);
        break;
      case "bulk_update":
        await this.undoBulkUpdate(action, queryRunner);
        break;
      default:
        throw new ConflictException(
          `Unsupported bulk action: ${action.action}`,
        );
    }
  }

  private async undoBulkDelete(
    action: ActionHistory,
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!action.beforeData || !Array.isArray(action.beforeData.transactions))
      return;

    const accountIds = new Set<string>();

    for (const txData of action.beforeData.transactions) {
      await queryRunner.query(
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
      await this.recalculateBalance(accountId, queryRunner);
    }
  }

  private async undoBulkUpdate(
    action: ActionHistory,
    queryRunner: QueryRunner,
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
        await queryRunner.manager.update(Transaction, txData.id, updateFields);
      }

      // Restore tags if captured
      if (Array.isArray(txData.tagIds)) {
        await queryRunner.query(
          `DELETE FROM transaction_tags WHERE transaction_id = $1`,
          [txData.id],
        );
        for (const tagId of txData.tagIds) {
          await queryRunner.query(
            `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [txData.id, tagId],
          );
        }
      }

      accountIds.add(txData.accountId);
    }

    for (const accountId of accountIds) {
      await this.recalculateBalance(accountId, queryRunner);
    }
  }

  // --- Simple entity undo (categories, payees, tags, accounts) ---

  private async undoSimpleEntity(
    action: ActionHistory,
    queryRunner: QueryRunner,
    entityClass: any,
    tableName: string,
  ): Promise<void> {
    switch (action.action) {
      case "create":
        if (action.entityId) {
          await queryRunner.manager.delete(entityClass, {
            id: action.entityId,
          });
        }
        break;
      case "update":
        if (action.entityId && action.beforeData) {
          const updateFields = { ...action.beforeData };
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
            await queryRunner.manager.update(
              entityClass,
              action.entityId,
              updateFields,
            );
          }
        }
        break;
      case "delete":
        if (action.beforeData) {
          const data = { ...action.beforeData };
          // Ensure userId is set from the action
          data.userId = action.userId;
          await this.reinsertEntity(queryRunner, tableName, data);
        }
        break;
      default:
        throw new ConflictException(`Unsupported action: ${action.action}`);
    }
  }

  // --- Utility methods ---

  private async recalculateBalance(
    accountId: string,
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Use the same recalculation logic as AccountsService
    const result = await queryRunner.query(
      `SELECT a.opening_balance, COALESCE(SUM(t.amount), 0) as tx_sum
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
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
      await queryRunner.query(
        `UPDATE accounts SET current_balance = $1 WHERE id = $2`,
        [balance, accountId],
      );
    }
  }

  private async rebuildHoldings(
    userId: string,
    accountId: string,
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Delete existing holdings for this account
    await queryRunner.query(
      `DELETE FROM holdings WHERE account_id = $1`,
      [accountId],
    );

    // Rebuild from investment transactions
    const invTransactions = await queryRunner.query(
      `SELECT * FROM investment_transactions
       WHERE account_id = $1 AND user_id = $2 AND transaction_date <= CURRENT_DATE
       ORDER BY transaction_date ASC, created_at ASC`,
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
      const price = Number(tx.price || 0);

      switch (tx.action) {
        case "BUY":
        case "REINVEST":
        case "TRANSFER_IN":
        case "ADD_SHARES":
          current.quantity += qty;
          current.totalCost += qty * price;
          break;
        case "SELL":
        case "TRANSFER_OUT":
        case "REMOVE_SHARES":
          current.quantity -= qty;
          if (current.quantity <= 0) {
            current.totalCost = 0;
            current.quantity = Math.max(0, current.quantity);
          }
          break;
        case "SPLIT": {
          const ratio = qty;
          current.quantity = current.quantity * ratio;
          break;
        }
      }

      holdings.set(securityId, current);
    }

    // Insert rebuilt holdings
    for (const [securityId, data] of holdings) {
      if (data.quantity <= 0) continue;
      const avgCost =
        data.quantity > 0
          ? Math.round((data.totalCost / data.quantity) * 1000000) / 1000000
          : 0;

      await queryRunner.query(
        `INSERT INTO holdings (id, account_id, security_id, quantity, average_cost)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4)
         ON CONFLICT (account_id, security_id) DO UPDATE SET quantity = $3, average_cost = $4`,
        [accountId, securityId, data.quantity, avgCost],
      );
    }
  }

  private async reinsertEntity(
    queryRunner: QueryRunner,
    tableName: string,
    data: Record<string, any>,
  ): Promise<void> {
    const allowedCols = ALLOWED_COLUMNS[tableName];
    if (!allowedCols) {
      throw new ConflictException(
        `Unsupported table for re-insert: ${tableName}`,
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

    await queryRunner.query(
      `INSERT INTO "${tableName}" (${quotedCols.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (id) DO NOTHING`,
      values,
    );
  }

  private toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  private async pruneUserHistory(userId: string): Promise<void> {
    try {
      // Keep only the most recent MAX_HISTORY_PER_USER records
      const countResult = await this.actionHistoryRepository.count({
        where: { userId },
      });

      if (countResult > MAX_HISTORY_PER_USER) {
        const oldest = await this.actionHistoryRepository.find({
          where: { userId },
          order: { createdAt: "DESC" },
          skip: MAX_HISTORY_PER_USER,
          select: ["id"],
        });

        if (oldest.length > 0) {
          const idsToDelete = oldest.map((a) => a.id);
          await this.actionHistoryRepository.delete(idsToDelete);
        }
      }
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

      const result = await this.actionHistoryRepository
        .createQueryBuilder()
        .delete()
        .where("created_at < :cutoff", { cutoff })
        .execute();

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
