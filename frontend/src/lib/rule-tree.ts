/**
 * The condition tree as the editor holds it, and the immutable operations on
 * it. Every operation takes the root and a path (child indices from the root)
 * and returns a new root; nothing here mutates.
 *
 * The editor tree differs from the stored one in two ways: every node carries
 * a `uid` (a stable React key, so moving a card does not hand its picker's
 * typed text to its neighbour), and a leaf's value may be incomplete while the
 * reader is still choosing. `lib/rule-draft.ts` converts in both directions.
 */
import {
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_LEAVES,
  MAX_RULE_CONDITION_NODES,
  RULE_CONDITION_FIELDS,
  RULE_OPERATOR_SHAPES,
} from '@/lib/rule-fields';
import type { RuleField, RuleOperator } from '@/types/transaction-rule';

export type GroupMatch = 'all' | 'any';

/** A leaf's value while it is being edited: a range may have an empty end. */
export type EditorValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly (number | undefined)[]
  | undefined;

export interface EditorLeaf {
  readonly kind: 'leaf';
  readonly uid: string;
  readonly field: RuleField;
  readonly op: RuleOperator;
  readonly value: EditorValue;
}

export interface EditorGroup {
  readonly kind: 'group';
  readonly uid: string;
  readonly match: GroupMatch;
  readonly not: boolean;
  readonly children: readonly EditorNode[];
}

export type EditorNode = EditorLeaf | EditorGroup;

/** Child indices from the root; `[]` is the root itself. */
export type NodePath = readonly number[];

export const newUid = (): string => crypto.randomUUID();

export function createGroup(match: GroupMatch = 'all', children: readonly EditorNode[] = []): EditorGroup {
  return { kind: 'group', uid: newUid(), match, not: false, children };
}

/** What a value looks like right after the operator (or field) is chosen. */
export function defaultValue(field: RuleField, op: RuleOperator): EditorValue {
  const spec = RULE_CONDITION_FIELDS[field];
  switch (RULE_OPERATOR_SHAPES[op]) {
    case 'none':
      return undefined;
    case 'list':
      return [];
    case 'range':
      // A date range is a pair of texts, an unset end the empty one.
      return spec.kind === 'date' ? ['', ''] : [undefined, undefined];
    default:
      if (spec.kind === 'boolean') return true;
      if (spec.kind === 'enum') return spec.enumValues?.[0] ?? '';
      return spec.kind === 'money' || spec.kind === 'dayOfMonth' ? undefined : '';
  }
}

/** A blank leaf on `field`, its operator the first one the field allows. */
export function createLeaf(field: RuleField = 'payeeText'): EditorLeaf {
  const op = RULE_CONDITION_FIELDS[field].operators[0];
  return { kind: 'leaf', uid: newUid(), field, op, value: defaultValue(field, op) };
}

/** Changing the field starts over: the old operator and value meant something else. */
export function changeLeafField(leaf: EditorLeaf, field: RuleField): EditorLeaf {
  if (field === leaf.field) return leaf;
  const op = RULE_CONDITION_FIELDS[field].operators[0];
  return { ...leaf, field, op, value: defaultValue(field, op) };
}

/**
 * Carries what the reader already chose across an operator change where the
 * shapes allow it (`is` to `is any of` keeps the pick), and starts over where
 * they do not.
 */
function coerceValue(leaf: EditorLeaf, op: RuleOperator): EditorValue {
  const from = RULE_OPERATOR_SHAPES[leaf.op];
  const to = RULE_OPERATOR_SHAPES[op];
  if (from === to) return leaf.value;
  const fresh = defaultValue(leaf.field, op);
  const value = leaf.value;
  if (from === 'scalar' && to === 'list') {
    if (typeof value === 'number') return [value];
    return typeof value === 'string' && value !== '' ? [value] : fresh;
  }
  if (from === 'list' && to === 'scalar') {
    if (Array.isArray(value) && (typeof value[0] === 'string' || typeof value[0] === 'number')) return value[0];
    return fresh;
  }
  if (from === 'scalar' && to === 'range') {
    if (RULE_CONDITION_FIELDS[leaf.field].kind === 'date') {
      return typeof value === 'string' && value !== '' ? [value, ''] : fresh;
    }
    return typeof value === 'number' ? [value, undefined] : fresh;
  }
  if (from === 'range' && to === 'scalar') {
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0] !== '') return value[0];
    return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : fresh;
  }
  return fresh;
}

export function changeLeafOperator(leaf: EditorLeaf, op: RuleOperator): EditorLeaf {
  if (op === leaf.op) return leaf;
  return { ...leaf, op, value: coerceValue(leaf, op) };
}

// ---- reading -------------------------------------------------------------

export function getNode(root: EditorNode, path: NodePath): EditorNode | undefined {
  let node: EditorNode | undefined = root;
  for (const index of path) {
    if (!node || node.kind !== 'group') return undefined;
    node = node.children[index];
  }
  return node;
}

export interface TreeStats {
  readonly leaves: number;
  /** Groups and leaves together, the root included. */
  readonly nodes: number;
}

