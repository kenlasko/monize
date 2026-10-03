import { UUID_REGEX } from "../../common/query-param-utils";
import {
  MAX_CAPTURES_PER_PATTERN,
  parseGlob,
} from "../../transaction-rules/rule-glob-capture";
import {
  MAX_CATEGORY_RULES,
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS_PER_FIELD,
  MAX_SECTION_MARKER_LENGTH,
  RECEIPT_PARSER_VERSION,
  ReceiptCategoryRule,
  ReceiptItemsDefinition,
  ReceiptParserDefinition,
} from "./receipt-parser.types";

/**
 * The one validator of a receipt parser definition (design 5.2). The form, the
 * API and the AI draft all pass through it, so a stored definition has the
 * same shape whoever wrote it. Pure and total: it never throws, whatever it is
 * given, and reports every problem it finds (up to a cap) as a path and a
 * machine-readable code. Ownership of the category ids is not checked here;
 * `collectParserCategoryIds` lists them for the service that does.
 */

/** A validator result stays small however hostile the input is. */
const MAX_REPORTED_ERRORS = 50;

export interface ReceiptParserValidationError {
  /** Where the problem is, e.g. `items.patterns[1]` or `categoryRules[0].categoryId`. */
  path: string;
  /**
   * `not_object`, `unknown_key`, `invalid_version`, `invalid_type`, `empty`,
   * `too_many`, `too_long`, `control_character`, `malformed_capture`,
   * `too_many_captures`, `duplicate_capture`, `capture_not_allowed`,
   * `capture_missing`, `capture_conflict`, `invalid_uuid`.
   */
  code: string;
}

export type ReceiptParserValidation =
  | { ok: true; definition: ReceiptParserDefinition }
  | { ok: false; errors: ReceiptParserValidationError[] };

/** The capture names a pattern of each field may hold, and the ones it must hold. */
interface FieldCaptures {
  readonly allowed: readonly string[];
  readonly required: readonly string[];
}

const ORDER_ID_CAPTURES: FieldCaptures = {
  allowed: ["orderid"],
  required: ["orderid"],
};
const AMOUNT_CAPTURES: FieldCaptures = {
  allowed: ["amount"],
  required: ["amount"],
};
const ITEM_CAPTURES: FieldCaptures = {
  allowed: ["name", "amount", "price", "qty"],
  required: ["name"],
};

const TOP_LEVEL_KEYS: readonly string[] = [
  "version",
  "orderId",
  "total",
  "shipping",
  "discount",
  "items",
  "categoryRules",
  "defaultCategoryId",
  "shippingCategoryId",
];
const ITEMS_KEYS: readonly string[] = ["startAfter", "stopAt", "patterns"];
const CATEGORY_RULE_KEYS: readonly string[] = ["match", "categoryId"];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Collects errors up to the cap; a full collector ignores further reports. */
class Errors {
  readonly list: ReceiptParserValidationError[] = [];
  add(path: string, code: string): void {
    if (this.list.length < MAX_REPORTED_ERRORS) this.list.push({ path, code });
  }
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: Errors,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.add(prefix + key, "unknown_key");
  }
}

function asArray(
  value: unknown,
  path: string,
  errors: Errors,
): unknown[] | null {
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length > MAX_PATTERNS_PER_FIELD) {
    errors.add(path, "too_many");
    return null;
  }
  return value;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A glob pattern for one field: bounded, well formed, with only the allowed captures. */
function checkPattern(
  value: unknown,
  path: string,
  captures: FieldCaptures,
  errors: Errors,
): boolean {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return false;
  }
  if (value.trim() === "") {
    errors.add(path, "empty");
    return false;
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    errors.add(path, "too_long");
    return false;
  }
  // A line never holds a line break or another control character.
  if (hasControlCharacter(value)) {
    errors.add(path, "control_character");
    return false;
  }
  const glob = parseGlob(value);
  const before = errors.list.length;
  if (glob.malformed.length > 0) errors.add(path, "malformed_capture");
  if (glob.captureNames.length > MAX_CAPTURES_PER_PATTERN) {
    errors.add(path, "too_many_captures");
  }
  const seen = new Set<string>();
  for (const name of glob.captureNames) {
    if (seen.has(name)) errors.add(path, "duplicate_capture");
    seen.add(name);
    if (!captures.allowed.includes(name)) {
      errors.add(path, "capture_not_allowed");
    }
  }
  for (const name of captures.required) {
    if (!seen.has(name)) errors.add(path, "capture_missing");
  }
  return errors.list.length === before;
}

/** A field's pattern list (each entry a glob with the field's captures). */
function checkPatternList(
  value: unknown,
  path: string,
  captures: FieldCaptures,
  errors: Errors,
  minimum: number,
): string[] | null {
  const list = asArray(value, path, errors);
  if (list === null) return null;
  if (list.length < minimum) {
    errors.add(path, "empty");
    return null;
  }
  let valid = true;
  const out: string[] = [];
  list.forEach((entry, index) => {
    if (checkPattern(entry, `${path}[${index}]`, captures, errors)) {
      out.push(entry as string);
    } else {
      valid = false;
    }
  });
  return valid ? out : null;
}

/** An item pattern also needs `amount`, or `price` (optionally with `qty`), never both. */
function checkItemPriceCaptures(
  patterns: readonly string[],
  path: string,
  errors: Errors,
): void {
  patterns.forEach((pattern, index) => {
    const names = parseGlob(pattern).captureNames;
    const hasAmount = names.includes("amount");
    const hasPrice = names.includes("price");
    if (hasAmount && hasPrice) {
      errors.add(`${path}[${index}]`, "capture_conflict");
    } else if (!hasAmount && !hasPrice) {
      errors.add(`${path}[${index}]`, "capture_missing");
    }
  });
}

