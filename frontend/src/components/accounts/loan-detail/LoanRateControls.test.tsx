import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { useLoanRateEditing } from './useLoanRateEditing';
import { LoanRateControls } from './LoanRateControls';
import { Account } from '@/types/account';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';

vi.mock('@/lib/loan-rate-changes', () => ({
  loanRateChangesApi: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    detect: vi.fn(),
    applyScheduledPayment: vi.fn(),
  },
}));

const account = {
  id: 'loan-1',
  accountType: 'MORTGAGE',
  currencyCode: 'CAD',
} as Account;

function Harness({ onChanged }: { onChanged: () => void }) {
  const editing = useLoanRateEditing(account, onChanged);
  return <LoanRateControls editing={editing} />;
}

describe('LoanRateControls + useLoanRateEditing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a rate change and prompts to update the scheduled payment', async () => {
    (loanRateChangesApi.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'rc-1',
      scheduledPaymentPreview: {
        scheduledTransactionId: 'sched-1',
        scheduledTransactionName: 'Mortgage',
        currencyCode: 'CAD',
        currentPaymentAmount: 1000,
        proposedPaymentAmount: 1100,
        currentPrincipal: 300,
        proposedPrincipal: 350,
        currentInterest: 700,
        proposedInterest: 750,
        extraPrincipal: 0,
      },
    });
    (
      loanRateChangesApi.applyScheduledPayment as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    const onChanged = vi.fn();

    render(<Harness onChanged={onChanged} />);

    fireEvent.click(screen.getByText('Add rate change'));
    fireEvent.change(screen.getByLabelText('Effective date'), {
      target: { value: '2024-06-01' },
    });
    fireEvent.change(screen.getByLabelText('New annual rate (%)'), {
      target: { value: '5.5' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(loanRateChangesApi.create).toHaveBeenCalledWith('loan-1', {
        effectiveDate: '2024-06-01',
        annualRate: 5.5,
        newPaymentAmount: null,
        recalculatePayment: false,
        note: null,
      }),
    );

    // The scheduled-payment permission prompt (a12b8d8a) surfaces.
    await waitFor(() =>
      expect(screen.getByText('Update scheduled payment?')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Update payment'));

    await waitFor(() =>
      expect(loanRateChangesApi.applyScheduledPayment).toHaveBeenCalledWith('loan-1'),
    );
  });

  it('detects rate changes from history on confirm', async () => {
    (loanRateChangesApi.detect as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: [],
      replacedCount: 0,
      warnings: [],
    });
    render(<Harness onChanged={vi.fn()} />);

    fireEvent.click(screen.getByText('Detect from history'));
    // Confirm dialog -> confirm
    const confirmButtons = screen.getAllByText('Detect from history');
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() =>
      expect(loanRateChangesApi.detect).toHaveBeenCalledWith('loan-1'),
    );
  });
});
