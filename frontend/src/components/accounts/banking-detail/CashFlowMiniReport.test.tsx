import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CashFlowMiniReport } from './CashFlowMiniReport';
import type { MonthlyTotal } from '@/types/transaction';

const formatCurrencyMock = vi.hoisted(() => vi.fn((a: number) => `$${a.toFixed(2)}`));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: formatCurrencyMock }),
  };
});
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

  it('formats with the currency the response names, not the account currency', () => {
    formatCurrencyMock.mockClear();
    render(
      <CashFlowMiniReport
        monthly={[{ month: '2026-05', currency: 'USD', total: -200, count: 4 }]}
        currencyCode="EUR"
        isLoading={false}
      />,
    );
    expect(formatCurrencyMock).toHaveBeenCalledWith(-200, 'USD');
  });

  it('shows a dash, not zero, for a month whose total is unknown', () => {
    render(
      <CashFlowMiniReport
        monthly={[
          { month: '2026-05', total: null, knownSubtotal: -10, count: 4 },
          { month: '2026-06', total: 500, count: 3 },
        ]}
        currencyCode="CAD"
        isLoading={false}
      />,
    );
    expect(screen.getByText('-')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});
