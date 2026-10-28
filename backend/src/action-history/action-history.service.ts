import { replayTaxonomyOperation } from "../accruals/accrual-taxonomy-operation";
import {
  guardAccruedTagDeletion,
  guardLegacyTagRestore,
} from "../accruals/accrual-tag-guard";
import {
  replayRelationshipHistory,
  guardLegacyRelationshipHistory,
} from "../accruals/accrual-relationship-history";
import {
  parseAccrualBulkDelete,
  clearAccrualBulkDeleteChildren,
  assertAccrualBulkDeleteStructure,
  equalBulkDeleteSnapshots,
  type BulkDeleteSnapshot,
} from "../accruals/accrual-bulk-delete";
import { MAX_JSONB_SIZE_BYTES } from "./history-limits";
import { accrualErrors } from "../accruals/accrual-errors";
import {
  readAccrualHistoryState,
  assertAccrualHistoryState,
  captureAccrualHistorySnapshot,
  assertAccrualStructureRestorable,
  restoreAccrualHistoryState,
  restoreAccrualSplitTags,
} from "../accruals/accrual-history-snapshot";
import {
  lockAccrualReplaySources,
  refreshAccrualReplaySources,
} from "../accruals/accrual-history-replay";
import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { ModuleRef } from "@nestjs/core";
import { DataSource, EntityManager } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { BondPriceService } from "../bonds/bond-price.service";
import type { HoldingsService } from "../securities/holdings.service";
import {
  clearForeignSeries,
  restoredSeries,
} from "../bonds/bond-series-resolver";
import { beginBondWriteGuard } from "../bonds/bond-write-guard";
import { findBondLinkProblem } from "../securities/bond-link.util";
import { ActionHistory } from "./entities/action-history.entity";
import {
  RULE_RUN_ENTITY_TYPE,
  assertRuleRunRedoable,
  undoRuleRun,
} from "./rule-run-undo";
import {
  LegBalanceWriter,
  removeLockedTransactionLeg,
} from "../transactions/remove-transaction-leg";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { Account } from "../accounts/entities/account.entity";
import { withResolvedMortgageTypeProperty } from "../accounts/legacy-mortgage-type.util";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Security } from "../securities/entities/security.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Budget } from "../budgets/entities/budget.entity";
import { CustomReport } from "../reports/entities/custom-report.entity";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import { withSystemContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import {
  LockedTransactionRow,
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";
import { invalidatePortfolioSummary } from "../securities/portfolio-summary-memo";

/**
 * A create whose snapshot links the row to a counterpart leg (a transfer leg,
 * or a split line with a linked leg) cannot be redone: the undo deleted the
 * leg, and re-inserting the row would point at a row that is gone.
 */
function assertTransactionCreateRedoable(action: ActionHistory): void {
  const after = action.afterData;
  const splits: unknown[] = Array.isArray(after?.splits) ? after.splits : [];
  const hasLegs =
    (after?.isTransfer === true && !!after?.linkedTransactionId) ||
    splits.some(
      (split) =>
        !!(split as { linkedTransactionId?: string | null })
          ?.linkedTransactionId,
    );
  if (!hasLegs) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.redoCreateWithLegs",
      "This transaction created entries in other accounts, so it cannot be redone. Create it again instead",
    ),
    errorCode: "REDO_CREATE_WITH_LEGS",
  });
}

/**
 * Account columns an undo or redo never writes back from a snapshot.
 *
 * `current_balance` is derived from the ledger: restoring the edit-time figure
 * erased every movement no action recorded since (the due-balance cron, a
 * bank sync, a grantee's posting), leaving chequing at 5,000.00 beside a
 * ledger of 4,800.00 (A26-H06). The rest are lifecycle and pairing state the
 * account edit does not change; close, reopen and pairing have their own
 * paths with their own checks.
 */
const ACCOUNT_UNDO_DERIVED_FIELDS = [
  "currentBalance",
  "isClosed",
  "closedDate",
  "linkedAccountId",
] as const;

/**
 * A loan's columns that `AccountsService.update` couples to its payment
 * template: a change to any of them reprices the template or relinks its
 * interest line in the same transaction (INV-LOAN-007, INV-LOAN-010). A
 * snapshot restore replays the column and not the coupling, so the bill kept
 * the other method's installment, or the template stopped being managed.
 */
const LOAN_TEMPLATE_FIELDS = [
  "mortgageType",
  "prepaymentMode",
  "amortizationMonths",
  "originalPrincipal",
  "paymentAmount",
  "paymentFrequency",
  "interestCategoryId",
  "sourceAccountId",
  "scheduledTransactionId",
  "paymentMatchingRuleId",
] as const;

/**
 * Refuses, before anything is written, the undo or redo of an account edit
 * that changed a template-coupled column of a loan with a schedule: the user
 * edits the loan back, which runs the reprice and relink.
 */
