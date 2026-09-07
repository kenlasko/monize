import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { Brackets, EntityManager, In, DataSource } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TransactionAttachment } from "../attachments/entities/transaction-attachment.entity";
import { primaryAttachmentSql } from "../attachments/primary-attachment.util";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { UpdateTransferDto } from "./dto/update-transfer.dto";
import { TagsService } from "../tags/tags.service";
import { AccountsService } from "../accounts/accounts.service";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TransactionSplitService } from "./transaction-split.service";
import { applyRegisterOrder } from "./register-order";
import {
  brokerageExclusionForEntity,
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
} from "../common/investment-filter.util";
import { transferPayeeLabel } from "./transfer-payee-label.util";
import {
  assertVoidTransitionAllowedOnRow,
  applyVoidTransitionToMirrorLeg,
} from "./void-status-transition.util";
import {
  PreparedTransfer,
  TransactionTransferService,
  TransferActor,
  TransferResult,
} from "./transaction-transfer.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import {
  maskTransactionsAgainst,
  payloadHasCrossOwnerTransfer,
} from "../delegation/transfer-mask.util";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import {
  TransactionBulkUpdateService,
  BulkUpdateResult,
  BulkDeleteResult,
} from "./transaction-bulk-update.service";
import { BulkUpdateDto, BulkDeleteDto } from "./dto/bulk-update.dto";
import { isTransactionInFuture } from "../common/date-utils";
import { ActionHistoryService } from "../action-history/action-history.service";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { loadQualifiedCategoryNames } from "../categories/category-name.util";
import { formatCurrency } from "../common/format-currency.util";
import {
  buildPaginationMeta,
  clampPagination,
  PaginatedResult,
} from "../common/dto/pagination-query.dto";
import {
  buildTransactionSearchClause,
  escapeLikePattern,
} from "./transaction-search.util";
import {
  parseSearchTerm,
  ParsedSearchTerm,
} from "./transaction-search-parse.util";
import { buildTagKeyFilterClause, TagKeyFilter } from "./tag-key-filter.util";
import { onlyBalanceAffecting } from "./balance-affecting.util";
import { tr } from "../i18n/translate";
import { stripHtml } from "../common/sanitization.util";
import {
  BulkCreateResult,
  BulkCreateSkip,
  bulkSkipReason,
} from "../common/bulk-create.types";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTransactionRow, lockTransactionRows } from "../common/db/locks";
import { assertReconciledRowsMutable } from "./reconciled-lock.util";
import { roundMoney } from "../common/round.util";
import {
  assertTransactionCurrencyMatchesAccount,
  normalizeFxEntry,
  type FxEntry,
  type FxEntryInput,
} from "../common/fx-entry.util";

export interface TransactionWithInvestmentLink extends Transaction {
  linkedInvestmentTransactionId?: string | null;
  attachmentCount?: number;
}

export interface PaginatedTransactions extends PaginatedResult<TransactionWithInvestmentLink> {
  startingBalance?: number;
}

export interface LlmTransactionRow {
  id: string;
  splitId?: string;
  date: string;
  payeeName: string | null;
  categoryName?: string;
  amount: number;
  accountName?: string;
  description: string | null;
  status: string;
  isSplit?: boolean;
  // Foreign-currency entry metadata (read-only). Present only when the
  // transaction was entered in a currency other than the account currency.
  originalAmount?: number;
  originalCurrencyCode?: string;
  exchangeRate?: number;
}

export interface LlmTransactionSearch {
  transactions: LlmTransactionRow[];
  total: number;
  hasMore: boolean;
}

/**
 * Resolved, sanitized preview of a transaction the assistant proposes to
 * create. Shared by the MCP `create_transaction` dry-run and the AI Assistant's
 * human-in-the-loop confirmation flow so both surfaces validate ownership and
 * resolve names identically.
 */
export interface CreateTransactionPreview {
  accountId: string;
  accountName: string;
  amount: number;
  transactionDate: string;
  /**
   * Existing payee the name resolved to (so create() links the transaction to
   * the payee record), or null when no payee matched the given name.
   */
  payeeId: string | null;
  payeeName: string | null;
  /** True when payeeName matched an existing payee; false for a new name. */
  payeeMatched: boolean;
  /**
   * True when confirming this transaction will create a new payee: an unmatched
   * name with createPayeeIfMissing left enabled. False when the name matched an
   * existing payee, no name was given, or the name will be stored as free text.
   */
  payeeWillBeCreated: boolean;
  categoryId: string | null;
  categoryName: string | null;
  description: string | null;
  currencyCode: string;
}

/** Resolved preview of a proposed transaction re-categorization. */
export interface CategorizeTransactionPreview {
  transactionId: string;
  payeeName: string | null;
  amount: number;
  transactionDate: string;
  accountName: string | null;
  currentCategoryName: string | null;
  categoryId: string;
  newCategoryName: string;
}

/**
 * Resolved, sanitized preview of an edit the assistant proposes to an existing
 * transaction. Carries the full resulting state (every field as it will be
 * persisted) so the confirmation card matches the create flow and the signed
 * descriptor can apply an idempotent overwrite. Shared by the MCP
 * `update_transaction` dry-run and the AI Assistant confirmation flow.
 */
export interface UpdateTransactionPreview {
  transactionId: string;
  accountId: string;
  accountName: string;
  amount: number;
  transactionDate: string;
  payeeId: string | null;
  payeeName: string | null;
  payeeMatched: boolean;
  payeeWillBeCreated: boolean;
  categoryId: string | null;
  categoryName: string | null;
  description: string | null;
  currencyCode: string;
  /**
   * True when the target transaction is reconciled. Editing it disturbs a
   * completed reconciliation, so the confirmation surfaces flag this.
   */
  isReconciled: boolean;
}

/** Resolved preview of a proposed transaction deletion (display-only). */
export interface DeleteTransactionPreview {
  transactionId: string;
  accountName: string;
  amount: number;
  transactionDate: string;
  payeeName: string | null;
  categoryName: string | null;
  description: string | null;
  currencyCode: string;
  /**
   * True when the target transaction is reconciled. Deleting it disturbs a
   * completed reconciliation, so the confirmation surfaces flag this.
   */
  isReconciled: boolean;
}

