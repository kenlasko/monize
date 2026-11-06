import { decimalPlacesOf } from "../common/amount-precision.util";
import { FIAT_MONEY_DECIMALS } from "../common/round.util";
import {
  evaluateRuleCondition,
  evaluateRuleConditionWithCaptures,
} from "./rule-condition.evaluator";
import {
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_NODES,
} from "./rule-validation";
import {
  RULE_CONDITION_FIELDS,
  RuleConditionLeaf,
  RuleConditionNode,
  RuleField,
  RuleFacts,
  RuleLeafValue,
  RuleOperator,
} from "./rule-condition.types";
import { GlobCaptures } from "./rule-glob-capture";

/**
 * The fact a leaf compared, as plain data: money as a decimal string at four
 * decimals, text as the row holds it, ids as ids, a tag set as a list of ids.
 * `null` is a fact the row does not have (unknown), never a default.
 *
 * The facts hold no full date: a date leaf reads `dayOfMonth` (a number) or
 * `weekday` (`MON`..`SUN`), and that is what is reported.
 */
export type RuleLeafActual =
  string | number | boolean | readonly string[] | null;

/** One condition leaf, with what it expected and what the row had. */
export interface RuleLeafExplanation {
  readonly kind: "leaf";
  readonly field: RuleField;
  readonly operator: RuleOperator;
  /** The value as authored; null for an operator with none (`isEmpty`). */
  readonly expected: RuleLeafValue | null;
  readonly actual: RuleLeafActual;
  readonly result: boolean;
  /** The values a `matches` leaf captured; absent when it captured nothing. */
  readonly captures?: GlobCaptures;
}

/**
 * A group. `not` wraps the group it negates as its only child, so the tree
 * says both what the group did and that its answer was turned around.
 */
export interface RuleGroupExplanation {
  readonly kind: "all" | "any" | "not";
  readonly result: boolean;
  readonly children: readonly RuleConditionExplanation[];
  /** What the holding children captured; absent when nothing was captured. */
  readonly captures?: GlobCaptures;
}

/**
 * A subtree left out because the condition is deeper or larger than the
 * validator allows (a stored rule is never; the bound is the explanation's
 * own). Its answer is still the evaluator's.
 */
export interface RuleOmittedExplanation {
  readonly kind: "omitted";
  readonly result: boolean;
  readonly captures?: GlobCaptures;
}

export type RuleConditionExplanation =
  RuleLeafExplanation | RuleGroupExplanation | RuleOmittedExplanation;

/**
 * An amount fact as the text a person is shown: at least the four places a
 * fiat amount is written at, and as many more (to eight) as a coin's carries.
 */
const amountToDecimal = (amount: number): string =>
  amount.toFixed(Math.max(FIAT_MONEY_DECIMALS, decimalPlacesOf(amount)));

/** The fact a field reads, in the form a person is shown. */
function actualFor(field: RuleField, facts: RuleFacts): RuleLeafActual {
  switch (field) {
    case "accountId":
      return facts.accountId;
    case "fromAccountId":
      return facts.fromAccountId;
    case "toAccountId":
      return facts.toAccountId;
    case "type":
      return facts.type;
    case "payeeId":
      return facts.payeeId;
    case "payeeText":
      return facts.payeeText;
    case "categoryId":
      return facts.categoryId;
    case "description":
      return facts.description;
    case "amount":
      return facts.amount === null ? null : amountToDecimal(facts.amount);
    case "absAmount":
      return facts.amount === null
        ? null
        : amountToDecimal(Math.abs(facts.amount));
    case "currencyCode":
      return facts.currencyCode;
    case "tagIds":
      return [...facts.tagIds];
    case "hasSplits":
      return facts.hasSplits;
    case "referenceNumber":
      return facts.referenceNumber;
    case "dayOfMonth":
      return facts.dayOfMonth;
    case "weekday":
      return facts.weekday;
    case "status":
      return facts.status;
    case "hasAttachment":
      return facts.hasAttachment;
    default:
      // A stored rule that names a field the table no longer has matches nothing.
      return null;
  }
}

