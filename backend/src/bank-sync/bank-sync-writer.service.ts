import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { DataSource, EntityManager } from "typeorm";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { AccountsService } from "../accounts/accounts.service";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { assertTransactionCurrencyMatchesAccount } from "../common/fx-entry.util";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { tr } from "../i18n/translate";
import { PayeesService } from "../payees/payees.service";
import { TagsService } from "../tags/tags.service";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
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
  findExistingPayee,
  NO_PAYEE,
  type ResolvedPayee,
} from "./bank-sync-payee-lookup";
import {
  findLedgerKeys,
  newPlannedRows,
  planFingerprint,
} from "./bank-sync-plan-fingerprint";
import {
  assertDisjointSelection,
  type BankSyncSelection,
} from "./bank-sync-selection";
import type { BankImportPlan } from "./bank-transaction-planner";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";

/** A bank balance that passed validation, at the column's money precision. */
export interface NormalizedBankBalance {
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
}

/**
 * The single write transaction of a bank sync (docs/specs/bank-sync.md section 7
 * step 5): the ledger rows, the payees, the transactions, the import rules, the
 * balance and the sync outcome commit together or not at all.
 *
 * **INV-BANKSYNC-001, the mechanism.** Each planned row first claims its ledger
 * row with `INSERT ... ON CONFLICT (account_id, external_key) DO NOTHING
 * RETURNING id`; nothing returned means the bank transaction was imported
 * before, and nothing else is written for it. The ledger is keyed on the Monize
 * account, so the claim holds across reconnects, and the unique index is what
 * makes two concurrent syncs converge.
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

      // 3b. A confirmed preview or a selection: what is about to be written is
      //     what was shown. The rows are the planned ones the ledger does not
      //     hold yet, read under the row lock this transaction holds, so a
      //     concurrent sync of the same account has either committed (and its
      //     rows are duplicates now) or waits behind it.
      const { selection } = input;
      if (selection !== undefined) assertDisjointSelection(selection);
      let newKeys: ReadonlySet<string> | null = null;
      if (input.expectedFingerprint !== undefined || selection !== undefined) {
        const ledgerKeys = await findLedgerKeys(
          m,
          userId,
          accountId,
          plan.planned.map((row) => row.externalKey),
        );
        const newRows = newPlannedRows(plan.planned, ledgerKeys);
        newKeys = new Set(newRows.map((row) => row.externalKey));
        if (
          input.expectedFingerprint !== undefined &&
          planFingerprint(newRows) !== input.expectedFingerprint
        ) {
          throw new BankSyncPlanChangedException(
            tr(
              "errors.bankSync.planChanged",
              "The bank's data changed since the preview. Nothing was imported; preview again.",
            ),
          );
        }
      }
      const importKeys =
        selection === undefined ? null : new Set(selection.importKeys);
      const excludeKeys =
        selection === undefined ? null : new Set(selection.excludeKeys);
      if (selection !== undefined && newKeys !== null) {
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
      const createdOperations: CreatedOperation[] = [];
      const payeeTextById = new Map<string, string | null>();
      const payeeCache = new Map<string, ResolvedPayee>();
      const dateCounters = new Map<string, number>();
      const baseTime = Date.now();
      let skipped = 0;

      for (const row of plan.planned) {
        if (importKeys !== null && !importKeys.has(row.externalKey)) continue;
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

      // 6. The import rules over what was created, with the bank's raw payee text.
      for (let start = 0; start < created.length; start += RULES_BATCH_SIZE) {
        await this.rulesApplier.applyToNew(
          m,
          userId,
          created.slice(start, start + RULES_BATCH_SIZE),
          "import",
          { rules, payeeTextById },
        );
      }

      // 7. The balance, from the ledger, in this transaction.
      if (created.length > 0) {
        await this.accountsService.recalculateCurrentBalance(userId, accountId);
      }

      // 8. The outcome, on the row this transaction holds locked. A new row the
      //    person neither imported nor excepted moves nothing forward.
      const leftForLater =
        newKeys !== null && importKeys !== null && excludeKeys !== null
          ? newKeys.size - importKeys.size - excludeKeys.size
          : 0;
      await this.recordOutcome(
        m,
        input,
        created.length,
        skipped,
        leftForLater === 0,
      );

      return { imported: created.length, skipped, excluded };
    });
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
  ): Promise<void> {
    const refused = Object.values(input.plan.refused).reduce(
      (sum, count) => sum + count,
      0,
    );
    await m.query(
      `UPDATE bank_sync_accounts
          SET last_synced_at = CURRENT_TIMESTAMP,
              last_success_at = CASE WHEN $6::boolean
                                     THEN CURRENT_TIMESTAMP
                                     ELSE last_success_at END,
              last_sync_status = 'succeeded',
              last_sync_error = NULL,
              last_imported_count = $3,
              last_skipped_count = $4,
              last_refused_count = $5
        WHERE id = $1 AND user_id = $2`,
      [
        input.bankAccountId,
        input.userId,
        imported,
        skipped,
        refused,
        advanceWindow,
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
    }
  }
}
