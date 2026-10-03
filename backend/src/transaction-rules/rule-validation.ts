import { UUID_REGEX } from "../common/query-param-utils";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import {
  RULE_ACTION_TYPES,
  RULE_DESCRIPTION_MODES,
  RuleAction,
  SPLIT_REST_AMOUNT,
} from "./rule-action.types";
import {
  RULE_CONDITION_FIELDS,
  RULE_MAX_DAY_OF_MONTH,
  RULE_MIN_DAY_OF_MONTH,
  RULE_OPERATOR_SHAPES,
  RuleConditionFieldSpec,
  RuleConditionLeaf,
  RuleConditionNode,
  RuleField,
} from "./rule-condition.types";
import {
  MAX_CAPTURES_PER_PATTERN,
  RESERVED_CAPTURE_NAMES,
  parseGlob,
} from "./rule-glob-capture";
import { TEMPLATE_BUILTINS, parseTemplate } from "./rule-template";

/** Bounds from design section 4. The DTO layer and the validator share them. */
export const MAX_RULE_CONDITION_DEPTH = 4;
export const MAX_RULE_CONDITION_LEAVES = 50;
/** Groups and leaves together; stops a tree of thousands of empty groups. */
export const MAX_RULE_CONDITION_NODES = 100;
export const MAX_RULE_ACTIONS = 10;
export const MIN_RULE_TAG_IDS = 1;
export const MAX_RULE_TAG_IDS = 20;
/** Trimmed length of a `request_ai_review` instruction. */
export const MIN_RULE_AI_INSTRUCTION_LENGTH = 1;
export const MAX_RULE_AI_INSTRUCTION_LENGTH = 1000;
export const MAX_RULE_AI_REVIEW_ACTIONS = 1;
export const MAX_RULE_STRUCTURAL_ACTIONS = 1;
/** Template lengths of `set_payee_from_text` and `set_description` (design 10.2). */
export const MIN_RULE_TEMPLATE_LENGTH = 1;
export const MAX_RULE_PAYEE_TEMPLATE_LENGTH = 200;
export const MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH = 500;
/** Parts of a `split` action (spec 3.4) and the length of a part's memo. */
export const MIN_RULE_SPLIT_PARTS = 2;
export const MAX_RULE_SPLIT_PARTS = 10;
export const MIN_RULE_SPLIT_DESCRIPTION_LENGTH = 1;
export const MAX_RULE_SPLIT_DESCRIPTION_LENGTH = 200;
/** Same limit as `matchesAliasPattern`, which returns false beyond it. */
export const MAX_RULE_TEXT_LENGTH = 500;
/** Entries in an `in` / `notIn` / `hasAny` / `hasAll` / `hasNone` list. */
export const MAX_RULE_VALUE_LIST = 50;

export const RULE_VALIDATION_CODES = [
  "INVALID_SHAPE",
  "UNKNOWN_KEY",
  "UNKNOWN_FIELD",
  "UNKNOWN_ACTION",
  "OPERATOR_NOT_ALLOWED",
  "VALUE_REQUIRED",
  "VALUE_NOT_ALLOWED",
  "VALUE_TYPE",
  "VALUE_OUT_OF_RANGE",
  "VALUE_TOO_LONG",
  "VALUE_EMPTY",
  "INVALID_UUID",
  "INVALID_ENUM",
  "INVALID_CURRENCY",
  "ARRAY_EMPTY",
  "ARRAY_TOO_LARGE",
  "RANGE_ORDER",
  "MAX_DEPTH",
  "MAX_LEAVES",
  "MAX_NODES",
  "NO_ACTIONS",
  "TOO_MANY_ACTIONS",
  "DUPLICATE_ACTION",
  "CONFLICTING_ACTIONS",
  "INVALID_CAPTURE",
  "TOO_MANY_CAPTURES",
  "DUPLICATE_CAPTURE",
  "UNKNOWN_CAPTURE",
  "LOOKS_LIKE_REGEX",
  "PATTERN_WITHOUT_WILDCARD",
] as const;
export type RuleValidationCode = (typeof RULE_VALIDATION_CODES)[number];

