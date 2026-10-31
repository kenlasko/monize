'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ResponsiveContainer, Sankey, Tooltip } from 'recharts';
import { buildCategoryColorMap, type SpecialCategoryFilterId } from '@/lib/categoryUtils';
import { buildTransactionsHref } from '@/lib/transactions-href';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ChartTooltip } from '@/components/reports/ChartTooltip';
import {
  toRechartsSankey,
  type SankeyDrawLink,
  type SankeyDrawNode,
} from '@/components/reports/sankey-layout';
import { fitSankeyLabel } from '@/components/reports/sankey-label';
import type { Category } from '@/types/category';
import type { CashFlowSankeyNode, CashFlowSankeyResponse } from '@/types/built-in-reports';

/**
 * What the Cash Flow Sankey report and its dashboard widget draw alike: the
 * node and link renderers, the tooltip, each node's label, colour and
 * drill-down. Every figure here is the server's; the "Other" merge in
 * `sankey-layout.ts` is drawing only (SANKEY-005).
 */

const UNCATEGORIZED: SpecialCategoryFilterId = 'uncategorized';
const TRANSFER: SpecialCategoryFilterId = 'transfer';

/** The catalog key of each node that is neither a category nor an account. */
const FIXED_NODE_KEYS: Record<string, string> = {
  hub: 'hub',
  "class:shared_settlements": "classSharedSettlements",
  "inflow:shared_settlements": "inflowSharedSettlements",
  'class:savings': 'classSavings',
  'class:debt': 'classDebt',
  'class:other_accounts': 'classOtherAccounts',
  'inflow:savings': 'inflowSavings',
  'inflow:borrowed': 'inflowBorrowed',
  'inflow:other_accounts': 'inflowOtherAccounts',
  'uncategorized:income': 'uncategorizedIncome',
  'uncategorized:expense': 'uncategorizedExpense',
  'residual:unspent': 'residualUnspent',
  'residual:deficit': 'residualDeficit',
  'account:unlinked': 'unlinkedAccount',
};

/** Which side of the hub a node is on, for a table and the CSV. */
export type FlowSide = 'in' | 'out' | 'detail';

export function sideOf(node: CashFlowSankeyNode): FlowSide {
  if (node.kind === 'child' || node.kind === 'account') return 'detail';
  if (
    node.kind === 'income' ||
    node.kind === 'inflow' ||
    node.id === 'uncategorized:income' ||
    node.id === 'residual:deficit'
  ) {
    return 'in';
  }
  return 'out';
}

const SIDE_ORDER: Record<FlowSide, number> = { in: 0, out: 1, detail: 2 };

export interface SankeyTableRow {
  node: CashFlowSankeyNode;
  side: FlowSide;
  /** The parent a depth-2 child or a class's account sits under. */
  parent: CashFlowSankeyNode | undefined;
}

/** Every node but the hub, unmerged, in the server's order within each side. */
export function sankeyTableRows(data: CashFlowSankeyResponse): SankeyTableRow[] {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();
  for (const link of data.links) {
    const target = byId.get(link.target);
    const source = byId.get(link.source);
    if (target && (target.kind === 'child' || target.kind === 'account')) parentOf.set(target.id, link.source);
    if (source && source.kind === 'child') parentOf.set(source.id, link.target);
  }
  return data.nodes
    .filter((node) => node.kind !== 'hub')
    .map((node, order) => ({ node, order, side: sideOf(node), parent: byId.get(parentOf.get(node.id) ?? '') }))
    .sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.order - b.order)
    .map(({ node, side, parent }) => ({ node, side, parent }));
}

/**
 * Where a node drills down to, or `null` for the hub, the residual and a
 * merged "Other", which are arithmetic rather than rows anyone can list.
 */
