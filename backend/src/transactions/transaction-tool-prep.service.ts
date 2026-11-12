import {
  Injectable,
  Inject,
  forwardRef,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { AccountsService } from "../accounts/accounts.service";
import {
  TransactionsService,
  CreateTransactionPreview,
  UpdateTransactionPreview,
  DeleteTransactionPreview,
} from "./transactions.service";
import {
  TransactionTransferService,
  CreateTransferPreview,
  UpdateTransferPreview,
} from "./transaction-transfer.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { TransactionSplitService } from "./transaction-split.service";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import {
  AiActionPreviewRow,
  BatchUpdateTransactionRow,
  BatchDeleteTransactionRow,
  BatchCreateTransferRow,
  ResolvedSplitLine,
  toSplitRowDescriptor,
  toSplitPreview,
} from "../ai/actions/ai-action.types";
import {
  transactionPreviewRow,
  transferPreviewRow,
} from "../ai/actions/ai-action-builder.service";
import { BulkCreateSkip, bulkSkipReason } from "../common/bulk-create.types";
import { didYouMean } from "../common/name-suggestions.util";
import { tr } from "../i18n/translate";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { resolveFxRateOrNull } from "../common/fx-entry.util";
import { ForeignEntryRequest } from "../common/foreign-entry.util";
import {
  ForeignEntryPreviewRequest,
  foreignEntryDisplayFields,
  foreignEntryWriteFields,
} from "./foreign-entry-preview";
import { carrySplitTags } from "./split-tag-carry.util";
import {
  splitTagChangeDisplayFields,
  splitTagChangeWriteFields,
  tagChangeDisplayFields,
  tagChangeFields,
  tagChangeWriteFields,
} from "../tags/tag-change.util";

/** One category-split line on a create/update row (names; resolved internally). */
export interface SplitLineInput {
  categoryName: string;
  amount: number;
  memo?: string;
  /**
   * Update only: the existing line this one continues (a read tool's
   * `splitId`), whose tags it keeps. Without it a line keeps the tags of an
   * existing line of the same category (`carrySplitTags`).
   */
  splitId?: string;
  /** `"ai"` marks a category the AI chose, on the confirmation card only. */
  categorySource?: "ai";
}

/**
 * Standard create-row input (names; resolved internally). A foreign-currency
 * entry gives `originalAmount` and `originalCurrencyCode`, with `amount` (what
 * the account was charged), `exchangeRate`, both or neither
 * (`resolveForeignEntry`); `amount` is then optional.
 */
export interface CreateRowInput extends ForeignEntryRequest {
  accountName: string;
  amount?: number;
  date: string;
  payeeName?: string;
  categoryName?: string;
  description?: string;
  createPayeeIfMissing?: boolean;
  /** Category splits; when present the transaction is created as a split. */
  splits?: SplitLineInput[];
}

/** Transfer create-row input (names; resolved internally). */
export interface TransferRowInput {
  /**
   * Refused on a transfer, whose legs each carry their own account's currency:
   * accepted here only so the refusal can name them instead of dropping them.
   */
  originalAmount?: number;
  originalCurrencyCode?: string;
  fromAccountName: string;
  toAccountName: string;
  amount: number;
  date: string;
  description?: string;
  payeeName?: string;
  categoryName?: string;
  createPayeeIfMissing?: boolean;
  exchangeRate?: number;
  toAmount?: number;
}

/**
 * Update-row input (names; resolved internally; >=1 mutable field). The
 * foreign-currency fields change the row's entry, its own figures filling in
 * the rest; the account's own currency as `originalCurrencyCode` clears it.
 */
