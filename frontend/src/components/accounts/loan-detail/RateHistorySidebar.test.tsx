import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { useLoanRateEditing } from './useLoanRateEditing';
import { RateHistorySidebar } from './RateHistorySidebar';
import { Account } from '@/types/account';
import { LoanRateChange } from '@/types/loan-rate-change';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { exportToCsv } from '@/lib/csv-export';

vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    applyScheduledPayment: vi.fn(),
    detect: vi.fn(),
  },
}));

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

const account = {
  id: 'loan-1',
  accountType: 'MORTGAGE',
  currencyCode: 'CAD',
} as Account;

const rateChanges: LoanRateChange[] = [
  {
    id: 'rc-1',
    accountId: 'loan-1',
    effectiveDate: '2022-05-13',
    annualRate: 1.75,
    newPaymentAmount: 3200,
    source: 'initial',
    note: null,
  } as LoanRateChange,
  {
    id: 'rc-2',
    accountId: 'loan-1',
    effectiveDate: '2022-08-05',
    annualRate: 3.25,
    newPaymentAmount: null,
    source: 'inferred',
    note: null,
  } as LoanRateChange,
];

function Harness({ rows, onChanged }: { rows: LoanRateChange[]; onChanged: () => void }) {
  const editing = useLoanRateEditing(account, onChanged);
  return <RateHistorySidebar account={account} rateChanges={rows} editing={editing} />;
}

