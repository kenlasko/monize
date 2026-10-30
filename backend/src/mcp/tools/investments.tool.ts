import { Injectable } from "@nestjs/common";
import { describeSkippedRows } from "../../common/bulk-create.types";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { PortfolioService } from "../../securities/portfolio.service";
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
  BondRedemptionSplitPreview,
  resolveApprovalMode,
} from "../../ai/actions/ai-action.types";
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
  getPortfolioSummaryOutput,
  listInvestmentTransactionsOutput,
  getCapitalGainsOutput,
  manageSecuritiesOutput,
  lookupSecuritiesOutput,
  manageInvestmentTransactionsOutput,
} from "../tool-output-schemas";
import { READ_ONLY, WRITE } from "../mcp-annotations";
import {
  uuidString,
  manageOperation,
  approvalMode,
  dryRun,
  itemsArray,
} from "./schema-fragments";
import {
  numberArg,
  booleanArg,
  bondSeriesCodeSchema,
} from "../../common/tool-schemas";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";

type ManageInvOperation = "create" | "update" | "delete";
type ManageSecOperation = "create" | "update" | "delete" | "list";

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
  accruedInterest?: number;
  exchangeRate?: number;
  description?: string;
  bondSeriesCode?: string;
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
  // update only: manual country allocation, weights as PERCENTAGES (0-100).
  countryWeightings?: { name: string; weight: number }[];
  // update only: manual asset-class allocation (free-text names), weights as
  // PERCENTAGES (0-100).
  assetWeightings?: { name: string; weight: number }[];
}