export interface RuleValidationError {
  /** Dotted path into the definition, e.g. `condition.all[0].value`. */
  readonly path: string;
  readonly code: RuleValidationCode;
}

export interface RuleDefinition {
  readonly condition: RuleConditionNode;
  readonly actions: readonly RuleAction[];
}

export interface RuleReferencedIds {
  readonly accountIds: string[];
  readonly payeeIds: string[];
  readonly categoryIds: string[];
  readonly tagIds: string[];
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;
const MONEY_SCALE = 10000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasKey = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

type Sink = (path: string, code: RuleValidationCode) => void;

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  push: Sink,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) push(`${path}.${key}`, "UNKNOWN_KEY");
  }
}

/**
 * Validate a rule definition. Never throws for user input: every problem is a
 * `{ path, code }` entry and an empty list means the definition is acceptable.
 *
 * Shape and bounds only. Whether each referenced id belongs to the owner is
 * the service's job (see `collectReferencedIds`), inside the write's
 * transaction.
 */
export function validateRuleDefinition(
  input: {
    condition: unknown;
    actions: unknown;
  },
  options: { readonly authoring?: boolean } = {},
): RuleValidationError[] {
  const errors: RuleValidationError[] = [];
  const push: Sink = (path, code) => errors.push({ path, code });
  const budget: Budget = {
    leaves: 0,
    nodes: 0,
    leavesReported: false,
    nodesReported: false,
    captures: new Set<string>(),
    authoring: options.authoring === true,
  };
  validateNode(input.condition, "condition", 1, budget, push);
  validateActions(input.actions, budget.captures, push);
  return errors;
}

interface Budget {
  leaves: number;
  nodes: number;
  leavesReported: boolean;
  nodesReported: boolean;
  /** Capture names the `matches` leaves define so far; one name once per rule. */
  captures: Set<string>;
  /**
   * True on the write and draft paths only. The glob-trap checks
   * (`LOOKS_LIKE_REGEX`, `PATTERN_WITHOUT_WILDCARD`) are authoring advice: a
   * stored rule that would fail them still evaluates, so loading, listing and
   * running never apply them.
   */
  authoring: boolean;
}

function validateNode(
  node: unknown,
  path: string,
  depth: number,
  budget: Budget,
  push: Sink,
): void {
  if (!isRecord(node)) return push(path, "INVALID_SHAPE");
  if (++budget.nodes > MAX_RULE_CONDITION_NODES) {
    if (!budget.nodesReported) push(path, "MAX_NODES");
    budget.nodesReported = true;
    return;
  }
  const isAll = hasKey(node, "all");
  const isAny = hasKey(node, "any");
  if (isAll || isAny) {
    if (isAll && isAny) return push(path, "INVALID_SHAPE");
    return validateGroup(
      node,
      isAll ? "all" : "any",
      path,
      depth,
      budget,
      push,
    );
  }
  if (hasKey(node, "field")) {
    if (++budget.leaves > MAX_RULE_CONDITION_LEAVES) {
      if (!budget.leavesReported) push(path, "MAX_LEAVES");
      budget.leavesReported = true;
      return;
    }
    return validateLeaf(node, path, budget, push);
  }
  push(path, "INVALID_SHAPE");
}

function validateGroup(
  node: Record<string, unknown>,
  key: "all" | "any",
  path: string,
  depth: number,
  budget: Budget,
  push: Sink,
): void {
  checkKeys(node, [key, "not"], path, push);
  if (hasKey(node, "not") && typeof node.not !== "boolean") {
    push(`${path}.not`, "VALUE_TYPE");
  }
  if (depth > MAX_RULE_CONDITION_DEPTH) return push(path, "MAX_DEPTH");
  const children = node[key];
  if (!Array.isArray(children)) return push(`${path}.${key}`, "INVALID_SHAPE");
  children.forEach((child, i) =>
    validateNode(child, `${path}.${key}[${i}]`, depth + 1, budget, push),
  );
}

