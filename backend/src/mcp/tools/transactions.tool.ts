import { Injectable } from "@nestjs/common";
import { describeSkippedRows } from "../../common/bulk-create.types";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { TransactionsService } from "../../transactions/transactions.service";
import { TRANSACTION_SORT_FIELDS } from "../../transactions/register-order";
import { PayeesService } from "../../payees/payees.service";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import {
  TransactionToolPrepService,
  CreateRowInput,
  TransferRowInput,
  UpdateRowInput,
} from "../../transactions/transaction-tool-prep.service";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import {
  ATTACHMENT_URI_SCHEME,
  RelayAttachmentStore,
} from "../../ai/relay/relay-attachment.store";
import { AiActionBuilderService } from "../../ai/actions/ai-action-builder.service";
import {
  ApprovalMode,
  AttachmentRefDescriptor,
  PendingAiAction,
  resolveApprovalMode,
  toSplitDtoRows,
} from "../../ai/actions/ai-action.types";
import {
  AttachmentDto,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENTS,
} from "../../ai/query/dto/ai-query.dto";
import { AttachmentToolPrepService } from "../../attachments/attachment-tool-prep.service";
import { AttachmentsService } from "../../attachments/attachments.service";
import { sniffAttachmentMime } from "../../attachments/attachment-mime.util";
import { withUserContext } from "../../common/db/with-context";
import { RELAY_PREVIEW_SHOWN, emitRelayCard } from "../mcp-relay-confirm";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import {
  cardKey,
  confirmItemsForCards,
  confirmWrite,
  confirmWriteMany,
  isAsk,
} from "../mcp-confirm";
import { McpWriteLimiter } from "../mcp-write-limiter";
import {
  getDefaultDateRange,
  resolveComparePeriods,
  numberArg,
  booleanArg,
} from "../../common/tool-schemas";
import {
  didYouMean,
  formatDidYouMean,
} from "../../common/name-suggestions.util";
import {
  listTransactionsOutput,
  comparePeriodsOutput,
  manageTransactionsOutput,
} from "../tool-output-schemas";
import { READ_ONLY, WRITE } from "../mcp-annotations";
import {
  uuidString,
  manageOperation,
  approvalMode,
  dryRun,
  itemsArray,
} from "./schema-fragments";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { SEARCH_SYNTAX_SUMMARY } from "../../transactions/transaction-search-query.util";

type ManageOperation = "create" | "update" | "delete";

/**
 * Appended to an MCP confirmation prompt when the target transaction is
 * reconciled, so the approver knows the edit/delete disturbs a completed
 * reconciliation. The web chat card surfaces the same warning visually.
 */
const RECONCILED_CONFIRM_NOTE =
  "\nWarning: this transaction is reconciled. Changing it will affect a completed reconciliation.";

/**
 * One file to save on the transaction: either a relayed chat attachment
 * (referenced by its monize-attachment:// URI) or inline base64 bytes from a
 * direct MCP client.
 */
interface ManageAttachmentInput {
  attachmentUri?: string;
  fileData?: string;
  fileName?: string;
}

interface ManageItem {
  // create (standard)
  accountName?: string;
  // create (transfer)
  fromAccountName?: string;
  toAccountName?: string;
  // update / delete
  transactionId?: string;
  // shared
  amount?: number;
  date?: string;
  payeeName?: string;
  categoryName?: string;
  description?: string;
  createPayeeIfMissing?: boolean;
  exchangeRate?: number;
  toAmount?: number;
  // split transactions (category splits only)
  splits?: { categoryName: string; amount: number; memo?: string }[];
  // files to save on the transaction (create/update, single item only)
  attachments?: ManageAttachmentInput[];
}

