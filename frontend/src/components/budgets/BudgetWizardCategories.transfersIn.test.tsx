import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetWizardCategories } from './BudgetWizardCategories';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { WizardState } from './BudgetWizard';
import type { GenerateBudgetResponse, TransferAnalysis } from '@/types/budget';

/** Issue #2141: transfer income suggestions on the wizard's Categories step. */
const analysis = (accountId: string, accountName: string, suggested: number): TransferAnalysis => ({
  accountId,
  accountName,
  accountType: 'SAVINGS',
  average: suggested,
  median: suggested,
  p25: suggested - 100,
  p75: suggested + 100,
  min: suggested - 100,
  max: suggested + 100,
  stdDev: 50,
  monthlyAmounts: [suggested, suggested, suggested],
  monthlyOccurrences: 3,
  isFixed: true,
  seasonalMonths: [],
  suggested,
});

const result: GenerateBudgetResponse = {
  categories: [
    {
      categoryId: 'cat-salary',
      categoryName: 'Salary',
      isIncome: true,
      average: 3000,
      median: 3000,
      p25: 3000,
      p75: 3000,
      min: 3000,
      max: 3000,
      stdDev: 0,
      monthlyAmounts: [3000, 3000, 3000],
      monthlyOccurrences: 3,
      isFixed: true,
      seasonalMonths: [],
      suggested: 3000,
    },
  ],
  transfers: [analysis('acc-hisa', 'HISA', 300)],
  incomeTransfers: [analysis('acc-hisa', 'HISA', 2000)],
  estimatedMonthlyIncome: 3000,
  totalBudgeted: 0,
  totalTransfers: 300,
  projectedMonthlySavings: 2700,
  analysisWindow: { startDate: '2026-05-01', endDate: '2026-11-01', months: 6 },
};

const baseState: WizardState = {
  analysisMonths: 6,
  profile: 'ON_TRACK',
  strategy: 'FIXED',
  analysisResult: result,
  selectedCategories: new Map([
    ['cat-salary', { categoryId: 'cat-salary', amount: 3000, isIncome: true }],
  ]),
  selectedTransfers: new Map([
    ['acc-hisa', { transferAccountId: 'acc-hisa', isTransfer: true, amount: 300 }],
  ]),
  selectedIncomeTransfers: new Map(),
  buckets: [],
  bucketsPresetApplied: false,
  budgetName: 'B',
  budgetType: 'MONTHLY',
  periodStart: '2026-11-01',
  currencyCode: 'USD',
  baseIncome: null,
  incomeLinked: false,
  defaultRolloverType: 'NONE',
  alertWarnPercent: 80,
  alertCriticalPercent: 95,
  excludedAccountIds: [],
  transfersInAsIncome: false,
  isSubmitting: false,
};

function checkboxIn(headerText: string): HTMLInputElement {
  const table = screen.getByText(headerText).closest('table')!;
  return table.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

describe('BudgetWizardCategories: transfers in', () => {
  const updateState = vi.fn();

  beforeEach(() => {
    usePreferencesStore.setState({ preferences: null });
    vi.clearAllMocks();
  });

  const renderStep = (state: WizardState = baseState) =>
    render(
      <BudgetWizardCategories
        state={state}
        updateState={updateState}
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );

  it('lists the transfer income sources, none ticked, with the hint', () => {
    renderStep();

    expect(screen.getByText('Transfers In (Income)')).toBeInTheDocument();
    expect(checkboxIn('Transfers In (Income)').checked).toBe(false);
    expect(screen.getByText(/Tick only the accounts you draw income from/)).toBeInTheDocument();
  });

  it('ticking a source adds an income transfer line and drops its savings line', () => {
    renderStep();

    fireEvent.click(checkboxIn('Transfers In (Income)'));

    const update = updateState.mock.calls.at(-1)![0];
    expect(update.selectedIncomeTransfers.get('acc-hisa')).toEqual({
      transferAccountId: 'acc-hisa',
      isTransfer: true,
      isIncome: true,
      amount: 2000,
    });
    expect(update.selectedTransfers.has('acc-hisa')).toBe(false);
  });

  it('ticking the savings line drops the account\'s income transfer line', () => {
    renderStep({
      ...baseState,
      selectedTransfers: new Map(),
      selectedIncomeTransfers: new Map([
        ['acc-hisa', { transferAccountId: 'acc-hisa', isTransfer: true, isIncome: true, amount: 2000 }],
      ]),
    });

    fireEvent.click(checkboxIn('Transfers / Savings'));

    const update = updateState.mock.calls.at(-1)![0];
    expect(update.selectedTransfers.get('acc-hisa')?.amount).toBe(300);
    expect(update.selectedIncomeTransfers.has('acc-hisa')).toBe(false);
  });

  it('counts a ticked source in total income and reprices it with the profile', () => {
    renderStep({
      ...baseState,
      selectedTransfers: new Map(),
      selectedIncomeTransfers: new Map([
        ['acc-hisa', { transferAccountId: 'acc-hisa', isTransfer: true, isIncome: true, amount: 2000 }],
      ]),
    });

    const income = screen.getByText('Total Income').nextElementSibling!;
    expect(income.textContent).toContain('5,000.00');

    fireEvent.click(screen.getByText('Comfortable'));
    const update = updateState.mock.calls.at(-1)![0];
    expect(update.selectedIncomeTransfers.get('acc-hisa')?.amount).toBe(2100);
  });

  it('edits a ticked source\'s amount', () => {
    renderStep({
      ...baseState,
      selectedTransfers: new Map(),
      selectedIncomeTransfers: new Map([
        ['acc-hisa', { transferAccountId: 'acc-hisa', isTransfer: true, isIncome: true, amount: 2000 }],
      ]),
    });

    const table = screen.getByText('Transfers In (Income)').closest('table')!;
    const input = table.querySelector('input[inputMode="decimal"]') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '1800' } });
    fireEvent.blur(input);

    const update = updateState.mock.calls.at(-1)![0];
    expect(update.selectedIncomeTransfers.get('acc-hisa')?.amount).toBe(1800);
  });

  it('unticking a source removes it', () => {
    renderStep({
      ...baseState,
      selectedIncomeTransfers: new Map([
        ['acc-hisa', { transferAccountId: 'acc-hisa', isTransfer: true, isIncome: true, amount: 2000 }],
      ]),
      selectedTransfers: new Map(),
    });

    fireEvent.click(checkboxIn('Transfers In (Income)'));

    const update = updateState.mock.calls.at(-1)![0];
    expect(update.selectedIncomeTransfers.size).toBe(0);
  });
});