function checkMarker(
  value: unknown,
  path: string,
  errors: Errors,
): string | null {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.trim() === "") {
    errors.add(path, "empty");
    return null;
  }
  if (value.length > MAX_SECTION_MARKER_LENGTH) {
    errors.add(path, "too_long");
    return null;
  }
  return value;
}

function checkUuid(
  value: unknown,
  path: string,
  errors: Errors,
): string | null {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return null;
  }
  if (!UUID_REGEX.test(value)) {
    errors.add(path, "invalid_uuid");
    return null;
  }
  return value;
}

function checkItems(
  value: unknown,
  errors: Errors,
): ReceiptItemsDefinition | null {
  if (!isPlainObject(value)) {
    errors.add("items", "invalid_type");
    return null;
  }
  const before = errors.list.length;
  checkKeys(value, ITEMS_KEYS, "items.", errors);
  const out: { startAfter?: string; stopAt?: string; patterns: string[] } = {
    patterns: [],
  };
  if (value.startAfter !== undefined) {
    const marker = checkMarker(value.startAfter, "items.startAfter", errors);
    if (marker !== null) out.startAfter = marker;
  }
  if (value.stopAt !== undefined) {
    const marker = checkMarker(value.stopAt, "items.stopAt", errors);
    if (marker !== null) out.stopAt = marker;
  }
  if (value.patterns === undefined) {
    errors.add("items.patterns", "invalid_type");
  } else {
    const patterns = checkPatternList(
      value.patterns,
      "items.patterns",
      ITEM_CAPTURES,
      errors,
      1,
    );
    if (patterns !== null) {
      checkItemPriceCaptures(patterns, "items.patterns", errors);
      out.patterns = patterns;
    }
  }
  return errors.list.length === before ? out : null;
}

function checkCategoryRules(
  value: unknown,
  errors: Errors,
): ReceiptCategoryRule[] | null {
  if (!Array.isArray(value)) {
    errors.add("categoryRules", "invalid_type");
    return null;
  }
  if (value.length > MAX_CATEGORY_RULES) {
    errors.add("categoryRules", "too_many");
    return null;
  }
  const before = errors.list.length;
  const out: ReceiptCategoryRule[] = [];
  value.forEach((entry, index) => {
    const path = `categoryRules[${index}]`;
    if (!isPlainObject(entry)) {
      errors.add(path, "invalid_type");
      return;
    }
    checkKeys(entry, CATEGORY_RULE_KEYS, `${path}.`, errors);
    // A category rule is a capture-less glob over an item name.
    const noCaptures: FieldCaptures = { allowed: [], required: [] };
    const matchOk = checkPattern(
      entry.match,
      `${path}.match`,
      noCaptures,
      errors,
    );
    const categoryId = checkUuid(
      entry.categoryId,
      `${path}.categoryId`,
      errors,
    );
    if (matchOk && categoryId !== null) {
      out.push({ match: entry.match as string, categoryId });
    }
  });
  return errors.list.length === before ? out : null;
}

/**
 * Validate an untrusted value as a version 1 receipt parser definition.
 * Refuses unknown keys at every level, wrong types, another version, bounds
 * exceeded, malformed or repeated captures, a capture name the field does not
 * take, and a category id that is not a UUID. On success the returned
 * definition is a fresh object holding only validated data.
 */
export function validateReceiptParserDefinition(
  input: unknown,
): ReceiptParserValidation {
  const errors = new Errors();
  if (!isPlainObject(input)) {
    errors.add("", "not_object");
    return { ok: false, errors: errors.list };
  }
  checkKeys(input, TOP_LEVEL_KEYS, "", errors);
  if (input.version !== RECEIPT_PARSER_VERSION) {
    errors.add("version", "invalid_version");
  }

  const out: ReceiptParserDefinition = { version: RECEIPT_PARSER_VERSION };
  const fields: [
    "orderId" | "total" | "shipping" | "discount",
    FieldCaptures,
  ][] = [
    ["orderId", ORDER_ID_CAPTURES],
    ["total", AMOUNT_CAPTURES],
    ["shipping", AMOUNT_CAPTURES],
    ["discount", AMOUNT_CAPTURES],
  ];
  for (const [field, captures] of fields) {
    if (input[field] === undefined) continue;
    const patterns = checkPatternList(input[field], field, captures, errors, 0);
    if (patterns !== null) out[field] = patterns;
  }
  if (input.items !== undefined) {
    const items = checkItems(input.items, errors);
    if (items !== null) out.items = items;
  }
  if (input.categoryRules !== undefined) {
    const rules = checkCategoryRules(input.categoryRules, errors);
    if (rules !== null) out.categoryRules = rules;
  }
  for (const field of ["defaultCategoryId", "shippingCategoryId"] as const) {
    if (input[field] === undefined) continue;
    const id = checkUuid(input[field], field, errors);
    if (id !== null) out[field] = id;
  }

  return errors.list.length > 0
    ? { ok: false, errors: errors.list }
    : { ok: true, definition: out };
}

/**
 * Every category id a definition refers to, each once, in first-seen order
 * (rules, then the default, then shipping). The service that saves a parser
 * checks in the write's transaction that the user owns each of them.
 */
export function collectParserCategoryIds(
  definition: ReceiptParserDefinition,
): string[] {
  const ids: string[] = [];
  for (const rule of definition.categoryRules ?? []) ids.push(rule.categoryId);
  if (definition.defaultCategoryId) ids.push(definition.defaultCategoryId);
  if (definition.shippingCategoryId) ids.push(definition.shippingCategoryId);
  return [...new Set(ids)];
}
