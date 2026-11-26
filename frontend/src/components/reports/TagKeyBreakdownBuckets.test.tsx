import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { render } from '@/test/render';
import { TagKeyBreakdownBuckets } from './TagKeyBreakdownBuckets';
import { UNTAGGED_TAG_BUCKET_ID, type IncomeExpenseTagBucket } from '@/types/built-in-reports';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ dataKey }: any) => <div data-testid={`bar-${dataKey}`} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
}));

function bucket(overrides: Partial<IncomeExpenseTagBucket> = {}): IncomeExpenseTagBucket {
  return {
    value: 'household',
    isUntagged: false,
    data: [
      {
        period: '2024-01',
        periodStart: '2024-01-01',
        periodEnd: '2024-01-31',
        income: 500,
        expenses: 200,
        net: 300,
        taggedInflows: 1000,
        taggedOutflows: 800,
      },
    ],
    totals: { income: 500, expenses: 200, net: 300, knownIncome: 500, knownExpenses: 200, knownNet: 300 },
    taggedInflows: 1000,
    taggedOutflows: 800,
    missingCurrencies: [],
    excludedCount: 0,
    ...overrides,
  };
}

describe('TagKeyBreakdownBuckets', () => {
  it('renders one tab per value bucket plus the untagged bucket, labelled from i18n', () => {
    const buckets = [
      bucket({ value: 'household' }),
      bucket({ value: UNTAGGED_TAG_BUCKET_ID, isUntagged: true, taggedInflows: 0, taggedOutflows: 0 }),
    ];
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={buckets}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );

    expect(screen.getByRole('tab', { name: 'household' })).toBeInTheDocument();
    // Rendered from i18n, never the raw sentinel id.
    expect(screen.getByRole('tab', { name: 'Untagged' })).toBeInTheDocument();
    expect(screen.queryByText(UNTAGGED_TAG_BUCKET_ID)).toBeNull();
  });

  it('renders tagged inflows/outflows as a distinct labelled pair, not income bars', () => {
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={[bucket()]}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );

    const taggedFlows = screen.getByTestId('tagged-flows');
    expect(taggedFlows).toHaveTextContent('Tagged inflows');
    expect(taggedFlows).toHaveTextContent('$1000');
    expect(taggedFlows).toHaveTextContent('Tagged outflows');
    expect(taggedFlows).toHaveTextContent('$800');
    // Never labelled as income/expenses, which would let a transfer read as one.
    expect(taggedFlows).not.toHaveTextContent('Total Income');
    expect(taggedFlows).not.toHaveTextContent('Total Expenses');
  });

  it('discloses that per-value shares can exceed 100%', () => {
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={[bucket()]}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );
    expect(
      screen.getByText(/per-value shares can add up to more than 100%/i),
    ).toBeInTheDocument();
  });

  it('marks an incomplete bucket with the missing-rate treatment', () => {
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={[bucket({ missingCurrencies: ['JPY'], excludedCount: 1 })]}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );
    expect(screen.getAllByTestId('partial-total').length).toBeGreaterThan(0);
  });

  it('does not mark a complete bucket', () => {
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={[bucket()]}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );
    expect(screen.queryByTestId('partial-total')).toBeNull();
  });

  it('notes the estimated amounts inside the tagged flows, under the pair', () => {
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={[bucket({ provisionalCount: 1 })]}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );
    const flows = screen.getByTestId('tagged-flows');
    expect(within(flows).getByTestId('provisional-data-notice')).toHaveTextContent(
      '1 amount in these figures is an estimate',
    );
  });

  it('notes no estimate on a bucket without one', () => {
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={[bucket({ provisionalCount: 0 }), bucket({ value: 'b' })]}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );
    expect(screen.queryByTestId('provisional-data-notice')).toBeNull();
  });

  it('switches the visible bucket on tab click', () => {
    const buckets = [
      bucket({ value: 'household', taggedInflows: 111 }),
      bucket({ value: 'stall', taggedInflows: 222 }),
    ];
    render(
      <TagKeyBreakdownBuckets
        tagKey="scope"
        buckets={buckets}
        reportingCurrency="CAD"
        idPrefix="test-tag"
      />,
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('$111');
    fireEvent.click(screen.getByRole('tab', { name: 'stall' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('$222');
  });

  describe('controlled mode', () => {
    const buckets = [
      bucket({ value: 'household', taggedInflows: 111 }),
      bucket({ value: 'stall', taggedInflows: 222 }),
    ];

    it('shows the bucket the caller selects and reports tab clicks without switching itself', () => {
      const onChange = vi.fn();
      render(
        <TagKeyBreakdownBuckets
          tagKey="scope"
          buckets={buckets}
          reportingCurrency="CAD"
          idPrefix="test-tag"
          activeValue="stall"
          onActiveValueChange={onChange}
        />,
      );
      expect(screen.getByRole('tabpanel')).toHaveTextContent('$222');

      fireEvent.click(screen.getByRole('tab', { name: 'household' }));
      expect(onChange).toHaveBeenCalledWith('household');
      // The caller owns the selection: nothing moves until it passes a new value.
      expect(screen.getByRole('tabpanel')).toHaveTextContent('$222');
    });

    it('follows the caller when it changes the value', () => {
      const { rerender } = render(
        <TagKeyBreakdownBuckets
          tagKey="scope"
          buckets={buckets}
          reportingCurrency="CAD"
          idPrefix="test-tag"
          activeValue="household"
          onActiveValueChange={() => {}}
        />,
      );
      expect(screen.getByRole('tabpanel')).toHaveTextContent('$111');
      rerender(
        <TagKeyBreakdownBuckets
          tagKey="scope"
          buckets={buckets}
          reportingCurrency="CAD"
          idPrefix="test-tag"
          activeValue="stall"
          onActiveValueChange={() => {}}
        />,
      );
      expect(screen.getByRole('tabpanel')).toHaveTextContent('$222');
    });

    it('falls back to the first bucket for a value it does not have', () => {
      render(
        <TagKeyBreakdownBuckets
          tagKey="scope"
          buckets={buckets}
          reportingCurrency="CAD"
          idPrefix="test-tag"
          activeValue="gone"
          onActiveValueChange={() => {}}
        />,
      );
      expect(screen.getByRole('tabpanel')).toHaveTextContent('$111');
    });

    it('still notifies a listener when uncontrolled', () => {
      const onChange = vi.fn();
      render(
        <TagKeyBreakdownBuckets
          tagKey="scope"
          buckets={buckets}
          reportingCurrency="CAD"
          idPrefix="test-tag"
          onActiveValueChange={onChange}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'stall' }));
      expect(onChange).toHaveBeenCalledWith('stall');
      expect(screen.getByRole('tabpanel')).toHaveTextContent('$222');
    });
  });
});
