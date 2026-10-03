import { RuleDefinitionLabels } from "./rule-labels";
import {
  RULE_CONDITION_FIELDS,
  RuleConditionNode,
  RuleField,
} from "./rule-condition.types";
import { RuleAction } from "./rule-action.types";
import {
  MAX_RULE_ACTIONS,
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_NODES,
  MAX_RULE_SPLIT_PARTS,
} from "./rule-validation";

/**
 * The name form of a rule definition, which is what a model reads and writes:
 * a leaf on an account, payee, category or tag field carries NAMES in `value`,
 * and an action carries `categoryName`, `payeeName` or `tagNames` where the
 * stored rule has ids. This file converts between the two and does nothing
 * else; finding the id for a name is the caller's, through the resolvers the
 * other tools use (`AccountsService`, `PayeesService`,
 * `resolveCategoryNamePaths`, `TagsService`), so there is one of each.
 */

export type RuleNameKind = "accounts" | "payees" | "categories" | "tags";

/** A name that did not become exactly one id. */
export type RuleNameFailure = "NAME_NOT_FOUND" | "NAME_AMBIGUOUS";

/** One problem with a model-supplied rule, at a dotted path into it. */
export interface RuleToolError {
  readonly path: string;
  readonly code: string;
  /** The name that failed, for `NAME_*` codes, and what kind of thing it was to name. */
  readonly name?: string;
  readonly kind?: RuleNameKind;
  /** Names the model could have meant. */
  readonly suggestions?: readonly string[];
}

export type NamedReferences = Record<RuleNameKind, string[]>;

export interface NameResolution {
  readonly id?: string;
  readonly failure?: RuleNameFailure;
  readonly suggestions?: readonly string[];
}

/** Looks up one name; the caller has resolved every name in `NamedReferences`. */
export type NameLookup = (kind: RuleNameKind, name: string) => NameResolution;

const KIND_OF_VALUE: Readonly<Record<string, RuleNameKind>> = {
  accountId: "accounts",
  payeeId: "payees",
  categoryId: "categories",
  tagIds: "tags",
};

/** Where an action keeps a name (or names) and the id key it replaces. */
interface ActionNameKey {
  readonly kind: RuleNameKind;
  readonly nameKey: string;
  readonly idKey: string;
}

const PAYEE_NAME: ActionNameKey = {
  kind: "payees",
  nameKey: "payeeName",
  idKey: "payeeId",
};

const ACTION_NAME_KEYS: Readonly<Record<string, readonly ActionNameKey[]>> = {
  set_category: [
    { kind: "categories", nameKey: "categoryName", idKey: "categoryId" },
  ],
  set_payee: [PAYEE_NAME],
  add_tags: [{ kind: "tags", nameKey: "tagNames", idKey: "tagIds" }],
  remove_tags: [{ kind: "tags", nameKey: "tagNames", idKey: "tagIds" }],
  convert_to_transfer: [
    { kind: "accounts", nameKey: "toAccountName", idKey: "toAccountId" },
    { kind: "accounts", nameKey: "fromAccountName", idKey: "fromAccountId" },
    PAYEE_NAME,
  ],
  split: [PAYEE_NAME],
};

/** The names of one `split` part: its category, the account it transfers to, its payee. */
const SPLIT_PART_NAME_KEYS: readonly ActionNameKey[] = [
  { kind: "categories", nameKey: "categoryName", idKey: "categoryId" },
  { kind: "accounts", nameKey: "transferTo", idKey: "transferAccountId" },
  PAYEE_NAME,
];

/** The most parts read for names; the validator refuses more (`MAX_RULE_SPLIT_PARTS`). */
const MAX_NAMED_SPLIT_PARTS = MAX_RULE_SPLIT_PARTS;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const stringsOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === "string",
  );

/** The name keys of an action, or none for a type this file does not map. */
const nameKeysOf = (action: unknown): readonly ActionNameKey[] =>
  isRecord(action) &&
  Object.prototype.hasOwnProperty.call(ACTION_NAME_KEYS, String(action.type))
    ? ACTION_NAME_KEYS[String(action.type)]
    : [];

