import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BudgetForm } from './BudgetForm';
import type { Budget } from '@/types/budget';

const mockBudget: Budget = {
  id: 'budget-1',
  userId: 'user-1',
  name: 'February 2026',
  description: 'Monthly budget',
  budgetType: 'MONTHLY',
  periodStart: '2026-02-01',
  periodEnd: '2026-02-28',
  baseIncome: 6000,
  incomeLinked: false,
  strategy: 'FIXED',
  isActive: true,
  currencyCode: 'USD',
  config: {},
  categories: [],
  createdAt: '2026-02-01',
  updatedAt: '2026-02-01',
};

describe('BudgetForm', () => {
  it('renders with budget name pre-filled', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nameInput = screen.getByLabelText('Budget Name');
    expect(nameInput).toHaveValue('February 2026');
  });

  it('renders description field', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const descInput = screen.getByLabelText('Description (optional)');
    expect(descInput).toHaveValue('Monthly budget');
  });

  it('calls onSave with updated name', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={handleSave}
        onCancel={vi.fn()}
      />,
    );

    const nameInput = screen.getByLabelText('Budget Name');
    fireEvent.change(nameInput, { target: { value: 'March 2026' } });

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'March 2026' }),
      );
    });
  });

  it('calls onCancel when cancel button is clicked', () => {
    const handleCancel = vi.fn();
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={handleCancel}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(handleCancel).toHaveBeenCalled();
  });

  it('shows saving state', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        isSaving={true}
      />,
    );

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('renders budget type selector', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Budget Type')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  it('renders strategy selector', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Strategy')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
  });

  it('renders base income field', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const incomeInput = screen.getByLabelText('Base Income (optional)');
    expect(incomeInput).toHaveValue('6,000.00');
  });

  it('renders active checkbox', () => {
    render(
      <BudgetForm
        budget={mockBudget}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const checkbox = screen.getByLabelText('Active');
    expect(checkbox).toBeChecked();
  });
});