export function sankeyNodeHref(
  node: CashFlowSankeyNode,
  response: CashFlowSankeyResponse,
): string | null {
  const range = { startDate: response.startDate, endDate: response.endDate };
  const scope = { ...range, accountIds: response.scopeAccountIds };
  switch (node.kind) {
    case 'income':
    case 'expense':
      return node.categoryId ? buildTransactionsHref({ ...scope, categoryId: node.categoryId }) : null;
    case 'child':
      // "(no subcategory)" is the parent's own rows, and the Transactions
      // filter cannot ask for a category without its descendants, so it
      // would list the whole parent under a node that is only part of it.
      if (!node.categoryId || node.categoryId === node.parentCategoryId) return null;
      return buildTransactionsHref({ ...scope, categoryId: node.categoryId });
    case 'uncategorized':
      return buildTransactionsHref({ ...scope, categoryId: UNCATEGORIZED });
    case 'class':
    case 'inflow':
      return buildTransactionsHref({ ...scope, categoryId: TRANSFER });
    case 'account':
      return node.accountId
        ? buildTransactionsHref({ ...range, accountIds: [node.accountId], categoryId: TRANSFER })
        : null;
    default:
      return null;
  }
}

/** Labels and colours for the nodes, from the reader's catalog and categories. */
export function useSankeyNodePresentation(categories: Category[] | null | undefined) {
  const t = useTranslations('reports');
  const categoryColors = useMemo(() => buildCategoryColorMap(categories ?? []), [categories]);

  const labelFor = (node: CashFlowSankeyNode): string => {
    if (node.kind === 'child' && node.categoryId === node.parentCategoryId) {
      return t('sankey.noSubcategory');
    }
    const key = FIXED_NODE_KEYS[node.id];
    return key ? t(`sankey.nodes.${key}`) : node.label;
  };

  const colorOfNode = (node: CashFlowSankeyNode): string => {
    const own = node.categoryId ? (categoryColors.get(node.categoryId) ?? node.color) : node.color;
    switch (node.kind) {
      case 'income':
      case 'expense':
      case 'child':
        return own ?? (sideOf(node) === 'in' ? chartColors.income : chartColors.expense);
      case 'inflow':
        return chartColors.income;
      case 'uncategorized':
        return node.id === 'uncategorized:income' ? chartColors.income : chartColors.expense;
      case 'class':
      case 'account':
      case 'hub':
        return chartColors.primary;
      default:
        return chartColors.neutral;
    }
  };

  return { labelFor, colorOfNode };
}

interface NodeShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: SankeyDrawNode;
  colorFor: (node: SankeyDrawNode) => string;
  onSelect: (node: SankeyDrawNode) => void;
  canSelect: (node: SankeyDrawNode) => boolean;
  unknownLabel: string;
  fontSize?: number;
  /** Widest a label may be: the gutter it is drawn in. Unbounded when omitted. */
  maxLabelWidth?: number;
}

/** Space kept between a node and its label. */
const LABEL_GAP = 6;

/**
 * One node: a bar in its colour (hollow when its figure is unknown) and its
 * label beside it, on the side that faces away from the hub, cut to
 * `maxLabelWidth` so it cannot run past the chart's edge. The hub carries no
 * label: it is where every flow meets, not a category, and a name drawn across
 * the bands beside it read as one more line of income.
 */