function validateLeaf(
  node: Record<string, unknown>,
  path: string,
  budget: Budget,
  push: Sink,
): void {
  checkKeys(node, ["field", "op", "value"], path, push);
  const field = node.field;
  if (typeof field !== "string" || !hasKey(RULE_CONDITION_FIELDS, field)) {
    return push(`${path}.field`, "UNKNOWN_FIELD");
  }
  const spec: RuleConditionFieldSpec =
    RULE_CONDITION_FIELDS[field as RuleField];
  const op = node.op;
  if (
    typeof op !== "string" ||
    !(spec.operators as readonly string[]).includes(op)
  ) {
    return push(`${path}.op`, "OPERATOR_NOT_ALLOWED");
  }
  const valuePath = `${path}.value`;
  const shape = RULE_OPERATOR_SHAPES[op as keyof typeof RULE_OPERATOR_SHAPES];
  const value = node.value;
  if (shape === "none") {
    if (hasKey(node, "value")) push(valuePath, "VALUE_NOT_ALLOWED");
    return;
  }
  if (value === undefined) return push(valuePath, "VALUE_REQUIRED");
  const checkOne = (v: unknown, p: string): boolean =>
    validateScalar(v, spec.kind, spec.enumValues ?? [], p, push);
  if (shape === "scalar") {
    if (checkOne(value, valuePath) && op === "matches") {
      if (budget.authoring) {
        validateGlobTraps(value as string, valuePath, push);
      }
      validateCaptures(value as string, valuePath, budget.captures, push);
    }
  } else if (shape === "list") {
    validateList(value, valuePath, push, MAX_RULE_VALUE_LIST, 1, checkOne);
  } else if (!Array.isArray(value) || value.length !== 2) {
    push(valuePath, "VALUE_TYPE");
  } else {
    const ok = value.map((v, i) => checkOne(v, `${valuePath}[${i}]`));
    // Numbers and `YYYY-MM-DD` strings both order with `>`.
    if (
      ok[0] &&
      ok[1] &&
      (value[0] as number | string) > (value[1] as number | string)
    ) {
      push(valuePath, "RANGE_ORDER");
    }
  }
}

/**
 * Regex-only syntax that is a literal character in a glob, so a pattern that
 * uses it never matches what its author meant: `|`, `.*`, a backslash and a
 * bracket class of 1 to 3 characters (`[xy]`, `[łl]`). A glob has no escape,
 * so `^`, `$` and longer bracketed words (`*[PENDING]*`) stay allowed: they
 * are the only way to match that literal text. `+` is too common in text.
 */
const REGEX_ONLY_SYNTAX = /[|\\]|\[[^\][]{1,3}\]/;

/**
 * Two mistakes a person or a model makes with `matches` (design 10.1): writing
 * a regex, and writing a bare word. A `matches` pattern is a glob answered
 * against the WHOLE text, so `nagroda` equals only the text "nagroda" (the
 * `eq` operator says that), and `a|b` equals only the text "a|b". At most one
 * of the two is reported, the regex first.
 */
function validateGlobTraps(pattern: string, path: string, push: Sink): void {
  // An empty pattern is a missing value, which the editor reports on its own;
  // it is not "a bare word" and not a regex.
  if (pattern === "") return;
  if (REGEX_ONLY_SYNTAX.test(pattern)) return push(path, "LOOKS_LIKE_REGEX");
  const { tokens, malformed } = parseGlob(pattern);
  if (malformed.length === 0 && tokens.every((t) => t.kind === "literal")) {
    push(path, "PATTERN_WITHOUT_WILDCARD");
  }
}

/**
 * The `{name}` captures of a `matches` pattern (design 10.1): at most 5 per
 * pattern, names `[a-z][a-z0-9]{0,19}`, a name once per rule, and none of the
 * names the template language owns. A `{...}` shaped like a capture that is
 * not a valid one is refused instead of matching as literal text.
 */
