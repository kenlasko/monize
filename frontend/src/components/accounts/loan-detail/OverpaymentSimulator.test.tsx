import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { OverpaymentSimulator } from './OverpaymentSimulator';
import { OverpaymentPlan } from '@/lib/loan-schedule';

const mockDetectLoanPayments = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    detectLoanPayments: (...args: unknown[]) => mockDetectLoanPayments(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

async function renderSimulator(props: Partial<React.ComponentProps<typeof OverpaymentSimulator>> = {}) {
  const onPlanChange = vi.fn();
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <OverpaymentSimulator
        accountId="loan-1"
        currencyCode="USD"
        onPlanChange={onPlanChange}
        {...props}
      />,
    );
  });
  return { result: result!, onPlanChange: props.onPlanChange ?? onPlanChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectLoanPayments.mockResolvedValue(null);
});

describe('OverpaymentSimulator', () => {
  it('emits a recurring extra plan when an amount is entered', async () => {
    const { onPlanChange } = await renderSimulator();

    const amountInput = screen.getByLabelText('Extra per payment');
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '200' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: { amount: 200, mode: 'SHORTEN_TERM' },
    } satisfies OverpaymentPlan);
  });

  it('carries the recurring extra mode chosen in the plan', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Extra per payment'), { target: { value: '200' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('After an overpayment'), {
        target: { value: 'LOWER_INSTALLMENT' },
      });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: { amount: 200, mode: 'LOWER_INSTALLMENT' },
    } satisfies OverpaymentPlan);
  });

  it('includes the optional date window in the emitted plan', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Extra per payment'), { target: { value: '150' } });
      fireEvent.change(screen.getByLabelText('Starting (optional)'), { target: { value: '2026-08-01' } });
      fireEvent.change(screen.getByLabelText('Until (optional)'), { target: { value: '2027-08-01' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: {
        amount: 150,
        mode: 'SHORTEN_TERM',
        startDate: '2026-08-01',
        endDate: '2027-08-01',
      },
    });
  });

  it('emits null when inputs do not form a valid plan', async () => {
    const { onPlanChange } = await renderSimulator();

    const amountInput = screen.getByLabelText('Extra per payment');
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '200' } });
    });
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith(null);
  });

  it('adds, edits, and removes lump sums', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.click(screen.getByText('Add lump sum'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1000' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      lumpSums: [{ date: '2026-09-01', amount: 1000, mode: 'SHORTEN_TERM' }],
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Remove'));
    });
    expect(onPlanChange).toHaveBeenLastCalledWith(null);
  });

  it('resets all inputs', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Extra per payment'), { target: { value: '200' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Reset'));
    });

    expect(onPlanChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByLabelText('Extra per payment')).toHaveValue('');
  });

  it('offers the detected extra principal as a pre-fill', async () => {
    mockDetectLoanPayments.mockResolvedValue({ averageExtraPrincipal: 250.5 });
    const { onPlanChange } = await renderSimulator();

    await waitFor(() => {
      expect(screen.getByText(/\$250\.50/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Use it'));
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: { amount: 250.5, mode: 'SHORTEN_TERM' },
    });
  });

  it('does not show a hint when detection finds no extra principal', async () => {
    mockDetectLoanPayments.mockResolvedValue({ averageExtraPrincipal: 0 });
    await renderSimulator();
    await act(async () => {});

    expect(screen.queryByText('Use it')).not.toBeInTheDocument();
  });

  it('survives a failing detection endpoint', async () => {
    mockDetectLoanPayments.mockRejectedValue(new Error('nope'));
    await renderSimulator();
    await act(async () => {});

    expect(screen.getByText('Overpayment Simulator')).toBeInTheDocument();
  });

  it('applies an externally loaded plan when the version changes', async () => {
    const loaded: OverpaymentPlan = {
      recurringExtra: { amount: 300, startDate: '2026-01-01' },
      lumpSums: [{ date: '2026-06-01', amount: 5000 }],
    };
    const { result } = await renderSimulator({ loadedPlan: null, loadedPlanVersion: 0 });

    await act(async () => {
      result.rerender(
        <OverpaymentSimulator
          accountId="loan-1"
          currencyCode="USD"
          onPlanChange={vi.fn()}
          loadedPlan={loaded}
          loadedPlanVersion={1}
        />,
      );
    });

    expect(screen.getByLabelText('Extra per payment')).toHaveValue('300.00');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-06-01');
    expect(screen.getByLabelText('Amount')).toHaveValue('5,000.00');
  });
});
