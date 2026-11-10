import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import type { Category } from '@/types/category';
import type { PayrollDeductionRule } from '@/types/payroll-deduction';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  billDeductionCategoryIds,
  billLineAmount,
  payrollBillOptions,
  PayrollDeductionRuleForm,
} from './PayrollDeductionRuleForm';

vi.mock('@/lib/zodConfig', () => ({}));
// Outside the two months before the next reset unless a test says otherwise,
// so the next period's fields start closed (spec section 11).
let mockToday = '2026-04-10';
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => mockToday,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
const mockSuggest = vi.fn();
vi.mock('@/lib/payroll-deductions', () => ({
  payrollDeductionsApi: { suggest: (...args: unknown[]) => mockSuggest(...args) },
}));
// The category picker's own behaviour is its own test; a select stands in.
vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, options, value, onChange, error }: any) => (
    <label>
      {label}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value, '')}>
        <option value="">--</option>
        {options.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span>{error}</span>}
    </label>
  ),
}));

const bill = (overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction =>
  ({
    id: 'st-pay',
    name: 'Paycheque',
    isActive: true,
    isInvestment: false,
    isTransfer: false,
    amount: 2436,
    currencyCode: 'CAD',
    splits: [
      { id: 's1', categoryId: 'cat-gross', amount: 2500 },
      { id: 's2', categoryId: 'cat-ei', amount: -64 },
      // Zeroed at the end of last year: still one of the bill's deductions.
      { id: 's3', categoryId: 'cat-cpp', amount: 0 },
      { id: 's4', categoryId: null, transferAccountId: 'acc-savings', amount: -100 },
    ],
    ...overrides,
  }) as ScheduledTransaction;

const categories = [
  { id: 'cat-gross', name: 'Salary', parentId: null },
  { id: 'cat-ei', name: 'EI', parentId: null },
  { id: 'cat-cpp', name: 'CPP', parentId: null },
  { id: 'cat-other', name: 'Groceries', parentId: null },
] as Category[];

const optionLabels = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);

describe('payrollBillOptions, billDeductionCategoryIds and billLineAmount', () => {
  it('offers only active, net-income, non-investment, non-transfer bills', () => {
    const options = payrollBillOptions([
      bill(),
      bill({ id: 'inactive', isActive: false }),
      bill({ id: 'inv', isInvestment: true }),
      bill({ id: 'xfer', isTransfer: true }),
      bill({ id: 'rent', amount: -1800 }),
      bill({ id: 'zero', amount: 0 }),
    ]);
    expect(options.map((b) => b.id)).toEqual(['st-pay']);
  });

  it("names the bill's deduction lines: categorised, not positive, not a transfer", () => {
    expect(billDeductionCategoryIds(bill())).toEqual(['cat-ei', 'cat-cpp']);
    expect(billDeductionCategoryIds(bill({ splits: [] }))).toEqual([]);
    expect(billDeductionCategoryIds(undefined)).toEqual([]);
  });

  it('reads the magnitude of a negative line and nothing from a positive or zero one', () => {
    expect(billLineAmount(bill(), 'cat-ei')).toBe(64);
    expect(billLineAmount(bill(), 'cat-gross')).toBeNull();
    expect(billLineAmount(bill(), 'cat-cpp')).toBeNull();
    expect(billLineAmount(undefined, 'cat-ei')).toBeNull();
  });
});