function validateCaptures(
  pattern: string,
  path: string,
  seen: Set<string>,
  push: Sink,
): void {
  const { captureNames, malformed } = parseGlob(pattern);
  if (malformed.length > 0) push(path, "INVALID_CAPTURE");
  if (captureNames.length > MAX_CAPTURES_PER_PATTERN) {
    push(path, "TOO_MANY_CAPTURES");
  }
  let reserved = false;
  let duplicate = false;
  for (const name of captureNames) {
    if (RESERVED_CAPTURE_NAMES.includes(name)) reserved = true;
    else if (seen.has(name)) duplicate = true;
    seen.add(name);
  }
  if (reserved) push(path, "INVALID_CAPTURE");
  if (duplicate) push(path, "DUPLICATE_CAPTURE");
}

function validateList(
  value: unknown,
  path: string,
  push: Sink,
  max: number,
  min: number,
  checkOne: (v: unknown, p: string) => boolean,
): void {
  if (!Array.isArray(value)) return push(path, "VALUE_TYPE");
  if (value.length < min) return push(path, "ARRAY_EMPTY");
  if (value.length > max) return push(path, "ARRAY_TOO_LARGE");
  value.forEach((v, i) => checkOne(v, `${path}[${i}]`));
}

/** Check one scalar against a value kind; returns whether it is acceptable. */
function validateScalar(
  value: unknown,
  kind: string,
  enumValues: readonly string[],
  path: string,
  push: Sink,
): boolean {
  const fail = (code: RuleValidationCode): false => {
    push(path, code);
    return false;
  };
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" || fail("VALUE_TYPE");
    case "money":
      if (typeof value !== "number") return fail("VALUE_TYPE");
      if (!Number.isFinite(value)) return fail("VALUE_OUT_OF_RANGE");
      return (
        Number.isSafeInteger(Math.round(value * MONEY_SCALE)) ||
        fail("VALUE_OUT_OF_RANGE")
      );
    case "dayOfMonth":
      if (typeof value !== "number") return fail("VALUE_TYPE");
      return (
        (Number.isInteger(value) &&
          value >= RULE_MIN_DAY_OF_MONTH &&
          value <= RULE_MAX_DAY_OF_MONTH) ||
        fail("VALUE_OUT_OF_RANGE")
      );
    case "date":
      if (typeof value !== "string") return fail("VALUE_TYPE");
      return isCalendarDate(value) || fail("VALUE_OUT_OF_RANGE");
    case "text":
      if (typeof value !== "string") return fail("VALUE_TYPE");
      return value.length <= MAX_RULE_TEXT_LENGTH || fail("VALUE_TOO_LONG");
    case "enum":
      if (typeof value !== "string") return fail("VALUE_TYPE");
      return enumValues.includes(value) || fail("INVALID_ENUM");
    case "currency":
      if (typeof value !== "string") return fail("VALUE_TYPE");
      return CURRENCY_CODE.test(value) || fail("INVALID_CURRENCY");
    default:
      // accountId, payeeId, categoryId, tagIds
      if (typeof value !== "string") return fail("VALUE_TYPE");
      return UUID_REGEX.test(value) || fail("INVALID_UUID");
  }
}

function validateActions(
  actions: unknown,
  captures: ReadonlySet<string>,
  push: Sink,
): void {
  if (!Array.isArray(actions)) return push("actions", "INVALID_SHAPE");
  if (actions.length === 0) return push("actions", "NO_ACTIONS");
  if (actions.length > MAX_RULE_ACTIONS) push("actions", "TOO_MANY_ACTIONS");
  let aiReviews = 0;
  let structural = 0;
  let structuralPath: string | null = null;
  let setsCategory = false;
  actions.slice(0, MAX_RULE_ACTIONS).forEach((action, i) => {
    const path = `actions[${i}]`;
    validateAction(action, path, captures, push);
    if (!isRecord(action)) return;
    if (action.type === "request_ai_review") {
      if (++aiReviews > MAX_RULE_AI_REVIEW_ACTIONS) {
        push(path, "DUPLICATE_ACTION");
      }
    } else if (action.type === "set_category") {
      setsCategory = true;
    } else if (
      action.type === "convert_to_transfer" ||
      action.type === "split"
    ) {
      // At most one structural action per rule (spec 3.6).
      if (++structural > MAX_RULE_STRUCTURAL_ACTIONS) {
        push(path, "DUPLICATE_ACTION");
      } else {
        structuralPath = path;
      }
    }
  });
  // A structural action decides the category itself (none, or one per part).
  if (structuralPath !== null && setsCategory) {
    push(structuralPath, "CONFLICTING_ACTIONS");
  }
}

