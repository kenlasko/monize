import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
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

  describe('transfers in as income (issue #2141)', () => {
    const label = 'Count transfers in from excluded accounts as income';

    it('keeps the other config keys when the option changes', async () => {
      const handleSave = vi.fn().mockResolvedValue(undefined);
      render(
        <BudgetForm
          budget={{ ...mockBudget, config: { excludedAccountIds: ['acc-hisa'] } }}
          onSave={handleSave}
          onCancel={vi.fn()}
        />,
      );

      const toggle = screen.getByLabelText(label);
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      fireEvent.click(screen.getByText('Save Changes'));

      await waitFor(() => {
        expect(handleSave).toHaveBeenCalledWith(
          expect.objectContaining({
            config: { excludedAccountIds: ['acc-hisa'], transfersInAsIncome: true },
          }),
        );
      });
    });

    it('sends no config when the option is unchanged', async () => {
      const handleSave = vi.fn().mockResolvedValue(undefined);
      render(
        <BudgetForm
          budget={{
            ...mockBudget,
            config: { excludedAccountIds: ['acc-hisa'], transfersInAsIncome: true },
          }}
          onSave={handleSave}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.getByLabelText(label)).toBeChecked();
      fireEvent.click(screen.getByText('Save Changes'));

      await waitFor(() => expect(handleSave).toHaveBeenCalled());
      expect(handleSave.mock.calls[0][0]).not.toHaveProperty('config');
    });

    it('warns that nothing counts while no account is excluded', () => {
      render(
        <BudgetForm
          budget={{ ...mockBudget, config: { transfersInAsIncome: true } }}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(
        screen.getByText('This budget excludes no account yet, so nothing is counted.'),
      ).toBeInTheDocument();
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

    // `<Button isLoading>` keeps the fixed label and shows progress with its
    // spinner; the label no longer swaps to "Saving...".
    const save = screen.getByRole('button', { name: /Save Changes/ });
    expect(save).toBeDisabled();
    expect(save.querySelector('svg.animate-spin')).not.toBeNull();
    expect(screen.queryByText('Saving...')).toBeNull();
    // Cancel is outline and first, the primary last, as `FormActions` lays out.
    const buttons = screen.getAllByRole('button');
    expect(buttons[buttons.length - 2]).toHaveTextContent('Cancel');
    expect(buttons[buttons.length - 1]).toBe(save);
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

  it('handles null description gracefully (defaults to empty string)', () => {
    const budgetNoDesc = { ...mockBudget, description: null } as any;
    render(<BudgetForm budget={budgetNoDesc} onSave={vi.fn()} onCancel={vi.fn()} />);
    const descInput = screen.getByLabelText('Description (optional)');
    expect(descInput).toHaveValue('');
  });

  it('handles null baseIncome gracefully', () => {
    const budgetNoIncome = { ...mockBudget, baseIncome: null } as any;
    render(<BudgetForm budget={budgetNoIncome} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Budget Name')).toBeInTheDocument();
  });

  it('passes undefined description when field is empty on submit', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    const budgetNoDesc = { ...mockBudget, description: '' } as any;
    render(<BudgetForm budget={budgetNoDesc} onSave={handleSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
    });
  });

  it('submits the trimmed name, type, strategy and base income', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    render(<BudgetForm budget={mockBudget} onSave={handleSave} onCancel={vi.fn()} />);

    const nameInput = screen.getByLabelText('Budget Name');
    fireEvent.change(nameInput, { target: { value: '  Trimmed Budget  ' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Trimmed Budget',
          budgetType: 'MONTHLY',
          strategy: 'FIXED',
          baseIncome: 6000,
        }),
      );
    });
  });

  it('submits a trimmed description when one is provided', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    render(<BudgetForm budget={mockBudget} onSave={handleSave} onCancel={vi.fn()} />);

    const descInput = screen.getByLabelText('Description (optional)');
    fireEvent.change(descInput, { target: { value: '  spending plan  ' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'spending plan' }),
      );
    });
  });

  it('submits the selected budget type and strategy after changing them', async () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    render(<BudgetForm budget={mockBudget} onSave={handleSave} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Monthly'), {
      target: { value: 'ANNUAL' },
    });
    fireEvent.change(screen.getByDisplayValue('Fixed'), {
      target: { value: 'ZERO_BASED' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Changes'));
    });

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({ budgetType: 'ANNUAL', strategy: 'ZERO_BASED' }),
      );
    });
  });

  it('renders all strategy options', () => {
    render(<BudgetForm budget={mockBudget} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Rollover')).toBeInTheDocument();
    expect(screen.getByText('Zero-Based')).toBeInTheDocument();
    expect(screen.getByText('50/30/20')).toBeInTheDocument();
    expect(screen.getByText('Bucket')).toBeInTheDocument();
  });

  it('renders all budget type options', () => {
    render(<BudgetForm budget={mockBudget} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Annual')).toBeInTheDocument();
    expect(screen.getByText('Pay Period')).toBeInTheDocument();
  });
});
