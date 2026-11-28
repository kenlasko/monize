import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { CategoryKeyInfoCard } from './CategoryKeyInfoCard';
import type { Category, CategoryDetail } from '@/types/category';

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    userId: 'user-1',
    parentId: 'cat-food',
    parent: null,
    children: [],
    name: 'Groceries',
    description: 'Weekly food shop',
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    autoSign: null,
    effectiveAutoSign: true,
    categoryType: 'expense',
    isSystem: false,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function detailFixture(overrides: Partial<CategoryDetail> = {}): CategoryDetail {
  return {
    category: category(),
    stats: {
      transactionCount: 24,
      firstTransactionDate: '2024-02-01',
      lastTransactionDate: '2026-07-01',
      payeeCount: 7,
      subcategoryCount: 2,
    },
    accounts: [],
    largestTransaction: {
      id: 'tx-1',
      transactionDate: '2025-12-24',
      amount: -412.5,
      currencyCode: 'CAD',
      accountId: 'acct-1',
      accountName: 'Chequing',
      description: null,
      payeeName: 'Loblaws',
    },
    defaultCategoryForPayees: [],
    ...overrides,
  };
}

function renderCard(detail = detailFixture(), parentName: string | null = 'Food') {
  const onSelectParent = vi.fn();
  const onSelectDate = vi.fn();
  const onSelectPayee = vi.fn();
  render(
    <CategoryKeyInfoCard
      detail={detail}
      parentName={parentName}
      onSelectParent={onSelectParent}
      onSelectDate={onSelectDate}
      onSelectPayee={onSelectPayee}
    />,
  );
  return { onSelectParent, onSelectDate, onSelectPayee };
}

describe('CategoryKeyInfoCard', () => {
  it('shows the reference facts', () => {
    renderCard();
    expect(screen.getByText('Key Information')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Expense')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Weekly food shop')).toBeInTheDocument();
  });

  it('links the parent row to the parent category', () => {
    const { onSelectParent } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    expect(onSelectParent).toHaveBeenCalled();
  });

  it('filters the register to the largest transaction own date', () => {
    const { onSelectDate } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /412\.50/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2025-12-24');
  });

  it('links up to four default-category payees and folds the rest', () => {
    const payees = Array.from({ length: 6 }, (_, index) => ({
      payeeId: `payee-${index}`,
      payeeName: `Payee ${index}`,
    }));
    const { onSelectPayee } = renderCard(
      detailFixture({ defaultCategoryForPayees: payees }),
    );
    expect(screen.getByRole('button', { name: 'Payee 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payee 3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Payee 4' })).toBeNull();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Payee 2' }));
    expect(onSelectPayee).toHaveBeenCalledWith('payee-2');
  });

  it('names every payee without a tail when four or fewer are designated', () => {
    renderCard(
      detailFixture({
        defaultCategoryForPayees: [
          { payeeId: 'payee-1', payeeName: 'Loblaws' },
          { payeeId: 'payee-2', payeeName: 'Metro' },
        ],
      }),
    );
    expect(screen.getByRole('button', { name: 'Loblaws' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Metro' })).toBeInTheDocument();
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it('drops rows that have no value, so a fresh category reads short', () => {
    renderCard(
      detailFixture({
        category: category({ parentId: null, description: null }),
        stats: {
          transactionCount: 0,
          firstTransactionDate: null,
          lastTransactionDate: null,
          payeeCount: 0,
          subcategoryCount: 0,
        },
        largestTransaction: null,
        defaultCategoryForPayees: [],
      }),
      null,
    );
    expect(screen.queryByText('Parent Category')).toBeNull();
    expect(screen.queryByText('Subcategories')).toBeNull();
    expect(screen.queryByText('Payees')).toBeNull();
    expect(screen.queryByText('First Transaction')).toBeNull();
    expect(screen.queryByText('Largest Transaction')).toBeNull();
    expect(screen.queryByText('Default Category For')).toBeNull();
    expect(screen.queryByText('Description')).toBeNull();
    // The facts every category has stay put.
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();
  });
});