const noCaptures = (captures: GlobCaptures): boolean =>
  Object.keys(captures).length === 0;

function merged(parts: readonly (GlobCaptures | undefined)[]): GlobCaptures {
  const out: Record<string, string> = Object.create(null);
  for (const part of parts) if (part !== undefined) Object.assign(out, part);
  return Object.freeze(out);
}

interface Budget {
  nodes: number;
}

/**
 * Explain a condition tree against the facts of one row: the same tree, each
 * node with the answer it gave and each leaf with what it expected and what the
 * row had. Pure; no query, no clock.
 *
 * It is the evaluator's answer, not a second one. A leaf's result is
 * `evaluateRuleCondition` of that leaf, its captures are
 * `evaluateRuleConditionWithCaptures` of that leaf, and a group combines its
 * children's results the way the evaluator does (`all` of nothing is true,
 * `any` of nothing is false, `not` negates). The root's `result` equals
 * `evaluateRuleCondition(node, facts)` and its captures equal the captures of
 * `evaluateRuleConditionWithCaptures`, which the spec holds over every
 * condition fixture of the evaluator's own specs. Unlike the evaluator it does
 * not stop at the first child that decides a group: every child is explained,
 * because the reader wants to see which leaf failed.
 *
 * The output is bounded by the validator's own limits: a group below
 * `MAX_RULE_CONDITION_DEPTH`, or any node beyond `MAX_RULE_CONDITION_NODES` nodes, is
 * reported as `omitted` with its answer.
 */
export function explainRuleCondition(
  node: RuleConditionNode,
  facts: RuleFacts,
): RuleConditionExplanation {
  return explain(node, facts, 1, { nodes: 0 });
}

function explain(
  node: RuleConditionNode,
  facts: RuleFacts,
  depth: number,
  budget: Budget,
): RuleConditionExplanation {
  // The validator limits the depth of groups (a leaf may sit one level below
  // the deepest allowed group) and the number of nodes.
  const isGroup = "all" in node || "any" in node;
  if (
    ++budget.nodes > MAX_RULE_CONDITION_NODES ||
    (isGroup && depth > MAX_RULE_CONDITION_DEPTH)
  ) {
    const answer = evaluateRuleConditionWithCaptures(node, facts);
    return {
      kind: "omitted",
      result: answer.matched,
      ...(answer.matched && !noCaptures(answer.captures)
        ? { captures: answer.captures }
        : {}),
    };
  }
  if ("all" in node || "any" in node) {
    const all = "all" in node;
    const source = "all" in node ? node.all : node.any;
    const children = source.map((child) =>
      explain(child, facts, depth + 1, budget),
    );
    const held = children.filter((child) => child.result);
    const inner = all ? held.length === children.length : held.length > 0;
    const captures = inner ? merged(held.map(capturesOf)) : undefined;
    const group: RuleGroupExplanation = {
      kind: all ? "all" : "any",
      result: inner,
      children,
      ...(captures !== undefined && !noCaptures(captures) ? { captures } : {}),
    };
    // A negated group captures nothing: the evaluator keeps no capture of a
    // group that held only because its children did not.
    return node.not === true
      ? { kind: "not", result: !inner, children: [group] }
      : group;
  }
  return explainLeaf(node, facts);
}

const capturesOf = (
  explanation: RuleConditionExplanation,
): GlobCaptures | undefined => explanation.captures;

function explainLeaf(
  leaf: RuleConditionLeaf,
  facts: RuleFacts,
): RuleLeafExplanation {
  const result = evaluateRuleCondition(leaf, facts);
  const matched = result
    ? evaluateRuleConditionWithCaptures(leaf, facts)
    : null;
  const captures =
    matched !== null && matched.matched && !noCaptures(matched.captures)
      ? matched.captures
      : undefined;
  return {
    kind: "leaf",
    field: leaf.field,
    operator: leaf.op,
    expected: leaf.value ?? null,
    actual:
      RULE_CONDITION_FIELDS[leaf.field] === undefined
        ? null
        : actualFor(leaf.field, facts),
    result,
    ...(captures !== undefined ? { captures } : {}),
  };
}