/** The `split` parts of an action as far as they can be read (bounded; a bad shape is the validator's). */
const splitPartsOf = (action: unknown): unknown[] =>
  isRecord(action) && action.type === "split" && Array.isArray(action.parts)
    ? action.parts.slice(0, MAX_NAMED_SPLIT_PARTS)
    : [];

/**
 * Swap each present name key of `record` for its id key, converting the value
 * with `convert`. A key the record does not have is left alone.
 */
function nameKeysToIds(
  record: Record<string, unknown>,
  keys: readonly ActionNameKey[],
  path: string,
  convert: (kind: RuleNameKind, value: unknown, at: string) => unknown,
): Record<string, unknown> {
  let out = record;
  for (const spec of keys) {
    if (out[spec.nameKey] === undefined) continue;
    const { [spec.nameKey]: names, ...rest } = out;
    out = {
      ...rest,
      [spec.idKey]: convert(spec.kind, names, `${path}.${spec.nameKey}`),
    };
  }
  return out;
}

/** The inverse: swap each present id key for its name key. */
function idKeysToNames(
  record: Record<string, unknown>,
  keys: readonly ActionNameKey[],
  convert: (kind: RuleNameKind, value: unknown) => unknown,
): Record<string, unknown> {
  let out = record;
  for (const spec of keys) {
    if (out[spec.idKey] === undefined) continue;
    const { [spec.idKey]: ids, ...rest } = out;
    out = { ...rest, [spec.nameKey]: convert(spec.kind, ids) };
  }
  return out;
}

/** The id kind a leaf's field carries, or undefined for any other leaf. */
function leafKind(node: Record<string, unknown>): RuleNameKind | undefined {
  const field = node.field;
  if (
    typeof field !== "string" ||
    !Object.prototype.hasOwnProperty.call(RULE_CONDITION_FIELDS, field)
  ) {
    return undefined;
  }
  return KIND_OF_VALUE[RULE_CONDITION_FIELDS[field as RuleField].kind];
}

/**
 * Walk a condition tree without trusting its shape. The walk is bounded by the
 * validator's own depth and node limits, so an oversized tree costs a bounded
 * amount here and is then refused by `validateRuleDefinition` with its usual
 * code; a node this cannot read is left for the validator to report.
 */
function walkCondition(
  node: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
  visit: (leaf: Record<string, unknown>, path: string) => void,
  rebuild: (
    leaf: Record<string, unknown>,
    path: string,
  ) => Record<string, unknown>,
): unknown {
  if (!isRecord(node) || ++budget.nodes > MAX_RULE_CONDITION_NODES) {
    return node;
  }
  for (const key of ["all", "any"] as const) {
    if (Array.isArray(node[key])) {
      if (depth > MAX_RULE_CONDITION_DEPTH) return node;
      return {
        ...node,
        [key]: (node[key] as unknown[]).map((child, i) =>
          walkCondition(
            child,
            `${path}.${key}[${i}]`,
            depth + 1,
            budget,
            visit,
            rebuild,
          ),
        ),
      };
    }
  }
  if (leafKind(node) === undefined) return node;
  visit(node, path);
  return rebuild(node, path);
}

/** Every distinct name a definition mentions, per kind. */
export function collectNamedReferences(
  condition: unknown,
  actions: unknown,
): NamedReferences {
  const sets: Record<RuleNameKind, Set<string>> = {
    accounts: new Set(),
    payees: new Set(),
    categories: new Set(),
    tags: new Set(),
  };
  walkCondition(
    condition,
    "condition",
    1,
    { nodes: 0 },
    (leaf) => {
      const kind = leafKind(leaf);
      if (kind) for (const name of stringsOf(leaf.value)) sets[kind].add(name);
    },
    (leaf) => leaf,
  );
  if (Array.isArray(actions)) {
    for (const action of actions.slice(0, MAX_RULE_ACTIONS)) {
      if (!isRecord(action)) continue;
      for (const spec of nameKeysOf(action)) {
        for (const name of stringsOf(action[spec.nameKey])) {
          sets[spec.kind].add(name);
        }
      }
      for (const part of splitPartsOf(action)) {
        if (!isRecord(part)) continue;
        for (const spec of SPLIT_PART_NAME_KEYS) {
          for (const name of stringsOf(part[spec.nameKey])) {
            sets[spec.kind].add(name);
          }
        }
      }
    }
  }
  return {
    accounts: [...sets.accounts],
    payees: [...sets.payees],
    categories: [...sets.categories],
    tags: [...sets.tags],
  };
}

