import { Logger } from "@nestjs/common";
import { resolvePositiveInt } from "../../common/env-number.util";

/**
 * Per-query resource budgets for the AI Assistant's tool-calling loop.
 *
 * What a sensible ceiling is depends on the provider behind the assistant. A
 * hosted frontier model plans several tool calls per turn and finishes a
 * multi-step question inside the defaults; a small local Ollama model tends to
 * issue one lookup per turn and runs out of iterations mid-investigation. So
 * the budgets are configurable -- but *where* they are configured follows who
 * owns the provider, and there are exactly two owners:
 *
 * - **The centrally managed provider** (`AI_DEFAULT_PROVIDER` and friends) is
 *   the operator's, and nobody can edit it from the UI. Its budgets come from
 *   the `AI_QUERY_*` environment variables, resolved once at startup by
 *   `resolveQueryBudgets`.
 * - **A provider a user configured themselves** is theirs, and so are its
 *   budgets: they live on the `ai_provider_configs` row, are edited in AI
 *   Settings, and fall back to the defaults below when left blank.
 *   `resolveQueryBudgetsForConfig` is the only place that decision is made.
 *
 * The environment variables deliberately do **not** apply to a user's own
 * provider. An operator sizing the loop for the model they host says nothing
 * about the model somebody else pointed at their own Ollama box, and a global
 * ceiling silently reshaping a config the user can see and edit is the kind of
 * setting that reads as broken.
 *
 * The whole set is declared as data -- default, env var name, storage column
 * and accepted range in one table -- so a new budget cannot be added without a
 * name, a column or a bound, and cannot drift out of sync with `.env.example`
 * or `database/schema.sql`, both of which `query-budgets.spec.ts` checks.
 */

/**
 * A budget's default value, the env var that overrides it for the centrally
 * managed provider, the entity field and column that override it per user
 * provider, and the range a stored override may occupy.
 */
export interface QueryBudgetSpec {
  readonly envVar: string;
  /** Entity property on `AiProviderConfig` holding a per-provider override. */
  readonly field: string;
  /** Column backing `field` in `ai_provider_configs`. */
  readonly column: string;
  readonly default: number;
  /** Smallest accepted per-provider override. */
  readonly min: number;
  /**
   * Largest accepted per-provider override. A ceiling on a user-supplied
   * budget is what keeps "configurable" from meaning "unbounded": these numbers
   * bound the work one question can ask the server to do.
   */
  readonly max: number;
  readonly description: string;
}

export const QUERY_BUDGET_SPECS = {
  /**
   * Maximum trips through the tool-calling loop. Binds before `maxToolCalls`
   * for any model that issues a single tool call per turn, which is the common
   * shape for smaller local models.
   */
  maxIterations: {
    envVar: "AI_QUERY_MAX_ITERATIONS",
    field: "queryMaxIterations",
    column: "query_max_iterations",
    default: 10,
    min: 1,
    max: 50,
    description: "analysis steps (tool-calling loop iterations) per query",
  },
  /** LLM04-F1: maximum total tool calls per query across all iterations. */
  maxToolCalls: {
    envVar: "AI_QUERY_MAX_TOOL_CALLS",
    field: "queryMaxToolCalls",
    column: "query_max_tool_calls",
    default: 20,
    min: 1,
    max: 200,
    description: "data lookups (tool calls) per query",
  },
  /**
   * LLM04-F2: overall wall-clock budget for one query, in minutes.
   *
   * Independent of the per-provider timeout (e.g. Ollama's 15-minute one),
   * which stays untouched so scheduled tasks calling the provider directly
   * still get the full provider window.
   */
  timeoutMinutes: {
    envVar: "AI_QUERY_TIMEOUT_MINUTES",
    field: "queryTimeoutMinutes",
    column: "query_timeout_minutes",
    default: 20,
    min: 1,
    max: 120,
    description: "wall-clock minutes before a query is cut short",
  },
  /** LLM04-F3: maximum cumulative input tokens before aborting the query. */
  maxInputTokens: {
    envVar: "AI_QUERY_MAX_INPUT_TOKENS",
    field: "queryMaxInputTokens",
    column: "query_max_input_tokens",
    default: 200_000,
    min: 1_000,
    max: 2_000_000,
    description: "cumulative input tokens per query",
  },
  /** LLM08-F2: maximum size of a single tool result message, in characters. */
  maxToolResultChars: {
    envVar: "AI_QUERY_MAX_TOOL_RESULT_CHARS",
    field: "queryMaxToolResultChars",
    column: "query_max_tool_result_chars",
    default: 50_000,
    min: 1_000,
    max: 500_000,
    description: "characters kept from a single tool result",
  },
} as const satisfies Record<string, QueryBudgetSpec>;

export type QueryBudgetKey = keyof typeof QUERY_BUDGET_SPECS;

/** Resolved budgets, in the units the loop actually uses. */
export interface QueryBudgets {
  maxIterations: number;
  maxToolCalls: number;
  /** Derived from `timeoutMinutes`; the loop compares against a ms delta. */
  queryTimeoutMs: number;
  maxInputTokens: number;
  maxToolResultChars: number;
}

