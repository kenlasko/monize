import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AmortizationScheduleTable } from './AmortizationScheduleTable';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import { LoanPaymentEvent } from '@/lib/loan-history';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));
vi.mock('@/hooks/useDateFormat', async () => {
  const { format, parseISO } = await import('date-fns');
  return {
    useDateFormat: () => ({
      formatDate: (d: string) => format(parseISO(d), 'MMM d, yyyy'),
    }),
  };
});

function makeHistoryEvents(count: number): LoanPaymentEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2025-${String(i + 1).padStart(2, '0')}-15`,
    principal: 450,
    interest: 50,
    balance: 10000 - 450 * (i + 1),
    cumulativePrincipal: 450 * (i + 1),
    cumulativeInterest: 50 * (i + 1),
  }));
}

function makeProjection(overpayments?: Parameters<typeof generateLoanSchedule>[0]['overpayments']) {
  return generateLoanSchedule({
    startingBalance: 8000,
    annualRate: 6,
    paymentAmount: 500,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date(2026, 7, 15),
    overpayments,
  });
}

describe('AmortizationScheduleTable', () => {
  it('renders historical and projected rows with a separator', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(2)}
        projectionRows={makeProjection().rows}
        currencyCode="CAD"
      />,
    );

    expect(screen.getByText('Installment Schedule')).toBeInTheDocument();
    expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    expect(screen.getByText('Jan 15, 2025')).toBeInTheDocument();
    expect(screen.getByText('Aug 15, 2026')).toBeInTheDocument();
  });

  it('numbers projected rows after the historical rows', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(2)}
        projectionRows={makeProjection().rows}
        currencyCode="CAD"
      />,
    );

    // Two historical rows, so the first projected payment is #3
    const rows = screen.getAllByRole('row');
    const projectedFirst = rows.find((row) => row.textContent?.includes('Aug 15, 2026'));
    expect(projectedFirst?.textContent).toContain('3');
  });

  it('hides the extra principal column without overpayments', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(1)}
        projectionRows={makeProjection().rows}
        currencyCode="CAD"
      />,
    );

    expect(screen.queryByText('Extra Principal')).not.toBeInTheDocument();
  });

  it('shows the extra principal column when the projection has overpayments', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(1)}
        projectionRows={makeProjection({ recurringExtra: { amount: 200 } }).rows}
        currencyCode="CAD"
      />,
    );

    expect(screen.getByText('Extra Principal')).toBeInTheDocument();
    expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
  });

  it('collapses to 24 rows and expands with the show-all toggle', () => {
    const projection = makeProjection();
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(12)}
        projectionRows={projection.rows}
        currencyCode="CAD"
      />,
    );

    const totalRows = 12 + projection.rows.length;
    expect(totalRows).toBeGreaterThan(24);
    const showAll = screen.getByText(`Show all ${totalRows} payments`);
    expect(showAll).toBeInTheDocument();

    fireEvent.click(showAll);
    expect(screen.getByText('Show less')).toBeInTheDocument();
    // Final projected row now visible: balance 0
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
  });

  it('shows an empty state when there are no rows', () => {
    render(
      <AmortizationScheduleTable historyEvents={[]} projectionRows={[]} currencyCode="CAD" />,
    );

    expect(screen.getByText('No payments found')).toBeInTheDocument();
  });
});