export interface UpdateRowInput extends ForeignEntryRequest {
  transactionId: string;
  amount?: number;
  date?: string;
  payeeName?: string;
  categoryName?: string;
  description?: string;
  createPayeeIfMissing?: boolean;
  /** Category splits; when present the transaction's split set is replaced. */
  splits?: SplitLineInput[];
  /**
   * Tag names to ADD (created at confirm when missing); the tags the row
   * carries stay. Sent by `manage_transactions` (`addTagNames`) and by the
   * review queue from an email-receipt profile's `tag`. On a transfer both
   * legs get them.
   */
  tagNames?: string[];
  /**
   * Tag names to REMOVE; a name the row does not carry is no change, one the
   * user has no tag for is refused. On a transfer, from both legs.
   */
  removeTagNames?: string[];
  /**
   * Tag changes on existing split lines of a split transaction, by the
   * `splitId` a read tool returned: names to add (created at confirm when
   * missing) and remove on that line only; the line's amount, category and
   * other tags stay. Not with `splits` (a replaced line keeps its tags by its
   * `splitId`), and not on a transfer.
   */
  splitTags?: {
    splitId: string;
    addTagNames?: string[];
    removeTagNames?: string[];
  }[];
  /**
   * The reference number ("Ref #") to set. Set by the review queue from an
   * email receipt's order number; the chat and MCP tools do not send it.
   * Standard edits only: a transfer ignores it.
   */
  referenceNumber?: string;
  /** `"ai"` marks `categoryName` as chosen by the AI, on the confirmation card only. */
  categorySource?: "ai";
}

export interface PrepareCreateResult {
  okPreviews: CreateTransactionPreview[];
  okCreatePayee: boolean[];
  okIndex: number[];
  previewRows: AiActionPreviewRow[];
  skipped: { index: number; reason: string }[];
}

export interface PrepareCreateTransferResult {
  okPreviews: CreateTransferPreview[];
  okIndex: number[];
  previewRows: AiActionPreviewRow[];
  skipped: { index: number; reason: string }[];
}

/** Single update result: either a standard edit or a transfer edit. */
export type PrepareUpdateResult =
  | {
      kind: "standard";
      preview: UpdateTransactionPreview;
      createPayee: boolean;
      /** Resolved category splits when the edit replaces the split set. */
      splits?: ResolvedSplitLine[];
    }
  | { kind: "transfer"; preview: UpdateTransferPreview };

export interface PrepareUpdateBulkResult {
  okRows: BatchUpdateTransactionRow[];
  previewRows: AiActionPreviewRow[];
  okIndex: number[];
  skipped: BulkCreateSkip[];
}

export interface PrepareDeleteBulkResult {
  okRows: BatchDeleteTransactionRow[];
  previewRows: AiActionPreviewRow[];
  okIndex: number[];
  skipped: BulkCreateSkip[];
}

/**
 * Shared name-resolution + preview-building for the unified `manage_transactions`
 * tool. Both tool surfaces (AI Assistant tool executor and MCP server) delegate
 * here so they stay thin adapters with identical behaviour (CLAUDE.md repo rule).
 *
 * Single-item resolution failures throw an HttpException (4xx) so the surfaces
 * map them to user-facing messages exactly as they already do; bulk variants are
 * best-effort, collecting per-row skips instead of aborting the batch.
 */