describe('PayrollDeductionRuleForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockToday = '2026-04-10';
    mockSuggest.mockResolvedValue({ expectedPerPaycheque: null, expectedSource: null, yearlyMaximum: null, yearlyMaximumSource: null });
  });

  const fillMaximum = (index: number, value: string) => {
    const input = screen.getAllByLabelText('Yearly maximum')[index];
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };
  const pickCategory = async (index: number, value: string) => {
    await act(async () => {
      fireEvent.change(screen.getByLabelText(`Deduction category ${index + 1}`), { target: { value } });
    });
  };
  const save = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save|Create/ }));
    });
  };

  it("preselects the only bill, defaults the reset to next 1 January and offers only the bill's deduction lines", async () => {
    render(
      <PayrollDeductionRuleForm scheduledTransactions={[bill()]} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    expect(screen.getByLabelText('Payroll scheduled bill')).toHaveValue('st-pay');
    expect(screen.getByLabelText('Reset date')).toHaveValue(`01/01/${new Date().getFullYear() + 1}`);
    expect(optionLabels(screen.getByLabelText('Deduction category 1'))).toEqual(['--', 'CPP', 'EI']);
    await pickCategory(0, 'cat-ei');
    expect(await screen.findByText("The bill's line deducts $64.00 per paycheque.")).toBeInTheDocument();
    expect(screen.queryByLabelText('Expected per paycheque')).not.toBeInTheDocument();
    fillMaximum(0, '1077.48');
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      scheduledTransactionId: 'st-pay',
      resetPeriod: 'YEARLY',
      resetDate: expect.stringMatching(/^\d{4}-01-01$/),
      lines: [{ categoryId: 'cat-ei', yearlyMaximum: 1077.48, expectedPerPaycheque: null }],
    });
  });

  it('takes several categories at once, each offered only the lines the others left', async () => {
    mockSuggest.mockResolvedValue({ expectedPerPaycheque: 150, expectedSource: 'ledger', yearlyMaximum: null, yearlyMaximumSource: null });
    render(
      <PayrollDeductionRuleForm scheduledTransactions={[bill()]} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    await pickCategory(0, 'cat-ei');
    fillMaximum(0, '1077.48');
    fireEvent.click(screen.getByRole('button', { name: '+ Add another category' }));
    expect(optionLabels(screen.getByLabelText('Deduction category 2'))).toEqual(['--', 'CPP']);
    await pickCategory(1, 'cat-cpp');
    // The zero line supplies nothing, so the ledger's usual figure is offered.
    expect(mockSuggest).toHaveBeenCalledWith('st-pay', 'cat-cpp', expect.stringMatching(/^\d{4}-01-01$/));
    const expected = await screen.findByLabelText('Expected per paycheque');
    await waitFor(() => expect(expected).toHaveValue('150.00'));
    expect(
      screen.getByText('Suggested from the amount your transactions in this category most often show over the last year.'),
    ).toBeInTheDocument();
    fillMaximum(1, '4034.10');
    // Both deduction lines are taken: nothing more to add.
    expect(screen.queryByRole('button', { name: '+ Add another category' })).not.toBeInTheDocument();
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].lines).toEqual([
      { categoryId: 'cat-ei', yearlyMaximum: 1077.48, expectedPerPaycheque: null },
      { categoryId: 'cat-cpp', yearlyMaximum: 4034.1, expectedPerPaycheque: 150 },
    ]);
  });

  it('removes a row and starts the rows over when the bill changes', async () => {
    const other = bill({ id: 'st-other', name: 'Second job', splits: [{ id: 'o1', categoryId: 'cat-other', amount: -5 }] as never });
    render(
      <PayrollDeductionRuleForm scheduledTransactions={[bill(), other]} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    fireEvent.change(screen.getByLabelText('Payroll scheduled bill'), { target: { value: 'st-pay' } });
    await pickCategory(0, 'cat-ei');
    fireEvent.click(screen.getByRole('button', { name: '+ Add another category' }));
    expect(screen.getAllByLabelText('Yearly maximum')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove category 2' }));
    expect(screen.getAllByLabelText('Yearly maximum')).toHaveLength(1);
    expect(screen.getByLabelText('Deduction category 1')).toHaveValue('cat-ei');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Payroll scheduled bill'), { target: { value: 'st-other' } });
    });
    expect(screen.getByLabelText('Deduction category 1')).toHaveValue('');
    expect(optionLabels(screen.getByLabelText('Deduction category 1'))).toEqual(['--', 'Groceries']);
  });

  it('still offers a bill that already has rules when creating, and keeps the rule\'s own bill when editing', async () => {
    const ruled = { id: 'r-ei', scheduledTransactionId: 'st-pay', categoryId: 'cat-ei' } as PayrollDeductionRule;
    const other = bill({ id: 'st-other', name: 'Second job' });
    const { unmount } = render(
      <PayrollDeductionRuleForm
        scheduledTransactions={[bill(), other]}
        categories={categories}
        existingRules={[ruled]}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const billLabels = optionLabels(screen.getByLabelText('Payroll scheduled bill'));
    expect(billLabels).toEqual(['Select the bill that is your paycheque', bill().name, 'Second job']);
    // The ruled category is not offered again on that bill.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Payroll scheduled bill'), { target: { value: 'st-pay' } });
    });
    const categoryLabels = optionLabels(screen.getByLabelText('Deduction category 1'));
    expect(categoryLabels).toContain('CPP');
    expect(categoryLabels).not.toContain('EI');
    unmount();
    // Editing a rule on a bill that no longer qualifies: the bill stays
    // selected, its line still supplies the expected amount, and the other
    // rule's category is not offered again.
    const rule = {
      ...ruled,
      id: 'r-cpp',
      categoryId: 'cat-cpp',
      yearlyMaximum: 4034.1,
      resetPeriod: 'YEARLY',
      resetDate: '2026-01-01',
      expectedPerPaycheque: 150,
      expectedSource: 'entered',
    } as PayrollDeductionRule;
    render(
      <PayrollDeductionRuleForm
        rule={rule}
        scheduledTransactions={[bill({ isActive: false })]}
        categories={categories}
        existingRules={[ruled, rule]}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByLabelText('Payroll scheduled bill')).toHaveValue('st-pay');
    expect(optionLabels(screen.getByLabelText('Deduction category 1'))).toEqual(['--', 'CPP']);
    expect(screen.getByLabelText('Yearly maximum')).toHaveValue('4,034.10');
  });

  it('ignores a suggestion that answers for a category the row has since left', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockSuggest
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ expectedPerPaycheque: null, expectedSource: null, yearlyMaximum: 4034.1, yearlyMaximumSource: 'previousPeriod' });
    render(
      <PayrollDeductionRuleForm scheduledTransactions={[bill()]} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    await pickCategory(0, 'cat-ei');
    await pickCategory(0, 'cat-cpp');
    await waitFor(() => expect(screen.getByLabelText('Yearly maximum')).toHaveValue('4,034.10'));
    // EI's late answer must not overwrite CPP's figure.
    await act(async () => {
      resolveFirst({ expectedPerPaycheque: null, expectedSource: null, yearlyMaximum: 1049.12, yearlyMaximumSource: 'previousPeriod' });
    });
    expect(screen.getByLabelText('Yearly maximum')).toHaveValue('4,034.10');
  });

  it('says when the bill has no deduction lines at all', () => {
    render(
      <PayrollDeductionRuleForm
        scheduledTransactions={[bill({ splits: [{ id: 's1', categoryId: 'cat-gross', amount: 2500 }] as never })]}
        categories={categories}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/This bill has no deduction lines/)).toBeInTheDocument();
    expect(optionLabels(screen.getByLabelText('Deduction category 1'))).toEqual(['--']);
  });

  it('refuses to submit without the expected amount when nothing supplies it', async () => {
    render(
      <PayrollDeductionRuleForm scheduledTransactions={[bill()]} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    await pickCategory(0, 'cat-cpp');
    fillMaximum(0, '4034.10');
    await save();
    expect(await screen.findByText('Enter the expected amount per paycheque')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('loads an existing rule as its one row, keeping an entered figure and offering its own category', () => {
    const rule = {
      id: 'r1',
      userId: 'u1',
      scheduledTransactionId: 'st-pay',
      scheduledTransactionName: 'Paycheque',
      categoryId: 'cat-cpp',
      categoryName: 'CPP',
      yearlyMaximum: 4034.1,
      resetPeriod: 'YEARLY' as const,
      resetDate: '2026-01-01',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      nextResetOn: '2027-01-01',
      paidToDate: 0,
      remaining: 4034.1,
      foreignCurrencyRows: 0,
      currencyCode: 'CAD',
      expectedPerPaycheque: 150,
      expectedSource: 'entered' as const,
      createdAt: '',
      updatedAt: '',
    };
    render(
      <PayrollDeductionRuleForm
        rule={rule}
        existingRules={[rule, { ...rule, id: 'r-ei', categoryId: 'cat-ei' }]}
        scheduledTransactions={[bill()]}
        categories={categories}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByLabelText('Deduction category 1')).toHaveValue('cat-cpp');
    expect(optionLabels(screen.getByLabelText('Deduction category 1'))).toEqual(['--', 'CPP']);
    expect(screen.getByLabelText('Yearly maximum')).toHaveValue('4,034.10');
    expect(screen.getByLabelText('Expected per paycheque')).toHaveValue('150.00');
    expect(screen.queryByRole('button', { name: '+ Add another category' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove category/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('the next period (spec section 11)', () => {
    const cppRule = (over: Partial<PayrollDeductionRule> = {}): PayrollDeductionRule => ({
      id: 'r1',
      userId: 'u1',
      scheduledTransactionId: 'st-pay',
      scheduledTransactionName: 'Paycheque',
      categoryId: 'cat-cpp',
      categoryName: 'CPP',
      yearlyMaximum: 4034.1,
      resetPeriod: 'YEARLY',
      resetDate: '2026-01-01',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      nextResetOn: '2027-01-01',
      paidToDate: 3800,
      remaining: 234.1,
      foreignCurrencyRows: 0,
      currencyCode: 'CAD',
      expectedPerPaycheque: 150,
      expectedSource: 'entered',
      createdAt: '',
      updatedAt: '',
      ...over,
    });
    const renderEdit = (rule: PayrollDeductionRule) =>
      render(
        <PayrollDeductionRuleForm
          rule={rule}
          scheduledTransactions={[bill()]}
          categories={categories}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />,
      );
    const fill = (label: string, value: string) => {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    };

    it('opens in the months before the reset and sends next year apart from this year', async () => {
      mockToday = '2026-11-10';
      renderEdit(cppRule());
      expect(screen.getByText(/^Next period, from/)).toBeInTheDocument();
      fill("Next period's maximum", '4230.45');
      fill("Next period's expected per paycheque", '160');
      await save();
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0].lines).toEqual([
        {
          categoryId: 'cat-cpp',
          yearlyMaximum: 4034.1,
          expectedPerPaycheque: 150,
          nextYearlyMaximum: 4230.45,
          nextExpectedPerPaycheque: 160,
        },
      ]);
    });

    it('stays closed outside those months until asked for, and sends nothing for it on a new rule', async () => {
      render(
        <PayrollDeductionRuleForm scheduledTransactions={[bill()]} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />,
      );
      expect(screen.queryByLabelText("Next period's maximum")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Set the figures for the next period/ }));
      expect(screen.getByLabelText("Next period's maximum")).toBeInTheDocument();
      await pickCategory(0, 'cat-ei');
      fillMaximum(0, '1077.48');
      await save();
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0].lines).toEqual([
        { categoryId: 'cat-ei', yearlyMaximum: 1077.48, expectedPerPaycheque: null },
      ]);
    });

    it('sends a next expected amount on its own, the next maximum left as this period\'s', async () => {
      mockToday = '2026-11-10';
      renderEdit(cppRule());
      fill("Next period's expected per paycheque", '160');
      await save();
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0].lines[0]).toMatchObject({
        nextYearlyMaximum: null,
        nextExpectedPerPaycheque: 160,
      });
    });

    it("loads the next period's own figures and drops them when the maximum is cleared", async () => {
      renderEdit(
        cppRule({
          nextPeriod: {
            periodStart: '2027-01-01',
            yearlyMaximum: 4230.45,
            expectedPerPaycheque: 160,
            expectedSource: 'entered',
            scheduled: true,
          },
        }),
      );
      expect(screen.getByLabelText("Next period's maximum")).toHaveValue('4,230.45');
      expect(screen.getByLabelText("Next period's expected per paycheque")).toHaveValue('160.00');
      fill("Next period's maximum", '');
      await save();
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0].lines[0]).toMatchObject({ nextYearlyMaximum: null });
    });
  });
});
