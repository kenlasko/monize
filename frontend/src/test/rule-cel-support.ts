/**
 * Shared fixtures of the expression-mode tests: a catalog with the names that
 * make printing hard (shared names, quotes), a tree builder, and a seeded
 * generator of every kind of tree the visual editor can build.
 */
import { EntityIndex, type CelCatalog } from '@/lib/rule-cel';
import {
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_LEAVES,
  MAX_RULE_CONDITION_NODES,
  MAX_RULE_TEXT_LENGTH,
  MAX_RULE_VALUE_LIST,
  RULE_CONDITION_FIELDS,
  RULE_FIELDS,
  RULE_OPERATOR_SHAPES,
} from '@/lib/rule-fields';
import type { EditorGroup, EditorLeaf, EditorNode, EditorValue } from '@/lib/rule-tree';
import type { RuleField, RuleOperator } from '@/types/transaction-rule';

export const CATALOG: CelCatalog = {
  account: [
    { id: 'acc-1', name: 'Chequing' },
    { id: 'acc-2', name: 'RRSP' },
    { id: 'acc-3', name: 'Chequing' },
    { id: 'acc-4', name: 'Say "hi" \\ there' },
  ],
  payee: [
    { id: 'pay-1', name: 'Corner Cafe' },
    { id: 'pay-2', name: 'Amazon' },
    { id: 'pay-3', name: 'Amazon' },
    { id: 'pay-4', name: 'Amazon' },
    { id: 'pay-5', name: "O'Brien's" },
  ],
  category: [
    { id: 'cat-1', name: 'Food' },
    { id: 'cat-2', name: 'Food: Coffee' },
    { id: 'cat-3', name: 'Zażółć gęślą' },
  ],
  tag: [
    { id: 'tag-1', name: 'Coffee run' },
    { id: 'tag-2', name: 'Work' },
    { id: 'tag-3', name: 'Line\nbreak' },
  ],
};

export const INDEX = new EntityIndex(CATALOG);

let counter = 0;
const uid = () => `u${++counter}`;

export const leaf = (field: RuleField, op: RuleOperator, value?: EditorValue): EditorLeaf => ({
  kind: 'leaf',
  uid: uid(),
  field,
  op,
  value,
});

export const group = (
  match: 'all' | 'any',
  children: readonly EditorNode[] = [],
  not = false,
): EditorGroup => ({ kind: 'group', uid: uid(), match, not, children });

/** The tree without its React keys, for comparing two trees that were built apart. */
export function stripUids(node: EditorNode): unknown {
  if (node.kind === 'leaf') return { kind: 'leaf', field: node.field, op: node.op, value: node.value };
  return { kind: 'group', match: node.match, not: node.not, children: node.children.map(stripUids) };
}

// ---- a seeded generator ---------------------------------------------------

/** mulberry32: small, fast, and the same numbers on every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const pick = <T>(rand: Random, list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const int = (rand: Random, min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

const TEXT_PARTS = ['coffee', '*BIEDRONKA*', 'a"b', "it's", 'back\\slash', 'two\nlines', '\ttab', 'zażółć', '日本語', '😀', '', ' ', '\u0001'];
const NUMBERS = [0, -0, 1, -1, 12.5, -500, -100, 0.0001, 1e21, 1e-7, 123456789.1234, 5];
const CURRENCIES = ['CAD', 'USD', 'eur'];
const DATES = ['2026-01-01', '2026-09-07', '2026-10-01', '2026-12-31'];

function text(rand: Random): string {
  const value = Array.from({ length: int(rand, 0, 3) }, () => pick(rand, TEXT_PARTS)).join('');
  return value.slice(0, MAX_RULE_TEXT_LENGTH);
}

function reference(rand: Random, field: RuleField): string {
  const kind = RULE_CONDITION_FIELDS[field].kind;
  const catalog = kind === 'accountId' ? CATALOG.account : kind === 'payeeId' ? CATALOG.payee : kind === 'categoryId' ? CATALOG.category : CATALOG.tag;
  // Now and then an id that is not in the catalog: an item deleted since the rule was saved.
  return rand() < 0.1 ? `gone-${int(rand, 1, 3)}` : pick(rand, catalog).id;
}

function scalar(rand: Random, field: RuleField, list: boolean): string | number | boolean | undefined {
  const spec = RULE_CONDITION_FIELDS[field];
  switch (spec.kind) {
    case 'accountId':
    case 'payeeId':
    case 'categoryId':
    case 'tagIds':
      return !list && rand() < 0.1 ? '' : reference(rand, field);
    case 'money':
      return rand() < 0.1 ? undefined : pick(rand, NUMBERS);
    case 'dayOfMonth':
      return !list && rand() < 0.1 ? undefined : int(rand, 1, 31);
    case 'enum':
      return pick(rand, spec.enumValues ?? []);
    case 'currency':
      return !list && rand() < 0.1 ? '' : pick(rand, CURRENCIES);
    case 'date':
      return rand() < 0.1 ? '' : pick(rand, DATES);
    case 'boolean':
      return rand() < 0.5;
    default:
      return text(rand);
  }
}

function value(rand: Random, field: RuleField, op: RuleOperator): EditorValue {
  switch (RULE_OPERATOR_SHAPES[op]) {
    case 'none':
      return undefined;
    case 'list':
      return Array.from({ length: int(rand, 0, 4) }, () => scalar(rand, field, true) as string);
    case 'range':
      return [scalar(rand, field, false) as number | undefined, scalar(rand, field, false) as number | undefined];
    default:
      return scalar(rand, field, false);
  }
}

/** A leaf on this field and operator with a random value of the kind the field holds. */
export function leafFor(rand: Random, field: RuleField, op: RuleOperator): EditorLeaf {
  return leaf(field, op, value(rand, field, op));
}

export function randomLeaf(rand: Random): EditorLeaf {
  const field = pick(rand, RULE_FIELDS);
  return leafFor(rand, field, pick(rand, RULE_CONDITION_FIELDS[field].operators));
}

/** A tree the visual editor could have built: inside the depth, leaf and node limits. */
export function randomTree(rand: Random): EditorGroup {
  let leaves = 0;
  let nodes = 0;
  const build = (depth: number): EditorGroup => {
    nodes += 1;
    const children: EditorNode[] = [];
    const count = int(rand, 0, 4);
    for (let i = 0; i < count; i += 1) {
      const room = nodes < MAX_RULE_CONDITION_NODES - 1 && leaves < MAX_RULE_CONDITION_LEAVES;
      if (!room) break;
      if (depth < MAX_RULE_CONDITION_DEPTH && rand() < 0.35) {
        children.push(build(depth + 1));
      } else {
        nodes += 1;
        leaves += 1;
        children.push(randomLeaf(rand));
      }
    }
    return group(rand() < 0.5 ? 'all' : 'any', children, rand() < 0.2);
  };
  return build(1);
}

export const LIMITS = { MAX_RULE_CONDITION_DEPTH, MAX_RULE_VALUE_LIST };