function validateAction(
  action: unknown,
  path: string,
  captures: ReadonlySet<string>,
  push: Sink,
): void {
  if (!isRecord(action)) return push(path, "INVALID_SHAPE");
  const type = action.type;
  if (
    typeof type !== "string" ||
    !(RULE_ACTION_TYPES as readonly string[]).includes(type)
  ) {
    return push(`${path}.type`, "UNKNOWN_ACTION");
  }
  const uuid = (v: unknown, p: string): boolean =>
    validateScalar(v, "tagIds", [], p, push);
  if (type === "add_tags" || type === "remove_tags") {
    checkKeys(action, ["type", "tagIds"], path, push);
    validateList(
      action.tagIds,
      `${path}.tagIds`,
      push,
      MAX_RULE_TAG_IDS,
      MIN_RULE_TAG_IDS,
      uuid,
    );
    return;
  }
  if (type === "request_ai_review") {
    checkKeys(action, ["type", "instruction"], path, push);
    validateInstruction(action.instruction, `${path}.instruction`, push);
    return;
  }
  if (type === "set_payee_from_text") {
    checkKeys(
      action,
      ["type", "template", "createIfMissing", "onlyIfEmpty"],
      path,
      push,
    );
    validateTemplate(
      action.template,
      MAX_RULE_PAYEE_TEMPLATE_LENGTH,
      `${path}.template`,
      captures,
      push,
    );
    for (const key of ["createIfMissing", "onlyIfEmpty"]) {
      if (typeof action[key] !== "boolean")
        push(`${path}.${key}`, "VALUE_TYPE");
    }
    return;
  }
  if (type === "set_description") {
    checkKeys(action, ["type", "template", "mode", "onlyIfEmpty"], path, push);
    validateTemplate(
      action.template,
      MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH,
      `${path}.template`,
      captures,
      push,
    );
    if (typeof action.mode !== "string") {
      push(`${path}.mode`, "VALUE_TYPE");
    } else if (
      !(RULE_DESCRIPTION_MODES as readonly string[]).includes(action.mode)
    ) {
      push(`${path}.mode`, "INVALID_ENUM");
    }
    if (typeof action.onlyIfEmpty !== "boolean") {
      push(`${path}.onlyIfEmpty`, "VALUE_TYPE");
    }
    return;
  }
  if (type === "convert_to_transfer") {
    validateConvertToTransfer(action, path, push);
    return;
  }
  if (type === "split") {
    validateSplit(action, path, captures, push);
    return;
  }
  const idKey = type === "set_category" ? "categoryId" : "payeeId";
  checkKeys(action, ["type", idKey, "onlyIfEmpty"], path, push);
  uuid(action[idKey], `${path}.${idKey}`);
  if (typeof action.onlyIfEmpty !== "boolean") {
    push(`${path}.onlyIfEmpty`, "VALUE_TYPE");
  }
}

/** An optional id key: absent is fine, present must be a UUID. */
function optionalUuid(
  record: Record<string, unknown>,
  key: string,
  path: string,
  push: Sink,
): void {
  if (hasKey(record, key)) {
    validateScalar(record[key], "tagIds", [], `${path}.${key}`, push);
  }
}

/**
 * `convert_to_transfer` (spec 3.3): exactly one of `toAccountId` and
 * `fromAccountId`, `clearCategory` a boolean (stored rules carry it; the
 * defaults fill it for a draft), an optional `payeeId`.
 */