/**
 * Replace every name with its id. A name that did not resolve stays as it was
 * (the validator then also reports the malformed value at the same path) and
 * adds an entry to `errors`.
 */
export function namesToIds(
  condition: unknown,
  actions: unknown,
  lookup: NameLookup,
): { condition: unknown; actions: unknown; errors: RuleToolError[] } {
  const errors: RuleToolError[] = [];
  const convert = (
    kind: RuleNameKind,
    value: unknown,
    path: string,
  ): unknown => {
    const one = (name: unknown, at: string): unknown => {
      if (typeof name !== "string") return name;
      const found = lookup(kind, name);
      if (found.id) return found.id;
      errors.push({
        path: at,
        code: found.failure ?? "NAME_NOT_FOUND",
        name,
        kind,
        ...(found.suggestions?.length
          ? { suggestions: found.suggestions }
          : {}),
      });
      return name;
    };
    return Array.isArray(value)
      ? value.map((v, i) => one(v, `${path}[${i}]`))
      : one(value, path);
  };

  const mappedCondition = walkCondition(
    condition,
    "condition",
    1,
    { nodes: 0 },
    () => undefined,
    (leaf, path) => {
      const kind = leafKind(leaf) as RuleNameKind;
      return leaf.value === undefined
        ? leaf
        : { ...leaf, value: convert(kind, leaf.value, `${path}.value`) };
    },
  );

  const mappedActions = Array.isArray(actions)
    ? actions.map((action, i) => {
        if (!isRecord(action)) return action;
        const path = `actions[${i}]`;
        let out = nameKeysToIds(action, nameKeysOf(action), path, convert);
        if (splitPartsOf(action).length > 0) {
          const parts = out.parts as unknown[];
          out = {
            ...out,
            parts: parts.map((part, j) =>
              j < MAX_NAMED_SPLIT_PARTS && isRecord(part)
                ? nameKeysToIds(
                    part,
                    SPLIT_PART_NAME_KEYS,
                    `${path}.parts[${j}]`,
                    convert,
                  )
                : part,
            ),
          };
        }
        return out;
      })
    : actions;

  return { condition: mappedCondition, actions: mappedActions, errors };
}

/**
 * The name form of a validated definition: the inverse of {@link namesToIds}.
 * An id with no label (deleted since) keeps its id, so the reader can see that
 * something is there.
 */
export function idsToNames(
  definition: {
    condition: RuleConditionNode;
    actions: readonly RuleAction[];
  },
  labels: RuleDefinitionLabels,
): { condition: unknown; actions: unknown[] } {
  const name = (kind: RuleNameKind, id: string): string =>
    labels[kind][id] ?? id;
  const convert = (kind: RuleNameKind, value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((v) => (typeof v === "string" ? name(kind, v) : v))
      : typeof value === "string"
        ? name(kind, value)
        : value;

  const condition = walkCondition(
    definition.condition,
    "condition",
    1,
    { nodes: 0 },
    () => undefined,
    (leaf) => {
      const kind = leafKind(leaf) as RuleNameKind;
      return leaf.value === undefined
        ? leaf
        : { ...leaf, value: convert(kind, leaf.value) };
    },
  );

  const actions = definition.actions.map((action) => {
    const record = action as unknown as Record<string, unknown>;
    let out = idKeysToNames(record, nameKeysOf(record), convert);
    if (action.type === "split" && Array.isArray(out.parts)) {
      out = {
        ...out,
        parts: out.parts.map((part: unknown) =>
          isRecord(part)
            ? idKeysToNames(part, SPLIT_PART_NAME_KEYS, convert)
            : part,
        ),
      };
    }
    return out;
  });
  return { condition, actions };
}