/**
 * Per-provider budget overrides, as stored on an `ai_provider_configs` row and
 * edited in AI Settings. `null`/`undefined` means "use the default".
 */
export interface ProviderQueryBudgetOverrides {
  queryMaxIterations?: number | null;
  queryMaxToolCalls?: number | null;
  queryTimeoutMinutes?: number | null;
  queryMaxInputTokens?: number | null;
  queryMaxToolResultChars?: number | null;
}

// Compile-time proof that every spec names a field this interface declares --
// a new budget whose `field` nobody added here fails `tsc`, not a review.
type SpecFieldsAreOverrideKeys =
  (typeof QUERY_BUDGET_SPECS)[QueryBudgetKey]["field"] extends keyof ProviderQueryBudgetOverrides
    ? true
    : never;
const _specFieldsAreOverrideKeys: SpecFieldsAreOverrideKeys = true;
void _specFieldsAreOverrideKeys;

/**
 * The budget-relevant shape of a resolved provider configuration: its
 * overrides, plus whether it is the centrally managed one built from
 * `AI_DEFAULT_*` rather than a row the user owns.
 */
export interface QueryBudgetSource extends ProviderQueryBudgetOverrides {
  isSystemDefault?: boolean;
}

/** Minimal surface needed to read config, so tests need not build a module. */
export interface BudgetConfigReader {
  get(key: string): unknown;
}

/** Iterate the spec table as typed pairs. */
const budgetSpecEntries = (): Array<[QueryBudgetKey, QueryBudgetSpec]> =>
  Object.entries(QUERY_BUDGET_SPECS) as Array<
    [QueryBudgetKey, QueryBudgetSpec]
  >;

/** Assemble the loop's units from one resolved value per budget. */
const toBudgets = (resolved: Record<QueryBudgetKey, number>): QueryBudgets => ({
  maxIterations: resolved.maxIterations,
  maxToolCalls: resolved.maxToolCalls,
  queryTimeoutMs: resolved.timeoutMinutes * 60 * 1000,
  maxInputTokens: resolved.maxInputTokens,
  maxToolResultChars: resolved.maxToolResultChars,
});

/**
 * Resolve every budget for the **centrally managed provider** from the
 * environment, falling back to the defaults.
 *
 * These values apply to `AI_DEFAULT_PROVIDER` only. A provider the user
 * configured for themselves carries its own budgets on its row; see
 * `resolveQueryBudgetsForConfig`.
 *
 * An override that is not a positive integer is refused and logged at warn:
 * running on the default is the right behaviour, but doing it silently leaves
 * an operator believing a typo took effect. Accepted overrides are logged too,
 * so the effective budget of a running instance is visible in its startup log
 * rather than inferable only from the environment.
 */
export function resolveQueryBudgets(
  config?: BudgetConfigReader,
  logger?: Logger,
): QueryBudgets {
  const resolved = {} as Record<QueryBudgetKey, number>;

  for (const [key, spec] of budgetSpecEntries()) {
    const raw = config?.get(spec.envVar);
    const { value, invalid } = resolvePositiveInt(raw, spec.default);
    if (invalid) {
      logger?.warn(
        `Ignoring ${spec.envVar}=${String(raw)}: expected a positive integer (${spec.description}). Using default ${spec.default}.`,
      );
    } else if (value !== spec.default) {
      logger?.log(
        `${spec.envVar}=${value} overrides the default ${spec.default} (${spec.description}).`,
      );
    }
    resolved[key] = value;
  }

  return toBudgets(resolved);
}

/**
 * Resolve the budgets for whichever provider answered this query.
 *
 * This is the one place the ownership rule is applied: the centrally managed
 * provider runs on `centralBudgets` (the `AI_QUERY_*` environment), and every
 * user-configured provider runs on the overrides stored on its own row, each
 * falling back to the built-in default -- never to the environment, which
 * describes a provider this user does not have.
 *
 * A stored value outside the accepted range is treated as unset rather than
 * clamped: it can only come from a hand-edited row or a restored artifact, and
 * an invented number is worse than the documented default.
 */
export function resolveQueryBudgetsForConfig(
  source: QueryBudgetSource,
  centralBudgets: QueryBudgets,
  logger?: Logger,
): QueryBudgets {
  if (source.isSystemDefault) {
    return centralBudgets;
  }

  const overrides = source as Record<string, unknown>;
  const resolved = {} as Record<QueryBudgetKey, number>;

  for (const [key, spec] of budgetSpecEntries()) {
    const raw = overrides[spec.field];
    const { value, invalid } = resolvePositiveInt(raw, spec.default);
    const outOfRange = !invalid && (value < spec.min || value > spec.max);
    if (invalid || outOfRange) {
      logger?.warn(
        `Ignoring stored ${spec.field}=${String(raw)}: expected an integer between ${spec.min} and ${spec.max} (${spec.description}). Using default ${spec.default}.`,
      );
      resolved[key] = spec.default;
      continue;
    }
    resolved[key] = value;
  }

  return toBudgets(resolved);
}
