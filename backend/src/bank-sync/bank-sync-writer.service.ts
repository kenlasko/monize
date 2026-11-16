import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { DataSource, EntityManager } from "typeorm";
import {
  Account,
  AccountSubType,
  AccountType,
} from "../accounts/entities/account.entity";
import { AccountsService } from "../accounts/accounts.service";
import {
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import { returnedRows } from "../common/db/query-result";
import { orderByDateStable } from "../common/date-order.util";
import { withScopedDb } from "../common/db/scoped-db";
import { assertTransactionCurrencyMatchesAccount } from "../common/fx-entry.util";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { tr } from "../i18n/translate";
import { PayeesService } from "../payees/payees.service";
import { TagsService } from "../tags/tags.service";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
import {
  allowedDuplicateActions,
  mergeIntoExisting,
  type DuplicateAction,
  type DuplicateCandidate,
} from "../import-preview/possible-duplicates";
import { TransactionsService } from "../transactions/transactions.service";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  operationTagLabel,
  type BankOperation,
  type OperationDirection,
} from "./bank-operation";
import { RULES_BATCH_SIZE } from "./bank-sync.constants";
import { findOrCreateTagId } from "./bank-sync-operation-tags";
import type { BankSyncProfile } from "./bank-sync-profiles";
import {
  loadPayeeDefaultCategories,
  payeeGivingDefaultCategory,
} from "./bank-sync-rule-payee-category";
import {
  findExistingPayee,
  NO_PAYEE,
  type ResolvedPayee,
} from "./bank-sync-payee-lookup";
import {
  findHeldRows,
  newPlannedRows,
  planFingerprint,
} from "./bank-sync-plan-fingerprint";
import {
  assertDisjointSelection,
  namesExistingTransactions,
  type BankSyncSelection,
} from "./bank-sync-selection";
import { findBankRowDuplicates } from "./bank-sync-duplicates";
import type {
  BankImportPlan,
  PlannedBankRow,
} from "./bank-transaction-planner";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";

/** A bank balance that passed validation, at the column's money precision. */
export interface NormalizedBankBalance {
  reportedAt?: string | null;
  amount: number;
  currencyCode: string;
  referenceDate: string | null;
}

/**
 * The preview the user confirmed no longer describes what the bank says (spec
 * section 7a). A 409 raised before the first write; its own class so the sync
 * that raised it does not record itself as failed: nothing was attempted.
 */
export class BankSyncPlanChangedException extends ConflictException {}

/**
 * The selection names a row that is not a new row of the plan (spec section 7b).
 * A 400 raised before the first write; its own class for the same reason: the
 * sync that raised it attempted nothing, so it does not record itself as failed.
 */
export class BankSyncSelectionRefusedException extends BadRequestException {}

export interface BankSyncWriteInput {
  userId: string;
  bankAccountId: string;
  /** The Monize account the sync read for; the write refuses when the link moved. */
  accountId: string;
  /**
   * The cut-off date (`sync_from_date`) the plan was made against, as read at
   * step 1 of the sync; null when the link had none. The write refuses when the
   * locked row holds another one: rows dated between the two would be planned
   * or dropped by a cut-off the user has since replaced.
   */
  plannedSyncFromDate: string | null;
  /** The account currency the plan was made against; the write refuses when it moved. */
  plannedCurrencyCode: string;
  plan: BankImportPlan;
  /** Null when the bank reported none: the stored balance is left alone. */
  balance: NormalizedBankBalance | null;
  /**
   * The fingerprint of the preview the user confirmed (`planFingerprint`). When
   * set, the write recomputes it from the rows it is about to write, under the
   * row lock, and refuses with `BankSyncPlanChangedException` when it differs.
   */
  expectedFingerprint?: string;
  /**
   * Whether a created transaction is tagged with the bank's operation type: the
   * connection's `tag_operation_type` as read at step 1 of the sync.
   */
  tagOperationType: boolean;
  /**
   * The profile of the connection's institution, resolved once for the sync
   * (`resolveProfile`); it names the operation-type tag and nothing else, so it
   * cannot change which rows are duplicates.
   */
  profile: BankSyncProfile;
  /**
   * The rows the person chose in the preview (spec section 7b). Absent: every
   * new row is imported, as a sync always did. Given: exactly `importKeys` are
   * imported, `excludeKeys` are written to the ledger as exceptions, and every
   * other new row is left for the next sync. The write refuses a key that is not
   * a new row of the plan it re-makes under the lock.
   */
  selection?: BankSyncSelection;
}

