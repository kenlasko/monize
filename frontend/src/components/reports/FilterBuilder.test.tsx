import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { FilterBuilder } from './FilterBuilder';
import { FilterGroup } from '@/types/custom-report';

vi.mock('@/lib/categoryUtils', () => ({
  getCategorySelectOptions: () => [
    { value: 'cat-1', label: 'Groceries' },
    { value: 'cat-2', label: 'Transport' },
  ],
}));

const mockAccounts = [
  { id: 'acc-1', name: 'Chequing' },
  { id: 'acc-2', name: 'Savings' },
] as any[];

const mockCategories = [
  { id: 'cat-1', name: 'Groceries' },
  { id: 'cat-2', name: 'Transport' },
] as any[];

const mockPayees = [
  { id: 'pay-1', name: 'Store A' },
  { id: 'pay-2', name: 'Store B' },
] as any[];

const defaultProps = {
  accounts: mockAccounts,
  categories: mockCategories,
  payees: mockPayees,
};

function renderFilterBuilder(
  value: FilterGroup[],
  onChange = vi.fn(),
) {
  const result = render(
    <FilterBuilder
      value={value}
      onChange={onChange}
      {...defaultProps}
    />,
  );
  return { onChange, ...result };
}

describe('FilterBuilder', () => {
  describe('empty state', () => {
    it('renders empty state when no filter groups', () => {
      renderFilterBuilder([]);
      expect(screen.getByText(/No filters/)).toBeInTheDocument();
      expect(screen.getByText('Add filter group')).toBeInTheDocument();
    });

    it('shows "all transactions included" message when empty', () => {
      renderFilterBuilder([]);
      expect(
        screen.getByText('No filters — all transactions included'),
      ).toBeInTheDocument();
    });

    it('does not render "Add AND group" button in empty state', () => {
      renderFilterBuilder([]);
      expect(screen.queryByText('Add AND group')).not.toBeInTheDocument();
    });

    it('does not render "Match any" label in empty state', () => {
      renderFilterBuilder([]);
      expect(screen.queryByText('Match any')).not.toBeInTheDocument();
    });
  });

  describe('adding filter groups', () => {
    it('adds a filter group when button is clicked in empty state', () => {
      const { onChange } = renderFilterBuilder([]);
      fireEvent.click(screen.getByText('Add filter group'));
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: '' }] },
      ]);
    });

    it('adds a new AND group when "Add AND group" button is clicked', () => {
      const existingGroups: FilterGroup[] = [
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ];
      const { onChange } = renderFilterBuilder(existingGroups);
      fireEvent.click(screen.getByText('Add AND group'));
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'category', value: '' }] },
      ]);
    });

    it('adds a new AND group preserving multiple existing groups', () => {
      const existingGroups: FilterGroup[] = [
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ];
      const { onChange } = renderFilterBuilder(existingGroups);
      fireEvent.click(screen.getByText('Add AND group'));
      expect(onChange).toHaveBeenCalledWith([
        ...existingGroups,
        { conditions: [{ field: 'category', value: '' }] },
      ]);
    });
  });

  describe('rendering filter groups with conditions', () => {
    it('renders existing filter groups with conditions', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      expect(screen.getByText('Match any')).toBeInTheDocument();
      expect(screen.getByText('Add OR condition')).toBeInTheDocument();
      expect(screen.getByText('Add AND group')).toBeInTheDocument();
    });

    it('renders AND separator between multiple groups', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      expect(screen.getByText('AND')).toBeInTheDocument();
    });

    it('does not render AND separator when only one group exists', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      expect(screen.queryByText('AND')).not.toBeInTheDocument();
    });

    it('renders OR separator between multiple conditions in a group', () => {
      renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'payee', value: 'pay-1' },
          ],
        },
      ]);
      expect(screen.getByText('OR')).toBeInTheDocument();
    });

    it('does not render OR separator when only one condition in a group', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      expect(screen.queryByText('OR')).not.toBeInTheDocument();
    });

    it('renders multiple "Match any" labels for multiple groups', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      expect(screen.getAllByText('Match any')).toHaveLength(2);
    });

    it('renders multiple AND separators between three groups', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
        { conditions: [{ field: 'payee', value: 'pay-1' }] },
      ]);
      expect(screen.getAllByText('AND')).toHaveLength(2);
    });
  });

  describe('field select dropdown', () => {
    it('renders field select with correct options', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: '' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      // First select is the field dropdown, second is the value dropdown
      const fieldSelect = selects[0];
      const options = within(fieldSelect).getAllByRole('option');
      expect(options).toHaveLength(4);
      expect(options[0]).toHaveTextContent('Account');
      expect(options[1]).toHaveTextContent('Category');
      expect(options[2]).toHaveTextContent('Payee');
      expect(options[3]).toHaveTextContent('Text');
    });

    it('has the correct field selected initially', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      expect(selects[0]).toHaveValue('account');
    });

    it('calls onChange with updated field when field dropdown changes', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'account' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'account', value: '' }] },
      ]);
    });

    it('resets value to empty when field changes', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'payee' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'payee', value: '' }] },
      ]);
    });

    it('does not reset value when field stays the same', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'category' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
    });
  });

  describe('value select/input', () => {
    it('renders a select with account options for account field', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'account', value: '' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      // selects[1] is the value select
      const valueSelect = selects[1];
      const options = within(valueSelect).getAllByRole('option');
      // placeholder + 2 accounts
      expect(options).toHaveLength(3);
      expect(options[0]).toHaveTextContent('Select Account...');
      expect(options[1]).toHaveTextContent('Chequing');
      expect(options[2]).toHaveTextContent('Savings');
    });

    it('renders a select with category options for category field', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'category', value: '' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      const valueSelect = selects[1];
      const options = within(valueSelect).getAllByRole('option');
      // placeholder + 2 categories
      expect(options).toHaveLength(3);
      expect(options[0]).toHaveTextContent('Select Category...');
      expect(options[1]).toHaveTextContent('Groceries');
      expect(options[2]).toHaveTextContent('Transport');
    });

    it('renders a select with payee options for payee field', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'payee', value: '' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      const valueSelect = selects[1];
      const options = within(valueSelect).getAllByRole('option');
      // placeholder + 2 payees
      expect(options).toHaveLength(3);
      expect(options[0]).toHaveTextContent('Select Payee...');
      expect(options[1]).toHaveTextContent('Store A');
      expect(options[2]).toHaveTextContent('Store B');
    });

    it('renders a text input for text field', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'text', value: '' }] },
      ]);
      const input = screen.getByPlaceholderText('Search text...');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'text');
    });

    it('calls onChange with updated value when value select changes', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: '' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[1], { target: { value: 'cat-2' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-2' }] },
      ]);
    });

    it('calls onChange with updated value when text input changes', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'text', value: '' }] },
      ]);
      const input = screen.getByPlaceholderText('Search text...');
      fireEvent.change(input, { target: { value: 'groceries' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'text', value: 'groceries' }] },
      ]);
    });

    it('has correct value selected in value dropdown', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'account', value: 'acc-2' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      expect(selects[1]).toHaveValue('acc-2');
    });

    it('has correct value in text input', () => {
      renderFilterBuilder([
        { conditions: [{ field: 'text', value: 'my search' }] },
      ]);
      const input = screen.getByPlaceholderText('Search text...');
      expect(input).toHaveValue('my search');
    });
  });

  describe('adding conditions', () => {
    it('adds an OR condition within a group', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      fireEvent.click(screen.getByText('Add OR condition'));
      expect(onChange).toHaveBeenCalledWith([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'category', value: '' },
          ],
        },
      ]);
    });

    it('adds an OR condition to the correct group when multiple groups exist', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      // Click the second "Add OR condition" button (belongs to second group)
      const addButtons = screen.getAllByText('Add OR condition');
      fireEvent.click(addButtons[1]);
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        {
          conditions: [
            { field: 'account', value: 'acc-1' },
            { field: 'category', value: '' },
          ],
        },
      ]);
    });

    it('does not modify other groups when adding a condition', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      const addButtons = screen.getAllByText('Add OR condition');
      fireEvent.click(addButtons[0]);
      expect(onChange).toHaveBeenCalledWith([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'category', value: '' },
          ],
        },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
    });
  });

  describe('removing conditions', () => {
    it('removes a condition when remove button is clicked', () => {
      const { onChange } = renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'payee', value: 'pay-1' },
          ],
        },
      ]);
      const removeButtons = screen.getAllByTitle('Remove condition');
      fireEvent.click(removeButtons[0]);
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'payee', value: 'pay-1' }] },
      ]);
    });

    it('removes the second condition when its remove button is clicked', () => {
      const { onChange } = renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'payee', value: 'pay-1' },
          ],
        },
      ]);
      const removeButtons = screen.getAllByTitle('Remove condition');
      fireEvent.click(removeButtons[1]);
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
    });

    it('removes the entire group when last condition is removed', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      const removeButton = screen.getByTitle('Remove condition');
      fireEvent.click(removeButton);
      expect(onChange).toHaveBeenCalledWith([]);
    });

    it('removes only the target group when last condition removed from one of multiple groups', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      // Remove condition from first group
      const removeButtons = screen.getAllByTitle('Remove condition');
      fireEvent.click(removeButtons[0]);
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
    });
  });

  describe('removing groups', () => {
    it('removes a group when "Remove group" button is clicked', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      const removeGroupButton = screen.getByTitle('Remove group');
      fireEvent.click(removeGroupButton);
      expect(onChange).toHaveBeenCalledWith([]);
    });

    it('removes the correct group from multiple groups', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      const removeGroupButtons = screen.getAllByTitle('Remove group');
      fireEvent.click(removeGroupButtons[0]);
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
    });

    it('removes the second group when its remove button is clicked', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      const removeGroupButtons = screen.getAllByTitle('Remove group');
      fireEvent.click(removeGroupButtons[1]);
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
    });
  });

  describe('updating conditions in multi-group scenarios', () => {
    it('updates the correct condition field in the correct group', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'account', value: 'acc-1' }] },
      ]);
      // Change the field of the second group's condition
      const fieldSelects = screen.getAllByRole('combobox');
      // fieldSelects: [group0-field, group0-value, group1-field, group1-value]
      fireEvent.change(fieldSelects[2], { target: { value: 'payee' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
        { conditions: [{ field: 'payee', value: '' }] },
      ]);
    });

    it('updates the correct condition value in the correct group', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: '' }] },
        { conditions: [{ field: 'account', value: '' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      // selects: [group0-field, group0-value, group1-field, group1-value]
      fireEvent.change(selects[3], { target: { value: 'acc-2' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'category', value: '' }] },
        { conditions: [{ field: 'account', value: 'acc-2' }] },
      ]);
    });

    it('updates the correct condition in a group with multiple conditions', () => {
      const { onChange } = renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: '' },
            { field: 'payee', value: '' },
          ],
        },
      ]);
      const selects = screen.getAllByRole('combobox');
      // selects: [cond0-field, cond0-value, cond1-field, cond1-value]
      fireEvent.change(selects[3], { target: { value: 'pay-2' } });
      expect(onChange).toHaveBeenCalledWith([
        {
          conditions: [
            { field: 'category', value: '' },
            { field: 'payee', value: 'pay-2' },
          ],
        },
      ]);
    });
  });

  describe('complex scenarios', () => {
    it('renders multiple conditions with OR separators', () => {
      renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'category', value: 'cat-2' },
            { field: 'payee', value: 'pay-1' },
          ],
        },
      ]);
      expect(screen.getAllByText('OR')).toHaveLength(2);
    });

    it('renders multiple groups each with multiple conditions', () => {
      renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'payee', value: 'pay-1' },
          ],
        },
        {
          conditions: [
            { field: 'account', value: 'acc-1' },
            { field: 'account', value: 'acc-2' },
          ],
        },
      ]);
      expect(screen.getAllByText('Match any')).toHaveLength(2);
      expect(screen.getByText('AND')).toBeInTheDocument();
      expect(screen.getAllByText('OR')).toHaveLength(2);
      expect(screen.getAllByText('Add OR condition')).toHaveLength(2);
      expect(screen.getAllByTitle('Remove group')).toHaveLength(2);
      expect(screen.getAllByTitle('Remove condition')).toHaveLength(4);
    });

    it('handles text condition alongside entity conditions', () => {
      renderFilterBuilder([
        {
          conditions: [
            { field: 'category', value: 'cat-1' },
            { field: 'text', value: 'rent' },
          ],
        },
      ]);
      // Should have field selects (2) + value select for category (1)
      // Text field renders input instead of select
      const selects = screen.getAllByRole('combobox');
      expect(selects).toHaveLength(3); // field0, value0, field1
      const input = screen.getByPlaceholderText('Search text...');
      expect(input).toHaveValue('rent');
    });

    it('handles switching from entity field to text field', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'text' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'text', value: '' }] },
      ]);
    });

    it('handles switching from text field to entity field', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'text', value: 'search term' }] },
      ]);
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'account' } });
      expect(onChange).toHaveBeenCalledWith([
        { conditions: [{ field: 'account', value: '' }] },
      ]);
    });
  });

  describe('onChange callback correctness', () => {
    it('does not mutate the original value array', () => {
      const originalGroups: FilterGroup[] = [
        { conditions: [{ field: 'category', value: 'cat-1' }] },
      ];
      const frozen = Object.freeze(
        originalGroups.map((g) =>
          Object.freeze({ ...g, conditions: Object.freeze([...g.conditions]) }),
        ),
      );
      const onChange = vi.fn();
      render(
        <FilterBuilder
          value={frozen as unknown as FilterGroup[]}
          onChange={onChange}
          {...defaultProps}
        />,
      );
      fireEvent.click(screen.getByText('Add AND group'));
      // Original should not be mutated
      expect(frozen).toHaveLength(1);
      // onChange should receive a new array
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0]).toHaveLength(2);
    });

    it('calls onChange exactly once per user action', () => {
      const { onChange } = renderFilterBuilder([
        { conditions: [{ field: 'category', value: '' }] },
      ]);
      fireEvent.click(screen.getByText('Add OR condition'));
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });
});