export function SankeyNodeShape({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  payload,
  colorFor,
  onSelect,
  canSelect,
  unknownLabel,
  fontSize = 12,
  maxLabelWidth,
}: NodeShapeProps) {
  if (!payload) return null;
  const color = colorFor(payload);
  const selectable = canSelect(payload);
  const labelLeft = payload.column === 'source';
  const fullLabel =
    payload.unknown && payload.node?.kind === 'residual' ? `${payload.name} (${unknownLabel})` : payload.name;
  const label =
    payload.column === 'hub'
      ? ''
      : maxLabelWidth === undefined
        ? fullLabel
        : fitSankeyLabel(fullLabel, maxLabelWidth, fontSize);
  return (
    // A pointer target only. The diagram is one `role="img"` whose children
    // are presentational, so a focusable link here would be a tab stop no
    // screen reader can name; the legend's buttons and the table's rows are
    // the keyboard and assistive-technology routes to the same drill-down.
    <g
      data-testid={`sankey-node-${payload.id}`}
      data-drillable={selectable ? 'true' : undefined}
      onClick={selectable ? () => onSelect(payload) : undefined}
      className={selectable ? 'cursor-pointer' : undefined}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={Math.max(height, 1)}
        fill={payload.unknown ? chartColors.surface : color}
        stroke={color}
        strokeDasharray={payload.unknown ? '3 2' : undefined}
      />
      {label && (
        <text
          x={labelLeft ? x - LABEL_GAP : x + width + LABEL_GAP}
          y={y + height / 2}
          textAnchor={labelLeft ? 'end' : 'start'}
          dominantBaseline="middle"
          fontSize={fontSize}
          fill={chartColors.axis}
        >
          {label}
        </text>
      )}
    </g>
  );
}

interface LinkShapeProps {
  sourceX?: number;
  targetX?: number;
  sourceY?: number;
  targetY?: number;
  sourceControlX?: number;
  targetControlX?: number;
  linkWidth?: number;
  payload?: { source?: SankeyDrawNode; target?: SankeyDrawNode } & Partial<SankeyDrawLink>;
  colorFor: (node: SankeyDrawNode) => string;
}

/** One link: a band in its source's colour, dashed when only partly known. */
export function SankeyLinkShape({
  sourceX = 0,
  targetX = 0,
  sourceY = 0,
  targetY = 0,
  sourceControlX = 0,
  targetControlX = 0,
  linkWidth = 0,
  payload,
  colorFor,
}: LinkShapeProps) {
  const from = payload?.source?.kind === 'hub' ? payload?.target : payload?.source;
  const color = from ? colorFor(from) : chartColors.neutral;
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeOpacity={0.35}
      strokeWidth={Math.max(linkWidth, 1)}
      strokeDasharray={payload?.incomplete ? '6 4' : payload?.netRefund ? '2 3' : undefined}
    />
  );
}

/** A hovered link: its two ends (recharts' laid-out nodes) and its flags. */
export interface SankeyTooltipLink {
  type: 'link';
  source: SankeyDrawNode;
  target: SankeyDrawNode;
  value: number;
  incomplete: boolean;
  netRefund: boolean;
  placeholder: boolean;
}

