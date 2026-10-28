import {
  captureAccrualBulkDelete,
  clearAccrualBulkDeleteChildren,
  recordRequiredAccrualBulkDelete,
} from "../accruals/accrual-bulk-delete";
import {
  resolveBulkAccrualEdit,
  verifyBulkAccrualEdit,
  type BulkAccrualPreview,
} from "../accruals/accrual-bulk-edit";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";
import { requireAccrualOwner } from "../accruals/accrual-source";
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import {
  Brackets,
  EntityManager,
  In,
  SelectQueryBuilder,
  DataSource,
} from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { TransactionSplitService } from "./transaction-split.service";
import { Category } from "../categories/entities/category.entity";
import {
  brokerageExclusionForEntity,
  investmentLinkedTransactionExclusion,
} from "../common/investment-filter.util";
import { Payee } from "../payees/entities/payee.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TagsService } from "../tags/tags.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  BulkUpdateDto,
  BulkDeleteDto,
  BulkUpdateFilterDto,
} from "./dto/bulk-update.dto";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { formatDateYMDLocal } from "../common/date-utils";
import { applyTransactionSearch } from "./apply-transaction-search";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import {
  lockTransactionRows,
  acquireAdvisoryLock,
  LockScope,
} from "../common/db/locks";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { roundMoney } from "../common/round.util";
import {
  assertReconciledIdsMutable,
  assertReconciledRowsMutable,
} from "./reconciled-lock.util";

export interface BulkDeleteResult {
  deleted: number;
}

export interface BulkUpdateResult {
  updated: number;
  skipped: number;
  skippedReasons: string[];
  /**
   * Split lines recategorized across the batch's split parents. A sibling
   * count, never folded into `updated` (invariant I5,
   * docs/specs/split-bulk-update.md). Omitted when zero.
   */
  splitLinesUpdated?: number;
}

/** One changed split line, as returned by bulkRecategorizeCategorySplits. */
interface ChangedSplitLine {
  splitId: string;
  transactionId: string;
  previousCategoryId: string | null;
}

/** Per-transaction snapshot rows for the Action History bulk_update record. */
interface BulkUpdateSnapshot {
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

/**
 * The columns the WP1b undo snapshot can capture, keyed by the updateFields
 * property they mirror. Keys come from extractUpdateFields' whitelist; the
 * values are literal column names, never request input.
 */
const SNAPSHOT_COLUMNS: Record<string, string> = {
  payeeId: "payee_id",
  payeeName: "payee_name",
  categoryId: "category_id",
  description: "description",
  status: "status",
};

@Injectable()
export class TransactionBulkUpdateService {
  private readonly logger = new Logger(TransactionBulkUpdateService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private tagsService: TagsService,
    @Inject(forwardRef(() => TransactionSplitService))
    private splitService: TransactionSplitService,
    private actionHistoryService: ActionHistoryService,
    private dataSource: DataSource,
  ) {}

