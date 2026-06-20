import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortfolioService } from "../../securities/portfolio.service";
import { HoldingsService } from "../../securities/holdings.service";
import { SecuritiesService } from "../../securities/securities.service";
import {
  SecurityToolPrepService,
  ManageCreateSecurityRow,
  ManageUpdateSecurityRow,
  ManageDeleteSecurityRow,
} from "../../securities/security-tool-prep.service";
import { AccountsService } from "../../accounts/accounts.service";
import {
  InvestmentTransactionsService,
  LlmCapitalGainsGroupBy,
  LlmInvestmentTxGroupBy,
  InvestmentCreateRowInput,
  InvestmentUpdateRowInput,
} from "../../securities/investment-transactions.service";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import {
  SECURITY_EXCHANGES,
  SECURITY_TYPES,
} from "../../securities/security-enums";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import { AiActionBuilderService } from "../../ai/actions/ai-action-builder.service";
import {
  ApprovalMode,
  PendingAiAction,
  MAX_BULK_ACTION_ROWS,
  resolveApprovalMode,
} from "../../ai/actions/ai-action.types";
import { RELAY_PREVIEW_SHOWN } from "../mcp-relay-confirm";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
  confirmWrite,
} from "../mcp-context";
import { McpWriteLimiter } from "../mcp-write-limiter";
import {
  getPortfolioSummaryOutput,
  listInvestmentTransactionsOutput,
  getCapitalGainsOutput,
  getHoldingDetailsOutput,
  manageSecuritiesOutput,
  lookupSecuritiesOutput,
  manageInvestmentTransactionsOutput,
} from "../tool-output-schemas";
import { READ_ONLY, WRITE } from "../mcp-annotations";

type ManageInvOperation = "create" | "update" | "delete";
type ManageSecOperation = "create" | "update" | "delete";

interface ManageInvItem {
  // create
  accountName?: string;
  fundingAccountName?: string;
  security?: string;
  action?: InvestmentAction;
  date?: string;
  quantity?: number;
  price?: number;
  commission?: number;
  exchangeRate?: number;
  description?: string;
  // update / delete
  transactionId?: string;
}

interface ManageSecItem {
  // create (lookup query) / update + delete (symbol or name)
  query?: string;
  symbol?: string;
  securityType?: string;
  exchange?: string;
  isFavourite?: boolean;
  currencyCode?: string;
}

