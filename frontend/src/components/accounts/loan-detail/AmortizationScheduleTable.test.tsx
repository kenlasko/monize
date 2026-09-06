import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { AmortizationScheduleTable } from './AmortizationScheduleTable';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import { LoanPaymentEvent } from '@/lib/loan-history';
import { exportToCsv } from '@/lib/csv-export';
import type { LoanRateEditing } from './useLoanRateEditing';

// Stub the rate controls (modals) so these tests focus on the table + rate cell.
vi.mock('./LoanRateControls', () => ({
  LoanRateControls: () => <div data-testid="rate-controls" />,
}));

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
    }),
  };
});vi.mock('@/hooks/useDateFormat', async () => {
  const { format, parseISO } = await import('date-fns');
  return {
    useDateFormat: () => ({
      formatDate: (d: string) => format(parseISO(d), 'MMM d, yyyy'),
    }),
  };
});

function makeHistoryEvents(count: number, annualRate: number | null = null): LoanPaymentEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2025-${String(i + 1).padStart(2, '0')}-15`,
    principal: 450,
    interest: 50,
    balance: 10000 - 450 * (i + 1),
    cumulativePrincipal: 450 * (i + 1),
    cumulativeInterest: 50 * (i + 1),
    type: 'REGULAR' as const,
    annualRate,
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
  it('flags the row after a gap in payments', () => {
    // Jan/Feb/Mar then a jump to August -- the ~5-month gap (missing Apr-Jul)
    // marks the August row so the schedule can highlight the missing data.
    const row = (date: string, i: number): LoanPaymentEvent => ({
      date,
      principal: 450,
      interest: 50,
      balance: 10000 - 450 * (i + 1),
      cumulativePrincipal: 450 * (i + 1),
      cumulativeInterest: 50 * (i + 1),
      type: 'REGULAR' as const,
      annualRate: 5,
    });
    render(
      <AmortizationScheduleTable
        historyEvents={[
          row('2025-01-15', 0),
          row('2025-02-15', 1),
          row('2025-03-15', 2),
          row('2025-08-15', 3),
        ]}
        projectionRows={[]}
        currencyCode="CAD"
      />,
    );

    // The gap is shown as its own empty "no data" band, not by tinting the
    // real August row.
    const gapRows = screen.getAllByText(/No recorded payments/);
    expect(gapRows).toHaveLength(1);
    // The real August payment still renders as a normal row.
    expect(screen.getByText('Aug 15, 2025')).toBeInTheDocument();
  });

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

  it('exports every historical and projected row to CSV', async () => {
    const projection = makeProjection();
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(2, 5)}
        projectionRows={projection.rows}
        currencyCode="CAD"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Loan Schedule as CSV' }));
    });

    expect(exportToCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = vi.mocked(exportToCsv).mock.calls[0];
    expect(filename).toBe('loan-schedule');
    // No overpayments, so no Extra Principal column.
    expect(headers).toEqual([
      '#',
      'Date',
      'Type',
      'Payment',
      'Interest',
      'Principal',
      'Rate',
      'Balance',
    ]);
    expect(rows).toHaveLength(2 + projection.rows.length);
    expect(rows[0]).toEqual([1, '2025-01-15', 'Historical', 500, 50, 450, 5, 9550]);
    expect(rows[2][0]).toBe(3); // first projected payment continues the numbering
    expect(rows[2][2]).toBe('Projected');
  });

  it('disables the CSV export when the schedule is empty', () => {
    render(
      <AmortizationScheduleTable historyEvents={[]} projectionRows={[]} currencyCode="CAD" />,
    );
    expect(
      screen.getByRole('button', { name: 'Download Loan Schedule as CSV' }),
    ).toBeDisabled();
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

    // The header and the per-row phone captions both spell the column, so the
    // label now appears more than once in the DOM (one tree, restyled at `sm`).
    expect(screen.getAllByText('Extra Principal').length).toBeGreaterThan(0);
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
        annualRate: null,
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
    // without a simulator scenario, and shows the overpaid amount. (The header
    // and the phone captions share the label, so it appears more than once.)
    expect(screen.getAllByText('Extra Principal').length).toBeGreaterThan(0);
    const overpaymentRow = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Feb 15, 2025'));
    expect(overpaymentRow?.textContent).toContain('$1000.00');
  });

  it('collapses around the present: hides the oldest, shows recent past + upcoming', () => {
    // 12 historical (Jan-Dec 2025) + projected (from Aug 2026).
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(12)}
        projectionRows={makeProjection().rows}
        currencyCode="CAD"
      />,
    );

    // Oldest historical is hidden by default; a recent paid row and the first
    // projected row are shown.
    expect(screen.queryByText('Jan 15, 2025')).not.toBeInTheDocument();
    expect(screen.getByText('Dec 15, 2025')).toBeInTheDocument();
    expect(screen.getByText('Aug 15, 2026')).toBeInTheDocument();
    expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
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

  it('shows a "paid to date" subtotal just above the projected section', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(2)}
        projectionRows={makeProjection().rows}
        currencyCode="CAD"
      />,
    );

    // Two paid rows of 450 principal + 50 interest each => 1000 paid so far.
    expect(screen.getByText('Paid to date')).toBeInTheDocument();
    const paidRow = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Paid to date'));
    expect(paidRow?.textContent).toContain('$1000.00'); // total payment
    expect(paidRow?.textContent).toContain('$900.00'); // principal 450 x 2
    expect(paidRow?.textContent).toContain('$100.00'); // interest 50 x 2
  });

  it('collapses a month with several entries and expands to per-date detail', () => {
    // May 2026: a regular installment and an overpayment on different days.
    const events: LoanPaymentEvent[] = [
      {
        date: '2026-05-05',
        principal: 765,
        interest: 154,
        balance: 142000,
        cumulativePrincipal: 765,
        cumulativeInterest: 154,
        type: 'REGULAR' as const,
        annualRate: 5.5,
      },
      {
        date: '2026-05-29',
        principal: 2534,
        interest: 536,
        balance: 139466,
        cumulativePrincipal: 3299,
        cumulativeInterest: 690,
        type: 'OVERPAYMENT' as const,
        annualRate: null,
      },
    ];
    render(
      <AmortizationScheduleTable historyEvents={events} projectionRows={[]} currencyCode="CAD" />,
    );

    // Collapsed: the per-date rows are hidden; an aggregate month row shows the
    // month total (payment 765 + 2534 interest-inclusive) and an entry count.
    expect(screen.getByText('2 entries')).toBeInTheDocument();
    expect(screen.queryByText('May 5, 2026')).not.toBeInTheDocument();
    // Aggregate payment = 919 + 3070 = 3989 (also echoed in the totals row).
    expect(screen.getAllByText('$3989.00').length).toBeGreaterThan(0);

    // Expanding reveals the two dated detail rows.
    fireEvent.click(screen.getByRole('button', { name: /Show or hide the payments/ }));
    expect(screen.getByText('May 5, 2026')).toBeInTheDocument();
    expect(screen.getByText('May 29, 2026')).toBeInTheDocument();
  });

  it('leaves a single-entry month as a plain row (no toggle)', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(2)}
        projectionRows={[]}
        currencyCode="CAD"
      />,
    );

    // Two distinct months, one entry each: no aggregate toggle appears.
    expect(screen.queryByRole('button', { name: /Show or hide the payments/ })).not.toBeInTheDocument();
    expect(screen.getByText('Jan 15, 2025')).toBeInTheDocument();
    expect(screen.getByText('Feb 15, 2025')).toBeInTheDocument();
  });

  it('shows an empty state when there are no rows', () => {
    render(
      <AmortizationScheduleTable historyEvents={[]} projectionRows={[]} currencyCode="CAD" />,
    );

    expect(screen.getByText('No payments found')).toBeInTheDocument();
  });

  it('shows a read-only observed Rate column for historical rows', () => {
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(1, 5.5)}
        projectionRows={[]}
        currencyCode="CAD"
      />,
    );

    // The Rate column header, plus the per-row phone caption on the rate cell.
    expect(screen.getAllByText('Rate').length).toBeGreaterThan(0);
    // Historical rate is the rate observed from the interest charged, shown
    // read-only -- there is no editable cell or controls without `editing`.
    expect(screen.getByText('5.50%')).toBeInTheDocument();
    expect(screen.queryByTestId('rate-controls')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Edit interest rate/)).not.toBeInTheDocument();
  });

  it('opens the rate-change form pre-filled when a historical rate is clicked', () => {
    const openAddWith = vi.fn();
    const editing = { openAddWith } as unknown as LoanRateEditing;

    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(1, 5.5)}
        projectionRows={[]}
        currencyCode="CAD"
        editing={editing}
      />,
    );

    // The rate value is a button that opens the add form seeded with the row's
    // date and rate -- no inline editing.
    fireEvent.click(screen.getByLabelText(/Edit interest rate/));
    expect(openAddWith).toHaveBeenCalledWith('2025-01-15', 5.5);
  });

  it('opens the rate-change form pre-filled when a projected rate is clicked', () => {
    const openAddWith = vi.fn();
    const editing = { openAddWith } as unknown as LoanRateEditing;

    const projection = makeProjection();
    render(
      <AmortizationScheduleTable
        historyEvents={[]}
        projectionRows={projection.rows}
        currencyCode="CAD"
        editing={editing}
      />,
    );

    // The first projected row is dated 2026-08-15.
    fireEvent.click(screen.getAllByLabelText(/Edit interest rate/)[0]);
    expect(openAddWith).toHaveBeenCalledWith('2026-08-15', expect.any(Number));
  });

  it('captions each amount within the row so a phone needs no column header', () => {
    // Below `sm` the header is hidden and the row wraps into a grid, so every
    // value must name its own column inside the row -- otherwise a phone reader
    // sees a column of unlabelled numbers. The table is one tree restyled by
    // CSS, so these captions ride in each row's markup at every width.
    render(
      <AmortizationScheduleTable
        historyEvents={makeHistoryEvents(2, 5)}
        projectionRows={[]}
        currencyCode="CAD"
      />,
    );

    const janRow = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Jan 15, 2025'));
    expect(janRow).toBeDefined();
    for (const caption of ['Payment', 'Interest', 'Principal', 'Rate', 'Balance']) {
      expect(janRow?.textContent).toContain(caption);
    }
  });
});