describe('RateHistorySidebar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists each recorded rate change with its rate, source badge, and payment', () => {
    render(<Harness rows={rateChanges} onChanged={() => {}} />);

    expect(screen.getByText('Rate History')).toBeInTheDocument();
    expect(screen.getByText('1.75%')).toBeInTheDocument();
    expect(screen.getByText('3.25%')).toBeInTheDocument();
    expect(screen.getByText('Initial')).toBeInTheDocument();
    expect(screen.getByText('Inferred')).toBeInTheDocument();
    // A row with no recorded payment shows "unchanged".
    expect(screen.getByText(/unchanged/)).toBeInTheDocument();
  });

  it('collapses and expands when the header bar is clicked', () => {
    render(<Harness rows={rateChanges} onChanged={() => {}} />);

    expect(screen.getByText('1.75%')).toBeInTheDocument();
    // The header (title) is the collapse toggle.
    fireEvent.click(screen.getByText('Rate History'));
    expect(screen.queryByText('1.75%')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Rate History'));
    expect(screen.getByText('1.75%')).toBeInTheDocument();
  });

  it('keeps the Add and Detect actions available even with no rate changes', () => {
    render(<Harness rows={[]} onChanged={() => {}} />);
    expect(screen.getByText(/No rate changes recorded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add rate change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detect from history' })).toBeInTheDocument();
  });

  it('offers the mortgage type detector on a mortgage whose container can edit it', () => {
    function WithTypeDetector() {
      const editing = useLoanRateEditing(account, () => {});
      return (
        <RateHistorySidebar
          account={account}
          rateChanges={rateChanges}
          editing={editing}
          onUseMortgageType={vi.fn()}
        />
      );
    }
    render(<WithTypeDetector />);
    expect(screen.getByRole('button', { name: 'Detect Mortgage Type' })).toBeInTheDocument();
  });

  it('does not offer the mortgage type detector without an edit form or on a loan', () => {
    const loan = { ...account, accountType: 'LOAN' } as Account;
    function OnLoan() {
      const editing = useLoanRateEditing(loan, () => {});
      return (
        <RateHistorySidebar
          account={loan}
          rateChanges={rateChanges}
          editing={editing}
          onUseMortgageType={vi.fn()}
        />
      );
    }
    const { unmount } = render(<Harness rows={rateChanges} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Detect Mortgage Type' })).not.toBeInTheDocument();
    unmount();
    render(<OnLoan />);
    expect(screen.queryByRole('button', { name: 'Detect Mortgage Type' })).not.toBeInTheDocument();
  });

  it('exports the rate timeline to CSV, sorted by effective date', async () => {
    // Pass the rows newest-first to prove the export re-sorts them.
    render(<Harness rows={[...rateChanges].reverse()} onChanged={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Rate History as CSV' }));
    });

    expect(exportToCsv).toHaveBeenCalledWith(
      'rate-history',
      ['Effective date', 'Rate (%)', 'Source', 'Payment', 'Note'],
      [
        ['2022-05-13', 1.75, 'Initial', 3200, ''],
        ['2022-08-05', 3.25, 'Inferred', '', ''],
      ],
    );
  });

  it('disables the CSV export when there are no rate changes', () => {
    render(<Harness rows={[]} onChanged={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Download Rate History as CSV' }),
    ).toBeDisabled();
  });

  it('detects rate changes from history after confirmation', async () => {
    (loanRateChangesApi.detect as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: rateChanges,
      replacedCount: 2,
      warnings: [],
    });
    const onChanged = vi.fn();
    render(<Harness rows={rateChanges} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Detect from history' }));
    const buttons = screen.getAllByRole('button', { name: 'Detect from history' });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(loanRateChangesApi.detect).toHaveBeenCalledWith('loan-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  // Timeline A of docs/specs/scheduled-loan-installment-pricing.md 7.5: editing
  // the change asks before the bill moves, and the prompt names the due date
  // the sync prices (2023-02-03) and the later due date the timeline's own
  // row reaches (2023-05-03, 560.00).
  it("asks before applying an edited rate change's scheduled-payment sync, naming the due date", async () => {
    (loanRateChangesApi.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'rc-2',
      scheduledPaymentPreview: {
        scheduledTransactionId: 'sched-1',
        scheduledTransactionName: 'Mortgage',
        currencyCode: 'CAD',
        dueDate: '2023-02-03',
        currentPaymentAmount: 560,
        proposedPaymentAmount: 584.59,
        currentPrincipal: 167.92,
        proposedPrincipal: 167.92,
        currentInterest: 375,
        proposedInterest: 416.67,
        extraPrincipal: 0,
        upcomingPaymentChanges: [{ dueDate: '2023-05-03', paymentAmount: 560 }],
      },
    });
    (
      loanRateChangesApi.applyScheduledPayment as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    const onChanged = vi.fn();
    render(<Harness rows={rateChanges} onChanged={onChanged} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(loanRateChangesApi.update).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText('Update scheduled payment?')).toBeInTheDocument(),
    );
    // Before/after on the due date, and the later due date the timeline
    // states a payment from.
    expect(screen.getByText(/584\.59/)).toBeInTheDocument();
    expect(screen.getByText(/From .* the payment becomes.*560\.00/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Update payment'));
    await waitFor(() =>
      expect(loanRateChangesApi.applyScheduledPayment).toHaveBeenCalledWith('loan-1'),
    );
  });

  it("asks before applying a deleted rate change's scheduled-payment sync; skip leaves the bill alone", async () => {
    (loanRateChangesApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue({
      scheduledPaymentPreview: {
        scheduledTransactionId: 'sched-1',
        scheduledTransactionName: 'Mortgage',
        currencyCode: 'CAD',
        dueDate: '2023-02-03',
        currentPaymentAmount: 560,
        proposedPaymentAmount: 584.59,
        currentPrincipal: 167.92,
        proposedPrincipal: 167.92,
        currentInterest: 375,
        proposedInterest: 416.67,
        extraPrincipal: 0,
        upcomingPaymentChanges: [],
      },
    });
    const onChanged = vi.fn();
    render(<Harness rows={rateChanges} onChanged={onChanged} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await waitFor(() => expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument());
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(loanRateChangesApi.delete).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText('Update scheduled payment?')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('Leave as-is'));
    expect(loanRateChangesApi.applyScheduledPayment).not.toHaveBeenCalled();
  });
});