@Injectable()
export class McpInvestmentsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly holdingsService: HoldingsService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly securitiesService: SecuritiesService,
    private readonly securityPrepService: SecurityToolPrepService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
    private readonly accountsService: AccountsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_portfolio_summary",
      {
        title: "Portfolio summary",
        annotations: READ_ONLY,
        description:
          "Get investment portfolio overview with holdings, gains/losses, and allocation. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional investment account IDs to filter to. Omit to cover all investment accounts.",
            ),
        },
        outputSchema: getPortfolioSummaryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const summary = await this.portfolioService.getLlmSummary(
            ctx.userId,
            args.accountIds,
          );
          return toolResult(summary);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "list_investment_transactions",
      {
        title: "List investment transactions",
        annotations: READ_ONLY,
        description:
          "Query brokerage investment-account transactions (buys, sells, dividends, interest, capital gains, splits, transfers, reinvestments, share adjustments). Filter by account, security symbol, action, and date; optionally group by account, date, security, or action. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional end date (YYYY-MM-DD)"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional investment account IDs."),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Optional security ticker symbols (case insensitive)."),
          actions: z
            .array(z.nativeEnum(InvestmentAction))
            .max(11)
            .optional()
            .describe(
              "Optional transaction types (BUY, SELL, DIVIDEND, INTEREST, CAPITAL_GAIN, SPLIT, TRANSFER_IN, TRANSFER_OUT, REINVEST, ADD_SHARES, REMOVE_SHARES).",
            ),
          groupBy: z
            .enum(["account", "date", "security", "action"])
            .optional()
            .describe(
              "Grouping: by account name, transaction date, security symbol, or action type. Defaults to 'security' when omitted.",
            ),
        },
        outputSchema: listInvestmentTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const result =
            await this.investmentTransactionsService.getLlmInvestmentTransactions(
              ctx.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds: args.accountIds,
                symbols: args.symbols,
                actions: args.actions,
                groupBy:
                  (args.groupBy as LlmInvestmentTxGroupBy | undefined) ??
                  "security",
              },
            );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_capital_gains",
      {
        title: "Capital gains",
        annotations: READ_ONLY,
        description:
          "Per-period capital gains (realized + unrealized) for the user's investment accounts. Replays transaction history and snapshots positions against historical close prices, so the output includes mark-to-market movement on currently-held positions in addition to realized SELL gains. Requires startDate and endDate. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Start date of the window (YYYY-MM-DD)"),
          endDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("End date of the window (YYYY-MM-DD)"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional investment account IDs."),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Optional security ticker symbols (case insensitive)."),
          groupBy: z
            .enum(["month", "security", "account"])
            .optional()
            .describe(
              "Bucket the breakdown by month, security, or account. Defaults to 'month' when omitted.",
            ),
        },
        outputSchema: getCapitalGainsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const result =
            await this.investmentTransactionsService.getLlmCapitalGains(
              ctx.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds: args.accountIds,
                symbols: args.symbols,
                groupBy:
                  (args.groupBy as LlmCapitalGainsGroupBy | undefined) ??
                  "month",
              },
            );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_holding_details",
      {
        title: "Holding details",
        annotations: READ_ONLY,
        description: "Get details for holdings in a specific account",
        inputSchema: {
          accountId: z
            .string()
            .uuid()
            .optional()
            .describe("Account ID to filter holdings"),
        },
        outputSchema: getHoldingDetailsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const holdings = await this.holdingsService.findAll(
            ctx.userId,
            args.accountId,
          );
          return toolResult(holdings);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "lookup_securities",
      {
        title: "Look up securities",
        annotations: READ_ONLY,
        description:
          "Look up a ticker symbol or company name against the user's configured price provider (Yahoo/MSN) and return the matching securities WITHOUT adding anything. Read-only: use it to resolve an ambiguous reference or confirm the exact symbol/exchange before adding it with manage_securities. Each candidate is flagged with alreadyAdded=true when a security with that symbol is already in the user's list. Shares the lookup logic with the AI Assistant's lookup_securities tool.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(100)
            .describe(
              "Ticker symbol (e.g. 'AAPL') or company/security name to search for.",
            ),
          exchange: z
            .enum(SECURITY_EXCHANGES)
            .optional()
            .describe(
              "Optional exchange to narrow the search. Omit to search across exchanges.",
            ),
          provider: z
            .enum(["yahoo", "msn", "auto"])
            .optional()
            .describe(
              "Optional quote provider: 'yahoo', 'msn', or 'auto' (the user's default). Omit for 'auto'.",
            ),
        },
        outputSchema: lookupSecuritiesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const result = await this.securitiesService.lookupSecuritiesForLlm(
            ctx.userId,
            {
              query: args.query,
              exchange: args.exchange,
              provider: args.provider,
            },
          );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "manage_securities",
      {
        title: "Manage securities",
        annotations: WRITE,
        description:
          "Create, edit, or delete the user's securities (stocks, ETFs, funds). operation = 'create' | 'update' | 'delete' with an items array (1-25 rows). " +
          "create: { query, exchange?, securityType?, isFavourite?, currencyCode? } -- the security is looked up and validated by ticker/name against the user's configured price provider, which fills the official symbol/name/exchange/type/currency (do not invent them); exchange/securityType MUST come from the enumerated lists; exchange disambiguates a symbol traded on several exchanges. " +
          "update: { symbol, securityType?, exchange?, isFavourite?, currencyCode? } -- symbol identifies an existing security (ticker or name); provide the classification/display fields to change. " +
          "delete: { symbol } -- removes the security (fails if it still has holdings or investment transactions). " +
          "approvalMode = 'bulk' (default; one card for the whole batch) or 'individual' (one card per item); ignored for a single item. Set dryRun=true to preview every item without saving. The user is asked to confirm before anything is saved (web chat card via relay, or an MCP confirmation dialog).",
        inputSchema: {
          operation: z
            .enum(["create", "update", "delete"])
            .describe("The operation to perform on every item."),
          items: z
            .array(
              z.object({
                query: z
                  .string()
                  .min(1)
                  .max(100)
                  .optional()
                  .describe(
                    "create: ticker symbol or security name to look up and validate.",
                  ),
                symbol: z
                  .string()
                  .min(1)
                  .max(100)
                  .optional()
                  .describe(
                    "update/delete: the existing security's ticker symbol (or name).",
                  ),
                exchange: z
                  .enum(SECURITY_EXCHANGES)
                  .optional()
                  .describe(
                    "create: exchange to disambiguate the lookup. update: new exchange. Must be one of the enumerated values.",
                  ),
                securityType: z
                  .enum(SECURITY_TYPES)
                  .optional()
                  .describe(
                    "create/update: security type. Must be one of the enumerated values.",
                  ),
                isFavourite: z
                  .boolean()
                  .optional()
                  .describe(
                    "create/update: pin the security to the dashboard Favourite Securities widget.",
                  ),
                currencyCode: z
                  .string()
                  .regex(/^[A-Za-z]{3}$/)
                  .optional()
                  .describe(
                    "create/update: ISO 4217 currency code (e.g. 'USD').",
                  ),
              }),
            )
            .min(1)
            .max(MAX_BULK_ACTION_ROWS)
            .describe("The rows to act on (1-25)."),
          approvalMode: z
            .enum(["bulk", "individual"])
            .optional()
            .describe(
              "How multi-item batches are approved: 'bulk' (default) one card for all; 'individual' one card per item. Ignored for a single item.",
            ),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a per-item preview without saving anything.",
            ),
        },
        outputSchema: manageSecuritiesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        const operation = args.operation as ManageSecOperation;
        const items = args.items as ManageSecItem[];
        const approvalMode = (args.approvalMode ?? "bulk") as ApprovalMode;

        try {
          if (args.dryRun) {
            return this.manageSecDryRun(ctx.userId, operation, items);
          }
          if (operation === "create") {
            return await this.manageSecCreate(
              server,
              ctx.userId,
              items,
              approvalMode,
              extra.requestId,
            );
          }
          if (operation === "update") {
            return await this.manageSecUpdate(
              server,
              ctx.userId,
              items,
              approvalMode,
              extra.requestId,
            );
          }
          return await this.manageSecDelete(
            server,
            ctx.userId,
            items,
            approvalMode,
            extra.requestId,
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "manage_investment_transactions",
      {
        title: "Manage investment transactions",
        annotations: WRITE,
        description:
          "Create, update, or delete the user's brokerage/investment-account transactions (BUY, SELL, DIVIDEND, INTEREST, CAPITAL_GAIN, SPLIT, TRANSFER_IN, TRANSFER_OUT, REINVEST, ADD_SHARES, REMOVE_SHARES). Accepts NAMES for account, funding account, and security -- they are resolved internally, so you do NOT need to call get_accounts/lookup_securities first. operation = 'create' | 'update' | 'delete' with an items array (1-25 rows). " +
          "create: { accountName, action, date, security?, quantity?, price?, commission?, fundingAccountName?, description? } -- security is required for BUY, SELL, SPLIT, REINVEST, ADD_SHARES, REMOVE_SHARES (matched by ticker or name). Buys debit and sells/dividends/interest/capital gains credit the brokerage's linked cash account automatically -- do not also create a separate cash transaction; fundingAccountName overrides which cash account is used. " +
          "update: { transactionId, action?, date?, security?, quantity?, price?, commission?, description? } -- provide only the fields to change (>=1); omitted fields keep their current value; the total and cash impact are recomputed. " +
          "delete: { transactionId } -- deleting one leg of a security transfer removes the paired leg too and reverses any linked cash impact. " +
          "approvalMode controls the confirmation: by default 6 or more items show one confirmation for the whole batch and 1-5 items show one confirmation per item; pass 'individual' to force one confirmation per item at any count; ignored for a single item. The user is asked to confirm before anything is saved (web chat card via relay, or an MCP confirmation dialog).",
        inputSchema: {
          operation: z
            .enum(["create", "update", "delete"])
            .describe("The operation to perform on every item."),
          items: z
            .array(
              z.object({
                accountName: z
                  .string()
                  .max(100)
                  .optional()
                  .describe(
                    "create: investment/brokerage account name. The base pair name (e.g. 'RRSP') resolves to its brokerage account ('RRSP - Brokerage'); the exact name also works.",
                  ),
                fundingAccountName: z
                  .string()
                  .max(100)
                  .optional()
                  .describe(
                    "create: optional cash account that funds a buy or receives a sell's proceeds. Omit to use the brokerage's own linked cash account.",
                  ),
                security: z
                  .string()
                  .min(1)
                  .max(100)
                  .optional()
                  .describe(
                    "create/update: security ticker symbol or name. Required (create) for BUY, SELL, SPLIT, REINVEST, ADD_SHARES, REMOVE_SHARES. Matched to one of the user's securities.",
                  ),
                action: z
                  .nativeEnum(InvestmentAction)
                  .optional()
                  .describe(
                    "create: transaction type. update: new type (omit to keep).",
                  ),
                date: z
                  .string()
                  .max(10)
                  .optional()
                  .describe("Transaction date (YYYY-MM-DD)."),
                quantity: z
                  .number()
                  .min(0)
                  .max(999999999999)
                  .optional()
                  .describe(
                    "Number of shares (8 dp). For SPLIT, the split ratio (>0).",
                  ),
                price: z
                  .number()
                  .min(0)
                  .max(999999999999)
                  .optional()
                  .describe(
                    "Price per share (6 dp). For DIVIDEND/INTEREST/CAPITAL_GAIN with no quantity, the total cash amount.",
                  ),
                commission: z
                  .number()
                  .min(0)
                  .max(999999999999)
                  .optional()
                  .describe("Commission or fee (4 dp). Defaults to 0."),
                exchangeRate: z
                  .number()
                  .min(0)
                  .max(999999999999)
                  .optional()
                  .describe(
                    "create/update: FX rate converting the security's currency into the funding cash account's currency (e.g. for a EUR security funded from a PLN account, the EUR->PLN rate such as 4.2514). Supply this when the broker's settlement data gives the rate or the converted cash total, so the cash posting is exact. Omit for same-currency transactions, or to use the rate for the transaction date.",
                  ),
                description: z
                  .string()
                  .max(500)
                  .optional()
                  .describe("Optional description or memo."),
                transactionId: z
                  .string()
                  .uuid()
                  .optional()
                  .describe("update/delete: investment transaction ID."),
              }),
            )
            .min(1)
            .max(MAX_BULK_ACTION_ROWS)
            .describe("The rows to act on (1-25)."),
          approvalMode: z
            .enum(["bulk", "individual"])
            .optional()
            .describe(
              "How multi-item batches are approved: by default 6 or more items show one card for the whole batch and 1-5 items show one card per item; 'individual' forces one card per item at any count. Ignored for a single item.",
            ),
        },
        outputSchema: manageInvestmentTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        const operation = args.operation as ManageInvOperation;
        const items = args.items as ManageInvItem[];
        const approvalMode = resolveApprovalMode(
          args.approvalMode as ApprovalMode | undefined,
          items.length,
        );

        try {
          if (operation === "create") {
            return await this.manageInvCreate(
              server,
              ctx.userId,
              items,
              approvalMode,
              extra.requestId,
            );
          }
          if (operation === "update") {
            return await this.manageInvUpdate(
              server,
              ctx.userId,
              items,
              approvalMode,
              extra.requestId,
            );
          }
          return await this.manageInvDelete(
            server,
            ctx.userId,
            items,
            approvalMode,
            extra.requestId,
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // manage_investment_transactions helpers
  // -------------------------------------------------------------------------

  private toInvCreateRow(item: ManageInvItem): InvestmentCreateRowInput {
    return {
      accountName: item.accountName as string,
      action: item.action as InvestmentAction,
      date: item.date as string,
      securityQuery: item.security,
      quantity: item.quantity,
      price: item.price,
      commission: item.commission,
      fundingAccountName: item.fundingAccountName,
      exchangeRate: item.exchangeRate,
      description: item.description,
    };
  }

  private toInvUpdateRow(item: ManageInvItem): InvestmentUpdateRowInput {
    return {
      transactionId: item.transactionId as string,
      action: item.action,
      date: item.date,
      securityQuery: item.security,
      quantity: item.quantity,
      price: item.price,
      commission: item.commission,
      exchangeRate: item.exchangeRate,
      description: item.description,
    };
  }

  /**
   * Reserve N writes against the daily cap or return an error result. Returns
   * undefined when allowed.
   */
  private checkWriteBudget(userId: string, count: number) {
    const limitCheck = this.writeLimiter.checkLimit(userId);
    if (limitCheck.currentCount + count > limitCheck.limit) {
      return toolError(
        `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
      );
    }
    return undefined;
  }

  private async manageInvCreate(
    server: McpServer,
    userId: string,
    items: ManageInvItem[],
    approvalMode: ApprovalMode,
    requestId: unknown,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview =
        await this.investmentTransactionsService.prepareCreateInvestmentSingle(
          userId,
          this.toInvCreateRow(items[0]),
        );
      const budget = this.checkWriteBudget(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildCreateInvestmentTransaction(
        userId,
        preview,
      );
      if (this.relayService.emitPendingAction(userId, action)) {
        return toolResult(RELAY_PREVIEW_SHOWN);
      }
      const confirmation = await confirmWrite(
        server,
        this.createConfirmLines(preview).join("\n"),
        requestId as never,
      );
      if (confirmation === "declined") {
        return toolError(
          "Cancelled: the confirmation was declined, so no investment transaction was created.",
        );
      }
      const tx = await this.investmentTransactionsService.create(userId, {
        accountId: preview.accountId,
        action: preview.action,
        transactionDate: preview.transactionDate,
        securityId: preview.securityId ?? undefined,
        fundingAccountId: preview.fundingAccountId ?? undefined,
        quantity: preview.quantity ?? undefined,
        price: preview.price ?? undefined,
        commission: preview.commission,
        exchangeRate: preview.exchangeRate,
        description: preview.description ?? undefined,
      });
      this.writeLimiter.record(userId, "create_investment_transaction");
      return toolResult({ id: tx.id, date: tx.transactionDate, count: 1 });
    }

    const bulk =
      await this.investmentTransactionsService.prepareCreateInvestmentBulk(
        userId,
        items.map((i) => this.toInvCreateRow(i)),
      );
    if (bulk.okPreviews.length === 0) {
      return toolError(
        "None of the investment transactions could be prepared. Check the account, security, action, and date for each row.",
      );
    }
    const budget = this.checkWriteBudget(userId, bulk.okPreviews.length);
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = bulk.okPreviews.map((p) =>
        this.actionBuilder.buildCreateInvestmentTransaction(userId, p),
      );
      return this.runInvIndividual(
        server,
        userId,
        cards,
        requestId,
        bulk.skipped,
      );
    }

    // bulk mode: one card carrying every row.
    const action = this.actionBuilder.buildCreateInvestmentTransactions(
      userId,
      bulk.okPreviews,
      bulk.previewRows,
    );
    if (this.relayService.emitPendingAction(userId, action)) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      `Create ${bulk.okPreviews.length} investment transaction(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      requestId as never,
    );
    if (confirmation === "declined") {
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was created.",
      );
    }
    const result = await this.investmentTransactionsService.createBulk(
      userId,
      bulk.okPreviews.map((preview) => ({
        accountId: preview.accountId,
        action: preview.action,
        transactionDate: preview.transactionDate,
        securityId: preview.securityId ?? undefined,
        fundingAccountId: preview.fundingAccountId ?? undefined,
        quantity: preview.quantity ?? undefined,
        price: preview.price ?? undefined,
        commission: preview.commission,
        exchangeRate: preview.exchangeRate,
        description: preview.description ?? undefined,
      })),
    );
    const skipped = [...bulk.skipped];
    for (const s of result.skipped) {
      skipped.push({ index: bulk.okIndex[s.index], reason: s.reason });
    }
    for (let i = 0; i < result.created.length; i++) {
      this.writeLimiter.record(userId, "create_investment_transaction");
    }
    return toolResult({
      ids: result.created.map((t) => t.id),
      count: result.created.length,
      skipped,
    });
  }

  private async manageInvUpdate(
    server: McpServer,
    userId: string,
    items: ManageInvItem[],
    approvalMode: ApprovalMode,
    requestId: unknown,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview =
        await this.investmentTransactionsService.previewUpdateInvestmentTransaction(
          userId,
          items[0].transactionId as string,
          this.toInvUpdateRow(items[0]),
        );
      const budget = this.checkWriteBudget(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildUpdateInvestmentTransaction(
        userId,
        preview,
      );
      if (this.relayService.emitPendingAction(userId, action)) {
        return toolResult(RELAY_PREVIEW_SHOWN);
      }
      const confirmation = await confirmWrite(
        server,
        [
          "Apply this investment transaction edit?",
          ...this.editLines(preview),
        ].join("\n"),
        requestId as never,
      );
      if (confirmation === "declined") {
        return toolError(
          "Cancelled: the confirmation was declined, so the investment transaction was not changed.",
        );
      }
      const tx = await this.investmentTransactionsService.update(
        userId,
        preview.transactionId,
        {
          action: preview.action,
          transactionDate: preview.transactionDate,
          securityId: preview.securityId ?? undefined,
          fundingAccountId: preview.fundingAccountId ?? undefined,
          quantity: preview.quantity ?? undefined,
          price: preview.price ?? undefined,
          commission: preview.commission,
          exchangeRate: preview.exchangeRate,
          description: preview.description ?? undefined,
        },
      );
      this.writeLimiter.record(userId, "update_investment_transaction");
      return toolResult({ id: tx.id, count: 1 });
    }

    if (approvalMode === "individual") {
      const cards: PendingAiAction[] = [];
      const skipped: { index: number; reason: string }[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const preview =
            await this.investmentTransactionsService.previewUpdateInvestmentTransaction(
              userId,
              items[i].transactionId as string,
              this.toInvUpdateRow(items[i]),
            );
          cards.push(
            this.actionBuilder.buildUpdateInvestmentTransaction(
              userId,
              preview,
            ),
          );
        } catch (err) {
          skipped.push({ index: i, reason: this.reason(err) });
        }
      }
      if (cards.length === 0)
        return toolError(
          "None of the investment transaction edits could be prepared.",
        );
      const budget = this.checkWriteBudget(userId, cards.length);
      if (budget) return budget;
      return this.runInvIndividual(server, userId, cards, requestId, skipped);
    }

    const bulk =
      await this.investmentTransactionsService.prepareUpdateInvestmentBulk(
        userId,
        items.map((i) => this.toInvUpdateRow(i)),
      );
    if (bulk.okRows.length === 0)
      return toolError(
        "None of the investment transaction edits could be prepared.",
      );
    const budget = this.checkWriteBudget(userId, bulk.okRows.length);
    if (budget) return budget;
    const action = this.actionBuilder.buildBatchUpdateInvestmentTransactions(
      userId,
      bulk.okRows,
      bulk.previewRows,
    );
    if (this.relayService.emitPendingAction(userId, action)) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      `Apply ${bulk.okRows.length} investment transaction edit(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      requestId as never,
    );
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was changed.",
      );
    const ids: string[] = [];
    for (const row of bulk.okRows) {
      const tx = await this.investmentTransactionsService.update(
        userId,
        row.transactionId,
        {
          action: row.action,
          transactionDate: row.transactionDate,
          securityId: row.securityId ?? undefined,
          fundingAccountId: row.fundingAccountId ?? undefined,
          quantity: row.quantity ?? undefined,
          price: row.price ?? undefined,
          commission: row.commission,
          exchangeRate: row.exchangeRate,
          description: row.description ?? undefined,
        },
      );
      ids.push(tx.id);
      this.writeLimiter.record(userId, "update_investment_transaction");
    }
    return toolResult({ ids, count: ids.length, skipped: bulk.skipped });
  }

  private async manageInvDelete(
    server: McpServer,
    userId: string,
    items: ManageInvItem[],
    approvalMode: ApprovalMode,
    requestId: unknown,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview =
        await this.investmentTransactionsService.previewDeleteInvestmentTransaction(
          userId,
          items[0].transactionId as string,
        );
      const budget = this.checkWriteBudget(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildDeleteInvestmentTransaction(
        userId,
        preview,
      );
      if (this.relayService.emitPendingAction(userId, action)) {
        return toolResult(RELAY_PREVIEW_SHOWN);
      }
      const confirmation = await confirmWrite(
        server,
        [
          "Delete this investment transaction?",
          `Account: ${preview.accountName}`,
          `Type: ${preview.action}`,
          `Date: ${preview.transactionDate}`,
        ].join("\n"),
        requestId as never,
      );
      if (confirmation === "declined") {
        return toolError(
          "Cancelled: the confirmation was declined, so the investment transaction was not deleted.",
        );
      }
      await this.investmentTransactionsService.remove(
        userId,
        preview.transactionId,
      );
      this.writeLimiter.record(userId, "delete_investment_transaction");
      return toolResult({ id: preview.transactionId, deleted: true, count: 1 });
    }

    if (approvalMode === "individual") {
      const cards: PendingAiAction[] = [];
      const skipped: { index: number; reason: string }[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const preview =
            await this.investmentTransactionsService.previewDeleteInvestmentTransaction(
              userId,
              items[i].transactionId as string,
            );
          cards.push(
            this.actionBuilder.buildDeleteInvestmentTransaction(
              userId,
              preview,
            ),
          );
        } catch (err) {
          skipped.push({ index: i, reason: this.reason(err) });
        }
      }
      if (cards.length === 0)
        return toolError(
          "None of the investment transactions could be prepared.",
        );
      const budget = this.checkWriteBudget(userId, cards.length);
      if (budget) return budget;
      return this.runInvIndividual(server, userId, cards, requestId, skipped);
    }

    const bulk =
      await this.investmentTransactionsService.prepareDeleteInvestmentBulk(
        userId,
        items.map((i) => i.transactionId as string),
      );
    if (bulk.okRows.length === 0)
      return toolError(
        "None of the investment transactions could be prepared.",
      );
    const budget = this.checkWriteBudget(userId, bulk.okRows.length);
    if (budget) return budget;
    const action = this.actionBuilder.buildBatchDeleteInvestmentTransactions(
      userId,
      bulk.okRows,
      bulk.previewRows,
    );
    if (this.relayService.emitPendingAction(userId, action)) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      `Delete ${bulk.okRows.length} investment transaction(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      requestId as never,
    );
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was deleted.",
      );
    const ids: string[] = [];
    for (const row of bulk.okRows) {
      await this.investmentTransactionsService.remove(
        userId,
        row.transactionId,
      );
      ids.push(row.transactionId);
      this.writeLimiter.record(userId, "delete_investment_transaction");
    }
    return toolResult({ ids, count: ids.length, skipped: bulk.skipped });
  }

  /**
   * Individual mode: relay path emits every card to the web chat; otherwise
   * confirm + commit each card in turn.
   */
  private async runInvIndividual(
    server: McpServer,
    userId: string,
    cards: PendingAiAction[],
    requestId: unknown,
    skipped: { index: number; reason: string }[],
  ) {
    if (this.relayService.emitPendingAction(userId, cards[0])) {
      for (let i = 1; i < cards.length; i++) {
        this.relayService.emitPendingAction(userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const ids: string[] = [];
    for (const card of cards) {
      const confirmation = await confirmWrite(
        server,
        this.confirmLineFor(card),
        requestId as never,
      );
      if (confirmation === "declined") continue;
      const id = await this.commitCard(userId, card);
      if (id) ids.push(id);
    }
    return toolResult({ ids, count: ids.length, skipped });
  }

  /** Commit one signed investment card directly (non-relay individual mode). */
  private async commitCard(
    userId: string,
    card: PendingAiAction,
  ): Promise<string | null> {
    const d = card.descriptor;
    switch (d.type) {
      case "create_investment_transaction": {
        const tx = await this.investmentTransactionsService.create(userId, {
          accountId: d.accountId,
          action: d.action,
          transactionDate: d.transactionDate,
          securityId: d.securityId ?? undefined,
          fundingAccountId: d.fundingAccountId ?? undefined,
          quantity: d.quantity ?? undefined,
          price: d.price ?? undefined,
          commission: d.commission,
          exchangeRate: d.exchangeRate,
          description: d.description ?? undefined,
        });
        this.writeLimiter.record(userId, "create_investment_transaction");
        return tx.id;
      }
      case "update_investment_transaction": {
        const tx = await this.investmentTransactionsService.update(
          userId,
          d.transactionId,
          {
            action: d.action,
            transactionDate: d.transactionDate,
            securityId: d.securityId ?? undefined,
            fundingAccountId: d.fundingAccountId ?? undefined,
            quantity: d.quantity ?? undefined,
            price: d.price ?? undefined,
            commission: d.commission,
            exchangeRate: d.exchangeRate,
            description: d.description ?? undefined,
          },
        );
        this.writeLimiter.record(userId, "update_investment_transaction");
        return tx.id;
      }
      case "delete_investment_transaction": {
        await this.investmentTransactionsService.remove(
          userId,
          d.transactionId,
        );
        this.writeLimiter.record(userId, "delete_investment_transaction");
        return d.transactionId;
      }
      default:
        return null;
    }
  }

  private confirmLineFor(card: PendingAiAction): string {
    const p = card.preview;
    const sec = p.symbol ? `\nSecurity: ${p.symbol}` : "";
    switch (card.type) {
      case "delete_investment_transaction":
        return `Delete this investment transaction?\nAccount: ${p.accountName}\nType: ${p.investmentAction}\nDate: ${p.transactionDate}${sec}`;
      case "update_investment_transaction":
        return `Apply this investment transaction edit?\nAccount: ${p.accountName}\nType: ${p.investmentAction}\nDate: ${p.transactionDate}${sec}`;
      default:
        return `Create this investment transaction?\nAccount: ${p.accountName}\nType: ${p.investmentAction}\nDate: ${p.transactionDate}${sec}`;
    }
  }

  private createConfirmLines(preview: {
    accountName: string;
    action: InvestmentAction;
    transactionDate: string;
    symbol: string | null;
    securityName: string | null;
    quantity: number | null;
    price: number | null;
    commission: number;
    cashAccountName: string | null;
    cashCurrency: string | null;
    cashAmount: number | null;
  }): string[] {
    return ["Create this investment transaction?", ...this.editLines(preview)];
  }

  /** The security/quantity/price/cash detail lines shared by create + update. */
  private editLines(preview: {
    accountName: string;
    action: InvestmentAction;
    transactionDate: string;
    symbol: string | null;
    securityName: string | null;
    quantity: number | null;
    price: number | null;
    commission: number;
    cashAccountName: string | null;
    cashCurrency: string | null;
    cashAmount: number | null;
  }): string[] {
    const lines: string[] = [
      `Account: ${preview.accountName}`,
      `Type: ${preview.action}`,
      `Date: ${preview.transactionDate}`,
    ];
    if (preview.symbol) {
      lines.push(
        `Security: ${preview.symbol}${preview.securityName ? ` (${preview.securityName})` : ""}`,
      );
    }
    if (preview.quantity !== null) lines.push(`Quantity: ${preview.quantity}`);
    if (preview.price !== null) lines.push(`Price: ${preview.price}`);
    if (preview.commission) lines.push(`Commission: ${preview.commission}`);
    if (preview.cashAccountName && preview.cashAmount !== null) {
      lines.push(
        `Cash: ${preview.cashAmount} ${preview.cashCurrency} in ${preview.cashAccountName}`,
      );
    }
    return lines;
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

  // -------------------------------------------------------------------------
  // manage_securities helpers
  // -------------------------------------------------------------------------

  private toSecCreateRow(item: ManageSecItem): ManageCreateSecurityRow {
    return {
      query: item.query as string,
      exchange: item.exchange,
      securityType: item.securityType,
      isFavourite: item.isFavourite,
      currencyCode: item.currencyCode,
    };
  }

  private toSecUpdateRow(item: ManageSecItem): ManageUpdateSecurityRow {
    return {
      query: item.symbol as string,
      securityType: item.securityType,
      exchange: item.exchange,
      isFavourite: item.isFavourite,
      currencyCode: item.currencyCode,
    };
  }

  private toSecDeleteRow(item: ManageSecItem): ManageDeleteSecurityRow {
    return { query: item.symbol as string };
  }

  private async manageSecDryRun(
    userId: string,
    operation: ManageSecOperation,
    items: ManageSecItem[],
  ) {
    const prep =
      operation === "create"
        ? await this.securityPrepService.prepareCreateSecurities(
            userId,
            items.map((i) => this.toSecCreateRow(i)),
          )
        : operation === "update"
          ? await this.securityPrepService.prepareUpdateSecurities(
              userId,
              items.map((i) => this.toSecUpdateRow(i)),
            )
          : await this.securityPrepService.prepareDeleteSecurities(
              userId,
              items.map((i) => this.toSecDeleteRow(i)),
            );
    return toolResult({
      dryRun: true,
      operation,
      previews: prep.previewRows,
      skipped: prep.skipped,
      message:
        "This is a preview. Call again with dryRun=false to apply the changes.",
    });
  }

  private async emitOrConfirmSec(
    server: McpServer,
    userId: string,
    pendingAction: PendingAiAction,
    confirmMessage: string,
    requestId: unknown,
  ): Promise<"relay" | "accepted" | "declined"> {
    if (this.relayService.emitPendingAction(userId, pendingAction)) {
      return "relay";
    }
    const confirmation = await confirmWrite(
      server,
      confirmMessage,
      requestId as never,
    );
    return confirmation === "declined" ? "declined" : "accepted";
  }

  private async manageSecCreate(
    server: McpServer,
    userId: string,
    items: ManageSecItem[],
    approvalMode: ApprovalMode,
    requestId: unknown,
  ) {
    if (items.length === 1) {
      const preview =
        await this.securityPrepService.prepareCreateSecuritySingle(
          userId,
          this.toSecCreateRow(items[0]),
        );
      const budget = this.checkWriteBudget(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildCreateSecurity(userId, preview);
      const outcome = await this.emitOrConfirmSec(
        server,
        userId,
        action,
        `Create this security?\nSymbol: ${preview.symbol}\nName: ${preview.name}\nCurrency: ${preview.currencyCode}`,
        requestId,
      );
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so no security was created.",
        );
      const security = await this.commitSecCreate(userId, preview);
      return toolResult({
        id: security.id,
        symbol: security.symbol,
        name: security.name,
        count: 1,
      });
    }

    const prep = await this.securityPrepService.prepareCreateSecurities(
      userId,
      items.map((i) => this.toSecCreateRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError(
        "None of the securities could be prepared. Check the ticker/name for each row.",
      );
    }
    const budget = this.checkWriteBudget(userId, prep.okPreviews.length);
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildCreateSecurity(userId, p),
      );
      return this.runSecIndividual(
        server,
        userId,
        cards,
        requestId,
        prep.skipped,
      );
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "create_security",
      prep.okRows,
      prep.previewRows,
    );
    if (this.relayService.emitPendingAction(userId, action)) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      `Create ${prep.okPreviews.length} security/securities?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      requestId as never,
    );
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was created.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      const security = await this.commitSecCreate(userId, preview);
      ids.push(security.id);
    }
    return toolResult({ ids, count: ids.length, skipped: prep.skipped });
  }

  private async manageSecUpdate(
    server: McpServer,
    userId: string,
    items: ManageSecItem[],
    approvalMode: ApprovalMode,
    requestId: unknown,
  ) {
    if (items.length === 1) {
      const preview =
        await this.securityPrepService.prepareUpdateSecuritySingle(
          userId,
          this.toSecUpdateRow(items[0]),
        );
      const budget = this.checkWriteBudget(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildUpdateSecurity(userId, preview);
      const outcome = await this.emitOrConfirmSec(
        server,
        userId,
        action,
        `Apply this security edit?\nSymbol: ${preview.symbol}\nType: ${preview.securityType ?? "(none)"}\nExchange: ${preview.exchange ?? "(none)"}\nCurrency: ${preview.currencyCode}`,
        requestId,
      );
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so the security was not changed.",
        );
      const security = await this.commitSecUpdate(userId, preview);
      return toolResult({
        id: security.id,
        symbol: security.symbol,
        name: security.name,
        count: 1,
      });
    }

    const prep = await this.securityPrepService.prepareUpdateSecurities(
      userId,
      items.map((i) => this.toSecUpdateRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError("None of the security edits could be prepared.");
    }
    const budget = this.checkWriteBudget(userId, prep.okPreviews.length);
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildUpdateSecurity(userId, p),
      );
      return this.runSecIndividual(
        server,
        userId,
        cards,
        requestId,
        prep.skipped,
      );
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "update_security",
      prep.okRows,
      prep.previewRows,
    );
    if (this.relayService.emitPendingAction(userId, action)) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      `Apply ${prep.okPreviews.length} security edit(s)?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      requestId as never,
    );
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was changed.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      const security = await this.commitSecUpdate(userId, preview);
      ids.push(security.id);
    }
    return toolResult({ ids, count: ids.length, skipped: prep.skipped });
  }

  private async manageSecDelete(
    server: McpServer,
    userId: string,
    items: ManageSecItem[],
    approvalMode: ApprovalMode,
    requestId: unknown,
  ) {
    if (items.length === 1) {
      const preview =
        await this.securityPrepService.prepareDeleteSecuritySingle(
          userId,
          this.toSecDeleteRow(items[0]),
        );
      const budget = this.checkWriteBudget(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildDeleteSecurity(userId, preview);
      const outcome = await this.emitOrConfirmSec(
        server,
        userId,
        action,
        `Delete this security?\nSymbol: ${preview.symbol}\nName: ${preview.name}`,
        requestId,
      );
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so the security was not deleted.",
        );
      await this.securitiesService.remove(userId, preview.securityId);
      this.writeLimiter.record(userId, "delete_security");
      return toolResult({ id: preview.securityId, deleted: true, count: 1 });
    }

    const prep = await this.securityPrepService.prepareDeleteSecurities(
      userId,
      items.map((i) => this.toSecDeleteRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError("None of the securities could be prepared.");
    }
    const budget = this.checkWriteBudget(userId, prep.okPreviews.length);
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildDeleteSecurity(userId, p),
      );
      return this.runSecIndividual(
        server,
        userId,
        cards,
        requestId,
        prep.skipped,
      );
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "delete_security",
      prep.okRows,
      prep.previewRows,
    );
    if (this.relayService.emitPendingAction(userId, action)) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      `Delete ${prep.okPreviews.length} security/securities?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      requestId as never,
    );
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was deleted.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      await this.securitiesService.remove(userId, preview.securityId);
      ids.push(preview.securityId);
      this.writeLimiter.record(userId, "delete_security");
    }
    return toolResult({ ids, count: ids.length, skipped: prep.skipped });
  }

  private async commitSecCreate(
    userId: string,
    preview: {
      symbol: string;
      name: string;
      securityType: string | null;
      exchange: string | null;
      currencyCode: string;
      isFavourite: boolean;
      quoteProvider: "yahoo" | "msn" | null;
      msnInstrumentId: string | null;
    },
  ) {
    const security = await this.securitiesService.create(userId, {
      symbol: preview.symbol,
      name: preview.name,
      securityType: preview.securityType ?? undefined,
      exchange: preview.exchange ?? undefined,
      currencyCode: preview.currencyCode,
      isFavourite: preview.isFavourite,
      quoteProvider: preview.quoteProvider ?? undefined,
      msnInstrumentId: preview.msnInstrumentId ?? undefined,
    });
    this.writeLimiter.record(userId, "create_security");
    return security;
  }

  private async commitSecUpdate(
    userId: string,
    preview: {
      securityId: string;
      securityType: string | null;
      exchange: string | null;
      currencyCode: string;
      isFavourite: boolean;
    },
  ) {
    const security = await this.securitiesService.update(
      userId,
      preview.securityId,
      {
        securityType: preview.securityType ?? undefined,
        exchange: preview.exchange ?? undefined,
        currencyCode: preview.currencyCode,
        isFavourite: preview.isFavourite,
      },
    );
    this.writeLimiter.record(userId, "update_security");
    return security;
  }

  /**
   * Individual mode for securities: relay path emits every card to the web chat;
   * otherwise confirm + commit each card in turn.
   */
  private async runSecIndividual(
    server: McpServer,
    userId: string,
    cards: PendingAiAction[],
    requestId: unknown,
    skipped: { index: number; reason: string }[],
  ) {
    if (this.relayService.emitPendingAction(userId, cards[0])) {
      for (let i = 1; i < cards.length; i++) {
        this.relayService.emitPendingAction(userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const ids: string[] = [];
    for (const card of cards) {
      const confirmation = await confirmWrite(
        server,
        this.secConfirmLineFor(card),
        requestId as never,
      );
      if (confirmation === "declined") continue;
      const id = await this.commitSecCard(userId, card);
      if (id) ids.push(id);
    }
    return toolResult({ ids, count: ids.length, skipped });
  }

  private secConfirmLineFor(card: PendingAiAction): string {
    const p = card.preview;
    switch (card.type) {
      case "delete_security":
        return `Delete this security?\nSymbol: ${p.symbol}\nName: ${p.securityName}`;
      case "update_security":
        return `Apply this security edit?\nSymbol: ${p.symbol}\nType: ${p.securityType ?? "(none)"}\nCurrency: ${p.securityCurrency}`;
      default:
        return `Create this security?\nSymbol: ${p.symbol}\nName: ${p.securityName}\nCurrency: ${p.securityCurrency}`;
    }
  }

  /** Commit one signed security card directly (non-relay individual mode). */
  private async commitSecCard(
    userId: string,
    card: PendingAiAction,
  ): Promise<string | null> {
    const d = card.descriptor;
    switch (d.type) {
      case "create_security": {
        const security = await this.commitSecCreate(userId, d);
        return security.id;
      }
      case "update_security": {
        const security = await this.commitSecUpdate(userId, d);
        return security.id;
      }
      case "delete_security": {
        await this.securitiesService.remove(userId, d.securityId);
        this.writeLimiter.record(userId, "delete_security");
        return d.securityId;
      }
      default:
        return null;
    }
  }
}
