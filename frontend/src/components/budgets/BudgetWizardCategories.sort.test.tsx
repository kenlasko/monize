import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { BudgetWizardCategories } from './BudgetWizardCategories';
import { bucketSelectWidth } from './BudgetWizardBuckets';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { WizardState } from './BudgetWizard';
import type { CategoryAnalysis, GenerateBudgetResponse } from '@/types/budget';

/** Issue #2222: sortable wizard columns and a bucket select that fits its text. */
const category = (categoryId: string, categoryName: string, median: number, isIncome = false): CategoryAnalysis => ({
  categoryId,
  categoryName,
  isIncome,
  average: median,
  median,
  p25: median,
  p75: median,
  min: median,
  max: median,
  stdDev: 0,
  monthlyAmounts: [median, median, median],
  monthlyOccurrences: 3,
  isFixed: false,
  seasonalMonths: [],
  suggested: median,
});

const result: GenerateBudgetResponse = {
  categories: [
    category('cat-salary', 'Salary', 3000, true),
    category('cat-tax-prop', 'Taxes: Property', 500),
    category('cat-groceries', 'Groceries', 400),
    category('cat-tax-owing', 'Taxes Owing', 300),
    category('cat-tax-fed', 'Taxes: Federal', 200),
    category('cat-taxes', 'Taxes', 100),
  ],
  transfers: [],
  incomeTransfers: [],
  estimatedMonthlyIncome: 3000,
  totalBudgeted: 1500,
  totalTransfers: 0,
  projectedMonthlySavings: 1500,
  analysisWindow: { startDate: '2026-05-01', endDate: '2026-11-01', months: 6 },
};

const baseState: WizardState = {
  analysisMonths: 6,
  profile: 'ON_TRACK',
  strategy: 'FIXED',
  analysisResult: result,
  selectedCategories: new Map([
    ['cat-tax-prop', { categoryId: 'cat-tax-prop', amount: 50, isIncome: false }],
    ['cat-groceries', { categoryId: 'cat-groceries', amount: 450, isIncome: false }],
    ['cat-tax-fed', { categoryId: 'cat-tax-fed', amount: 250, isIncome: false }],
  ]),
  selectedTransfers: new Map(),
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

const renderStep = (state: WizardState = baseState) =>
  render(<BudgetWizardCategories state={state} updateState={vi.fn()} onNext={vi.fn()} onBack={vi.fn()} />);

const expenseTable = () => screen.getByRole('columnheader', { name: /^Expenses/ }).closest('table')!;
const header = (name: RegExp) => within(expenseTable()).getByRole('columnheader', { name });
const expenseNames = () =>
  within(expenseTable())
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('checkbox').closest('label')!.textContent);

describe('BudgetWizardCategories: sorting', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ preferences: null });
  });

  it('opens with expenses by suggested amount, no column marked sorted', () => {
    renderStep();
    expect(expenseNames()).toEqual(['Taxes: Property', 'Groceries', 'Taxes Owing', 'Taxes: Federal', 'Taxes']);
    for (const name of [/^Expenses/, /^Trend \/ Median/, /^Amount/]) {
      expect(header(name)).toHaveAttribute('aria-sort', 'none');
    }
  });

  it('sorts by category with every subcategory next to its parent, both ways', () => {
    renderStep();
    fireEvent.click(header(/^Expenses/));
    expect(header(/^Expenses/)).toHaveAttribute('aria-sort', 'ascending');
    expect(expenseNames()).toEqual(['Groceries', 'Taxes', 'Taxes: Federal', 'Taxes: Property', 'Taxes Owing']);

    fireEvent.click(header(/^Expenses/));
    expect(header(/^Expenses/)).toHaveAttribute('aria-sort', 'descending');
    expect(expenseNames()).toEqual(['Taxes Owing', 'Taxes', 'Taxes: Property', 'Taxes: Federal', 'Groceries']);
  });

  it('sorts by the trend median', () => {
    renderStep();
    fireEvent.click(header(/^Trend \/ Median/));
    expect(expenseNames()).toEqual(['Taxes', 'Taxes: Federal', 'Taxes Owing', 'Groceries', 'Taxes: Property']);
  });

  it('sorts by the typed amount, unselected rows last, and from the keyboard', () => {
    renderStep();
    fireEvent.keyDown(header(/^Amount/), { key: 'Enter' });
    expect(expenseNames()).toEqual(['Taxes: Property', 'Taxes: Federal', 'Groceries', 'Taxes', 'Taxes Owing']);
    fireEvent.click(header(/^Amount/));
    expect(expenseNames()).toEqual(['Groceries', 'Taxes: Federal', 'Taxes: Property', 'Taxes', 'Taxes Owing']);
  });

  it('sorts each table on its own', () => {
    renderStep();
    fireEvent.click(header(/^Expenses/));
    const income = screen.getByRole('columnheader', { name: /^Income/ });
    expect(income).toHaveAttribute('aria-sort', 'none');
  });
});

describe('BudgetWizardBucketSelect sizing', () => {
  const bucketState: WizardState = {
    ...baseState,
    strategy: 'BUCKET',
    buckets: [
      { key: 'k-long', name: 'A bucket with a fairly long name', targetType: 'PERCENT', targetValue: 50, carryOver: false, carryCap: null },
    ],
  };

  it('is as wide as its longest option, never under 10rem', () => {
    expect(bucketSelectWidth(['Unassigned'])).toBe('max(10rem, calc(11ch + 2.25rem))');
    expect(bucketSelectWidth([])).toBe('max(10rem, calc(1ch + 2.25rem))');

    renderStep(bucketState);
    const select = screen.getByRole('combobox', { name: 'Bucket for Groceries' });
    const wrapper = select.parentElement!.parentElement!;
    expect(wrapper.style.getPropertyValue('--bucket-select-width')).toBe(
      bucketSelectWidth(['Unassigned', 'A bucket with a fairly long name']),
    );
  });

  it('overrides the global select padding and text size so the text is not cut off', () => {
    renderStep(bucketState);
    const select = screen.getByRole('combobox', { name: 'Bucket for Groceries' });
    // globals.css styles `select` outside any layer, so a plain utility loses to it.
    for (const cls of ['py-0!', 'pl-2!', 'pr-7!', 'text-xs!']) {
      expect(select).toHaveClass(cls);
    }
  });
});