@Injectable()
export class TransactionToolPrepService {
  private readonly logger = new Logger(TransactionToolPrepService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    private readonly transferService: TransactionTransferService,
    @Inject(forwardRef(() => TransactionAnalyticsService))
    private readonly analyticsService: TransactionAnalyticsService,
    private readonly splitService: TransactionSplitService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * A row's foreign-currency figures for `previewCreate` / `previewUpdate`,
   * with the market-rate lookup used when the caller gave neither the amount
   * charged nor a rate; `undefined` when the row names none.
   */
  private foreignEntryOf(
    row: ForeignEntryRequest,
  ): ForeignEntryPreviewRequest | undefined {
    if (
      row.originalAmount === undefined &&
      row.originalCurrencyCode === undefined &&
      row.exchangeRate === undefined
    ) {
      return undefined;
    }
    return {
      originalAmount: row.originalAmount,
      originalCurrencyCode: row.originalCurrencyCode,
      exchangeRate: row.exchangeRate,
      lookupRate: (from, to, date) =>
        resolveFxRateOrNull(this.exchangeRateService, from, to, date),
    };
  }

  /**
   * A transfer moves money between two accounts, each leg in its own
   * account's currency; a cross-currency one takes `exchangeRate` or
   * `toAmount`, never a foreign entry. Refused rather than dropped.
   */
  private assertNoForeignEntryOnTransfer(row: {
    originalAmount?: number;
    originalCurrencyCode?: string;
  }): void {
    if (
      row.originalAmount !== undefined ||
      row.originalCurrencyCode !== undefined
    ) {
      throw new BadRequestException(
        tr(
          "errors.transactions.fxEntryNotOnTransfer",
          "originalAmount and originalCurrencyCode are for a transaction in one account. A transfer between accounts in different currencies takes exchangeRate or toAmount when it is created.",
        ),
      );
    }
  }

  private async resolveCategoryId(
    userId: string,
    categoryName: string,
  ): Promise<string | null> {
    const resolved = await this.analyticsService.resolveLlmCategoryIds(userId, [
      categoryName,
    ]);
    return resolved.categoryIds[0] ?? null;
  }

  /**
   * Resolve each split line's category name to an id and validate that the
   * lines sum to `transactionAmount` (reusing the domain rule). Category splits
   * only -- the tool does not expose transfer/investment splits. Throws on an
   * unknown category or an invalid sum so the single-card path surfaces a 4xx.
   */
  private async resolveSplits(
    userId: string,
    splits: SplitLineInput[],
    transactionAmount: number,
    /** The parent account's currency: the lines are held to its places. */
    currencyCode: string,
  ): Promise<ResolvedSplitLine[]> {
    const resolved: ResolvedSplitLine[] = [];
    for (const line of splits) {
      const categoryId = await this.resolveCategoryId(
        userId,
        line.categoryName,
      );
      if (!categoryId) throw this.unknownCategoryError(line.categoryName);
      resolved.push({
        categoryId,
        categoryName: line.categoryName,
        amount: line.amount,
        memo: line.memo ?? null,
        ...(line.categorySource === "ai"
          ? { categorySource: "ai" as const }
          : {}),
      });
    }
    // Reuse the domain sum/sign validation so the preview rejects bad splits
    // the same way the REST endpoint and confirm step would.
    const dtos = resolved.map<CreateTransactionSplitDto>((s) => ({
      categoryId: s.categoryId,
      amount: s.amount,
      memo: s.memo ?? undefined,
    }));
    await this.splitService.validateSplitsInCurrency(
      dtos,
      transactionAmount,
      currencyCode,
    );
    return resolved;
  }

  private unknownCategoryError(categoryName: string): NotFoundException {
    return new NotFoundException(
      `Unknown category: ${categoryName}. Call list_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
    );
  }

  /**
   * Build a "did you mean" fragment for an account name that failed to resolve,
   * so the model can self-correct without a separate list_accounts round trip.
   * Loaded only on the failure path (rare), so the extra query is cheap.
   */
  private async accountSuggestion(
    userId: string,
    name: string,
  ): Promise<string> {
    // Best-effort: a suggestion lookup must never break the underlying
    // "unknown account" error, so swallow any failure and offer no hint.
    try {
      const accounts = await this.accountsService.findAll(userId, true);
      return didYouMean(
        name,
        accounts.map((a) => a.name),
      );
    } catch {
      return "";
    }
  }

  /**
   * Resolve + preview each standard create row best-effort. Mirrors the logic
   * that previously lived in ToolExecutorService.createTransactionsAction and the
   * MCP create_transactions handler -- this method replaces that duplication.
   */
  async prepareCreate(
    userId: string,
    rows: CreateRowInput[],
  ): Promise<PrepareCreateResult> {
    const okPreviews: CreateTransactionPreview[] = [];
    const okCreatePayee: boolean[] = [];
    const okIndex: number[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const skipped: { index: number; reason: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const createPayeeIfMissing = row.createPayeeIfMissing ?? true;
      const base: AiActionPreviewRow = {
        status: "error",
        accountName: row.accountName,
        amount: row.amount,
        transactionDate: row.date,
        payeeName: row.payeeName ?? null,
        categoryName: row.categoryName ?? null,
        description: row.description ?? null,
        ...(row.originalCurrencyCode !== undefined
          ? {
              originalAmount: row.originalAmount ?? null,
              originalCurrencyCode: row.originalCurrencyCode,
            }
          : {}),
      };

      const account = await this.accountsService.resolveByName(
        userId,
        row.accountName,
      );
      if (!account) {
        const reason = `Unknown account: ${row.accountName}`;
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
        continue;
      }

      let categoryId: string | undefined;
      if (row.categoryName) {
        const resolved = await this.resolveCategoryId(userId, row.categoryName);
        if (!resolved) {
          const reason = `Unknown category: ${row.categoryName}`;
          skipped.push({ index: i, reason });
          previewRows.push({ ...base, error: reason });
          continue;
        }
        categoryId = resolved;
      }

      try {
        const preview = await this.transactionsService.previewCreate(userId, {
          accountId: account.id,
          amount: row.amount,
          transactionDate: row.date,
          payeeName: row.payeeName,
          categoryId,
          description: row.description,
          createPayeeIfMissing,
          foreignEntry: this.foreignEntryOf(row),
        });
        okPreviews.push(preview);
        okCreatePayee.push(createPayeeIfMissing);
        okIndex.push(i);
        previewRows.push(transactionPreviewRow(preview));
      } catch (err) {
        const reason = bulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
      }
    }

    return { okPreviews, okCreatePayee, okIndex, previewRows, skipped };
  }

  /** Resolve + preview each transfer create row best-effort. */
  async prepareCreateTransfer(
    userId: string,
    rows: TransferRowInput[],
  ): Promise<PrepareCreateTransferResult> {
    const okPreviews: CreateTransferPreview[] = [];
    const okIndex: number[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const skipped: { index: number; reason: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const base: AiActionPreviewRow = {
        status: "error",
        accountName: row.fromAccountName,
        fromAccountName: row.fromAccountName,
        toAccountName: row.toAccountName,
        amount: row.amount,
        transactionDate: row.date,
        description: row.description ?? null,
        payeeName: row.payeeName ?? null,
        categoryName: row.categoryName ?? null,
      };

      const fromAccount = await this.accountsService.resolveByName(
        userId,
        row.fromAccountName,
      );
      if (!fromAccount) {
        const reason = `Unknown account: ${row.fromAccountName}`;
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
        continue;
      }
      const toAccount = await this.accountsService.resolveByName(
        userId,
        row.toAccountName,
      );
      if (!toAccount) {
        const reason = `Unknown account: ${row.toAccountName}`;
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
        continue;
      }

      let categoryId: string | undefined;
      if (row.categoryName) {
        const resolved = await this.resolveCategoryId(userId, row.categoryName);
        if (!resolved) {
          const reason = `Unknown category: ${row.categoryName}`;
          skipped.push({ index: i, reason });
          previewRows.push({ ...base, error: reason });
          continue;
        }
        categoryId = resolved;
      }

      try {
        this.assertNoForeignEntryOnTransfer(row);
        const preview = await this.transferService.previewCreateTransfer(
          userId,
          {
            fromAccountId: fromAccount.id,
            toAccountId: toAccount.id,
            amount: row.amount,
            transactionDate: row.date,
            exchangeRate: row.exchangeRate,
            toAmount: row.toAmount,
            description: row.description,
            payeeName: row.payeeName,
            createPayeeIfMissing: row.createPayeeIfMissing ?? true,
            categoryId,
          },
        );
        okPreviews.push(preview);
        okIndex.push(i);
        previewRows.push(transferPreviewRow(preview));
      } catch (err) {
        const reason = bulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
      }
    }

    return { okPreviews, okIndex, previewRows, skipped };
  }

  /**
   * Resolve + preview a single create transfer row, throwing on failure (single
   * card path).
   */
  async prepareCreateTransferSingle(
    userId: string,
    row: TransferRowInput,
  ): Promise<CreateTransferPreview> {
    this.assertNoForeignEntryOnTransfer(row);
    const fromAccount = await this.accountsService.resolveByName(
      userId,
      row.fromAccountName,
    );
    if (!fromAccount) {
      throw new NotFoundException(
        `Unknown account: ${row.fromAccountName}.${await this.accountSuggestion(userId, row.fromAccountName)} Use an exact name from the user's account list.`,
      );
    }
    const toAccount = await this.accountsService.resolveByName(
      userId,
      row.toAccountName,
    );
    if (!toAccount) {
      throw new NotFoundException(
        `Unknown account: ${row.toAccountName}.${await this.accountSuggestion(userId, row.toAccountName)} Use an exact name from the user's account list.`,
      );
    }
    let categoryId: string | undefined;
    if (row.categoryName) {
      const resolved = await this.resolveCategoryId(userId, row.categoryName);
      if (!resolved) throw this.unknownCategoryError(row.categoryName);
      categoryId = resolved;
    }
    return this.transferService.previewCreateTransfer(userId, {
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      amount: row.amount,
      transactionDate: row.date,
      exchangeRate: row.exchangeRate,
      toAmount: row.toAmount,
      description: row.description,
      payeeName: row.payeeName,
      createPayeeIfMissing: row.createPayeeIfMissing ?? true,
      categoryId,
    });
  }

