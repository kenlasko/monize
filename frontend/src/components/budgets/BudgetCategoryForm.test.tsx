import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BudgetCategoryForm } from './BudgetCategoryForm';
import type { BudgetCategory } from '@/types/budget';

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
});