export interface BankSyncWriteOutcome {
  imported: number;
  skipped: number;
  /** Rows added to the exceptions by this write. */
  excluded: number;
  /**
   * Possible duplicates (docs/specs/import-duplicate-review.md section 4):
   * merged into the existing transaction, linked to it as it was, or imported
   * after it was deleted (`replaced` rows are also in `imported`).
   */
  merged: number;
  kept: number;
  replaced: number;
  /** Possible duplicates nobody decided about: not written, and recorded on the link. */
  heldDuplicates: number;
  /**
   * Securities a replaced transaction's deletion touched (an embedded
   * investment row of a split); their bond prices are recomputed after the
   * commit (`dispatchAfterCommit`, INV-CACHE-001).
   */
  touchedSecurityIds: string[];
  /**
   * Accounts a structural rule moved money into (the loan of a settlement,
   * the target of a conversion); the sync dispatches their net-worth
   * recompute after the commit, as it does the synced account's
   * (INV-CACHE-001).
   */
  affectedAccountIds: string[];
  /**
   * Scheduled payments a `settle_loan_installment` rule claimed an occurrence
   * of; the sync reprices each template after the commit (INV-CACHE-001).
   */
  settledScheduleIds: string[];
}

/**
 * The single write transaction of a bank sync (docs/specs/bank-sync.md section 7
 * step 5): the ledger rows, the payees, the transactions, the import rules, the
 * balance and the sync outcome commit together or not at all.
 *
 * **INV-BANKSYNC-001, the mechanism.** A planned row's key is a function of the
 * row alone (`explainBankImport`). A row the ledger already holds, under that
 * key or a key an earlier planner gave the same bank transaction
 * (`findHeldRows`, read under the link and account row locks this write holds),
 * is skipped. Every other row first claims its ledger row with
 * `INSERT ... ON CONFLICT (account_id, external_key) DO NOTHING RETURNING id`;
 * nothing returned means the bank transaction was imported before, and nothing
 * else is written for it. The ledger is keyed on the Monize account, so the
 * claim holds across reconnects, and the unique index is what makes two
 * concurrent syncs converge.
 *
 * **INV-BANKSYNC-003.** Every row is written in the account's own currency,
 * through `assertTransactionCurrencyMatchesAccount`; the plan already refused a
 * row whose currency differs, and the write refuses the whole batch if the
 * account's currency changed while the bank was being read.
 *
 * **INV-BALANCE-001.** The balance is `AccountsService.recalculateCurrentBalance`
 * over the ledger, in this same transaction and under the account's row lock,
 * so it is right for a row of any date and there is no delta to get wrong. The
 * writer never writes `current_balance` itself.
 *
 * **A selection is checked before it is written.** `importKeys` and
 * `excludeKeys` must be disjoint and each must name a new row of the plan the
 * write makes under the lock; otherwise the whole write is refused (400) before
 * the first insert. An exception is a ledger row with `excluded_at` set and no
 * transaction, claimed with the same `ON CONFLICT DO NOTHING` as an import, so it
 * is in the same transaction and obeys the same unique key. A new row that is in
 * neither list is left alone, and then `last_success_at` does not move: the
 * window of the next sync starts a week before it, and a row skipped now must
 * still be inside that window to be shown again.
 *
 * **Possible duplicates (INV-IMPORT-004).** A new row that pairs with a
 * transaction already in the account (`findBankRowDuplicates`, read under the
 * locks this write holds) is written only by a decision: imported beside it,
 * merged into it, linked to it as it is, imported after it is deleted, or
 * added to the exceptions. Without one it is held, counted in
 * `held_duplicate_count`, and `last_success_at` does not move
 * (docs/specs/import-duplicate-review.md section 4). A merge, keep or replace
 * needs the preview's fingerprint, which covers the pairs, so a decision is
 * never applied to a pair other than the one shown.
 *
 * **A rejected sync has not already written.** The link and the account are
 * locked and re-checked before the first insert: a re-link, a new cut-off
 * date, a close or a currency change during the fetch refuses the whole write
 * (409, and `last_success_at` does not move).
 */
