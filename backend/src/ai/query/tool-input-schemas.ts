import { z } from "zod";
import {
  directionSchema,
  isoDateSchema,
  positiveIntSchema,
} from "../../common/tool-schemas";
import { MAX_BULK_ACTION_ROWS } from "../actions/ai-action.types";
import {
  SECURITY_EXCHANGES,
  SECURITY_TYPES,
} from "../../securities/security-enums";

/**
 * LLM07-F1: Zod schemas for validating AI tool inputs server-side.
 *
 * LLMs may produce malformed inputs that don't match the declared schema.
 * These schemas enforce type correctness before tool execution.
 *
 * Shared Zod primitives (ISO date, direction normalization, positive int
 * coercion) live in `src/common/tool-schemas.ts` so the MCP server and
 * the internal AI query engine share the same validation rules.
 */

export const listTransactionsSchema = z.object({
  searchText: z.string().max(200).optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  accountNames: z.array(z.string().max(100)).max(50).optional(),
  categoryNames: z.array(z.string().max(100)).max(100).optional(),
  payeeNames: z.array(z.string().max(100)).max(100).optional(),
  minAmount: z.number().min(-999999999999).max(999999999999).optional(),
  maxAmount: z.number().min(-999999999999).max(999999999999).optional(),
  direction: directionSchema.optional(),
  groupBy: z
    .enum(["category", "payee", "year", "month", "week", "none"])
    .optional(),
  transfersOnly: z.boolean().optional(),
  includeTransactions: z.boolean().optional(),
  limit: positiveIntSchema(1, 100).optional(),
  sortBy: z.enum(["date", "amount", "payee"]).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
});

const accountTypeSchema = z.preprocess(
  (val) => (typeof val === "string" ? val.toUpperCase().trim() : val),
  z.enum([
    "CHEQUING",
    "SAVINGS",
    "CREDIT_CARD",
    "LOAN",
    "MORTGAGE",
    "INVESTMENT",
    "CASH",
    "LINE_OF_CREDIT",
    "ASSET",
    "OTHER",
  ]),
);

export const listAccountsSchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
  accountIds: z.array(z.string().uuid()).optional(),
  nameQuery: z.string().max(100).optional(),
  status: z.enum(["open", "closed", "all"]).optional(),
  accountTypes: z.array(accountTypeSchema).max(10).optional(),
});

export const getCategoriesSchema = z.object({
  type: z.enum(["expense", "income", "all"]).optional(),
  search: z.string().max(100).optional(),
});

export const getNetWorthHistorySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
});

export const comparePeriodsSchema = z.object({
  period1Start: isoDateSchema.optional(),
  period1End: isoDateSchema.optional(),
  period2Start: isoDateSchema.optional(),
  period2End: isoDateSchema.optional(),
  groupBy: z.enum(["category", "payee"]).optional(),
  direction: directionSchema.optional(),
});

export const getPortfolioSummarySchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
});

export const INVESTMENT_ACTIONS = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "INTEREST",
  "CAPITAL_GAIN",
  "SPLIT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "REINVEST",
  "ADD_SHARES",
  "REMOVE_SHARES",
] as const;

const investmentActionSchema = z.preprocess(
  (val) => (typeof val === "string" ? val.toUpperCase().trim() : val),
  z.enum(INVESTMENT_ACTIONS),
);

export const listInvestmentTransactionsSchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  accountNames: z.array(z.string().max(100)).max(50).optional(),
  symbols: z.array(z.string().min(1).max(20)).max(50).optional(),
  actions: z.array(investmentActionSchema).max(11).optional(),
  groupBy: z.enum(["account", "date", "security", "action"]).optional(),
});

export const getCapitalGainsSchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  accountNames: z.array(z.string().max(100)).max(50).optional(),
  symbols: z.array(z.string().min(1).max(20)).max(50).optional(),
  groupBy: z.enum(["month", "security", "account"]).optional(),
});

export const getBudgetStatusSchema = z.object({
  period: z.string().max(20).optional(),
  budgetName: z.string().max(100).optional(),
});

export const listPayeesSchema = z.object({
  search: z.string().max(200).optional(),
});

export const listHoldingDetailsSchema = z.object({
  accountName: z.string().max(100).optional(),
});

export const generateReportSchema = z.object({
  type: z.enum([
    "spending_by_category",
    "spending_by_payee",
    "income_vs_expenses",
    "monthly_trend",
    "income_by_source",
  ]),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
});

export const listAnomaliesSchema = z.object({
  months: positiveIntSchema(1, 24).optional(),
});

/** Report month in YYYY-MM form, matching the MCP monthly_comparison tool. */
const reportMonthSchema = z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM");

