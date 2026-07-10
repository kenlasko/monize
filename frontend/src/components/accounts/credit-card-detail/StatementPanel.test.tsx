import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { StatementPanel } from './StatementPanel';
import type { StatementCycle } from '@/types/credit-card-detail';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: Date) => `${d.getMonth() + 1}/${d.getDate()}` }),
}));

const cycle: StatementCycle = {
  accountId: 'cc-1',
  currencyCode: 'CAD',
  cycleStart: '2026-06-10',
  cycleEnd: '2026-07-09',
  lastSettlementDate: '2026-06-10',
  nextSettlementDate: '2026-07-10',
  daysUntilSettlement: 2,
  paymentDueDate: '2026-07-15',
  daysUntilPaymentDue: 7,
  statementBalance: -1000,
  amountPaidSinceStatement: 200,
  currentBalance: -1200,
};

describe('StatementPanel', () => {
  it('renders the cycle window and statement figures as magnitudes', () => {
    render(<StatementPanel cycle={cycle} isLoading={false} />);
    expect(screen.getByText('Current Statement Cycle')).toBeInTheDocument();
    expect(screen.getByText(/Cycle:/)).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument(); // abs statement balance
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.getByText('7 days remaining')).toBeInTheDocument();
    expect(screen.getByText('Settles in 2 days')).toBeInTheDocument();
  });

  it('renders the unavailable hint when there is no cycle', () => {
    render(<StatementPanel cycle={null} isLoading={false} />);
    expect(screen.getByText('Statement cycle unavailable')).toBeInTheDocument();
  });

  it('renders a loading placeholder', () => {
    const { container } = render(<StatementPanel cycle={null} isLoading={true} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('handles a missing due date', () => {
    render(
      <StatementPanel
        cycle={{ ...cycle, paymentDueDate: null, daysUntilPaymentDue: null }}
        isLoading={false}
      />,
    );
    expect(screen.getByText('No due date set')).toBeInTheDocument();
  });
});
