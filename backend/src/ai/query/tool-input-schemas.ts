import { z } from "zod";
import {
  directionSchema,
  isoDateSchema,
  positiveIntSchema,
} from "../../common/tool-schemas";

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

export const queryTransactionsSchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  categoryNames: z.array(z.string().max(100)).optional(),
  accountNames: z.array(z.string().max(100)).optional(),
  searchText: z.string().max(200).optional(),
  groupBy: z.enum(["category", "payee", "year", "month", "week"]).optional(),
  direction: directionSchema.optional(),
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

export const getAccountBalancesSchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
  status: z.enum(["open", "closed", "all"]).optional(),
  accountTypes: z.array(accountTypeSchema).max(10).optional(),
});

export const getCategoriesSchema = z.object({
  type: z.enum(["expense", "income", "all"]).optional(),
  search: z.string().max(100).optional(),
});

export const getSpendingByCategorySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  topN: positiveIntSchema(1, 50).optional(),
});

export const getIncomeSummarySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  groupBy: z.enum(["category", "payee", "month"]).optional(),
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

export const queryInvestmentTransactionsSchema = z.object({
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

export const getTransfersSchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  accountNames: z.array(z.string().max(100)).optional(),
});

export const getBudgetStatusSchema = z.object({
  period: z.string().max(20).optional(),
  budgetName: z.string().max(100).optional(),
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

export const getScheduledTransactionsSchema = z.object({
  kind: scheduledKindSchema.optional(),
  accountNames: z.array(z.string().max(100)).max(50).optional(),
  isActive: z.boolean().optional(),
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

export const searchTransactionsSchema = z.object({
  searchText: z.string().max(200).optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  accountName: z.string().max(100).optional(),
  categoryName: z.string().max(100).optional(),
  minAmount: z.number().min(-999999999999).max(999999999999).optional(),
  maxAmount: z.number().min(-999999999999).max(999999999999).optional(),
  limit: positiveIntSchema(1, 25).optional(),
});

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

export const createPayeeSchema = z.object({
  name: z.string().min(1).max(100),
  defaultCategoryName: z.string().max(100).optional(),
});

export const toolInputSchemas: Record<string, z.ZodSchema> = {
  query_transactions: queryTransactionsSchema,
  get_account_balances: getAccountBalancesSchema,
  get_categories: getCategoriesSchema,
  get_spending_by_category: getSpendingByCategorySchema,
  get_income_summary: getIncomeSummarySchema,
  get_net_worth_history: getNetWorthHistorySchema,
  compare_periods: comparePeriodsSchema,
  get_portfolio_summary: getPortfolioSummarySchema,
  query_investment_transactions: queryInvestmentTransactionsSchema,
  get_capital_gains: getCapitalGainsSchema,
  get_transfers: getTransfersSchema,
  get_budget_status: getBudgetStatusSchema,
  get_upcoming_bills: getUpcomingBillsSchema,
  get_scheduled_transactions: getScheduledTransactionsSchema,
  calculate: calculateSchema,
  render_chart: renderChartSchema,
  search_transactions: searchTransactionsSchema,
  create_transaction: createTransactionSchema,
  categorize_transaction: categorizeTransactionSchema,
  create_payee: createPayeeSchema,
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