export const monthlyComparisonSchema = z.object({
  month: reportMonthSchema.optional(),
});

export const SCHEDULED_KINDS = [
  "bill",
  "deposit",
  "transfer",
  "investment",
  "all",
] as const;

const scheduledKindSchema = z.preprocess(
  (val) => (typeof val === "string" ? val.toLowerCase().trim() : val),
  z.enum(SCHEDULED_KINDS),
);

export const getUpcomingBillsSchema = z.object({
  days: positiveIntSchema(1, 365).optional(),
  kind: scheduledKindSchema.optional(),
  accountNames: z.array(z.string().max(100)).max(50).optional(),
});

export const calculateSchema = z.object({
  operation: z.enum(["percentage", "difference", "ratio", "sum", "average"]),
  values: z.array(z.number()).min(1).max(100),
  label: z.string().max(200).optional(),
});

/**
 * render_chart takes a compact, LLM-assembled visualization payload that
 * flows through the SSE stream to the browser. Caps keep the payload small
 * enough that recharts renders cleanly and that a misbehaving model can't
 * flood the client with thousands of points.
 */
export const renderChartSchema = z.object({
  type: z.enum(["bar", "pie", "line", "area"]),
  title: z.string().min(1).max(120),
  data: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        value: z.number().finite().nonnegative(),
      }),
    )
    .min(1)
    .max(20),
});

/**
 * Money amount matching CreateTransactionDto: bounded and at most 4 decimal
 * places. The decimal-place check mirrors `@IsNumber({ maxDecimalPlaces: 4 })`
 * so the model cannot smuggle a higher-precision value past the tool schema.
 */
const amountSchema = z
  .number()
  .finite()
  .min(-999999999999)
  .max(999999999999)
  .refine(
    (n) => Math.abs(n * 10000 - Math.round(n * 10000)) < 1e-6,
    "amount supports at most 4 decimal places",
  );

export const createTransactionSchema = z.object({
  accountName: z.string().min(1).max(100),
  amount: amountSchema,
  date: isoDateSchema,
  payeeName: z.string().max(100).optional(),
  categoryName: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  createPayeeIfMissing: z.boolean().optional(),
});

export const categorizeTransactionSchema = z.object({
  transactionId: z.string().uuid(),
  categoryName: z.string().min(1).max(100),
});

export const managePayeesSchema = z.object({
  operation: z.enum(["create", "update", "delete"]),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        newName: z.string().min(1).max(100).optional(),
        categoryName: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(MAX_BULK_ACTION_ROWS),
  approvalMode: z.enum(["bulk", "individual"]).optional(),
});

export const lookupSecuritiesSchema = z.object({
  query: z.string().min(1).max(100),
  exchange: z.enum(SECURITY_EXCHANGES).optional(),
  provider: z.enum(["yahoo", "msn", "auto"]).optional(),
});

export const manageSecuritiesSchema = z.object({
  operation: z.enum(["create", "update", "delete"]),
  items: z
    .array(
      z.object({
        // create: lookup query; update/delete: existing symbol or name.
        query: z.string().min(1).max(100).optional(),
        symbol: z.string().min(1).max(100).optional(),
        exchange: z.enum(SECURITY_EXCHANGES).optional(),
        securityType: z.enum(SECURITY_TYPES).optional(),
        isFavourite: z.boolean().optional(),
        // ISO 4217 alphabetic code; the confirm-time DTO re-validates it as a
        // known currency, so the schema only enforces the 3-letter shape here.
        currencyCode: z
          .string()
          .regex(/^[A-Za-z]{3}$/)
          .optional(),
        // update only: manual country allocation for an ETF/fund. Weights are
        // PERCENTAGES (0-100); a sub-100 total leaves the rest as "Other".
        countryWeightings: z
          .array(
            z.object({
              name: z.string().min(1).max(100),
              weight: z.number().min(0).max(100),
            }),
          )
          .max(60)
          .optional(),
      }),
    )
    .min(1)
    .max(MAX_BULK_ACTION_ROWS),
  approvalMode: z.enum(["bulk", "individual"]).optional(),
});

/**
 * A non-negative share/price/commission quantity. Bounded the same way the
 * money amount is; per-field decimal precision is enforced downstream by the
 * CreateInvestmentTransactionDto (and the preview rounds to column scale), so
 * the schema only needs to reject negatives and absurd magnitudes.
 */
const nonNegativeAmountSchema = z.number().finite().min(0).max(999999999999);

/**
 * Bulk variants: an array of the singular row schema, capped at
 * MAX_BULK_ACTION_ROWS so a pasted table cannot blow past the provider's
 * tool-call output-token budget. The singular schemas are reused directly so
 * the row shapes can never drift from their single-row counterparts.
 */