function validateConvertToTransfer(
  action: Record<string, unknown>,
  path: string,
  push: Sink,
): void {
  checkKeys(
    action,
    ["type", "toAccountId", "fromAccountId", "clearCategory", "payeeId"],
    path,
    push,
  );
  const hasTo = hasKey(action, "toAccountId");
  const hasFrom = hasKey(action, "fromAccountId");
  if (hasTo && hasFrom) push(path, "CONFLICTING_ACTIONS");
  else if (!hasTo && !hasFrom) push(`${path}.toAccountId`, "VALUE_REQUIRED");
  optionalUuid(action, "toAccountId", path, push);
  optionalUuid(action, "fromAccountId", path, push);
  optionalUuid(action, "payeeId", path, push);
  if (typeof action.clearCategory !== "boolean") {
    push(`${path}.clearCategory`, "VALUE_TYPE");
  }
}

/**
 * `split` (spec 3.4): 2..10 parts, each with an amount that is `rest` (at
 * most one) or `{capture}` naming a capture the rule defines, at most one of
 * a category and a transfer account, a payee only on a transfer part, and an
 * optional memo.
 */
function validateSplit(
  action: Record<string, unknown>,
  path: string,
  captures: ReadonlySet<string>,
  push: Sink,
): void {
  checkKeys(action, ["type", "payeeId", "parts"], path, push);
  optionalUuid(action, "payeeId", path, push);
  const partsPath = `${path}.parts`;
  const parts = action.parts;
  if (!Array.isArray(parts)) return push(partsPath, "INVALID_SHAPE");
  if (parts.length < MIN_RULE_SPLIT_PARTS)
    return push(partsPath, "ARRAY_EMPTY");
  if (parts.length > MAX_RULE_SPLIT_PARTS) {
    return push(partsPath, "ARRAY_TOO_LARGE");
  }
  let rests = 0;
  parts.forEach((part, i) => {
    const at = `${partsPath}[${i}]`;
    if (!isRecord(part)) return push(at, "INVALID_SHAPE");
    checkKeys(
      part,
      ["amount", "categoryId", "transferAccountId", "payeeId", "description"],
      at,
      push,
    );
    if (validatePartAmount(part.amount, `${at}.amount`, captures, push)) {
      if (part.amount === SPLIT_REST_AMOUNT && ++rests > 1) {
        push(`${at}.amount`, "DUPLICATE_ACTION");
      }
    }
    optionalUuid(part, "categoryId", at, push);
    optionalUuid(part, "transferAccountId", at, push);
    optionalUuid(part, "payeeId", at, push);
    if (hasKey(part, "categoryId") && hasKey(part, "transferAccountId")) {
      push(at, "CONFLICTING_ACTIONS");
    } else if (hasKey(part, "payeeId") && !hasKey(part, "transferAccountId")) {
      push(`${at}.payeeId`, "CONFLICTING_ACTIONS");
    }
    if (hasKey(part, "description")) {
      validatePartDescription(part.description, `${at}.description`, push);
    }
  });
}

const PART_CAPTURE = /^\{([a-z][a-z0-9]{0,19})\}$/;

/** `rest`, or exactly `{name}` for a capture of the rule; returns whether the shape was acceptable. */
function validatePartAmount(
  value: unknown,
  path: string,
  captures: ReadonlySet<string>,
  push: Sink,
): boolean {
  if (typeof value !== "string") {
    push(path, "VALUE_TYPE");
    return false;
  }
  if (value === SPLIT_REST_AMOUNT) return true;
  const match = PART_CAPTURE.exec(value);
  if (match === null) {
    push(path, "INVALID_SHAPE");
    return false;
  }
  if (!captures.has(match[1])) {
    push(path, "UNKNOWN_CAPTURE");
    return false;
  }
  return true;
}

function validatePartDescription(
  value: unknown,
  path: string,
  push: Sink,
): void {
  if (typeof value !== "string") return push(path, "VALUE_TYPE");
  const length = value.trim().length;
  if (length < MIN_RULE_SPLIT_DESCRIPTION_LENGTH)
    return push(path, "VALUE_EMPTY");
  if (length > MAX_RULE_SPLIT_DESCRIPTION_LENGTH) push(path, "VALUE_TOO_LONG");
}

/**
 * A template is plain text with `{capture}`, `{payeeText}` and `{description}`
 * placeholders. A placeholder must name a capture some leaf of the rule
 * defines (design 10.1), or one of the two built-ins.
 */
