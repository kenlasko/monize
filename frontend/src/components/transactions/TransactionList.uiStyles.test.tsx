import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@/test/render';
import { TransactionList } from './TransactionList';
import { Transaction, TransactionStatus } from '@/types/transaction';

/**
 * The register under the Classic and Modern UI styles. Standard is covered by
 * the rest of the register's suite; these pin what each style adds: Classic's
 * date group rows, Payment / Deposit split and totals footer; Modern's day
 * blocks and the selected-row inspector with the actions a row already has.
 */

const style = vi.hoisted(() => ({ value: 'standard' as 'standard' | 'classic' | 'modern' }));
vi.mock('@/hooks/useUiStyle', () => ({ useUiStyle: () => style.value }));
vi.mock('@/hooks/useIsMobile', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useIsMobile')>()),
  useIsLgUp: () => true,
}));
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { delete: vi.fn(), deleteTransfer: vi.fn(), updateStatus: vi.fn() },
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    dateFormat: 'browser',
    datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => d,
    formatDateWithoutYear: (d: Date | string) => String(d).slice(5),
  }),
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    }),
  };
});

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    userId: 'u',
    accountId: 'acc-1',
    account: { id: 'acc-1', name: 'Chequing', accountType: 'CHEQUING' } as any,
    transactionDate: '2024-01-15',
    payeeId: null,
    payeeName: 'Grocery Store',
    payee: null,
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries', color: '#22c55e' } as any,
    amount: -50,
    currencyCode: 'CAD',
    exchangeRate: 1,
    originalAmount: null,
    originalCurrencyCode: null,
    description: 'Weekly shop',
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    createdAt: '2024-01-15T00:00:00Z',
    updatedAt: '2024-01-15T00:00:00Z',
    ...overrides,
  };
}

const rows = [
  makeTx({ id: 'a', transactionDate: '2024-01-16', amount: 200, payeeName: 'Employer', description: 'Pay' }),
  makeTx({ id: 'b', transactionDate: '2024-01-15', amount: -50 }),
  makeTx({ id: 'c', transactionDate: '2024-01-15', amount: -25, payeeName: 'Cafe', description: '' }),
];
const dateSort = { field: 'date', direction: 'desc' } as const;

function renderList(extra: Record<string, unknown> = {}) {
  return render(
    <TransactionList
      transactions={rows}
      isSingleAccountView
      startingBalance={1000}
      sort={dateSort}
      rowsSort={dateSort}
      onSortChange={vi.fn()}
      onEdit={vi.fn()}
      onDuplicate={vi.fn()}
      onDeleted={vi.fn()}
      {...extra}
    />,
  );
}

describe('Standard', () => {
  beforeEach(() => {
    style.value = 'standard';
  });

  it('draws the single Amount column and a Date cell, with no group rows or footer', () => {
    const { container } = renderList();
    expect(container.querySelector('.ui-register')).toBeNull();
    expect(container.querySelector('th[scope="colgroup"]')).toBeNull();
    expect(container.querySelector('tfoot')).toBeNull();
    expect(screen.getAllByText('2024-01-15').length).toBeGreaterThan(0);
  });
});

describe('Classic register', () => {
  beforeEach(() => {
    style.value = 'classic';
  });

  it('groups entries under a date row instead of a Date column', () => {
    const { container } = renderList();
    const groups = container.querySelectorAll('th[scope="colgroup"]');
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toMatch(/Tuesday, January 16/);
    expect(screen.queryByText('2024-01-15')).toBeNull();
  });

  it.each([
    ['one account', true],
    ['every account', false],
  ])('draws a header cell for every row cell, so no column shifts (%s)', (_label, single) => {
    // Classic draws no Description cell; a header that still drew one pushed
    // every later column one to the left.
    const { container } = renderList({ isSingleAccountView: single });
    const headerCells = container.querySelectorAll('thead tr:last-child > th').length;
    const rowsDrawn = container.querySelectorAll('tbody tr.ui-register-row');
    expect(rowsDrawn.length).toBeGreaterThan(0);
    rowsDrawn.forEach((row) => expect(row.children).toHaveLength(headerCells));
    expect(container.querySelector('thead')?.textContent).not.toMatch(/Description/i);
  });

  it('splits the signed amount into Payment and Deposit', () => {
    const { container } = renderList();
    const body = container.querySelectorAll('tbody tr.ui-register-row');
    expect(body[0].querySelector('.ui-register-deposit')?.textContent).toBe('$200.00');
    expect(body[0].querySelector('.ui-register-payment')?.textContent).toBe('');
    expect(body[1].querySelector('.ui-register-payment')?.textContent).toBe('$50.00');
    expect(body[1].querySelector('.ui-register-deposit')?.textContent).toBe('');
  });

  it('prints balances from the running-balance walk with a rule under each', () => {
    const { container } = renderList();
    const cells = Array.from(container.querySelectorAll('.ui-register-balance')) as HTMLElement[];
    expect(cells[0].textContent).toBe('$1000.00');
    expect(cells[0].style.backgroundSize).toBe('100% 2px');
  });

  it('totals the page in a footer', () => {
    const { container } = renderList();
    const foot = container.querySelector('tfoot') as HTMLElement;
    expect(within(foot).getByText('$75.00')).toBeTruthy();
    expect(within(foot).getByText('$200.00')).toBeTruthy();
  });

  it('keeps the Date column when the register is not in date order', () => {
    const payeeSort = { field: 'payee', direction: 'asc' } as const;
    const { container } = renderList({ sort: payeeSort, rowsSort: payeeSort });
    expect(container.querySelector('th[scope="colgroup"]')).toBeNull();
    expect(container.querySelector('tfoot')).toBeNull();
  });
});

describe('Modern register', () => {
  beforeEach(() => {
    style.value = 'modern';
  });

  it('draws day blocks of rows instead of a table body', () => {
    const { container } = renderList();
    expect(container.querySelectorAll('[data-testid="modern-row"]')).toHaveLength(3);
    expect(container.querySelector('tbody')).toBeNull();
  });

  it('labels the inspector region and shows the first row until another is clicked', () => {
    renderList();
    const inspector = screen.getByRole('complementary', { name: 'Selected transaction' });
    expect(within(inspector).getByText('Employer')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('modern-row')[1]);
    expect(within(screen.getByRole('complementary')).getByText('Grocery Store')).toBeTruthy();
  });

  it('offers the actions a row already has', () => {
    const onEdit = vi.fn();
    renderList({ onEdit });
    const inspector = screen.getByRole('complementary');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(within(inspector).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(inspector).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('is reachable from the keyboard', () => {
    renderList();
    const row = screen.getAllByTestId('modern-row')[2];
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(within(screen.getByRole('complementary')).getByText('Cafe')).toBeTruthy();
  });
});
