import { AiToolDefinition } from "../providers/ai-provider.interface";

/**
 * Part 2: Structured output schemas for AI tool use / function calling.
 */

export const CATEGORIZATION_TOOL: AiToolDefinition = {
  name: "categorize_transaction",
  description: "TODO: Part 2 - Categorize a transaction",
  inputSchema: {},
};

export const QUERY_TRANSACTIONS_TOOL: AiToolDefinition = {
  name: "query_transactions",
  description: "TODO: Part 2 - Query user transactions",
  inputSchema: {},
};
