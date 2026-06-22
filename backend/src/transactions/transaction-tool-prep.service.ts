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
} from "../ai/actions/ai-action.types";
import {
  transactionPreviewRow,
  transferPreviewRow,
} from "../ai/actions/ai-action-builder.service";
import { BulkCreateSkip, bulkSkipReason } from "../common/bulk-create.types";
import { didYouMean } from "../common/name-suggestions.util";
import { tr } from "../i18n/translate";

/** One category-split line on a create/update row (names; resolved internally). */
export interface SplitLineInput {
  categoryName: string;
  amount: number;
  memo?: string;
}

/** Standard create-row input (names; resolved internally). */
export interface CreateRowInput {
  accountName: string;
  amount: number;
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

/** Update-row input (names; resolved internally; >=1 mutable field). */
export interface UpdateRowInput {
  transactionId: string;
  amount?: number;
  date?: string;
  payeeName?: string;
  categoryName?: string;
  description?: string;
  createPayeeIfMissing?: boolean;
  /** Category splits; when present the transaction's split set is replaced. */
  splits?: SplitLineInput[];
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
  ) {}

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
      });
    }
    // Reuse the domain sum/sign validation so the preview rejects bad splits
    // the same way the REST endpoint and confirm step would.
    const dtos = resolved.map<CreateTransactionSplitDto>((s) => ({
      categoryId: s.categoryId,
      amount: s.amount,
      memo: s.memo ?? undefined,
    }));
    this.splitService.validateSplits(dtos, transactionAmount);
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
    const splits = row.splits
      ? await this.resolveSplits(userId, row.splits, row.amount)
      : undefined;
    let categoryId: string | undefined;
    if (!splits && row.categoryName) {
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
    });
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

    if (this.transferService.isTransfer(existing)) {
      if (item.splits) {
        throw new BadRequestException(
          "A transfer cannot be converted into a split transaction.",
        );
      }
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
      return { kind: "transfer", preview };
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
      },
    );
    // Validate splits against the effective amount the edit will leave on the
    // transaction (preview.amount reflects item.amount or the existing value).
    const splits = item.splits
      ? await this.resolveSplits(userId, item.splits, preview.amount)
      : undefined;
    return { kind: "standard", preview, createPayee, splits };
  }

  /** Preview a single delete (works for standard, split, and transfer). */
  async prepareDelete(
    userId: string,
    transactionId: string,
  ): Promise<DeleteTransactionPreview> {
    return this.transactionsService.previewDelete(userId, transactionId);
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
        okRows.push({
          transactionId: preview.transactionId,
          accountId: preview.accountId,
          amount: preview.amount,
          transactionDate: preview.transactionDate,
          payeeId: preview.payeeId,
          payeeName: preview.payeeName,
          createPayee: preview.payeeWillBeCreated,
          categoryId: preview.categoryId,
          description: preview.description,
          currencyCode: preview.currencyCode,
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
          categoryName: preview.categoryName,
          description: preview.description,
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
