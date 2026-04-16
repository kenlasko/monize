import { z } from "zod";

/**
 * LLM07-F1: Zod schemas for validating AI tool inputs server-side.
 *
 * LLMs may produce malformed inputs that don't match the declared schema.
 * These schemas enforce type correctness before tool execution.
 */

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Direction normalization. The model often sends variants of the same concept
 * (e.g. "expense" vs "expenses", "all" vs "both"). Normalize these at the
 * schema boundary so the tool executor gets a consistent canonical value and
 * the user doesn't see a failed-tool-call for a cosmetic difference.
 *
 * Canonical values: "expenses" | "income" | "both"
 */
const directionSchema = z.preprocess(
  (val) => {
    if (typeof val !== "string") return val;
    const normalized = val.toLowerCase().trim();
    // Aliases the model tends to produce.
    const aliases: Record<string, string> = {
      expense: "expenses",
      expenditure: "expenses",
      expenditures: "expenses",
      spending: "expenses",
      out: "expenses",
      outgoing: "expenses",
      debit: "expenses",
      debits: "expenses",
      earnings: "income",
      revenue: "income",
      in: "income",
      incoming: "income",
      credit: "income",
      credits: "income",
      all: "both",
      any: "both",
    };
    return aliases[normalized] ?? normalized;
  },
  z.enum(["expenses", "income", "both"]),
);

/**
 * Integer coercion from string. The model sometimes sends topN as "5" or even
 * "all" (which should be omitted). We coerce clean numeric strings and let
 * non-numeric values fail validation so the model gets a clear error.
 */
const positiveIntSchema = (min: number, max: number) =>
  z.preprocess(
    (val) =>
      typeof val === "string" && /^-?\d+$/.test(val) ? Number(val) : val,
    z.number().int().min(min).max(max),
  );

export const queryTransactionsSchema = z.object({
  startDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  categoryNames: z.array(z.string().max(100)).optional(),
  accountNames: z.array(z.string().max(100)).optional(),
  searchText: z.string().max(200).optional(),
  groupBy: z.enum(["category", "payee", "month", "week"]).optional(),
  direction: directionSchema.optional(),
});

export const getAccountBalancesSchema = z.object({
  accountNames: z.array(z.string().max(100)).optional(),
});

export const getSpendingByCategorySchema = z.object({
  startDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(isoDateRegex, "Expected YYYY-MM-DD"),
  topN: positiveIntSchema(1, 50).optional(),
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
  direction: directionSchema.optional(),
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
