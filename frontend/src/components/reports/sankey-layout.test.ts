import { describe, it, expect } from 'vitest';
import type {
  CashFlowSankeyLink,
  CashFlowSankeyNode,
  CashFlowSankeyResponse,
} from '@/types/built-in-reports';
import { MAX_NODES_PER_COLUMN, columnOf, toRechartsSankey } from './sankey-layout';

function node(id: string, total: number | null, overrides: Partial<CashFlowSankeyNode> = {}): CashFlowSankeyNode {
  const [kind] = id.split(':');
  return {
    id,
    kind: (kind === 'hub' ? 'hub' : kind) as CashFlowSankeyNode['kind'],
    label: id,
    categoryId: null,
    parentCategoryId: null,
    accountId: null,
    color: null,
    total,
    knownTotal: total ?? 0,
    ...overrides,
  };
}

function link(source: string, target: string, amount: number | null, knownAmount = amount ?? 0): CashFlowSankeyLink {
  return { source, target, amount, knownAmount };
}

function response(nodes: CashFlowSankeyNode[], links: CashFlowSankeyLink[]): CashFlowSankeyResponse {
  return {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    currency: 'CAD',
    scopeAccountIds: [],
    nodes,
    links,
    totals: { income: 0, inflows: 0, expenses: 0, outflows: 0, unspent: 0, deficit: 0 },
    knownTotals: { income: 0, inflows: 0, expenses: 0, outflows: 0 },
    missingCurrencies: [],
    excludedCount: 0,
  };
}

/** Freezes the response all the way down, so a mutation throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const OPTIONS = {
  labelFor: (n: CashFlowSankeyNode) => n.label,
  otherLabel: 'Other',
  otherColor: 'neutral',
};

/** Income 1,000 split across fourteen expense categories of falling size. */
function fourteenCategories(): CashFlowSankeyResponse {
  const amounts = Array.from({ length: 14 }, (_, i) => 140 - i * 10);
  const expenses = amounts.map((amount, i) => node(`expense:c${i}`, amount));
  return response(
    [node('income:salary', 1050), node('hub', 1050), ...expenses],
    [
      link('income:salary', 'hub', 1050),
      ...expenses.map((e) => link('hub', e.id, e.total)),
    ],
  );
}

