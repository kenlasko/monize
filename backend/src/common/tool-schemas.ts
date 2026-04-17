import { z } from "zod";

/**
 * Shared Zod primitives for tool inputs exposed to LLMs, used by both
 * the internal AI query engine (src/ai) and the MCP server (src/mcp).
 *
 * Keeping date and direction validation in one place prevents drift
 * between the two surfaces — the same normalization rules apply
 * regardless of which surface the model is talking to.
 */

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const isoDateSchema = z
  .string()
  .regex(isoDateRegex, "Expected YYYY-MM-DD");

/**
 * Direction normalization. The model often sends variants of the same
 * concept (e.g. "expense" vs "expenses", "all" vs "both"). Normalize
 * at the schema boundary so the tool executor always gets a canonical
 * value and the user doesn't see a failed tool call for a cosmetic
 * difference.
 */
export const directionSchema = z.preprocess(
  (val) => {
    if (typeof val !== "string") return val;
    const normalized = val.toLowerCase().trim();
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
 * Coerce clean numeric strings ("5") to integers while letting other
 * strings fail validation with a clear error. The model sometimes
 * sends topN / limit as a string.
 */
export const positiveIntSchema = (min: number, max: number) =>
  z.preprocess(
    (val) =>
      typeof val === "string" && /^-?\d+$/.test(val) ? Number(val) : val,
    z.number().int().min(min).max(max),
  );
