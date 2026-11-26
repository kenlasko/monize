import { getDecimalPlacesForCurrency, sumMoney } from '@/lib/format';
import type {
  CashFlowSankeyNode,
  CashFlowSankeyNodeKind,
  CashFlowSankeyResponse,
} from '@/types/built-in-reports';

/**
 * How many category nodes one column draws before the rest merge into
 * "Other". A drawing decision only: the table and the summary cards read the
 * unmerged response (SANKEY-005, INV-REPORT-002).
 */
export const MAX_NODES_PER_COLUMN = 10;

/** Where a node sits, left to right. */
export type SankeyColumn = 'source' | 'hub' | 'destination' | 'child';

/** A node as the chart draws it; the response's own node rides along. */
export interface SankeyDrawNode {
  /** Read by recharts for the tooltip; the caller supplies the label. */
  name: string;
  id: string;
  kind: CashFlowSankeyNodeKind | 'other';
  column: SankeyColumn;
  color: string | null;
  /** The response's node, or `null` for a merged "Other". */
  node: CashFlowSankeyNode | null;
  /** For "Other": the labels it holds, largest first. */
  members: string[];
  /** The figure drawn: the total, or the known part when the total is unknown. */
  value: number;
  /** True when part of what the node stands for could not be converted. */
  unknown: boolean;
}

export interface SankeyDrawLink {
  source: number;
  target: number;
  value: number;
  /** Drawn at its known part because the whole could not be converted. */
  incomplete: boolean;
  /**
   * A subcategory whose refunds exceed its spending. The response links it
   * INTO its parent (so the signed child links sum to the parent's); the
   * drawing turns it round so the child stays in the child column, and marks
   * it so the reader is not shown a refund as spending.
   */
  netRefund: boolean;
  /**
   * Nothing of this link converted, so `value` is a sliver for the drawing
   * (design section 9: an unknown figure is drawn, hollow, never dropped).
   * The tooltip says "unknown" rather than printing the sliver.
   */
  placeholder: boolean;
}

export interface SankeyDrawing {
  nodes: SankeyDrawNode[];
  links: SankeyDrawLink[];
}

export interface SankeyLayoutOptions {
  maxNodesPerColumn?: number;
  /** The label each response node is drawn under. */
  labelFor: (node: CashFlowSankeyNode) => string;
  /** The label of a merged node. */
  otherLabel: string;
  /** The colour of a merged node. */
  otherColor: string | null;
}

/** The column a node's kind draws in. */
export function columnOf(node: CashFlowSankeyNode): SankeyColumn {
  switch (node.kind) {
    case 'hub':
      return 'hub';
    case 'income':
    case 'inflow':
      return 'source';
    case 'child':
    case 'account':
      return 'child';
    case 'uncategorized':
      return node.id === 'uncategorized:income' ? 'source' : 'destination';
    case 'residual':
      return node.id === 'residual:deficit' ? 'source' : 'destination';
    default:
      return 'destination';
  }
}

/** Only categories merge; the fixed nodes (classes, residual) always draw. */
const MERGEABLE: ReadonlySet<CashFlowSankeyNodeKind> = new Set([
  'income',
  'expense',
  'child',
]);

const drawnAmount = (amount: number | null, known: number): number =>
  amount ?? known;

/**
 * The response's hub-centred links in the shape recharts' `Sankey` reads --
 * nodes in an array, links by index -- with each column's smallest categories
 * beyond `maxNodesPerColumn` merged into one "Other" node.
 *
 * Pure, and over a copy: the response is never mutated, so the figures the
 * table and the cards read are the server's whole answer. A link whose amount
 * is unknown is drawn at its known part and flagged; a node with nothing
 * drawable to it is left out of the drawing (the table still lists it).
 *
 * A merged link and an "Other" node are sums of the server's figures, which
 * arrive at the reporting currency's places, apportioned so a side's parts add
 * up to it (`docs/specs/report-rounding-and-aggregation.md` rule 6). They are
 * summed exactly at those places, never in floats: 0.1 + 0.2 is
 * 0.30000000000000004. They are presentation only, on the tooltip and the
 * band; no total, card, table or export reads them (INV-SANKEY-005).
 */
