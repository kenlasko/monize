import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { CategoryList } from './CategoryList';
import { Category } from '@/types/category';
import { useDensityStore } from '@/store/densityStore';

/**
 * On a phone the density toggle picks the LAYOUT: at Normal density each
 * category is a wrapped card in a single `<td>`, which is how the Type and
 * Count this table hides below `sm` / `md` get back on screen; Compact and
 * Dense keep the tier table, and so does every wider screen. The rest of the
 * list's suite runs under the harness's default `matchMedia` (no match), so
 * it exercises the tier table.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/categories',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getTransactionCount: vi.fn().mockResolvedValue(0),
    reassignTransactions: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const PHONE_QUERY = '(max-width: 639px)';
const originalMatchMedia = window.matchMedia;

/** Answer `true` only for the phone query `useIsMobile` asks. */
function setPhoneViewport(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function makeCategory(overrides: Partial<Category> & { id: string; name: string }): Category {
  return {
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    autoSign: null,
    effectiveAutoSign: true,
    categoryType: 'expense',
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    transactionCount: 0,
    ...overrides,
  };
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

describe('the categories list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each category as a wrapped card carrying the type and count at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { categories: 'normal' } });

    const { container } = render(
      <CategoryList
        categories={[
          makeCategory({ id: 'c1', name: 'Salary', categoryType: 'income', transactionCount: 12, description: 'Paycheque' }),
        ]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);
    expect(within(rows[0]).getByText('Salary')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Income')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Count')).toBeInTheDocument();
    expect(within(rows[0]).getByText('12')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Paycheque')).toBeInTheDocument();
    // The row actions move to the long-press sheet.
    expect(within(rows[0]).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('reaches Edit and Delete through the action sheet the card sends them to', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { categories: 'normal' } });

    const { container } = render(
      <CategoryList categories={[makeCategory({ id: 'c1', name: 'Food' })]} onEdit={vi.fn()} onRefresh={vi.fn()} />,
    );

    fireEvent.contextMenu(bodyRows(container)[0]);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps every sort field reachable from a slim header that announces the direction', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { categories: 'normal' } });
    const onSort = vi.fn();

    render(
      <CategoryList
        categories={[makeCategory({ id: 'c1', name: 'Food' })]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        sortField="type"
        sortDirection="desc"
        onSort={onSort}
      />,
    );

    const header = screen.getAllByRole('columnheader');
    expect(header).toHaveLength(1);
    expect(header[0]).toHaveAttribute('aria-sort', 'descending');
    const buttons = within(header[0]).getAllByRole('button');
    expect(buttons.map((b) => (b.textContent ?? '').replace(/[^A-Za-z]/g, ''))).toEqual(['Name', 'Type', 'Count']);
    fireEvent.click(buttons[2]);
    expect(onSort).toHaveBeenCalledWith('count');
  });

  it('keeps the tier table on a phone at Compact density, and on a wide screen', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { categories: 'compact' } });
    const { container, unmount } = render(
      <CategoryList categories={[makeCategory({ id: 'c1', name: 'Food' })]} onEdit={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(bodyRows(container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
    unmount();

    setPhoneViewport(false);
    useDensityStore.setState({ densities: { categories: 'normal' } });
    const wide = render(
      <CategoryList categories={[makeCategory({ id: 'c1', name: 'Food' })]} onEdit={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(bodyRows(wide.container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });
});
