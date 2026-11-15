import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BudgetCategoryForm } from './BudgetCategoryForm';
import type { BudgetBucket, BudgetCategory, BudgetStrategy } from '@/types/budget';

const mockCategory: BudgetCategory = {
  id: 'bc-1',
  budgetId: 'budget-1',
  categoryId: 'cat-1',
  category: { id: 'cat-1', name: 'Groceries', isIncome: false },
  categoryGroup: null,
  bucketId: null,
  transferAccountId: null,
  transferAccount: null,
  isTransfer: false,
  amount: 600,
  isIncome: false,
  rolloverType: 'NONE',
  rolloverCap: null,
  flexGroup: null,
  alertWarnPercent: 80,
  alertCriticalPercent: 95,
  notes: null,
  sortOrder: 0,
  createdAt: '2026-02-01',
  updatedAt: '2026-02-01',
};

describe('BudgetCategoryForm', () => {
  describe('on a transfer income line', () => {
    const transferIncomeLine: BudgetCategory = {
      ...mockCategory,
      categoryId: null,
      category: null,
      isTransfer: true,
      isIncome: true,
      transferAccountId: 'acct-hisa',
      transferAccount: { id: 'acct-hisa', name: 'HISA' } as BudgetCategory['transferAccount'],
    };

    it('titles the dialog with the line name', () => {
      render(
        <BudgetCategoryForm
          category={transferIncomeLine}
          currencyCode="CAD"
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.getByText('Edit: Transfers from HISA')).toBeInTheDocument();
    });

    it('does not offer the need / want / saving group', () => {
      render(
        <BudgetCategoryForm
          category={transferIncomeLine}
          currencyCode="CAD"
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.queryByText('Category Group (50/30/20)')).not.toBeInTheDocument();
    });
  });

  it('titles an outgoing transfer line with its account', () => {
    render(
      <BudgetCategoryForm
        category={{
          ...mockCategory,
          categoryId: null,
          category: null,
          isTransfer: true,
          transferAccountId: 'acct-hisa',
          transferAccount: { id: 'acct-hisa', name: 'HISA' } as BudgetCategory['transferAccount'],
        }}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Edit: HISA')).toBeInTheDocument();
    expect(screen.getByText('Category Group (50/30/20)')).toBeInTheDocument();
  });

  it('renders with category name', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Edit: Groceries')).toBeInTheDocument();
  });

  it('renders form fields with initial values', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const amountInput = screen.getByLabelText('Budget Amount');
    expect(amountInput).toHaveValue('600.00');
  });

  it('calls onSave with updated data on submit', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={handleSave}
        onCancel={vi.fn()}
      />,
    );

    const amountInput = screen.getByLabelText('Budget Amount');
    fireEvent.change(amountInput, { target: { value: '700' } });

    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 700 }),
      );
    });
  });

  it('calls onCancel when cancel button is clicked', () => {
    const handleCancel = vi.fn();
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={handleCancel}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(handleCancel).toHaveBeenCalled();
  });

  it('shows saving state', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
        isSaving={true}
      />,
    );

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('shows rollover cap field when rollover type is not NONE', () => {
    const categoryWithRollover = {
      ...mockCategory,
      rolloverType: 'MONTHLY' as const,
    };

    render(
      <BudgetCategoryForm
        category={categoryWithRollover}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Rollover Cap (optional)')).toBeInTheDocument();
  });

  it('hides rollover cap field when rollover type is NONE', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Rollover Cap (optional)')).not.toBeInTheDocument();
  });

  it('renders flex group input', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Flex Group (optional)')).toBeInTheDocument();
  });

  it('renders alert threshold inputs', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Warning at (%)')).toBeInTheDocument();
    expect(screen.getByLabelText('Critical at (%)')).toBeInTheDocument();
  });

  it('offers no remove action unless the caller can remove the line', () => {
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Remove from budget' })).not.toBeInTheDocument();
  });

  it('calls onRemove without saving when the remove action is clicked', () => {
    const handleRemove = vi.fn();
    const handleSave = vi.fn();
    render(
      <BudgetCategoryForm
        category={mockCategory}
        currencyCode="CAD"
        onSave={handleSave}
        onCancel={vi.fn()}
        onRemove={handleRemove}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove from budget' }));
    expect(handleRemove).toHaveBeenCalledTimes(1);
    expect(handleSave).not.toHaveBeenCalled();
  });

  describe('bucket select', () => {
    const buckets: BudgetBucket[] = [
      {
        id: 'bk-1',
        budgetId: 'budget-1',
        name: 'Fixed costs',
        targetType: 'PERCENT',
        targetValue: 50,
        carryOver: false,
        carryCap: null,
        sortOrder: 0,
        createdAt: '2026-11-01',
        updatedAt: '2026-11-01',
      },
      {
        id: 'bk-2',
        budgetId: 'budget-1',
        name: 'Savings',
        targetType: 'PERCENT',
        targetValue: 20,
        carryOver: true,
        carryCap: null,
        sortOrder: 1,
        createdAt: '2026-11-01',
        updatedAt: '2026-11-01',
      },
    ];

    const renderLine = (
      category: BudgetCategory,
      strategy: BudgetStrategy | undefined,
      handleSave = vi.fn().mockResolvedValue(undefined),
    ) => {
      render(
        <BudgetCategoryForm
          category={category}
          currencyCode="CAD"
          onSave={handleSave}
          onCancel={vi.fn()}
          strategy={strategy}
          buckets={buckets}
        />,
      );
      return handleSave;
    };

    it.each<BudgetStrategy | undefined>(['FIXED', 'FIFTY_THIRTY_TWENTY', 'ZERO_BASED', undefined])(
      'is not offered for a %s budget, and the save sends no bucketId',
      async (strategy) => {
        const handleSave = renderLine(mockCategory, strategy);
        expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(handleSave).toHaveBeenCalled());
        expect(handleSave.mock.calls[0][0]).not.toHaveProperty('bucketId');
      },
    );

    it('is not offered for an income line of a Bucket budget', async () => {
      const handleSave = renderLine({ ...mockCategory, isIncome: true }, 'BUCKET');
      expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(handleSave).toHaveBeenCalled());
      expect(handleSave.mock.calls[0][0]).not.toHaveProperty('bucketId');
    });

    it('lists Unassigned and the budget buckets for an expense line of a Bucket budget', () => {
      renderLine({ ...mockCategory, bucketId: 'bk-2' }, 'BUCKET');
      const select = screen.getByLabelText('Bucket');

      expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
        'Unassigned',
        'Fixed costs',
        'Savings',
      ]);
      expect(select).toHaveValue('bk-2');
    });

    it('sends the chosen bucket id', async () => {
      const handleSave = renderLine(mockCategory, 'BUCKET');
      fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'bk-1' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(handleSave).toHaveBeenCalledWith(expect.objectContaining({ bucketId: 'bk-1' })));
    });

    it('sends null when the line is moved to Unassigned', async () => {
      const handleSave = renderLine({ ...mockCategory, bucketId: 'bk-2' }, 'BUCKET');
      fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: '' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(handleSave).toHaveBeenCalledWith(expect.objectContaining({ bucketId: null })));
    });

    it('leaves the 50/30/20 group select as it is', () => {
      renderLine(mockCategory, 'BUCKET');
      expect(screen.getByText('Category Group (50/30/20)')).toBeInTheDocument();
    });
  });
});