export interface SankeyTooltipNode {
  type: 'node';
  node: SankeyDrawNode;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The hovered link or node, from one recharts tooltip entry.
 *
 * recharts 3 wraps the Sankey's item once more than its other charts do: an
 * entry's `payload` is `{ payload, name, value }`, and the link's or node's
 * own data is the INNER `payload`. Reading the outer object as a node is what
 * crashed the report (`members` undefined). So the entry is read by shape,
 * descending through `payload` until a link or a node is found, and anything
 * that is neither is no tooltip rather than a crash.
 */
export function sankeyTooltipItem(entry: unknown): SankeyTooltipLink | SankeyTooltipNode | null {
  let item: unknown = entry;
  for (let depth = 0; depth < 3 && isObject(item); depth += 1) {
    const found = sankeyItemOf(item);
    if (found) return found;
    item = item.payload;
  }
  return null;
}

function sankeyItemOf(item: Record<string, unknown>): SankeyTooltipLink | SankeyTooltipNode | null {
  if (isObject(item.source) && isObject(item.target)) {
    return {
      type: 'link',
      source: item.source as unknown as SankeyDrawNode,
      target: item.target as unknown as SankeyDrawNode,
      value: typeof item.value === 'number' ? item.value : 0,
      incomplete: item.incomplete === true,
      netRefund: item.netRefund === true,
      placeholder: item.placeholder === true,
    };
  }
  if (Array.isArray(item.members) && typeof item.name === 'string') {
    return { type: 'node', node: item as unknown as SankeyDrawNode };
  }
  return null;
}

interface CashFlowSankeyDiagramProps {
  data: CashFlowSankeyResponse;
  categories: Category[] | null | undefined;
  /** The accessible name: the diagram is one image that states its totals. */
  ariaLabel: string;
  onOpen: (node: CashFlowSankeyNode) => void;
  heightClass: string;
  /** Room either side for the node labels; a longer label is cut to fit it. */
  labelMargin: number;
  fontSize?: number;
}

/** The recharts Sankey with this report's renderers and tooltip. */
export function CashFlowSankeyDiagram({
  data,
  categories,
  ariaLabel,
  onOpen,
  heightClass,
  labelMargin,
  fontSize,
}: CashFlowSankeyDiagramProps) {
  const t = useTranslations('reports');
  const { formatCurrency } = useNumberFormat();
  const { labelFor, colorOfNode } = useSankeyNodePresentation(categories);
  const colorOfDrawn = (drawn: SankeyDrawNode): string =>
    drawn.node ? colorOfNode(drawn.node) : chartColors.neutral;

  // Drawing only: the merge works on a copy (SANKEY-005).
  const drawing = toRechartsSankey(data, {
    labelFor,
    otherLabel: t('sankey.other'),
    otherColor: chartColors.neutral,
  });

  const tooltip = ({ active, payload }: { active?: boolean; payload?: ReadonlyArray<unknown> }) => {
    const item = active ? sankeyTooltipItem(payload?.[0]) : null;
    if (!item) return null;
    if (item.type === 'link') {
      return (
        <ChartTooltip
          active
          label={t('sankey.linkLabel', { source: item.source.name, target: item.target.name })}
          payload={[{ name: t('sankey.colAmount'), value: item.value, color: colorOfDrawn(item.source.kind === 'hub' ? item.target : item.source) }]}
          // A sliver drawn for a link nothing of which converted is not a figure.
          formatValue={(value) => (item.placeholder ? t('sankey.unknown') : formatCurrency(value))}
        >
          {item.netRefund && ( <p className="text-xs text-gray-600 dark:text-gray-400">
              {t('sankey.netRefund')}
            </p>
          )}
          {item.incomplete && ( <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('sankey.knownPartOnly')}
            </p>
          )}
        </ChartTooltip>
      );
    }
    const drawn = item.node;
    return (
      <ChartTooltip
        active
        label={drawn.name}
        payload={[{ name: t('sankey.colAmount'), value: drawn.value, color: colorOfDrawn(drawn) }]}
        formatValue={(value) => formatCurrency(value)}
      >
        {drawn.unknown && ( <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('sankey.knownPartOnly')}
          </p>
        )}
        {drawn.members.length > 0 && (
          <ul className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            {drawn.members.map((member) => (
              <li key={member}>{member}</li>
            ))}
          </ul>
        )}
      </ChartTooltip>
    );
  };

  return (
    <div role="img" aria-label={ariaLabel} className={heightClass}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <Sankey
          data={drawing}
          nodePadding={16}
          nodeWidth={12}
          margin={{ top: 10, right: labelMargin, bottom: 10, left: labelMargin }}
          node={(props: object) => (
            <SankeyNodeShape
              {...(props as Omit<NodeShapeProps, 'colorFor' | 'onSelect' | 'canSelect' | 'unknownLabel'>)}
              colorFor={colorOfDrawn}
              onSelect={(drawn) => drawn.node && onOpen(drawn.node)}
              canSelect={(drawn) => !!drawn.node && sankeyNodeHref(drawn.node, data) !== null}
              unknownLabel={t('sankey.unknown')}
              fontSize={fontSize}
              // The outer columns' labels sit in the side margins; the
              // middle ones get the same width so no label is cut differently.
              maxLabelWidth={labelMargin - LABEL_GAP - 2}
            />
          )}
          link={(props: object) => (
            <SankeyLinkShape {...(props as Omit<LinkShapeProps, 'colorFor'>)} colorFor={colorOfDrawn} />
          )}
        >
          <Tooltip content={tooltip} />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}