@Injectable()
export class McpInvestmentsTools {
  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly securitiesService: SecuritiesService,
    private readonly securityPrepService: SecurityToolPrepService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
    private readonly accountsService: AccountsService,
    private readonly writeLimiter: McpWriteLimiter,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "get_portfolio_summary",
      {
        title: "Portfolio summary",
        annotations: READ_ONLY,
        description:
          "Portfolio overview: holdings, cost basis, gains and allocation, " +
          "plus a per-account breakdown in holdingsByAccount -- so use it for " +
          "single-account holdings questions too. Check valuationComplete " +
          "before quoting any total: false means a price or an exchange rate " +
          "was unavailable, and the figure is a subtotal, not a total. " +
          "includeLookThrough adds country and asset-class exposure.",
        inputSchema: z.object({
          accountNames: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe("Investment account names. Omit for all of them."),
          includeLookThrough: booleanArg()
            .optional()
            .describe(
              "Adds country and asset-class exposure. Costs an extra pass.",
            ),
        }),
        outputSchema: getPortfolioSummaryOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const accountFilter = await this.accountsService.resolveAccountFilter(
            user.userId,
            args.accountNames,
          );
          if (accountFilter.error) return toolError(accountFilter.error);
          const accountIds = accountFilter.accountIds;
          const summary = await this.portfolioService.getLlmSummary(
            user.userId,
            accountIds,
            { includeLookThrough: args.includeLookThrough === true },
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
          "Brokerage trades, income, splits, transfers and share adjustments " +
          "by account, symbol, action and date, optionally grouped. A VOID " +
          "row is listed but in no total. incomeByCurrency includes " +
          "reinvested income.",
        inputSchema: z.object({
          startDate: z.string().max(10).optional().describe("Start date."),
          endDate: z.string().max(10).optional().describe("End date."),
          accountNames: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe("Account names."),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Tickers, case-insensitive."),
          actions: z
            .array(z.nativeEnum(InvestmentAction))
            .max(18)
            .optional()
            .describe("Narrow to these actions."),
          groupBy: z
            .enum(["account", "date", "security", "action"])
            .optional()
            .describe("Defaults to 'security'."),
        }),
        outputSchema: listInvestmentTransactionsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const accountFilter = await this.accountsService.resolveAccountFilter(
            user.userId,
            args.accountNames,
          );
          if (accountFilter.error) return toolError(accountFilter.error);
          const accountIds = accountFilter.accountIds;
          const result =
            await this.investmentTransactionsService.getLlmInvestmentTransactions(
              user.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds,
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
      "list_capital_gains",
      {
        title: "Capital gains",
        annotations: READ_ONLY,
        description:
          "Realized and unrealized capital gains per period, at historical closes.",
        inputSchema: z.object({
          startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Start of the window."),
          endDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("End of the window."),
          accountNames: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe(
              "Optional investment account names (resolved internally).",
            ),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Optional security ticker symbols (case insensitive)."),
          groupBy: z
            .enum(["month", "security", "account"])
            .optional()
            .describe("Defaults to 'month'."),
        }),
        outputSchema: getCapitalGainsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const accountFilter = await this.accountsService.resolveAccountFilter(
            user.userId,
            args.accountNames,
          );
          if (accountFilter.error) return toolError(accountFilter.error);
          const accountIds = accountFilter.accountIds;
          const result =
            await this.investmentTransactionsService.getLlmCapitalGains(
              user.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds,
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
      "lookup_securities",
      {
        title: "Look up securities",
        annotations: READ_ONLY,
        description:
          "Look up a ticker or company name with the user's price provider " +
          "and return the matches WITHOUT adding anything. Use it to resolve " +
          "an ambiguous reference before manage_securities; a candidate " +
          "already in the user's list is flagged alreadyAdded.",
        inputSchema: z.object({
          search: z
            .string()
            .min(1)
            .max(100)
            .describe("Ticker symbol or company name to look up."),
          exchange: z
            .enum(SECURITY_EXCHANGES)
            .optional()
            .describe("Narrows the search. Omit to search everywhere."),
          provider: z
            .enum(["yahoo", "msn", "auto"])
            .optional()
            .describe("Defaults to the user's configured provider."),
        }),
        outputSchema: lookupSecuritiesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const result = await this.securitiesService.lookupSecuritiesForLlm(
            user.userId,
            {
              query: args.search,
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
          "List, create, edit or delete securities. list takes accountName " +
          "(name or id) and returns what it holds, with no items. A create " +
          "is validated against the price provider, which supplies the " +
          "official symbol, name, exchange, type and currency -- do not " +
          "invent them; pass `exchange` only to disambiguate a symbol listed " +
          "in more than one place. An update identifies the security by " +
          "symbol or name. A delete fails while it has holdings or " +
          "transactions.",
        inputSchema: z.object({
          operation: z
            .enum(["list", "create", "update", "delete"])
            .describe("list: accountName's holdings. Others: every item."),
          accountName: z
            .string()
            .max(100)
            .optional()
            .describe("list: name or id."),
          items: z
            .array(
              z.object({
                query: z
                  .string()
                  .min(1)
                  .max(100)
                  .optional()
                  .describe("create: ticker or name."),
                symbol: z
                  .string()
                  .min(1)
                  .max(100)
                  .optional()
                  .describe("update/delete: ticker or name."),
                exchange: z
                  .enum(SECURITY_EXCHANGES)
                  .optional()
                  .describe("create: disambiguates. update: the new one."),
                securityType: z.enum(SECURITY_TYPES).optional(),
                isFavourite: booleanArg()
                  .optional()
                  .describe("Pin to favourites."),
                currencyCode: z
                  .string()
                  .regex(/^[A-Za-z]{3}$/)
                  .optional()
                  .describe("ISO 4217."),
                countryWeightings: z
                  .array(
                    z.object({
                      name: z
                        .string()
                        .min(1)
                        .max(100)
                        .describe("Country name, canonical where possible."),
                      weight: numberArg(z.number().min(0).max(100)).describe(
                        "Percent, 0-100.",
                      ),
                    }),
                  )
                  .max(60)
                  .optional()
                  .describe(
                    "update: country allocation in percent; the rest is 'Other'.",
                  ),
                assetWeightings: z
                  .array(
                    z.object({
                      name: z
                        .string()
                        .min(1)
                        .max(100)
                        .describe("Asset class name, free text."),
                      weight: numberArg(z.number().min(0).max(100)).describe(
                        "Percent, 0-100.",
                      ),
                    }),
                  )
                  .max(60)
                  .optional()
                  .describe(
                    "update: asset-class allocation, same rule; reuse their spelling.",
                  ),
              }),
            )
            .max(25)
            .optional()
            .describe("The rows to act on (1-25)."),
          approvalMode: approvalMode(),
          dryRun: dryRun(),
        }),
        outputSchema: manageSecuritiesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const operation = args.operation as ManageSecOperation;
        const check = requireScope(
          user.scopes,
          operation === "list" ? "read" : "write",
        );
        if (check.error) return check.result;

        if (operation === "list") {
          try {
            return await this.listSecuritiesInAccount(
              user.userId,
              args.accountName,
            );
          } catch (err: unknown) {
            return safeToolError(err);
          }
        }

        const items = args.items as ManageSecItem[] | undefined;
        if (!items || items.length === 0) {
          return toolError(`${operation} needs 1-25 items.`);
        }
        const approvalMode = (args.approvalMode ?? "bulk") as ApprovalMode;

        try {
          if (args.dryRun) {
            return this.manageSecDryRun(user.userId, operation, items);
          }
          if (operation === "create") {
            return await this.manageSecCreate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
            );
          }
          if (operation === "update") {
            return await this.manageSecUpdate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
            );
          }
          return await this.manageSecDelete(
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

    server.registerTool(
      "manage_investment_transactions",
      {
        title: "Manage investment transactions",
        annotations: WRITE,
        description:
          "Create, update or delete brokerage transactions. Account, funding " +
          "account and security resolve by name. A buy debits, and a sale or " +
          "a distribution credits, the brokerage's linked " +
          "cash account automatically -- never record that cash movement " +
          "yourself; fundingAccountName overrides which account settles. " +
          "An update changes only the fields you send and recomputes the " +
          "total and the cash impact. Deleting one leg of a security transfer " +
          "removes its pair and reverses the linked cash movement.",
        inputSchema: z.object({
          operation: manageOperation(),
          items: itemsArray(
            z.object({
              accountName: z
                .string()
                .max(100)
                .optional()
                .describe(
                  "create: the brokerage account. A base pair name ('RRSP') resolves to its brokerage side.",
                ),
              fundingAccountName: z
                .string()
                .max(100)
                .optional()
                .describe(
                  "create: the cash account that funds or receives. Omit for the brokerage's linked one.",
                ),
              security: z
                .string()
                .min(1)
                .max(100)
                .optional()
                .describe(
                  "Ticker or name. Required for anything that moves shares.",
                ),
              action: z
                .nativeEnum(InvestmentAction)
                .optional()
                .describe("The transaction type."),
              date: z.string().max(10).optional().describe("Transaction date."),
              quantity: numberArg(z.number().min(0).max(999999999999))
                .optional()
                .describe("Number of shares, or the ratio for a SPLIT."),
              price: numberArg(z.number().min(0).max(999999999999))
                .optional()
                .describe(
                  "Price per share, or the total cash for an income row with no quantity.",
                ),
              commission: numberArg(z.number().min(0).max(999999999999))
                .optional()
                .describe("Commission or fee. Defaults to 0."),
              accruedInterest: numberArg(z.number().min(0).max(999999999999))
                .optional()
                .describe(
                  "REDEEM: accrued interest (linked INTEREST row). Bonds: omit; the redemption split fills it.",
                ),
              exchangeRate: numberArg(z.number().min(0).max(999999999999))
                .optional()
                .describe(
                  "Security-to-settlement currency rate. Give the broker's own for an exact cash posting; omit to use the date's rate.",
                ),
              description: z
                .string()
                .max(TRANSACTION_NOTE_MAX_LENGTH)
                .optional()
                .describe("Description or memo."),
              bondSeriesCode: bondSeriesCodeSchema
                .optional()
                .describe("e.g. EDO1036"),
              transactionId: uuidString()
                .optional()
                .describe("update/delete: the row's id."),
            }),
          ),
          approvalMode: approvalMode(),
        }),
        outputSchema: manageInvestmentTransactionsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "write");
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
              ctx,
              user.userId,
              items,
              approvalMode,
            );
          }
          if (operation === "update") {
            return await this.manageInvUpdate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
            );
          }
          return await this.manageInvDelete(
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
      accruedInterest: item.accruedInterest,
      fundingAccountName: item.fundingAccountName,
      exchangeRate: item.exchangeRate,
      description: item.description,
      bondSeriesCode: item.bondSeriesCode,
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
      accruedInterest: item.accruedInterest,
      exchangeRate: item.exchangeRate,
      description: item.description,
      bondSeriesCode: item.bondSeriesCode,
    };
  }

  private async manageInvCreate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageInvItem[],
    approvalMode: ApprovalMode,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview =
        await this.investmentTransactionsService.prepareCreateInvestmentSingle(
          userId,
          this.toInvCreateRow(items[0]),
        );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildCreateInvestmentTransaction(
        userId,
        preview,
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
        this.createConfirmLines(preview).join("\n"),
        action.descriptor,
      );
      if (isAsk(confirmation)) return confirmation.ask;
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
        accruedInterest: preview.accruedInterest,
        exchangeRate: preview.exchangeRate,
        description: preview.description ?? undefined,
        bondInstrumentId: preview.bondInstrumentId ?? undefined,
      });
      await this.writeLimiter.record(userId, "create_investment_transaction");
      return toolResult({ id: tx.id, date: tx.transactionDate, count: 1 });
    }

    const bulk =
      await this.investmentTransactionsService.prepareCreateInvestmentBulk(
        userId,
        items.map((i) => this.toInvCreateRow(i)),
      );
    if (bulk.okPreviews.length === 0) {
      return toolError(
        `None of the investment transactions could be prepared.${describeSkippedRows(bulk.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      bulk.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = bulk.okPreviews.map((p) =>
        this.actionBuilder.buildCreateInvestmentTransaction(userId, p),
      );
      return this.runInvIndividual(server, ctx, userId, cards, bulk.skipped);
    }

    // bulk mode: one card carrying every row.
    const action = this.actionBuilder.buildCreateInvestmentTransactions(
      userId,
      bulk.okPreviews,
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
      `Create ${bulk.okPreviews.length} investment transaction(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
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
        accruedInterest: preview.accruedInterest,
        exchangeRate: preview.exchangeRate,
        description: preview.description ?? undefined,
        bondInstrumentId: preview.bondInstrumentId ?? undefined,
      })),
    );
    const skipped = [...bulk.skipped];
    for (const s of result.skipped) {
      skipped.push({ index: bulk.okIndex[s.index], reason: s.reason });
    }
    for (let i = 0; i < result.created.length; i++) {
      await this.writeLimiter.record(userId, "create_investment_transaction");
    }
    return toolResult({
      ids: result.created.map((t) => t.id),
      count: result.created.length,
      skipped,
    });
  }