export { TransferResult };

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private payeesService: PayeesService,
    private tagsService: TagsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private splitService: TransactionSplitService,
    private transferService: TransactionTransferService,
    private reconciliationService: TransactionReconciliationService,
    private analyticsService: TransactionAnalyticsService,
    private bulkUpdateService: TransactionBulkUpdateService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    private crossOwnerAccess: CrossOwnerAccessService,
  ) {}

  /**
   * Interprets the search box term as an exact amount and/or date using the
   * user's number/date-format preferences, so a value typed in the user's own
   * locale format (e.g. "1 234,56" or "02.07.2026") also matches. Returns
   * `{ amount: null, date: null }` for a blank/non-parseable term.
   */
  private async resolveSearchTerm(
    userId: string,
    term?: string,
  ): Promise<ParsedSearchTerm> {
    if (!term || !term.trim()) return { amount: null, date: null };
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    return parseSearchTerm(term, {
      numberFormat: prefs?.numberFormat,
      dateFormat: prefs?.dateFormat,
    });
  }

  /**
   * Validate and normalize the foreign-currency entry fields against the
   * account currency. Thin wrapper over the shared `normalizeFxEntry`, which
   * scheduled transactions use too so both surfaces accept and reject exactly
   * the same payloads.
   */
  private normalizeFxEntry(
    input: FxEntryInput,
    accountCurrencyCode: string,
  ): FxEntry {
    return normalizeFxEntry(input, accountCurrencyCode);
  }

  async create(
    userId: string,
    createTransactionDto: CreateTransactionDto,
    options?: { createPayeeIfMissing?: boolean },
  ): Promise<Transaction> {
    const account = await this.accountsService.findOne(
      userId,
      createTransactionDto.accountId,
    );

    const { splits, tagIds, ...transactionData } = createTransactionDto;
    const hasSplits = splits && splits.length > 0;

    if (hasSplits) {
      this.splitService.validateSplits(splits, createTransactionDto.amount);
    }

    // The stored primary currency is the account's; a mismatched request is
    // rejected rather than persisted beside a balance in another currency.
    const primaryCurrencyCode = assertTransactionCurrencyMatchesAccount(
      transactionData.currencyCode,
      account.currencyCode,
    );

    // Normalize/validate foreign-currency entry against the account currency.
    const fx = this.normalizeFxEntry(
      {
        originalAmount: transactionData.originalAmount,
        originalCurrencyCode: transactionData.originalCurrencyCode,
        exchangeRate: transactionData.exchangeRate,
        amount: transactionData.amount,
      },
      account.currencyCode,
    );

    // Validate ownership of a referenced payee, or -- when the caller opts in
    // (createPayeeIfMissing) and only a free-text name was given -- find or
    // create a reusable payee from that name so the transaction links to a
    // payee record. Callers that want a one-off free-text payee leave the
    // option unset, in which case the name is stored verbatim.
    let resolvedPayeeId = transactionData.payeeId;
    let resolvedPayeeName = transactionData.payeeName;
    if (transactionData.payeeId) {
      await this.payeesService.findOne(userId, transactionData.payeeId);
    } else if (
      options?.createPayeeIfMissing &&
      typeof transactionData.payeeName === "string" &&
      transactionData.payeeName.trim().length > 0
    ) {
      const payee = await this.payeesService.findOrCreate(
        userId,
        transactionData.payeeName.trim(),
      );
      resolvedPayeeId = payee.id;
      resolvedPayeeName = payee.name;
    }
    if (transactionData.categoryId) {
      const cat = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: transactionData.categoryId, userId },
        }),
      );
      if (!cat) {
        throw new NotFoundException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
    }

    let categoryId = transactionData.categoryId;
    if (!hasSplits && !categoryId && resolvedPayeeId) {
      try {
        const payee = await this.payeesService.findOne(userId, resolvedPayeeId);
        if (payee.defaultCategoryId) {
          categoryId = payee.defaultCategoryId;
        }
      } catch {
        // Payee already validated above; this is for default category lookup
      }
    }

    // Provider rate lookups for cross-currency transfer children happen out
    // here, before the transaction opens; see prewarmSplitTransferRates.
    if (hasSplits) {
      await this.splitService.prewarmSplitTransferRates(
        userId,
        splits,
        createTransactionDto.accountId,
        createTransactionDto.transactionDate,
      );
    }

    // Accounts a transfer/investment split touched, invalidated after commit.
    const splitAffectedAccountIds = new Set<string>();

    // One transaction: the row, its splits/tags, and the balance update
    // commit or roll back together. Nested service calls (split service, tags,
    // account balances) run their own withScopedDb and join this one.
    const savedTransactionId = await withScopedDb(
      this.dataSource,
      async (m) => {
        const transaction = m.create(Transaction, {
          ...transactionData,
          // Derived from the account, not taken from the request: `amount` is in
          // the account's currency, so the primary code has to be too
          // (audit P5-003).
          currencyCode: primaryCurrencyCode,
          payeeId: resolvedPayeeId,
          payeeName: resolvedPayeeName,
          categoryId: hasSplits ? null : categoryId,
          isSplit: hasSplits,
          userId,
          exchangeRate: transactionData.exchangeRate || 1,
          originalAmount: fx.originalAmount,
          originalCurrencyCode: fx.originalCurrencyCode,
        });

        const savedTransaction = await m.save(transaction);

        if (hasSplits) {
          const savedSplits = await this.splitService.createSplits(
            savedTransaction.id,
            splits,
            userId,
            createTransactionDto.accountId,
            new Date(createTransactionDto.transactionDate),
            resolvedPayeeName,
            resolvedPayeeId,
            // A VOID parent's transfer counterpart must be VOID too and move no
            // balance; without this a void split still credited the target.
            { parentStatus: savedTransaction.status },
            // Transfer-target and brokerage accounts this split touched, so their
            // net-worth state is invalidated after commit -- not only the parent
            // account (recheck RR5-002).
            splitAffectedAccountIds,
          );

          // Set split-level tags (and mirror them onto any transfer counterpart)
          if (savedSplits && splits) {
            await this.applySplitTags(savedSplits, splits, userId);
          }
        }

        // Set transaction-level tags
        if (tagIds && tagIds.length > 0) {
          await this.tagsService.setTransactionTags(
            savedTransaction.id,
            tagIds,
            userId,
          );
        }

        if (savedTransaction.status !== TransactionStatus.VOID) {
          if (isTransactionInFuture(createTransactionDto.transactionDate)) {
            await this.accountsService.recalculateCurrentBalance(
              userId,
              createTransactionDto.accountId,
            );
          } else {
            await this.accountsService.updateBalance(
              createTransactionDto.accountId,
              Number(createTransactionDto.amount),
            );
          }
        }

        return savedTransaction.id;
      },
    );

    this.netWorthService.triggerDebouncedRecalc(
      createTransactionDto.accountId,
      userId,
    );
    for (const affected of splitAffectedAccountIds) {
      if (affected !== createTransactionDto.accountId) {
        this.netWorthService.triggerDebouncedRecalc(affected, userId);
      }
    }

    const result = await this.findOne(userId, savedTransactionId);
    this.recordTransactionAction(userId, result, "create");
    return result;
  }

  /**
   * Create many cash transactions in one go for the "paste a table" bulk
   * approval flow. Best-effort: each row is created through the single-row
   * `create()` (its own QueryRunner, atomic balance update, action history) so a
   * failing row is collected into `skipped` rather than aborting the batch. The
   * per-row `createPayee` flag is forwarded so unmatched payee names are created
   * or stored as free text exactly as the user approved on the card.
   */
  async createBulk(
    userId: string,
    rows: Array<{ dto: CreateTransactionDto; createPayeeIfMissing: boolean }>,
  ): Promise<BulkCreateResult<Transaction>> {
    const created: Transaction[] = [];
    const skipped: BulkCreateSkip[] = [];
    for (let index = 0; index < rows.length; index++) {
      const { dto, createPayeeIfMissing } = rows[index];
      try {
        created.push(await this.create(userId, dto, { createPayeeIfMissing }));
      } catch (error) {
        skipped.push({ index, reason: bulkSkipReason(error) });
        this.logger.warn(
          `Bulk transaction row ${index} skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return { created, skipped };
  }

  /**
   * Validate and resolve a proposed transaction WITHOUT persisting it. Used by
   * the MCP `create_transaction` dry-run and the AI Assistant confirmation
   * flow. Validates account + category ownership and sanitizes user strings so
   * the returned preview is exactly what `create()` would persist.
   */
  async previewCreate(
    userId: string,
    input: {
      accountId: string;
      amount: number;
      transactionDate: string;
      payeeName?: string;
      categoryId?: string;
      description?: string;
      /** Auto-create a payee for an unmatched name. Defaults to true. */
      createPayeeIfMissing?: boolean;
    },
  ): Promise<CreateTransactionPreview> {
    const account = await this.accountsService.findOne(userId, input.accountId);

    let categoryId: string | null = input.categoryId ?? null;
    let categoryName: string | null = null;
    if (categoryId) {
      const requestedCategoryId = categoryId;
      const cat = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: requestedCategoryId, userId },
        }),
      );
      if (!cat) {
        throw new NotFoundException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
      categoryName = cat.name;
    }

    // Resolve the payee name to an existing payee so the created transaction
    // links to the payee record instead of recording a detached free-text name.
    // When nothing matches, payeeId stays null and the caller can offer to
    // create the payee.
    const inputPayeeName = stripHtml(input.payeeName) || null;
    let payeeId: string | null = null;
    let payeeName: string | null = inputPayeeName;
    let payeeMatched = false;
    if (inputPayeeName) {
      const payee = await this.payeesService.resolveByName(
        userId,
        inputPayeeName,
      );
      if (payee) {
        payeeId = payee.id;
        payeeMatched = true;
        // Use the matched payee's canonical name so the transaction links
        // cleanly and the preview shows which payee the name resolved to
        // (e.g. "Buon Gusto" -> "Buon Gusto Restaurant").
        payeeName = payee.name;
        // Mirror create(): when the caller gave no category, adopt the matched
        // payee's default so the preview equals what create() will persist.
        if (!categoryId && payee.defaultCategoryId) {
          categoryId = payee.defaultCategoryId;
          categoryName = payee.defaultCategory?.name ?? null;
        }
      }
    }

    // An unmatched name becomes a new payee on confirm unless the caller
    // explicitly opted out (createPayeeIfMissing === false), in which case it is
    // recorded as a free-text name.
    const payeeWillBeCreated =
      !!payeeName && !payeeMatched && input.createPayeeIfMissing !== false;

    return {
      accountId: input.accountId,
      accountName: account.name,
      amount: input.amount,
      transactionDate: input.transactionDate,
      payeeId,
      payeeName,
      payeeMatched,
      payeeWillBeCreated,
      categoryId,
      categoryName,
      description: stripHtml(input.description) || null,
      currencyCode: account.currencyCode,
    };
  }

  /**
   * Validate and resolve a proposed re-categorization WITHOUT persisting it.
   * Confirms ownership of both the transaction and the target category and
   * returns a preview (payee/amount/date plus current and new category names).
   */
  async previewCategorize(
    userId: string,
    transactionId: string,
    categoryId: string,
  ): Promise<CategorizeTransactionPreview> {
    const transaction = await this.findOne(userId, transactionId);
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

    return {
      transactionId,
      payeeName: transaction.payeeName ?? null,
      amount: Number(transaction.amount),
      transactionDate: transaction.transactionDate,
      accountName: transaction.account?.name ?? null,
      currentCategoryName: transaction.category?.name ?? null,
      categoryId,
      newCategoryName: cat.name,
    };
  }

  /**
   * Validate and resolve a proposed edit to an existing transaction WITHOUT
   * persisting it. Only the provided fields change; every other field is kept
   * from the stored transaction so the returned preview is the exact resulting
   * state `update()` will write. Validates account ownership implicitly (the
   * transaction is loaded by owner), validates a changed category, and resolves
   * a changed payee name to an existing payee exactly like `previewCreate`.
   *
   * Transfers are still rejected here: their linked legs need the dedicated
   * edit flow. Split transactions are editable per Truth table B in
   * docs/future-plans/split-bulk-update.md: parent fields (payee, date,
   * description) change freely, and a category or amount change is allowed
   * only when a complete replacement splits array accompanies the edit
   * (`splitsAccompany`), because a split parent's categories live on its lines
   * and its amount must equal their sum (invariant I1).
   */
  async previewUpdate(
    userId: string,
    transactionId: string,
    input: {
      amount?: number;
      transactionDate?: string;
      payeeName?: string;
      categoryId?: string;
      description?: string;
      /** Auto-create a payee for an unmatched name. Defaults to true. */
      createPayeeIfMissing?: boolean;
      /**
       * True when the caller sends a complete replacement splits array with
       * this edit (the splits themselves are resolved and validated by the
       * caller against the preview's amount). Gates category/amount changes on
       * an existing split and counts as a change on its own.
       */
      splitsAccompany?: boolean;
    },
  ): Promise<UpdateTransactionPreview> {
    const existing = await this.findOne(userId, transactionId);

    if (existing.isTransfer) {
      throw new BadRequestException(
        tr(
          "errors.transactions.cannotEditTransfer",
          "Transfers can't be edited here. Edit the transfer from the Transactions screen.",
        ),
      );
    }
    if (existing.isSplit && !input.splitsAccompany) {
      if (input.categoryId !== undefined) {
        throw new BadRequestException(
          tr(
            "errors.transactions.splitCategoryNeedsSplits",
            "This is a split transaction: its categories live on its split lines, not on the parent. Read the transaction's current split lines first, then resend the update with the complete splits array (every line: categoryName, amount, optional memo) with the category change applied.",
          ),
        );
      }
      if (input.amount !== undefined) {
        throw new BadRequestException(
          tr(
            "errors.transactions.splitAmountNeedsSplits",
            "This is a split transaction: its amount must equal the sum of its split lines. Resend the update with both the new amount and the complete splits array (every line: categoryName, amount, optional memo) summing to it.",
          ),
        );
      }
    }

    const hasChange =
      input.amount !== undefined ||
      input.transactionDate !== undefined ||
      input.payeeName !== undefined ||
      input.categoryId !== undefined ||
      input.description !== undefined ||
      // A splits-only replacement changes the transaction even though no
      // scalar field does.
      input.splitsAccompany === true;
    if (!hasChange) {
      throw new BadRequestException(
        tr(
          "errors.transactions.noUpdateFields",
          "Provide at least one field to change.",
        ),
      );
    }

    const amount = input.amount ?? Number(existing.amount);
    const transactionDate = input.transactionDate ?? existing.transactionDate;
    const description =
      input.description !== undefined
        ? stripHtml(input.description) || null
        : (existing.description ?? null);

    // Category: validate ownership of a changed category; otherwise keep the
    // transaction's existing category.
    let categoryId: string | null = existing.categoryId ?? null;
    let categoryName: string | null = existing.category?.name ?? null;
    if (input.categoryId !== undefined) {
      const cat = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: input.categoryId, userId },
        }),
      );
      if (!cat) {
        throw new NotFoundException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
      categoryId = cat.id;
      categoryName = cat.name;
    }

    // Payee: when a new name is given, resolve it to an existing payee (matching
    // create()/previewCreate); an unmatched name becomes a new payee on confirm
    // unless the caller opted out. When no new name is given, keep the existing
    // payee link.
    let payeeId: string | null = existing.payeeId ?? null;
    let payeeName: string | null = existing.payeeName ?? null;
    let payeeMatched = !!existing.payeeId;
    let payeeWillBeCreated = false;
    if (input.payeeName !== undefined) {
      const inputPayeeName = stripHtml(input.payeeName) || null;
      payeeId = null;
      payeeName = inputPayeeName;
      payeeMatched = false;
      if (inputPayeeName) {
        const payee = await this.payeesService.resolveByName(
          userId,
          inputPayeeName,
        );
        if (payee) {
          payeeId = payee.id;
          payeeMatched = true;
          payeeName = payee.name;
        }
      }
      payeeWillBeCreated =
        !!payeeName && !payeeMatched && input.createPayeeIfMissing !== false;
    }

    return {
      transactionId,
      accountId: existing.accountId,
      accountName: existing.account?.name ?? "",
      amount,
      transactionDate,
      payeeId,
      payeeName,
      payeeMatched,
      payeeWillBeCreated,
      categoryId,
      categoryName,
      description,
      currencyCode: existing.currencyCode,
      isReconciled: existing.isReconciled,
    };
  }

  /**
   * Validate ownership of a transaction the assistant proposes to delete and
   * return a display-only preview of what will be removed. The actual deletion
   * (including any transfer/split side effects) is handled by `remove()`.
   */
  async previewDelete(
    userId: string,
    transactionId: string,
  ): Promise<DeleteTransactionPreview> {
    const existing = await this.findOne(userId, transactionId);
    return {
      transactionId,
      accountName: existing.account?.name ?? "",
      amount: Number(existing.amount),
      transactionDate: existing.transactionDate,
      payeeName: existing.payeeName ?? null,
      categoryName: existing.category?.name ?? null,
      description: existing.description ?? null,
      currencyCode: existing.currencyCode,
      isReconciled: existing.isReconciled,
    };
  }

  async getRecent(
    userId: string,
    limit = 5,
    filter?: { payeeId?: string; payeeName?: string },
  ): Promise<Transaction[]> {
    const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
    const isPayeeFiltered = !!(filter?.payeeId || filter?.payeeName);
    // For payee-scoped requests, raw last-N is what's wanted: same payee, just
    // different historical entries. For the unfiltered case we pull a 6x window
    // so dedup can still yield safeLimit distinct rows.
    const window = isPayeeFiltered ? safeLimit : safeLimit * 6;

    // Excludes transfers (those are handled by their own form mode). Splits
    // ARE included so a user can quick-fill a recurring split entry.
    const where: Record<string, unknown> = { userId, isTransfer: false };
    if (filter?.payeeId) {
      where.payeeId = filter.payeeId;
    } else if (filter?.payeeName) {
      where.payeeName = filter.payeeName;
    }

    const rows = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Transaction).find({
        where,
        order: { transactionDate: "DESC", createdAt: "DESC" },
        take: window,
        relations: [
          "payee",
          "category",
          "account",
          "tags",
          "splits",
          "splits.category",
          "splits.transferAccount",
          "splits.tags",
          "splits.investmentTransaction",
          "splits.investmentTransaction.security",
        ],
      }),
    );

    if (isPayeeFiltered) {
      return rows.slice(0, safeLimit);
    }

    // Split parents have categoryId=null (categories live on the splits), so
    // the dedup key `payeeId|categoryId` collapses to one row per payee for
    // splits, and to one row per (payee, category) pair for normals.
    const seen = new Set<string>();
    const result: Transaction[] = [];
    for (const row of rows) {
      const payeeKey = row.payeeId ?? row.payeeName ?? "";
      const key = `${payeeKey}|${row.categoryId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(row);
      if (result.length >= safeLimit) break;
    }
    return result;
  }

  /**
   * The register read scope (joint-accounts spec): the user's own rows plus
   * rows in accounts jointly shared to them -- `jointAccountIds` is the
   * already-authorized joint set computed by the controller, never raw
   * request input. One definition on purpose: the same predicate must gate
   * the listing, the target-page count and the filtered balance sums, or a
   * page could sum rows it does not show. Empty joint set = exactly the old
   * owner-only predicate, so non-joint traffic is untouched.
   */
  private registerScope(
    alias: string,
    userId: string,
    jointAccountIds: string[],
  ): Brackets {
    return new Brackets((qb) => {
      qb.where(`${alias}.userId = :registerScopeUserId`, {
        registerScopeUserId: userId,
      });
      if (jointAccountIds.length > 0) {
        qb.orWhere(`${alias}.accountId IN (:...registerScopeJointIds)`, {
          registerScopeJointIds: jointAccountIds,
        });
      }
    });
  }

  async findAll(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    page: number = 1,
    limit: number = 50,
    includeInvestmentBrokerage: boolean = false,
    search?: string,
    targetTransactionId?: string,
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
    statuses?: TransactionStatus[],
    sortBy: "date" | "amount" | "payee" = "date",
    sortDirection: "ASC" | "DESC" = "DESC",
    tagKeyFilter?: TagKeyFilter,
    originalCurrencyCodes?: string[],
    hasAttachments?: boolean,
    jointAccountIds: string[] = [],
  ): Promise<PaginatedTransactions> {
    const clamped = clampPagination(page, limit);
    const safeLimit = clamped.limit;
    let safePage = clamped.page;

    // Interpret the search term once (amount/date in the user's locale format)
    // and thread it through the query, the target-page count, and the running
    // balance so all three match the same rows.
    const parsedSearch = await this.resolveSearchTerm(userId, search);

    // The whole listing -- main query, target-page lookup, running-balance
    // math, and investment/attachment enrichment -- is one read block on a
    // single withScopedDb manager.
    return withScopedDb(this.dataSource, async (m) => {
      const queryBuilder = m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .leftJoinAndSelect("transaction.account", "account")
        .leftJoinAndSelect("transaction.payee", "payee")
        .leftJoinAndSelect("transaction.category", "category")
        .leftJoinAndSelect("transaction.tags", "tags")
        .leftJoinAndSelect("transaction.splits", "splits")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
        .leftJoinAndSelect("splits.tags", "splitTags")
        .leftJoinAndSelect("splits.investmentTransaction", "splitInvestmentTx")
        .leftJoinAndSelect(
          "splitInvestmentTx.security",
          "splitInvestmentSecurity",
        )
        .leftJoinAndSelect("transaction.linkedTransaction", "linkedTransaction")
        .leftJoinAndSelect("linkedTransaction.account", "linkedAccount")
        .leftJoinAndSelect("linkedTransaction.splits", "linkedSplits")
        .leftJoinAndSelect("linkedSplits.category", "linkedSplitCategory")
        .leftJoinAndSelect(
          "linkedSplits.transferAccount",
          "linkedSplitTransferAccount",
        )
        .where(this.registerScope("transaction", userId, jointAccountIds));
      applyRegisterOrder(
        queryBuilder,
        "transaction",
        sortDirection,
        sortBy === "amount"
          ? "amount"
          : sortBy === "payee"
            ? "payeeName"
            : "transactionDate",
      );

      if (!includeInvestmentBrokerage) {
        queryBuilder.andWhere(brokerageExclusionForEntity("account"));
      }

      if (accountIds && accountIds.length > 0) {
        queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
          accountIds,
        });
      }

      if (startDate) {
        queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
          startDate,
        });
      }

      if (endDate) {
        queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
          endDate,
        });
      }

      if (categoryIds && categoryIds.length > 0) {
        await this.applyCategoryFilters(m, queryBuilder, categoryIds, userId);
      }

      if (payeeIds && payeeIds.length > 0) {
        queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
          payeeIds,
        });
      }

      if (search && search.trim()) {
        const searchPattern = `%${escapeLikePattern(search.trim())}%`;
        queryBuilder.andWhere(
          buildTransactionSearchClause({
            transaction: "transaction",
            splits: "splits",
          }),
          {
            search: searchPattern,
            searchAmount: parsedSearch.amount,
            searchDate: parsedSearch.date,
          },
        );
      }

      if (amountFrom !== undefined) {
        queryBuilder.andWhere("transaction.amount >= :amountFrom", {
          amountFrom,
        });
      }

      if (amountTo !== undefined) {
        queryBuilder.andWhere("transaction.amount <= :amountTo", { amountTo });
      }

      if (tagIds && tagIds.length > 0) {
        queryBuilder.leftJoin("transaction.tags", "filterTags");
        queryBuilder.leftJoin("splits.tags", "filterSplitTags");
        queryBuilder.andWhere(
          new Brackets((qb) => {
            qb.where("filterTags.id IN (:...filterTagIds)", {
              filterTagIds: tagIds,
            }).orWhere("filterSplitTags.id IN (:...filterTagIds)", {
              filterTagIds: tagIds,
            });
          }),
        );
      }

      if (tagKeyFilter) {
        const { clause, params } = buildTagKeyFilterClause(
          "transaction",
          tagKeyFilter,
        );
        queryBuilder.andWhere(clause, params);
      }

      if (statuses && statuses.length > 0) {
        queryBuilder.andWhere("transaction.status IN (:...statuses)", {
          statuses,
        });
      }

      if (originalCurrencyCodes && originalCurrencyCodes.length > 0) {
        queryBuilder.andWhere(
          "transaction.original_currency_code IN (:...originalCurrencyCodes)",
          { originalCurrencyCodes },
        );
      }

      // Attachment presence filter. An EXISTS subquery against the separate
      // transaction_attachments table keeps this out of the heavily-joined main
      // query, so it never multiplies rows or corrupts pagination.
      if (hasAttachments !== undefined) {
        // Primaries only: a scan pair's hidden original is not an attachment
        // the user has, so "no attachments" must not be false because one is
        // stored behind the row they deleted the visible half of.
        const existsSubquery =
          `SELECT 1 FROM transaction_attachments ta WHERE ta.transaction_id = transaction.id ` +
          `AND ${primaryAttachmentSql("ta")}`;
        queryBuilder.andWhere(
          hasAttachments
            ? `EXISTS (${existsSubquery})`
            : `NOT EXISTS (${existsSubquery})`,
        );
      }

      if (targetTransactionId) {
        safePage = await this.calculateTargetPage(
          m,
          userId,
          targetTransactionId,
          safeLimit,
          accountIds,
          startDate,
          endDate,
          payeeIds,
          search,
          includeInvestmentBrokerage,
          safePage,
          parsedSearch,
          jointAccountIds,
        );
      }

      const skip = (safePage - 1) * safeLimit;

      const [data, total] = await queryBuilder
        .skip(skip)
        .take(safeLimit)
        .getManyAndCount();

      let startingBalance: number | undefined;
      const singleAccountId =
        accountIds?.length === 1 ? accountIds[0] : undefined;
      const hasContentFilters = !!(
        (categoryIds && categoryIds.length > 0) ||
        (payeeIds && payeeIds.length > 0) ||
        (tagIds && tagIds.length > 0) ||
        search ||
        amountFrom !== undefined ||
        amountTo !== undefined
      );
      if (singleAccountId && data.length > 0) {
        startingBalance = await this.calculateStartingBalance(
          m,
          userId,
          singleAccountId,
          safePage,
          skip,
          {
            startDate,
            endDate,
            categoryIds,
            payeeIds,
            tagIds,
            search,
            searchAmount: parsedSearch.amount,
            searchDate: parsedSearch.date,
            amountFrom,
            amountTo,
          },
        );
      } else if (
        accountIds &&
        accountIds.length > 1 &&
        hasContentFilters &&
        data.length > 0
      ) {
        startingBalance =
          await this.calculateMultiAccountContentFilteredBalance(
            m,
            userId,
            accountIds,
            safePage,
            skip,
            {
              startDate,
              endDate,
              categoryIds,
              payeeIds,
              tagIds,
              search,
              searchAmount: parsedSearch.amount,
              searchDate: parsedSearch.date,
              amountFrom,
              amountTo,
            },
            jointAccountIds,
          );
      } else if (
        (!accountIds || accountIds.length === 0) &&
        hasContentFilters &&
        data.length > 0
      ) {
        startingBalance =
          await this.calculateMultiAccountContentFilteredBalance(
            m,
            userId,
            undefined,
            safePage,
            skip,
            {
              startDate,
              endDate,
              categoryIds,
              payeeIds,
              tagIds,
              search,
              searchAmount: parsedSearch.amount,
              searchDate: parsedSearch.date,
              amountFrom,
              amountTo,
            },
            jointAccountIds,
          );
      }

      const enrichedData = await this.enrichWithInvestmentLinks(m, data);

      return {
        data: enrichedData,
        pagination: buildPaginationMeta(safePage, safeLimit, total),
        startingBalance,
      };
    });
  }

  private async applyCategoryFilters(
    m: EntityManager,
    queryBuilder: any,
    categoryIds: string[],
    userId: string,
  ): Promise<void> {
    const hasUncategorized = categoryIds.includes("uncategorized");
    const hasTransfer = categoryIds.includes("transfer");
    const regularCategoryIds = categoryIds.filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );

    let hasCondition = false;

    if (hasUncategorized || hasTransfer || regularCategoryIds.length > 0) {
      const uniqueCategoryIds =
        regularCategoryIds.length > 0
          ? await getAllCategoryIdsWithChildren(
              m.getRepository(Category),
              userId,
              regularCategoryIds,
            )
          : [];

      queryBuilder.andWhere(
        new Brackets((qb) => {
          if (hasUncategorized) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              new Brackets((unc) => {
                unc
                  .where(
                    `transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND ${investmentLinkedTransactionExclusion(
                      "transaction",
                    )}`,
                  )
                  // A split transaction is uncategorised when any of its
                  // non-transfer split lines has no category. Match those too so
                  // the list agrees with the account-detail category breakdown,
                  // which buckets uncategorised split lines the same way. Only
                  // the matching (null-category) splits hydrate, giving the
                  // frontend a filtered partial total.
                  .orWhere(
                    `transaction.isSplit = true AND transaction.isTransfer = false AND splits.categoryId IS NULL AND splits.transferAccountId IS NULL AND ${investmentLinkedSplitExclusion(
                      "splits",
                    )}`,
                  );
              }),
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
            // Filter on the main "splits" alias so that only matching split
            // rows are hydrated.  Non-matching splits are excluded from the
            // response, which lets the frontend detect partial amounts and
            // display a filtered total.  The edit form fetches the full
            // transaction via getById, so it still sees all splits.
            qb[method](
              new Brackets((inner) => {
                inner
                  .where("transaction.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  })
                  .orWhere("splits.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  });
              }),
            );
          }
        }),
      );
    }
  }

  private async calculateTargetPage(
    m: EntityManager,
    userId: string,
    targetTransactionId: string,
    safeLimit: number,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    payeeIds?: string[],
    search?: string,
    includeInvestmentBrokerage?: boolean,
    fallbackPage: number = 1,
    parsedSearch: ParsedSearchTerm = { amount: null, date: null },
    jointAccountIds: string[] = [],
  ): Promise<number> {
    try {
      const targetTx = await m.getRepository(Transaction).findOne({
        // Own row, or a row in an authorized joint account (same scope as
        // the listing this page number is computed against).
        where: [
          { id: targetTransactionId, userId },
          ...(jointAccountIds.length > 0
            ? [{ id: targetTransactionId, accountId: In(jointAccountIds) }]
            : []),
        ],
        select: ["id", "transactionDate", "createdAt"],
      });

      if (!targetTx) return fallbackPage;

      const countQuery = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "a")
        .leftJoin("t.splits", "s")
        .where(this.registerScope("t", userId, jointAccountIds));

      if (!includeInvestmentBrokerage) {
        countQuery.andWhere(brokerageExclusionForEntity("a"));
      }
      if (accountIds && accountIds.length > 0) {
        countQuery.andWhere("t.accountId IN (:...accountIds)", { accountIds });
      }
      if (startDate) {
        countQuery.andWhere("t.transactionDate >= :startDate", { startDate });
      }
      if (endDate) {
        countQuery.andWhere("t.transactionDate <= :endDate", { endDate });
      }
      if (payeeIds && payeeIds.length > 0) {
        countQuery.andWhere("t.payeeId IN (:...payeeIds)", { payeeIds });
      }
      if (search && search.trim()) {
        const searchPattern = `%${escapeLikePattern(search.trim())}%`;
        countQuery.andWhere(
          buildTransactionSearchClause({ transaction: "t", splits: "s" }),
          {
            search: searchPattern,
            searchAmount: parsedSearch.amount,
            searchDate: parsedSearch.date,
          },
        );
      }

      countQuery.andWhere(
        `(t.transactionDate > :targetDate
          OR (t.transactionDate = :targetDate AND t.createdAt > :targetCreatedAt)
          OR (t.transactionDate = :targetDate AND t.createdAt = :targetCreatedAt AND t.id > :targetId))`,
        {
          targetDate: targetTx.transactionDate,
          targetCreatedAt: targetTx.createdAt,
          targetId: targetTx.id,
        },
      );

      const countBefore = await countQuery.getCount();
      return Math.floor(countBefore / safeLimit) + 1;
    } catch (error) {
      this.logger.error(
        "Failed to find target transaction page:",
        error instanceof Error ? error.stack : String(error),
      );
      return fallbackPage;
    }
  }

  private async calculateStartingBalance(
    m: EntityManager,
    userId: string,
    singleAccountId: string,
    safePage: number,
    skip: number,
    filters?: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      searchAmount?: number | null;
      searchDate?: string | null;
      amountFrom?: number;
      amountTo?: number;
    },
  ): Promise<number> {
    const hasContentFilters = !!(
      (filters?.categoryIds && filters.categoryIds.length > 0) ||
      (filters?.payeeIds && filters.payeeIds.length > 0) ||
      (filters?.tagIds && filters.tagIds.length > 0) ||
      filters?.search ||
      filters?.amountFrom !== undefined ||
      filters?.amountTo !== undefined
    );
    const hasDateFilter = !!(filters?.startDate || filters?.endDate);

    if (hasContentFilters) {
      return this.calculateContentFilteredBalance(
        m,
        userId,
        singleAccountId,
        safePage,
        skip,
        filters!,
      );
    }

    if (hasDateFilter) {
      return this.calculateDateFilteredBalance(
        m,
        userId,
        singleAccountId,
        safePage,
        skip,
        filters!,
      );
    }

    // No filters: original behavior
    return this.calculateUnfilteredBalance(
      m,
      userId,
      singleAccountId,
      safePage,
      skip,
    );
  }

  /**
   * Original unfiltered balance calculation. Returns projected balance
   * (current + future) adjusted for pagination.
   */
  private async calculateUnfilteredBalance(
    m: EntityManager,
    userId: string,
    singleAccountId: string,
    safePage: number,
    skip: number,
  ): Promise<number> {
    const projectedBalance = await this.computeProjectedBalance(
      userId,
      singleAccountId,
    );

    if (safePage === 1) {
      return projectedBalance;
    }

    const previousPagesQuery = m
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :singleAccountId", { singleAccountId })
      .limit(skip);
    // Must stay the register's own order: these rows are the pages above the
    // one being shown, and their sum is where its running balance starts.
    applyRegisterOrder(previousPagesQuery, "t", "DESC");

    // The window is every row the register lists above this page -- voids
    // included, because they occupy a line each. What is summed out of that
    // window is only what the projected balance counted in.
    const sumResult = await onlyBalanceAffecting(
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select("SUM(transaction.amount)", "sum")
        .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
        .setParameters(previousPagesQuery.getParameters()),
      "transaction",
    ).getRawOne();

    const sumBefore = Number(sumResult?.sum) || 0;
    return projectedBalance - sumBefore;
  }

  /**
   * Content-filtered balance: zero-based running balance.
   * startingBalance = totalSum of all matching transactions (page 1)
   * or totalSum - sumOfPreviousPages (page > 1).
   */
  private async calculateContentFilteredBalance(
    m: EntityManager,
    userId: string,
    accountId: string,
    safePage: number,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      m,
      userId,
      accountId,
      filters,
    );

    const totalSum = await this.computeSplitAwareSum(
      m,
      idsSubquery,
      userId,
      filters,
    );

    if (safePage === 1) return totalSum;

    return (
      totalSum -
      (await this.computeFilteredPrevPagesSum(
        m,
        userId,
        accountId,
        skip,
        filters,
      ))
    );
  }

  /**
   * Multi-account content-filtered balance: zero-based running balance
   * across multiple accounts when content filters are active.
   */
  private async calculateMultiAccountContentFilteredBalance(
    m: EntityManager,
    userId: string,
    accountIds: string[] | undefined,
    safePage: number,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      searchAmount?: number | null;
      searchDate?: string | null;
      amountFrom?: number;
      amountTo?: number;
    },
    jointAccountIds: string[] = [],
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      m,
      userId,
      accountIds,
      filters,
      jointAccountIds,
    );

    const totalSum = await this.computeSplitAwareSum(
      m,
      idsSubquery,
      userId,
      filters,
    );

    if (safePage === 1) return totalSum;

    return (
      totalSum -
      (await this.computeFilteredPrevPagesSum(
        m,
        userId,
        accountIds,
        skip,
        filters,
        jointAccountIds,
      ))
    );
  }

  /**
   * Date-filtered balance: shows actual account balance at the date range.
   * With endDate: balance at end of date range.
   * With only startDate: projected balance (same as unfiltered).
   * Adjusted for pagination within the filtered set.
   */
  private async calculateDateFilteredBalance(
    m: EntityManager,
    userId: string,
    accountId: string,
    safePage: number,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
    },
  ): Promise<number> {
    let baseBalance: number;

    if (filters.endDate) {
      // Balance at end of date range = projected - sum(tx after endDate)
      const projectedBalance = await this.computeProjectedBalance(
        userId,
        accountId,
      );

      const sumAfterResult = await onlyBalanceAffecting(
        m
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "sum")
          .where("t.userId = :userId", { userId })
          .andWhere("t.accountId = :accountId", { accountId })
          .andWhere("t.transactionDate > :endDate", {
            endDate: filters.endDate,
          }),
        "t",
      ).getRawOne();

      baseBalance = projectedBalance - (Number(sumAfterResult?.sum) || 0);
    } else {
      // Only startDate: top of list is still projected balance
      baseBalance = await this.computeProjectedBalance(userId, accountId);
    }

    if (safePage === 1) return baseBalance;

    // For page > 1, subtract sum of previous pages (within filtered set)
    const previousPagesQuery = m
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :accountId", { accountId })
      .limit(skip);
    // Must stay the register's own order: these rows are the pages above the
    // one being shown, and their sum is where its running balance starts.
    applyRegisterOrder(previousPagesQuery, "t", "DESC");

    if (filters.startDate) {
      previousPagesQuery.andWhere("t.transactionDate >= :startDate", {
        startDate: filters.startDate,
      });
    }
    if (filters.endDate) {
      previousPagesQuery.andWhere("t.transactionDate <= :endDate", {
        endDate: filters.endDate,
      });
    }

    const sumResult = await onlyBalanceAffecting(
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select("SUM(transaction.amount)", "sum")
        .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
        .setParameters(previousPagesQuery.getParameters()),
      "transaction",
    ).getRawOne();

    return baseBalance - (Number(sumResult?.sum) || 0);
  }

  /**
   * Thin delegate to AccountsService.getProjectedBalance -- kept here so the
   * paging helpers below stay readable. See that method for why balance is
   * derived live rather than from the stored currentBalance column.
   */
  private async computeProjectedBalance(
    userId: string,
    accountId: string,
  ): Promise<number> {
    return this.accountsService.getProjectedBalance(userId, accountId);
  }

  /**
   * Sum of filtered transactions on previous pages (for content-filtered pagination).
   */
  private async computeFilteredPrevPagesSum(
    m: EntityManager,
    userId: string,
    accountId: string | string[] | undefined,
    skip: number,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
    },
    jointAccountIds: string[] = [],
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      m,
      userId,
      accountId,
      filters,
      jointAccountIds,
    );

    // Get ordered matching transactions, limited to previous pages
    const prevIdsQuery = m
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("t.id")
      .where(`t.id IN (${idsSubquery.getQuery()})`)
      .setParameters(idsSubquery.getParameters())
      .limit(skip);
    // Must stay the register's own order: these rows are the pages above the
    // one being shown, and their sum is where its running balance starts.
    applyRegisterOrder(prevIdsQuery, "t", "DESC");

    return this.computeSplitAwareSum(m, prevIdsQuery, userId, filters);
  }

  /**
   * Compute a split-aware sum for a set of transaction IDs.
   *
   * When category or tag filters are active, splits are joined with the
   * same filter conditions used by findAll().  Non-matching split rows
   * are excluded, so COALESCE(splits.amount, t.amount) produces the
   * partial split sum for partially-matching split transactions and the
   * full t.amount for non-split transactions.
   */
  private async computeSplitAwareSum(
    m: EntityManager,
    idsSubquery: {
      getQuery: () => string;
      getParameters: () => Record<string, any>;
    },
    userId: string,
    filters: {
      categoryIds?: string[];
      tagIds?: string[];
    },
  ): Promise<number> {
    const regularCategoryIds = (filters.categoryIds ?? []).filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );
    const hasRegularCategories = regularCategoryIds.length > 0;
    const hasTags = (filters.tagIds?.length ?? 0) > 0;

    if (!hasRegularCategories && !hasTags) {
      const result = await onlyBalanceAffecting(
        m
          .getRepository(Transaction)
          .createQueryBuilder("sa")
          .select("COALESCE(SUM(sa.amount), 0)", "totalSum")
          .where(`sa.id IN (${idsSubquery.getQuery()})`)
          .setParameters(idsSubquery.getParameters()),
        "sa",
      ).getRawOne();
      return Number(result?.totalSum) || 0;
    }

    const sumQb = onlyBalanceAffecting(
      m
        .getRepository(Transaction)
        .createQueryBuilder("sa")
        .where(`sa.id IN (${idsSubquery.getQuery()})`)
        .setParameters(idsSubquery.getParameters()),
      "sa",
    );

    sumQb.leftJoin("sa.splits", "saSplits");

    if (hasRegularCategories) {
      const expandedIds = await getAllCategoryIdsWithChildren(
        m.getRepository(Category),
        userId,
        regularCategoryIds,
      );
      if (expandedIds.length > 0) {
        sumQb.andWhere(
          new Brackets((qb) => {
            qb.where("sa.categoryId IN (:...saCatIds)", {
              saCatIds: expandedIds,
            }).orWhere("saSplits.categoryId IN (:...saCatIds)");
          }),
        );
      }
    }

    if (hasTags) {
      sumQb.leftJoin("sa.tags", "saTags");
      sumQb.leftJoin("saSplits.tags", "saSplitTags");
      sumQb.andWhere(
        new Brackets((qb) => {
          qb.where("saTags.id IN (:...saTagIds)", {
            saTagIds: filters.tagIds,
          }).orWhere("saSplitTags.id IN (:...saTagIds)");
        }),
      );
    }

    sumQb.select(
      "COALESCE(SUM(COALESCE(saSplits.amount, sa.amount)), 0)",
      "totalSum",
    );
    const result = await sumQb.getRawOne();
    return Number(result?.totalSum) || 0;
  }

  /**
   * Build a subquery that returns DISTINCT transaction IDs matching
   * the given content/date filters for a single account.
   */
  private async buildFilteredIdsSubquery(
    m: EntityManager,
    userId: string,
    accountId: string | string[] | undefined,
    filters: {
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      searchAmount?: number | null;
      searchDate?: string | null;
      amountFrom?: number;
      amountTo?: number;
    },
    jointAccountIds: string[] = [],
  ) {
    const qb = m
      .getRepository(Transaction)
      .createQueryBuilder("bf")
      .select("DISTINCT bf.id")
      .where(
        new Brackets((scope) => {
          scope.where("bf.userId = :bfUserId", { bfUserId: userId });
          if (jointAccountIds.length > 0) {
            scope.orWhere("bf.accountId IN (:...bfJointIds)", {
              bfJointIds: jointAccountIds,
            });
          }
        }),
      );

    if (Array.isArray(accountId)) {
      qb.andWhere("bf.accountId IN (:...bfAccountIds)", {
        bfAccountIds: accountId,
      });
    } else if (accountId) {
      qb.andWhere("bf.accountId = :bfAccountId", { bfAccountId: accountId });
    }

    if (filters.startDate) {
      qb.andWhere("bf.transactionDate >= :bfStartDate", {
        bfStartDate: filters.startDate,
      });
    }
    if (filters.endDate) {
      qb.andWhere("bf.transactionDate <= :bfEndDate", {
        bfEndDate: filters.endDate,
      });
    }
    if (filters.payeeIds && filters.payeeIds.length > 0) {
      qb.andWhere("bf.payeeId IN (:...bfPayeeIds)", {
        bfPayeeIds: filters.payeeIds,
      });
    }
    if (filters.amountFrom !== undefined) {
      qb.andWhere("bf.amount >= :bfAmountFrom", {
        bfAmountFrom: filters.amountFrom,
      });
    }
    if (filters.amountTo !== undefined) {
      qb.andWhere("bf.amount <= :bfAmountTo", {
        bfAmountTo: filters.amountTo,
      });
    }

    // Determine if we need a splits join (shared across search/category/tag)
    const needsSplitsJoin = !!(
      filters.search ||
      (filters.categoryIds &&
        filters.categoryIds.some(
          (id) => id !== "uncategorized" && id !== "transfer",
        )) ||
      (filters.tagIds && filters.tagIds.length > 0)
    );

    if (needsSplitsJoin) {
      qb.leftJoin("bf.splits", "bfSplits");
    }

    if (filters.search) {
      const searchPattern = `%${escapeLikePattern(filters.search.trim())}%`;
      qb.andWhere(
        buildTransactionSearchClause({
          transaction: "bf",
          splits: "bfSplits",
          paramName: "bfSearch",
        }),
        {
          bfSearch: searchPattern,
          bfSearchAmount: filters.searchAmount ?? null,
          bfSearchDate: filters.searchDate ?? null,
        },
      );
    }

    if (filters.categoryIds && filters.categoryIds.length > 0) {
      const hasUncategorized = filters.categoryIds.includes("uncategorized");
      const hasTransfer = filters.categoryIds.includes("transfer");
      const regularIds = filters.categoryIds.filter(
        (id) => id !== "uncategorized" && id !== "transfer",
      );

      const expandedIds =
        regularIds.length > 0
          ? await getAllCategoryIdsWithChildren(
              m.getRepository(Category),
              userId,
              regularIds,
            )
          : [];

      qb.andWhere(
        new Brackets((outer) => {
          let hasCondition = false;
          if (hasUncategorized) {
            // A trade's cash leg is not a row the user forgot to file, so the
            // running balance must not sum a row the list above it does not
            // show. This arm is NOT otherwise identical to the list's: the list
            // also matches a split parent with an uncategorized child, and this
            // one does not, so such a parent is missing from the prior-page sum
            // (pre-existing, and not fixable by copying the branch --
            // `computeSplitAwareSum` adds the WHOLE parent amount for a
            // pure-uncategorized filter, which would be wrong in the other
            // direction).
            outer.where(
              `bf.categoryId IS NULL AND bf.isSplit = false AND bf.isTransfer = false AND ${investmentLinkedTransactionExclusion(
                "bf",
              )}`,
            );
            hasCondition = true;
          }
          if (hasTransfer) {
            const method = hasCondition ? "orWhere" : "where";
            outer[method]("bf.isTransfer = true");
            hasCondition = true;
          }
          if (expandedIds.length > 0) {
            const method = hasCondition ? "orWhere" : "where";
            outer[method](
              new Brackets((inner) => {
                inner
                  .where("bf.categoryId IN (:...bfCatIds)", {
                    bfCatIds: expandedIds,
                  })
                  .orWhere("bfSplits.categoryId IN (:...bfCatIds)");
              }),
            );
          }
        }),
      );
    }

    if (filters.tagIds && filters.tagIds.length > 0) {
      qb.leftJoin("bf.tags", "bfTags");
      qb.leftJoin("bfSplits.tags", "bfSplitTags");
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where("bfTags.id IN (:...bfTagIds)", {
              bfTagIds: filters.tagIds,
            })
            .orWhere("bfSplitTags.id IN (:...bfTagIds)");
        }),
      );
    }

    return qb;
  }

  private async enrichWithInvestmentLinks(
    m: EntityManager,
    data: Transaction[],
  ): Promise<TransactionWithInvestmentLink[]> {
    const transactionIds = data.map((tx) => tx.id);
    const investmentLinkMap = new Map<string, string>();
    const attachmentCountMap = new Map<string, number>();

    if (transactionIds.length > 0) {
      // includes VOID rows: records read -- the register links a VOID cash
      // leg to its investment row exactly as an active one.
      const linkedInvestmentTxs = await m
        .getRepository(InvestmentTransaction)
        .find({
          where: { transactionId: In(transactionIds) },
          select: ["id", "transactionId"],
        });

      for (const invTx of linkedInvestmentTxs) {
        if (invTx.transactionId) {
          investmentLinkMap.set(invTx.transactionId, invTx.id);
        }
      }

      // One grouped count over the current page's ids (index-backed by
      // idx on transaction_id); avoids an N+1 and keeps the blob-free
      // attachments table off the main query.
      const attachmentCounts = await m
        .getRepository(TransactionAttachment)
        .createQueryBuilder("ta")
        .select("ta.transactionId", "transactionId")
        .addSelect("COUNT(*)", "count")
        .where("ta.transactionId IN (:...transactionIds)", { transactionIds })
        // A scan pair counts once: the register's paperclip is a count of what
        // the attachments list shows, and that list hides originals.
        .andWhere(primaryAttachmentSql("ta"))
        .groupBy("ta.transactionId")
        .getRawMany<{ transactionId: string; count: string }>();

      for (const row of attachmentCounts) {
        attachmentCountMap.set(row.transactionId, Number(row.count));
      }
    }

    return data.map((tx) => ({
      ...tx,
      isCleared: tx.isCleared,
      isReconciled: tx.isReconciled,
      isVoid: tx.isVoid,
      linkedInvestmentTransactionId: investmentLinkMap.get(tx.id) || null,
      attachmentCount: attachmentCountMap.get(tx.id) ?? 0,
    }));
  }

  async findOne(
    userId: string,
    id: string,
    jointAccountIds: string[] = [],
  ): Promise<Transaction> {
    const transaction = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Transaction).findOne({
        // Own row, or a row in an account jointly shared to the caller --
        // `jointAccountIds` is the controller's already-authorized set,
        // never raw request input. Empty for every non-joint caller.
        where: [
          { id, userId },
          ...(jointAccountIds.length > 0
            ? [{ id, accountId: In(jointAccountIds) }]
            : []),
        ],
        relations: [
          "account",
          "payee",
          "category",
          "tags",
          "splits",
          "splits.category",
          "splits.transferAccount",
          "splits.tags",
          "splits.investmentTransaction",
          "splits.investmentTransaction.security",
          "linkedTransaction",
          "linkedTransaction.account",
        ],
      }),
    );

    if (!transaction) {
      throw new NotFoundException(
        tr(
          "errors.transactions.notFoundById",
          `Transaction with ID ${id} not found`,
          { id },
        ),
      );
    }

    return transaction;
  }

  async update(
    userId: string,
    id: string,
    updateTransactionDto: UpdateTransactionDto,
    options?: { createPayeeIfMissing?: boolean },
  ): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    const beforeSnapshot = this.snapshotTransaction(transaction);
    const oldAccountId = transaction.accountId;
    // Accounts touched by split-transfer counterpart propagation, reported by the
    // helper because this method cannot know them in advance. The authoritative
    // old amount/date/status are read from the locked row inside the transaction
    // below (audit P4-003), not from this pre-lock snapshot.
    const counterpartAccountIds = new Set<string>();

    const { splits, tagIds, createdAt, ...updateData } = updateTransactionDto;

    // The account the row will belong to after this update, which is what its
    // primary currency must match. Loaded here so the currency assertion and the
    // foreign-entry normalization below both read the real account rather than
    // the row's own (possibly wrong) currencyCode.
    const effectiveAccount =
      updateData.accountId && updateData.accountId !== oldAccountId
        ? await this.accountsService.findOne(userId, updateData.accountId)
        : await this.accountsService.findOne(userId, oldAccountId);
    const effectiveAccountCurrency = assertTransactionCurrencyMatchesAccount(
      "currencyCode" in updateData ? updateData.currencyCode : undefined,
      effectiveAccount.currencyCode,
    );

    // Validate ownership of referenced payee and category. When the caller opts
    // in (createPayeeIfMissing) and only a free-text name was given, find or
    // create a reusable payee from that name so the transaction links to a
    // payee record -- mirroring create().
    if (updateData.payeeId) {
      await this.payeesService.findOne(userId, updateData.payeeId);
    } else if (
      options?.createPayeeIfMissing &&
      typeof updateData.payeeName === "string" &&
      updateData.payeeName.trim().length > 0
    ) {
      const payee = await this.payeesService.findOrCreate(
        userId,
        updateData.payeeName.trim(),
      );
      updateData.payeeId = payee.id;
      updateData.payeeName = payee.name;
    }
    // Provider rate lookups for cross-currency transfer children happen out
    // here, before the transaction opens; see prewarmSplitTransferRates.
    if (Array.isArray(splits) && splits.length > 0) {
      await this.splitService.prewarmSplitTransferRates(
        userId,
        splits,
        effectiveAccount.id,
        updateData.transactionDate ?? transaction.transactionDate,
      );
    }

    if ("categoryId" in updateData && updateData.categoryId) {
      const cat = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: updateData.categoryId, userId },
        }),
      );
      if (!cat) {
        throw new NotFoundException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
    }

    // Validate splits before starting the transaction
    if (splits !== undefined && Array.isArray(splits) && splits.length > 0) {
      const amount = updateData.amount ?? transaction.amount;
      this.splitService.validateSplits(splits, amount);
    }

    // One transaction: split rebuild, field update, tags, and balance
    // adjustments commit or roll back together. Nested service calls join it.
    await withScopedDb(this.dataSource, async (m) => {
      // The values a balance delta reverses are read HERE, under a row lock,
      // not from the snapshot `findOne` above returned.
      //
      // That snapshot is a claim that nothing changed in between, and two
      // concurrent updates each held it: PostgreSQL serialized the row writes,
      // but the second request never refreshed its "old amount" after waiting,
      // so it reversed an amount the first had already replaced. Opening
      // balance 100.00, one -10.00 row, A updates it to -20.00 and B to -30.00:
      // the ledger ends at -30.00 while the stored balance says 60.00 instead
      // of 70.00 (audit P4-003).
      const locked = await lockTransactionRow(m, id, userId);
      if (!locked) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${id} not found`,
            { id },
          ),
        );
      }
      // Strict reconciled lock, against the LOCKED row and before any write:
      // an edit refused here must not already have happened.
      await assertReconciledRowsMutable(m, userId, [locked]);

      const oldAmount = locked.amount;
      const oldLockedAccountId = locked.accountId;
      const oldTransactionDate = locked.transactionDate;
      const wasVoid = locked.status === TransactionStatus.VOID;

      if (splits !== undefined) {
        if (Array.isArray(splits) && splits.length > 0) {
          // Re-validate against the amount the locked row holds. The check above
          // ran on the pre-transaction snapshot, which is an early rejection and
          // not an authoritative one: a request that only replaces the splits
          // takes its parent amount from that snapshot, so a concurrent amount
          // edit that committed while this one waited for the row lock would let
          // a split set through that does not sum to the parent it is attached
          // to (audit FV4-002).
          this.splitService.validateSplits(
            splits,
            updateData.amount ?? locked.amount,
          );

          // Both the delete of the old counterparts and the create of the new
          // ones touch accounts the parent never named; route them into the
          // set this method already invalidates after commit (recheck RR5-002).
          for (const acc of await this.splitService.deleteSplitSideEffects(
            id,
            userId,
          )) {
            counterpartAccountIds.add(acc);
          }
          await m.delete(TransactionSplit, {
            transactionId: id,
          });

          // Fallbacks come off the locked row, never the caller's snapshot: the
          // counterpart and embedded investment rows describe the parent's
          // account, date and payee, so a stale fallback writes rows describing a
          // parent that has already moved.
          const accountId = updateData.accountId ?? locked.accountId;
          const txDate = updateData.transactionDate ?? locked.transactionDate;
          const savedSplits = await this.splitService.createSplits(
            id,
            splits,
            userId,
            accountId,
            new Date(txDate),
            updateData.payeeName ?? locked.payeeName,
            updateData.payeeId ?? locked.payeeId,
            // Same rule on the update path: the counterpart follows the status
            // the parent will have after this edit. Read from the locked row,
            // not the pre-lock snapshot (P5-001).
            {
              parentStatus:
                (updateData.status as TransactionStatus | undefined) ??
                ((locked.status ?? undefined) as TransactionStatus | undefined),
            },
            counterpartAccountIds,
          );

          // Set split-level tags (and mirror them onto any transfer counterpart)
          if (savedSplits) {
            await this.applySplitTags(savedSplits, splits, userId);
          }
        } else if (Array.isArray(splits) && splits.length === 0) {
          for (const acc of await this.splitService.deleteSplitSideEffects(
            id,
            userId,
          )) {
            counterpartAccountIds.add(acc);
          }
          await m.delete(TransactionSplit, {
            transactionId: id,
          });
          await m.update(Transaction, id, {
            isSplit: false,
          });
        }
      }

      const transactionUpdateData: Partial<Transaction> = {};

      if ("accountId" in updateData)
        transactionUpdateData.accountId = updateData.accountId;
      if ("transactionDate" in updateData)
        transactionUpdateData.transactionDate =
          updateData.transactionDate as any;
      if ("payeeId" in updateData)
        transactionUpdateData.payeeId = updateData.payeeId ?? null;
      if ("payeeName" in updateData)
        transactionUpdateData.payeeName = updateData.payeeName ?? null;
      if ("categoryId" in updateData)
        transactionUpdateData.categoryId = updateData.categoryId ?? null;
      if ("amount" in updateData)
        transactionUpdateData.amount = updateData.amount;
      // Always the account's, whether or not the request mentioned it: moving a
      // transaction to an account in another currency has to re-denominate the
      // row, not leave it labelled with the old one.
      transactionUpdateData.currencyCode = effectiveAccountCurrency;
      if ("exchangeRate" in updateData)
        transactionUpdateData.exchangeRate = updateData.exchangeRate;
      // Foreign-currency entry: re-normalize when either field is touched --
      // or when the row is moving to an account in another currency while
      // carrying a foreign entry. The tuple was normalized against the old
      // denomination; re-labelling currencyCode above without re-normalizing
      // left originalCurrencyCode able to equal the new primary currency
      // beside a stale rate, a state normalizeFxEntry never produces (it
      // strips the metadata when the currencies coincide, and validates the
      // pair when they still differ).
      const movingAcrossCurrencies =
        effectiveAccountCurrency !== transaction.currencyCode &&
        transaction.originalCurrencyCode != null;
      if (
        "originalAmount" in updateData ||
        "originalCurrencyCode" in updateData ||
        movingAcrossCurrencies
      ) {
        const fx = this.normalizeFxEntry(
          {
            originalAmount:
              "originalAmount" in updateData
                ? updateData.originalAmount
                : transaction.originalAmount,
            originalCurrencyCode:
              "originalCurrencyCode" in updateData
                ? updateData.originalCurrencyCode
                : transaction.originalCurrencyCode,
            exchangeRate:
              updateData.exchangeRate ?? Number(transaction.exchangeRate),
            amount: updateData.amount ?? Number(transaction.amount),
          },
          effectiveAccountCurrency,
        );
        transactionUpdateData.originalAmount = fx.originalAmount;
        transactionUpdateData.originalCurrencyCode = fx.originalCurrencyCode;
      }
      if ("description" in updateData)
        transactionUpdateData.description = updateData.description ?? null;
      if ("referenceNumber" in updateData)
        transactionUpdateData.referenceNumber =
          updateData.referenceNumber ?? null;
      if ("status" in updateData)
        transactionUpdateData.status = updateData.status;
      if ("reconciledDate" in updateData)
        transactionUpdateData.reconciledDate = updateData.reconciledDate as any;
      if (createdAt !== undefined) {
        // Convert ISO string to a UTC-formatted timestamp string without
        // timezone suffix.  TypeORM + pg serialise Date objects using the
        // server's local timezone, which shifts the value when the server
        // is not UTC.  By passing a plain string ('YYYY-MM-DD HH:mm:ss.SSS')
        // the pg driver sends it verbatim and PostgreSQL stores the UTC
        // value as-is in the TIMESTAMP WITHOUT TIME ZONE column.
        const d = new Date(createdAt);
        const utc = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
        await m.query(`UPDATE transactions SET created_at = $1 WHERE id = $2`, [
          utc,
          id,
        ]);
      }

      if (splits && splits.length > 0) {
        transactionUpdateData.categoryId = null;
        transactionUpdateData.isSplit = true;
      }

      if (Object.keys(transactionUpdateData).length > 0) {
        await m.update(Transaction, id, transactionUpdateData);
      }

      // Update transaction-level tags
      if (tagIds !== undefined) {
        await this.tagsService.setTransactionTags(id, tagIds, userId);
      }

      const savedTransaction = await m.findOne(Transaction, {
        where: { id, userId },
      });
      if (!savedTransaction) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${id} not found`,
            { id },
          ),
        );
      }

      const newAmount = Number(savedTransaction.amount);
      const newAccountId = savedTransaction.accountId;
      const newStatus = savedTransaction.status;
      const isVoid = newStatus === TransactionStatus.VOID;

      // A split parent's transfer children have their own counterpart rows in
      // other accounts. `parentStatus` reaches them when children are created or
      // rebuilt, but a status-only edit does not rebuild them -- so voiding a
      // mixed category/transfer split used to restore the source balance and
      // leave the target holding the transferred amount under an ACTIVE
      // counterpart (review finding FR-002). Inside this transaction, so the
      // parent and every counterpart commit together.
      if (savedTransaction.isSplit && wasVoid !== isVoid) {
        // The accounts it moved join this update's invalidation set: a corrected
        // live balance beside a stale net-worth snapshot is an inconsistency the
        // user can see, and it persisted until something unrelated wrote to that
        // account (recheck RR4-003).
        for (const affected of await this.splitService.applyParentStatusToTransferCounterparts(
          m,
          id,
          userId,
          newStatus,
        )) {
          counterpartAccountIds.add(affected);
        }
      } else if (savedTransaction.isTransfer && wasVoid !== isVoid) {
        // The generic row update crosses the VOID boundary under the same
        // obligations as the dedicated routes: a split-transfer counterpart
        // leg is refused (the pairing belongs to the parent), and a mirror
        // leg's counterpart crosses with it, adjusted by its own amount.
        // Without this, PATCH /transactions/:id on one leg restored one
        // account and left the other holding the money (P5-001 scenario B).
        await assertVoidTransitionAllowedOnRow(m, id);
        for (const affected of await applyVoidTransitionToMirrorLeg(
          m,
          this.accountsService,
          userId,
          locked,
          newStatus,
        )) {
          counterpartAccountIds.add(affected);
        }
      }
      const oldIsFuture = isTransactionInFuture(oldTransactionDate);
      const newIsFuture = isTransactionInFuture(
        savedTransaction.transactionDate,
      );
      const anyFuture = oldIsFuture || newIsFuture;

      if (anyFuture) {
        // Deterministic order so two accounts locked by both this path and a
        // transfer cannot be taken in opposite orders.
        const affectedAccounts = [
          ...new Set([oldLockedAccountId, newAccountId]),
        ].sort();
        for (const accId of affectedAccounts) {
          await this.accountsService.recalculateCurrentBalance(userId, accId);
        }
      } else if (wasVoid && !isVoid) {
        await this.accountsService.updateBalance(newAccountId, newAmount);
      } else if (!wasVoid && isVoid) {
        await this.accountsService.updateBalance(
          oldLockedAccountId,
          -oldAmount,
        );
      } else if (!wasVoid && !isVoid) {
        if (newAccountId !== oldLockedAccountId) {
          await this.accountsService.updateBalance(
            oldLockedAccountId,
            -oldAmount,
          );
          await this.accountsService.updateBalance(newAccountId, newAmount);
        } else if (newAmount !== oldAmount) {
          // Rounded: the difference of two 4dp decimals is not itself a 4dp
          // decimal in binary floating point, and this value is the amount a
          // balance moves by.
          const balanceChange = roundMoney(newAmount - oldAmount);
          await this.accountsService.updateBalance(newAccountId, balanceChange);
        } else if (oldTransactionDate !== savedTransaction.transactionDate) {
          // Same account, same amount, both dates in the past (anyFuture is
          // handled above): current_balance is unchanged, so no balance write
          // runs and nothing bumps accounts.updated_at. But moving the row
          // between past months changes monthly_account_balances, and
          // NetWorthService.sweepStaleSnapshots finds a stale snapshot only by
          // accounts.updated_at outrunning its computed_at. Touch the account so
          // that crash-recovery backstop still fires if the in-memory debounce
          // is lost (audit DR-04-03).
          await this.accountsService.touchAccount(userId, newAccountId);
        }
      }
    });

    const finalTransaction = await this.findOne(userId, id);

    this.netWorthService.triggerDebouncedRecalc(
      finalTransaction.accountId,
      userId,
    );
    if (oldAccountId !== finalTransaction.accountId) {
      this.netWorthService.triggerDebouncedRecalc(oldAccountId, userId);
    }
    // Accounts moved by split-transfer counterpart propagation, which this method
    // knows nothing about until the helper reports them. After the commit, so a
    // rollback leaves nothing queued.
    for (const affected of counterpartAccountIds) {
      if (
        affected !== finalTransaction.accountId &&
        affected !== oldAccountId
      ) {
        this.netWorthService.triggerDebouncedRecalc(affected, userId);
      }
    }

    this.actionHistoryService.record(userId, {
      entityType: "transaction",
      entityId: id,
      action: "update",
      beforeData: beforeSnapshot,
      afterData: this.snapshotTransaction(finalTransaction),
      description: `Updated transaction ${finalTransaction.payeeName || ""} ${formatCurrency(Number(finalTransaction.amount), finalTransaction.currencyCode)}`,
      descriptionKey: "updatedTransaction",
      descriptionParams: {
        payee: finalTransaction.payeeName || "",
        // `amount` is the deterministic English rendering, kept for a client
        // that predates the structured pair below; `amountValue` /
        // `amountCurrency` let the reader's client format it in their own
        // number locale (issue #1316) -- the stored string cannot be, since
        // this row outlives the request that wrote it.
        amount: formatCurrency(
          Number(finalTransaction.amount),
          finalTransaction.currencyCode,
        ),
        amountValue: Number(finalTransaction.amount),
        amountCurrency: finalTransaction.currencyCode,
      },
    });
    return finalTransaction;
  }

  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);
    const beforeSnapshot = this.snapshotTransaction(transaction);
    // Every account this deletion moves, not only the selected row's, so the
    // net-worth fan-out after commit invalidates all of them (recheck RR5-002).
    // Seeded empty and filled from the LOCKED row (below), never the pre-lock
    // snapshot: a concurrent edit may have moved the row to another account, and
    // upstream's P4 fix reverses/recalcs the locked account. Seeding with the
    // snapshot account would re-introduce the stale one into the net-worth
    // fan-out (RR5-002 must not undo the P4-002 locked-account guarantee).
    const affectedAccountIds = new Set<string>();

    // One transaction: split side effects, linked/parent cleanup, the delete
    // itself, and the balance adjustment commit or roll back together.
    await withScopedDb(this.dataSource, async (m) => {
      // Parent-before-leg (audit RV4-005). If this row is a leg of a split
      // parent, lock the parent *before* the leg -- the same order
      // TransactionSplitService.removeSplit takes, which cannot know a leg id
      // before reading the split and so necessarily locks parent then leg. Two
      // delete paths taking the same rows in opposite orders is a reachable
      // deadlock; ordering by role (parent first) removes it. The lookup is an
      // unlocked read, and lockTransactionRow is re-entrant within the
      // transaction, so removeParentTransaction re-locking the parent below is a
      // no-op that inherits this order.
      const parentSplit = await m.findOne(TransactionSplit, {
        where: { linkedTransactionId: id },
      });
      if (parentSplit) {
        await lockTransactionRow(m, parentSplit.transactionId, userId);
      }

      // Lock the row and re-read the amount to reverse. `m.remove(entity)`
      // deletes by primary key and reports nothing when it hits no row, so two
      // concurrent deletes each reversed the same amount and only one row went
      // away: opening 100.00, one -10.00 row removed twice, stored balance
      // 110.00 against an authoritative 100.00 (audit P4-003).
      const locked = await lockTransactionRow(m, id, userId);
      if (!locked) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${id} not found`,
            { id },
          ),
        );
      }
      // Strict reconciled lock, before the delete and any split cleanup.
      await assertReconciledRowsMutable(m, userId, [locked]);

      // The locked row's account joins the fan-out set: a concurrent edit could
      // have moved the row, and the balance reversal below uses locked.accountId.
      affectedAccountIds.add(locked.accountId);

      if (locked.isSplit) {
        // Transfer-target and brokerage accounts this split's cleanup moved join
        // the set invalidated after commit (recheck RR5-002).
        for (const acc of await this.splitService.deleteSplitSideEffects(
          id,
          userId,
        )) {
          affectedAccountIds.add(acc);
        }
      }

      if (parentSplit) {
        await this.removeParentTransaction(
          m,
          parentSplit,
          id,
          userId,
          affectedAccountIds,
        );
      }

      const deleted = await m.delete(Transaction, { id, userId });
      if ((deleted.affected ?? 0) === 0) {
        // The row was removed by the parent cleanup above (a split counterpart
        // cascade). Reversing its amount again would double-count.
        return;
      }

      const effect = deletionBalanceEffect(locked);
      if (effect.delta !== 0) {
        await this.accountsService.updateBalance(
          locked.accountId,
          effect.delta,
        );
      }
      if (effect.needsRecalc) {
        await this.accountsService.recalculateCurrentBalance(
          userId,
          locked.accountId,
        );
      }
    });

    for (const affected of affectedAccountIds) {
      this.netWorthService.triggerDebouncedRecalc(affected, userId);
    }
    this.recordTransactionAction(
      userId,
      { ...transaction, ...beforeSnapshot } as Transaction,
      "delete",
      beforeSnapshot,
    );
  }

  /**
   * `affectedAccountIds` collects every account this deletion touched, so the
   * caller can invalidate the balance-derived state of all of them after the
   * commit. It used to recalculate net worth for the deleted row's account alone,
   * leaving a sibling target account with a corrected balance beside a stale
   * net-worth snapshot (recheck RR4-003, on the deletion path).
   */
  private async removeParentTransaction(
    m: EntityManager,
    parentSplit: TransactionSplit,
    linkedTransactionId: string,
    userId: string,
    affectedAccountIds: Set<string>,
  ): Promise<void> {
    const parentTransactionId = parentSplit.transactionId;
    // Locked, like every other read whose amount becomes a balance delta.
    const parentTransaction = await lockTransactionRow(
      m,
      parentTransactionId,
      userId,
    );

    if (parentTransaction) {
      const allSplits = await m.find(TransactionSplit, {
        where: { transactionId: parentTransactionId },
      });

      // Fetch every linked transfer transaction for these splits in one query
      // instead of a findOne per split, then process them with the same
      // per-transaction balance/remove logic as before.
      const linkedIds = [
        ...new Set(
          allSplits
            .map((s) => s.linkedTransactionId)
            .filter((id): id is string => !!id && id !== linkedTransactionId),
        ),
      ];

      if (linkedIds.length > 0) {
        // Locked in ascending id order: these amounts become balance deltas,
        // and an unlocked read can be stale by the time the delete lands.
        const linkedTxs = await lockTransactionRows(m, linkedIds, userId);

        for (const linkedTx of [...linkedTxs.values()]) {
          const linkedAccId = linkedTx.accountId;
          // The one deletion-reversal rule, from the shared helper: a VOID or
          // future-dated row contributed nothing. This function is the one the
          // helper's own doc cites (recheck RR4-001), yet it still hand-rolled
          // the rule twice.
          const effect = deletionBalanceEffect(linkedTx);
          const removed = await m.delete(Transaction, {
            id: linkedTx.id,
            userId,
          });
          if ((removed.affected ?? 0) === 0) continue;
          // Every account this deletion actually moved joins the fan-out set so
          // its net-worth snapshot is invalidated after commit (recheck RR5-002).
          affectedAccountIds.add(linkedAccId);
          if (effect.delta !== 0) {
            await this.accountsService.updateBalance(linkedAccId, effect.delta);
          }
          if (effect.needsRecalc) {
            await this.accountsService.recalculateCurrentBalance(
              userId,
              linkedAccId,
            );
          }
        }
      }

      await m.remove(allSplits);

      const parentEffect = deletionBalanceEffect(parentTransaction);
      const parentRemoved = await m.delete(Transaction, {
        id: parentTransaction.id,
        userId,
      });
      if ((parentRemoved.affected ?? 0) === 0) return;
      // The parent's own account joins the fan-out set (recheck RR5-002).
      affectedAccountIds.add(parentTransaction.accountId);

      if (parentEffect.delta !== 0) {
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          parentEffect.delta,
        );
      }
      if (parentEffect.needsRecalc) {
        await this.accountsService.recalculateCurrentBalance(
          userId,
          parentTransaction.accountId,
        );
      }
    }
  }

  // Delegated methods

  // These four pass the transaction *id*, not a loaded entity: the status a
  // guard refuses on and the status a balance delta is derived from are the
  // same value, and it has to be read under the write's own lock. See
  // `applyStatusTransition`.
  async updateStatus(
    userId: string,
    id: string,
    status: TransactionStatus,
  ): Promise<Transaction> {
    return this.reconciliationService.updateStatus(
      userId,
      id,
      status,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async markCleared(
    userId: string,
    id: string,
    isCleared: boolean,
  ): Promise<Transaction> {
    return this.reconciliationService.markCleared(
      userId,
      id,
      isCleared,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async reconcile(userId: string, id: string): Promise<Transaction> {
    return this.reconciliationService.reconcile(
      userId,
      id,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async unreconcile(userId: string, id: string): Promise<Transaction> {
    return this.reconciliationService.unreconcile(
      userId,
      id,
      this.findOne.bind(this),
    );
  }

  async getStaleUnreconciled(userId: string) {
    return this.reconciliationService.getStaleUnreconciled(userId);
  }

  async getReconciliationData(
    userId: string,
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ) {
    return this.reconciliationService.getReconciliationData(
      userId,
      accountId,
      statementDate,
      statementBalance,
    );
  }

  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ) {
    return this.reconciliationService.bulkReconcile(
      userId,
      accountId,
      transactionIds,
      reconciledDate,
    );
  }

  async getSummary(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
    jointAccountIds?: string[],
  ) {
    return this.analyticsService.getSummary(
      userId,
      accountIds,
      startDate,
      endDate,
      categoryIds,
      payeeIds,
      search,
      amountFrom,
      amountTo,
      undefined,
      undefined,
      tagIds,
      jointAccountIds,
    );
  }

  /** The payees and categories a register's filter pickers may offer. */
  async getRegisterFilterOptions(
    userId: string,
    filters: { accountIds?: string[]; jointAccountIds?: string[] } = {},
  ) {
    return this.analyticsService.getRegisterFilterOptions(userId, filters);
  }

  async getGroupedTotals(
    userId: string,
    params: {
      groupBy: "category" | "payee";
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      limit?: number;
      includeUnreconciledBeforeStart?: boolean;
      jointAccountIds?: string[];
    },
  ) {
    return this.analyticsService.getGroupedTotals(userId, params);
  }

  async getTagKeyBreakdown(
    userId: string,
    key: string,
    params: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      limit?: number;
    },
  ) {
    return this.analyticsService.getTransactionBreakdownByTagKey(
      userId,
      key,
      params,
    );
  }

  /**
   * `payeeIds` and `accountId` are both optional here and the controller
   * requires at least one, because an unfiltered detection over the whole
   * ledger is a different (and much heavier) question than either caller asks.
   */
  async getRecurringCharges(
    userId: string,
    startDate: string,
    endDate: string,
    options: { payeeIds?: string[]; accountId?: string },
  ) {
    return this.analyticsService.getRecurringCharges(
      userId,
      startDate,
      endDate,
      options,
    );
  }

  async getMonthlyTotals(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
    jointAccountIds?: string[],
  ) {
    return this.analyticsService.getMonthlyTotals(
      userId,
      accountIds,
      startDate,
      endDate,
      categoryIds,
      payeeIds,
      search,
      amountFrom,
      amountTo,
      tagIds,
      jointAccountIds,
    );
  }

  async getFxFeeSummary(userId: string, accountId: string) {
    return this.analyticsService.getFxFeeSummary(userId, accountId);
  }

  async getSplits(userId: string, transactionId: string) {
    await this.findOne(userId, transactionId);
    return this.splitService.getSplits(transactionId);
  }

  async updateSplits(
    userId: string,
    transactionId: string,
    splits: CreateTransactionSplitDto[],
  ) {
    const transaction = await this.findOne(userId, transactionId);
    return this.splitService.updateSplits(transaction, splits, userId);
  }

  async addSplit(
    userId: string,
    transactionId: string,
    splitDto: CreateTransactionSplitDto,
  ) {
    const transaction = await this.findOne(userId, transactionId);
    return this.splitService.addSplit(transaction, splitDto, userId);
  }

  async removeSplit(userId: string, transactionId: string, splitId: string) {
    const transaction = await this.findOne(userId, transactionId);
    return this.splitService.removeSplit(transaction, splitId, userId);
  }

  async createTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
    actor?: TransferActor,
  ): Promise<TransferResult> {
    const prepared = await this.prepareTransfer(
      userId,
      createTransferDto,
      actor,
    );
    const { savedFromId, savedToId } =
      await this.transferService.writeTransferLegs(prepared);
    return this.completeTransfer(prepared, savedFromId, savedToId);
  }

  /**
   * Validate and authorize a transfer without writing it. See
   * `TransactionTransferService.prepareTransfer` -- a caller that already holds
   * a transaction must decide authorization before opening it, because the
   * authorization read runs under a system context that cannot join a
   * user-identity transaction.
   */
  prepareTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
    actor?: TransferActor,
  ): Promise<PreparedTransfer> {
    return this.transferService.prepareTransfer(
      userId,
      createTransferDto,
      actor,
    );
  }

  /**
   * Write a prepared transfer's legs, joining `manager` when the caller supplies
   * one so the write is atomic with the rest of their transaction.
   */
  writeTransferLegs(
    prepared: PreparedTransfer,
    manager?: EntityManager,
  ): Promise<{ savedFromId: string; savedToId: string }> {
    return this.transferService.writeTransferLegs(prepared, manager);
  }

  /**
   * Everything a transfer does after its legs commit: derived recalculation,
   * action history, tags, and the read-back the caller returns. A caller that
   * wrote the legs inside its own transaction calls this once that transaction
   * has committed -- never inside it, since the history recorder swallows its
   * own failures and would either abort the caller or lose the undo entry.
   */
  async completeTransfer(
    prepared: PreparedTransfer,
    savedFromId: string,
    savedToId: string,
  ): Promise<TransferResult> {
    const userId = prepared.effectiveUserId;
    const result = await this.transferService.completeTransfer(
      prepared,
      savedFromId,
      savedToId,
      this.findOne.bind(this),
    );

    const tagIds = prepared.dto.tagIds;
    if (tagIds && tagIds.length > 0) {
      // Tags are per-user reference data: never write the effective user's
      // tag ids onto a cross-owner counterpart leg.
      const refresh = async (leg: Transaction) => {
        if (leg.userId !== userId) return leg;
        await this.tagsService.setTransactionTags(leg.id, tagIds, userId);
        return this.findOne(userId, leg.id);
      };

      return {
        fromTransaction: await refresh(result.fromTransaction),
        toTransaction: await refresh(result.toTransaction),
      };
    }

    return result;
  }

  async getLinkedTransaction(
    userId: string,
    transactionId: string,
    actor?: TransferActor,
  ): Promise<Transaction | null> {
    return this.transferService.getLinkedTransaction(
      userId,
      transactionId,
      this.findOne.bind(this),
      actor,
    );
  }

  async removeTransfer(
    userId: string,
    transactionId: string,
    actor?: TransferActor,
  ): Promise<void> {
    return this.transferService.removeTransfer(
      userId,
      transactionId,
      this.findOne.bind(this),
      actor,
    );
  }

  /**
   * Delete a transaction, routing transfers to removeTransfer so both linked
   * legs are removed (plain remove() only deletes the single row). Used by the
   * AI Assistant / MCP manage_transactions delete path, where the caller does
   * not know up front whether the target is a transfer.
   */
  async removeAny(userId: string, transactionId: string): Promise<void> {
    const transaction = await this.findOne(userId, transactionId);
    if (transaction.isTransfer && transaction.linkedTransactionId) {
      return this.removeTransfer(userId, transactionId);
    }
    return this.remove(userId, transactionId);
  }

  /**
   * Persist split-level tags and mirror them onto each split's transfer
   * counterpart. A transfer split's tags live on both the split row (shown on
   * the source transaction) and the counterpart leg's transaction tags (shown
   * on the target account), so the two stay in agreement in both directions.
   */
  private async applySplitTags(
    savedSplits: TransactionSplit[],
    splits: CreateTransactionSplitDto[],
    userId: string,
  ): Promise<void> {
    for (let i = 0; i < splits.length; i++) {
      const splitTagIds = splits[i].tagIds;
      const saved = savedSplits[i];
      if (!saved || !splitTagIds || splitTagIds.length === 0) continue;

      await this.tagsService.setSplitTags(saved.id, splitTagIds, userId);

      if (saved.linkedTransactionId) {
        await this.tagsService.setTransactionTags(
          saved.linkedTransactionId,
          splitTagIds,
          userId,
        );
      }
    }
  }

  async updateTransfer(
    userId: string,
    transactionId: string,
    updateDto: Partial<UpdateTransferDto>,
    actor?: TransferActor,
  ): Promise<TransferResult> {
    const result = await this.transferService.updateTransfer(
      userId,
      transactionId,
      updateDto,
      this.findOne.bind(this),
      actor,
    );

    if (updateDto.tagIds !== undefined) {
      // Tags are per-user reference data: cross-owner counterpart legs keep
      // their own owner's tags, so only effective-user legs are synced.
      for (const legId of new Set(
        [result.fromTransaction, result.toTransaction]
          .filter((leg) => leg.userId === userId)
          .map((leg) => leg.id),
      )) {
        await this.tagsService.setTransactionTags(
          legId,
          updateDto.tagIds,
          userId,
        );
      }

      // When the edited leg belongs to a split transfer, mirror the tags onto
      // the owning split so the source transaction's split reflects them too
      // (parallels the description<->memo and amount mirroring done in
      // transferService.updateSplitTransferLeg).
      const parentSplit =
        await this.splitService.getTransferSplitByLinkedTransaction(
          transactionId,
        );
      if (parentSplit) {
        await this.tagsService.setSplitTags(
          parentSplit.id,
          updateDto.tagIds,
          userId,
        );
      }

      const refresh = (leg: Transaction) =>
        leg.userId === userId ? this.findOne(userId, leg.id) : leg;
      return {
        fromTransaction: await refresh(result.fromTransaction),
        toTransaction: await refresh(result.toTransaction),
      };
    }

    return result;
  }

  async bulkUpdate(
    userId: string,
    bulkUpdateDto: BulkUpdateDto,
  ): Promise<BulkUpdateResult> {
    return this.bulkUpdateService.bulkUpdate(userId, bulkUpdateDto);
  }

  async bulkDelete(
    userId: string,
    bulkDeleteDto: BulkDeleteDto,
  ): Promise<BulkDeleteResult> {
    return this.bulkUpdateService.bulkDelete(userId, bulkDeleteDto);
  }

  private snapshotTransaction(tx: Transaction): Record<string, any> {
    return {
      id: tx.id,
      accountId: tx.accountId,
      transactionDate: tx.transactionDate,
      amount: tx.amount,
      currencyCode: tx.currencyCode,
      exchangeRate: tx.exchangeRate,
      payeeId: tx.payeeId,
      payeeName: tx.payeeName,
      categoryId: tx.categoryId,
      description: tx.description,
      referenceNumber: tx.referenceNumber,
      status: tx.status,
      isSplit: tx.isSplit,
      isTransfer: tx.isTransfer,
      linkedTransactionId: tx.linkedTransactionId,
      parentTransactionId: tx.parentTransactionId,
      reconciledDate: tx.reconciledDate,
      createdAt: tx.createdAt,
      splits: tx.splits?.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        transferAccountId: s.transferAccountId,
        linkedTransactionId: s.linkedTransactionId,
        amount: s.amount,
        memo: s.memo,
      })),
      tagIds: tx.tags?.map((t) => t.id),
    };
  }

  private recordTransactionAction(
    userId: string,
    tx: Transaction,
    action: "create" | "update" | "delete",
    beforeData?: Record<string, any>,
  ): void {
    const snapshot =
      action === "delete" ? beforeData : this.snapshotTransaction(tx);
    this.actionHistoryService.record(userId, {
      entityType: "transaction",
      entityId: tx.id,
      action,
      beforeData: action === "create" ? undefined : beforeData,
      afterData: action === "delete" ? undefined : snapshot,
      description: `${action === "create" ? "Created" : action === "update" ? "Updated" : "Deleted"} transaction ${tx.payeeName || ""} ${formatCurrency(Number(tx.amount), tx.currencyCode)}`,
      descriptionKey:
        action === "create"
          ? "createdTransaction"
          : action === "update"
            ? "updatedTransaction"
            : "deletedTransaction",
      descriptionParams: {
        payee: tx.payeeName || "",
        // See `update`: English fallback plus the structured pair the client
        // formats in the reader's number locale.
        amount: formatCurrency(Number(tx.amount), tx.currencyCode),
        amountValue: Number(tx.amount),
        amountCurrency: tx.currencyCode,
      },
    });
  }

  /**
   * Search transactions and shape them as flat rows for LLM tools (the MCP
   * server's search_transactions tool and any AI Assistant equivalent). Split
   * transactions are expanded so each split appears as its own row with its
   * real category -- the parent of a split has categoryId NULL by design, so
   * reporting it as-is would make the model think it is uncategorized. Amount
   * filters are applied per expanded row. Keeping this on the domain service
   * (rather than in the tool layer) keeps both surfaces consistent.
   */
  async getLlmTransactionRows(
    userId: string,
    filters: {
      accountId?: string;
      categoryId?: string;
      payeeId?: string;
      startDate?: string;
      endDate?: string;
      query?: string;
      minAmount?: number;
      maxAmount?: number;
      limit?: number;
      sortBy?: "date" | "amount" | "payee";
      sortDirection?: "asc" | "desc";
    },
  ): Promise<LlmTransactionSearch> {
    const limit = Math.min(filters.limit || 50, 100);
    const sortBy = filters.sortBy ?? "date";
    const sortDirection = filters.sortDirection === "asc" ? "ASC" : "DESC";
    // Push the amount filter into the SQL WHERE clause so pagination, total and
    // hasMore reflect the filtered set. Filtering only the expanded rows after
    // the page was fetched returned a biased sample with a total/hasMore that
    // counted unfiltered parent rows -- the model would see e.g. 3 rows but be
    // told there were 50 and never page to the real matches. The per-row filter
    // below still applies to split sub-rows (whose individual amounts differ
    // from the parent total) so a split row outside the range is not shown.
    const result = await this.findAll(
      userId,
      filters.accountId ? [filters.accountId] : undefined,
      filters.startDate,
      filters.endDate,
      filters.categoryId ? [filters.categoryId] : undefined,
      filters.payeeId ? [filters.payeeId] : undefined,
      1,
      limit,
      false,
      filters.query,
      undefined,
      filters.minAmount,
      filters.maxAmount,
      undefined,
      undefined,
      sortBy,
      sortDirection,
    );

    // AI/MCP responses bypass the HTTP mask interceptor, so cross-owner
    // counterparts the user cannot read are masked here, before projection
    // (rewrites the auto payee tail on the visible leg). Pure-payload fast
    // path first: same-owner result sets never pay the grants query.
    if (payloadHasCrossOwnerTransfer(result.data)) {
      const readable =
        await this.crossOwnerAccess.readableAccountIdSetFor(userId);
      maskTransactionsAgainst(readable, result.data);
    }

    // Category names are qualified ("Business: Cell Phone"), because a leaf
    // name does not identify a category: a chart of accounts with "Cell Phone"
    // under both "Bills" and "Business" gave the model rows it could only
    // label by guessing, and it guessed. The map is the same one the tools
    // resolve an incoming name against, so a name shown here comes back as
    // this category and no other.
    const categoryNames = await withScopedDb(this.dataSource, (m) =>
      loadQualifiedCategoryNames(m, userId),
    );

    // A category filter hydrates ONLY the matching split lines (see
    // `applyCategoryFilters`). That is deliberate for the register, which
    // wants a filtered partial total, and wrong here: the reader is a model
    // that will send the lines back as a complete replacement set, and
    // `manage_transactions` replaces the set with exactly what it is given.
    // Shown one line of a three-line split, it either proposes wiping the
    // other two or -- as happened -- concludes these are not split
    // transactions at all. So the LLM path reloads the whole set for every
    // split parent on the page, and the rows below are always complete.
    const completeSplits = await this.loadCompleteSplits(
      result.data.filter((t) => t.isSplit).map((t) => t.id),
    );
    const nameOf = (category?: { id: string; name: string } | null) =>
      category ? (categoryNames.get(category.id) ?? category.name) : undefined;

    const transactions = result.data.flatMap((t): LlmTransactionRow[] => {
      const splits = completeSplits.get(t.id) ?? t.splits;
      const rows: LlmTransactionRow[] =
        t.isSplit && Array.isArray(splits) && splits.length > 0
          ? splits.map((s) => ({
              id: t.id,
              splitId: s.id,
              date: t.transactionDate,
              payeeName: t.payeeName,
              categoryName: nameOf(s.category),
              amount: Number(s.amount),
              accountName: t.account?.name,
              description: s.memo ?? t.description,
              status: t.status,
              isSplit: true,
            }))
          : [
              {
                id: t.id,
                date: t.transactionDate,
                // A blank transfer payee resolves to "Transfer to/from
                // <account>" from the counterpart's current name (issue
                // #1214) -- the same label the register shows the user, so
                // the model and the screen describe the row identically. The
                // mask above already rewrote unreadable counterpart names.
                payeeName:
                  t.payeeName ??
                  (t.isTransfer && t.linkedTransaction?.account?.name
                    ? transferPayeeLabel(
                        t.amount,
                        t.linkedTransaction.account.name,
                      )
                    : t.payeeName),
                categoryName: nameOf(t.category),
                amount: Number(t.amount),
                accountName: t.account?.name,
                description: t.description,
                status: t.status,
                // Read-only foreign-currency metadata, emitted only for a
                // foreign-entered transaction.
                ...(t.originalCurrencyCode
                  ? {
                      originalAmount: Number(t.originalAmount),
                      originalCurrencyCode: t.originalCurrencyCode,
                      exchangeRate: Number(t.exchangeRate),
                    }
                  : {}),
              },
            ];
      return rows.filter((row) => {
        if (filters.minAmount !== undefined && row.amount < filters.minAmount) {
          return false;
        }
        if (filters.maxAmount !== undefined && row.amount > filters.maxAmount) {
          return false;
        }
        return true;
      });
    });

    return {
      transactions,
      total: result.pagination.total,
      hasMore: result.pagination.hasMore,
    };
  }

  /**
   * Every split line of the given transactions, keyed by transaction id.
   *
   * A separate read rather than a relation on the list query, because the list
   * query's split hydration is filtered on purpose and the caller here needs
   * the opposite. Ordered by id so a set read twice comes back in the same
   * order -- a model resending "the same lines with one changed" should not
   * have them shuffle underneath it.
   */
  private async loadCompleteSplits(
    transactionIds: string[],
  ): Promise<Map<string, TransactionSplit[]>> {
    if (transactionIds.length === 0) return new Map();
    const splits = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).find({
        where: { transactionId: In(transactionIds) },
        relations: ["category"],
        order: { id: "ASC" },
      }),
    );
    const byTransaction = new Map<string, TransactionSplit[]>();
    for (const split of splits) {
      const existing = byTransaction.get(split.transactionId);
      if (existing) existing.push(split);
      else byTransaction.set(split.transactionId, [split]);
    }
    return byTransaction;
  }
}
