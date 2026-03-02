import { z } from "zod";

/**
 * LLM07-F1: Zod schemas for validating AI tool inputs server-side.
 *
 * LLMs may produce malformed inputs that don't match the declared schema.
 * These schemas enforce type correctness before tool execution.
 */

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const queryTransactionsSchema = z.object({
  startDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  categoryNames: z.array(z.string().max(100)).optional(),
  accountNames: z.array(z.string().max(100)).optional(),
  searchText: z.string().max(200).optional(),
  groupBy: z.enum(["category", "payee", "month", "week"]).optional(),
  direction: z.enum(["income", "expense", "both"]).optional(),
});

export const getAccountBalancesSchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
});

export const getSpendingByCategorySchema = z.object({
  startDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  topN: z.number().int().min(1).max(50).optional(),
});

export const getIncomeSummarySchema = z.object({
  startDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  groupBy: z.enum(["category", "payee", "month"]).optional(),
});

export const getNetWorthHistorySchema = z.object({
  startDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD").optional(),
  endDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD").optional(),
});

export const comparePeriodsSchema = z.object({
  period1Start: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  period1End: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  period2Start: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  period2End: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  groupBy: z.enum(["category", "payee"]).optional(),
  direction: z.enum(["expenses", "income", "all"]).optional(),
});

export const getBudgetStatusSchema = z.object({
  period: z.string().max(20).optional(),
  budgetName: z.string().max(100).optional(),
});

export const toolInputSchemas: Record<string, z.ZodSchema> = {
  query_transactions: queryTransactionsSchema,
  get_account_balances: getAccountBalancesSchema,
  get_spending_by_category: getSpendingByCategorySchema,
  get_income_summary: getIncomeSummarySchema,
  get_net_worth_history: getNetWorthHistorySchema,
  compare_periods: comparePeriodsSchema,
  get_budget_status: getBudgetStatusSchema,
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