export function toRechartsSankey(
  response: CashFlowSankeyResponse,
  options: SankeyLayoutOptions,
): SankeyDrawing {
  const max = options.maxNodesPerColumn ?? MAX_NODES_PER_COLUMN;
  const places = getDecimalPlacesForCurrency(response.currency);
  const byId = new Map(response.nodes.map((node) => [node.id, node]));

  // A child -> parent link is a net refund. Drawn as the response has it, the
  // child would sit in the first column beside the income sources, and merged
  // into "Other" beside a sibling it would make a two-link cycle recharts'
  // depth walk recurses on forever. It is drawn parent -> child, flagged.
  const oriented = response.links.map((link) => {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    const reversed =
      source?.kind === 'child' && target !== undefined && target.kind !== 'child' && target.kind !== 'account';
    return reversed
      ? { ...link, source: link.target, target: link.source, netRefund: true }
      : { ...link, netRefund: false };
  });

  // A link is drawn when it carries something, or when its figure is unknown:
  // a known zero moved nothing, an unknown one may have moved anything.
  const isDrawn = (link: { amount: number | null; knownAmount: number }) =>
    link.amount === null || link.amount > 0;
  // An unknown link with no converted part is drawn as a sliver of the widest
  // known link, so the node it reaches is on the page.
  const widest = response.links.reduce(
    (max, link) => Math.max(max, drawnAmount(link.amount, link.knownAmount)),
    0,
  );
  const placeholderValue = widest > 0 ? widest * 0.02 : 1;

  // The nodes some drawable link touches; the rest have nothing to draw.
  const drawable = new Set<string>();
  // A net-refund child keeps its own node, so its marker means something.
  const keepOwnNode = new Set<string>();
  for (const link of oriented) {
    if (!isDrawn(link)) continue;
    drawable.add(link.source);
    drawable.add(link.target);
    if (link.netRefund) keepOwnNode.add(link.target);
  }

  // Per column, which categories keep their own node.
  const merged = new Map<string, SankeyColumn>();
  const columns = new Map<SankeyColumn, CashFlowSankeyNode[]>();
  for (const node of response.nodes) {
    if (!MERGEABLE.has(node.kind) || !drawable.has(node.id) || keepOwnNode.has(node.id) || node.expenseRefund) continue;
    const column = columnOf(node);
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  for (const [column, nodes] of columns) {
    if (nodes.length <= max) continue;
    const ranked = [...nodes].sort(
      (a, b) =>
        drawnAmount(b.total, b.knownTotal) - drawnAmount(a.total, a.knownTotal) ||
        a.id.localeCompare(b.id),
    );
    for (const node of ranked.slice(max)) merged.set(node.id, column);
  }

  const drawNodes: SankeyDrawNode[] = [];
  const indexOf = new Map<string, number>();
  const otherIndex = new Map<SankeyColumn, number>();

  const indexFor = (id: string): number | undefined => {
    const column = merged.get(id);
    if (column !== undefined) {
      const existing = otherIndex.get(column);
      if (existing !== undefined) return existing;
      const index = drawNodes.length;
      drawNodes.push({
        name: options.otherLabel,
        id: `other:${column}`,
        kind: 'other',
        column,
        color: options.otherColor,
        node: null,
        members: [],
        value: 0,
        unknown: false,
      });
      otherIndex.set(column, index);
      return index;
    }
    const existing = indexOf.get(id);
    if (existing !== undefined) return existing;
    const node = byId.get(id);
    if (!node) return undefined;
    const index = drawNodes.length;
    drawNodes.push({
      name: options.labelFor(node),
      id: node.id,
      kind: node.kind,
      column: columnOf(node),
      color: node.color,
      node,
      members: [],
      value: drawnAmount(node.total, node.knownTotal),
      unknown: node.total === null,
    });
    indexOf.set(id, index);
    return index;
  };

  // Links in response order, with each merged endpoint redirected to its
  // column's "Other" and two links between the same pair drawn as one. A link
  // that would close a cycle is not drawn: recharts lays columns out by
  // walking the links and has no cycle check.
  const drawLinks: SankeyDrawLink[] = [];
  const linkAt = new Map<string, number>();
  const targetsOf = new Map<number, number[]>();
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(targetsOf.get(at) ?? []));
    }
    return false;
  };
  for (const link of oriented) {
    if (!isDrawn(link)) continue;
    // The known part only; a sliver is added below to a link that has none.
    const value = Math.max(drawnAmount(link.amount, link.knownAmount), 0);
    const source = indexFor(link.source);
    const target = indexFor(link.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const key = `${source}->${target}`;
    const at = linkAt.get(key);
    const incomplete = link.amount === null;
    if (at === undefined) {
      if (reaches(target, source)) continue;
      linkAt.set(key, drawLinks.length);
      targetsOf.set(source, [...(targetsOf.get(source) ?? []), target]);
      drawLinks.push({ source, target, value, incomplete, netRefund: link.netRefund, placeholder: false });
    } else {
      const previous = drawLinks[at];
      drawLinks[at] = {
        ...previous,
        value: sumMoney([previous.value, value], places),
        incomplete: previous.incomplete || incomplete,
        netRefund: previous.netRefund || link.netRefund,
      };
    }
  }

  const sized = drawLinks.map((link) =>
    link.value > 0 ? link : { ...link, value: placeholderValue, placeholder: true },
  );

  // Each "Other" lists what it holds, largest first, and is unknown when any
  // member is.
  const finished = drawNodes.map((drawNode) => {
    if (drawNode.kind !== 'other') return drawNode;
    const members = response.nodes
      .filter((node) => merged.get(node.id) === drawNode.column)
      .sort(
        (a, b) =>
          drawnAmount(b.total, b.knownTotal) - drawnAmount(a.total, a.knownTotal),
      );
    return {
      ...drawNode,
      members: members.map((node) => options.labelFor(node)),
      value: sumMoney(
        members.map((node) => drawnAmount(node.total, node.knownTotal)),
        places,
      ),
      unknown: members.some((node) => node.total === null),
    };
  });

  return { nodes: finished, links: sized };
}
