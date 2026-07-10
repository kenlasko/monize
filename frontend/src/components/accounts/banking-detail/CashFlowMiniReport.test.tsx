import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CashFlowMiniReport } from './CashFlowMiniReport';
import type { MonthlyTotal } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

const monthly: MonthlyTotal[] = [
  { month: '2026-05', total: -200, count: 4 },
  { month: '2026-06', total: 500, count: 3 },
];

describe('CashFlowMiniReport', () => {
  it('renders a row per month with net amounts', () => {
    render(<CashFlowMiniReport monthly={monthly} currencyCode="CAD" isLoading={false} />);
    expect(screen.getByText('Cash Flow')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();
    expect(screen.getByText('$-200.00')).toBeInTheDocument();
    expect(screen.getByText(/May 26/)).toBeInTheDocument();
  });

  it('shows an empty state with no activity', () => {
    render(<CashFlowMiniReport monthly={[]} currencyCode="CAD" isLoading={false} />);
    expect(screen.getByText('No activity in the last 12 months')).toBeInTheDocument();
  });

  it('shows a loading placeholder', () => {
    const { container } = render(
      <CashFlowMiniReport monthly={monthly} currencyCode="CAD" isLoading={true} />,
    );
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});
