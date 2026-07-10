import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@/test/render';
import { RecurringChargesPanel } from './RecurringChargesPanel';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

// The lazily-loaded scheduled-bill form is replaced with a stub that echoes the
// template it was given and can fire onSuccess.
const mockFormProps = vi.fn();
vi.mock('@/components/scheduled-transactions/ScheduledTransactionForm', () => ({
  ScheduledTransactionForm: (props: { templateTransaction?: unknown; onSuccess?: () => void }) => {
    mockFormProps(props.templateTransaction);
    return (
      <div data-testid="scheduled-form">
        <button type="button" onClick={() => props.onSuccess?.()}>
          save-bill
        </button>
      </div>
    );
  },
}));

const mockGetAll = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getRecurringCharges: (...a: unknown[]) => mockGetRecurringCharges(...a),
  },
}));

const mockGetScheduled = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...a: unknown[]) => mockGetScheduled(...a),
  },
}));

function charge(overrides: Record<string, unknown> = {}) {
  return {
    payeeName: 'Netflix',
    payeeId: 'pay-netflix',
    amounts: [15],
    dates: ['2026-04-01', '2026-05-01', '2026-06-01'],
    frequency: 'monthly',
    currentAmount: 15,
    previousAmount: 15,
    categoryName: 'Streaming',
    categoryId: 'cat-streaming',
    ...overrides,
  };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'st-1',
    accountId: 'acc-1',
    name: 'Rent',
    payeeName: 'Landlord',
    payeeId: 'pay-landlord',
    amount: -1200,
    currencyCode: 'CAD',
    frequency: 'MONTHLY',
    nextDueDate: '2026-07-01',
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAll.mockResolvedValue({
    data: [
      { id: 't1', payeeId: 'pay-netflix', payeeName: 'Netflix' },
      { id: 't2', payeeId: null, payeeName: null },
    ],
    pagination: { hasMore: false },
  });
  mockGetRecurringCharges.mockResolvedValue([charge()]);
  mockGetScheduled.mockResolvedValue([schedule()]);
});

async function renderPanel() {
  await act(async () => {
    render(<RecurringChargesPanel accountId="acc-1" currencyCode="CAD" />);
  });
}

describe('RecurringChargesPanel', () => {
  it('lists scheduled bills for the account', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Landlord')).toBeInTheDocument());
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    // Expense: signed and coloured red.
    const amount = screen.getByText('-$1200.00');
    expect(amount).toBeInTheDocument();
    expect(amount.className).toContain('text-red-600');
    expect(screen.getByText(/Next due 2026-07-01/)).toBeInTheDocument();
  });

  it('colours scheduled bills by kind (income green, transfer blue)', async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({ id: 'inc', payeeName: 'Payroll', payeeId: 'pay-job', amount: 2500 }),
      schedule({
        id: 'xfer',
        payeeName: 'To Savings',
        payeeId: null,
        amount: -300,
        isTransfer: true,
        transferAccountId: 'sav-1',
      }),
    ]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Payroll')).toBeInTheDocument());

    const income = screen.getByText('+$2500.00');
    expect(income.className).toContain('text-green-600');

    // Transfers carry no +/- sign and are coloured blue.
    const transfer = screen.getByText('$300.00');
    expect(transfer.className).toContain('text-blue-600');
  });

  it('flags detected charges not already scheduled', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    expect(screen.getByText('Possible recurring charges')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(mockGetRecurringCharges).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIds: ['pay-netflix'] }),
    );
  });

  it('does not flag a detected charge that matches a scheduled bill by payee', async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({ id: 'st-2', payeeId: 'pay-netflix', payeeName: 'Netflix' }),
    ]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    // Netflix appears only as the scheduled bill, never as a "possible" charge.
    expect(screen.queryByText('Possible recurring charges')).not.toBeInTheDocument();
  });

  it('excludes scheduled bills from other accounts', async () => {
    mockGetScheduled.mockResolvedValue([schedule({ accountId: 'other-acc' })]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    expect(screen.queryByText('Landlord')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
  });

  it('filters out irregular cadences', async () => {
    mockGetRecurringCharges.mockResolvedValue([charge({ frequency: 'irregular' })]);
    mockGetScheduled.mockResolvedValue([]);
    await renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText('No recurring charges detected on this account'),
      ).toBeInTheDocument(),
    );
  });

  it('skips the recurring lookup when there are no payees', async () => {
    mockGetAll.mockResolvedValue({ data: [], pagination: {} });
    mockGetScheduled.mockResolvedValue([]);
    await renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText('No recurring charges detected on this account'),
      ).toBeInTheDocument(),
    );
    expect(mockGetRecurringCharges).not.toHaveBeenCalled();
  });

  it('opens the pre-filled bill form for a detected charge and reloads on success', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Create a scheduled bill for Netflix'));
    });
    await waitFor(() => expect(screen.getByTestId('scheduled-form')).toBeInTheDocument());
    // The form is seeded with a negative (expense) amount and the charge's payee.
    expect(mockFormProps).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1', payeeId: 'pay-netflix', amount: -15 }),
    );

    // Saving closes the modal and re-fetches (scheduled + transactions again).
    const scheduledCallsBefore = mockGetScheduled.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByText('save-bill'));
    });
    await waitFor(() =>
      expect(mockGetScheduled.mock.calls.length).toBeGreaterThan(scheduledCallsBefore),
    );
  });
});
