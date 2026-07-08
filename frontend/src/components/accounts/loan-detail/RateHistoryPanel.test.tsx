import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import toast from 'react-hot-toast';
import { RateHistoryPanel } from './RateHistoryPanel';
import { Account } from '@/types/account';
import { LoanRateChange } from '@/types/loan-rate-change';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockDetect = vi.fn();
vi.mock('@/lib/loan-rate-changes', () => ({
  loanRateChangesApi: {
    getAll: vi.fn(),
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    detect: (...args: unknown[]) => mockDetect(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    accountType: 'MORTGAGE',
    name: 'Home Mortgage',
    currencyCode: 'CAD',
    currentBalance: -400000,
    interestRate: 4.9,
    paymentAmount: 2500,
    paymentFrequency: 'MONTHLY',
    isCanadianMortgage: true,
    isVariableRate: true,
    ...overrides,
  } as Account;
}

function makeRateChange(overrides: Partial<LoanRateChange> = {}): LoanRateChange {
  return {
    id: 'rc-1',
    accountId: 'account-1',
    effectiveDate: '2024-06-01',
    annualRate: 4.9,
    newPaymentAmount: null,
    source: 'manual',
    note: null,
    createdAt: '2024-06-01',
    updatedAt: '2024-06-01',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof RateHistoryPanel>> = {}) {
  const props = {
    account: makeAccount(),
    rateChanges: [makeRateChange()],
    onChanged: vi.fn(),
    ...overrides,
  };
  const result = render(<RateHistoryPanel {...props} />);
  return { result, props };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RateHistoryPanel', () => {
  it('lists rate changes with date, rate, and payment summary', () => {
    renderPanel();

    expect(screen.getByText('Rate History')).toBeInTheDocument();
    expect(screen.getByText('Jun 1, 2024')).toBeInTheDocument();
    expect(screen.getByText('4.9%')).toBeInTheDocument();
    expect(screen.getByText(/Payment: unchanged/)).toBeInTheDocument();
  });

  it('shows an empty state without rate changes', () => {
    renderPanel({ rateChanges: [] });
    expect(screen.getByText(/No rate changes recorded/)).toBeInTheDocument();
  });

  it('badges inferred and initial rows', () => {
    renderPanel({
      rateChanges: [
        makeRateChange({ id: 'rc-init', source: 'initial', effectiveDate: '2022-01-01' }),
        makeRateChange({ id: 'rc-inf', source: 'inferred', effectiveDate: '2023-01-01' }),
        makeRateChange(),
      ],
    });

    expect(screen.getByText('Initial')).toBeInTheDocument();
    expect(screen.getByText('Inferred')).toBeInTheDocument();
  });

  it('shows the recorded payment when the change carries one', () => {
    renderPanel({
      rateChanges: [makeRateChange({ newPaymentAmount: 2650 })],
    });
    expect(screen.getByText(/Payment: \$2650\.00/)).toBeInTheDocument();
  });

  it('creates a rate change with the keep-payment default', async () => {
    mockCreate.mockResolvedValue(makeRateChange());
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Add rate change'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Effective date'), {
        target: { value: '2025-01-01' },
      });
      fireEvent.change(screen.getByLabelText('New annual rate (%)'), {
        target: { value: '4.5' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    expect(mockCreate).toHaveBeenCalledWith('account-1', {
      effectiveDate: '2025-01-01',
      annualRate: 4.5,
      newPaymentAmount: null,
      recalculatePayment: false,
      note: null,
    });
    expect(toast.success).toHaveBeenCalled();
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('creates with an explicit new payment amount', async () => {
    mockCreate.mockResolvedValue(makeRateChange());
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Add rate change'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Effective date'), {
        target: { value: '2025-01-01' },
      });
      fireEvent.change(screen.getByLabelText('New annual rate (%)'), {
        target: { value: '4.5' },
      });
      fireEvent.click(screen.getByLabelText('Set a new payment amount'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New payment amount'), {
        target: { value: '2650' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    expect(mockCreate).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ newPaymentAmount: 2650, recalculatePayment: false }),
    );
  });

  it('creates with payment recalculation for mortgages', async () => {
    mockCreate.mockResolvedValue(makeRateChange());
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Add rate change'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Effective date'), {
        target: { value: '2025-01-01' },
      });
      fireEvent.change(screen.getByLabelText('New annual rate (%)'), {
        target: { value: '4.5' },
      });
      fireEvent.click(
        screen.getByLabelText('Recalculate payment to keep the amortization on track'),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    expect(mockCreate).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ recalculatePayment: true, newPaymentAmount: null }),
    );
  });

  it('hides the recalculate option for plain loans', async () => {
    renderPanel({ account: makeAccount({ accountType: 'LOAN' }) });

    await act(async () => {
      fireEvent.click(screen.getByText('Add rate change'));
    });

    expect(
      screen.queryByLabelText('Recalculate payment to keep the amortization on track'),
    ).not.toBeInTheDocument();
  });

  it('updates an existing rate change', async () => {
    mockUpdate.mockResolvedValue(makeRateChange({ annualRate: 5.1 }));
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Edit'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New annual rate (%)'), {
        target: { value: '5.1' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'account-1',
      'rc-1',
      expect.objectContaining({ annualRate: 5.1, effectiveDate: '2024-06-01' }),
    );
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('deletes after confirmation', async () => {
    mockDelete.mockResolvedValue(undefined);
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    await act(async () => {
      // The confirm dialog's button shares its label with the row action
      const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
      fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    });

    expect(mockDelete).toHaveBeenCalledWith('account-1', 'rc-1');
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('runs detection after confirmation and reports the count', async () => {
    mockDetect.mockResolvedValue({
      created: [makeRateChange({ source: 'inferred' })],
      replacedCount: 0,
      warnings: [],
    });
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Detect from history'));
    });
    await act(async () => {
      // The confirm dialog's button shares its label with the panel action
      const detectButtons = screen.getAllByRole('button', { name: 'Detect from history' });
      fireEvent.click(detectButtons[detectButtons.length - 1]);
    });

    expect(mockDetect).toHaveBeenCalledWith('account-1');
    expect(toast.success).toHaveBeenCalled();
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('surfaces detection failures as an error toast', async () => {
    mockDetect.mockRejectedValue(new Error('nope'));
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Detect from history'));
    });
    await act(async () => {
      // The confirm dialog's button shares its label with the panel action
      const detectButtons = screen.getAllByRole('button', { name: 'Detect from history' });
      fireEvent.click(detectButtons[detectButtons.length - 1]);
    });
    await act(async () => {}); // flush pending rejection handlers

    expect(toast.error).toHaveBeenCalledWith(
      'Could not detect rate changes from the payment history',
    );
  });

  it('surfaces save failures as an error toast', async () => {
    mockCreate.mockRejectedValue(new Error('duplicate'));
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Add rate change'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Effective date'), {
        target: { value: '2025-01-01' },
      });
      fireEvent.change(screen.getByLabelText('New annual rate (%)'), {
        target: { value: '4.5' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    await act(async () => {}); // flush pending rejection handlers

    expect(toast.error).toHaveBeenCalledWith('Failed to save rate change');
  });
});