/** A transaction the sync created, with what its operation tag is named from. */
interface CreatedOperation {
  transactionId: string;
  operation: BankOperation;
  /** The planned row's direction, which a bare `TRANSFER` is read by. */
  direction: OperationDirection;
}

@Injectable()
export class BankSyncWriterService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly accountsService: AccountsService,
    private readonly rulesApplier: TransactionRulesApplierService,
    private readonly payeesService: PayeesService,
    private readonly tagsService: TagsService,
    private readonly i18n: I18nService,
    private readonly transactionsService: TransactionsService,
  ) {}

  async write(input: BankSyncWriteInput): Promise<BankSyncWriteOutcome> {
    const { userId, bankAccountId, accountId, plan } = input;

    return withScopedDb(this.dataSource, async (m) => {
      // 1. The link, under its row lock: a concurrent sync of the same bank
      //    account queues here, and a re-link is refused rather than written
      //    through.
      const link = await m.getRepository(BankSyncAccount).findOne({
        where: { id: bankAccountId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!link) {
        throw new NotFoundException(
          tr(
            "errors.bankSync.bankAccountNotFound",
            `Bank account with ID ${bankAccountId} not found`,
            { id: bankAccountId },
          ),
        );
      }
      if (link.accountId !== accountId) {
        throw new ConflictException(
          tr(
            "errors.bankSync.linkChanged",
            "The bank account was linked to a different account while it was being read. Nothing was imported; sync again.",
          ),
        );
      }

      if (link.syncFromDate !== input.plannedSyncFromDate) {
        throw new ConflictException(
          tr(
            "errors.bankSync.cutoffChanged",
            "The cut-off date of the bank account changed while it was being read. Nothing was imported; sync again.",
          ),
        );
      }

      // 2. The Monize account, locked for a balance write before it is read.
      await lockAccountsForBalanceWrite(m, [accountId], userId);
      const account = await m
        .getRepository(Account)
        .findOne({ where: { id: accountId, userId } });
      if (!account) {
        throw new ConflictException(
          tr(
            "errors.bankSync.linkChanged",
            "The bank account was linked to a different account while it was being read. Nothing was imported; sync again.",
          ),
        );
      }
      if (account.isClosed) {
        throw new BadRequestException(
          tr(
            "errors.bankSync.accountClosed",
            "The linked account is closed. Reopen it or link another account.",
          ),
        );
      }
      if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE) {
        throw new BadRequestException(
          tr(
            "errors.bankSync.accountBrokerage",
            "An investment brokerage account cannot receive bank transactions. Link its cash account instead.",
          ),
        );
      }
      if (account.accountType === AccountType.CRYPTO) {
        throw new BadRequestException(
          tr(
            "errors.bankSync.accountCrypto",
            "A cryptocurrency wallet cannot receive bank transactions. Link a bank account instead.",
          ),
        );
      }

      // 3. INV-BANKSYNC-003: the account's currency is the row's currency, and
      //    it is still the one the plan was made against.
      const currencyCode = assertTransactionCurrencyMatchesAccount(
        null,
        account.currencyCode,
      );
      if (currencyCode !== input.plannedCurrencyCode.trim().toUpperCase()) {
        throw new ConflictException(
          tr(
            "errors.bankSync.accountCurrencyChanged",
            "The currency of the linked account changed while it was being read. Nothing was imported; sync again.",
          ),
        );
      }

      // 3b. The planned rows the ledger already holds, under its own key or a
      //     key an earlier version of the planner gave the same bank
      //     transaction (`findHeldRows`), read under the row lock this
      //     transaction holds, so a concurrent sync of the same account has
      //     either committed (and its rows are held now) or waits behind it.
      //     A confirmed preview or a selection: what is about to be written is
      //     what was shown.
      if (plan.review && (link.backfillThrough ?? null) !== plan.review.cursor)
        throw new BankSyncPlanChangedException(
          tr(
            "errors.bankSync.planChanged",
            "The bank's data changed since the preview. Nothing was imported; preview again.",
          ),
        );
      const { selection } = input;
      if (selection !== undefined) assertDisjointSelection(selection);
      if (
        selection !== undefined &&
        namesExistingTransactions(selection) &&
        input.expectedFingerprint === undefined
      ) {
        // A merge, a keep or a replace names the transaction a possible
        // duplicate pairs with only through the fingerprint of the preview
        // that showed the pair.
        throw new BankSyncSelectionRefusedException(
          tr(
            "errors.bankSync.duplicateNeedsPreview",
            "A decision about a possible duplicate needs the preview that showed it. Nothing was imported; preview again.",
          ),
        );
      }
      const held = await findHeldRows(m, userId, accountId, plan.planned);
      const newRows = newPlannedRows(plan.planned, held);
      const newKeys: ReadonlySet<string> = new Set(
        newRows.map((row) => row.externalKey),
      );
      // 3c. The possible duplicates among the new rows
      //     (docs/specs/import-duplicate-review.md section 4). The existing
      //     transactions a decision names are row-locked (accounts before
      //     transactions) and the pairs read again under that lock, so the
      //     fingerprint below is compared with pairs no concurrent edit can
      //     move before this commits.
      let duplicates = await findBankRowDuplicates(
        m,
        userId,
        accountId,
        newRows,
      );
      const decisionByKey = this.decisionsOf(selection);
      const decidedExisting = [...duplicates]
        .filter(([key]) => decisionByKey.has(key))
        .map(([, existing]) => existing.id);
      if (decidedExisting.length > 0) {
        await lockTransactionRows(m, decidedExisting, userId);
        duplicates = await findBankRowDuplicates(m, userId, accountId, newRows);
      }
      if (
        input.expectedFingerprint !== undefined &&
        planFingerprint(newRows, plan.review, duplicates) !==
          input.expectedFingerprint
      ) {
        throw new BankSyncPlanChangedException(
          tr(
            "errors.bankSync.planChanged",
            "The bank's data changed since the preview. Nothing was imported; preview again.",
          ),
        );
      }
      const importKeys =
        selection === undefined ? null : new Set(selection.importKeys);
      const excludeKeys =
        selection === undefined ? null : new Set(selection.excludeKeys);
      if (selection !== undefined) {
        const stray = [...selection.importKeys, ...selection.excludeKeys].some(
          (key) => !newKeys.has(key),
        );
        if (stray) {
          throw new BankSyncSelectionRefusedException(
            tr(
              "errors.bankSync.selectionNotNew",
              "A selected transaction is not a new row of the bank's data. Nothing was imported; preview again.",
            ),
          );
        }
        this.assertDuplicateDecisions(decisionByKey, duplicates);
      }

      // 4. The user's import rules, loaded once for the batch.
      const rules = await this.rulesApplier.loadRulesFor(m, userId, "import");

      // 4b. Exceptions: a ledger row with no transaction, claimed like any
      //     other, so no later sync imports the bank transaction.
      let excluded = 0;
      if (excludeKeys !== null) {
        for (const row of plan.planned) {
          if (!excludeKeys.has(row.externalKey)) continue;
          const claimedException = returnedRows<{ id: string }>(
            await m.query(
              `INSERT INTO bank_sync_imported_transactions
                 (user_id, account_id, external_key, booking_date, excluded_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (account_id, external_key) DO NOTHING
               RETURNING id`,
              [userId, accountId, row.externalKey, row.transactionDate],
            ),
          );
          excluded += claimedException.length;
        }
      }

      // 5. Row by row: claim the ledger row, then write what it promises.
      const created: string[] = [];
      const createdDateById = new Map<string, string>();
      const createdOperations: CreatedOperation[] = [];
      const payeeTextById = new Map<string, string | null>();
      const payeeCache = new Map<string, ResolvedPayee>();
      const dateCounters = new Map<string, number>();
      const baseTime = Date.now();
      let skipped = 0;

      let merged = 0;
      let kept = 0;
      let replaced = 0;
      // What a replaced transaction's deletion moved, dispatched after the
      // commit rather than inside this transaction.
      const deferred = {
        accountIds: new Set<string>(),
        securityIds: new Set<string>(),
      };
      let heldDuplicates = 0;
      let leftForLater = 0;
      for (const row of plan.planned) {
        if (held.has(row.externalKey)) {
          if (importKeys === null || importKeys.has(row.externalKey)) {
            skipped += 1;
          }
          continue;
        }
        const pair = duplicates.get(row.externalKey);
        const decision: DuplicateAction | "except" | null =
          selection === undefined
            ? pair === undefined
              ? "import"
              : null
            : (decisionByKey.get(row.externalKey) ?? null);
        if (decision === null) {
          // Nobody decided: a plain new row left for the next sync, or a
          // possible duplicate held back for the person.
          leftForLater += 1;
          if (pair !== undefined) heldDuplicates += 1;
          continue;
        }
        if (decision === "except") continue;
        if (
          pair !== undefined &&
          (decision === "merge" || decision === "keep")
        ) {
          if (
            await this.linkToExisting(m, userId, accountId, row, pair, decision)
          ) {
            if (decision === "merge") merged += 1;
            else kept += 1;
          } else {
            skipped += 1;
          }
          continue;
        }
        const claimed = returnedRows<{ id: string }>(
          await m.query(
            `INSERT INTO bank_sync_imported_transactions
               (user_id, account_id, external_key, booking_date)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (account_id, external_key) DO NOTHING
             RETURNING id`,
            [userId, accountId, row.externalKey, row.transactionDate],
          ),
        );
        if (claimed.length === 0) {
          skipped += 1;
          continue;
        }
        if (pair !== undefined && decision === "replace") {
          // Only once the key is this write's: a key a concurrent sync
          // claimed writes nothing, so it must delete nothing either. Through
          // the one delete path, which reverses what the row contributed and
          // cleans up what hangs off it, in this transaction. A sync records
          // no history entry, so neither does its delete.
          await this.transactionsService.remove(userId, pair.id, {
            recordHistory: false,
            deferDerivedRecompute: deferred,
          });
          replaced += 1;
        }

        const payee = await this.resolvePayee(
          m,
          userId,
          row.payeeText,
          payeeCache,
        );
        // One millisecond apart per date, as the file import does, so rows of
        // one day keep the order the bank listed them in.
        const counter = dateCounters.get(row.transactionDate) ?? 0;
        dateCounters.set(row.transactionDate, counter + 1);

        const saved = await m.save(
          m.create(Transaction, {
            userId,
            accountId,
            transactionDate: row.transactionDate,
            amount: row.amount,
            currencyCode,
            payeeId: payee.payeeId,
            payeeName: payee.payeeName ?? row.payeeText,
            categoryId: payee.defaultCategoryId,
            description: row.description,
            referenceNumber: row.referenceNumber,
            status: TransactionStatus.CLEARED,
            isSplit: false,
            isTransfer: false,
            createdAt: new Date(baseTime + counter),
          }),
        );
        await m.query(
          `UPDATE bank_sync_imported_transactions
              SET transaction_id = $1
            WHERE id = $2`,
          [saved.id, claimed[0].id],
        );
        created.push(saved.id);
        createdDateById.set(saved.id, row.transactionDate);
        createdOperations.push({
          transactionId: saved.id,
          operation: row.operation,
          direction: row.direction,
        });
        payeeTextById.set(saved.id, row.payeeText);
      }

      // 5b. The bank's operation type as a tag, BEFORE the rules run, so a rule
      //     can use it ("tags has any Card payment").
      if (input.tagOperationType) {
        await this.tagOperations(m, userId, createdOperations, input.profile);
      }

      // 6. The import rules over what was created, oldest first and within a
      //    date in the bank's order (INV-RULE-005), with the bank's raw payee
      //    text.
      const affectedAccountIds = new Set<string>(deferred.accountIds);
      const settledScheduleIds = new Set<string>();
      const forRules = orderByDateStable(
        created,
        (id) => createdDateById.get(id) ?? "",
      ).map(({ row }) => row);
      const payeeByRow = new Map<string, string>();
      for (let start = 0; start < forRules.length; start += RULES_BATCH_SIZE) {
        const applied = await this.rulesApplier.applyToNew(
          m,
          userId,
          forRules.slice(start, start + RULES_BATCH_SIZE),
          "import",
          { rules, payeeTextById },
        );
        for (const row of applied) {
          for (const accountId of row.affectedAccountIds) {
            affectedAccountIds.add(accountId);
          }
          for (const scheduleId of row.settledScheduleIds) {
            settledScheduleIds.add(scheduleId);
          }
          const payeeId = payeeGivingDefaultCategory(row.effects);
          if (payeeId !== null) payeeByRow.set(row.transactionId, payeeId);
        }
      }

      // 6b. A row whose payee the rules changed, and whose category they did
      //     not set, takes the new payee's default category.
      await this.applyRulePayeeCategories(m, userId, payeeByRow);

      // 7. The balance, from the ledger, in this transaction.
      if (created.length > 0 || merged > 0 || replaced > 0) {
        await this.accountsService.recalculateCurrentBalance(userId, accountId);
      }

      // 8. The outcome, on the row this transaction holds locked. A new row the
      //    person neither imported nor excepted moves nothing forward, and a
      //    possible duplicate held back is recorded so the account needs its
      //    preview.
      await this.recordOutcome(
        m,
        input,
        created.length,
        skipped,
        leftForLater === 0,
        heldDuplicates,
      );

      return {
        imported: created.length,
        skipped,
        excluded,
        merged,
        kept,
        replaced,
        heldDuplicates,
        touchedSecurityIds: [...deferred.securityIds],
        affectedAccountIds: [...affectedAccountIds],
        settledScheduleIds: [...settledScheduleIds],
      };
    });
  }

  /**
   * After the write committed: the bond prices of the securities a replaced
   * transaction's deletion touched (INV-CACHE-001). The net-worth recompute of
   * the accounts it moved is the caller's, through `affectedAccountIds`.
   */
  async dispatchAfterCommit(
    userId: string,
    outcome: Pick<BankSyncWriteOutcome, "touchedSecurityIds">,
  ): Promise<void> {
    if (outcome.touchedSecurityIds.length === 0) return;
    await this.transactionsService.dispatchDeferredRecompute(userId, {
      accountIds: new Set(),
      securityIds: new Set(outcome.touchedSecurityIds),
    });
  }

  /**
   * The decision the selection makes about each key it names: one of the
   * duplicate actions, or `except` for an exception. Empty without a selection.
   */
  private decisionsOf(
    selection: BankSyncSelection | undefined,
  ): Map<string, DuplicateAction | "except"> {
    const decisions = new Map<string, DuplicateAction | "except">();
    if (selection === undefined) return decisions;
    const lists: [readonly string[], DuplicateAction | "except"][] = [
      [selection.importKeys, "import"],
      [selection.excludeKeys, "except"],
      [selection.mergeKeys, "merge"],
      [selection.keepKeys, "keep"],
      [selection.replaceKeys, "replace"],
    ];
    for (const [keys, decision] of lists) {
      for (const key of keys) decisions.set(key, decision);
    }
    return decisions;
  }

  /**
   * Refuses (400), before anything is written, a merge, keep or replace that
   * does not name a possible duplicate of the plan made under the lock, or
   * that spec section 3 does not allow for the transaction it pairs with.
   */
  private assertDuplicateDecisions(
    decisions: ReadonlyMap<string, DuplicateAction | "except">,
    duplicates: ReadonlyMap<string, DuplicateCandidate>,
  ): void {
    for (const [key, decision] of decisions) {
      if (decision === "import" || decision === "except") continue;
      const pair = duplicates.get(key);
      if (pair === undefined) {
        throw new BankSyncSelectionRefusedException(
          tr(
            "errors.bankSync.selectionNotDuplicate",
            "A transaction chosen to merge, keep or replace is not a possible duplicate any more. Nothing was imported; preview again.",
          ),
        );
      }
      if (!allowedDuplicateActions(pair).includes(decision)) {
        throw new BankSyncSelectionRefusedException(
          tr(
            "errors.bankSync.duplicateActionNotAllowed",
            "A reconciled transaction cannot be merged or replaced, and a transfer or a split cannot be replaced. Nothing was imported; keep it or import the bank's row beside it.",
          ),
        );
      }
    }
  }

  /**
   * Merge or keep: the bank row's key is claimed for the existing transaction
   * (`ON CONFLICT DO NOTHING`, as for an import), so no later sync brings the
   * row back. A merge then gives the existing transaction the bank's date
   * (not for a transfer leg or a split parent), its reference when it has one,
   * and status Cleared; its payee, category, splits, tags and memo stay. False
   * when a concurrent sync claimed the key first: nothing else is written.
   */
  private async linkToExisting(
    m: EntityManager,
    userId: string,
    accountId: string,
    row: PlannedBankRow,
    existing: DuplicateCandidate,
    decision: "merge" | "keep",
  ): Promise<boolean> {
    const claimed = returnedRows<{ id: string }>(
      await m.query(
        `INSERT INTO bank_sync_imported_transactions
           (user_id, account_id, external_key, booking_date, transaction_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, external_key) DO NOTHING
         RETURNING id`,
        [userId, accountId, row.externalKey, row.transactionDate, existing.id],
      ),
    );
    if (claimed.length === 0) return false;
    if (decision === "merge") {
      // A bank row has no FITID of its own: the ledger row is its key.
      await mergeIntoExisting(m, userId, existing, {
        date: row.transactionDate,
        referenceNumber: row.referenceNumber,
        externalId: null,
      });
    }
    return true;
  }

  /**
   * The payee for a bank counterparty, the way the file import resolves one: an
   * exact name, then an alias pattern (the `PayeesService` lookups the importer
   * shares), else a new payee. An empty counterparty is no payee.
   *
   * The create is one `INSERT ... ON CONFLICT (user_id, name)` so two syncs that
   * meet the same new counterparty converge on one payee rather than one of them
   * failing on the unique key. No action-history entry is written: it is
   * recorded outside a transaction by contract, and the file import records
   * none either.
   */
  private async resolvePayee(
    m: EntityManager,
    userId: string,
    text: string | null,
    cache: Map<string, ResolvedPayee>,
  ): Promise<ResolvedPayee> {
    if (text === null) return NO_PAYEE;
    const cached = cache.get(text);
    if (cached) return cached;

    let resolved = await findExistingPayee(this.payeesService, userId, text);
    if (resolved === null) {
      const rows = returnedRows<{
        id: string;
        name: string;
        default_category_id: string | null;
      }>(
        await m.query(
          `INSERT INTO payees (user_id, name)
           VALUES ($1, $2)
           ON CONFLICT (user_id, name) DO UPDATE SET name = payees.name
           RETURNING id, name, default_category_id`,
          [userId, text],
        ),
      );
      resolved = {
        payeeId: rows[0].id,
        payeeName: rows[0].name,
        defaultCategoryId: rows[0].default_category_id,
        defaultCategoryName: null,
        via: null,
      };
    }
    cache.set(text, resolved);
    return resolved;
  }

  /**
   * Give each row in `payeeByRow` the default category of the payee the rules
   * chose for it (`payeeGivingDefaultCategory`), in this transaction. A payee
   * with no default category leaves the row as the rules left it.
   */
  private async applyRulePayeeCategories(
    m: EntityManager,
    userId: string,
    payeeByRow: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (payeeByRow.size === 0) return;
    const defaults = await loadPayeeDefaultCategories(m, userId, [
      ...payeeByRow.values(),
    ]);
    for (const [transactionId, payeeId] of payeeByRow) {
      const category = defaults.get(payeeId);
      if (category === undefined) continue;
      await m.update(
        Transaction,
        { id: transactionId, userId, isSplit: false, isTransfer: false },
        { categoryId: category.categoryId },
      );
    }
  }

  /**
   * Tag the created transactions with the bank's operation type, on the
   * writer's manager and so inside its transaction. The tag's name is the
   * operation's label in the user's language (`resolveUserEmailLocale`: the
   * stored preference, as a message addressed to the person); a known code is
   * translated and an unknown one is its own name. A tag is resolved by name
   * case-insensitively and created when missing; a row whose operation gives no
   * tag name is left untagged. The links are written through `TagsService`'s
   * additive, idempotent `addTransactionTags`.
   */
  private async tagOperations(
    m: EntityManager,
    userId: string,
    created: readonly CreatedOperation[],
    profile: BankSyncProfile,
  ): Promise<void> {
    if (created.length === 0) return;
    const lang = await resolveUserEmailLocale(
      m.getRepository(UserPreference),
      userId,
    );
    const t = emailTranslator(this.i18n, lang);
    const tagIds = new Map<string, string>();
    const transactionsByTag = new Map<string, string[]>();
    for (const { transactionId, operation, direction } of created) {
      const tag = operationTagLabel(operation, profile, t, direction);
      if (tag === null) continue;
      const tagId = await findOrCreateTagId(m, userId, tag.label, tagIds);
      transactionsByTag.set(tagId, [
        ...(transactionsByTag.get(tagId) ?? []),
        transactionId,
      ]);
    }
    for (const [tagId, transactionIds] of transactionsByTag) {
      for (
        let start = 0;
        start < transactionIds.length;
        start += RULES_BATCH_SIZE
      ) {
        await this.tagsService.addTransactionTags(
          m,
          userId,
          transactionIds.slice(start, start + RULES_BATCH_SIZE),
          [tagId],
        );
      }
    }
  }

  private async recordOutcome(
    m: EntityManager,
    input: BankSyncWriteInput,
    imported: number,
    skipped: number,
    advanceWindow: boolean,
    heldDuplicates: number,
  ): Promise<void> {
    const refused = Object.values(input.plan.refused).reduce(
      (sum, count) => sum + count,
      0,
    );
    await m.query(
      `UPDATE bank_sync_accounts
          SET last_synced_at = CURRENT_TIMESTAMP,
              last_success_at = CASE WHEN $6::boolean
                                     THEN CASE WHEN $8::boolean THEN last_success_at ELSE CURRENT_TIMESTAMP END
                                     ELSE last_success_at END,
              backfill_through = CASE WHEN $6::boolean THEN $7::date ELSE backfill_through END,
              last_sync_status = 'succeeded',
              last_sync_error = NULL,
              last_imported_count = $3,
              last_skipped_count = $4,
              last_refused_count = $5,
              held_duplicate_count = $9
        WHERE id = $1 AND user_id = $2`,
      [
        input.bankAccountId,
        input.userId,
        imported,
        skipped,
        refused,
        advanceWindow,
        input.plan.review?.remaining ? input.plan.review.dateTo : null,
        input.plan.review?.remaining ?? false,
        heldDuplicates,
      ],
    );
    // A balance the bank did not report leaves the stored one as it was: null is
    // "not reported", never a reason to blank what an earlier sync learned.
    if (input.balance !== null) {
      await m.query(
        `UPDATE bank_sync_accounts
            SET bank_balance = $3,
                bank_balance_currency = $4,
                bank_balance_date = $5
          WHERE id = $1 AND user_id = $2`,
        [
          input.bankAccountId,
          input.userId,
          input.balance.amount,
          input.balance.currencyCode,
          input.balance.referenceDate,
        ],
      );
      if (input.balance.reportedAt !== undefined)
        await m.query(
          "UPDATE bank_sync_accounts SET bank_balance_at=$1::timestamptz WHERE id=$2 AND user_id=$3",
          [input.balance.reportedAt, input.bankAccountId, input.userId],
        );
    }
  }
}
