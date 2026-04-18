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
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  categoryNames: z.array(z.string().max(100)).optional(),
  accountNames: z.array(z.string().max(100)).optional(),
  searchText: z.string().max(200).optional(),
  groupBy: z.enum(["category", "payee", "year", "month", "week"]).optional(),
  direction: directionSchema.optional(),
});

export const getAccountBalancesSchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
});

export const getSpendingByCategorySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  topN: positiveIntSchema(1, 50).optional(),
});

export const getIncomeSummarySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  groupBy: z.enum(["category", "payee", "month"]).optional(),
});

export const getNetWorthHistorySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
});

export const comparePeriodsSchema = z.object({
  period1Start: isoDateSchema,
  period1End: isoDateSchema,
  period2Start: isoDateSchema,
  period2End: isoDateSchema,
  groupBy: z.enum(["category", "payee"]).optional(),
  direction: directionSchema.optional(),
});

export const getPortfolioSummarySchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
});

export const getTransfersSchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  accountNames: z.array(z.string().max(100)).optional(),
});

export const getBudgetStatusSchema = z.object({
  period: z.string().max(20).optional(),
  budgetName: z.string().max(100).optional(),
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

export const toolInputSchemas: Record<string, z.ZodSchema> = {
  query_transactions: queryTransactionsSchema,
  get_account_balances: getAccountBalancesSchema,
  get_spending_by_category: getSpendingByCategorySchema,
  get_income_summary: getIncomeSummarySchema,
  get_net_worth_history: getNetWorthHistorySchema,
  compare_periods: comparePeriodsSchema,
  get_portfolio_summary: getPortfolioSummarySchema,
  get_transfers: getTransfersSchema,
  get_budget_status: getBudgetStatusSchema,
  calculate: calculateSchema,
  render_chart: renderChartSchema,
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