  private async manageInvUpdate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageInvItem[],
    approvalMode: ApprovalMode,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview =
        await this.investmentTransactionsService.previewUpdateInvestmentTransaction(
          userId,
          items[0].transactionId as string,
          this.toInvUpdateRow(items[0]),
        );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildUpdateInvestmentTransaction(
        userId,
        preview,
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
        [
          "Apply this investment transaction edit?",
          ...this.editLines(preview),
        ].join("\n"),
      );
      if (isAsk(confirmation)) return confirmation.ask;
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
          accruedInterest: preview.accruedInterest,
          exchangeRate: preview.exchangeRate,
          description: preview.description ?? undefined,
          bondInstrumentId: preview.bondInstrumentId ?? undefined,
        },
      );
      await this.writeLimiter.record(userId, "update_investment_transaction");
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
          `None of the investment transaction edits could be prepared.${describeSkippedRows(skipped, items.length)}`,
        );
      const budget = await this.writeLimiter.reserve(userId, cards.length);
      if (budget) return budget;
      return this.runInvIndividual(server, ctx, userId, cards, skipped);
    }

    const bulk =
      await this.investmentTransactionsService.prepareUpdateInvestmentBulk(
        userId,
        items.map((i) => this.toInvUpdateRow(i)),
      );
    if (bulk.okRows.length === 0)
      return toolError(
        `None of the investment transaction edits could be prepared.${describeSkippedRows(bulk.skipped, items.length)}`,
      );
    const budget = await this.writeLimiter.reserve(userId, bulk.okRows.length);
    if (budget) return budget;
    const action = this.actionBuilder.buildBatchUpdateInvestmentTransactions(
      userId,
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
      `Apply ${bulk.okRows.length} investment transaction edit(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
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
          accruedInterest: row.accruedInterest,
          exchangeRate: row.exchangeRate,
          description: row.description ?? undefined,
          bondInstrumentId: row.bondInstrumentId ?? undefined,
        },
      );
      ids.push(tx.id);
      await this.writeLimiter.record(userId, "update_investment_transaction");
    }
    return toolResult({ ids, count: ids.length, skipped: bulk.skipped });
  }

  private async manageInvDelete(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageInvItem[],
    approvalMode: ApprovalMode,
  ) {
    const single = items.length === 1;

    if (single) {
      const preview =
        await this.investmentTransactionsService.previewDeleteInvestmentTransaction(
          userId,
          items[0].transactionId as string,
        );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildDeleteInvestmentTransaction(
        userId,
        preview,
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
        [
          "Delete this investment transaction?",
          `Account: ${preview.accountName}`,
          `Type: ${preview.action}`,
          `Date: ${preview.transactionDate}`,
        ].join("\n"),
      );
      if (isAsk(confirmation)) return confirmation.ask;
      if (confirmation === "declined") {
        return toolError(
          "Cancelled: the confirmation was declined, so the investment transaction was not deleted.",
        );
      }
      await this.investmentTransactionsService.remove(
        userId,
        preview.transactionId,
      );
      await this.writeLimiter.record(userId, "delete_investment_transaction");
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
          `None of the investment transactions could be prepared.${describeSkippedRows(skipped, items.length)}`,
        );
      const budget = await this.writeLimiter.reserve(userId, cards.length);
      if (budget) return budget;
      return this.runInvIndividual(server, ctx, userId, cards, skipped);
    }

    const bulk =
      await this.investmentTransactionsService.prepareDeleteInvestmentBulk(
        userId,
        items.map((i) => i.transactionId as string),
      );
    if (bulk.okRows.length === 0)
      return toolError(
        `None of the investment transactions could be prepared.${describeSkippedRows(bulk.skipped, items.length)}`,
      );
    const budget = await this.writeLimiter.reserve(userId, bulk.okRows.length);
    if (budget) return budget;
    const action = this.actionBuilder.buildBatchDeleteInvestmentTransactions(
      userId,
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
      `Delete ${bulk.okRows.length} investment transaction(s)?${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
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
      await this.writeLimiter.record(userId, "delete_investment_transaction");
    }
    return toolResult({ ids, count: ids.length, skipped: bulk.skipped });
  }

  /**
   * Individual mode: relay path emits every card to the web chat; otherwise
   * confirm + commit each card in turn.
   */
  private async runInvIndividual(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    cards: PendingAiAction[],
    skipped: { index: number; reason: string }[],
  ) {
    // Only the round that asks may hand the cards to the web chat; on a retry
    // the human has already answered in their own client.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, cards[0]))
    ) {
      for (let i = 1; i < cards.length; i++) {
        await emitRelayCard(this.relayService, userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    // Every card is asked in ONE round: a round per card would be 25 rounds on
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
          accruedInterest: d.accruedInterest,
          exchangeRate: d.exchangeRate,
          description: d.description ?? undefined,
          bondInstrumentId: d.bondInstrumentId ?? undefined,
        });
        await this.writeLimiter.record(userId, "create_investment_transaction");
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
            accruedInterest: d.accruedInterest,
            exchangeRate: d.exchangeRate,
            description: d.description ?? undefined,
            bondInstrumentId: d.bondInstrumentId ?? undefined,
          },
        );
        await this.writeLimiter.record(userId, "update_investment_transaction");
        return tx.id;
      }
      case "delete_investment_transaction": {
        await this.investmentTransactionsService.remove(
          userId,
          d.transactionId,
        );
        await this.writeLimiter.record(userId, "delete_investment_transaction");
        return d.transactionId;
      }
      default:
        return null;
    }
  }

  private confirmLineFor(card: PendingAiAction): string {
    const p = card.preview;
    const sec =
      (p.symbol ? `\nSecurity: ${p.symbol}` : "") +
      (p.bondSeriesCode ? `\nSeries: ${p.bondSeriesCode}` : "");
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
    accruedInterest?: number;
    bondSeriesCode?: string | null;
    redemptionSplit?: BondRedemptionSplitPreview | null;
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
    accruedInterest?: number;
    bondSeriesCode?: string | null;
    redemptionSplit?: BondRedemptionSplitPreview | null;
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
    if (preview.bondSeriesCode) {
      lines.push(`Series: ${preview.bondSeriesCode}`);
    }
    if (preview.quantity !== null) lines.push(`Quantity: ${preview.quantity}`);
    if (preview.price !== null) lines.push(`Price: ${preview.price}`);
    if (preview.commission) lines.push(`Commission: ${preview.commission}`);
    if (preview.accruedInterest) {
      lines.push(`Accrued interest: ${preview.accruedInterest}`);
    }
    const split = preview.redemptionSplit;
    if (split) {
      lines.push(
        `Redemption split: principal ${split.principal}, interest ${split.interest}, deduction ${split.deduction}, payout ${split.payout}`,
      );
      if (split.outcome === "differs") {
        lines.push(
          "Warning: the price and accrued interest differ from the redemption split.",
        );
      }
    }
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

  private async listSecuritiesInAccount(
    userId: string,
    accountName: string | undefined,
  ) {
    if (!accountName?.trim()) {
      return toolError("list needs accountName.");
    }
    const { match, candidates } =
      await this.accountsService.resolveBrokerageByNameOrId(
        userId,
        accountName,
      );
    if (!match) {
      return toolError(
        candidates.length > 0
          ? `"${accountName}" is ambiguous: ${candidates.map((c) => c.name).join(", ")}.`
          : `Unknown account: ${accountName}. Call list_accounts to look up valid names.`,
      );
    }
    const securities = await this.securitiesService.listSecuritiesInAccount(
      userId,
      match.id,
    );
    return toolResult({
      operation: "list",
      account: match.name,
      count: securities.length,
      securities,
    });
  }

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
      countryWeightings: item.countryWeightings,
      assetWeightings: item.assetWeightings,
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

  private async manageSecCreate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManageSecItem[],
    approvalMode: ApprovalMode,
  ) {
    if (items.length === 1) {
      const preview =
        await this.securityPrepService.prepareCreateSecuritySingle(
          userId,
          this.toSecCreateRow(items[0]),
        );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildCreateSecurity(userId, preview);
      const outcome = await this.emitOrConfirmSec(
        server,
        ctx,
        userId,
        action,
        `Create this security?\nSymbol: ${preview.symbol}\nName: ${preview.name}\nCurrency: ${preview.currencyCode}`,
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
        `None of the securities could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildCreateSecurity(userId, p),
      );
      return this.runSecIndividual(server, ctx, userId, cards, prep.skipped);
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "create_security",
      prep.okRows,
      prep.previewRows,
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
      `Create ${prep.okPreviews.length} security/securities?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
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
    ctx: ServerContext,
    userId: string,
    items: ManageSecItem[],
    approvalMode: ApprovalMode,
  ) {
    if (items.length === 1) {
      const preview =
        await this.securityPrepService.prepareUpdateSecuritySingle(
          userId,
          this.toSecUpdateRow(items[0]),
        );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildUpdateSecurity(userId, preview);
      const outcome = await this.emitOrConfirmSec(
        server,
        ctx,
        userId,
        action,
        `Apply this security edit?\nSymbol: ${preview.symbol}\nType: ${preview.securityType ?? "(none)"}\nExchange: ${preview.exchange ?? "(none)"}\nCurrency: ${preview.currencyCode}`,
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
      return toolError(
        `None of the security edits could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildUpdateSecurity(userId, p),
      );
      return this.runSecIndividual(server, ctx, userId, cards, prep.skipped);
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "update_security",
      prep.okRows,
      prep.previewRows,
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
      `Apply ${prep.okPreviews.length} security edit(s)?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
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
    ctx: ServerContext,
    userId: string,
    items: ManageSecItem[],
    approvalMode: ApprovalMode,
  ) {
    if (items.length === 1) {
      const preview =
        await this.securityPrepService.prepareDeleteSecuritySingle(
          userId,
          this.toSecDeleteRow(items[0]),
        );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildDeleteSecurity(userId, preview);
      const outcome = await this.emitOrConfirmSec(
        server,
        ctx,
        userId,
        action,
        `Delete this security?\nSymbol: ${preview.symbol}\nName: ${preview.name}`,
      );
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so the security was not deleted.",
        );
      await this.securitiesService.remove(userId, preview.securityId);
      await this.writeLimiter.record(userId, "delete_security");
      return toolResult({ id: preview.securityId, deleted: true, count: 1 });
    }

    const prep = await this.securityPrepService.prepareDeleteSecurities(
      userId,
      items.map((i) => this.toSecDeleteRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError(
        `None of the securities could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildDeleteSecurity(userId, p),
      );
      return this.runSecIndividual(server, ctx, userId, cards, prep.skipped);
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "delete_security",
      prep.okRows,
      prep.previewRows,
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
      `Delete ${prep.okPreviews.length} security/securities?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was deleted.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      await this.securitiesService.remove(userId, preview.securityId);
      ids.push(preview.securityId);
      await this.writeLimiter.record(userId, "delete_security");
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
      quoteProvider: "yahoo" | "msn" | "lse" | "deutsche_boerse" | null;
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
    await this.writeLimiter.record(userId, "create_security");
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
      countryWeightings?: { name: string; weight: number }[] | null;
      assetWeightings?: { name: string; weight: number }[] | null;
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
        countryWeightings: preview.countryWeightings ?? [],
        assetWeightings: preview.assetWeightings ?? [],
      },
    );
    await this.writeLimiter.record(userId, "update_security");
    return security;
  }

  /**
   * Individual mode for securities: relay path emits every card to the web chat;
   * otherwise confirm + commit each card in turn.
   */
  private async runSecIndividual(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    cards: PendingAiAction[],
    skipped: { index: number; reason: string }[],
  ) {
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, cards[0]))
    ) {
      for (let i = 1; i < cards.length; i++) {
        await emitRelayCard(this.relayService, userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    // Every card is asked in ONE round: a round per card would be 25 rounds on
    // a full batch, and a multi-round-trip flow is two.
    const answers = await confirmWriteMany(
      server,
      ctx,
      confirmItemsForCards(cards, (card) => this.secConfirmLineFor(card)),
    );
    if (!(answers instanceof Map)) return answers.ask;
    const ids: string[] = [];
    for (const [index, card] of cards.entries()) {
      if (answers.get(cardKey(index)) === "declined") continue;
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
        await this.writeLimiter.record(userId, "delete_security");
        return d.securityId;
      }
      default:
        return null;
    }
  }
}
