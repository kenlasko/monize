/**
 * The condition tree as CEL-syntax text. One canonical text per tree, and
 * `parseCondition` reads it back to the same tree (`roundtrip.test.ts`).
 *
 * Shape of the text:
 *  - a group of two or more is `a && b` (all) or `a || b` (any); a group inside
 *    another is always in parentheses, so `a && b && c` (one group) and
 *    `a && (b && c)` (a group inside one) stay different rules;
 *  - a group with one child is `all(x)` / `any(x)`, an empty one `true` / `false`
 *    (an empty all-group is true, an empty any-group false, as in CEL);
 *  - a negated group is `!( ... )`;
 *  - the root is written without the parentheses; a root holding exactly one
 *    condition is just that condition.
 * A value not chosen yet is `_`, so a half-built rule can be shown and edited.
 */
import { ENTITY_KIND_OF_FIELD, EntityIndex, type CelEntityKind } from '@/lib/rule-cel/catalog';
import { CEL_UNFILLED, formatNumber, quoteString } from '@/lib/rule-cel/literal';
import { RULE_CONDITION_FIELDS, RULE_OPERATOR_SHAPES } from '@/lib/rule-fields';
import type { EditorGroup, EditorLeaf, EditorNode, EditorValue } from '@/lib/rule-tree';
import type { RuleOperator } from '@/types/transaction-rule';

/** Infix operators of a comparison. */
export const COMPARISON_TOKENS: Readonly<Partial<Record<RuleOperator, string>>> = {
  eq: '==',
  neq: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Operators written as a method of the field, with the method's name. */
export const METHOD_NAMES: Readonly<Partial<Record<RuleOperator, string>>> = {
  contains: 'contains',
  startsWith: 'startsWith',
  matches: 'matchesGlob',
  between: 'between',
  inSubtree: 'inSubtree',
  hasAny: 'hasAny',
  hasAll: 'hasAll',
  hasNone: 'hasNone',
};

export const fieldPath = (field: string): string => `transaction.${field}`;

/** One reference to an item: `account("Chequing")`, `payee("Amazon", 2)`, or `missing("<id>")`. */
export function entityText(index: EntityIndex, kind: CelEntityKind, id: string): string {
  if (id === '') return CEL_UNFILLED;
  const written = index.nameOf(kind, id);
  // An item that no longer exists has no name to show; its id is the only way to keep the rule intact.
  if (!written) return `missing(${quoteString(id)})`;
  const ordinal = written.ordinal === null ? '' : `, ${written.ordinal}`;
  return `${kind}(${quoteString(written.name)}${ordinal})`;
}

function scalarText(index: EntityIndex, leaf: EditorLeaf, value: unknown): string {
  const spec = RULE_CONDITION_FIELDS[leaf.field];
  const entity = ENTITY_KIND_OF_FIELD[spec.kind];
  if (entity) return entityText(index, entity, typeof value === 'string' ? value : '');
  switch (spec.kind) {
    case 'money':
    case 'dayOfMonth':
      return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : CEL_UNFILLED;
    case 'boolean':
      return value === false ? 'false' : 'true';
    case 'currency':
    case 'date':
      return typeof value === 'string' && value !== '' ? quoteString(value) : CEL_UNFILLED;
    default:
      return quoteString(typeof value === 'string' ? value : '');
  }
}

function listText(index: EntityIndex, leaf: EditorLeaf, value: EditorValue): string {
  const items = Array.isArray(value) ? (value as readonly unknown[]) : [];
  return `[${items.map((item) => scalarText(index, leaf, item)).join(', ')}]`;
}

export function leafText(index: EntityIndex, leaf: EditorLeaf): string {
  const field = fieldPath(leaf.field);
  const { op, value } = leaf;
  const comparison = COMPARISON_TOKENS[op];
  if (comparison) return `${field} ${comparison} ${scalarText(index, leaf, value)}`;
  switch (op) {
    case 'in':
      return `${field} in ${listText(index, leaf, value)}`;
    case 'notIn':
      return `!(${field} in ${listText(index, leaf, value)})`;
    case 'isEmpty':
      return `isEmpty(${field})`;
    case 'between': {
      const ends = Array.isArray(value) ? (value as readonly unknown[]) : [];
      return `${field}.between(${scalarText(index, leaf, ends[0])}, ${scalarText(index, leaf, ends[1])})`;
    }
    default:
      break;
  }
  const method = METHOD_NAMES[op];
  const argument =
    RULE_OPERATOR_SHAPES[op] === 'list' ? listText(index, leaf, value) : scalarText(index, leaf, value);
  return `${field}.${method}(${argument})`;
}

/** A group without its negation: the text that goes inside `!( ... )`. */
function coreText(index: EntityIndex, group: EditorGroup): string {
  const { children, match } = group;
  if (children.length === 0) return match === 'all' ? 'true' : 'false';
  if (children.length === 1) return `${match}(${argumentText(index, children[0])})`;
  return children.map((child) => operandText(index, child)).join(match === 'all' ? ' && ' : ' || ');
}

/** A node as the argument of `all(...)` / `any(...)`: any expression is allowed there. */
function argumentText(index: EntityIndex, node: EditorNode): string {
  if (node.kind === 'leaf') return leafText(index, node);
  return node.not ? `!(${coreText(index, node)})` : coreText(index, node);
}

/** A node as an operand of `&&` / `||`: a group of several is parenthesised. */
function operandText(index: EntityIndex, node: EditorNode): string {
  if (node.kind === 'leaf') return leafText(index, node);
  if (node.not) return `!(${coreText(index, node)})`;
  return node.children.length >= 2 ? `(${coreText(index, node)})` : coreText(index, node);
}

/** The whole condition, ready for the expression view. */
export function printCondition(root: EditorGroup, index: EntityIndex = new EntityIndex()): string {
  if (root.not) return `!(${coreText(index, root)})`;
  const [only] = root.children;
  if (root.match === 'all' && root.children.length === 1 && only.kind === 'leaf') return leafText(index, only);
  return coreText(index, root);
}
