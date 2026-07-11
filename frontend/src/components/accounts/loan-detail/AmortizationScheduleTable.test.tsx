import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AmortizationScheduleTable } from './AmortizationScheduleTable';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import { LoanPaymentEvent } from '@/lib/loan-history';
import type { LoanRateChange } from '@/types/loan-rate-change';
import type { LoanRateEditing } from './useLoanRateEditing';

// Stub the rate controls (modals) so these tests focus on the table + rate cell.
vi.mock('./LoanRateControls', () => ({
  LoanRateControls: () => <div data-testid="rate-controls" />,
}));

const makeRateChange = (overrides: Partial<LoanRateChange> = {}): LoanRateChange =>
  ({
    id: 'rc-1',
    accountId: 'loan-1',
    effectiveDate: '2025-01-05',
    annualRate: 5.5,
    newPaymentAmount: null,
    source: 'inferred',
    note: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }) as LoanRateChange;

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
    type: 'REGULAR' as const,
    interestRecorded: true,
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

    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();
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

  it('surfaces a historical overpayment as extra principal', () => {
    const events: LoanPaymentEvent[] = [
      ...makeHistoryEvents(1),
      {
        date: '2025-02-15',
        principal: 1000,
        interest: 0,
        balance: 8550,
        cumulativePrincipal: 1450,
        cumulativeInterest: 50,
        type: 'OVERPAYMENT' as const,
        interestRecorded: false,
      },
    ];
    render(
      <AmortizationScheduleTable
        historyEvents={events}
        projectionRows={makeProjection().rows}
        currencyCode="CAD"
      />,
    );

    // The extra-principal column appears for a historical overpayment even
    // without a simulator scenario, and shows the overpaid amount.
    expect(screen.getByText('Extra Principal')).toBeInTheDocument();
    const overpaymentRow = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Feb 15, 2025'));
    expect(overpaymentRow?.textContent).toContain('$1000.00');
  });

  it('collapses to 10 rows and expands with the show-all toggle', () => {
    const projection = makeProjection();
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(12)}
        projectionRows={projection.rows}
        currencyCode="CAD"
      />,
    );

    const totalRows = 12 + projection.rows.length;
    expect(totalRows).toBeGreaterThan(10);
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

  it('shows a read-only Rate column from the timeline when not editable', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(1)}
        projectionRows={[]}
        currencyCode="CAD"
        rateChanges={[makeRateChange({ effectiveDate: '2024-12-01', annualRate: 5.5 })]}
        fallbackAnnualRate={5.5}
      />,
    );

    expect(screen.getByText('Rate')).toBeInTheDocument();
    expect(screen.getByText('5.50%')).toBeInTheDocument();
    // No controls and no editable button when `editing` is absent.
    expect(screen.queryByTestId('rate-controls')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Edit interest rate/)).not.toBeInTheDocument();
  });

  it('edits a rate inline and reports the row date, rate, and change id', () => {
    const commitInlineRate = vi.fn();
    const editing = {
      savingDate: null,
      commitInlineRate,
      openEdit: vi.fn(),
    } as unknown as LoanRateEditing;

    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(1)}
        projectionRows={[]}
        currencyCode="CAD"
        rateChanges={[makeRateChange({ effectiveDate: '2024-12-01', annualRate: 5.5 })]}
        fallbackAnnualRate={5.5}
        editing={editing}
      />,
    );

    expect(screen.getByTestId('rate-controls')).toBeInTheDocument();
    // The single historical row is dated 2025-01-15 (no exact change on it).
    fireEvent.click(screen.getByLabelText(/Edit interest rate/));
    const input = screen.getByLabelText(/Edit interest rate/);
    fireEvent.change(input, { target: { value: '6.1' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(commitInlineRate).toHaveBeenCalledWith('2025-01-15', 6.1, undefined);
  });
});