export const createTransactionsSchema = z.object({
  rows: z.array(createTransactionSchema).min(1).max(MAX_BULK_ACTION_ROWS),
});

/**
 * Unified `manage_investment_transactions` input. A single schema validated
 * per-operation via superRefine, mirroring `manageTransactionsSchema`: create
 * rows need accountName + action + date; update rows require the target id plus
 * at least one mutable field; delete rows need only the target id. `items` is
 * 1..MAX_BULK_ACTION_ROWS.
 */
const manageInvestmentItemSchema = z
  .object({
    accountName: z.string().min(1).max(100).optional(),
    fundingAccountName: z.string().min(1).max(100).optional(),
    security: z.string().min(1).max(100).optional(),
    action: investmentActionSchema.optional(),
    date: isoDateSchema.optional(),
    quantity: nonNegativeAmountSchema.optional(),
    price: nonNegativeAmountSchema.optional(),
    commission: nonNegativeAmountSchema.optional(),
    exchangeRate: nonNegativeAmountSchema.optional(),
    description: z.string().max(500).optional(),
    transactionId: z.string().uuid().optional(),
  })
  .passthrough();

export const manageInvestmentTransactionsSchema = z
  .object({
    operation: z.enum(["create", "update", "delete"]),
    items: z.array(manageInvestmentItemSchema).min(1).max(MAX_BULK_ACTION_ROWS),
    approvalMode: z.enum(["bulk", "individual"]).optional(),
  })
  .superRefine((value, ctx) => {
    value.items.forEach((item, index) => {
      const path = (field: string) => ["items", index, field];
      if (value.operation === "create") {
        if (!item.accountName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("accountName"),
            message: "accountName is required.",
          });
        }
        if (item.action === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("action"),
            message: "action is required.",
          });
        }
        if (item.date === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("date"),
            message: "date is required.",
          });
        }
      } else if (value.operation === "update") {
        if (!item.transactionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("transactionId"),
            message: "transactionId is required.",
          });
        }
        const hasChange =
          item.action !== undefined ||
          item.date !== undefined ||
          item.security !== undefined ||
          item.quantity !== undefined ||
          item.price !== undefined ||
          item.commission !== undefined ||
          item.description !== undefined;
        if (!hasChange) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("transactionId"),
            message:
              "Provide at least one field to change (action, date, security, quantity, price, commission, or description).",
          });
        }
      } else {
        if (!item.transactionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("transactionId"),
            message: "transactionId is required.",
          });
        }
      }
    });
  });

/**
 * Edit/delete schemas. Edits require at least one field to change (enforced via
 * refine) so a no-op confirmation card is never proposed; deletes need only the
 * target id.
 */