export function treeStats(node: EditorNode): TreeStats {
  if (node.kind === 'leaf') return { leaves: 1, nodes: 1 };
  return node.children.reduce<TreeStats>(
    (sum, child) => {
      const stats = treeStats(child);
      return { leaves: sum.leaves + stats.leaves, nodes: sum.nodes + stats.nodes };
    },
    { leaves: 0, nodes: 1 },
  );
}

export interface TreeCapacity {
  readonly canAddLeaf: boolean;
  readonly canAddGroupNode: boolean;
}

/** What the tree as a whole still has room for (depth is per group, see below). */
export function treeCapacity(root: EditorNode): TreeCapacity {
  const { leaves, nodes } = treeStats(root);
  return {
    canAddLeaf: leaves < MAX_RULE_CONDITION_LEAVES && nodes < MAX_RULE_CONDITION_NODES,
    canAddGroupNode: nodes < MAX_RULE_CONDITION_NODES,
  };
}

/** The root is depth 1; a group deeper than `MAX_RULE_CONDITION_DEPTH` is refused. */
export function groupDepth(path: NodePath): number {
  return path.length + 1;
}

/** Whether a group at `path` may hold a group of its own. */
export function canNestGroup(path: NodePath): boolean {
  return groupDepth(path) < MAX_RULE_CONDITION_DEPTH;
}

/** Deepest group level under (and including) `node`, counting the node as `base`. */
function deepestGroup(node: EditorNode, base: number): number {
  if (node.kind === 'leaf') return 0;
  return node.children.reduce((deepest, child) => Math.max(deepest, deepestGroup(child, base + 1)), base);
}

// ---- writing -------------------------------------------------------------

function replaceAt(root: EditorGroup, path: NodePath, fn: (node: EditorNode) => EditorNode): EditorGroup {
  if (path.length === 0) {
    const next = fn(root);
    return next.kind === 'group' ? next : root;
  }
  const [head, ...rest] = path;
  const child = root.children[head];
  if (!child) return root;
  const next =
    rest.length === 0 ? fn(child) : child.kind === 'group' ? replaceAt(child, rest, fn) : child;
  if (next === child) return root;
  return { ...root, children: root.children.map((c, i) => (i === head ? next : c)) };
}

/** Replaces the node at `path` with what `fn` makes of it. */
export function updateNode(root: EditorGroup, path: NodePath, fn: (node: EditorNode) => EditorNode): EditorGroup {
  return replaceAt(root, path, fn);
}

/** Appends `node` to the group at `groupPath`. */
export function addChild(root: EditorGroup, groupPath: NodePath, node: EditorNode): EditorGroup {
  return replaceAt(root, groupPath, (target) =>
    target.kind === 'group' ? { ...target, children: [...target.children, node] } : target,
  );
}

function withParent(
  root: EditorGroup,
  path: NodePath,
  fn: (children: readonly EditorNode[], index: number) => readonly EditorNode[],
): EditorGroup {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  return replaceAt(root, parentPath, (parent) =>
    parent.kind === 'group' && parent.children[index]
      ? { ...parent, children: fn(parent.children, index) }
      : parent,
  );
}

/** Removes the node at `path`; the root cannot be removed. */
export function removeNode(root: EditorGroup, path: NodePath): EditorGroup {
  return withParent(root, path, (children, index) => children.filter((_, i) => i !== index));
}

/** Whether the node at `path` has a sibling `delta` places away. */
export function canMoveNode(root: EditorGroup, path: NodePath, delta: -1 | 1): boolean {
  if (path.length === 0) return false;
  const parent = getNode(root, path.slice(0, -1));
  if (!parent || parent.kind !== 'group') return false;
  const target = path[path.length - 1] + delta;
  return target >= 0 && target < parent.children.length;
}

/** Swaps the node at `path` with the sibling `delta` places away. */
export function moveNode(root: EditorGroup, path: NodePath, delta: -1 | 1): EditorGroup {
  if (!canMoveNode(root, path, delta)) return root;
  return withParent(root, path, (children, index) => {
    const next = [...children];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    return next;
  });
}

/** A copy of `node` and everything under it, every node with a new `uid`. */
export function cloneNode(node: EditorNode): EditorNode {
  if (node.kind === 'leaf') return { ...node, uid: newUid() };
  return { ...node, uid: newUid(), children: node.children.map(cloneNode) };
}

/** Inserts a copy of the node at `path` right after it. */
export function duplicateNode(root: EditorGroup, path: NodePath): EditorGroup {
  return withParent(root, path, (children, index) => {
    const next = [...children];
    next.splice(index + 1, 0, cloneNode(children[index]));
    return next;
  });
}

/** Whether a copy of the node at `path` still fits the depth and size limits. */
export function canDuplicateNode(root: EditorGroup, path: NodePath): boolean {
  const node = getNode(root, path);
  if (!node || path.length === 0) return false;
  const copy = treeStats(node);
  const total = treeStats(root);
  const depthOk = node.kind === 'leaf' || deepestGroup(node, groupDepth(path)) <= MAX_RULE_CONDITION_DEPTH;
  return (
    depthOk &&
    total.leaves + copy.leaves <= MAX_RULE_CONDITION_LEAVES &&
    total.nodes + copy.nodes <= MAX_RULE_CONDITION_NODES
  );
}

/** The stable string an error map uses for a condition node, `c:` for the root. */
export const conditionKey = (path: NodePath): string => `c:${path.join('.')}`;
