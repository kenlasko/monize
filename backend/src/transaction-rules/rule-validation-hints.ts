import { RULE_ACTION_TYPES } from "./rule-action.types";
import {
  RULE_CONDITION_FIELDS,
  RULE_FIELDS,
  RULE_OPERATOR_SHAPES,
  RuleField,
} from "./rule-condition.types";
import {
  MAX_RULE_ACTIONS,
  RuleValidationCode,
  RuleValidationError,
} from "./rule-validation";

/**
 * A short English sentence per validation code: what is wrong and the correct
 * form. The `{ path, code }` list is exact but a model guesses from it (design
 * 10.1); the tools (assistant and MCP) send these beside it so the next call is
 * right. Pure, and total over the validation codes by type (`Record<RuleValidationCode, ...>`).
 */

/** The keys of each action as a model writes them (names, not ids). */
export const RULE_ACTION_TOOL_KEYS: Readonly<
  Record<(typeof RULE_ACTION_TYPES)[number], readonly string[]>
> = {
  set_category: ["type", "categoryName", "onlyIfEmpty"],
  set_payee: ["type", "payeeName", "onlyIfEmpty"],
  add_tags: ["type", "tagNames"],
  remove_tags: ["type", "tagNames"],
  request_ai_review: ["type", "instruction"],
  set_payee_from_text: ["type", "template", "createIfMissing", "onlyIfEmpty"],
  set_description: ["type", "template", "mode", "onlyIfEmpty"],
  convert_to_transfer: [
    "type",
    "toAccountName",
    "fromAccountName",
    "clearCategory",
    "payeeName",
  ],
  split: ["type", "payeeName", "parts"],
};

/** The keys of one `split` part as a model writes them. */
const SPLIT_PART_TOOL_KEYS = [
  "amount",
  "categoryName",
  "transferTo",
  "payeeName",
  "description",
] as const;
const SPLIT_FORM = `a split has 2-10 parts, each {"amount":"{capture}" or "rest" (at most one), then categoryName or transferTo (an account; not both), payeeName only with transferTo, description?}; the parts must add up to the transaction's amount.`;

const inSplitParts = (segments: readonly Segment[]): boolean =>
  segments[0] === "actions" && segments.includes("parts");

const MAX_HINTS = 6;
const LEAF_EXAMPLE = '{"field":"description","op":"contains","value":"ASSECO"}';
const CONDITION_FORM = `condition must be a JSON object: {"all":[...]} or {"any":[...]} (optional "not":true), or a leaf {"field","op","value"}, e.g. {"all":[${LEAF_EXAMPLE}]}. Never a string.`;
const ACTIONS_FORM =
  'actions must be a JSON array of objects, e.g. [{"type":"set_category","categoryName":"Groceries"}]. Never a string.';

type Segment = string | number;

/** `condition.all[0].value` -> ["condition", "all", 0, "value"]. */
function parsePath(path: string): Segment[] {
  const out: Segment[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  }
  return out;
}