  /**
   * Resolve + preview a single create row, throwing on failure (single card).
   */
  async prepareCreateSingle(
    userId: string,
    row: CreateRowInput,
  ): Promise<{
    preview: CreateTransactionPreview;
    createPayee: boolean;
    splits?: ResolvedSplitLine[];
  }> {
    const createPayee = row.createPayeeIfMissing ?? true;
    const account = await this.accountsService.resolveByName(
      userId,
      row.accountName,
    );
    if (!account) {
      throw new NotFoundException(
        `Unknown account: ${row.accountName}.${await this.accountSuggestion(userId, row.accountName)} Use an exact name from the user's account list.`,
      );
    }
    // A split row carries its categories in the splits array; the parent has no
    // single category.
    let categoryId: string | undefined;
    if (!row.splits && row.categoryName) {
      const resolved = await this.resolveCategoryId(userId, row.categoryName);
      if (!resolved) throw this.unknownCategoryError(row.categoryName);
      categoryId = resolved;
    }
    const preview = await this.transactionsService.previewCreate(userId, {
      accountId: account.id,
      amount: row.amount,
      transactionDate: row.date,
      payeeName: row.payeeName,
      categoryId,
      description: row.description,
      createPayeeIfMissing: createPayee,
      hasSplits: !!row.splits,
      foreignEntry: this.foreignEntryOf(row),
    });
    // The lines sum to the amount the row will store, which a foreign entry
    // may have worked out.
    const splits = row.splits
      ? await this.resolveSplits(
          userId,
          row.splits,
          preview.amount,
          account.currencyCode,
        )
      : undefined;
    return { preview, createPayee, splits };
  }