@Injectable()
export class McpTransactionsTools {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly payeesService: PayeesService,
    private readonly analyticsService: TransactionAnalyticsService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
    private readonly prepService: TransactionToolPrepService,
    private readonly accountsService: AccountsService,
    private readonly writeLimiter: McpWriteLimiter,
    private readonly attachmentPrepService: AttachmentToolPrepService,
    private readonly attachmentsService: AttachmentsService,
    private readonly relayAttachmentStore: RelayAttachmentStore,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "list_transactions",
      {
        title: "List transactions",
        annotations: READ_ONLY,
        description:
          "Cash income/expense/net totals, grouped breakdown and per-account transfer rollup. Use includeTransactions for rows (costly). Own-account transfers stay outside income/expenses; transfersOnly shows them. Use generate_report for accrual.",
        inputSchema: z.object({
          basis: z.literal("cash").optional(),
          searchText: z
            .string()
            .max(200)
            .optional()
            .describe(SEARCH_SYNTAX_SUMMARY),
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Defaults to 30 days ago."),
          endDate: z.string().max(10).optional(),
          accountNames: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe("Account names."),
          categoryNames: z
            .array(z.string().max(100))
            .max(100)
            .optional()
            .describe(
              "Category names. An ambiguous bare child name is rejected, and the error lists the qualified ones.",
            ),
          payeeNames: z
            .array(z.string().max(100))
            .max(100)
            .optional()
            .describe("Payee names."),
          minAmount: numberArg(z.number().min(-999999999999).max(999999999999))
            .optional()
            .describe("Minimum signed amount."),
          maxAmount: numberArg(z.number().min(-999999999999).max(999999999999))
            .optional()
            .describe("Maximum signed amount."),
          direction: z
            .enum(["expenses", "income", "both"])
            .optional()
            .describe("Narrows the grouped breakdown."),
          groupBy: z
            .enum(["category", "payee", "year", "month", "week", "none"])
            .optional()
            .describe(
              "Default 'none', which returns totals with no breakdown.",
            ),
          transfersOnly: booleanArg()
            .optional()
            .describe("Also compute the per-account transfer rollup."),
          includeTransactions: booleanArg()
            .optional()
            .default(false)
            .describe(
              "Foreign rows include originalAmount, originalCurrencyCode and exchangeRate; amount is in account currency.",
            ),
          limit: numberArg(z.number().int().min(1).max(100))
            .optional()
            .default(50)
            .describe("Max raw rows, up to 100."),
          // No `.describe` on either: the enum carries the values and
          // `.default` carries the default, so prose restating them is the
          // redundancy `tools-list-budget.spec.ts` exists to keep out of every
          // request's context. Only "which end desc is" needs saying.
          sortBy: z.enum(TRANSACTION_SORT_FIELDS).optional().default("date"),
          sortDirection: z
            .enum(["asc", "desc"])
            .optional()
            .default("desc")
            .describe("desc is newest first."),
        }),
        outputSchema: listTransactionsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const startDate = args.startDate ?? defaults.startDate;
          const endDate = args.endDate ?? defaults.endDate;

          const resolved = await this.resolveListFilters(user.userId, {
            accountNames: args.accountNames,
            categoryNames: args.categoryNames,
            payeeNames: args.payeeNames,
          });
          if (resolved.error) return toolError(resolved.error);

          const data = await this.analyticsService.getLlmListTransactions(
            user.userId,
            {
              startDate,
              endDate,
              accountIds: resolved.accountIds,
              categoryIds: resolved.categoryIds,
              payeeIds: resolved.payeeIds,
              searchText: args.searchText,
              minAmount: args.minAmount,
              maxAmount: args.maxAmount,
              direction: args.direction,
              groupBy: args.groupBy,
              transfersOnly: args.transfersOnly,
            },
          );

          if (!args.includeTransactions) {
            return toolResult(data);
          }

          const rows = await this.transactionsService.getLlmTransactionRows(
            user.userId,
            {
              accountId: resolved.accountIds?.[0],
              categoryId: resolved.categoryIds?.[0],
              payeeId: resolved.payeeIds?.[0],
              startDate,
              endDate,
              query: args.searchText,
              minAmount: args.minAmount,
              maxAmount: args.maxAmount,
              limit: args.limit,
              sortBy: args.sortBy,
              sortDirection: args.sortDirection,
            },
          );

          return toolResult({
            ...data,
            transactions: rows.transactions,
            total: rows.total,
            hasMore: rows.hasMore,
            truncatedTransactionList: rows.hasMore,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "compare_periods",
      {
        title: "Compare periods",
        annotations: READ_ONLY,
        description:
          "Compare spending/income by group between periods. Dates default to last full month vs this month to date; basis follows your preference.",
        inputSchema: z.object({
          basis: z.enum(["cash", "accrual"]).optional(),
          period1Start: z.string().max(10).optional(),
          period1End: z.string().max(10).optional(),
          period2Start: z.string().max(10).optional(),
          period2End: z.string().max(10).optional(),
          groupBy: z
            .enum(["category", "payee"])
            .optional()
            .describe("Default 'category'."),
          direction: z
            .enum(["expenses", "income", "both"])
            .optional()
            .describe("Default 'expenses'."),
        }),
        outputSchema: comparePeriodsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const periods = resolveComparePeriods({
            period1Start: args.period1Start,
            period1End: args.period1End,
            period2Start: args.period2Start,
            period2End: args.period2End,
          });
          const data = await this.analyticsService.getLlmPeriodComparison(
            user.userId,
            {
              period1Start: periods.period1Start,
              period1End: periods.period1End,
              period2Start: periods.period2Start,
              period2End: periods.period2End,
              groupBy: args.groupBy,
              direction: args.direction,
              basis: args.basis,
            },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "manage_transactions",
      {
        title: "Manage transactions",
        annotations: WRITE,
        description:
          "Create, update or delete cash transactions, including transfers " +
          "between the user's own accounts -- an item with toAccountName is a " +
          "transfer. Names for account, category and payee resolve internally. " +
          "A split transaction carries a `splits` array instead of a single " +
          "categoryName, and its lines must sum to the transaction amount. " +
          "Updating an EXISTING split transaction: parent fields (date, " +
          "payeeName, description) work without splits, but changing its " +
          "categories or its amount requires resending the COMPLETE splits " +
          "array. Read tools return one row per split line (same transaction " +
          "id, distinct splitId) and always the whole set even when you " +
          "filtered by category, so read the current lines first and resend " +
          "every one with your change applied. Several split transactions CAN " +
          "be sent in one call, each carrying its own complete array. " +
          "Deleting a row removes its linked transfer legs and split children " +
          "too.",
        inputSchema: z.object({
          operation: manageOperation(),
          items: itemsArray(
            z.object({
              accountName: z
                .string()
                .max(100)
                .optional()
                .describe("create: the account, for a non-transfer."),
              fromAccountName: z
                .string()
                .max(100)
                .optional()
                .describe("create: transfer source."),
              toAccountName: z
                .string()
                .max(100)
                .optional()
                .describe(
                  "create: transfer destination. Its presence makes the item a transfer.",
                ),
              transactionId: uuidString()
                .optional()
                .describe("update/delete: the row's id."),
              amount: numberArg(z.number().min(-999999999999).max(999999999999))
                .optional()
                .describe(
                  "Signed amount, or the positive amount moved by a transfer.",
                ),
              date: z.string().max(10).optional().describe("Transaction date."),
              payeeName: z
                .string()
                .max(100)
                .optional()
                .describe(
                  "Matched to an existing payee, else handled per createPayeeIfMissing. On a transfer it is a custom label; omitted, the transfer reads as 'Transfer to/from <account>'.",
                ),
              categoryName: z
                .string()
                .max(100)
                .optional()
                .describe(
                  "The category. On a transfer it is stored on both legs and surfaces it in the category breakdown without counting as income or expense.",
                ),
              description: z
                .string()
                .max(TRANSACTION_NOTE_MAX_LENGTH)
                .optional()
                .describe("Description or memo."),
              createPayeeIfMissing: booleanArg()
                .optional()
                .describe(
                  "An unmatched payee name creates a payee (default) or stays free text.",
                ),
              exchangeRate: numberArg(z.number().min(0).max(1_000_000))
                .optional()
                .describe("create: rate for a cross-currency transfer."),
              toAmount: numberArg(
                z.number().min(-999999999999).max(999999999999),
              )
                .optional()
                .describe(
                  "create: explicit destination amount, overriding exchangeRate.",
                ),
              splits: z
                .array(
                  z.object({
                    categoryName: z
                      .string()
                      .min(1)
                      .max(100)
                      .describe("Category for this line."),
                    amount: numberArg(
                      z.number().min(-999999999999).max(999999999999),
                    ).describe("Signed amount for this line."),
                    memo: z
                      .string()
                      .max(TRANSACTION_NOTE_MAX_LENGTH)
                      .optional()
                      .describe("Memo for this line."),
                  }),
                )
                .max(50)
                .optional()
                .describe(
                  "Two or more category lines instead of a single categoryName. See the tool description for editing an existing split.",
                ),
              attachments: z
                .array(
                  z.object({
                    attachmentUri: z
                      .string()
                      .max(300)
                      .optional()
                      .describe(
                        "A monize-attachment:// URI (or bare id) of a web-chat file. Exclusive with fileData.",
                      ),
                    fileData: z
                      .string()
                      .max(MAX_ATTACHMENT_BASE64_LENGTH)
                      .optional()
                      .describe(
                        "Inline base64 bytes, max 5 MB decoded. Needs fileName. Exclusive with attachmentUri.",
                      ),
                    fileName: z
                      .string()
                      .max(255)
                      .optional()
                      .describe("Filename for fileData."),
                  }),
                )
                .min(1)
                .max(MAX_ATTACHMENTS)
                .optional()
                .describe(
                  "Images or PDFs to save on the transaction. Single-item calls only; not valid on a transfer, a delete or a dryRun.",
                ),
            }),
          ),
          approvalMode: approvalMode(),
          dryRun: dryRun(),
        }),
        outputSchema: manageTransactionsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "write");
        if (check.error) return check.result;

        const operation = args.operation as ManageOperation;
        const items = args.items as ManageItem[];
        const approvalMode = resolveApprovalMode(
          args.approvalMode as ApprovalMode | undefined,
          items.length,
        );

        try {
          // Attachments only ride the singular create/update card, mirroring
          // the AI Assistant executor's rules.
          let attachmentDtos: AttachmentDto[] | undefined;
          if (items.some((i) => i.attachments !== undefined)) {
            if (items.length > 1) {
              return toolError(
                "Attachments must be sent one at a time: use a single item with an attachments array.",
              );
            }
            if (operation === "delete") {
              return toolError("attachments are not used for delete.");
            }
            if (args.dryRun) {
              return toolError(
                "attachments cannot be combined with dryRun. Preview without attachments, then call again with dryRun=false.",
              );
            }
            if (this.isTransferItem(items[0])) {
              return toolError(
                "Attachments cannot be added to transfers: attach files to a standard transaction instead.",
              );
            }
            const resolved = await this.resolveMcpAttachments(
              user.userId,
              items[0].attachments as ManageAttachmentInput[],
            );
            if ("error" in resolved) return toolError(resolved.error);
            attachmentDtos = resolved.dtos;
          }

          if (args.dryRun) {
            return this.manageDryRun(user.userId, operation, items);
          }
          if (operation === "create") {
            return await this.manageCreate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
              attachmentDtos,
            );
          }
          if (operation === "update") {
            return await this.manageUpdate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
              attachmentDtos,
            );
          }
          return await this.manageDelete(
            server,
            ctx,
            user.userId,
            items,
            approvalMode,
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // list_transactions helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the name-based filters of `list_transactions` into IDs. Accounts
   * resolve via the shared `AccountsService` name map, categories via the
   * analytics category resolver (expands to descendants, supports
   * "Parent: Child"), and payees via the payees lookup. Any name that cannot be
   * resolved is reported as a hard error rather than silently dropped -- a
   * mistyped filter must not widen the result to "all transactions".
   */
  private async resolveListFilters(
    userId: string,
    names: {
      accountNames?: string[];
      categoryNames?: string[];
      payeeNames?: string[];
    },
  ): Promise<{
    accountIds?: string[];
    categoryIds?: string[];
    payeeIds?: string[];
    error?: string;
  }> {
    let accountIds: string[] | undefined;
    if (names.accountNames && names.accountNames.length > 0) {
      const accounts = await this.accountsService.findAll(userId, true);
      const nameMap = new Map(
        accounts.map((a) => [a.name.toLowerCase(), a.id]),
      );
      const ids: string[] = [];
      const unresolved: string[] = [];
      for (const name of names.accountNames) {
        const id = nameMap.get(name.toLowerCase());
        if (id) ids.push(id);
        else unresolved.push(name);
      }
      if (unresolved.length > 0) {
        const suggestion = didYouMean(
          unresolved[0],
          accounts.map((a) => a.name),
        );
        return {
          error: `Unknown account${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}.${suggestion} Use exact names from the user's account list.`,
        };
      }
      accountIds = ids;
    }

    let categoryIds: string[] | undefined;
    if (names.categoryNames && names.categoryNames.length > 0) {
      const resolved = await this.analyticsService.resolveLlmCategoryIds(
        userId,
        names.categoryNames,
      );
      if (resolved.unresolved.length > 0) {
        return {
          error: `Unknown categor${resolved.unresolved.length === 1 ? "y" : "ies"}: ${resolved.unresolved.join(", ")}.${formatDidYouMean(resolved.suggestions)} Call list_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
        };
      }
      categoryIds = resolved.categoryIds;
    }

    let payeeIds: string[] | undefined;
    if (names.payeeNames && names.payeeNames.length > 0) {
      const ids: string[] = [];
      const unresolved: string[] = [];
      for (const name of names.payeeNames) {
        const payee = await this.payeesService.findByName(userId, name);
        if (payee) ids.push(payee.id);
        else unresolved.push(name);
      }
      if (unresolved.length > 0) {
        // Best-effort suggestion: a lookup failure must not mask the
        // "unknown payee" error, so fall back to no hint.
        let suggestion: string;
        try {
          const matches = await this.payeesService.search(
            userId,
            unresolved[0],
            5,
          );
          suggestion = didYouMean(
            unresolved[0],
            matches.map((p) => p.name),
          );
        } catch {
          suggestion = "";
        }
        return {
          error: `Unknown payee${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}.${suggestion} Call list_payees to look up valid names.`,
        };
      }
      payeeIds = ids;
    }

    return { accountIds, categoryIds, payeeIds };
  }

  // -------------------------------------------------------------------------
  // manage_transactions helpers
  // -------------------------------------------------------------------------

  private isTransferItem(item: ManageItem): boolean {
    return item.toAccountName !== undefined;
  }

  private toCreateRow(item: ManageItem): CreateRowInput {
    return {
      accountName: item.accountName as string,
      amount: item.amount as number,
      date: item.date as string,
      payeeName: item.payeeName,
      categoryName: item.categoryName,
      description: item.description,
      createPayeeIfMissing: item.createPayeeIfMissing,
      splits: item.splits,
    };
  }

  private toTransferRow(item: ManageItem): TransferRowInput {
    return {
      fromAccountName: item.fromAccountName as string,
      toAccountName: item.toAccountName as string,
      amount: item.amount as number,
      date: item.date as string,
      description: item.description,
      payeeName: item.payeeName,
      categoryName: item.categoryName,
      createPayeeIfMissing: item.createPayeeIfMissing,
      exchangeRate: item.exchangeRate,
      toAmount: item.toAmount,
    };
  }

  /**
   * Resolve the final payee id for a transfer preview/descriptor, mirroring the
   * normal cash-transaction flow: use the matched id, otherwise find-or-create
   * from the custom label when opted in. Returns undefined when no payee should
   * be linked.
   */
  private async resolveTransferPayeeId(
    userId: string,
    src: {
      payeeId: string | null;
      payeeName: string | null;
      payeeWillBeCreated?: boolean;
      createPayee?: boolean;
    },
  ): Promise<string | undefined> {
    let payeeId = src.payeeId ?? undefined;
    const shouldCreate = src.payeeWillBeCreated ?? src.createPayee ?? false;
    if (!payeeId && shouldCreate && src.payeeName) {
      const payee = await this.payeesService.findOrCreate(
        userId,
        src.payeeName,
      );
      payeeId = payee.id;
    }
    return payeeId;
  }

  private toUpdateRow(item: ManageItem): UpdateRowInput {
    return {
      transactionId: item.transactionId as string,
      amount: item.amount,
      date: item.date,
      payeeName: item.payeeName,
      categoryName: item.categoryName,
      description: item.description,
      createPayeeIfMissing: item.createPayeeIfMissing,
      splits: item.splits,
    };
  }

  /** Dry-run preview for a single category-split create/update item. */
  private async manageDryRunSplit(
    userId: string,
    operation: "create" | "update",
    item: ManageItem,
  ) {
    const message =
      "This is a preview. Call again with dryRun=false to apply the changes.";
    if (operation === "create") {
      const { preview, splits } = await this.prepService.prepareCreateSingle(
        userId,
        this.toCreateRow(item),
      );
      return toolResult({
        dryRun: true,
        operation,
        previews: [
          {
            status: "ok",
            accountName: preview.accountName,
            amount: preview.amount,
            currencyCode: preview.currencyCode,
            transactionDate: preview.transactionDate,
            payeeName: preview.payeeName,
            splits: (splits ?? []).map((s) => ({
              categoryName: s.categoryName,
              amount: s.amount,
              memo: s.memo,
            })),
          },
        ],
        skipped: [],
        message,
      });
    }
    const result = await this.prepService.prepareUpdate(
      userId,
      this.toUpdateRow(item),
    );
    // A split update always resolves to the standard branch (prepareUpdate
    // rejects splits on a transfer), but narrow defensively.
    if (result.kind !== "standard") {
      return toolError(
        "A transfer cannot be converted into a split transaction.",
      );
    }
    const { preview, splits } = result;
    return toolResult({
      dryRun: true,
      operation,
      previews: [
        {
          status: "ok",
          accountName: preview.accountName,
          amount: preview.amount,
          currencyCode: preview.currencyCode,
          transactionDate: preview.transactionDate,
          splits: (splits ?? []).map((s) => ({
            categoryName: s.categoryName,
            amount: s.amount,
            memo: s.memo,
          })),
        },
      ],
      skipped: [],
      message,
    });
  }

  /** Dry-run preview for every item without writing. */
  private async manageDryRun(
    userId: string,
    operation: ManageOperation,
    items: ManageItem[],
  ) {
    // A single split create/update is its own rich unit; the bulk preview
    // helpers do not carry splits.
    if (
      items.length === 1 &&
      items[0].splits &&
      (operation === "create" || operation === "update")
    ) {
      return this.manageDryRunSplit(userId, operation, items[0]);
    }
    if (operation === "create") {
      const std = await this.prepService.prepareCreate(
        userId,
        items
          .filter((i) => !this.isTransferItem(i))
          .map((i) => this.toCreateRow(i)),
      );
      const xfer = await this.prepService.prepareCreateTransfer(
        userId,
        items
          .filter((i) => this.isTransferItem(i))
          .map((i) => this.toTransferRow(i)),
      );
      return toolResult({
        dryRun: true,
        operation,
        previews: [...std.previewRows, ...xfer.previewRows],
        skipped: [...std.skipped, ...xfer.skipped],
        message:
          "This is a preview. Call again with dryRun=false to apply the changes.",
      });
    }
    if (operation === "update") {
      const bulk = await this.prepService.prepareUpdateBulk(
        userId,
        items.map((i) => this.toUpdateRow(i)),
      );
      return toolResult({
        dryRun: true,
        operation,
        previews: bulk.previewRows,
        skipped: bulk.skipped,
        message:
          "This is a preview. Call again with dryRun=false to apply the changes.",
      });
    }
    const bulk = await this.prepService.prepareDeleteBulk(
      userId,
      items.map((i) => i.transactionId as string),
    );
    return toolResult({
      dryRun: true,
      operation,
      previews: bulk.previewRows,
      skipped: bulk.skipped,
      message:
        "This is a preview. Call again with dryRun=false to delete the transactions.",
    });
  }

  /**
   * Relay-first then confirmWrite for a single signed card. Returns the relay
   * result when handled there, otherwise the elicitation outcome.
   */
  private async emitOrConfirm(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    pendingAction: PendingAiAction,
    confirmMessage: string,
  ): Promise<"relay" | "accepted" | "declined" | { ask: InputRequiredResult }> {
    // Only the round that ASKS may hand the confirmation to the web chat. On a
    // retry the human has already answered in their own client, and a relay
    // turn that began in between would swallow that answer.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, pendingAction))
    ) {
      return "relay";
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      confirmMessage,
      pendingAction.descriptor,
    );
    if (isAsk(confirmation)) return confirmation;
    return confirmation === "declined" ? "declined" : "accepted";
  }

  /**
   * Resolve the tool call's attachment entries into validated chat-attachment
   * DTOs: relay URIs read the parked chat file, inline base64 is sniffed for a
   * supported type. Returns an error string the model can act on.
   */
  private async resolveMcpAttachments(
    userId: string,
    entries: ManageAttachmentInput[],
  ): Promise<{ dtos: AttachmentDto[] } | { error: string }> {
    const dtos: AttachmentDto[] = [];
    for (const entry of entries) {
      const hasUri = entry.attachmentUri !== undefined;
      const hasData = entry.fileData !== undefined;
      if (hasUri === hasData) {
        return {
          error:
            "Each attachments entry needs exactly one of attachmentUri or fileData.",
        };
      }
      if (hasUri) {
        const id = this.parseAttachmentUri(entry.attachmentUri as string);
        const stored = await this.relayAttachmentStore.get(userId, id);
        if (!stored) {
          return {
            error: `Unknown or expired attachment reference "${entry.attachmentUri}". Chat attachments expire about 20 minutes after upload; ask the user to re-send the file.`,
          };
        }
        if (stored.kind === "text") {
          return {
            error: `"${stored.filename}" cannot be saved as a transaction attachment: only images and PDFs can be attached (CSV/text files cannot).`,
          };
        }
        dtos.push({
          kind: stored.kind,
          mediaType: stored.mediaType,
          filename: stored.filename,
          data: stored.data.toString("base64"),
        });
      } else {
        if (!entry.fileName) {
          return { error: "fileName is required with fileData." };
        }
        const buffer = Buffer.from(
          (entry.fileData as string).replace(/\s+/g, ""),
          "base64",
        );
        const mediaType =
          buffer.length > 0 ? sniffAttachmentMime(buffer) : null;
        if (!mediaType) {
          return {
            error: `"${entry.fileName}" is not a supported file type: only images (JPEG/PNG/GIF/WebP) and PDFs can be attached.`,
          };
        }
        dtos.push({
          kind: mediaType === "application/pdf" ? "pdf" : "image",
          mediaType,
          filename: entry.fileName,
          data: buffer.toString("base64"),
        });
      }
    }
    return { dtos };
  }

  /** Accept a full monize-attachment:// URI or a bare store id. */
  private parseAttachmentUri(uri: string): string {
    const prefix = `${ATTACHMENT_URI_SCHEME}://`;
    return uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
  }

  /**
   * Validate the resolved files (size/type/per-transaction cap) and park their
   * bytes under fresh store ids for the signed card. Validation errors bubble
   * as 4xx HttpExceptions for `safeToolError`. The MCP request has no ambient
   * identity context (bearer auth, no JWT guard), so withScopedDb-based prep runs
   * under withUserContext.
   */
  private async prepareAttachmentRefs(
    userId: string,
    dtos: AttachmentDto[],
    existingTransactionId?: string,
  ): Promise<AttachmentRefDescriptor[]> {
    const previews = await withUserContext(userId, () =>
      this.attachmentPrepService.prepareAttachments(
        userId,
        dtos.map((dto) => ({
          filename: dto.filename,
          buffer: Buffer.from(dto.data, "base64"),
        })),
        existingTransactionId,
      ),
    );
    const stored = await this.relayAttachmentStore.store(userId, dtos);
    return previews.map((preview, i) => ({
      attachmentRefId: stored[i].id,
      filename: preview.filename,
      contentType: preview.contentType,
      byteSize: preview.byteSize,
      sha256: preview.sha256,
    }));
  }

  /**
   * Persist the resolved files against the written transaction (direct MCP
   * confirm path), then free the parked refs.
   */
  private async persistAttachmentsDirect(
    userId: string,
    transactionId: string,
    dtos: AttachmentDto[],
    refs: AttachmentRefDescriptor[],
  ): Promise<{ id: string; filename: string }[]> {
    const created: { id: string; filename: string }[] = [];
    for (const dto of dtos) {
      const buffer = Buffer.from(dto.data, "base64");
      const attachment = await withUserContext(userId, () =>
        this.attachmentsService.create(
          userId,
          { kind: "transaction", id: transactionId },
          {
            originalname: dto.filename,
            buffer,
            size: buffer.length,
          },
        ),
      );
      created.push({ id: attachment.id, filename: attachment.filename });
    }
    await this.releaseAttachmentRefs(userId, refs);
    return created;
  }

  /** Drop parked refs a declined/committed confirmation no longer needs. */
  private async releaseAttachmentRefs(
    userId: string,
    refs?: AttachmentRefDescriptor[],
  ): Promise<void> {
    if (refs?.length) {
      await this.relayAttachmentStore.releaseForPrompt(
        userId,
        refs.map((r) => r.attachmentRefId),
      );
    }
  }

  /** Confirmation-prompt suffix listing the files an approval would save. */
  private attachmentConfirmNote(refs?: AttachmentRefDescriptor[]): string {
    return refs?.length
      ? `\nAttachments: ${refs.map((r) => r.filename).join(", ")}`
      : "";
  }

  /** Create one category-split transaction (single rich item). */
  private async manageCreateSplit(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    item: ManageItem,
    attachmentDtos?: AttachmentDto[],
  ) {
    const budget = await this.writeLimiter.reserve(userId, 1);
    if (budget) return budget;
    const { preview, createPayee, splits } =
      await this.prepService.prepareCreateSingle(
        userId,
        this.toCreateRow(item),
      );
    const attachmentRefs = attachmentDtos
      ? await this.prepareAttachmentRefs(userId, attachmentDtos)
      : undefined;
    const action = this.actionBuilder.buildCreateTransaction(
      userId,
      preview,
      splits,
      attachmentRefs,
    );
    const outcome = await this.emitOrConfirm(
      server,
      ctx,
      userId,
      action,
      `Create this split transaction?\nAccount: ${preview.accountName}\nAmount: ${preview.amount} ${preview.currencyCode}\nDate: ${preview.transactionDate}\nSplits: ${(splits ?? []).map((s) => `${s.categoryName} ${s.amount}`).join(", ")}${this.attachmentConfirmNote(attachmentRefs)}`,
    );
    if (isAsk(outcome)) {
      // The refs park the file bytes for the round that commits, and this
      // round does not: it returns the question. Round two re-derives its own,
      // so holding these would leave a duplicate copy of every uploaded file
      // in the store until its TTL.
      await this.releaseAttachmentRefs(userId, attachmentRefs);
      return outcome.ask;
    }
    if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
    if (outcome === "declined") {
      await this.releaseAttachmentRefs(userId, attachmentRefs);
      return toolError(
        "Cancelled: the confirmation was declined, so no transaction was created.",
      );
    }
    const tx = await this.transactionsService.create(
      userId,
      {
        accountId: preview.accountId,
        amount: preview.amount,
        transactionDate: preview.transactionDate,
        payeeId: preview.payeeId ?? undefined,
        payeeName: preview.payeeName ?? undefined,
        description: preview.description ?? undefined,
        currencyCode: preview.currencyCode,
        splits: toSplitDtoRows(splits ?? []),
      },
      { createPayeeIfMissing: createPayee },
    );
    await this.writeLimiter.record(userId, "create_transaction");
    const attachments =
      attachmentDtos && attachmentRefs
        ? await this.persistAttachmentsDirect(
            userId,
            tx.id,
            attachmentDtos,
            attachmentRefs,
          )
        : undefined;
    return toolResult({
      id: tx.id,
      date: tx.transactionDate,
      count: 1,
      ...(attachments ? { attachments } : {}),
    });
  }

  private async manageCreate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageItem[],
    approvalMode: ApprovalMode,
    attachmentDtos?: AttachmentDto[],
  ) {
    const single = items.length === 1;

    // A single split transaction is its own rich unit; handle it on a dedicated
    // path (the bulk prepare/preview helpers do not carry splits).
    if (single && items[0].splits) {
      return this.manageCreateSplit(
        server,
        ctx,
        userId,
        items[0],
        attachmentDtos,
      );
    }

    const standardItems = items.filter((i) => !this.isTransferItem(i));
    const transferItems = items.filter((i) => this.isTransferItem(i));

    const std = await this.prepService.prepareCreate(
      userId,
      standardItems.map((i) => this.toCreateRow(i)),
    );
    const xfer = await this.prepService.prepareCreateTransfer(
      userId,
      transferItems.map((i) => this.toTransferRow(i)),
    );

    const okCount = std.okPreviews.length + xfer.okPreviews.length;
    if (okCount === 0) {
      return toolError(
        `None of the transactions could be prepared.${describeSkippedRows(
          [...std.skipped, ...xfer.skipped],
          items.length,
        )}`,
      );
    }

    const budget = await this.writeLimiter.reserve(userId, okCount);
    if (budget) return budget;

    if (single) {
      if (std.okPreviews.length === 1) {
        const preview = std.okPreviews[0];
        const attachmentRefs = attachmentDtos
          ? await this.prepareAttachmentRefs(userId, attachmentDtos)
          : undefined;
        const action = this.actionBuilder.buildCreateTransaction(
          userId,
          preview,
          undefined,
          attachmentRefs,
        );
        const outcome = await this.emitOrConfirm(
          server,
          ctx,
          userId,
          action,
          `Create this transaction?\nAccount: ${preview.accountName}\nAmount: ${preview.amount} ${preview.currencyCode}\nDate: ${preview.transactionDate}${this.attachmentConfirmNote(attachmentRefs)}`,
        );
        if (isAsk(outcome)) {
          // See manageCreateSplit: the asking round parks nothing it keeps.
          await this.releaseAttachmentRefs(userId, attachmentRefs);
          return outcome.ask;
        }
        if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
        if (outcome === "declined") {
          await this.releaseAttachmentRefs(userId, attachmentRefs);
          return toolError(
            "Cancelled: the confirmation was declined, so no transaction was created.",
          );
        }
        const tx = await this.transactionsService.create(
          userId,
          {
            accountId: preview.accountId,
            amount: preview.amount,
            transactionDate: preview.transactionDate,
            payeeId: preview.payeeId ?? undefined,
            payeeName: preview.payeeName ?? undefined,
            categoryId: preview.categoryId ?? undefined,
            description: preview.description ?? undefined,
            currencyCode: preview.currencyCode,
          },
          { createPayeeIfMissing: std.okCreatePayee[0] },
        );
        await this.writeLimiter.record(userId, "create_transaction");
        const attachments =
          attachmentDtos && attachmentRefs
            ? await this.persistAttachmentsDirect(
                userId,
                tx.id,
                attachmentDtos,
                attachmentRefs,
              )
            : undefined;
        return toolResult({
          id: tx.id,
          date: tx.transactionDate,
          count: 1,
          ...(attachments ? { attachments } : {}),
        });
      }
      // single transfer
      const preview = xfer.okPreviews[0];
      const action = this.actionBuilder.buildCreateTransfer(userId, preview);
      const outcome = await this.emitOrConfirm(
        server,
        ctx,
        userId,
        action,
        `Create this transfer?\nFrom: ${preview.fromAccountName}\nTo: ${preview.toAccountName}\nAmount: ${preview.amount} ${preview.fromCurrencyCode}\nDate: ${preview.transactionDate}`,
      );
      if (isAsk(outcome)) return outcome.ask;
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so no transfer was created.",
        );
      const payeeId = await this.resolveTransferPayeeId(userId, preview);
      const result = await this.transactionsService.createTransfer(userId, {
        fromAccountId: preview.fromAccountId,
        toAccountId: preview.toAccountId,
        transactionDate: preview.transactionDate,
        amount: preview.amount,
        fromCurrencyCode: preview.fromCurrencyCode,
        toCurrencyCode: preview.toCurrencyCode,
        exchangeRate: preview.exchangeRate,
        toAmount: preview.toAmount,
        description: preview.description ?? undefined,
        payeeId,
        payeeName: preview.payeeName ?? undefined,
        categoryId: preview.categoryId ?? undefined,
      });
      await this.writeLimiter.record(userId, "create_transfer");
      return toolResult({ id: result.fromTransaction.id, count: 1 });
    }

    if (approvalMode === "individual") {
      const cards: PendingAiAction[] = [
        ...std.okPreviews.map((p) =>
          this.actionBuilder.buildCreateTransaction(userId, p),
        ),
        ...xfer.okPreviews.map((p) =>
          this.actionBuilder.buildCreateTransfer(userId, p),
        ),
      ];
      return this.runIndividual(server, ctx, userId, cards, [
        ...std.skipped,
        ...xfer.skipped,
      ]);
    }

    // bulk mode: one card per kind that has ok rows.
    const cards: PendingAiAction[] = [];
    if (std.okPreviews.length > 0) {
      cards.push(
        this.actionBuilder.buildCreateTransactions(
          userId,
          std.okPreviews,
          std.previewRows,
        ),
      );
    }
    if (xfer.okPreviews.length > 0) {
      cards.push(
        this.actionBuilder.buildBatchActions(
          userId,
          "create_transfer",
          xfer.okPreviews.map((p) => this.prepService.transferToBatchRow(p)),
          xfer.previewRows,
        ),
      );
    }
    // Relay: emit each card to the web chat.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, cards[0]))
    ) {
      for (let i = 1; i < cards.length; i++) {
        await emitRelayCard(this.relayService, userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const skipped = [...std.skipped, ...xfer.skipped];
    const confirmation = await confirmWrite(
      server,
      ctx,
      `Create ${okCount} transaction(s)?${skipped.length ? ` (${skipped.length} skipped)` : ""}`,
      cards.map((card) => card.descriptor),
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined") {
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was created.",
      );
    }
    const ids: string[] = [];
    for (let i = 0; i < std.okPreviews.length; i++) {
      const preview = std.okPreviews[i];
      const tx = await this.transactionsService.create(
        userId,
        {
          accountId: preview.accountId,
          amount: preview.amount,
          transactionDate: preview.transactionDate,
          payeeId: preview.payeeId ?? undefined,
          payeeName: preview.payeeName ?? undefined,
          categoryId: preview.categoryId ?? undefined,
          description: preview.description ?? undefined,
          currencyCode: preview.currencyCode,
        },
        { createPayeeIfMissing: std.okCreatePayee[i] },
      );
      ids.push(tx.id);
      await this.writeLimiter.record(userId, "create_transaction");
    }
    for (const preview of xfer.okPreviews) {
      const payeeId = await this.resolveTransferPayeeId(userId, preview);
      const result = await this.transactionsService.createTransfer(userId, {
        fromAccountId: preview.fromAccountId,
        toAccountId: preview.toAccountId,
        transactionDate: preview.transactionDate,
        amount: preview.amount,
        fromCurrencyCode: preview.fromCurrencyCode,
        toCurrencyCode: preview.toCurrencyCode,
        exchangeRate: preview.exchangeRate,
        toAmount: preview.toAmount,
        description: preview.description ?? undefined,
        payeeId,
        payeeName: preview.payeeName ?? undefined,
        categoryId: preview.categoryId ?? undefined,
      });
      ids.push(result.fromTransaction.id);
      await this.writeLimiter.record(userId, "create_transfer");
    }
    return toolResult({ ids, count: ids.length, skipped });
  }

  private async manageUpdate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageItem[],
    approvalMode: ApprovalMode,
    attachmentDtos?: AttachmentDto[],
  ) {
    const single = items.length === 1;

    if (single) {
      const result = await this.prepService.prepareUpdate(
        userId,
        this.toUpdateRow(items[0]),
      );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      if (result.kind === "transfer" && attachmentDtos) {
        return toolError(
          "Attachments cannot be added to transfers: this transaction is a transfer between accounts.",
        );
      }
      if (result.kind === "transfer") {
        const preview = result.preview;
        const action = this.actionBuilder.buildUpdateTransfer(userId, preview);
        const outcome = await this.emitOrConfirm(
          server,
          ctx,
          userId,
          action,
          `Apply this transfer edit?\nFrom: ${preview.fromAccountName}\nTo: ${preview.toAccountName}\nAmount: ${preview.amount} ${preview.fromCurrencyCode}\nDate: ${preview.transactionDate}${preview.categoryName ? `\nCategory: ${preview.categoryName}` : ""}`,
        );
        if (isAsk(outcome)) return outcome.ask;
        if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
        if (outcome === "declined")
          return toolError(
            "Cancelled: the confirmation was declined, so the transfer was not changed.",
          );
        const payeeId = await this.resolveTransferPayeeId(userId, preview);
        const r = await this.transactionsService.updateTransfer(
          userId,
          preview.transactionId,
          {
            amount: preview.amount,
            transactionDate: preview.transactionDate,
            exchangeRate: preview.exchangeRate,
            toAmount: preview.toAmount,
            description: preview.description ?? undefined,
            payeeId,
            payeeName: preview.payeeName ?? undefined,
            categoryId: preview.categoryId,
          },
        );
        await this.writeLimiter.record(userId, "update_transfer");
        return toolResult({ id: r.fromTransaction.id, count: 1 });
      }
      const preview = result.preview;
      const splits = result.splits;
      const attachmentRefs = attachmentDtos
        ? await this.prepareAttachmentRefs(
            userId,
            attachmentDtos,
            preview.transactionId,
          )
        : undefined;
      const action = this.actionBuilder.buildUpdateTransaction(
        userId,
        preview,
        splits,
        attachmentRefs,
      );
      const reconciledNote = preview.isReconciled
        ? RECONCILED_CONFIRM_NOTE
        : "";
      const attachmentNote = this.attachmentConfirmNote(attachmentRefs);
      const confirmMessage = splits
        ? `Apply this transaction edit?\nAccount: ${preview.accountName}\nAmount: ${preview.amount} ${preview.currencyCode}\nDate: ${preview.transactionDate}\nSplits: ${splits.map((s) => `${s.categoryName} ${s.amount}`).join(", ")}${attachmentNote}${reconciledNote}`
        : `Apply this transaction edit?\nAccount: ${preview.accountName}\nAmount: ${preview.amount} ${preview.currencyCode}\nDate: ${preview.transactionDate}${attachmentNote}${reconciledNote}`;
      const outcome = await this.emitOrConfirm(
        server,
        ctx,
        userId,
        action,
        confirmMessage,
      );
      if (isAsk(outcome)) {
        // See manageCreateSplit: the asking round parks nothing it keeps.
        await this.releaseAttachmentRefs(userId, attachmentRefs);
        return outcome.ask;
      }
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined") {
        await this.releaseAttachmentRefs(userId, attachmentRefs);
        return toolError(
          "Cancelled: the confirmation was declined, so the transaction was not changed.",
        );
      }
      const tx = await this.transactionsService.update(
        userId,
        preview.transactionId,
        {
          amount: preview.amount,
          transactionDate: preview.transactionDate,
          payeeId: preview.payeeId ?? undefined,
          payeeName: preview.payeeName ?? undefined,
          // Replacing the split set clears any single category on the parent.
          categoryId: splits ? undefined : (preview.categoryId ?? undefined),
          description: preview.description ?? undefined,
          currencyCode: preview.currencyCode,
          // Splits ride inside the same DTO so update() rebuilds the set in
          // the same transaction, under the same row lock, as the scalar
          // fields (invariant I1) -- never as a separate follow-up write.
          splits: splits ? toSplitDtoRows(splits) : undefined,
        },
        { createPayeeIfMissing: result.createPayee },
      );
      await this.writeLimiter.record(userId, "update_transaction");
      const attachments =
        attachmentDtos && attachmentRefs
          ? await this.persistAttachmentsDirect(
              userId,
              tx.id,
              attachmentDtos,
              attachmentRefs,
            )
          : undefined;
      return toolResult({
        id: tx.id,
        count: 1,
        ...(attachments ? { attachments } : {}),
      });
    }

    if (approvalMode === "individual") {
      const cards: PendingAiAction[] = [];
      const skipped: { index: number; reason: string }[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const result = await this.prepService.prepareUpdate(
            userId,
            this.toUpdateRow(items[i]),
          );
          cards.push(
            result.kind === "transfer"
              ? this.actionBuilder.buildUpdateTransfer(userId, result.preview)
              : this.actionBuilder.buildUpdateTransaction(
                  userId,
                  result.preview,
                  // Without this the resolved lines are dropped and the card
                  // proposes a parent-only edit -- a silent no-op against what
                  // the caller asked for.
                  result.splits,
                ),
          );
        } catch (err) {
          skipped.push({ index: i, reason: this.reason(err) });
        }
      }
      if (cards.length === 0)
        return toolError(
          `None of the transaction edits could be prepared.${describeSkippedRows(skipped, items.length)}`,
        );
      const budget = await this.writeLimiter.reserve(userId, cards.length);
      if (budget) return budget;
      return this.runIndividual(server, ctx, userId, cards, skipped);
    }

    // bulk mode
    const bulk = await this.prepService.prepareUpdateBulk(
      userId,
      items.map((i) => this.toUpdateRow(i)),
    );
    if (bulk.okRows.length === 0)
      return toolError(
        `None of the transaction edits could be prepared.${describeSkippedRows(bulk.skipped, items.length)}`,
      );
    const budget = await this.writeLimiter.reserve(userId, bulk.okRows.length);
    if (budget) return budget;
    const action = this.actionBuilder.buildBatchActions(
      userId,
      "update",
      bulk.okRows,
      bulk.previewRows,
    );
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, action))
    ) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      `Apply ${bulk.okRows.length} transaction edit(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was changed.",
      );
    const ids: string[] = [];
    for (const row of bulk.okRows) {
      const tx = await this.transactionsService.update(
        userId,
        row.transactionId,
        {
          amount: row.amount,
          transactionDate: row.transactionDate,
          payeeId: row.payeeId ?? undefined,
          payeeName: row.payeeName ?? undefined,
          categoryId: row.categoryId ?? undefined,
          description: row.description ?? undefined,
          currencyCode: row.currencyCode,
        },
        { createPayeeIfMissing: row.createPayee === true },
      );
      ids.push(tx.id);
      await this.writeLimiter.record(userId, "update_transaction");
    }
    return toolResult({ ids, count: ids.length, skipped: bulk.skipped });
  }

  private async manageDelete(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageItem[],
    approvalMode: ApprovalMode,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview = await this.prepService.prepareDelete(
        userId,
        items[0].transactionId as string,
      );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildDeleteTransaction(userId, preview);
      const outcome = await this.emitOrConfirm(
        server,
        ctx,
        userId,
        action,
        `Delete this transaction?\nAccount: ${preview.accountName}\nAmount: ${preview.amount} ${preview.currencyCode}\nDate: ${preview.transactionDate}${preview.isReconciled ? RECONCILED_CONFIRM_NOTE : ""}`,
      );
      if (isAsk(outcome)) return outcome.ask;
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so the transaction was not deleted.",
        );
      await this.transactionsService.removeAny(userId, preview.transactionId);
      await this.writeLimiter.record(userId, "delete_transaction");
      return toolResult({ id: preview.transactionId, deleted: true, count: 1 });
    }

    if (approvalMode === "individual") {
      const cards: PendingAiAction[] = [];
      const skipped: { index: number; reason: string }[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const preview = await this.prepService.prepareDelete(
            userId,
            items[i].transactionId as string,
          );
          cards.push(
            this.actionBuilder.buildDeleteTransaction(userId, preview),
          );
        } catch (err) {
          skipped.push({ index: i, reason: this.reason(err) });
        }
      }
      if (cards.length === 0)
        return toolError(
          `None of the transactions could be prepared.${describeSkippedRows(skipped, items.length)}`,
        );
      const budget = await this.writeLimiter.reserve(userId, cards.length);
      if (budget) return budget;
      return this.runIndividual(server, ctx, userId, cards, skipped);
    }

    const bulk = await this.prepService.prepareDeleteBulk(
      userId,
      items.map((i) => i.transactionId as string),
    );
    if (bulk.okRows.length === 0)
      return toolError(
        `None of the transactions could be prepared.${describeSkippedRows(bulk.skipped, items.length)}`,
      );
    const budget = await this.writeLimiter.reserve(userId, bulk.okRows.length);
    if (budget) return budget;
    const action = this.actionBuilder.buildBatchActions(
      userId,
      "delete",
      bulk.okRows,
      bulk.previewRows,
    );
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, action))
    ) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      `Delete ${bulk.okRows.length} transaction(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was deleted.",
      );
    const ids: string[] = [];
    for (const row of bulk.okRows) {
      await this.transactionsService.removeAny(userId, row.transactionId);
      ids.push(row.transactionId);
      await this.writeLimiter.record(userId, "delete_transaction");
    }
    return toolResult({ ids, count: ids.length, skipped: bulk.skipped });
  }

  /**
   * Individual mode: emit/confirm one card per item. Relay path emits every
   * card to the web chat; non-relay confirms+writes each one in turn.
   */
  private async runIndividual(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    cards: PendingAiAction[],
    skipped: { index: number; reason: string }[],
  ) {
    // Relay path: emit each card; the browser confirms+commits each. Only the
    // round that asks may do this -- see emitOrConfirm.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, cards[0]))
    ) {
      for (let i = 1; i < cards.length; i++) {
        await emitRelayCard(this.relayService, userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    // Every card is asked in ONE round. A round per card would be 25 rounds on
    // a full batch, and a multi-round-trip flow is two.
    const answers = await confirmWriteMany(
      server,
      ctx,
      confirmItemsForCards(cards, (card) => this.confirmLineFor(card)),
    );
    if (!(answers instanceof Map)) return answers.ask;
    const ids: string[] = [];
    for (const [index, card] of cards.entries()) {
      if (answers.get(cardKey(index)) === "declined") continue;
      const id = await this.commitCard(userId, card);
      if (id) ids.push(id);
    }
    return toolResult({ ids, count: ids.length, skipped });
  }

  private confirmLineFor(card: PendingAiAction): string {
    const p = card.preview;
    switch (card.type) {
      case "create_transfer":
      case "update_transfer":
        return `${card.type === "create_transfer" ? "Create" : "Edit"} transfer?\nFrom: ${p.fromAccountName}\nTo: ${p.toAccountName}\nAmount: ${p.amount} ${p.currencyCode}`;
      case "delete_transaction":
        return `Delete this transaction?\nAccount: ${p.accountName}${p.isReconciled ? RECONCILED_CONFIRM_NOTE : ""}`;
      case "update_transaction":
        return `Apply this transaction edit?\nAccount: ${p.accountName}\nAmount: ${p.amount} ${p.currencyCode}${p.isReconciled ? RECONCILED_CONFIRM_NOTE : ""}`;
      default:
        return `Create this transaction?\nAccount: ${p.accountName}\nAmount: ${p.amount} ${p.currencyCode}`;
    }
  }

  /** Commit one signed card directly (non-relay individual mode). */
  private async commitCard(
    userId: string,
    card: PendingAiAction,
  ): Promise<string | null> {
    const d = card.descriptor;
    switch (d.type) {
      case "create_transaction": {
        const tx = await this.transactionsService.create(
          userId,
          {
            accountId: d.accountId,
            amount: d.amount,
            transactionDate: d.transactionDate,
            payeeId: d.payeeId ?? undefined,
            payeeName: d.payeeName ?? undefined,
            categoryId: d.categoryId ?? undefined,
            description: d.description ?? undefined,
            currencyCode: d.currencyCode,
          },
          { createPayeeIfMissing: d.createPayee === true },
        );
        await this.writeLimiter.record(userId, "create_transaction");
        return tx.id;
      }
      case "create_transfer": {
        const payeeId = await this.resolveTransferPayeeId(userId, d);
        const r = await this.transactionsService.createTransfer(userId, {
          fromAccountId: d.fromAccountId,
          toAccountId: d.toAccountId,
          transactionDate: d.transactionDate,
          amount: d.amount,
          fromCurrencyCode: d.fromCurrencyCode,
          toCurrencyCode: d.toCurrencyCode,
          exchangeRate: d.exchangeRate,
          toAmount: d.toAmount,
          description: d.description ?? undefined,
          payeeId,
          payeeName: d.payeeName ?? undefined,
        });
        await this.writeLimiter.record(userId, "create_transfer");
        return r.fromTransaction.id;
      }
      case "update_transaction": {
        const tx = await this.transactionsService.update(
          userId,
          d.transactionId,
          {
            amount: d.amount,
            transactionDate: d.transactionDate,
            payeeId: d.payeeId ?? undefined,
            payeeName: d.payeeName ?? undefined,
            categoryId: d.categoryId ?? undefined,
            description: d.description ?? undefined,
            currencyCode: d.currencyCode,
          },
          { createPayeeIfMissing: d.createPayee === true },
        );
        await this.writeLimiter.record(userId, "update_transaction");
        return tx.id;
      }
      case "update_transfer": {
        const payeeId = await this.resolveTransferPayeeId(userId, d);
        const r = await this.transactionsService.updateTransfer(
          userId,
          d.transactionId,
          {
            amount: d.amount,
            transactionDate: d.transactionDate,
            exchangeRate: d.exchangeRate,
            toAmount: d.toAmount,
            description: d.description ?? undefined,
            payeeId,
            payeeName: d.payeeName ?? undefined,
            categoryId: d.categoryId,
          },
        );
        await this.writeLimiter.record(userId, "update_transfer");
        return r.fromTransaction.id;
      }
      case "delete_transaction": {
        await this.transactionsService.removeAny(userId, d.transactionId);
        await this.writeLimiter.record(userId, "delete_transaction");
        return d.transactionId;
      }
      default:
        return null;
    }
  }

  private reason(err: unknown): string {
    if (
      err &&
      typeof err === "object" &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
    return "Could not be prepared.";
  }
}