function nodeAt(root: unknown, segments: readonly Segment[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface RuleHintDefinition {
  readonly condition?: unknown;
  readonly actions?: unknown;
}

type HintFn = (
  segments: readonly Segment[],
  definition: RuleHintDefinition,
) => string;

/** The node the error's path points INTO (its parent), or undefined. */
function parentNode(
  segments: readonly Segment[],
  definition: RuleHintDefinition,
): unknown {
  return nodeAt(definition, segments.slice(0, -1));
}

function leafOperators(field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(RULE_CONDITION_FIELDS, field)) {
    return null;
  }
  return RULE_CONDITION_FIELDS[field as RuleField].operators.join(", ");
}

function shapeOfLeafValue(
  segments: readonly Segment[],
  definition: RuleHintDefinition,
): string {
  const leaf = parentNode(
    typeof segments[segments.length - 1] === "number"
      ? segments.slice(0, -1)
      : segments,
    definition,
  );
  if (!isRecord(leaf) || typeof leaf.field !== "string") {
    return "The value has the wrong JSON type for this field.";
  }
  const spec = Object.prototype.hasOwnProperty.call(
    RULE_CONDITION_FIELDS,
    leaf.field,
  )
    ? RULE_CONDITION_FIELDS[leaf.field as RuleField]
    : undefined;
  const shape =
    typeof leaf.op === "string" &&
    Object.prototype.hasOwnProperty.call(RULE_OPERATOR_SHAPES, leaf.op)
      ? RULE_OPERATOR_SHAPES[leaf.op as keyof typeof RULE_OPERATOR_SHAPES]
      : undefined;
  const kind = spec?.kind ?? "the field's kind";
  if (shape === "list") {
    return `${leaf.op} takes a JSON array of ${kind} values, e.g. ["a","b"].`;
  }
  if (shape === "range") {
    return kind === "date"
      ? `${leaf.op} takes exactly two "YYYY-MM-DD" strings [from,to], earliest first.`
      : `${leaf.op} takes exactly two numbers [min,max], min first.`;
  }
  if (kind === "date") return `${leaf.field} takes a "YYYY-MM-DD" string.`;
  if (kind === "money" || kind === "dayOfMonth") {
    return `${leaf.field} takes a JSON number (not a string).`;
  }
  if (kind === "boolean") return `${leaf.field} takes true or false.`;
  return `${leaf.field} takes a ${kind === "enum" ? "string from its fixed list" : "string"}.`;
}

const generic =
  (text: string): HintFn =>
  () =>
    text;

const HINTS: Record<RuleValidationCode, HintFn> = {
  INVALID_SHAPE: (segments) => {
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (segments.length === 1 && first === "actions") return ACTIONS_FORM;
    if (inSplitParts(segments))
      return `parts is an array of objects: ${SPLIT_FORM}`;
    if (first === "actions") {
      return `Each action is a JSON object with a "type", e.g. {"type":"set_category","categoryName":"Groceries"}.`;
    }
    if (last === "all" || last === "any") {
      return `"${last}" holds a JSON array of conditions.`;
    }
    if (segments.length === 1) return CONDITION_FORM;
    return `Each entry of all/any is an object: a group {"all":[...]} / {"any":[...]} (not both) or a leaf {"field","op","value"}.`;
  },
  UNKNOWN_KEY: (segments, definition) => {
    const key = String(segments[segments.length - 1]);
    const parent = parentNode(segments, definition);
    if (inSplitParts(segments) && segments.length > 3) {
      return `"${key}" is not a key of a split part; a part takes only ${SPLIT_PART_TOOL_KEYS.join(", ")}.`;
    }
    if (segments[0] === "actions") {
      const type = isRecord(parent) ? parent.type : undefined;
      const keys =
        typeof type === "string" &&
        Object.prototype.hasOwnProperty.call(RULE_ACTION_TOOL_KEYS, type)
          ? `${type} takes only ${RULE_ACTION_TOOL_KEYS[type as keyof typeof RULE_ACTION_TOOL_KEYS].join(", ")}`
          : `Keys per action: ${Object.entries(RULE_ACTION_TOOL_KEYS)
              .map(([t, k]) => `${t}(${k.slice(1).join(",")})`)
              .join(" ")}`;
      return `"${key}" is not a key of this action; ${keys}.`;
    }
    if (isRecord(parent) && ("all" in parent || "any" in parent)) {
      return `"${key}" is not allowed in a group; a group has only "all" or "any" (an array) and optionally "not":true.`;
    }
    return `"${key}" is not allowed in a leaf; a leaf has exactly the keys "field", "op" and "value" (isEmpty takes no value).`;
  },
  UNKNOWN_FIELD: () =>
    `field must be one of: ${RULE_FIELDS.join(", ")}. There is no memo field.`,
  UNKNOWN_ACTION: () =>
    `action type must be one of: ${RULE_ACTION_TYPES.join(", ")}.`,
  OPERATOR_NOT_ALLOWED: (segments, definition) => {
    const leaf = parentNode(segments, definition);
    const ops =
      isRecord(leaf) && typeof leaf.field === "string"
        ? leafOperators(leaf.field)
        : null;
    return ops
      ? `For field ${String((leaf as Record<string, unknown>).field)} op must be one of: ${ops}.`
      : `op must be one of the operators listed for the field: ${RULE_FIELDS.map((f) => `${f}(${RULE_CONDITION_FIELDS[f].operators.join(",")})`).join(" ")}.`;
  },
  VALUE_REQUIRED: (segments) =>
    segments[0] === "actions"
      ? "convert_to_transfer needs toAccountName (an expense) or fromAccountName (an income)."
      : 'This operator needs a "value"; only isEmpty takes none.',
  VALUE_NOT_ALLOWED: generic('isEmpty takes no "value"; remove it.'),
  VALUE_TYPE: (segments, definition) =>
    segments[0] === "condition"
      ? shapeOfLeafValue(segments, definition)
      : "This value has the wrong JSON type (booleans are true/false, not strings).",
  VALUE_OUT_OF_RANGE: generic(
    "The value is out of range (dayOfMonth 1-31; amounts are finite numbers with at most 4 decimals; date is a real calendar day as YYYY-MM-DD).",
  ),
  VALUE_TOO_LONG: generic(
    "The text is too long (a condition value is at most 500 characters).",
  ),
  VALUE_EMPTY: generic("This text must not be empty."),
  INVALID_UUID: generic(
    "Give a name where the tool asks for one (accounts, payees, categories, tags); an id must be a UUID.",
  ),
  INVALID_ENUM: generic(
    "The value is not one of the allowed values for this field (see the field's list in the tool description).",
  ),
  INVALID_CURRENCY: generic(
    'currencyCode is a three-letter ISO code, e.g. "PLN".',
  ),
  ARRAY_EMPTY: (segments) =>
    inSplitParts(segments)
      ? `A split needs 2 to 10 parts: ${SPLIT_FORM}`
      : "This list needs at least one entry.",
  ARRAY_TOO_LARGE: (segments) =>
    inSplitParts(segments)
      ? "A split has at most 10 parts."
      : "This list has too many entries.",
  RANGE_ORDER: generic(
    "between takes [min,max] (for date: [from,to]) with the first not above the second.",
  ),
  MAX_DEPTH: generic("Groups nest at most 4 deep; flatten the condition."),
  MAX_LEAVES: generic("A rule has at most 50 leaves; simplify it."),
  MAX_NODES: generic("A rule has at most 100 groups and leaves; simplify it."),
  NO_ACTIONS: generic(
    'actions needs at least one, e.g. [{"type":"set_category","categoryName":"Groceries"}].',
  ),
  TOO_MANY_ACTIONS: generic(`A rule has at most ${MAX_RULE_ACTIONS} actions.`),
  DUPLICATE_ACTION: (segments) =>
    inSplitParts(segments)
      ? 'Only one part of a split may have the amount "rest".'
      : "A rule has at most one request_ai_review action and at most one convert_to_transfer or split action.",
  CONFLICTING_ACTIONS: (segments, definition) => {
    if (inSplitParts(segments)) {
      return "A split part has a category or a transfer account, not both, and a payee only together with a transfer account.";
    }
    const action = nodeAt(definition, segments);
    const bothAccounts =
      isRecord(action) &&
      ("toAccountName" in action || "toAccountId" in action) &&
      ("fromAccountName" in action || "fromAccountId" in action);
    return bothAccounts
      ? "convert_to_transfer takes toAccountName (an expense) or fromAccountName (an income), not both."
      : "A rule with convert_to_transfer or split must not also have set_category: the structural action decides the category.";
  },
  INVALID_CAPTURE: generic(
    "A capture is {name} with name a-z0-9, starting with a letter, at most 20 characters, and not 'description'.",
  ),
  TOO_MANY_CAPTURES: generic("A pattern has at most 5 captures."),
  DUPLICATE_CAPTURE: generic("Each capture name is used once per rule."),
  UNKNOWN_CAPTURE: (segments) =>
    inSplitParts(segments)
      ? 'A split part amount is "rest" or {name} of a capture some matches pattern of the same rule defines, e.g. matches "PRINCIPAL: {principal} INTEREST: *" gives "{principal}".'
      : "A template may use {payeeText}, {description} and the captures defined by a matches pattern of the same rule.",
  LOOKS_LIKE_REGEX: generic(
    'matches is a glob, not a regex: | \\ and a short [xy] class are matched literally, so a pattern written as a regex never matches what was meant. For alternatives use an any group of leaves, e.g. {"any":[{"field":"description","op":"contains","value":"a"},{"field":"description","op":"contains","value":"b"}]}.',
  ),
  PATTERN_WITHOUT_WILDCARD: generic(
    'A matches pattern without * or {name} must equal the WHOLE text. Use "eq" for the whole text, or "contains" (or matches "*text*") for a part of it.',
  ),
};

/** The hint for one error; `definition` (names or ids, as validated) sharpens it. */
export function ruleErrorHint(
  error: RuleValidationError,
  definition: RuleHintDefinition = {},
): string | null {
  const fn = Object.prototype.hasOwnProperty.call(HINTS, error.code)
    ? HINTS[error.code as RuleValidationCode]
    : undefined;
  return fn ? fn(parsePath(error.path), definition) : null;
}

/** Distinct hints for a list of errors, in order, at most {@link MAX_HINTS}. */
export function ruleErrorHints(
  errors: readonly { path: string; code: string }[],
  definition: RuleHintDefinition = {},
): string[] {
  const out: string[] = [];
  for (const error of errors) {
    const hint = ruleErrorHint(error as RuleValidationError, definition);
    if (hint && !out.includes(hint)) out.push(hint);
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}
