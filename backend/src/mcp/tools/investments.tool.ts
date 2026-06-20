import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortfolioService } from "../../securities/portfolio.service";
import { HoldingsService } from "../../securities/holdings.service";
import { SecuritiesService } from "../../securities/securities.service";
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
  PendingAiAction,
  MAX_BULK_ACTION_ROWS,
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
  queryInvestmentTransactionsOutput,
  getCapitalGainsOutput,
  getHoldingDetailsOutput,
  createSecurityOutput,
  lookupSecuritiesOutput,
  manageInvestmentTransactionsOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, WRITE } from "../mcp-annotations";

type ManageInvOperation = "create" | "update" | "delete";
type ApprovalMode = "bulk" | "individual";

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
  description?: string;
  // update / delete
  transactionId?: string;
}

@Injectable()
export class McpInvestmentsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly holdingsService: HoldingsService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly securitiesService: SecuritiesService,
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
      "query_investment_transactions",
      {
        title: "Query investment transactions",
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
        outputSchema: queryInvestmentTransactionsOutput,
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
          "Look up a ticker symbol or company name against the user's configured price provider (Yahoo/MSN) and return the matching securities WITHOUT adding anything. Read-only: use it to resolve an ambiguous reference or confirm the exact symbol/exchange before calling create_security. Each candidate is flagged with alreadyAdded=true when a security with that symbol is already in the user's list. Shares the lookup logic with the AI Assistant's lookup_securities tool.",
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
      "create_security",
      {
        title: "Create security",
        annotations: CREATE,
        description:
          "Add a new security (stock, ETF, mutual fund, etc.) to the user's security list. The security is looked up and validated by ticker symbol or name against the user's configured price provider, which fills in the official symbol, name, exchange, type, and currency -- do not invent those. Pass the optional `exchange` only to disambiguate a symbol that trades on several exchanges; an ambiguous lookup returns an error listing the candidates. `exchange` and `securityType` MUST come from the enumerated lists -- never guess a value outside them. Set dryRun=true to preview the resolved security without saving. When dryRun is false, the user is asked to confirm before it is saved (clients that support it show a confirmation dialog). Uses the same shared lookup/validation logic as the AI Assistant's create_security tool. Creates one security per call.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(100)
            .describe(
              "Ticker symbol (e.g. 'AAPL') or security name to look up and validate.",
            ),
          exchange: z
            .enum(SECURITY_EXCHANGES)
            .optional()
            .describe(
              "Optional exchange to disambiguate the lookup when a symbol trades on more than one exchange. Must be one of the enumerated values; omit to let the lookup choose.",
            ),
          securityType: z
            .enum(SECURITY_TYPES)
            .optional()
            .describe(
              "Optional security type override. Must be one of the enumerated values; omit to use the looked-up type.",
            ),
          isFavourite: z
            .boolean()
            .optional()
            .describe(
              "Pin the new security to the dashboard Favourite Securities widget. Defaults to false.",
            ),
          currencyCode: z
            .string()
            .regex(/^[A-Za-z]{3}$/)
            .optional()
            .describe(
              "Optional ISO 4217 currency code (e.g. 'USD'). Overrides the looked-up currency and lets creation proceed when the lookup can't determine one. Omit to use the looked-up currency.",
            ),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a preview without creating the security.",
            ),
        },
        outputSchema: createSecurityOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          // Shared lookup/validation: resolves the symbol/name against the
          // user's quote provider, fills exchange/type/currency, and enforces
          // the per-user unique symbol -- identical to the AI Assistant flow.
          const preview = await this.securitiesService.previewCreateSecurity(
            ctx.userId,
            {
              query: args.query,
              exchange: args.exchange,
              securityType: args.securityType,
              isFavourite: args.isFavourite,
              currencyCode: args.currencyCode,
            },
          );

          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                symbol: preview.symbol,
                name: preview.name,
                securityType: preview.securityType,
                exchange: preview.exchange,
                currencyCode: preview.currencyCode,
                isFavourite: preview.isFavourite,
                quoteProvider: preview.quoteProvider,
              },
              message:
                "This is a preview. Call again with dryRun=false to create the security.",
            });
          }

          // Relay path: confirm in the web chat via the approve/reject card
          // rather than an elicitation in the agent's MCP client.
          const pendingAction = this.actionBuilder.buildCreateSecurity(
            ctx.userId,
            preview,
          );
          if (this.relayService.emitPendingAction(ctx.userId, pendingAction)) {
            return toolResult(RELAY_PREVIEW_SHOWN);
          }

          // Ask the client to confirm before persisting (AI Assistant parity).
          const confirmLines = [
            "Create this security?",
            `Symbol: ${preview.symbol}`,
            `Name: ${preview.name}`,
          ];
          if (preview.securityType) {
            confirmLines.push(`Type: ${preview.securityType}`);
          }
          if (preview.exchange) {
            confirmLines.push(`Exchange: ${preview.exchange}`);
          }
          confirmLines.push(`Currency: ${preview.currencyCode}`);
          if (preview.isFavourite) {
            confirmLines.push("Pinned to favourites: yes");
          }
          const confirmation = await confirmWrite(
            server,
            confirmLines.join("\n"),
            extra.requestId,
          );
          if (confirmation === "declined") {
            return toolError(
              "Cancelled: the confirmation was declined, so no security was created. Do not retry unless the user asks again.",
            );
          }

          const security = await this.securitiesService.create(ctx.userId, {
            symbol: preview.symbol,
            name: preview.name,
            securityType: preview.securityType ?? undefined,
            exchange: preview.exchange ?? undefined,
            currencyCode: preview.currencyCode,
            isFavourite: preview.isFavourite,
            quoteProvider: preview.quoteProvider ?? undefined,
            msnInstrumentId: preview.msnInstrumentId ?? undefined,
          });

          this.writeLimiter.record(ctx.userId, "create_security");

          return toolResult({
            id: security.id,
            symbol: security.symbol,
            name: security.name,
            securityType: security.securityType,
            exchange: security.exchange,
            currencyCode: security.currencyCode,
            isFavourite: security.isFavourite,
          });
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
          "approvalMode = 'bulk' (default; one confirmation for the whole batch) or 'individual' (one confirmation per item); ignored for a single item. The user is asked to confirm before anything is saved (web chat card via relay, or an MCP confirmation dialog).",
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
              "How multi-item batches are approved: 'bulk' (default) one card for all; 'individual' one card per item. Ignored for a single item.",
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
        const approvalMode = (args.approvalMode ?? "bulk") as ApprovalMode;

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
}
