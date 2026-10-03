import { GlobCaptures, matchGlobWithCaptures } from "./rule-glob-capture";
import {
  RULE_CONDITION_FIELDS,
  RuleConditionLeaf,
  RuleConditionNode,
  RuleFacts,
  RuleOperator,
} from "./rule-condition.types";

/** Money scale: rule literals and facts compare as integers in 1/10000 units. */
const MONEY_SCALE = 10000;

/** A rule literal as the scaled integer the facts use. */
export function scaleRuleMoney(value: unknown): number {
  return Math.round(Number(value) * MONEY_SCALE);
}

const normalize = (value: string): string => value.trim().toLowerCase();

const asList = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/**
 * Evaluate a condition tree against the facts of one row.
 *
 * Pure: no query, no clock, no `eval`. A group `all` of nothing is true and
 * `any` of nothing is false; `not` negates the group's result. A leaf whose
 * fact is unknown (`null`) is false for every operator except `isEmpty`.
 */
export function evaluateRuleCondition(
  node: RuleConditionNode,
  facts: RuleFacts,
): boolean {
  if ("all" in node) {
    const result = node.all.every((child) =>
      evaluateRuleCondition(child, facts),
    );
    return node.not === true ? !result : result;
  }
  if ("any" in node) {
    const result = node.any.some((child) =>
      evaluateRuleCondition(child, facts),
    );
    return node.not === true ? !result : result;
  }
  return evaluateLeaf(node, facts);
}

function evaluateLeaf(leaf: RuleConditionLeaf, facts: RuleFacts): boolean {
  const spec = RULE_CONDITION_FIELDS[leaf.field];
  if (spec === undefined || !spec.operators.includes(leaf.op as never)) {
    // A stored rule that no longer fits the table matches nothing.
    return false;
  }
  switch (spec.kind) {
    case "accountId":
    case "payeeId":
    case "categoryId":
      return evaluateId(leaf, facts);
    case "tagIds":
      return evaluateTags(leaf.op, facts.tagIds, asList(leaf.value));
    case "text":
      return evaluateText(leaf.op, textFact(leaf, facts), leaf.value);
    case "money":
      return evaluateMoney(leaf, facts);
    case "boolean":
      return (
        leaf.op === "eq" &&
        (leaf.field === "hasAttachment"
          ? facts.hasAttachment
          : facts.hasSplits) === leaf.value
      );
    case "dayOfMonth":
      return evaluateDayOfMonth(leaf, facts.dayOfMonth);
    case "date":
      return evaluateDate(leaf, facts.date);
    default:
      // "enum" and "currency" compare as case-insensitive codes.
      return evaluateCode(leaf.op, codeFact(leaf, facts), leaf.value);
  }
}

function codeFact(leaf: RuleConditionLeaf, facts: RuleFacts): string | null {
  switch (leaf.field) {
    case "type":
      return facts.type;
    case "weekday":
      return facts.weekday;
    case "status":
      return facts.status;
    default:
      return facts.currencyCode;
  }
}

function idFact(leaf: RuleConditionLeaf, facts: RuleFacts): string | null {
  switch (leaf.field) {
    case "accountId":
      return facts.accountId;
    case "fromAccountId":
      return facts.fromAccountId;
    case "toAccountId":
      return facts.toAccountId;
    case "payeeId":
      return facts.payeeId;
    default:
      return facts.categoryId;
  }
}

function textFact(leaf: RuleConditionLeaf, facts: RuleFacts): string | null {
  switch (leaf.field) {
    case "payeeText":
      return facts.payeeText;
    case "description":
      return facts.description;
    default:
      return facts.referenceNumber;
  }
}

function evaluateId(leaf: RuleConditionLeaf, facts: RuleFacts): boolean {
  const fact = idFact(leaf, facts);
  if (fact === null) return leaf.op === "isEmpty";
  switch (leaf.op) {
    case "eq":
      return fact === leaf.value;
    case "neq":
      return fact !== leaf.value;
    case "in":
      return asList(leaf.value).includes(fact);
    case "notIn":
      return !asList(leaf.value).includes(fact);
    case "inSubtree":
      return facts.categoryAncestorIds.includes(leaf.value as string);
    default:
      return false;
  }
}

function evaluateTags(
  op: RuleOperator,
  tagIds: readonly string[],
  wanted: readonly unknown[],
): boolean {
  switch (op) {
    case "hasAny":
      return wanted.some((id) => tagIds.includes(id as string));
    case "hasAll":
      return wanted.every((id) => tagIds.includes(id as string));
    default: // hasNone: the field table admits no other operator
      return !wanted.some((id) => tagIds.includes(id as string));
  }
}

function evaluateText(
  op: RuleOperator,
  fact: string | null,
  value: unknown,
): boolean {
  if (fact === null) return op === "isEmpty";
  const text = normalize(fact);
  if (op === "isEmpty") return text === "";
  if (typeof value !== "string") return false;
  // `matches` reads `{name}` as a capture (design 10.1), so it gets the text
  // with its case, exactly as the capture path does; a pattern without a
  // capture is answered by `matchesAliasPattern` all the same.
  if (op === "matches") {
    return matchGlobWithCaptures(fact.trim(), value.trim()) !== null;
  }
  const wanted = normalize(value);
  switch (op) {
    case "eq":
      return text === wanted;
    case "contains":
      return text.includes(wanted);
    default: // startsWith: the field table admits no other operator
      return text.startsWith(wanted);
  }
}