  async previewBulkUpdate(
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<BulkAccrualPreview> {
    requireAccrualOwner(userId);
    const capture: { result?: BulkAccrualPreview } = {};
    await this.bulkUpdate(userId, dto, capture);
    return (
      capture.result ?? { fingerprint: null, transactionIds: [], impacts: [] }
    );
  }

  async bulkUpdate(
    userId: string,
    dto: BulkUpdateDto,
    previewCapture?: { result?: BulkAccrualPreview },
  ): Promise<BulkUpdateResult> {
    const previewOnly = previewCapture !== undefined;
    const updateFields = this.extractUpdateFields(dto);
    const isUpdatingTags = "tagIds" in dto;
    if (Object.keys(updateFields).length === 0 && !isUpdatingTags) {
      throw new BadRequestException(
        tr(
          "errors.transactions.bulkUpdateNoFields",
          "At least one update field must be provided",
        ),
      );
    }

    // H4: Validate ownership of categoryId and payeeId before applying
    if ("categoryId" in dto && dto.categoryId) {
      const categoryId = dto.categoryId;
      const cat = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: categoryId, userId },
        }),
      );
      if (!cat) {
        throw new NotFoundException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
    }
    if ("payeeId" in dto && dto.payeeId) {
      const payeeId = dto.payeeId;
      const payee = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Payee).findOne({
          where: { id: payeeId, userId },
        }),
      );
      if (!payee) {
        throw new NotFoundException(
          tr("errors.transactions.payeeNotFound", "Payee not found"),
        );
      }
    }

    const isUpdatingCategory = "categoryId" in dto;
    const isUpdatingStatus = "status" in dto;

    // Step 1: Get eligible transaction IDs
    const allIds = await this.resolveTransactionIds(userId, dto);
    if (allIds.length === 0) {
      verifyBulkAccrualEdit(
        { fingerprint: null, transactionIds: [], impacts: [] },
        dto.accrualImpactFingerprint,
      );
      return { updated: 0, skipped: 0, skippedReasons: [] };
    }

    // Step 2: Classify targets. Split parents stay in the batch (parent-level
    // fields apply to them); when the run sets a category their lines are
    // recategorized instead of the parent (invariant I1).
    const {
      eligibleIds,
      splitParentIds,
      skipped: classifySkipped,
      skippedReasons: classifySkippedReasons,
    } = await this.classifyTargets(
      userId,
      allIds,
      isUpdatingStatus ? dto.status : undefined,
    );

    if (eligibleIds.length === 0) {
      verifyBulkAccrualEdit(
        { fingerprint: null, transactionIds: [], impacts: [] },
        dto.accrualImpactFingerprint,
      );
      return {
        updated: 0,
        skipped: classifySkipped,
        skippedReasons: classifySkippedReasons,
      };
    }

    let accrualPreview: BulkAccrualPreview | undefined;
    const splitParentIdSet = new Set(splitParentIds);
    let changedLines: ChangedSplitLine[] = [];
    let snapshot: BulkUpdateSnapshot = { before: [], after: [] };
    // Rows whose status is being changed: the selection plus any transfer
    // counterpart pulled in with it. Declared out here so the post-commit
    // net-worth recalculation covers the counterpart's account as well.
    let statusIds: string[] = eligibleIds;
    // Accounts moved by split-parent counterpart propagation, which only the
    // propagation helper can name.
    const counterpartAccountIds = new Set<string>();
    const touchedSecurityIds = new Set<string>();

    // Balance changes and the batch update commit in a single transaction.
    await withScopedDb(this.dataSource, async (m) => {
      // Lock every row this batch could write before anything reads the
      // statuses the VOID crossing is decided on.
      //
      // Whether a row crosses the VOID boundary -- and so whether its transfer
      // counterpart and its split parent's legs move with it -- is a question
      // about its status. Deciding it on a read taken before the lock let a
      // concurrent edit flip that status in between: a VOID pair, one leg
      // bulk-voided while another request un-voided the pair, expanded on "A is
      // VOID, nothing crosses", then locked A, found it CLEARED and voided A
      // alone, leaving the 100.00 in savings with no outflow (A26-M09). So the
      // superset is discovered structurally (every mirror leg and split-parent
      // leg, whatever its status), locked, and only then is the crossing read.
      const lockSet = isUpdatingStatus
        ? await this.discoverStatusLockSet(m, userId, eligibleIds)
        : { parentIds: [], rowIds: [] };
      if (isUpdatingStatus) {
        // First lock of the transaction: advisory before row locks
        // (`common/db/locks.ts`). The embedded investment rows a crossing
        // parent carries are rebuilt under the holdings advisory lock, and
        // `InvestmentTransactionsService.update()` reaches the same parent the
        // other way round -- advisory lock first, then the parent's `FOR
        // UPDATE`. Taken for every selected split parent, crossing or not,
        // because the crossing is only known under the row lock; the helper's
        // own `SELECT` is unlocked and may precede it.
        if (lockSet.parentIds.length > 0) {
          await this.splitService.lockEmbeddedInvestmentScopes(
            m,
            userId,
            lockSet.parentIds,
          );
        }
        // Split parents on their own first, then every other row ascending:
        // the by-role order of `common/db/locks.ts`.
        const lockedParents = await lockTransactionRows(
          m,
          lockSet.parentIds,
          userId,
        );
        await lockTransactionRows(
          m,
          lockSet.rowIds.filter((id) => !lockedParents.has(id)),
          userId,
        );
      }

      // A transfer's two legs are one movement of money and must share a
      // status. Selecting one leg and voiding it used to leave the counterpart
      // active: the source's balance was restored and the destination kept the
      // money, so the pair created it outright (audit P5-001, scenario B).
      //
      // The counterpart is folded into the batch BEFORE the balance pass so
      // both legs are voided and both balances adjusted in the same
      // transaction, and on the statuses read under the lock above.
      statusIds = isUpdatingStatus
        ? await this.expandTransferCounterparts(
            m,
            userId,
            eligibleIds,
            dto.status!,
          )
        : eligibleIds;

      // The rows split-parent propagation will write, discovered BEFORE any
      // write so the undo snapshot can capture their pre-values -- an undo that
      // restores only the selected leg leaves the propagated counterpart VOID,
      // recreating the divergent pair through the app's own undo.
      const { crossingParentIds, counterpartIds: propagationTargetIds } =
        isUpdatingStatus
          ? await this.findSplitParentCounterpartIds(
              m,
              userId,
              statusIds,
              dto.status!,
            )
          : { crossingParentIds: [], counterpartIds: [] };

      // Every row this batch writes must be one the lock above froze. A row the
      // locked expansion names that the structural discovery did not -- a leg
      // linked or added after the discovery read -- would be written unlocked,
      // which is the race this lock closes; refuse rather than lock it out of
      // order.
      if (isUpdatingStatus) {
        const requested = new Set([...lockSet.parentIds, ...lockSet.rowIds]);
        const unlocked = [...statusIds, ...propagationTargetIds].filter(
          (id) => !requested.has(id),
        );
        if (unlocked.length > 0) {
          throw new ConflictException(
            tr(
              "errors.transactions.bulkUpdateConcurrentChange",
              "These transactions changed while the update was running. Reload and try again.",
            ),
          );
        }
      }

      // Strict reconciled lock over every row this batch will write -- the
      // selection, the transfer counterparts folded in with it, and the split
      // parents' propagation targets. A refusal on the single-row route that
      // the bulk route walks around is not a refusal.
      await assertReconciledIdsMutable(m, userId, [
        ...eligibleIds,
        ...statusIds,
        ...propagationTargetIds,
      ]);

      const restriction = isUpdatingCategory
        ? await this.resolveCategoryRestriction(m, userId, dto)
        : undefined;
      accrualPreview = await resolveBulkAccrualEdit(
        m,
        userId,
        eligibleIds,
        splitParentIdSet,
        dto,
        restriction,
      );
      if (accrualPreview.impacts.length) requireAccrualOwner(userId);
      if (previewOnly) return;
      verifyBulkAccrualEdit(accrualPreview, dto.accrualImpactFingerprint);

      // WP1b: read the pre-write values of exactly the fields this run changes,
      // before ANY update runs -- including the counterpart and propagated rows
      // a status change writes, or undo cannot restore them. The split-line
      // half of the snapshot comes from bulkRecategorizeCategorySplits' own
      // pre-read below.
      const snapshotIds = isUpdatingStatus
        ? [...new Set([...eligibleIds, ...statusIds, ...propagationTargetIds])]
        : eligibleIds;
      const parentSnapshot = await this.readParentSnapshot(
        m,
        userId,
        snapshotIds,
        updateFields,
        isUpdatingTags,
      );

      // Step 3: Handle balance adjustments for VOID status changes
      if (isUpdatingStatus) {
        await this.handleStatusBalanceChanges(
          m,
          userId,
          statusIds,
          dto.status!,
        );

        // A selected split PARENT crossing the VOID boundary has to take the
        // counterparts its transfer children created with it.
        // `expandTransferCounterparts` cannot do this: a parent is
        // `isSplit = true, isTransfer = false`, so it finds nothing, and the
        // batch then voided the parent, restored its source balance and left
        // every child-created leg active with the money (recheck RR3-001). The
        // single-update route already goes through this helper, so both now call
        // the same one rather than growing a second copy of the rule.
        for (const affected of await this.propagateSplitParentStatus(
          m,
          userId,
          crossingParentIds,
          dto.status!,
          touchedSecurityIds,
        )) {
          counterpartAccountIds.add(affected);
        }
      }

      // Step 4: Execute batch update for column fields. When the run sets a
      // category, split parents must not receive it (their category_id stays
      // NULL -- invariant I1), so their UPDATE drops categoryId.
      if (Object.keys(updateFields).length > 0) {
        // The status column applies to the expanded set; every other field
        // stays on the explicitly selected rows (payee/description mirroring is
        // handled separately by syncLinkedTransfers, and a category or payee
        // belongs to the leg the user picked).
        const { status: statusField, ...nonStatusFields } =
          updateFields as Record<string, unknown>;

        if (Object.keys(nonStatusFields).length > 0) {
          // When the run sets a category, split parents must not receive it
          // (their category_id stays NULL -- invariant I1), so their UPDATE
          // drops categoryId below.
          const fullFieldIds = isUpdatingCategory
            ? eligibleIds.filter((id) => !splitParentIdSet.has(id))
            : eligibleIds;
          if (fullFieldIds.length > 0) {
            await m
              .createQueryBuilder()
              .update(Transaction)
              .set(nonStatusFields as Partial<Transaction>)
              .where("id IN (:...ids)", { ids: fullFieldIds })
              .andWhere("userId = :userId", { userId })
              .execute();
          }

          if (isUpdatingCategory && splitParentIds.length > 0) {
            const splitParentFields = { ...nonStatusFields };
            delete splitParentFields.categoryId;
            if (Object.keys(splitParentFields).length > 0) {
              await m
                .createQueryBuilder()
                .update(Transaction)
                .set(splitParentFields as Partial<Transaction>)
                .where("id IN (:...ids)", { ids: splitParentIds })
                .andWhere("userId = :userId", { userId })
                .execute();
            }
          }
        }

        if (statusField !== undefined) {
          await m
            .createQueryBuilder()
            .update(Transaction)
            .set({ status: statusField } as Partial<Transaction>)
            .where("id IN (:...ids)", { ids: statusIds })
            .andWhere("userId = :userId", { userId })
            .execute();
        }

        // Step 4b: Sync payee/description to linked transfer transactions
        await this.syncLinkedTransfers(m, userId, eligibleIds, updateFields);
      }

      // Step 4c: Update tags (many-to-many relation). Validates the tag set
      // once and replaces tags with a single bulk delete + insert across all
      // eligible transactions.
      if (isUpdatingTags) {
        await this.tagsService.setTransactionTagsBulk(
          eligibleIds,
          dto.tagIds ?? [],
          userId,
        );

        // Keep transfer counterparts in step, mirroring the single-edit flow
        // (updateTransfer wrapper): plain transfer legs share tags with their
        // mirror leg; split-transfer legs mirror tags onto the owning split.
        await this.syncTransferTags(m, userId, eligibleIds, dto.tagIds ?? []);
      }

      // Step 4d: Recategorize the split parents' category-kind lines, joined
      // to this transaction. The restriction set is computed with the same
      // expansion the selection uses, so update and selection cannot drift.
      if (isUpdatingCategory && splitParentIds.length > 0) {
        changedLines = await this.splitService.bulkRecategorizeCategorySplits(
          userId,
          splitParentIds,
          dto.categoryId ?? null,
          restriction,
        );
      }

      for (const impact of accrualPreview.impacts) {
        await refreshSourceAccruals(m, userId, impact.transactionId);
      }

      snapshot = this.buildSnapshots(
        parentSnapshot,
        updateFields,
        isUpdatingCategory,
        splitParentIdSet,
        isUpdatingTags,
        dto.tagIds,
        changedLines,
        dto.categoryId ?? null,
        new Set(snapshotIds.filter((id) => !eligibleIds.includes(id))),
      );
    });

    if (previewCapture) {
      previewCapture.result = accrualPreview!;
      return { updated: 0, skipped: 0, skippedReasons: [] };
    }

    // Step 5: Trigger net worth recalc for affected accounts (after commit).
    // Uses the expanded set: a counterpart in another account had its status
    // and balance changed too, so that account's snapshots are stale as well.
    if (isUpdatingStatus) {
      await this.triggerNetWorthRecalcForTransactions(
        userId,
        statusIds,
        // Accounts the split-parent propagation moved. They are not in
        // `statusIds` -- the helper discovered them -- so without this the child's
        // account kept a stale net-worth snapshot beside its corrected balance.
        counterpartAccountIds,
      );
      // Embedded investment rows of the split parents that crossed the VOID
      // boundary moved lots: reprice after the commit (INV-BOND-005).
      await this.splitService.recomputeBondPricesAfterWrite(
        userId,
        touchedSecurityIds,
      );
    }

    // Result (invariant I5): a parent counts as updated only when it received
    // at least one write. With a category-only run, a split parent none of
    // whose lines changed received nothing and is skipped with a reason.
    const parentLevelChangesApply =
      Object.keys(updateFields).some((k) => k !== "categoryId") ||
      isUpdatingTags;
    const changedParentIds = new Set(changedLines.map((l) => l.transactionId));
    const skippedSplitParents =
      isUpdatingCategory && !parentLevelChangesApply
        ? splitParentIds.filter((id) => !changedParentIds.has(id))
        : [];
    const updated = eligibleIds.length - skippedSplitParents.length;

    const skippedReasons: string[] = [...classifySkippedReasons];
    if (skippedSplitParents.length === 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkSplitNoMatchingLinesOne",
          "1 split transaction was skipped because none of its split lines matched the category update",
        ),
      );
    } else if (skippedSplitParents.length > 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkSplitNoMatchingLinesMany",
          `${skippedSplitParents.length} split transactions were skipped because none of their split lines matched the category update`,
          { count: skippedSplitParents.length },
        ),
      );
    }

    // WP1b: record the undo entry AFTER the transaction committed (record
    // swallows its own failures, which is only safe outside a transaction --
    // see derived-state-writers.guard.spec.ts). Skipped parents received no
    // write, so they are excluded from the snapshot.
    if (updated > 0) {
      const skippedSet = new Set(skippedSplitParents);
      const keep = (row: Record<string, unknown>) =>
        !skippedSet.has(row.id as string);
      void this.actionHistoryService.record(userId, {
        entityType: "bulk_transaction",
        entityId: null,
        action: "bulk_update",
        beforeData: { transactions: snapshot.before.filter(keep) },
        afterData: { transactions: snapshot.after.filter(keep) },
        description: `Bulk updated ${updated} transaction${updated === 1 ? "" : "s"}`,
        descriptionKey: "bulkUpdatedTransactions",
        descriptionParams: { count: updated },
      });
    }

    const result: BulkUpdateResult = {
      updated,
      skipped: classifySkipped + skippedSplitParents.length,
      skippedReasons,
    };
    if (changedLines.length > 0) {
      result.splitLinesUpdated = changedLines.length;
    }
    return result;
  }

  async bulkDelete(
    userId: string,
    dto: BulkDeleteDto,
  ): Promise<BulkDeleteResult> {
    const allIds = await this.resolveTransactionIds(userId, dto);
    if (allIds.length === 0) {
      return { deleted: 0 };
    }

    // Load transaction details needed for balance adjustments and linked transfers
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select([
          "transaction.id",
          "transaction.accountId",
          "transaction.amount",
          "transaction.status",
          "transaction.transactionDate",
          "transaction.isTransfer",
          "transaction.linkedTransactionId",
          "transaction.isSplit",
        ])
        .where("transaction.id IN (:...ids)", { ids: allIds })
        .andWhere("transaction.userId = :userId", { userId })
        .getMany(),
    );

    if (transactions.length === 0) {
      return { deleted: 0 };
    }

    // Every account whose balance this delete touches, including accounts
    // reached only through a linked transfer leg or a split counterpart.
    //
    // The recalculation set used to be built from `transactions` alone, after
    // the commit -- so bulk-deleting one leg of a transfer reversed both live
    // balances correctly but left the counterpart account's monthly net-worth
    // snapshot carrying the deleted amount (audit P5-012). The single-transfer
    // delete path already tracked all affected accounts, which is what showed
    // the intended coverage. Collected inside the transaction, where the linked
    // rows are loaded, and consumed after it commits.
    const affectedAccountIds = new Set<string>(
      transactions.map((t) => t.accountId),
    );

    // Balance adjustments and both delete passes commit atomically.
    let deleted = 0;
    await withScopedDb(this.dataSource, async (m) => {
      await acquireAdvisoryLock(m, LockScope.AccrualBulkHistory, userId);
      const transactionIdsSet = new Set(transactions.map((t) => t.id));

      // A split-transfer leg links to its split PARENT, not to a mirror leg.
      // Queuing that link as "the other leg" deleted the parent, cascaded its
      // split rows and left every sibling leg standing with its money: a
      // -100.00 split to B (60.00) and C (40.00), bulk-deleted from B's
      // register, left C at 40.00 with nothing on the other side (A26-H05). So
      // a selected leg brings its parent's whole set, the way the single
      // delete does (`removeTransferFromSplitInTransaction`).
      const legParents = await m.find(TransactionSplit, {
        select: { transactionId: true },
        where: { linkedTransactionId: In([...transactionIdsSet]) },
      });
      const parentIds = new Set<string>(
        legParents.map((split) => split.transactionId),
      );
      for (const tx of transactions) {
        if (tx.isSplit) parentIds.add(tx.id);
      }

      // Split parents first, on their own, then everything else ascending: the
      // by-role order of common/db/locks.ts, so this path cannot hold a leg a
      // `removeSplit` holding its parent is waiting for (RV4-005). Their split
      // rows are read under the parent lock, so the legs collected are the set
      // the deletion removes, not the set the pre-read saw.
      const lockedParents = await lockTransactionRows(
        m,
        [...parentIds],
        userId,
      );
      const parentSplits =
        lockedParents.size > 0
          ? await m.find(TransactionSplit, {
              select: { transactionId: true, linkedTransactionId: true },
              where: { transactionId: In([...lockedParents.keys()]) },
            })
          : [];

      // Every row this delete removes besides the selected ones: a plain
      // transfer's mirror, a split parent reached through its leg, and each
      // leg of every split parent in the set.
      const linkedIdsToDelete = new Set<string>();
      const queue = (id: string | null | undefined) => {
        if (id && !transactionIdsSet.has(id)) linkedIdsToDelete.add(id);
      };
      for (const tx of transactions) queue(tx.linkedTransactionId);
      for (const parentId of lockedParents.keys()) queue(parentId);
      for (const split of parentSplits) queue(split.linkedTransactionId);

      // Lock every row about to be deleted -- primary and linked alike --
      // ascending by id, and derive the reversals from the locked values.
      //
      // The `transactions` read above happened before this transaction opened,
      // so its amounts and statuses are a claim about the past. A row another
      // request deleted in the meantime is simply absent from `locked`, and gets
      // no reversal: reversing an amount whose row is already gone is how a
      // double delete leaves the balance 10.00 above the ledger (P4-003).
      const lockedRest = await lockTransactionRows(
        m,
        [...allIds, ...linkedIdsToDelete].filter(
          (id) => !lockedParents.has(id),
        ),
        userId,
      );
      const locked = new Map([...lockedParents, ...lockedRest]);

      // Every linked leg and split counterpart this delete removes was locked
      // above and lives in `locked`, so its account joins the net-worth
      // fan-out beside the primary rows. The recalculation set used to be the
      // selected rows alone, which left the counterpart account -- reached only
      // through the linked leg -- carrying the deleted amount in its monthly
      // net-worth snapshot beside a corrected live balance (audit P5-012).
      for (const tx of locked.values()) {
        affectedAccountIds.add(tx.accountId);
      }

      // Strict reconciled lock over the locked delete set, primary rows and
      // linked legs alike, before the first reversal.
      await assertReconciledRowsMutable(m, userId, [...locked.values()]);

      // What each locked row contributed, from the one deletion rule: a VOID
      // row moved nothing, a future-dated row is recomputed after it is gone.
      const accrualHistory = await captureAccrualBulkDelete(m, userId, [
        ...locked.keys(),
      ]);

      const balanceAdjustments = new Map<string, number>();
      const recalcAccountIds = new Set<string>();
      for (const tx of locked.values()) {
        const { delta, needsRecalc } = deletionBalanceEffect(tx);
        if (delta !== 0) {
          const current = balanceAdjustments.get(tx.accountId) ?? 0;
          balanceAdjustments.set(tx.accountId, roundMoney(current + delta));
        }
        if (needsRecalc) recalcAccountIds.add(tx.accountId);
      }

      for (const accountId of [...balanceAdjustments.keys()].sort()) {
        const adjustment = balanceAdjustments.get(accountId)!;
        if (adjustment !== 0) {
          await this.accountsService.updateBalance(accountId, adjustment);
        }
      }

      if (accrualHistory)
        await clearAccrualBulkDeleteChildren(m, userId, [...locked.keys()]);

      // Delete linked transactions first (foreign key order)
      if (linkedIdsToDelete.size > 0) {
        await m
          .createQueryBuilder()
          .delete()
          .from(Transaction)
          .where("id IN (:...ids)", { ids: [...linkedIdsToDelete] })
          .andWhere("userId = :userId", { userId })
          .execute();
      }

      // Delete the primary transactions
      const primaryDeleted = await m
        .createQueryBuilder()
        .delete()
        .from(Transaction)
        .where("id IN (:...ids)", { ids: allIds })
        .andWhere("userId = :userId", { userId })
        .execute();
      // What the database removed, not what the pre-read hoped to remove: a row
      // a concurrent request already deleted must not be counted twice.
      deleted = primaryDeleted.affected ?? 0;

      for (const accountId of [...recalcAccountIds].sort()) {
        await this.accountsService.recalculateCurrentBalance(userId, accountId);
      }
      if (accrualHistory)
        await recordRequiredAccrualBulkDelete(m, userId, accrualHistory);
    });

    // Trigger net worth recalc for every affected account, deduplicated.
    for (const accountId of affectedAccountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }

    return { deleted };
  }

  private extractUpdateFields(dto: BulkUpdateDto): Partial<Transaction> {
    const fields: Record<string, unknown> = {};

    if ("payeeId" in dto) {
      fields.payeeId = dto.payeeId ?? null;
    }
    if ("payeeName" in dto) {
      fields.payeeName = dto.payeeName ?? null;
    }
    if ("categoryId" in dto) {
      fields.categoryId = dto.categoryId ?? null;
    }
    if ("description" in dto) {
      fields.description = dto.description ?? null;
    }
    if ("status" in dto) {
      fields.status = dto.status;
    }

    return fields as Partial<Transaction>;
  }

  private async resolveTransactionIds(
    userId: string,
    dto: BulkUpdateDto | BulkDeleteDto,
  ): Promise<string[]> {
    if (dto.mode === "ids") {
      if (!dto.transactionIds || dto.transactionIds.length === 0) {
        return [];
      }

      const transactions = await withScopedDb(this.dataSource, (m) =>
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .select("transaction.id")
          .where("transaction.id IN (:...ids)", { ids: dto.transactionIds })
          .andWhere("transaction.userId = :userId", { userId })
          .getMany(),
      );

      return transactions.map((t) => t.id);
    }

    // Filter mode
    const transactions = await withScopedDb(this.dataSource, async (m) => {
      const queryBuilder = m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select("transaction.id")
        .where("transaction.userId = :userId", { userId });

      await this.applyFilters(m, queryBuilder, userId, dto.filters || {});

      if (dto.excludedIds && dto.excludedIds.length > 0) {
        queryBuilder.andWhere("transaction.id NOT IN (:...excludedIds)", {
          excludedIds: dto.excludedIds,
        });
      }

      return queryBuilder.getMany();
    });
    return transactions.map((t) => t.id);
  }

  /**
   * Classify the batch: every owned row is eligible (split parents included),
   * and the split parents are named so a category update can route their
   * change to the split lines instead of the parent row.
   */
  private async classifyTargets(
    userId: string,
    allIds: string[],
    /**
     * The status being applied, when this is a status update.
     *
     * Needed because a split-transfer leg cannot cross the VOID boundary on its
     * own: `expandTransferCounterparts` deliberately refuses to drag the split
     * PARENT along (that would void unrelated category children), so voiding the
     * leg alone left the parent's split row and total still recording money that
     * left the source and never arrived -- the same inconsistency the single-edit
     * path refuses in `updateSplitTransferLeg`, reached through the bulk path
     * instead. Skipped and reported.
     */
    newStatus?: TransactionStatus,
  ): Promise<{
    eligibleIds: string[];
    splitParentIds: string[];
    skipped: number;
    skippedReasons: string[];
  }> {
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select([
          "transaction.id",
          "transaction.isTransfer",
          "transaction.isSplit",
          "transaction.status",
        ])
        .where("transaction.id IN (:...ids)", { ids: allIds })
        .andWhere("transaction.userId = :userId", { userId })
        .getMany(),
    );

    // Which of the selected rows are a split's transfer counterpart. Only asked
    // when a status change could cross the VOID boundary.
    const transferLegIds = transactions
      .filter((t) => t.isTransfer)
      .map((t) => t.id);
    const splitLegIds = new Set<string>();
    if (newStatus !== undefined && transferLegIds.length > 0) {
      const owningSplits = await withScopedDb(this.dataSource, (m) =>
        m.find(TransactionSplit, {
          where: { linkedTransactionId: In(transferLegIds) },
          select: ["id", "linkedTransactionId"],
        }),
      );
      for (const split of owningSplits) {
        if (split.linkedTransactionId) {
          splitLegIds.add(split.linkedTransactionId);
        }
      }
    }

    // Which of the selected rows are the cash leg of an investment
    // transaction. Same shape as the split-leg rule: the investment row owns
    // the pair's VOID boundary, so a cash leg cannot cross it alone -- its
    // trade's shares would stay counted while its cash claims not to have
    // moved. Only asked when a status change could cross the boundary.
    const investmentLegIds = new Set<string>();
    if (newStatus !== undefined && transactions.length > 0) {
      const owningRows: { transaction_id: string }[] = await withScopedDb(
        this.dataSource,
        (m) =>
          m.query(
            // includes VOID rows: records read -- ownership, not effect.
            `SELECT transaction_id FROM investment_transactions
              WHERE transaction_id = ANY($1)`,
            [transactions.map((t) => t.id)],
          ),
      );
      for (const row of owningRows) {
        investmentLegIds.add(row.transaction_id);
      }
    }

    const skippedReasons: string[] = [];
    let splitLegVoidCount = 0;
    let investmentLegVoidCount = 0;

    const eligible = transactions.filter((t) => {
      const crossesVoid =
        newStatus !== undefined &&
        (t.status === TransactionStatus.VOID) !==
          (newStatus === TransactionStatus.VOID);
      if (crossesVoid && splitLegIds.has(t.id)) {
        splitLegVoidCount++;
        return false;
      }
      if (crossesVoid && investmentLegIds.has(t.id)) {
        investmentLegVoidCount++;
        return false;
      }
      return true;
    });

    if (splitLegVoidCount === 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkSplitTransferLegSkippedOne",
          "1 split transfer was skipped (void or restore it from the split transaction it belongs to, so both sides change together)",
        ),
      );
    } else if (splitLegVoidCount > 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkSplitTransferLegSkippedMany",
          `${splitLegVoidCount} split transfers were skipped (void or restore them from the split transaction they belong to, so both sides change together)`,
          { count: splitLegVoidCount },
        ),
      );
    }

    if (investmentLegVoidCount === 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkInvestmentCashLegSkippedOne",
          "1 investment cash transaction was skipped (void or restore it by changing the investment transaction's status, so both sides change together)",
        ),
      );
    } else if (investmentLegVoidCount > 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkInvestmentCashLegSkippedMany",
          `${investmentLegVoidCount} investment cash transactions were skipped (void or restore them by changing the investment transactions' status, so both sides change together)`,
          { count: investmentLegVoidCount },
        ),
      );
    }

    return {
      eligibleIds: eligible.map((t) => t.id),
      splitParentIds: eligible.filter((t) => t.isSplit).map((t) => t.id),
      skipped: splitLegVoidCount + investmentLegVoidCount,
      skippedReasons,
    };
  }

  /**
   * The restriction set for split-line recategorization: filter mode with real
   * category UUIDs in the filter yields the descendant-expanded set (matching
   * the selection's own expansion); everything else -- ids mode, no category
   * filter, pseudo-ids only -- is unrestricted (`undefined` = all category
   * lines), per Truth table A in docs/specs/split-bulk-update.md.
   */
  private async resolveCategoryRestriction(
    m: EntityManager,
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<string[] | undefined> {
    // The restriction keys off the category filter that was ACTIVE in the UI,
    // not off the selection mode: hand-picked rows arrive as mode "ids" and
    // must still honor the filter the user was looking through, so the client
    // sends it explicitly as categoryFilterIds in both modes. Filter-mode
    // filters.categoryIds remains a fallback for payloads without the field.
    const categoryIds =
      dto.categoryFilterIds ??
      (dto.mode === "filter" ? dto.filters?.categoryIds : undefined);
    if (!categoryIds || categoryIds.length === 0) return undefined;
    const expanded = await this.expandRealCategoryIds(m, userId, categoryIds);
    return expanded.length > 0 ? expanded : undefined;
  }

  /**
   * Pre-write values of exactly the fields this run changes, camel-cased to the
   * shape ActionHistoryService.undoBulkUpdate restores. Raw SQL on purpose: no
   * DATE/decimal columns are captured, and the column list comes from the
   * SNAPSHOT_COLUMNS whitelist, never from request input.
   */
  private async readParentSnapshot(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    updateFields: Partial<Transaction>,
    isUpdatingTags: boolean,
  ): Promise<{
    rows: Record<string, unknown>[];
    tagsByTransaction: Map<string, string[]>;
  }> {
    const fieldKeys = Object.keys(updateFields).filter(
      (k) => k in SNAPSHOT_COLUMNS,
    );
    const columns = [
      "id",
      "account_id",
      ...fieldKeys.map((k) => SNAPSHOT_COLUMNS[k]),
    ];
    const rawRows: Record<string, unknown>[] =
      (await m.query(
        `SELECT ${columns.join(", ")} FROM transactions WHERE user_id = $1 AND id = ANY($2)`,
        [userId, eligibleIds],
      )) ?? [];

    const rows = rawRows.map((raw) => {
      const row: Record<string, unknown> = {
        id: raw.id,
        accountId: raw.account_id,
      };
      for (const key of fieldKeys) {
        row[key] = raw[SNAPSHOT_COLUMNS[key]] ?? null;
      }
      return row;
    });

    const tagsByTransaction = new Map<string, string[]>();
    if (isUpdatingTags) {
      const tagRows: { transaction_id: string; tag_id: string }[] =
        (await m.query(
          `SELECT tt.transaction_id, tt.tag_id
             FROM transaction_tags tt
             JOIN transactions t ON t.id = tt.transaction_id
            WHERE t.user_id = $1 AND tt.transaction_id = ANY($2)`,
          [userId, eligibleIds],
        )) ?? [];
      for (const tagRow of tagRows) {
        const list = tagsByTransaction.get(tagRow.transaction_id) ?? [];
        tagsByTransaction.set(tagRow.transaction_id, [...list, tagRow.tag_id]);
      }
    }

    return { rows, tagsByTransaction };
  }

  /**
   * Assemble the before/after snapshots for the Action History record. Split
   * parents never carry `categoryId` in either side (undo/redo must not write a
   * parent category onto a split -- invariant I1); their changed lines ride
   * along as `splits: [{ id, categoryId }]`.
   */
  private buildSnapshots(
    parentSnapshot: {
      rows: Record<string, unknown>[];
      tagsByTransaction: Map<string, string[]>;
    },
    updateFields: Partial<Transaction>,
    isUpdatingCategory: boolean,
    splitParentIdSet: Set<string>,
    isUpdatingTags: boolean,
    newTagIds: string[] | undefined,
    changedLines: ChangedSplitLine[],
    newCategoryId: string | null,
    /**
     * Rows the batch wrote only a status to -- transfer counterparts and
     * propagated split-child legs. Their after-state must not claim the other
     * updateFields or the tag set, which apply only to the selected rows.
     */
    statusOnlyIdSet: Set<string> = new Set(),
  ): BulkUpdateSnapshot {
    const linesByParent = new Map<string, ChangedSplitLine[]>();
    for (const line of changedLines) {
      const list = linesByParent.get(line.transactionId) ?? [];
      linesByParent.set(line.transactionId, [...list, line]);
    }

    const before: Record<string, unknown>[] = [];
    const after: Record<string, unknown>[] = [];

    for (const row of parentSnapshot.rows) {
      const id = row.id as string;
      const isSplitParent = splitParentIdSet.has(id);
      const statusOnly = statusOnlyIdSet.has(id);

      const beforeRow: Record<string, unknown> = { ...row };
      const afterRow: Record<string, unknown> = statusOnly
        ? { id, accountId: row.accountId, status: updateFields.status }
        : {
            id,
            accountId: row.accountId,
            ...updateFields,
          };
      if (isUpdatingCategory && isSplitParent) {
        delete beforeRow.categoryId;
        delete afterRow.categoryId;
      }

      if (isUpdatingTags && !statusOnly) {
        beforeRow.tagIds = parentSnapshot.tagsByTransaction.get(id) ?? [];
        afterRow.tagIds = newTagIds ?? [];
      }

      const lines = linesByParent.get(id);
      if (lines && lines.length > 0) {
        beforeRow.splits = lines.map((l) => ({
          id: l.splitId,
          categoryId: l.previousCategoryId,
        }));
        afterRow.splits = lines.map((l) => ({
          id: l.splitId,
          categoryId: newCategoryId,
        }));
      }

      before.push(beforeRow);
      after.push(afterRow);
    }

    return { before, after };
  }

  /**
   * For transfer transactions in the batch, apply payee and description
   * updates to their linked counterparts so both sides stay in sync.
   * Category is NOT synced because each side of a transfer may use
   * different categories (e.g. "Transfer In" vs "Transfer Out").
   */
  private async syncLinkedTransfers(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    updateFields: Partial<Transaction>,
  ): Promise<void> {
    // Build the subset of fields that should sync to the linked side
    const syncFields: Record<string, unknown> = {};
    if ("payeeId" in updateFields) syncFields.payeeId = updateFields.payeeId;
    if ("payeeName" in updateFields)
      syncFields.payeeName = updateFields.payeeName;
    if ("description" in updateFields)
      syncFields.description = updateFields.description;

    if (Object.keys(syncFields).length === 0) return;

    const { plainLinkedIds, owningSplitIds } = await this.classifyTransferLegs(
      m,
      userId,
      eligibleIds,
    );

    if (plainLinkedIds.length > 0) {
      await m
        .createQueryBuilder()
        .update(Transaction)
        .set(syncFields as Partial<Transaction>)
        .where("id IN (:...ids)", { ids: plainLinkedIds })
        .andWhere("userId = :userId", { userId })
        .execute();
    }

    // Split-transfer legs mirror the description onto the owning split's memo
    // instead (matching updateSplitTransferLeg); payee changes stay on the leg.
    if ("description" in syncFields && owningSplitIds.length > 0) {
      await m
        .createQueryBuilder()
        .update(TransactionSplit)
        .set({ memo: (syncFields.description as string | null) ?? null })
        .where("id IN (:...ids)", { ids: owningSplitIds })
        .execute();
    }
  }

  /**
   * Mirror a bulk tag change onto transfer counterparts, matching the
   * single-edit flow (the updateTransfer wrapper): plain transfer legs share
   * one tag set with their mirror leg; split-transfer legs mirror the tags
   * onto the owning split's split-level tags (never the split parent).
   */
  private async syncTransferTags(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    tagIds: string[],
  ): Promise<void> {
    const { plainLinkedIds, owningSplitIds } = await this.classifyTransferLegs(
      m,
      userId,
      eligibleIds,
    );

    // Mirror legs not already covered by the batch itself.
    const eligibleSet = new Set(eligibleIds);
    const linkedToUpdate = plainLinkedIds.filter((id) => !eligibleSet.has(id));
    if (linkedToUpdate.length > 0) {
      await this.tagsService.setTransactionTagsBulk(
        linkedToUpdate,
        tagIds,
        userId,
      );
    }

    if (owningSplitIds.length > 0) {
      await this.tagsService.setSplitTagsBulk(owningSplitIds, tagIds, userId);
    }
  }

  /**
   * Classify the transfer legs among a batch. A split-transfer leg is owned by
   * a transaction_splits row and its linkedTransactionId points at the split
   * PARENT (whose fields aggregate the whole split) -- syncing there would
   * clobber the parent. A plain transfer leg's linkedTransactionId is its
   * mirror leg, which is safe to sync.
   */
  private async classifyTransferLegs(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
  ): Promise<{ plainLinkedIds: string[]; owningSplitIds: string[] }> {
    const repo = m.getRepository(Transaction);
    const transfers = await repo
      .createQueryBuilder("t")
      .select(["t.id", "t.linkedTransactionId"])
      .where("t.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("t.userId = :userId", { userId })
      .andWhere("t.isTransfer = true")
      .andWhere("t.linkedTransactionId IS NOT NULL")
      .getMany();

    if (transfers.length === 0) {
      return { plainLinkedIds: [], owningSplitIds: [] };
    }

    const owningSplits = await m.find(TransactionSplit, {
      where: { linkedTransactionId: In(transfers.map((t) => t.id)) },
      select: ["id", "linkedTransactionId"],
    });
    const splitLegIds = new Set(owningSplits.map((s) => s.linkedTransactionId));

    const candidateLinkedIds = transfers
      .filter((t) => !splitLegIds.has(t.id))
      .map((t) => t.linkedTransactionId)
      .filter((id): id is string => id !== null);

    // A cross-owner counterpart belongs to another user; tag ids are per-user
    // reference data, so only same-user linked legs may be synced. (The
    // field sync in syncLinkedTransfers is additionally user-filtered in its
    // UPDATE, but the tag path hands these ids straight to the bulk tag
    // writer.)
    const plainLinkedIds =
      candidateLinkedIds.length === 0
        ? candidateLinkedIds
        : (
            await repo
              .createQueryBuilder("t")
              .select(["t.id"])
              .where("t.id IN (:...ids)", { ids: candidateLinkedIds })
              .andWhere("t.userId = :userId", { userId })
              .getMany()
          ).map((t) => t.id);

    return {
      plainLinkedIds,
      owningSplitIds: owningSplits.map((s) => s.id),
    };
  }

  /**
   * The selected ids plus the transfer counterpart of every transfer leg among
   * them, so a status change applies to both halves of one movement of money.
   *
   * A transfer is two rows that must agree: `recalculateCurrentBalance` and
   * every report exclude a VOID row, so a void source with an active
   * destination is money in one account that came from nowhere. Selecting only
   * one leg is the normal case (a filter or a single click in the list), which
   * is why the expansion belongs here rather than in the caller.
   *
   * Split-transfer legs are included too: the leg is a real transaction row in
   * the target account whose balance contribution has to stop with its
   * counterpart's. Only same-user rows are returned -- a cross-owner
   * counterpart is another user's ledger and is not ours to void, and the
   * UPDATE is user-filtered besides.
   */
  private async expandTransferCounterparts(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    newStatus: TransactionStatus,
  ): Promise<string[]> {
    const repo = m.getRepository(Transaction);
    const allLegs = await repo
      .createQueryBuilder("t")
      .select(["t.id", "t.linkedTransactionId", "t.status"])
      .where("t.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("t.userId = :userId", { userId })
      .andWhere("t.isTransfer = true")
      .andWhere("t.linkedTransactionId IS NOT NULL")
      .getMany();

    // Only a leg CROSSING the VOID boundary takes its counterpart with it: the
    // two rows are one movement of money, so VOID-membership is shared. The
    // reconciliation states are genuinely per-ledger (the PR's own spec), so a
    // bulk CLEARED/RECONCILED/UNRECONCILED must not stamp the counterpart in
    // an account whose statement was never touched -- ungated, working a
    // checking statement re-wrote the savings ledger's reconciliation state.
    const isNewVoid = newStatus === TransactionStatus.VOID;
    const legs = allLegs.filter(
      (t) => (t.status === TransactionStatus.VOID) !== isNewVoid,
    );

    if (legs.length === 0) return eligibleIds;

    const selected = new Set(eligibleIds);
    const candidates = legs
      .map((t) => t.linkedTransactionId)
      .filter((id): id is string => id !== null && !selected.has(id));

    if (candidates.length === 0) return eligibleIds;

    // A split-transfer leg's linkedTransactionId points at the split PARENT,
    // whose fields aggregate the whole split -- voiding that would void
    // unrelated category children. Keep the counterpart only when it is a
    // mirror leg, matching how classifyTransferLegs draws the same distinction
    // for field and tag syncing.
    const owningSplits = await m.find(TransactionSplit, {
      where: { linkedTransactionId: In(legs.map((t) => t.id)) },
      select: ["id", "linkedTransactionId"],
    });
    const splitLegIds = new Set(owningSplits.map((s) => s.linkedTransactionId));
    const mirrorIds = legs
      .filter((t) => !splitLegIds.has(t.id))
      .map((t) => t.linkedTransactionId)
      .filter((id): id is string => id !== null && !selected.has(id));

    if (mirrorIds.length === 0) return eligibleIds;

    const sameUser = await repo
      .createQueryBuilder("t")
      .select(["t.id"])
      .where("t.id IN (:...ids)", { ids: mirrorIds })
      .andWhere("t.userId = :userId", { userId })
      .getMany();

    return [...eligibleIds, ...sameUser.map((t) => t.id)];
  }

  /**
   * Every row a status change of `eligibleIds` could write, found without
   * reading a status: the selection, each plain transfer leg's mirror, and every
   * leg of each selected split parent. The crossing is decided later, on the
   * locked rows; this set only has to contain whatever that decision can pick.
   * Split parents come back apart from the rest so they can be locked first.
   */
  private async discoverStatusLockSet(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
  ): Promise<{ parentIds: string[]; rowIds: string[] }> {
    const rows = await m
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select(["t.id", "t.isSplit", "t.isTransfer", "t.linkedTransactionId"])
      .where("t.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("t.userId = :userId", { userId })
      .getMany();
    const parentIds = rows.filter((t) => t.isSplit).map((t) => t.id);

    // A split-transfer leg's link names its split PARENT, which the expansion
    // never writes (see expandTransferCounterparts), so only a plain leg's
    // link is a mirror to lock.
    const transferLegIds = rows
      .filter((t) => t.isTransfer && t.linkedTransactionId)
      .map((t) => t.id);
    const owningSplits =
      transferLegIds.length > 0
        ? await m.find(TransactionSplit, {
            where: { linkedTransactionId: In(transferLegIds) },
            select: ["id", "linkedTransactionId"],
          })
        : [];
    const splitLegIds = new Set(owningSplits.map((s) => s.linkedTransactionId));
    const mirrorIds = rows
      .filter(
        (t) => t.isTransfer && t.linkedTransactionId && !splitLegIds.has(t.id),
      )
      .map((t) => t.linkedTransactionId as string);

    const parentLegIds =
      parentIds.length > 0
        ? (
            await m.find(TransactionSplit, {
              where: { transactionId: In(parentIds) },
              select: ["id", "linkedTransactionId"],
            })
          )
            .map((split) => split.linkedTransactionId)
            .filter((id): id is string => id !== null)
        : [];

    const parentIdSet = new Set(parentIds);
    const rowIds = [
      ...new Set([...eligibleIds, ...mirrorIds, ...parentLegIds]),
    ].filter((id) => !parentIdSet.has(id));
    return { parentIds, rowIds };
  }

  /**
   * The counterpart rows split-parent propagation WILL write for this batch,
   * discovered without writing anything: the ids feed the pre-write undo
   * snapshot and the row locks, so an undo can restore them and no delta is
   * derived from an unlocked row.
   */
  private async findSplitParentCounterpartIds(
    m: EntityManager,
    userId: string,
    statusIds: string[],
    newStatus: TransactionStatus,
  ): Promise<{ crossingParentIds: string[]; counterpartIds: string[] }> {
    if (statusIds.length === 0) {
      return { crossingParentIds: [], counterpartIds: [] };
    }
    const isNewVoid = newStatus === TransactionStatus.VOID;
    const parents = await m
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select(["t.id", "t.status"])
      .where("t.id IN (:...ids)", { ids: statusIds })
      .andWhere("t.userId = :userId", { userId })
      .andWhere("t.isSplit = true")
      .getMany();
    const crossingParentIds = parents
      .filter((t) => (t.status === TransactionStatus.VOID) !== isNewVoid)
      .map((t) => t.id);
    if (crossingParentIds.length === 0) {
      return { crossingParentIds, counterpartIds: [] };
    }
    const splits = await m.find(TransactionSplit, {
      where: { transactionId: In(crossingParentIds) },
      select: ["id", "linkedTransactionId"],
    });
    return {
      crossingParentIds,
      counterpartIds: splits
        .map((split) => split.linkedTransactionId)
        .filter((id): id is string => id !== null),
    };
  }

  /**
   * For every selected split parent whose status crosses the VOID boundary, apply
   * that status to the transfer counterparts its children created, moving each
   * counterpart's balance exactly once.
   *
   * Delegates to `TransactionSplitService.applyParentStatusToTransferCounterparts`
   * -- the same helper the single-transaction update path uses -- inside this
   * batch's transaction, so a bulk void and a single void cannot diverge.
   */
  private async propagateSplitParentStatus(
    m: EntityManager,
    userId: string,
    /** The crossing parents `findSplitParentCounterpartIds` discovered. */
    crossingParentIds: string[],
    newStatus: TransactionStatus,
    touchedSecurityIds?: Set<string>,
  ): Promise<Set<string>> {
    const affectedAccountIds = new Set<string>();

    for (const parentId of crossingParentIds) {
      // The counterpart accounts are not in `statusIds` -- they are discovered in
      // here -- so they have to be reported back or the batch's net-worth
      // invalidation misses them entirely (recheck RR4-003).
      for (const affected of await this.splitService.applyParentStatusToTransferCounterparts(
        m,
        parentId,
        userId,
        newStatus,
        touchedSecurityIds,
      )) {
        affectedAccountIds.add(affected);
      }
    }

    return affectedAccountIds;
  }

  private async handleStatusBalanceChanges(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    newStatus: TransactionStatus,
  ): Promise<void> {
    const isNewVoid = newStatus === TransactionStatus.VOID;

    // Query transactions that will actually change to/from VOID
    const statusCondition = isNewVoid
      ? "transaction.status != :voidStatus"
      : "transaction.status = :voidStatus";

    // Only include non-future transactions in balance changes
    const today = formatDateYMDLocal(new Date());

    const balanceDeltas = await m
      .getRepository(Transaction)
      .createQueryBuilder("transaction")
      .select("transaction.accountId", "accountId")
      .addSelect("SUM(transaction.amount)", "totalAmount")
      .where("transaction.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("transaction.userId = :userId", { userId })
      .andWhere(statusCondition, { voidStatus: TransactionStatus.VOID })
      .andWhere("transaction.transactionDate <= :today", { today })
      .groupBy("transaction.accountId")
      .getRawMany();

    for (const row of balanceDeltas) {
      const amount = Number(row.totalAmount) || 0;
      if (amount === 0) continue;

      if (isNewVoid) {
        // Becoming VOID: subtract amounts from balances
        await this.accountsService.updateBalance(row.accountId, -amount);
      } else {
        // Leaving VOID: add amounts to balances
        await this.accountsService.updateBalance(row.accountId, amount);
      }
    }
  }

  private async triggerNetWorthRecalcForTransactions(
    userId: string,
    transactionIds: string[],
    extraAccountIds: Set<string> = new Set(),
  ): Promise<void> {
    const accountIds = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select("DISTINCT transaction.accountId", "accountId")
        .where("transaction.id IN (:...ids)", { ids: transactionIds })
        .getRawMany(),
    );

    const targets = new Set<string>(extraAccountIds);
    for (const row of accountIds) targets.add(row.accountId);

    for (const accountId of targets) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
  }

  private async applyFilters(
    m: EntityManager,
    queryBuilder: SelectQueryBuilder<Transaction>,
    userId: string,
    filters: BulkUpdateFilterDto,
  ): Promise<void> {
    if (filters.accountIds && filters.accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds: filters.accountIds,
      });
    }

    if (filters.startDate) {
      queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
        startDate: filters.startDate,
      });
    }

    if (filters.endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate: filters.endDate,
      });
    }

    let categorySplitsJoined = false;
    if (filters.categoryIds && filters.categoryIds.length > 0) {
      categorySplitsJoined = await this.applyCategoryFilters(
        m,
        queryBuilder,
        userId,
        filters.categoryIds,
      );
    }

    if (filters.payeeIds && filters.payeeIds.length > 0) {
      queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
        payeeIds: filters.payeeIds,
      });
    }

    if (filters.search && filters.search.trim()) {
      // Split grain, so the selection is the transactions the register lists.
      // Which lines of a selected split a category change rewrites is still
      // `resolveCategoryRestriction`'s decision, read from the category filter
      // alone. The category filter joins `filterSplits` only for real
      // category ids; with none (no filter, or only the uncategorized and
      // transfer pseudo-ids) the search joins its own alias.
      if (!categorySplitsJoined) {
        queryBuilder.leftJoin("transaction.splits", "searchSplits");
      }
      await applyTransactionSearch(m, queryBuilder, filters.search, {
        userId,
        transaction: "transaction",
        splits: categorySplitsJoined ? "filterSplits" : "searchSplits",
        grain: "split",
        paramPrefix: "srch",
      });
    }

    if (filters.amountFrom !== undefined) {
      queryBuilder.andWhere("transaction.amount >= :amountFrom", {
        amountFrom: filters.amountFrom,
      });
    }

    if (filters.amountTo !== undefined) {
      queryBuilder.andWhere("transaction.amount <= :amountTo", {
        amountTo: filters.amountTo,
      });
    }

    if (filters.tagIds && filters.tagIds.length > 0) {
      // Split-aware, mirroring findAll: a tag on the parent or on any split
      // line matches. A dedicated splits alias avoids depending on the joins
      // the category/search branches may or may not have added.
      queryBuilder.leftJoin("transaction.tags", "filterTags");
      queryBuilder.leftJoin("transaction.splits", "tagSplits");
      queryBuilder.leftJoin("tagSplits.tags", "filterSplitTags");
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where("filterTags.id IN (:...filterTagIds)", {
            filterTagIds: filters.tagIds,
          }).orWhere("filterSplitTags.id IN (:...filterTagIds)", {
            filterTagIds: filters.tagIds,
          });
        }),
      );
    }
  }

  /**
   * The real (non-pseudo) category ids of a filter, descendant-expanded.
   * Written once so the selection predicate (applyCategoryFilters) and the
   * split-line recategorization restriction (resolveCategoryRestriction)
   * cannot drift apart. Returns [] when the filter holds only pseudo-ids.
   */
  private async expandRealCategoryIds(
    m: EntityManager,
    userId: string,
    categoryIds: string[],
  ): Promise<string[]> {
    const regularCategoryIds = categoryIds.filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );
    if (regularCategoryIds.length === 0) return [];
    return getAllCategoryIdsWithChildren(
      m.getRepository(Category),
      userId,
      regularCategoryIds,
    );
  }

  /**
   * Applies the category filter. Returns whether it joined `filterSplits`,
   * which it does only for real category ids; the search reuses that alias
   * so both filters read the same split line.
   */
  private async applyCategoryFilters(
    m: EntityManager,
    queryBuilder: SelectQueryBuilder<Transaction>,
    userId: string,
    categoryIds: string[],
  ): Promise<boolean> {
    const hasUncategorized = categoryIds.includes("uncategorized");
    const hasTransfer = categoryIds.includes("transfer");

    let hasCondition = false;

    // Expansion always contains its seed ids, so a non-empty real-id filter
    // yields a non-empty expansion and the outer condition is unchanged.
    const uniqueCategoryIds = await this.expandRealCategoryIds(
      m,
      userId,
      categoryIds,
    );

    if (hasUncategorized || hasTransfer || uniqueCategoryIds.length > 0) {
      if (hasUncategorized) {
        queryBuilder.leftJoin("transaction.account", "filterAccount");
      }

      if (uniqueCategoryIds.length > 0) {
        queryBuilder.leftJoin("transaction.splits", "filterSplits");
      }

      queryBuilder.andWhere(
        new Brackets((qb) => {
          if (hasUncategorized) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              `transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND ${brokerageExclusionForEntity(
                "filterAccount",
              )} AND ${investmentLinkedTransactionExclusion("transaction")}`,
            );
          }
          if (hasTransfer) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method]("transaction.isTransfer = true");
          }
          if (uniqueCategoryIds.length > 0) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              new Brackets((inner) => {
                inner
                  .where("transaction.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  })
                  .orWhere(
                    "filterSplits.categoryId IN (:...filterCategoryIds)",
                    { filterCategoryIds: uniqueCategoryIds },
                  );
              }),
            );
          }
        }),
      );
    }
    return uniqueCategoryIds.length > 0;
  }
}
