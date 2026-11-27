import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { CategorySubcategoriesTab } from './CategorySubcategoriesTab';
import type { SubcategoryShare } from '@/lib/categoryUtils';
import type { Category } from '@/types/category';

function category(
  id: string,
  name: string,
  overrides: Partial<Category> = {},
): Category {
  return {
    id,
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name,
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    autoSign: null,
    effectiveAutoSign: true,
    categoryType: 'expense',
    isSystem: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const parent = category('cat-1', 'Food');
const alpha = category('child-a', 'Alpha', { parentId: 'cat-1' });
const beta = category('child-b', 'Beta', { parentId: 'cat-1' });
const yak = category('child-y', 'Yak', { parentId: 'cat-1' });
const zed = category('child-z', 'Zed', { parentId: 'cat-1' });
// Not a child of cat-1; must never appear in the table.
const stranger = category('cat-other', 'Stranger');

const categories = [parent, alpha, beta, yak, zed, stranger];

const shares: SubcategoryShare[] = [
  { id: 'child-a', name: 'Alpha', total: -200, count: 2, share: 0.2 },
  { id: 'child-b', name: 'Beta', total: -500, count: 5, share: 0.5 },
  // The self bucket has no row of its own in this table.
  { id: 'cat-1', name: null, total: -300, count: 3, share: 0.3 },
];

function renderTab(
  overrides: { categories?: Category[]; shares?: SubcategoryShare[] } = {},
) {
  const onSelectChild = vi.fn();
  const { container } = render(
    <CategorySubcategoriesTab
      category={parent}
      categories={overrides.categories ?? categories}
      shares={overrides.shares ?? shares}
      currencyCode="CAD"
      onSelectChild={onSelectChild}
    />,
  );
  return { onSelectChild, container };
}

function rowTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map(
    (row) => row.textContent ?? '',
  );
}

describe('CategorySubcategoriesTab', () => {
  it('renders one row per direct child, and nothing else', () => {
    const { container } = renderTab();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
    expect(screen.queryByText('Stranger')).toBeNull();
    // The self bucket is not a subcategory.
    expect(screen.queryByText('This category')).toBeNull();
  });

  it('orders children largest first, then unused ones alphabetically', () => {
    const { container } = renderTab();
    const rows = rowTexts(container);
    expect(rows[0]).toContain('Beta');
    expect(rows[1]).toContain('Alpha');
    expect(rows[2]).toContain('Yak');
    expect(rows[3]).toContain('Zed');
  });

  it('shows the subtree total and count for a used child', () => {
    const { container } = renderTab();
    const betaRow = rowTexts(container)[0];
    expect(betaRow).toMatch(/500\.00/);
    expect(betaRow).toContain('5');
  });

  it('shows em dashes for a never-used child, not measured zeros', () => {
    const { container } = renderTab();
    const yakRow = Array.from(container.querySelectorAll('tbody tr'))[2];
    const cells = Array.from(yakRow.querySelectorAll('td'));
    expect(cells[1].textContent).toBe('—');
    expect(cells[2].textContent).toBe('—');
  });

  it('opens a child from its row', () => {
    const { onSelectChild } = renderTab();
    fireEvent.click(screen.getByText('Alpha').closest('tr') as HTMLElement);
    expect(onSelectChild).toHaveBeenCalledWith('child-a');
  });

  it('says when the category has no subcategories', () => {
    renderTab({ categories: [parent, stranger], shares: [] });
    expect(screen.getByText('This category has no subcategories')).toBeInTheDocument();
  });
});
