import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetBucketSummary } from './BudgetBucketSummary';
import type { BudgetBucketStatus, BudgetBucketStatusResult } from '@/types/budget';

const fmt = (amount: number) => `$${amount.toFixed(2)}`;

const needs: BudgetBucketStatus = {
  bucketId: 'b1',
  name: 'Needs',
  targetType: 'PERCENT',
  targetValue: 50,
  carryOver: false,
  carryCap: null,
  allocated: 2500,
  carriedIn: 0,
  planned: 2400,
  spent: 1800,
  available: 700,
  percentUsed: 72,
  lineCount: 3,
};

const savings: BudgetBucketStatus = {
  ...needs,
  bucketId: 'b2',
  name: 'Savings',
  targetType: 'AMOUNT',
  targetValue: 1000,
  allocated: 1000,
  spent: 1200,
  available: -200,
  percentUsed: 120,
  lineCount: 1,
};

const unknownNeeds: BudgetBucketStatus = {
  ...needs,
  allocated: null,
  available: null,
  percentUsed: null,
};

const full: BudgetBucketStatusResult = {
  periodStart: '2026-02-01',
  periodEnd: '2026-02-28',
  currencyCode: 'USD',
  income: 5000,
  incomeSource: 'BASE_INCOME',
  totalAllocated: 3500,
  knownAllocated: 3500,
  unallocated: 1500,
  buckets: [needs, savings],
  unassigned: { planned: 0, spent: 0, lineCount: 0 },
};

function renderCard(data: BudgetBucketStatusResult) {
  return render(
    <BudgetBucketSummary
      budgetId="bud-1"
      status={{ state: 'ready', data }}
      formatCurrency={fmt}
    />,
  );
}

describe('BudgetBucketSummary', () => {
  it('renders the server figures for a full card', () => {
    renderCard(full);

    expect(screen.getByText('Bucket allocation')).toBeInTheDocument();
    expect(screen.getByText('$5000.00')).toBeInTheDocument();
    expect(screen.getByText("Based on the budget's base income")).toBeInTheDocument();
    expect(screen.getByText('Total allocated')).toBeInTheDocument();
    expect(screen.getByText('$3500.00')).toBeInTheDocument();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
    expect(screen.getByText('50% of income')).toBeInTheDocument();
    expect(screen.getByText('$1000.00 per period')).toBeInTheDocument();
    expect(screen.getByText('3 categories')).toBeInTheDocument();
    expect(screen.getByText('1 category')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '72');
    expect(screen.queryByText(/Over-allocated/)).toBeNull();
  });

  it('marks an overspent bucket', () => {
    renderCard(full);
    expect(screen.getByText(/Overspent/)).toHaveTextContent('Overspent $-200.00');
  });

  it('renders the missing-income message with a link, never zero', () => {
    renderCard({
      ...full,
      income: null,
      incomeSource: 'NONE',
      totalAllocated: null,
      knownAllocated: 1000,
      unallocated: null,
      buckets: [unknownNeeds, savings],
    });

    expect(
      screen.getByText(/Set a base income on the budget, or add an income category/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit budget' })).toHaveAttribute(
      'href',
      '/budgets/bud-1/edit',
    );
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('relabels a partial total', () => {
    renderCard({
      ...full,
      totalAllocated: null,
      knownAllocated: 1000,
      unallocated: null,
      buckets: [unknownNeeds, savings],
    });

    expect(screen.getByText('Allocated so far')).toBeInTheDocument();
    expect(screen.queryByText('Total allocated')).toBeNull();
    expect(screen.getAllByText('$1000.00').length).toBeGreaterThan(0);
  });

  it('flags over-allocation', () => {
    renderCard({ ...full, totalAllocated: 5500, unallocated: -500 });
    expect(screen.getByRole('alert')).toHaveTextContent(/Over-allocated/);
  });

  it('shows a carried-in caption only when carriedIn is not zero', () => {
    renderCard({ ...full, buckets: [{ ...needs, carriedIn: 150 }, savings] });
    expect(screen.getAllByText(/Carried in/)).toHaveLength(1);
    expect(screen.getByText('Carried in $150.00')).toBeInTheDocument();
  });

  it('shows the unassigned row with a link to assign', () => {
    renderCard({ ...full, unassigned: { planned: 300, spent: 120, lineCount: 2 } });

    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText(/Planned \$300\.00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assign them' })).toHaveAttribute(
      'href',
      '/budgets/bud-1/edit',
    );
  });

  it('shows the empty state with a link to add buckets', () => {
    renderCard({ ...full, buckets: [] });
    expect(screen.getByRole('link', { name: 'Add buckets' })).toHaveAttribute(
      'href',
      '/budgets/bud-1/edit',
    );
  });

  it('shows a loading state', () => {
    render(
      <BudgetBucketSummary budgetId="bud-1" status={{ state: 'loading' }} formatCurrency={fmt} />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('says a failed request failed', () => {
    render(
      <BudgetBucketSummary budgetId="bud-1" status={{ state: 'error' }} formatCurrency={fmt} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load the bucket allocation/);
    expect(screen.queryByText('No buckets yet')).toBeNull();
  });
});