function assertAccountEditUndoable(action: ActionHistory): void {
  const before = action.beforeData ?? {};
  const after = action.afterData ?? {};
  if (!(before.scheduledTransactionId ?? after.scheduledTransactionId)) return;
  const changed = LOAN_TEMPLATE_FIELDS.some(
    (field) =>
      JSON.stringify(before[field] ?? null) !==
      JSON.stringify(after[field] ?? null),
  );
  if (!changed) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.loanEditNotUndoable",
      "This loan change cannot be undone automatically. Edit the loan to change it back.",
    ),
    errorCode: "LOAN_EDIT_NOT_UNDOABLE",
  });
}

interface SplitSnapshot {
  kind?: string | null;
  categoryId?: string | null;
  transferAccountId?: string | null;
  linkedTransactionId?: string | null;
  amount?: number | string | null;
  memo?: string | null;
}

function splitKindOf(split: SplitSnapshot): SplitKind {
  return (
    (split.kind as SplitKind | null | undefined) ??
    (split.transferAccountId ? SplitKind.TRANSFER : SplitKind.CATEGORY)
  );
}

/** A split line that moves money outside its own row (a leg in another account). */
function isLegSplit(split: SplitSnapshot): boolean {
  return (
    !!split.transferAccountId ||
    !!split.linkedTransactionId ||
    splitKindOf(split) !== SplitKind.CATEGORY
  );
}

/**
 * Whether two split snapshots hold the same lines by value, order aside. Ids
 * and linked leg ids are left out: an edit that resends the splits re-creates
 * both, and that is not a change the user made.
 */
function splitsEqualByValue(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const keys = (list: SplitSnapshot[]) =>
    list
      .map((s) =>
        JSON.stringify([
          splitKindOf(s),
          s.categoryId ?? null,
          s.transferAccountId ?? null,
          Math.round(Number(s.amount) * 10000),
          s.memo || null,
        ]),
      )
      .sort();
  return JSON.stringify(keys(a)) === JSON.stringify(keys(b));
}

/**
 * Refuses, before anything is written, the undo or redo of an edit that
 * changed split lines which move money to other accounts: the edit deleted
 * and re-created the counterpart legs, so the recorded lines name rows that
 * are gone. The user edits the transaction back instead.
 */
function assertSplitLegsUndoable(
  beforeSplits: unknown,
  afterSplits: unknown,
): void {
  const lists = [beforeSplits, afterSplits].map((list) =>
    Array.isArray(list) ? (list as SplitSnapshot[]) : [],
  );
  if (!lists.some((list) => list.some(isLegSplit))) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.undoSplitLegsChanged",
      "This edit changed split lines that move money to other accounts, so it cannot be undone automatically. Edit the transaction to change it back.",
    ),
    errorCode: "UNDO_SPLIT_LEGS_CHANGED",
  });
}

/**
 * Refuses, before anything is written, the undo or redo of a status edit that
 * voided or restored a row with legs: the edit propagated VOID to the
 * counterparts in other accounts, but history holds only the edited row, so a
 * replay would move one side of the pair. The user changes the status back.
 */
function assertVoidChangeUndoable(
  before: Record<string, any>,
  after: Record<string, any>,
): void {
  if ((before.status === "VOID") === (after.status === "VOID")) return;
  const hasLegs = [before, after].some(
    (snap) =>
      (snap.isTransfer === true && !!snap.linkedTransactionId) ||
      (Array.isArray(snap.splits) &&
        (snap.splits as SplitSnapshot[]).some(
          (split) => !!split.linkedTransactionId || !!split.transferAccountId,
        )),
  );
  if (!hasLegs) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.undoVoidWithLegs",
      "This change voided or restored entries in other accounts, so it cannot be undone automatically. Change the status back instead.",
    ),
    errorCode: "UNDO_VOID_WITH_LEGS",
  });
}

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

/**
 * What an undo leaves for after its commit: the scheduled payments whose
 * occurrence claim a rule-run undo released, repriced once the transaction
 * has committed (INV-CACHE-001; `docs/specs/loan-installment-settlement.md`
 * section 12.6). Empty for every other entry.
 */
interface UndoAfterCommit {
  readonly settledScheduleIds: readonly string[];
  /**
   * Accounts whose derived state changed because the undo deleted a security's
   * bond-engine prices (its link was restored to something else); published
   * after the commit (INV-CACHE-001).
   */
  readonly bondClearedAccountIds?: readonly string[];
  /**
   * Securities whose bond-engine prices are recomputed after the commit: a
   * restored link, or a ledger row an undo or redo created, changed or removed
   * (a security that is not linked is ignored).
   */
  readonly bondRecomputeSecurityIds?: readonly string[];
}

const NOTHING_AFTER_COMMIT: UndoAfterCommit = { settledScheduleIds: [] };