function validateTemplate(
  value: unknown,
  max: number,
  path: string,
  captures: ReadonlySet<string>,
  push: Sink,
): void {
  if (typeof value !== "string") return push(path, "VALUE_TYPE");
  if (value.trim().length < MIN_RULE_TEMPLATE_LENGTH) {
    return push(path, "VALUE_EMPTY");
  }
  if (value.length > max) return push(path, "VALUE_TOO_LONG");
  const { refs, malformed } = parseTemplate(value);
  if (malformed.length > 0) push(path, "INVALID_CAPTURE");
  if (
    refs.some((ref) => !TEMPLATE_BUILTINS.includes(ref) && !captures.has(ref))
  ) {
    push(path, "UNKNOWN_CAPTURE");
  }
}

function validateInstruction(value: unknown, path: string, push: Sink): void {
  if (typeof value !== "string") return push(path, "VALUE_TYPE");
  const length = value.trim().length;
  if (length < MIN_RULE_AI_INSTRUCTION_LENGTH) return push(path, "VALUE_EMPTY");
  if (length > MAX_RULE_AI_INSTRUCTION_LENGTH) push(path, "VALUE_TOO_LONG");
}

/**
 * Every account, payee, category and tag id a (valid) definition names, each
 * once, so the service can check ownership of all of them in the write's
 * transaction. Call it after `validateRuleDefinition` returned no errors.
 */
export function collectReferencedIds(
  definition: RuleDefinition,
): RuleReferencedIds {
  const sets = {
    accountIds: new Set<string>(),
    payeeIds: new Set<string>(),
    categoryIds: new Set<string>(),
    tagIds: new Set<string>(),
  };
  const addAll = (target: Set<string>, value: unknown): void => {
    for (const id of Array.isArray(value) ? value : [value]) {
      target.add(id as string);
    }
  };
  const visit = (node: RuleConditionNode): void => {
    if ("all" in node || "any" in node) {
      const children = "all" in node ? node.all : node.any;
      children.forEach(visit);
      return;
    }
    collectLeafIds(node, sets, addAll);
  };
  visit(definition.condition);
  for (const action of definition.actions) {
    if (action.type === "set_category") sets.categoryIds.add(action.categoryId);
    else if (action.type === "set_payee") sets.payeeIds.add(action.payeeId);
    else if (action.type === "add_tags" || action.type === "remove_tags") {
      addAll(sets.tagIds, action.tagIds);
    } else if (action.type === "convert_to_transfer") {
      for (const id of [action.toAccountId, action.fromAccountId]) {
        if (id !== undefined) sets.accountIds.add(id);
      }
      if (action.payeeId !== undefined) sets.payeeIds.add(action.payeeId);
    } else if (action.type === "split") {
      if (action.payeeId !== undefined) sets.payeeIds.add(action.payeeId);
      for (const part of action.parts) {
        if (part.categoryId !== undefined)
          sets.categoryIds.add(part.categoryId);
        if (part.transferAccountId !== undefined) {
          sets.accountIds.add(part.transferAccountId);
        }
        if (part.payeeId !== undefined) sets.payeeIds.add(part.payeeId);
      }
    }
  }
  return {
    accountIds: [...sets.accountIds],
    payeeIds: [...sets.payeeIds],
    categoryIds: [...sets.categoryIds],
    tagIds: [...sets.tagIds],
  };
}

function collectLeafIds(
  leaf: RuleConditionLeaf,
  sets: Record<keyof RuleReferencedIds, Set<string>>,
  addAll: (target: Set<string>, value: unknown) => void,
): void {
  if (leaf.value === undefined) return;
  switch (RULE_CONDITION_FIELDS[leaf.field].kind) {
    case "accountId":
      return addAll(sets.accountIds, leaf.value);
    case "payeeId":
      return addAll(sets.payeeIds, leaf.value);
    case "categoryId":
      return addAll(sets.categoryIds, leaf.value);
    case "tagIds":
      return addAll(sets.tagIds, leaf.value);
    default:
  }
}
