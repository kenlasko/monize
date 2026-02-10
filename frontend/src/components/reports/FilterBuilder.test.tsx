import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { FilterBuilder } from './FilterBuilder';

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

describe('FilterBuilder', () => {
  it('renders empty state when no filter groups', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={[]}
        onChange={onChange}
        accounts={mockAccounts}
        categories={mockCategories}
        payees={mockPayees}
      />
    );
    expect(screen.getByText(/No filters/)).toBeInTheDocument();
    expect(screen.getByText('Add filter group')).toBeInTheDocument();
  });

  it('adds a filter group when button is clicked', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={[]}
        onChange={onChange}
        accounts={mockAccounts}
        categories={mockCategories}
        payees={mockPayees}
      />
    );
    fireEvent.click(screen.getByText('Add filter group'));
    expect(onChange).toHaveBeenCalledWith([
      { conditions: [{ field: 'category', value: '' }] },
    ]);
  });

  it('renders existing filter groups with conditions', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={[
          { conditions: [{ field: 'category', value: 'cat-1' }] },
        ]}
        onChange={onChange}
        accounts={mockAccounts}
        categories={mockCategories}
        payees={mockPayees}
      />
    );
    expect(screen.getByText('Match any')).toBeInTheDocument();
    expect(screen.getByText('Add OR condition')).toBeInTheDocument();
    expect(screen.getByText('Add AND group')).toBeInTheDocument();
  });

  it('renders AND separator between multiple groups', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={[
          { conditions: [{ field: 'category', value: 'cat-1' }] },
          { conditions: [{ field: 'account', value: 'acc-1' }] },
        ]}
        onChange={onChange}
        accounts={mockAccounts}
        categories={mockCategories}
        payees={mockPayees}
      />
    );
    expect(screen.getByText('AND')).toBeInTheDocument();
  });
});
