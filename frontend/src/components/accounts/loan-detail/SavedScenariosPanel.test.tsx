import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import toast from 'react-hot-toast';
import { SavedScenariosPanel } from './SavedScenariosPanel';
import { LoanScenario } from '@/types/loan-scenario';
import type { ScenarioComparison } from '@/lib/loan-schedule';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@/lib/loan-scenarios', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/loan-scenarios')>();
  return {
    ...original,
    loanScenariosApi: {
      getAll: vi.fn(),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  };
});

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

vi.mock('@/components/accounts/loan-detail/ScenarioComparisonChart', () => ({
  ScenarioComparisonChart: () => <div data-testid="scenario-chart" />,
}));

function makeScenario(overrides: Partial<LoanScenario> = {}): LoanScenario {
  return {
    id: 'scenario-1',
    userId: 'user-1',
    accountId: 'account-1',
    name: 'Extra 200',
    recurringExtraAmount: 200,
    recurringExtraMode: null,
    recurringExtraFrequency: null,
    recurringExtraStartDate: null,
    recurringExtraEndDate: null,
    targetMonthlyPayment: null,
    targetMonthlyPaymentMode: null,
    targetMonthlyPaymentStartDate: null,
    targetMonthlyPaymentEndDate: null,
    lumpSums: [{ date: '2026-06-01', amount: 5000 }],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof SavedScenariosPanel>> = {}) {
  const props = {
    accountId: 'account-1',
    scenarios: [makeScenario()],
    comparisons: new Map<string, ScenarioComparison | null>(),
    currencyCode: 'CAD',
    activePlan: { recurringExtra: { amount: 100 } },
    onLoad: vi.fn(),
    onScenariosChanged: vi.fn(),
    ...overrides,
  };
  const result = render(<SavedScenariosPanel {...props} />);
  return { result, props };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SavedScenariosPanel', () => {
  it('lists scenarios with a readable summary', () => {
    renderPanel();

    expect(screen.getByText('Saved Scenarios')).toBeInTheDocument();
    expect(screen.getByText('Extra 200')).toBeInTheDocument();
    expect(screen.getByText('$200.00 extra per payment + 1 lump sum')).toBeInTheDocument();
  });

  it('shows each scenario outcome as a comparison row', () => {
    const comparison = {
      scenario: { payoffDate: '2040-06-15', finalPaymentAmount: 500 },
      paymentsSaved: 24,
      monthsSaved: 24,
      interestSaved: 15000,
      installmentReduction: 0,
    } as unknown as ScenarioComparison;
    renderPanel({ comparisons: new Map([['scenario-1', comparison]]) });

    expect(screen.getByText('24 months')).toBeInTheDocument();
    expect(screen.getByText('$15000.00')).toBeInTheDocument();
  });

  it('shows an empty state without scenarios', () => {
    renderPanel({ scenarios: [] });
    expect(screen.getByText(/No saved scenarios yet/)).toBeInTheDocument();
  });

  it('shows the chart toggle next to Save current and reveals the chart on click', async () => {
    renderPanel({
      chartOutcomes: [
        { id: 's1', name: 'A', recurringExtra: 100, lumpSumCount: 0, interestSaved: 1000, payoffDate: '2030-01-01' },
        { id: 's2', name: 'B', recurringExtra: 200, lumpSumCount: 0, interestSaved: 2000, payoffDate: '2029-01-01' },
      ],
      chartBaseline: { payoffDate: '2032-01-01' },
    });

    expect(screen.queryByTestId('scenario-chart')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('Show scenario comparison chart'));
    });
    expect(screen.getByTestId('scenario-chart')).toBeInTheDocument();
    expect(screen.getByText('Hide scenario comparison chart')).toBeInTheDocument();
  });

  it('offers no chart toggle without chart data', () => {
    renderPanel();
    expect(screen.queryByText('Show scenario comparison chart')).not.toBeInTheDocument();
  });

  it('disables saving when no plan is active', () => {
    renderPanel({ activePlan: null });
    expect(screen.getByText('Save current scenario')).toBeDisabled();
  });

  it('loads a scenario when its row is clicked', () => {
    const { props } = renderPanel();

    // No dedicated Load button: clicking anywhere on the row loads it.
    fireEvent.click(screen.getByText('Extra 200'));

    expect(props.onLoad).toHaveBeenCalledWith(
      { recurringExtra: { amount: 200 }, lumpSums: [{ date: '2026-06-01', amount: 5000 }] },
      expect.objectContaining({ id: 'scenario-1' }),
    );
  });

  it('does not load when a row action button is clicked', () => {
    const { props } = renderPanel();

    fireEvent.click(screen.getByText('Rename'));

    expect(props.onLoad).not.toHaveBeenCalled();
  });

  it('saves the active plan under a name', async () => {
    mockCreate.mockResolvedValue(makeScenario());
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Save current scenario'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Scenario name'), {
        target: { value: 'My plan' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    expect(mockCreate).toHaveBeenCalledWith('account-1', {
      name: 'My plan',
      recurringExtraAmount: 100,
      recurringExtraMode: null,
      recurringExtraFrequency: null,
      recurringExtraStartDate: null,
      recurringExtraEndDate: null,
      targetMonthlyPayment: null,
      targetMonthlyPaymentMode: null,
      targetMonthlyPaymentStartDate: null,
      targetMonthlyPaymentEndDate: null,
      lumpSums: [],
    });
    expect(props.onScenariosChanged).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('surfaces a save failure as a toast', async () => {
    mockCreate.mockRejectedValue(new Error('conflict'));
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Save current scenario'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Scenario name'), {
        target: { value: 'Dup' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    await act(async () => {}); // flush pending rejection handlers

    expect(toast.error).toHaveBeenCalledWith('Failed to save scenario');
  });

  it('renames a scenario', async () => {
    mockUpdate.mockResolvedValue(makeScenario({ name: 'Renamed' }));
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Rename'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Scenario name'), {
        target: { value: 'Renamed' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    expect(mockUpdate).toHaveBeenCalledWith('account-1', 'scenario-1', { name: 'Renamed' });
    expect(props.onScenariosChanged).toHaveBeenCalled();
  });

  it('deletes a scenario after confirmation', async () => {
    mockDelete.mockResolvedValue(undefined);
    const { props } = renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    // ConfirmDialog: its confirm button carries the same label
    const confirmButtons = screen.getAllByText('Delete');
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    });

    expect(mockDelete).toHaveBeenCalledWith('account-1', 'scenario-1');
    expect(props.onScenariosChanged).toHaveBeenCalled();
  });
});