export const updateTransactionSchema = z
  .object({
    transactionId: z.string().uuid(),
    amount: amountSchema.optional(),
    date: isoDateSchema.optional(),
    payeeName: z.string().max(100).optional(),
    categoryName: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    createPayeeIfMissing: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.amount !== undefined ||
      v.date !== undefined ||
      v.payeeName !== undefined ||
      v.categoryName !== undefined ||
      v.description !== undefined,
    {
      message:
        "Provide at least one field to change (amount, date, payeeName, categoryName, or description).",
    },
  );

export const deleteTransactionSchema = z.object({
  transactionId: z.string().uuid(),
});

/**
 * Unified `manage_transactions` input. A single schema validated per-operation
 * via superRefine: create rows are a standard transaction unless `toAccountName`
 * is present (then a transfer), update rows require >=1 mutable field, and delete
 * rows need only the target id. `items` is 1..MAX_BULK_ACTION_ROWS so a pasted
 * table cannot blow past the provider's tool-call output-token budget.
 */
/**
 * One category split line on a create/update row. Category splits only: each
 * line names a category and the slice of the transaction amount it carries. The
 * slices must sum to the transaction amount (enforced downstream by
 * `validateSplits`); transfer/investment splits are not exposed through the tool.
 */
const manageTransactionSplitSchema = z.object({
  categoryName: z.string().min(1).max(100),
  amount: amountSchema,
  memo: z.string().max(500).optional(),
});

/** Largest split set a single transaction row may carry through the tool. */
const MAX_SPLIT_LINES = 50;

const manageTransactionItemSchema = z
  .object({
    // create (standard)
    accountName: z.string().min(1).max(100).optional(),
    // create (transfer)
    fromAccountName: z.string().min(1).max(100).optional(),
    toAccountName: z.string().min(1).max(100).optional(),
    // update / delete
    transactionId: z.string().uuid().optional(),
    // shared
    amount: amountSchema.optional(),
    date: isoDateSchema.optional(),
    payeeName: z.string().max(100).optional(),
    categoryName: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    createPayeeIfMissing: z.boolean().optional(),
    exchangeRate: z.number().finite().min(0).max(1_000_000).optional(),
    toAmount: amountSchema.optional(),
    // split transactions (category splits only)
    splits: z
      .array(manageTransactionSplitSchema)
      .max(MAX_SPLIT_LINES)
      .optional(),
  })
  .passthrough();

export const manageTransactionsSchema = z
  .object({
    operation: z.enum(["create", "update", "delete"]),
    items: z
      .array(manageTransactionItemSchema)
      .min(1)
      .max(MAX_BULK_ACTION_ROWS),
    approvalMode: z.enum(["bulk", "individual"]).optional(),
  })
  .superRefine((value, ctx) => {
    value.items.forEach((item, index) => {
      const path = (field: string) => ["items", index, field];
      // A split row carries a `splits` array instead of a single category and
      // cannot also be a transfer or name a top-level category.
      const hasSplits = item.splits !== undefined;
      if (hasSplits) {
        if (item.splits!.length < 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("splits"),
            message: "A split transaction needs at least 2 split lines.",
          });
        }
        if (item.categoryName !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("categoryName"),
            message:
              "Do not set categoryName on a split row; put categories in the splits array.",
          });
        }
        if (
          item.toAccountName !== undefined ||
          item.fromAccountName !== undefined
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("splits"),
            message: "splits cannot be combined with a transfer.",
          });
        }
        if (value.operation === "delete") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("splits"),
            message: "splits are not used for delete.",
          });
        }
      }
      if (value.operation === "create") {
        const isTransfer = item.toAccountName !== undefined;
        if (isTransfer) {
          if (!item.fromAccountName) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: path("fromAccountName"),
              message: "fromAccountName is required for a transfer.",
            });
          }
          if (item.amount === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: path("amount"),
              message: "amount is required.",
            });
          }
          if (item.date === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: path("date"),
              message: "date is required.",
            });
          }
        } else {
          if (!item.accountName) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: path("accountName"),
              message:
                "accountName is required (or provide toAccountName for a transfer).",
            });
          }
          if (item.amount === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: path("amount"),
              message: "amount is required.",
            });
          }
          if (item.date === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: path("date"),
              message: "date is required.",
            });
          }
        }
      } else if (value.operation === "update") {
        if (!item.transactionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("transactionId"),
            message: "transactionId is required.",
          });
        }
        const hasChange =
          item.amount !== undefined ||
          item.date !== undefined ||
          item.payeeName !== undefined ||
          item.categoryName !== undefined ||
          item.description !== undefined ||
          hasSplits;
        if (!hasChange) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("transactionId"),
            message:
              "Provide at least one field to change (amount, date, payeeName, categoryName, description, or splits).",
          });
        }
      } else {
        // delete
        if (!item.transactionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("transactionId"),
            message: "transactionId is required.",
          });
        }
      }
    });
  });

export const toolInputSchemas: Record<string, z.ZodSchema> = {
  list_transactions: listTransactionsSchema,
  list_accounts: listAccountsSchema,
  list_categories: getCategoriesSchema,
  get_net_worth_history: getNetWorthHistorySchema,
  compare_periods: comparePeriodsSchema,
  get_portfolio_summary: getPortfolioSummarySchema,
  list_investment_transactions: listInvestmentTransactionsSchema,
  list_capital_gains: getCapitalGainsSchema,
  get_budget_status: getBudgetStatusSchema,
  list_upcoming_bills: getUpcomingBillsSchema,
  calculate: calculateSchema,
  render_chart: renderChartSchema,
  manage_transactions: manageTransactionsSchema,
  manage_payees: managePayeesSchema,
  manage_securities: manageSecuritiesSchema,
  lookup_securities: lookupSecuritiesSchema,
  manage_investment_transactions: manageInvestmentTransactionsSchema,
  list_payees: listPayeesSchema,
  list_holding_details: listHoldingDetailsSchema,
  generate_report: generateReportSchema,
  list_anomalies: listAnomaliesSchema,
  monthly_comparison: monthlyComparisonSchema,
};

/**
 * Validate tool input against its Zod schema.
 * Returns { success: true, data } on valid input, or
 * { success: false, error } with a human-readable error message.
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>,
):
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string } {
  const schema = toolInputSchemas[toolName];
  if (!schema) {
    return { success: true, data: input };
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data as Record<string, unknown> };
  }

  const issues = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { success: false, error: `Invalid input: ${issues}` };
}