function evaluateMoney(leaf: RuleConditionLeaf, facts: RuleFacts): boolean {
  if (facts.amount === null) return false;
  const fact =
    leaf.field === "absAmount" ? Math.abs(facts.amount) : facts.amount;
  if (leaf.op === "between") {
    const [min, max] = asList(leaf.value);
    return fact >= scaleRuleMoney(min) && fact <= scaleRuleMoney(max);
  }
  const wanted = scaleRuleMoney(leaf.value);
  switch (leaf.op) {
    case "eq":
      return fact === wanted;
    case "lt":
      return fact < wanted;
    case "lte":
      return fact <= wanted;
    case "gt":
      return fact > wanted;
    default: // gte: the field table admits no other operator
      return fact >= wanted;
  }
}

/** Whole days compared as numbers; an unknown date is false for every operator. */
function evaluateDayOfMonth(
  leaf: RuleConditionLeaf,
  day: number | null,
): boolean {
  if (day === null) return false;
  if (leaf.op === "between") {
    const [min, max] = asList(leaf.value);
    return day >= Number(min) && day <= Number(max);
  }
  if (leaf.op === "in") return asList(leaf.value).includes(day);
  const wanted = Number(leaf.value);
  switch (leaf.op) {
    case "eq":
      return day === wanted;
    case "lt":
      return day < wanted;
    case "lte":
      return day <= wanted;
    case "gt":
      return day > wanted;
    default: // gte: the field table admits no other operator
      return day >= wanted;
  }
}

/**
 * Calendar dates compared as `YYYY-MM-DD` strings (fixed width, so the text
 * order is the date order), never through a `Date`; an unknown date is false
 * for every operator.
 */
function evaluateDate(leaf: RuleConditionLeaf, date: string | null): boolean {
  if (date === null) return false;
  if (leaf.op === "between") {
    const [min, max] = asList(leaf.value);
    return (
      typeof min === "string" &&
      typeof max === "string" &&
      date >= min &&
      date <= max
    );
  }
  if (typeof leaf.value !== "string") return false;
  switch (leaf.op) {
    case "eq":
      return date === leaf.value;
    case "lt":
      return date < leaf.value;
    case "lte":
      return date <= leaf.value;
    case "gt":
      return date > leaf.value;
    default: // gte: the field table admits no other operator
      return date >= leaf.value;
  }
}

function evaluateCode(
  op: RuleOperator,
  fact: string | null,
  value: unknown,
): boolean {
  if (fact === null) return false;
  const code = fact.trim().toUpperCase();
  const same = (v: unknown): boolean =>
    typeof v === "string" && v.trim().toUpperCase() === code;
  switch (op) {
    case "eq":
      return same(value);
    case "neq":
      return !same(value);
    default: // in: the field table admits no other operator
      return asList(value).some(same);
  }
}

/** Whether a condition held for a row, and what its `matches` leaves captured. */
export interface RuleConditionMatch {
  readonly matched: boolean;
  /**
   * Captured values by name (design 10.1), from the leaves that matched. A
   * leaf in a branch of `any` that did not match, or under `not`, captures
   * nothing. Meant for the actions of the same rule only.
   */
  readonly captures: GlobCaptures;
}

const NO_MATCH: RuleConditionMatch = Object.freeze({
  matched: false,
  captures: Object.freeze(Object.create(null)),
});

/**
 * `evaluateRuleCondition` that also returns the captures of the `matches`
 * leaves. `matched` always equals `evaluateRuleCondition` for the same input
 * (the spec compares the two); a leaf without a capture is decided by the
 * boolean path itself.
 */
export function evaluateRuleConditionWithCaptures(
  node: RuleConditionNode,
  facts: RuleFacts,
): RuleConditionMatch {
  const captures = captureNode(node, facts);
  return captures === null
    ? NO_MATCH
    : Object.freeze({ matched: true, captures });
}

function merge(parts: readonly GlobCaptures[]): GlobCaptures {
  const out: Record<string, string> = Object.create(null);
  for (const part of parts) Object.assign(out, part);
  return Object.freeze(out);
}

/** The captures when the node holds, or null when it does not. */
function captureNode(
  node: RuleConditionNode,
  facts: RuleFacts,
): GlobCaptures | null {
  if ("all" in node || "any" in node) {
    const all = "all" in node;
    const children = "all" in node ? node.all : node.any;
    const held: GlobCaptures[] = [];
    let ok = all;
    for (const child of children) {
      const got = captureNode(child, facts);
      if (got !== null) held.push(got);
      if (all && got === null) {
        ok = false;
        break;
      }
      if (!all && got !== null) ok = true;
    }
    if (node.not === true) return ok ? null : merge([]);
    return ok ? merge(held) : null;
  }
  if (
    node.op === "matches" &&
    RULE_CONDITION_FIELDS[node.field]?.kind === "text" &&
    typeof node.value === "string"
  ) {
    const fact = textFact(node, facts);
    if (fact === null) return null;
    return matchGlobWithCaptures(fact.trim(), node.value.trim());
  }
  return evaluateLeaf(node, facts) ? merge([]) : null;
}