const MAX_HISTORY_PER_USER = 100;
export { MAX_JSONB_SIZE_BYTES } from "./history-limits";

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
    "payment_matching_rule_id",
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
    "bond_program_id",
    "bond_auto_fetch",
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
    "bond_instrument_id",
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

  constructor(
    private dataSource: DataSource,
    // Resolved lazily (`bondPrices`): the bond layer reaches this module back
    // through the securities module, so a constructor edge would be a cycle.
    private moduleRef: ModuleRef,
  ) {}

  private bondPrices(): BondPriceService {
    return this.moduleRef.get(BondPriceService, { strict: false });
  }

  /**
   * Resolved lazily, like `bondPrices`, and its class loaded at the call: the
   * securities layer reaches this file back through its imports, so a
   * top-level value import of `HoldingsService` is a load-time cycle that
   * leaves a provider undefined when SecuritiesModule is built.
   */
  private holdings(): HoldingsService {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require("../securities/holdings.service") as {
      HoldingsService: typeof HoldingsService;
    };
    return this.moduleRef.get(loaded.HoldingsService, { strict: false });
  }

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

    const afterCommit = await withScopedDb(this.dataSource, async (manager) => {
      const effects = await this.executeUndo(action, manager);
      await manager.update(ActionHistory, action.id, {
        isUndone: true,
      });
      return effects;
    });

    // After the commit, like every other derived-state invalidation here: a
    // replay that rolled back must not have dropped the memo that still
    // describes the committed state.
    invalidatePortfolioSummary(userId);
    // A released settlement leaves its schedule's template priced on a debt
    // the undo has since changed: repriced after the commit, never inside it.
    await repriceSettledLoanTemplates(
      this.dataSource,
      afterCommit.settledScheduleIds,
    );
    await this.publishBondEffects(userId, afterCommit);

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

    const afterCommit = await withScopedDb(this.dataSource, async (manager) => {
      const effects = await this.executeRedo(action, manager);
      await manager.update(ActionHistory, action.id, {
        isUndone: false,
      });
      return effects;
    });

    invalidatePortfolioSummary(userId);
    await this.publishBondEffects(userId, afterCommit);

    return { action, description: `Redone: ${action.description}` };
  }

  private async executeUndo(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<UndoAfterCommit> {
    switch (action.entityType) {
      case "accrual_relationship_operation":
        await replayTaxonomyOperation(manager, action);
        break;
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
        await this.undoAccount(action, manager);
        break;
      case "scheduled_transaction":
        await this.undoSimpleEntity(
          action,
          manager,
          ScheduledTransaction,
          "scheduled_transactions",
        );
        break;
      case "security": {
        const bond = await this.guardSecurityLinkRestore(action, manager);
        await this.undoSimpleEntity(action, manager, Security, "securities");
        return { ...NOTHING_AFTER_COMMIT, ...bond };
      }
      case "investment_transaction":
        await this.undoInvestmentTransaction(action, manager);
        // The ledger the engine reads changed: a linked security is repriced.
        return {
          ...NOTHING_AFTER_COMMIT,
          bondRecomputeSecurityIds: this.investmentSecurityIds(action),
        };
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
      case RULE_RUN_ENTITY_TYPE: {
        const undone = await undoRuleRun(
          action,
          manager,
          this.legBalances(manager, action),
        );
        return { settledScheduleIds: [...undone.settledScheduleIds] };
      }
      default:
        throw new ConflictException(
          tr(
            "errors.actionHistory.undoNotSupportedForEntityType",
            `Undo not supported for entity type: ${action.entityType}`,
            { entityType: action.entityType },
          ),
        );
    }
    return NOTHING_AFTER_COMMIT;
  }

  private async executeRedo(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<UndoAfterCommit> {
    if (
      action.entityType === "bulk_transaction" &&
      action.action === "bulk_delete" &&
      action.beforeData?.accrualBulkDeleteVersion === 1
    ) {
      await this.redoAccrualBulkDelete(action, manager);
      return NOTHING_AFTER_COMMIT;
    }
    // A run that restructured rows cannot be replayed from its snapshot.
    if (action.entityType === RULE_RUN_ENTITY_TYPE) {
      assertRuleRunRedoable(action);
    }
    // Redo of a create replays the row from its stored snapshot, which names
    // the legs the undo deleted (a rule's transfer counterpart, transfer split
    // lines): they cannot be replayed, so a create that had any is refused
    // before anything is written, as a structural rule run's redo is.
    if (action.entityType === "transaction" && action.action === "create") {
      assertTransactionCreateRedoable(action);
    }
    // Redo is the inverse of undo: swap before/after and flip the action
    const invertedAction: ActionHistory = {
      ...action,
      beforeData: action.afterData,
      afterData: action.beforeData,
      action: this.invertAction(action.action),
    };
    return this.executeUndo(invertedAction, manager);
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

    const peek = await manager.findOne(Transaction, {
      where: { id: action.entityId, userId: action.userId },
    });
    if (!peek) return;

    // A create can leave legs in other accounts: the counterpart of a rule's
    // `convert_to_transfer`, and the linked leg of every transfer split line
    // (a rule's `split` or a person's). They are part of what the create wrote,
    // so the undo removes them with their balance, `deletionBalanceEffect` per
    // leg like the undo of a rule run. Locks: the row with a transfer
    // counterpart in one ascending batch, then the split legs after their
    // parent (`common/db/locks.ts`); the reconciled check runs on all of them
    // before the first write, so a refusal changes nothing.
    const locked = await lockTransactionRows(
      manager,
      [
        peek.id,
        ...(peek.isTransfer && peek.linkedTransactionId
          ? [peek.linkedTransactionId]
          : []),
      ],
      action.userId,
    );
    const parent = locked.get(peek.id);
    if (!parent) return;

    const transaction = await manager.findOne(Transaction, {
      where: { id: action.entityId, userId: action.userId },
      relations: ["splits"],
    });
    if (!transaction) return;

    const legs = new Map<string, LockedTransactionRow>();
    if (parent.linkedTransactionId) {
      const transferLeg =
        locked.get(parent.linkedTransactionId) ??
        (
          await lockTransactionRows(
            manager,
            [parent.linkedTransactionId],
            action.userId,
          )
        ).get(parent.linkedTransactionId);
      if (transferLeg) legs.set(transferLeg.id, transferLeg);
    }
    const splitLegIds = (transaction.splits ?? [])
      .map((split) => split.linkedTransactionId)
      .filter((id): id is string => !!id && !legs.has(id));
    for (const leg of (
      await lockTransactionRows(manager, splitLegIds, action.userId)
    ).values()) {
      legs.set(leg.id, leg);
    }
    await assertReconciledRowsMutable(manager, action.userId, [
      parent,
      ...legs.values(),
    ]);

    if (action.isUndone) {
      await assertAccrualHistoryState(
        manager,
        action.userId,
        transaction.id,
        action.afterData?.accrualState,
      );
    } else {
      const current = await readAccrualHistoryState(
        manager,
        action.userId,
        transaction.id,
      );
      if (current.schedules.length) {
        const snapshot = { ...action.afterData };
        await captureAccrualHistorySnapshot(
          manager,
          action.userId,
          transaction.id,
          snapshot,
        );
        assertAccrualStructureRestorable(snapshot);
        await manager.update(ActionHistory, action.id, { afterData: snapshot });
      }
    }

    const balances = this.legBalances(manager, action);
    for (const leg of legs.values()) {
      // A leg linked elsewhere is not this create's to remove.
      if (leg.linkedTransactionId !== transaction.id) continue;
      await removeLockedTransactionLeg(manager, leg, action.userId, balances);
    }

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
    assertVoidChangeUndoable(before, action.afterData ?? {});

    // A change is a value difference: a form resends every split, so equal
    // lines leave the rows (and the legs they link) alone. Changed lines that
    // carry a leg cannot be replayed from the snapshot; refuse before a write.
    const restoreSplits =
      before.splits !== undefined &&
      !splitsEqualByValue(before.splits, action.afterData?.splits);
    if (restoreSplits) {
      assertSplitLegsUndoable(before.splits, action.afterData?.splits);
    }
    await assertAccrualHistoryState(
      manager,
      action.userId,
      action.entityId,
      action.afterData?.accrualState,
    );
    assertAccrualStructureRestorable(before);

    // Restore transaction fields
    const updateFields: Partial<Transaction> = {};
    const fieldKeys = [
      "accountId",
      "transactionDate",
      "amount",
      "currencyCode",
      "exchangeRate",
      "originalAmount",
      "originalCurrencyCode",
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

    // Restore splits if they were captured and the edit changed them
    if (restoreSplits) {
      await manager.delete(TransactionSplit, {
        transactionId: action.entityId,
      });

      if (Array.isArray(before.splits) && before.splits.length > 0) {
        for (const splitData of before.splits) {
          const split = manager.create(TransactionSplit, {
            id: splitData.id,
            ...(splitData.kind ? { kind: splitData.kind } : {}),
            transactionId: action.entityId,
            kind: splitKindOf(splitData),
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

    await restoreAccrualSplitTags(
      manager,
      action.userId,
      action.entityId,
      before,
    );
    await restoreAccrualHistoryState(
      manager,
      action.userId,
      action.entityId,
      before.accrualState,
    );

    // Recalculate balances for affected accounts
    const accountIds = new Set<string>();
    if (before.accountId) accountIds.add(before.accountId);
    accountIds.add(transaction.accountId);

    for (const accountId of accountIds) {
      await this.recalculateBalance(action.userId, accountId, manager);
    }
    if (before.accrualState) {
      const accrualState = await readAccrualHistoryState(
        manager,
        action.userId,
        action.entityId,
      );
      await manager.update(ActionHistory, action.id, {
        [action.isUndone ? "afterData" : "beforeData"]: {
          ...before,
          accrualState,
        },
      });
    }
  }

  private async undoTransactionDelete(
    action: ActionHistory,
    manager: EntityManager,
    persistExpectation = true,
    deferBalance = false,
  ): Promise<void> {
    if (!action.beforeData) return;

    const before = action.beforeData;
    assertAccrualStructureRestorable(before);

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

    if (
      before.accrualState?.schedules?.length &&
      account.currencyCode !== before.currencyCode
    ) {
      throw accrualErrors.conflict();
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

    if (before.accrualState) {
      await manager.query(
        "UPDATE transactions SET original_amount=$1,original_currency_code=$2 WHERE id=$3 AND user_id=$4",
        [
          before.originalAmount ?? null,
          before.originalCurrencyCode ?? null,
          before.id,
          action.userId,
        ],
      );
    }

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

    await restoreAccrualSplitTags(manager, action.userId, before.id, before);
    await restoreAccrualHistoryState(
      manager,
      action.userId,
      before.id,
      before.accrualState,
    );

    if (!deferBalance)
      await this.recalculateBalance(action.userId, before.accountId, manager);
    if (before.accrualState && persistExpectation) {
      const accrualState = await readAccrualHistoryState(
        manager,
        action.userId,
        before.id,
      );
      await manager.update(ActionHistory, action.id, {
        [action.isUndone ? "afterData" : "beforeData"]: {
          ...before,
          accrualState,
        },
      });
    }
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
      Record<string, any> | undefined;

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

    // The legs as they are now, read before either is rewritten: their current
    // accounts join the holdings rebuild, their current securities the bond
    // guard's before-state.
    const legs = [before, linkedBefore];
    const currentLegs = new Map<string, InvestmentTransaction | null>();
    for (const legBefore of legs) {
      currentLegs.set(
        legBefore.id,
        await manager.findOne(InvestmentTransaction, {
          where: { id: legBefore.id, userId: action.userId },
        }),
      );
    }
    const bondGuard = await beginBondWriteGuard(manager, action.userId, [
      ...legs.map((leg) => leg.securityId),
      ...[...currentLegs.values()].map((leg) => leg?.securityId),
    ]);

    const accountIds = new Set<string>();
    for (const legBefore of legs) {
      // Capture the leg's current (post-edit) account before we overwrite it so
      // holdings are rebuilt for both the old and the new account.
      const current = currentLegs.get(legBefore.id);
      if (current) accountIds.add(current.accountId);

      // INV-BOND-007: the snapshot's series goes back exactly as it was, never
      // inferred (an undo must not fail for a series the row already had, or
      // never had). One that names a series outside the security's current
      // program is stored as NULL and the ledger reports the row.
      const bondInstrumentId = await restoredSeries(
        manager,
        action.userId,
        legBefore.securityId,
        legBefore.bondInstrumentId,
      );
      await manager.update(
        InvestmentTransaction,
        { id: legBefore.id, userId: action.userId },
        {
          accountId: legBefore.accountId,
          securityId: legBefore.securityId ?? null,
          bondInstrumentId,
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

    // A restore that leaves a removal the account cannot cover is refused here,
    // and the transaction of the undo rolls back with it.
    await bondGuard.verify(legs.map((leg) => leg.id));
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

    // Undoing a create deletes the rows: refused when that leaves a removal of
    // a program-linked security uncovered (INV-BOND-007).
    const bondGuard = await beginBondWriteGuard(
      manager,
      action.userId,
      legs.map((leg) => leg.securityId),
    );

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

    await bondGuard.verify();
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
      Record<string, any> | undefined;

    const bondGuard = await beginBondWriteGuard(manager, action.userId, [
      before.securityId,
      linkedLeg?.securityId,
    ]);

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

    await bondGuard.verify(linkedLeg ? [before.id, linkedLeg.id] : [before.id]);
  }

  private async reinsertInvestmentTransaction(
    manager: EntityManager,
    userId: string,
    data: Record<string, any>,
    transactionId: string | null,
  ): Promise<void> {
    // INV-BOND-007: the snapshot's series goes back as it was, never inferred;
    // one outside the security's current program is stored as NULL.
    const bondInstrumentId = await restoredSeries(
      manager,
      userId,
      data.securityId,
      data.bondInstrumentId,
    );
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
        funding_account_id, action, transaction_date, quantity, price, commission, total_amount, exchange_rate, description, created_at,
        bond_instrument_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        bondInstrumentId,
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
    if (action.beforeData?.accrualBulkDeleteVersion === 1) {
      await this.undoAccrualBulkDelete(action, manager);
      return;
    }
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

  /** Versioned operations serialize before source/account rows; history rows are written last. */
  private async currentAccrualBulkAction(
    action: ActionHistory,
    manager: EntityManager,
    isUndone: boolean,
  ): Promise<ActionHistory> {
    await acquireAdvisoryLock(
      manager,
      LockScope.AccrualBulkHistory,
      action.userId,
    );
    const current = await manager.findOne(ActionHistory, {
      where: { id: action.id, userId: action.userId },
    });
    if (!current || current.isUndone !== isUndone)
      throw accrualErrors.conflict();
    return current;
  }

  private async undoAccrualBulkDelete(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    const current = await this.currentAccrualBulkAction(action, manager, false);
    const data = parseAccrualBulkDelete(current.beforeData);
    const ids = data.transactions.map((row) => row.id);
    const collisions: { id: string }[] = await manager.query(
      "SELECT id FROM transactions WHERE user_id=$1 AND id=ANY($2)",
      [action.userId, ids],
    );
    if (collisions.length) throw accrualErrors.conflict();
    // Check every account before recreating the first row; a late failure still
    // rolls the entire batch back, including restored schedules and balances.
    for (const row of data.transactions) {
      const account = await manager.findOne(Account, {
        where: { id: row.accountId, userId: action.userId },
      });
      if (!account || account.currencyCode !== row.currencyCode)
        throw accrualErrors.conflict();
    }
    const restored: BulkDeleteSnapshot[] = [];
    for (const row of data.transactions) {
      await this.undoTransactionDelete(
        { ...current, beforeData: row, entityId: row.id },
        manager,
        false,
        true,
      );
      const snapshot: Record<string, unknown> = {};
      await captureAccrualHistorySnapshot(
        manager,
        action.userId,
        row.id,
        snapshot,
        true,
      );
      restored.push(snapshot as BulkDeleteSnapshot);
    }
    // All source rows exist before accounts are locked, in sorted order.
    // Recheck currencies under those balance locks to close a metadata race.
    for (const accountId of [
      ...new Set(data.transactions.map((row) => row.accountId)),
    ].sort()) {
      await this.recalculateBalance(action.userId, accountId, manager);
      const account = await manager.findOne(Account, {
        where: { id: accountId, userId: action.userId },
      });
      if (
        !account ||
        data.transactions.some(
          (row) =>
            row.accountId === accountId &&
            row.currencyCode !== account.currencyCode,
        )
      )
        throw accrualErrors.conflict();
    }
    // Conditional history write is last: a concurrent redo-stack clear must
    // produce a conflict/rollback rather than an untracked source restoration.
    const result = await manager
      .createQueryBuilder()
      .update(ActionHistory)
      .set({ beforeData: { ...data, transactions: restored } })
      .where("id=:id AND user_id=:userId AND is_undone=false", {
        id: action.id,
        userId: action.userId,
      })
      .execute();
    if (result.affected !== 1) throw accrualErrors.conflict();
  }

  private async redoAccrualBulkDelete(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    const current = await this.currentAccrualBulkAction(action, manager, true);
    const data = parseAccrualBulkDelete(current.beforeData);
    const ids = data.transactions.map((row) => row.id);
    const locked = await lockTransactionRows(manager, ids, action.userId);
    if (locked.size !== ids.length) throw accrualErrors.conflict();
    await assertReconciledRowsMutable(manager, action.userId, [
      ...locked.values(),
    ]);
    const actual: BulkDeleteSnapshot[] = [];
    for (const row of data.transactions) {
      await assertAccrualHistoryState(
        manager,
        action.userId,
        row.id,
        row.accrualState,
      );
      const snapshot: Record<string, unknown> = {};
      await captureAccrualHistorySnapshot(
        manager,
        action.userId,
        row.id,
        snapshot,
        true,
      );
      if (!equalBulkDeleteSnapshots(row, snapshot as BulkDeleteSnapshot))
        throw accrualErrors.conflict();
      actual.push(snapshot as BulkDeleteSnapshot);
    }
    await assertAccrualBulkDeleteStructure(manager, action.userId, actual);
    await clearAccrualBulkDeleteChildren(manager, action.userId, ids);
    await manager
      .createQueryBuilder()
      .delete()
      .from(Transaction)
      .where("id IN (:...ids)", { ids })
      .andWhere("userId=:userId", { userId: action.userId })
      .execute();
    for (const accountId of [
      ...new Set([...locked.values()].map((row) => row.accountId)),
    ].sort()) {
      await this.recalculateBalance(action.userId, accountId, manager);
    }
    const result = await manager
      .createQueryBuilder()
      .update(ActionHistory)
      .set({ isUndone: false })
      .where("id=:id AND user_id=:userId AND is_undone=true", {
        id: action.id,
        userId: action.userId,
      })
      .execute();
    if (result.affected !== 1) throw accrualErrors.conflict();
  }

  private async undoBulkUpdate(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (!action.beforeData || !Array.isArray(action.beforeData.transactions))
      return;

    // INV-RECONCILE-001: the restore rewrites every row's status and fields
    // (redo reaches here too, via `executeRedo`), so a reconciled locked row
    // refuses the whole batch, as the single-row undo does. Locked first, and
    // checked before the first write.
    const locked = await lockTransactionRows(
      manager,
      action.beforeData.transactions.map((txData: { id: string }) => txData.id),
      action.userId,
    );
    await assertReconciledRowsMutable(manager, action.userId, [
      ...locked.values(),
    ]);

    const accrualSourceIds = await lockAccrualReplaySources(
      manager,
      action.userId,
      action.beforeData.transactions.map((row) => row.id),
    );
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
      // parent transaction (invariant I3, docs/specs/split-bulk-update.md).
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

    await refreshAccrualReplaySources(manager, action.userId, accrualSourceIds);

    for (const accountId of accountIds) {
      await this.recalculateBalance(action.userId, accountId, manager);
    }
  }

  // --- Bond links and the engine's prices ---

  /**
   * The securities an investment-transaction entry touched, from its snapshots
   * (the row, and the other leg of a transfer).
   */
  private investmentSecurityIds(action: ActionHistory): string[] {
    const ids = new Set<string>();
    for (const snapshot of [action.beforeData, action.afterData]) {
      if (!snapshot) continue;
      for (const row of [snapshot, snapshot.linkedTransferLeg]) {
        const id = (row as Record<string, unknown> | undefined)?.securityId;
        if (typeof id === "string") ids.add(id);
      }
    }
    return [...ids];
  }

  /**
   * Before an undo or redo of a security edit (or of its deletion) writes the
   * recorded state back, the bond link in that state is held to the rules of a
   * normal edit: the instrument exists, the security is of type BOND and in the
   * instrument's currency (`findBondLinkProblem`, the check `SecuritiesService`
   * runs). A state that is no longer valid refuses the undo with a code and
   * writes nothing. A link that changes also deletes the engine's prices of the
   * old one, inside this transaction under the recompute lock; the new link is
   * priced after the commit.
   */
  private async guardSecurityLinkRestore(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<UndoAfterCommit> {
    const target = action.beforeData as Record<string, any> | null;
    if (!target || !action.entityId) return NOTHING_AFTER_COMMIT;
    const lower = (v: unknown) =>
      typeof v === "string" ? v.toLowerCase() : (v ?? null);

    if (action.action === "delete") {
      // Re-inserting a deleted security: its recorded link is checked as is.
      const link = lower(target.bondProgramId) as string | null;
      if (!link) return NOTHING_AFTER_COMMIT;
      await this.assertRestorableLink(manager, link, target);
      return {
        settledScheduleIds: [],
        bondRecomputeSecurityIds: [action.entityId],
      };
    }
    if (action.action !== "update") return NOTHING_AFTER_COMMIT;
    // A snapshot that names none of the three fields a link depends on cannot
    // change whether the link is valid.
    if (
      !["bondProgramId", "securityType", "currencyCode"].some(
        (k) => k in target,
      )
    ) {
      return NOTHING_AFTER_COMMIT;
    }

    // A restored link may delete the engine's rows under the recompute lock
    // (`clearEnginePrices`): that advisory lock comes before the row lock, the
    // order every writer uses (`common/db/locks.ts`).
    if ("bondProgramId" in target) {
      await acquireAdvisoryLock(
        manager,
        LockScope.BondPriceRecompute,
        action.entityId,
      );
    }
    const rows: Array<{
      bond_program_id: string | null;
      security_type: string | null;
      currency_code: string;
    }> = await manager.query(
      `SELECT bond_program_id, security_type, currency_code
         FROM securities
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [action.entityId, action.userId],
    );
    const current = rows[0];
    if (!current) return NOTHING_AFTER_COMMIT;

    const has = (key: string) => key in target && target[key] !== undefined;
    const link = has("bondProgramId")
      ? (lower(target.bondProgramId) as string | null)
      : (lower(current.bond_program_id) as string | null);
    const securityType = has("securityType")
      ? (target.securityType ?? null)
      : current.security_type;
    const currencyCode = has("currencyCode")
      ? target.currencyCode
      : current.currency_code;
    const linkChanged =
      link !== (lower(current.bond_program_id) as string | null);

    if (
      link &&
      (linkChanged ||
        securityType !== current.security_type ||
        currencyCode !== current.currency_code)
    ) {
      await this.assertRestorableLink(manager, link, {
        securityType,
        currencyCode,
      });
    }
    if (!linkChanged) return NOTHING_AFTER_COMMIT;

    const { accountIds } = await this.bondPrices().clearEnginePrices(
      manager,
      action.userId,
      action.entityId,
    );
    // INV-BOND-007: the restored link owns the series its rows name.
    await clearForeignSeries(manager, action.userId, action.entityId, link);
    return {
      settledScheduleIds: [],
      bondClearedAccountIds: accountIds,
      bondRecomputeSecurityIds: link ? [action.entityId] : [],
    };
  }

  private async assertRestorableLink(
    manager: EntityManager,
    bondProgramId: string,
    state: Record<string, any>,
  ): Promise<void> {
    const problem = await findBondLinkProblem(manager, {
      bondProgramId,
      currencyCode: state.currencyCode,
      securityType: state.securityType,
    });
    if (problem) {
      throw new ConflictException(
        tr(
          "errors.bonds.UNDO_LINK_INVALID",
          "This change cannot be undone because the bond link it would restore is no longer valid",
        ),
      );
    }
  }

  /** After the commit of an undo or redo (INV-CACHE-001): never inside it. */
  private async publishBondEffects(
    userId: string,
    effects: UndoAfterCommit,
  ): Promise<void> {
    const cleared = effects.bondClearedAccountIds ?? [];
    const ids = effects.bondRecomputeSecurityIds ?? [];
    if (cleared.length === 0 && ids.length === 0) return;
    try {
      const bond = this.bondPrices();
      if (cleared.length > 0) bond.publishClearedPrices(userId, cleared);
      if (ids.length > 0) await bond.recomputeLinkedSecurities(userId, ids);
    } catch (error) {
      this.logger.warn(
        `Bond price recompute after an undo failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * An account edit's undo or redo restores what the user edited and never
   * what is derived (A26-H06): the derived and lifecycle columns are left out,
   * a restored opening balance recomputes `current_balance` from the ledger
   * under the balance-write lock, and a loan's template-coupled change is
   * refused rather than restored without its reprice and relink.
   */
  private async undoAccount(
    action: ActionHistory,
    manager: EntityManager,
  ): Promise<void> {
    if (action.action !== "update") {
      await this.undoSimpleEntity(action, manager, Account, "accounts");
      return;
    }
    assertAccountEditUndoable(action);
    const beforeData = { ...(action.beforeData ?? {}) };
    for (const field of ACCOUNT_UNDO_DERIVED_FIELDS) delete beforeData[field];
    await this.undoSimpleEntity(
      { ...action, beforeData },
      manager,
      Account,
      "accounts",
    );
    const openingRestored =
      JSON.stringify(action.beforeData?.openingBalance ?? null) !==
      JSON.stringify(action.afterData?.openingBalance ?? null);
    if (action.entityId && openingRestored) {
      await this.recalculateBalance(action.userId, action.entityId, manager);
    }
  }

  // --- Simple entity undo (categories, payees, tags, accounts) ---

  private async undoSimpleEntity(
    action: ActionHistory,
    manager: EntityManager,
    entityClass: any,
    tableName: string,
  ): Promise<void> {
    if (action.entityType === "tag") {
      if (action.action === "create" && action.entityId)
        await guardAccruedTagDeletion(manager, action.userId, action.entityId);
      if (action.action === "delete")
        await guardLegacyTagRestore(manager, action.userId);
    }
    if (["category", "payee"].includes(action.entityType)) {
      if (await replayRelationshipHistory(manager, action)) return;
      await guardLegacyRelationshipHistory(manager, action);
    }
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
   * before the mortgage type was required carries the legacy flags, which no
   * code reads now, and a null or missing type; it is replayed with the type
   * the default migration would have given it.
   */
  private replayableSnapshot(
    tableName: string,
    snapshot: Record<string, any>,
  ): Record<string, any> {
    return tableName === "accounts"
      ? withResolvedMortgageTypeProperty(snapshot)
      : { ...snapshot };
  }

  /**
   * The two balance operations `removeLockedTransactionLeg` needs, on the
   * undo's own manager and scoped to the action's user: an atomic delta (the
   * statement every delta writer uses, `docs/concurrency-and-idempotency.md`
   * section 2) and the locked absolute recomputation.
   */
  private legBalances(
    manager: EntityManager,
    action: ActionHistory,
  ): LegBalanceWriter {
    return {
      updateBalance: (accountId, amount) =>
        manager.query(
          `UPDATE accounts
              SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4)
            WHERE id = $2 AND user_id = $3`,
          [amount, accountId, action.userId],
        ),
      recalculateCurrentBalance: (userId, accountId) =>
        this.recalculateBalance(userId, accountId, manager),
    };
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

  /**
   * Re-derive an account's holdings from its ledger after an undo or redo
   * moved an investment row, through the one fold every other ledger write
   * uses (`HoldingsService.rebuildAccountsFromTransactions`, inside this
   * transaction, under the same holdings lock).
   *
   * This used to be a second fold over every non-VOID row: a DIVIDEND entered
   * with a quantity added its total to the basis, and the average was stored at
   * 6 decimals where the canonical writers store 10, so the boot drift report
   * flagged what an undo had just written (A26-L21, INV-HOLDING-001).
   */
  private async rebuildHoldings(
    userId: string,
    accountId: string,
    manager: EntityManager,
  ): Promise<void> {
    await (
      await this.holdings()
    ).rebuildAccountsFromTransactions(userId, [accountId], manager);
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
