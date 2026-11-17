import type { AiProviderQueryBudgets } from '@/types/ai';

/**
 * The AI Assistant's per-query budgets, as a user editing their own provider
 * sees them.
 *
 * These belong to the provider: a config the user added in Settings -> AI
 * carries its own budgets, and a blank field means the built-in default. The
 * `AI_QUERY_*` environment variables size the *centrally managed* provider
 * only -- an operator's ceiling for the model they host, which the user cannot
 * see or edit and which never reaches these fields.
 *
 * The numbers are a copy of `QUERY_BUDGET_SPECS` in
 * `backend/src/ai/query/query-budgets.ts`, which is the authority; nothing
 * compiles the two together, so `ai-query-budgets.contract.test.ts` reads that
 * file and fails when a default or a bound drifts.
 */
export interface AiQueryBudgetField {
  /** Key on the create/update payload, and the backend column behind it. */
  readonly name: keyof AiProviderQueryBudgets;
  /** Suffix of the `settings.aiProviders.configForm.queryBudgets.*` keys. */
  readonly labelKey: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export const AI_QUERY_BUDGET_FIELDS: readonly AiQueryBudgetField[] = ([
  {
    name: 'queryMaxIterations',
    labelKey: 'maxIterations',
    default: 10,
    min: 1,
    max: 50,
  },
  {
    name: 'queryMaxToolCalls',
    labelKey: 'maxToolCalls',
    default: 20,
    min: 1,
    max: 200,
  },
  {
    name: 'queryTimeoutMinutes',
    labelKey: 'timeoutMinutes',
    default: 20,
    min: 1,
    max: 120,
  },
  {
    name: 'queryMaxInputTokens',
    labelKey: 'maxInputTokens',
    default: 200000,
    min: 1000,
    max: 2000000,
  },
  {
    name: 'queryMaxToolResultChars',
    labelKey: 'maxToolResultChars',
    default: 50000,
    min: 1000,
    max: 500000,
  },
] as const satisfies readonly AiQueryBudgetField[]);

/**
 * The same fields keyed by name, for the places that need one budget rather
 * than the list -- a form schema naming each field, say. Derived from the list
 * so the two cannot disagree.
 */
export const AI_QUERY_BUDGETS = Object.fromEntries(
  AI_QUERY_BUDGET_FIELDS.map((field) => [field.name, field]),
) as Record<keyof AiProviderQueryBudgets, AiQueryBudgetField>;
