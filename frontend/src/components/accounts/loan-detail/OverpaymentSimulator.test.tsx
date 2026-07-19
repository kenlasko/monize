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
  return { result: result!, onPlanChange };
}

const projectionInput = {
  startingBalance: 100000,
  annualRate: 5,
  paymentAmount: 600,
  frequency: 'MONTHLY' as const,
  firstPaymentDate: new Date('2025-01-15'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectLoanPayments.mockResolvedValue(null);
});

describe('OverpaymentSimulator', () => {
  it('emits a monthly recurring extra plan when an amount is entered', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Overpayment amount'), { target: { value: '200' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: { amount: 200, frequency: 'MONTHLY', mode: 'SHORTEN_TERM' },
    } satisfies OverpaymentPlan);
  });

  it('carries the chosen frequency and mode in the plan', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'QUARTERLY' } });
      fireEvent.change(screen.getByLabelText('Overpayment amount'), { target: { value: '300' } });
      fireEvent.change(screen.getByLabelText('After an overpayment'), {
        target: { value: 'LOWER_INSTALLMENT' },
      });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: { amount: 300, frequency: 'QUARTERLY', mode: 'LOWER_INSTALLMENT' },
    } satisfies OverpaymentPlan);
  });

  it('includes the optional date window in the emitted plan', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Overpayment amount'), { target: { value: '150' } });
      fireEvent.change(screen.getByLabelText('Starting (optional)'), { target: { value: '2026-08-01' } });
      fireEvent.change(screen.getByLabelText('Until (optional)'), { target: { value: '2027-08-01' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      recurringExtra: {
        amount: 150,
        frequency: 'MONTHLY',
        mode: 'SHORTEN_TERM',
        startDate: '2026-08-01',
        endDate: '2027-08-01',
      },
    });
  });

  it('emits a one-off lump sum when the frequency is one-off', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'ONE_OFF' } });
    });
    // One-off hides the recurring window and shows a single date field.
    expect(screen.queryByLabelText('Starting (optional)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Until (optional)')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Overpayment amount'), { target: { value: '5000' } });
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      lumpSums: [{ date: '2026-09-01', amount: 5000, mode: 'SHORTEN_TERM' }],
    });
  });

  it('emits null when inputs do not form a valid plan', async () => {
    const { onPlanChange } = await renderSimulator();

    const amountInput = screen.getByLabelText('Overpayment amount');
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '200' } });
    });
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith(null);
  });

  it('resets all inputs', async () => {
    const { onPlanChange } = await renderSimulator();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Overpayment amount'), { target: { value: '200' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Reset'));
    });

    expect(onPlanChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByLabelText('Overpayment amount')).toHaveValue('');
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
      recurringExtra: { amount: 250.5, frequency: 'MONTHLY', mode: 'SHORTEN_TERM' },
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

  it('live-solves the required amount for a target interest saving', async () => {
    const { onPlanChange } = await renderSimulator({ projectionInput });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Simulation type'), { target: { value: 'INTEREST' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Target interest savings'), {
        target: { value: '10000' },
      });
    });

    const lastPlan = onPlanChange.mock.calls.at(-1)?.[0];
    expect(lastPlan?.recurringExtra?.mode).toBe('SHORTEN_TERM');
    expect(lastPlan?.recurringExtra?.frequency).toBe('MONTHLY');
    expect(lastPlan?.recurringExtra?.amount).toBeGreaterThan(0);
  });

  it('honors the date window for a payoff-month goal and forces shorten-term', async () => {
    const { onPlanChange } = await renderSimulator({ projectionInput });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Simulation type'), { target: { value: 'PAYOFF' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Target payoff month'), {
        target: { value: '2030-01-01' },
      });
      fireEvent.change(screen.getByLabelText('Starting (optional)'), { target: { value: '2025-06-01' } });
    });

    const lastPlan = onPlanChange.mock.calls.at(-1)?.[0];
    expect(lastPlan?.recurringExtra?.mode).toBe('SHORTEN_TERM');
    expect(lastPlan?.recurringExtra?.startDate).toBe('2025-06-01');
    // A payoff-month goal locks the mode selector to shorten-term.
    expect(screen.getByLabelText('After an overpayment')).toBeDisabled();
  });

  it('disables the goal-seek simulation types without a projection input', async () => {
    await renderSimulator();
    expect(screen.getByRole('option', { name: 'Target interest savings' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Target payoff month' })).toBeDisabled();
  });

  it('applies an externally loaded recurring plan when the version changes', async () => {
    const loaded: OverpaymentPlan = {
      recurringExtra: { amount: 300, frequency: 'QUARTERLY', startDate: '2026-01-01' },
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

    expect(screen.getByLabelText('Overpayment amount')).toHaveValue('300.00');
    expect(screen.getByLabelText('Frequency')).toHaveValue('QUARTERLY');
    expect(screen.getByLabelText('Starting (optional)')).toHaveValue('2026-01-01');
  });

  it('applies an externally loaded one-off plan when the version changes', async () => {
    const loaded: OverpaymentPlan = {
      lumpSums: [{ date: '2026-06-01', amount: 5000, mode: 'SHORTEN_TERM' }],
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

    expect(screen.getByLabelText('Frequency')).toHaveValue('ONE_OFF');
    expect(screen.getByLabelText('Overpayment amount')).toHaveValue('5,000.00');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-06-01');
  });

  it('emits a fixed monthly budget plan and hides the cadence/window', async () => {
    const { onPlanChange } = await renderSimulator({ projectionInput });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Simulation type'), { target: { value: 'BUDGET' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Total monthly payment'), { target: { value: '4000' } });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      targetMonthlyPayment: 4000,
      // A budget defaults to lower-installment (the installment shrinks).
      targetMonthlyPaymentMode: 'LOWER_INSTALLMENT',
    });
    // A budget hides the cadence and the window (but keeps the mode).
    expect(screen.queryByLabelText('Frequency')).not.toBeInTheDocument();
    expect(screen.getByLabelText('After an overpayment')).toBeInTheDocument();
  });

  it('carries the budget mode (shorten vs lower installment)', async () => {
    const { onPlanChange } = await renderSimulator({ projectionInput });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Simulation type'), { target: { value: 'BUDGET' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Total monthly payment'), { target: { value: '4000' } });
      fireEvent.change(screen.getByLabelText('After an overpayment'), {
        target: { value: 'SHORTEN_TERM' },
      });
    });

    expect(onPlanChange).toHaveBeenLastCalledWith({
      targetMonthlyPayment: 4000,
      targetMonthlyPaymentMode: 'SHORTEN_TERM',
    });
  });
});