  /**
   * Resolve + preview a single update, auto-detecting a transfer. Throws on
   * failure (single card path / single-item resolution failure).
   */
  async prepareUpdate(
    userId: string,
    item: UpdateRowInput,
  ): Promise<PrepareUpdateResult> {
    const existing = await this.transactionsService.findOne(
      userId,
      item.transactionId,
    );

    if (item.splitTags?.length && item.splits) {
      throw new BadRequestException(
        tr(
          "errors.tags.splitTagsWithSplits",
          "splitTags cannot be sent with splits. A replaced line keeps its tags when it names its splitId; change the lines' tags in a separate edit.",
        ),
      );
    }
    if (this.transferService.isTransfer(existing)) {
      this.assertNoForeignEntryOnTransfer(item);
      // The transfer edit takes no rate, so one sent would be dropped while the
      // model reports it changed.
      if (item.exchangeRate !== undefined) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferRateNotEditable",
            "A transfer's exchange rate cannot be changed here. Edit the transfer from the Transactions screen to change its rate.",
          ),
        );
      }
      if (item.splits) {
        throw new BadRequestException(
          "A transfer cannot be converted into a split transaction.",
        );
      }
      if (item.splitTags?.length) {
        throw new BadRequestException(
          tr(
            "errors.tags.splitTagsNotSplit",
            "splitTags changes the tags on a split transaction's lines, and this transaction is not split. Use addTagNames and removeTagNames for its own tags.",
          ),
        );
      }
      await this.assertNotCrossOwnerTransfer(userId, existing);
      // A transfer carries an optional spending category on both legs (the web
      // UI supports this). Resolve a provided category name to an id so the
      // edit persists it, matching the standard-transaction path.
      let categoryId: string | null | undefined;
      if (item.categoryName !== undefined) {
        if (item.categoryName) {
          const resolved = await this.resolveCategoryId(
            userId,
            item.categoryName,
          );
          if (!resolved) throw this.unknownCategoryError(item.categoryName);
          categoryId = resolved;
        } else {
          categoryId = null;
        }
      }
      const preview = await this.transferService.previewUpdateTransfer(
        userId,
        item.transactionId,
        {
          amount: item.amount,
          transactionDate: item.date,
          description: item.description,
          payeeName: item.payeeName,
          createPayeeIfMissing: item.createPayeeIfMissing ?? true,
          categoryId,
        },
        this.transactionsService.findOne.bind(this.transactionsService),
      );
      const tagChange = await this.transactionsService.previewTransferTagChange(
        userId,
        item.transactionId,
        item.tagNames ?? [],
        item.removeTagNames ?? [],
      );
      // An edit that asked only for tags the transfer already has (or does not
      // have) changes nothing: refused like the standard path, never offered as
      // a card that rewrites the transfer from this snapshot.
      const fieldChange = preview.changesFields !== false;
      const tagChanges =
        tagChange.tagNames.length > 0 || tagChange.removeTagIds.length > 0;
      const askedForTags =
        (item.tagNames?.length ?? 0) > 0 ||
        (item.removeTagNames?.length ?? 0) > 0;
      if (!fieldChange && askedForTags && !tagChanges) {
        throw new BadRequestException(
          tr(
            "errors.tags.nothingToChange",
            "Nothing to change: the transaction already carries every tag to add and none of the tags to remove. Tags on split lines change only through splitTags.",
          ),
        );
      }
      return {
        kind: "transfer",
        preview: {
          ...preview,
          ...tagChangeFields(tagChange),
          ...(tagChanges && !fieldChange ? { tagsOnly: true as const } : {}),
        },
      };
    }

    const createPayee = item.createPayeeIfMissing ?? true;
    let categoryId: string | undefined;
    if (item.splits === undefined && item.categoryName !== undefined) {
      const resolved = await this.resolveCategoryId(userId, item.categoryName);
      if (!resolved) throw this.unknownCategoryError(item.categoryName);
      categoryId = resolved;
    }
    const preview = await this.transactionsService.previewUpdate(
      userId,
      item.transactionId,
      {
        amount: item.amount,
        transactionDate: item.date,
        payeeName: item.payeeName,
        categoryId,
        description: item.description,
        createPayeeIfMissing: createPayee,
        // A complete replacement splits array accompanies this edit; on an
        // existing split transaction this is what permits a category or
        // amount change (Truth table B).
        splitsAccompany: item.splits !== undefined,
        tagNames: item.tagNames,
        removeTagNames: item.removeTagNames,
        splitTags: item.splitTags?.map((line) => ({
          splitId: line.splitId,
          addNames: line.addTagNames,
          removeNames: line.removeTagNames,
        })),
        referenceNumber: item.referenceNumber,
        foreignEntry: this.foreignEntryOf(item),
      },
    );
    // Validate splits against the effective amount the edit will leave on the
    // transaction (preview.amount reflects item.amount or the existing value).
    const resolved = item.splits
      ? await this.resolveSplits(
          userId,
          item.splits,
          preview.amount,
          preview.currencyCode,
        )
      : undefined;
    // Replacing the set deletes the old lines: each new line keeps the tags of
    // the line it continues, or they would be lost with it.
    const splits =
      resolved && item.splits
        ? this.withCarriedSplitTags(existing, resolved, item.splits)
        : undefined;
    return {
      kind: "standard",
      preview:
        item.categorySource === "ai" && categoryId !== undefined
          ? { ...preview, categorySource: "ai" }
          : preview,
      createPayee,
      splits,
    };
  }

  private withCarriedSplitTags(
    existing: { splits?: TransactionSplit[] | null },
    resolved: ResolvedSplitLine[],
    inputs: SplitLineInput[],
  ): ResolvedSplitLine[] {
    const carried = carrySplitTags(
      (existing.splits ?? []).map((line) => ({
        id: line.id,
        categoryId: line.categoryId,
        amount: line.amount,
        tags: line.tags,
      })),
      resolved.map((line, i) => ({
        categoryId: line.categoryId,
        amount: line.amount,
        ...(inputs[i]?.splitId ? { splitId: inputs[i].splitId } : {}),
      })),
    );
    return resolved.map((line, i) => {
      const tags = carried[i];
      return tags
        ? { ...line, tagIds: tags.tagIds, tagNames: tags.tagNames }
        : line;
    });
  }

  /** Preview a single delete (works for standard, split, and transfer). */
  async prepareDelete(
    userId: string,
    transactionId: string,
  ): Promise<DeleteTransactionPreview> {
    const existing = await this.transactionsService.findOne(
      userId,
      transactionId,
    );
    if (this.transferService.isTransfer(existing)) {
      await this.assertNotCrossOwnerTransfer(userId, existing);
    }
    return this.transactionsService.previewDelete(userId, transactionId);
  }

  /**
   * The assistant's transfer edit/delete flows are same-owner only for now: a
   * transfer whose counterpart leg is not the effective user's row is refused
   * with a clear error at preview time, before any confirm descriptor is
   * signed. One check here covers both the AI executor and the MCP server
   * (shared prep service, per the CLAUDE.md shared-AI-tools rule).
   */
  private async assertNotCrossOwnerTransfer(
    userId: string,
    transaction: { linkedTransactionId?: string | null },
  ): Promise<void> {
    if (!transaction.linkedTransactionId) return;
    try {
      await this.transactionsService.findOne(
        userId,
        transaction.linkedTransactionId,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new BadRequestException(
          tr(
            "errors.ai.crossOwnerTransferUnsupported",
            "This transfer involves another user's account, which the assistant can't edit or delete yet. Use the Transactions screen instead.",
          ),
        );
      }
      throw err;
    }
  }

  /**
   * Map an update preview to a batch row descriptor. Transfers are not supported
   * inside a batch_actions(update) envelope -- a bulk update that targets a
   * transfer is skipped with a clear reason.
   */
  async prepareUpdateBulk(
    userId: string,
    items: UpdateRowInput[],
  ): Promise<PrepareUpdateBulkResult> {
    const okRows: BatchUpdateTransactionRow[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const okIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const result = await this.prepareUpdate(userId, item);
        if (result.kind === "transfer") {
          // Editing a transfer needs the dedicated single-card flow; a bulk
          // update envelope only carries standard edits.
          const reason = tr(
            "errors.ai.transferInBulkUpdate",
            "Transfers can't be edited in a bulk update. Edit the transfer on its own.",
          );
          skipped.push({ index: i, reason });
          previewRows.push({
            status: "error",
            transactionDate: item.date ?? undefined,
            error: reason,
          });
          continue;
        }
        const preview = result.preview;
        // A row that replaces a split set carries its resolved lines, so a
        // batch can recategorize several split transactions under one
        // confirmation. Splits and a parent `categoryId` are mutually
        // exclusive, exactly as on the singular descriptor.
        const splits = result.splits;
        okRows.push({
          transactionId: preview.transactionId,
          accountId: preview.accountId,
          amount: preview.amount,
          transactionDate: preview.transactionDate,
          payeeId: preview.payeeId,
          payeeName: preview.payeeName,
          createPayee: preview.payeeWillBeCreated,
          categoryId: splits ? null : preview.categoryId,
          description: preview.description,
          currencyCode: preview.currencyCode,
          ...foreignEntryWriteFields(preview),
          ...(splits ? { splits: splits.map(toSplitRowDescriptor) } : {}),
          ...tagChangeWriteFields(preview),
          ...splitTagChangeWriteFields(preview),
          ...(preview.tagsOnly ? { tagsOnly: true as const } : {}),
        });
        okIndex.push(i);
        previewRows.push({
          status: "ok",
          accountName: preview.accountName,
          amount: preview.amount,
          currencyCode: preview.currencyCode,
          transactionDate: preview.transactionDate,
          payeeName: preview.payeeName,
          payeeWillBeCreated: preview.payeeWillBeCreated,
          // The card shows the split lines instead of a single category name,
          // because that is what the row will write.
          categoryName: splits ? null : preview.categoryName,
          description: preview.description,
          isReconciled: preview.isReconciled,
          ...foreignEntryDisplayFields(preview),
          ...(splits ? { splits: splits.map(toSplitPreview) } : {}),
          ...tagChangeDisplayFields(preview),
          ...splitTagChangeDisplayFields(preview),
        });
      } catch (err) {
        const reason = this.skipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({
          status: "error",
          transactionDate: item.date ?? undefined,
          error: reason,
        });
      }
    }

    return { okRows, previewRows, okIndex, skipped };
  }

  /** Map each delete to a batch row descriptor best-effort. */
  async prepareDeleteBulk(
    userId: string,
    transactionIds: string[],
  ): Promise<PrepareDeleteBulkResult> {
    const okRows: BatchDeleteTransactionRow[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const okIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < transactionIds.length; i++) {
      const transactionId = transactionIds[i];
      try {
        const preview = await this.prepareDelete(userId, transactionId);
        okRows.push({ transactionId });
        okIndex.push(i);
        previewRows.push({
          status: "ok",
          accountName: preview.accountName,
          amount: preview.amount,
          currencyCode: preview.currencyCode,
          transactionDate: preview.transactionDate,
          payeeName: preview.payeeName,
          categoryName: preview.categoryName,
          description: preview.description,
          isReconciled: preview.isReconciled,
        });
      } catch (err) {
        const reason = this.skipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ status: "error", error: reason });
      }
    }

    return { okRows, previewRows, okIndex, skipped };
  }

  /** Map a create-transfer preview to a batch row descriptor. */
  transferToBatchRow(preview: CreateTransferPreview): BatchCreateTransferRow {
    return {
      fromAccountId: preview.fromAccountId,
      toAccountId: preview.toAccountId,
      amount: preview.amount,
      transactionDate: preview.transactionDate,
      fromCurrencyCode: preview.fromCurrencyCode,
      toCurrencyCode: preview.toCurrencyCode,
      exchangeRate: preview.exchangeRate,
      toAmount: preview.toAmount,
      description: preview.description,
      payeeId: preview.payeeId,
      payeeName: preview.payeeName,
      createPayee: preview.payeeWillBeCreated,
      categoryId: preview.categoryId,
    };
  }

  private skipReason(err: unknown): string {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      if (status >= 400 && status < 500) {
        return err.message;
      }
    }
    this.logger.warn(
      `prep failed: ${err instanceof Error ? err.message : err}`,
    );
    return "Could not be prepared.";
  }
}
