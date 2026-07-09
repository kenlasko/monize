import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository, In, DataSource, QueryRunner } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
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
import {
  TransactionTransferService,
  TransferResult,
} from "./transaction-transfer.service";
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
import { tr } from "../i18n/translate";
import { stripHtml } from "../common/sanitization.util";
import {
  BulkCreateResult,
  BulkCreateSkip,
  bulkSkipReason,
} from "../common/bulk-create.types";

export interface TransactionWithInvestmentLink extends Transaction {
  linkedInvestmentTransactionId?: string | null;
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
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @InjectRepository(UserPreference)
    private userPreferenceRepository: Repository<UserPreference>,
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
    const prefs = await this.userPreferenceRepository.findOne({
      where: { userId },
    });
    return parseSearchTerm(term, {
      numberFormat: prefs?.numberFormat,
      dateFormat: prefs?.dateFormat,
    });
  }

  async create(
    userId: string,
    createTransactionDto: CreateTransactionDto,
    options?: { createPayeeIfMissing?: boolean },
  ): Promise<Transaction> {
    await this.accountsService.findOne(userId, createTransactionDto.accountId);

    const { splits, tagIds, ...transactionData } = createTransactionDto;
    const hasSplits = splits && splits.length > 0;

    if (hasSplits) {
      this.splitService.validateSplits(splits, createTransactionDto.amount);
    }

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
      const cat = await this.categoriesRepository.findOne({
        where: { id: transactionData.categoryId, userId },
      });
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedTransactionId: string;

    try {
      const transaction = queryRunner.manager.create(Transaction, {
        ...transactionData,
        payeeId: resolvedPayeeId,
        payeeName: resolvedPayeeName,
        categoryId: hasSplits ? null : categoryId,
        isSplit: hasSplits,
        userId,
        exchangeRate: transactionData.exchangeRate || 1,
      });

      const savedTransaction = await queryRunner.manager.save(transaction);
      savedTransactionId = savedTransaction.id;

      if (hasSplits) {
        const savedSplits = await this.splitService.createSplits(
          savedTransaction.id,
          splits,
          userId,
          createTransactionDto.accountId,
          new Date(createTransactionDto.transactionDate),
          transactionData.payeeName,
          queryRunner,
        );

        // Set split-level tags
        if (savedSplits && splits) {
          for (let i = 0; i < splits.length; i++) {
            const splitTagIds = splits[i].tagIds;
            if (splitTagIds && splitTagIds.length > 0 && savedSplits[i]) {
              await this.tagsService.setSplitTags(
                savedSplits[i].id,
                splitTagIds,
                userId,
                queryRunner,
              );
            }
          }
        }
      }

      // Set transaction-level tags
      if (tagIds && tagIds.length > 0) {
        await this.tagsService.setTransactionTags(
          savedTransaction.id,
          tagIds,
          userId,
          queryRunner,
        );
      }

      if (savedTransaction.status !== TransactionStatus.VOID) {
        if (isTransactionInFuture(createTransactionDto.transactionDate)) {
          await this.accountsService.recalculateCurrentBalance(
            createTransactionDto.accountId,
            queryRunner,
          );
        } else {
          await this.accountsService.updateBalance(
            createTransactionDto.accountId,
            Number(createTransactionDto.amount),
            queryRunner,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.netWorthService.triggerDebouncedRecalc(
      createTransactionDto.accountId,
      userId,
    );

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
      const cat = await this.categoriesRepository.findOne({
        where: { id: categoryId, userId },
      });
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
    const cat = await this.categoriesRepository.findOne({
      where: { id: categoryId, userId },
    });
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
   * Transfers and split transactions are rejected here: their linked legs and
   * child splits need the dedicated edit flows, so this single-record path
   * would leave them inconsistent.
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
    if (existing.isSplit) {
      throw new BadRequestException(
        tr(
          "errors.transactions.cannotEditSplit",
          "Split transactions can't be edited here. Edit the split from the Transactions screen.",
        ),
      );
    }

    const hasChange =
      input.amount !== undefined ||
      input.transactionDate !== undefined ||
      input.payeeName !== undefined ||
      input.categoryId !== undefined ||
      input.description !== undefined;
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
      const cat = await this.categoriesRepository.findOne({
        where: { id: input.categoryId, userId },
      });
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

    const rows = await this.transactionsRepository.find({
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
    });

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
  ): Promise<PaginatedTransactions> {
    const clamped = clampPagination(page, limit);
    const safeLimit = clamped.limit;
    let safePage = clamped.page;

    // Interpret the search term once (amount/date in the user's locale format)
    // and thread it through the query, the target-page count, and the running
    // balance so all three match the same rows.
    const parsedSearch = await this.resolveSearchTerm(userId, search);

    const queryBuilder = this.transactionsRepository
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
      .where("transaction.userId = :userId", { userId })
      .orderBy(
        sortBy === "amount"
          ? "transaction.amount"
          : sortBy === "payee"
            ? "transaction.payeeName"
            : "transaction.transactionDate",
        sortDirection,
      )
      .addOrderBy("transaction.createdAt", sortDirection)
      .addOrderBy("transaction.id", sortDirection);

    if (!includeInvestmentBrokerage) {
      queryBuilder.andWhere(
        "(account.accountSubType IS NULL OR account.accountSubType != 'INVESTMENT_BROKERAGE')",
      );
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
      await this.applyCategoryFilters(queryBuilder, categoryIds, userId);
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

    if (targetTransactionId) {
      safePage = await this.calculateTargetPage(
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
      startingBalance = await this.calculateMultiAccountContentFilteredBalance(
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
      );
    } else if (
      (!accountIds || accountIds.length === 0) &&
      hasContentFilters &&
      data.length > 0
    ) {
      startingBalance = await this.calculateMultiAccountContentFilteredBalance(
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
      );
    }

    const enrichedData = await this.enrichWithInvestmentLinks(data);

    return {
      data: enrichedData,
      pagination: buildPaginationMeta(safePage, safeLimit, total),
      startingBalance,
    };
  }

  private async applyCategoryFilters(
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
              this.categoriesRepository,
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
              "transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND account.accountType != 'INVESTMENT'",
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
  ): Promise<number> {
    try {
      const targetTx = await this.transactionsRepository.findOne({
        where: { id: targetTransactionId, userId },
        select: ["id", "transactionDate", "createdAt"],
      });

      if (!targetTx) return fallbackPage;

      const countQuery = this.transactionsRepository
        .createQueryBuilder("t")
        .leftJoin("t.account", "a")
        .leftJoin("t.splits", "s")
        .where("t.userId = :userId", { userId });

      if (!includeInvestmentBrokerage) {
        countQuery.andWhere(
          "(a.accountSubType IS NULL OR a.accountSubType != 'INVESTMENT_BROKERAGE')",
        );
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
        userId,
        singleAccountId,
        safePage,
        skip,
        filters!,
      );
    }

    if (hasDateFilter) {
      return this.calculateDateFilteredBalance(
        userId,
        singleAccountId,
        safePage,
        skip,
        filters!,
      );
    }

    // No filters: original behavior
    return this.calculateUnfilteredBalance(
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

    const previousPagesQuery = this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :singleAccountId", { singleAccountId })
      .orderBy("t.transactionDate", "DESC")
      .addOrderBy("t.createdAt", "DESC")
      .addOrderBy("t.id", "DESC")
      .limit(skip);

    const sumResult = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("SUM(transaction.amount)", "sum")
      .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
      .setParameters(previousPagesQuery.getParameters())
      .getRawOne();

    const sumBefore = Number(sumResult?.sum) || 0;
    return projectedBalance - sumBefore;
  }

  /**
   * Content-filtered balance: zero-based running balance.
   * startingBalance = totalSum of all matching transactions (page 1)
   * or totalSum - sumOfPreviousPages (page > 1).
   */
  private async calculateContentFilteredBalance(
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
      userId,
      accountId,
      filters,
    );

    const totalSum = await this.computeSplitAwareSum(
      idsSubquery,
      userId,
      filters,
    );

    if (safePage === 1) return totalSum;

    return (
      totalSum -
      (await this.computeFilteredPrevPagesSum(userId, accountId, skip, filters))
    );
  }

  /**
   * Multi-account content-filtered balance: zero-based running balance
   * across multiple accounts when content filters are active.
   */
  private async calculateMultiAccountContentFilteredBalance(
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
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      userId,
      accountIds,
      filters,
    );

    const totalSum = await this.computeSplitAwareSum(
      idsSubquery,
      userId,
      filters,
    );

    if (safePage === 1) return totalSum;

    return (
      totalSum -
      (await this.computeFilteredPrevPagesSum(
        userId,
        accountIds,
        skip,
        filters,
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

      const sumAfterResult = await this.transactionsRepository
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "sum")
        .where("t.userId = :userId", { userId })
        .andWhere("t.accountId = :accountId", { accountId })
        .andWhere("t.transactionDate > :endDate", {
          endDate: filters.endDate,
        })
        .getRawOne();

      baseBalance = projectedBalance - (Number(sumAfterResult?.sum) || 0);
    } else {
      // Only startDate: top of list is still projected balance
      baseBalance = await this.computeProjectedBalance(userId, accountId);
    }

    if (safePage === 1) return baseBalance;

    // For page > 1, subtract sum of previous pages (within filtered set)
    const previousPagesQuery = this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :accountId", { accountId })
      .orderBy("t.transactionDate", "DESC")
      .addOrderBy("t.createdAt", "DESC")
      .addOrderBy("t.id", "DESC")
      .limit(skip);

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

    const sumResult = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("SUM(transaction.amount)", "sum")
      .where(`transaction.id IN (${previousPagesQuery.getQuery()})`)
      .setParameters(previousPagesQuery.getParameters())
      .getRawOne();

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
  ): Promise<number> {
    const idsSubquery = await this.buildFilteredIdsSubquery(
      userId,
      accountId,
      filters,
    );

    // Get ordered matching transactions, limited to previous pages
    const prevIdsQuery = this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.id")
      .where(`t.id IN (${idsSubquery.getQuery()})`)
      .setParameters(idsSubquery.getParameters())
      .orderBy("t.transactionDate", "DESC")
      .addOrderBy("t.createdAt", "DESC")
      .addOrderBy("t.id", "DESC")
      .limit(skip);

    return this.computeSplitAwareSum(prevIdsQuery, userId, filters);
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
      const result = await this.transactionsRepository
        .createQueryBuilder("sa")
        .select("COALESCE(SUM(sa.amount), 0)", "totalSum")
        .where(`sa.id IN (${idsSubquery.getQuery()})`)
        .setParameters(idsSubquery.getParameters())
        .getRawOne();
      return Number(result?.totalSum) || 0;
    }

    const sumQb = this.transactionsRepository
      .createQueryBuilder("sa")
      .where(`sa.id IN (${idsSubquery.getQuery()})`)
      .setParameters(idsSubquery.getParameters());

    sumQb.leftJoin("sa.splits", "saSplits");

    if (hasRegularCategories) {
      const expandedIds = await getAllCategoryIdsWithChildren(
        this.categoriesRepository,
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
  ) {
    const qb = this.transactionsRepository
      .createQueryBuilder("bf")
      .select("DISTINCT bf.id")
      .where("bf.userId = :bfUserId", { bfUserId: userId });

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
              this.categoriesRepository,
              userId,
              regularIds,
            )
          : [];

      qb.andWhere(
        new Brackets((outer) => {
          let hasCondition = false;
          if (hasUncategorized) {
            outer.where(
              "bf.categoryId IS NULL AND bf.isSplit = false AND bf.isTransfer = false",
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
    data: Transaction[],
  ): Promise<TransactionWithInvestmentLink[]> {
    const transactionIds = data.map((tx) => tx.id);
    const investmentLinkMap = new Map<string, string>();

    if (transactionIds.length > 0) {
      const linkedInvestmentTxs =
        await this.investmentTransactionsRepository.find({
          where: { transactionId: In(transactionIds) },
          select: ["id", "transactionId"],
        });

      for (const invTx of linkedInvestmentTxs) {
        if (invTx.transactionId) {
          investmentLinkMap.set(invTx.transactionId, invTx.id);
        }
      }
    }

    return data.map((tx) => ({
      ...tx,
      isCleared: tx.isCleared,
      isReconciled: tx.isReconciled,
      isVoid: tx.isVoid,
      linkedInvestmentTransactionId: investmentLinkMap.get(tx.id) || null,
    }));
  }

  async findOne(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.transactionsRepository.findOne({
      where: { id, userId },
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
    });

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
    const oldAmount = Number(transaction.amount);
    const oldAccountId = transaction.accountId;
    const oldTransactionDate = transaction.transactionDate;
    const oldStatus = transaction.status;
    const wasVoid = oldStatus === TransactionStatus.VOID;

    const { splits, tagIds, createdAt, ...updateData } = updateTransactionDto;

    if (updateData.accountId && updateData.accountId !== oldAccountId) {
      await this.accountsService.findOne(userId, updateData.accountId);
    }

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
    if ("categoryId" in updateData && updateData.categoryId) {
      const cat = await this.categoriesRepository.findOne({
        where: { id: updateData.categoryId, userId },
      });
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (splits !== undefined) {
        if (Array.isArray(splits) && splits.length > 0) {
          await this.splitService.deleteSplitSideEffects(
            id,
            userId,
            queryRunner,
          );
          await queryRunner.manager.delete(TransactionSplit, {
            transactionId: id,
          });

          const accountId = updateData.accountId ?? transaction.accountId;
          const txDate =
            updateData.transactionDate ?? transaction.transactionDate;
          const savedSplits = await this.splitService.createSplits(
            id,
            splits,
            userId,
            accountId,
            new Date(txDate),
            updateData.payeeName ?? transaction.payeeName,
            queryRunner,
          );

          // Set split-level tags
          if (savedSplits) {
            for (let i = 0; i < splits.length; i++) {
              const splitTagIds = splits[i].tagIds;
              if (splitTagIds && splitTagIds.length > 0 && savedSplits[i]) {
                await this.tagsService.setSplitTags(
                  savedSplits[i].id,
                  splitTagIds,
                  userId,
                  queryRunner,
                );
              }
            }
          }
        } else if (Array.isArray(splits) && splits.length === 0) {
          await this.splitService.deleteSplitSideEffects(
            id,
            userId,
            queryRunner,
          );
          await queryRunner.manager.delete(TransactionSplit, {
            transactionId: id,
          });
          await queryRunner.manager.update(Transaction, id, {
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
      if ("currencyCode" in updateData)
        transactionUpdateData.currencyCode = updateData.currencyCode;
      if ("exchangeRate" in updateData)
        transactionUpdateData.exchangeRate = updateData.exchangeRate;
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
        await queryRunner.query(
          `UPDATE transactions SET created_at = $1 WHERE id = $2`,
          [utc, id],
        );
      }

      if (splits && splits.length > 0) {
        transactionUpdateData.categoryId = null;
        transactionUpdateData.isSplit = true;
      }

      if (Object.keys(transactionUpdateData).length > 0) {
        await queryRunner.manager.update(
          Transaction,
          id,
          transactionUpdateData,
        );
      }

      // Update transaction-level tags
      if (tagIds !== undefined) {
        await this.tagsService.setTransactionTags(
          id,
          tagIds,
          userId,
          queryRunner,
        );
      }

      const savedTransaction = await queryRunner.manager.findOne(Transaction, {
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
      const oldIsFuture = isTransactionInFuture(oldTransactionDate);
      const newIsFuture = isTransactionInFuture(
        savedTransaction.transactionDate,
      );
      const anyFuture = oldIsFuture || newIsFuture;

      if (anyFuture) {
        const affectedAccounts = new Set([oldAccountId, newAccountId]);
        for (const accId of affectedAccounts) {
          await this.accountsService.recalculateCurrentBalance(
            accId,
            queryRunner,
          );
        }
      } else if (wasVoid && !isVoid) {
        await this.accountsService.updateBalance(
          newAccountId,
          newAmount,
          queryRunner,
        );
      } else if (!wasVoid && isVoid) {
        await this.accountsService.updateBalance(
          oldAccountId,
          -oldAmount,
          queryRunner,
        );
      } else if (!wasVoid && !isVoid) {
        if (newAccountId !== oldAccountId) {
          await this.accountsService.updateBalance(
            oldAccountId,
            -oldAmount,
            queryRunner,
          );
          await this.accountsService.updateBalance(
            newAccountId,
            newAmount,
            queryRunner,
          );
        } else if (newAmount !== oldAmount) {
          const balanceChange = newAmount - oldAmount;
          await this.accountsService.updateBalance(
            newAccountId,
            balanceChange,
            queryRunner,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    const finalTransaction = await this.findOne(userId, id);

    this.netWorthService.triggerDebouncedRecalc(
      finalTransaction.accountId,
      userId,
    );
    if (oldAccountId !== finalTransaction.accountId) {
      this.netWorthService.triggerDebouncedRecalc(oldAccountId, userId);
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
        amount: formatCurrency(
          Number(finalTransaction.amount),
          finalTransaction.currencyCode,
        ),
      },
    });
    return finalTransaction;
  }

  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);
    const beforeSnapshot = this.snapshotTransaction(transaction);
    const accountId = transaction.accountId;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (transaction.isSplit) {
        await this.splitService.deleteSplitSideEffects(id, userId, queryRunner);
      }

      const parentSplit = await queryRunner.manager.findOne(TransactionSplit, {
        where: { linkedTransactionId: id },
      });

      if (parentSplit) {
        await this.removeParentTransaction(
          parentSplit,
          id,
          queryRunner,
          userId,
        );
      }

      if (transaction.status !== TransactionStatus.VOID) {
        if (isTransactionInFuture(transaction.transactionDate)) {
          await queryRunner.manager.remove(transaction);
          await this.accountsService.recalculateCurrentBalance(
            accountId,
            queryRunner,
          );
          await queryRunner.commitTransaction();
          this.netWorthService.triggerDebouncedRecalc(accountId, userId);
          this.recordTransactionAction(
            userId,
            { ...transaction, ...beforeSnapshot } as Transaction,
            "delete",
            beforeSnapshot,
          );
          return;
        } else {
          await this.accountsService.updateBalance(
            accountId,
            -Number(transaction.amount),
            queryRunner,
          );
        }
      }

      await queryRunner.manager.remove(transaction);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    this.recordTransactionAction(
      userId,
      { ...transaction, ...beforeSnapshot } as Transaction,
      "delete",
      beforeSnapshot,
    );
  }

  private async removeParentTransaction(
    parentSplit: TransactionSplit,
    linkedTransactionId: string,
    queryRunner: QueryRunner,
    userId: string,
  ): Promise<void> {
    const parentTransactionId = parentSplit.transactionId;
    const parentTransaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: parentTransactionId, userId },
    });

    if (parentTransaction) {
      const allSplits = await queryRunner.manager.find(TransactionSplit, {
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
        const linkedTxs = await queryRunner.manager.find(Transaction, {
          where: { id: In(linkedIds), userId },
        });

        for (const linkedTx of linkedTxs) {
          const linkedAccId = linkedTx.accountId;
          const linkedIsFuture = isTransactionInFuture(
            linkedTx.transactionDate,
          );
          if (!linkedIsFuture) {
            await this.accountsService.updateBalance(
              linkedAccId,
              -Number(linkedTx.amount),
              queryRunner,
            );
          }
          await queryRunner.manager.remove(linkedTx);
          if (linkedIsFuture) {
            await this.accountsService.recalculateCurrentBalance(
              linkedAccId,
              queryRunner,
            );
          }
        }
      }

      await queryRunner.manager.remove(allSplits);

      if (parentTransaction.status !== TransactionStatus.VOID) {
        if (isTransactionInFuture(parentTransaction.transactionDate)) {
          await queryRunner.manager.remove(parentTransaction);
          await this.accountsService.recalculateCurrentBalance(
            parentTransaction.accountId,
            queryRunner,
          );
          return;
        }
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          -Number(parentTransaction.amount),
          queryRunner,
        );
      }
      await queryRunner.manager.remove(parentTransaction);
    }
  }

  // Delegated methods

  async updateStatus(
    userId: string,
    id: string,
    status: TransactionStatus,
  ): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.updateStatus(
      transaction,
      status,
      userId,
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
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.markCleared(
      transaction,
      isCleared,
      userId,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async reconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.reconcile(
      transaction,
      userId,
      (accountId: string, userId: string) =>
        this.netWorthService.triggerDebouncedRecalc(accountId, userId),
      this.findOne.bind(this),
    );
  }

  async unreconcile(userId: string, id: string): Promise<Transaction> {
    const transaction = await this.findOne(userId, id);
    return this.reconciliationService.unreconcile(
      transaction,
      userId,
      this.findOne.bind(this),
    );
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
    );
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

  async getRecurringCharges(
    userId: string,
    startDate: string,
    endDate: string,
    payeeIds: string[],
  ) {
    return this.analyticsService.getRecurringCharges(
      userId,
      startDate,
      endDate,
      { payeeIds },
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
    );
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
  ): Promise<TransferResult> {
    const result = await this.transferService.createTransfer(
      userId,
      createTransferDto,
      this.findOne.bind(this),
    );

    if (createTransferDto.tagIds && createTransferDto.tagIds.length > 0) {
      await this.tagsService.setTransactionTags(
        result.fromTransaction.id,
        createTransferDto.tagIds,
        userId,
      );
      await this.tagsService.setTransactionTags(
        result.toTransaction.id,
        createTransferDto.tagIds,
        userId,
      );

      return {
        fromTransaction: await this.findOne(userId, result.fromTransaction.id),
        toTransaction: await this.findOne(userId, result.toTransaction.id),
      };
    }

    return result;
  }

  async getLinkedTransaction(
    userId: string,
    transactionId: string,
  ): Promise<Transaction | null> {
    return this.transferService.getLinkedTransaction(
      userId,
      transactionId,
      this.findOne.bind(this),
    );
  }

  async removeTransfer(userId: string, transactionId: string): Promise<void> {
    return this.transferService.removeTransfer(
      userId,
      transactionId,
      this.findOne.bind(this),
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

  async updateTransfer(
    userId: string,
    transactionId: string,
    updateDto: Partial<UpdateTransferDto>,
  ): Promise<TransferResult> {
    const result = await this.transferService.updateTransfer(
      userId,
      transactionId,
      updateDto,
      this.findOne.bind(this),
    );

    if (updateDto.tagIds !== undefined) {
      await this.tagsService.setTransactionTags(
        result.fromTransaction.id,
        updateDto.tagIds,
        userId,
      );
      await this.tagsService.setTransactionTags(
        result.toTransaction.id,
        updateDto.tagIds,
        userId,
      );

      return {
        fromTransaction: await this.findOne(userId, result.fromTransaction.id),
        toTransaction: await this.findOne(userId, result.toTransaction.id),
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
        amount: formatCurrency(Number(tx.amount), tx.currencyCode),
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

    const transactions = result.data.flatMap((t): LlmTransactionRow[] => {
      const rows: LlmTransactionRow[] =
        t.isSplit && Array.isArray(t.splits) && t.splits.length > 0
          ? t.splits.map((s) => ({
              id: t.id,
              splitId: s.id,
              date: t.transactionDate,
              payeeName: t.payeeName,
              categoryName: s.category?.name,
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
                payeeName: t.payeeName,
                categoryName: t.category?.name,
                amount: Number(t.amount),
                accountName: t.account?.name,
                description: t.description,
                status: t.status,
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
}