describe('toRechartsSankey', () => {
  it('maps hub-centred links to recharts index references', () => {
    const drawing = toRechartsSankey(
      response(
        [node('income:salary', 100), node('hub', 100), node('expense:food', 60), node('residual:unspent', 40)],
        [link('income:salary', 'hub', 100), link('hub', 'expense:food', 60), link('hub', 'residual:unspent', 40)],
      ),
      OPTIONS,
    );

    const name = (index: number) => drawing.nodes[index].id;
    expect(drawing.links.map((l) => [name(l.source), name(l.target), l.value])).toEqual([
      ['income:salary', 'hub', 100],
      ['hub', 'expense:food', 60],
      ['hub', 'residual:unspent', 40],
    ]);
    expect(drawing.nodes.map((n) => n.name)).toEqual(['income:salary', 'hub', 'expense:food', 'residual:unspent']);
  });

  it(`merges past ${MAX_NODES_PER_COLUMN} categories into one Other node for the drawing (SANKEY-005)`, () => {
    const source = deepFreeze(fourteenCategories());

    const drawing = toRechartsSankey(source, OPTIONS);

    const expenses = drawing.nodes.filter((n) => n.column === 'destination');
    expect(expenses).toHaveLength(MAX_NODES_PER_COLUMN + 1);
    const other = drawing.nodes.find((n) => n.kind === 'other')!;
    expect(other.name).toBe('Other');
    expect(other.color).toBe('neutral');
    // The four smallest, largest first.
    expect(other.members).toEqual(['expense:c10', 'expense:c11', 'expense:c12', 'expense:c13']);
    expect(other.value).toBe(40 + 30 + 20 + 10);
    // The full response is untouched: fourteen categories, every figure.
    expect(source.nodes.filter((n) => n.kind === 'expense')).toHaveLength(14);
    // The drawn links still carry everything that left the hub.
    const hubIndex = drawing.nodes.findIndex((n) => n.id === 'hub');
    const drawnOut = drawing.links.filter((l) => l.source === hubIndex).map((l) => l.value);
    expect(drawnOut.reduce((a, b) => a + b, 0)).toBe(1050);
  });

  it('keeps a smaller expense refund identifiable in the merged source tooltip', () => {
    const salary = node('income:salary', 500);
    const refund = node('income:food', 50, { label: 'Food', expenseRefund: true });
    const drawing = toRechartsSankey(
      response(
        [salary, refund, node('hub', 550)],
        [link(salary.id, 'hub', 500), link(refund.id, 'hub', 50)],
      ),
      {
        ...OPTIONS,
        maxNodesPerColumn: 1,
        labelFor: (n) => n.expenseRefund ? `${n.label} (expense refund)` : n.label,
      },
    );
    expect(drawing.nodes.find((n) => n.kind === 'other')).toMatchObject({
      value: 50, members: ['Food (expense refund)'],
    });
  });

  it('merges nothing at or under the limit', () => {
    const drawing = toRechartsSankey(fourteenCategories(), { ...OPTIONS, maxNodesPerColumn: 14 });
    expect(drawing.nodes.some((n) => n.kind === 'other')).toBe(false);
  });

  it('never merges a destination class or the residual', () => {
    const fixed = response(
      [
        node('income:a', 30),
        node('hub', 30),
        node('expense:x', 5),
        node('expense:y', 4),
        node('class:savings', 1),
        node('residual:unspent', 20),
      ],
      [
        link('income:a', 'hub', 30),
        link('hub', 'expense:x', 5),
        link('hub', 'expense:y', 4),
        link('hub', 'class:savings', 1),
        link('hub', 'residual:unspent', 20),
      ],
    );

    const drawing = toRechartsSankey(fixed, { ...OPTIONS, maxNodesPerColumn: 1 });

    const ids = drawing.nodes.map((n) => n.id);
    expect(ids).toContain('class:savings');
    expect(ids).toContain('residual:unspent');
    expect(ids).toContain('expense:x');
    expect(ids).not.toContain('expense:y');
    expect(drawing.nodes.find((n) => n.kind === 'other')?.members).toEqual(['expense:y']);
  });

  it('draws an unknown link at its known part and flags it', () => {
    const drawing = toRechartsSankey(
      response(
        [node('income:a', 100), node('hub', null), node('expense:usd', null, { knownTotal: 7 })],
        [link('income:a', 'hub', 100), link('hub', 'expense:usd', null, 7)],
      ),
      OPTIONS,
    );

    const usd = drawing.links.find((l) => drawing.nodes[l.target].id === 'expense:usd')!;
    expect(usd.value).toBe(7);
    expect(usd.incomplete).toBe(true);
    expect(drawing.nodes.find((n) => n.id === 'expense:usd')?.unknown).toBe(true);
  });

  it('leaves out a known zero, but draws an unknown figure as a flagged sliver', () => {
    const drawing = toRechartsSankey(
      response(
        [node('income:a', 10), node('hub', 10), node('expense:b', 10), node('expense:zero', 0), node('residual:unspent', null)],
        [link('income:a', 'hub', 10), link('hub', 'expense:b', 10), link('hub', 'residual:unspent', null, 0)],
      ),
      OPTIONS,
    );

    // A known zero moved nothing; the unknown residual is drawn (hollow).
    expect(drawing.nodes.map((n) => n.id)).toEqual(['income:a', 'hub', 'expense:b', 'residual:unspent']);
    expect(drawing.nodes.find((n) => n.id === 'residual:unspent')?.unknown).toBe(true);
    const residual = drawing.links.find((l) => drawing.nodes[l.target].id === 'residual:unspent')!;
    expect(residual.placeholder).toBe(true);
    expect(residual.incomplete).toBe(true);
    expect(residual.value).toBeCloseTo(0.2);
    expect(drawing.links.filter((l) => l.placeholder)).toHaveLength(1);
  });

  it('gives no sliver to a merged link that carries a known part', () => {
    const expenses = Array.from({ length: 3 }, (_, i) => node(`expense:c${i}`, 10 - i));
    const drawing = toRechartsSankey(
      response(
        [node('income:a', 30), node('hub', null), ...expenses, node('expense:usd', null)],
        [
          link('income:a', 'hub', 30),
          ...expenses.map((e) => link('hub', e.id, e.total)),
          link('hub', 'expense:usd', null, 0),
        ],
      ),
      { ...OPTIONS, maxNodesPerColumn: 2 },
    );

    const other = drawing.nodes.findIndex((n) => n.id === 'other:destination');
    const intoOther = drawing.links.find((l) => l.target === other)!;
    expect(intoOther.value).toBe(8);
    expect(intoOther.placeholder).toBe(false);
    expect(intoOther.incomplete).toBe(true);
    expect(drawing.nodes[other].unknown).toBe(true);
  });

  it('merges children of several parents into the child column Other, one link per parent', () => {
    const children = Array.from({ length: 4 }, (_, i) => node(`child:k${i}`, 10 - i));
    const drawing = toRechartsSankey(
      response(
        [node('income:a', 34), node('hub', 34), node('expense:p', 19), node('expense:q', 15), ...children],
        [
          link('income:a', 'hub', 34),
          link('hub', 'expense:p', 19),
          link('hub', 'expense:q', 15),
          link('expense:p', 'child:k0', 10),
          link('expense:p', 'child:k1', 9),
          link('expense:q', 'child:k2', 8),
          link('expense:q', 'child:k3', 7),
        ],
      ),
      { ...OPTIONS, maxNodesPerColumn: 2 },
    );

    const other = drawing.nodes.findIndex((n) => n.id === 'other:child');
    const intoOther = drawing.links.filter((l) => l.target === other);
    expect(intoOther.map((l) => [drawing.nodes[l.source].id, l.value])).toEqual([['expense:q', 15]]);
  });
});

// The merged figures are the server's apportioned parts added up; in floats
// 0.1 + 0.2 drew 0.30000000000000004 (issue #2413).
describe('toRechartsSankey merged figures', () => {
  function smallCategories(): CashFlowSankeyResponse {
    // Ten categories of 10 keep their nodes; 0.1 and 0.2 merge into Other.
    const kept = Array.from({ length: MAX_NODES_PER_COLUMN }, (_, i) => node(`expense:k${i}`, 10));
    const small = [node('expense:a', 0.1), node('expense:b', 0.2)];
    return response(
      [node('income:salary', 100.3), node('hub', 100.3), ...kept, ...small],
      [
        link('income:salary', 'hub', 100.3),
        ...[...kept, ...small].map((e) => link('hub', e.id, e.total)),
      ],
    );
  }

  it("adds the Other node's members at the currency's places", () => {
    const drawing = toRechartsSankey(smallCategories(), OPTIONS);
    const other = drawing.nodes.find((n) => n.kind === 'other');
    expect(other?.value).toBe(0.3);
  });

  it('adds the links merged into one at the currency\'s places', () => {
    const drawing = toRechartsSankey(smallCategories(), OPTIONS);
    const otherIndex = drawing.nodes.findIndex((n) => n.kind === 'other');
    const merged = drawing.links.filter((l) => l.target === otherIndex);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe(0.3);
  });
});

describe('toRechartsSankey with a net-refund subcategory', () => {
  /** True when the drawn links hold no cycle, which recharts cannot lay out. */
  function acyclic(links: Array<{ source: number; target: number }>): boolean {
    const out = new Map<number, number[]>();
    for (const l of links) out.set(l.source, [...(out.get(l.source) ?? []), l.target]);
    const state = new Map<number, 'open' | 'done'>();
    const visit = (n: number): boolean => {
      if (state.get(n) === 'done') return true;
      if (state.get(n) === 'open') return false;
      state.set(n, 'open');
      const ok = (out.get(n) ?? []).every(visit);
      state.set(n, 'done');
      return ok;
    };
    return [...out.keys()].every(visit);
  }

  /**
   * Parent B nets to 40 of spending: twelve children spend 5 each (60) and
   * one, Rebates, takes in 20 more than it spent, so the response links it
   * INTO B. Thirteen children overflow the child column.
   */
  function refundBeyondTheLimit(): CashFlowSankeyResponse {
    const spenders = Array.from({ length: 12 }, (_, i) => node(`child:s${i}`, 5));
    return response(
      [node('income:a', 40), node('hub', 40), node('expense:b', 40), ...spenders, node('child:rebates', 20)],
      [
        link('income:a', 'hub', 40),
        link('hub', 'expense:b', 40),
        ...spenders.map((c) => link('expense:b', c.id, 5)),
        link('child:rebates', 'expense:b', 20),
      ],
    );
  }

  it('draws the refund parent -> child, flagged, and never as a cycle', () => {
    const drawing = toRechartsSankey(deepFreeze(refundBeyondTheLimit()), OPTIONS);

    expect(acyclic(drawing.links)).toBe(true);
    const id = (i: number) => drawing.nodes[i].id;
    const refund = drawing.links.find((l) => id(l.target) === 'child:rebates')!;
    expect(id(refund.source)).toBe('expense:b');
    expect(refund.netRefund).toBe(true);
    expect(refund.value).toBe(20);
    // Kept out of the merge, so its marker means something, and drawn in the
    // child column rather than beside the income sources.
    expect(drawing.nodes.find((n) => n.id === 'child:rebates')?.column).toBe('child');
    expect(drawing.nodes.find((n) => n.id === 'other:child')?.members).not.toContain('child:rebates');
    expect(drawing.links.filter((l) => l.netRefund)).toHaveLength(1);
  });

  it('drops a link that would close a cycle, whatever produced it', () => {
    const drawing = toRechartsSankey(
      response(
        [node('income:a', 10), node('hub', 10), node('class:b', 10), node('account:c', 10)],
        [
          link('income:a', 'hub', 10),
          link('hub', 'class:b', 10),
          link('class:b', 'account:c', 10),
          link('account:c', 'class:b', 10),
        ],
      ),
      OPTIONS,
    );

    expect(acyclic(drawing.links)).toBe(true);
    expect(drawing.links).toHaveLength(3);
  });
});

describe('columnOf', () => {
  it.each([
    ['income:a', 'source'],
    ['inflow:savings', 'source'],
    ['uncategorized:income', 'source'],
    ['residual:deficit', 'source'],
    ['hub', 'hub'],
    ['expense:a', 'destination'],
    ['class:debt', 'destination'],
    ['uncategorized:expense', 'destination'],
    ['residual:unspent', 'destination'],
    ['child:a', 'child'],
    ['account:a', 'child'],
  ])('draws %s in the %s column', (id, column) => {
    expect(columnOf(node(id, 1))).toBe(column);
  });
});
