import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@/test/render';
import { TransactionList } from './TransactionList';
import { useDensityStore } from '@/store/densityStore';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';
import { useAuthStore } from '@/store/authStore';

/**
 * The register under the Folio and Pebble UI styles. Standard is covered by
 * the rest of the register's suite; these pin what each style adds: Folio's
 * date group rows, Payment / Deposit split and totals footer; Pebble's day
 * blocks and the selected-row inspector with the actions a row already has.
 */

const style = vi.hoisted(() => ({ value: 'standard' as 'standard' | 'folio' | 'pebble' }));
// Counts the row figures (not the inspector's `display` one) drawn, so a test
// can tell which rows re-rendered.
const rowFigureRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ui/MoneyFigure', async (orig) => {
  const actual = await orig<typeof import('@/components/ui/MoneyFigure')>();
  return {
    ...actual,
    MoneyFigure: (props: Parameters<typeof actual.MoneyFigure>[0]) => {
      if (!props.display) rowFigureRenders.count += 1;
      return actual.MoneyFigure(props);
    },
  };
});
vi.mock('@/hooks/useUiStyle', () => ({ useUiStyle: () => style.value }));
// A phone width, for the wrapped Folio card; the inspector stays lg-up.
const phone = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useIsMobile')>()),
  useIsMobile: () => phone.value,
  useIsLgUp: () => true,
}));
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { delete: vi.fn(), deleteTransfer: vi.fn(), updateStatus: vi.fn() },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { deleteTransaction: vi.fn() },
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

describe('Folio register', () => {
  beforeEach(() => {
    style.value = 'folio';
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
    // Folio draws no Description cell; a header that still drew one pushed
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

  it('converts an all-accounts page into the default currency before totalling it', () => {
    const { container } = renderList({
      isSingleAccountView: false,
      startingBalance: undefined,
      transactions: [
        // The server's factor for the row's own date: 100 USD was 150 CAD.
        makeTx({ id: 'u', amount: -100, currencyCode: 'USD', reportingCurrencyCode: 'CAD', reportingRate: 1.5 }),
        makeTx({ id: 'k', amount: -30, reportingCurrencyCode: 'CAD', reportingRate: 1 }),
      ],
    });
    const foot = container.querySelector('tfoot') as HTMLElement;
    // 100 USD is 150 CAD; adding the two face values would say 130.
    expect(within(foot).getByText('$180.00')).toBeTruthy();
    expect(within(foot).queryByTestId('partial-total-marker')).toBeNull();
  });

  it('marks the footer partial when a currency on the page has no rate', () => {
    const { container } = renderList({
      isSingleAccountView: false,
      startingBalance: undefined,
      transactions: [
        makeTx({ id: 'j', amount: -5000, currencyCode: 'JPY', reportingCurrencyCode: 'CAD', reportingRate: null }),
        makeTx({ id: 'k', amount: -30, reportingCurrencyCode: 'CAD', reportingRate: 1 }),
      ],
    });
    const foot = container.querySelector('tfoot') as HTMLElement;
    expect(within(foot).getByText('$30.00')).toBeTruthy();
    expect(within(foot).getAllByTestId('partial-total-marker').length).toBeGreaterThan(0);
  });

  it.each([
    ['one account', { isSingleAccountView: true }],
    ['every account', { isSingleAccountView: false }],
    ['selecting', { selectionMode: true, selectedIds: new Set<string>() }],
  ])('lays the footer out cell for cell under the rows, tier classes and all (%s)', (_label, extra) => {
    // The container tiers hide columns with a class, so a footer that spanned
    // colCount columns put the totals under Status and Actions at mid widths
    // and past the table's edge on a phone (#2305).
    const { container } = renderList(extra);
    const tiers = (cell: Element) =>
      Array.from(cell.classList).filter((c) => c === 'hidden' || c.startsWith('@min-')).join(' ');
    const row = Array.from(container.querySelector('tbody tr.ui-register-row')!.children);
    const foot = Array.from(container.querySelector('tfoot tr')!.children);
    expect(foot.map(tiers)).toEqual(row.map(tiers));
    foot.forEach((cell) => expect((cell as HTMLTableCellElement).colSpan).toBe(1));
    const paymentAt = row.findIndex((cell) => cell.classList.contains('ui-register-payment'));
    expect(foot[paymentAt].textContent).toBe('$75.00');
    expect(foot[paymentAt + 1].textContent).toBe('$200.00');
  });

  it('takes the wide inset, which halves the padding on a phone, where Standard keeps the default', () => {
    // Folio's second money column is what a phone's register has no room for
    // at the default inset; the payee was squeezed to nothing (#2305).
    useDensityStore.setState({ densities: { transactions: 'dense' } });
    try {
      const { container, unmount } = renderList();
      const cell = container.querySelector('tbody tr.ui-register-row > td') as HTMLElement;
      expect(cell.className).toMatch(/(^|\s)px-1\.5 sm:px-3(\s|$)/);
      unmount();
      style.value = 'standard';
      const standard = renderList();
      const standardCell = standard.container.querySelector('tbody tr.ui-register-row > td') as HTMLElement;
      expect(standardCell.className).not.toMatch(/px-1\.5/);
      expect(standardCell.className).toMatch(/(^|\s)px-3(\s|$)/);
      standard.unmount();
    } finally {
      useDensityStore.setState({ densities: {} });
    }
  });

  describe('on a phone, where the rows draw no balance column', () => {
    beforeEach(() => {
      phone.value = true;
      return () => {
        phone.value = false;
      };
    });

    // Rows a (+200, Jan 16), b (-50) and c (-25, Jan 15) under a balance of
    // 1000 after the newest: Jan 16 closed at 1000 and Jan 15 at 800, the
    // balance beside its newest row b, never c's 850 (issue #2486).
    const figures = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-testid="day-closing-balance-figure"]')).map(
        (el) => el.textContent,
      );

    it('prints the balance each day closed on beside its date, in place of the day net', () => {
      const { container } = renderList();
      const groups = Array.from(container.querySelectorAll('th[scope="colgroup"]'));
      expect(groups).toHaveLength(2);
      expect(figures(container)).toEqual(['$1000.00', '$800.00']);
      expect(groups[1].textContent).not.toMatch(/75\.00/);
      // Named for a screen reader: the same place holds the day net elsewhere.
      expect(within(groups[0] as HTMLElement).getByText('Balance at end of day').className).toBe('sr-only');
    });

    it('reads the closing balance from the newest row when the page runs oldest first', () => {
      const asc = { field: 'date', direction: 'asc' } as const;
      // Oldest first, the seed is still the balance after the newest row.
      const { container } = renderList({ sort: asc, rowsSort: asc, transactions: [...rows].reverse() });
      // c (Jan 15) is drawn first; b, Jan 15's newest row, closed it at 800.
      expect(figures(container)).toEqual(['$800.00', '$1000.00']);
    });

    it('withholds the close of a day whose newer rows are on the previous page', () => {
      // Page 2, newest first: Jan 16 may have later rows on page 1, so 1000
      // is only the balance after the newest Jan 16 row on this page.
      const { container } = renderList({ currentPage: 2, totalPages: 3 });
      expect(figures(container)).toEqual(['Continues on the previous page', '$800.00']);
    });

    it('withholds the close of a day whose newer rows are on the next page, oldest first', () => {
      const asc = { field: 'date', direction: 'asc' } as const;
      const { container, unmount } = renderList({
        sort: asc,
        rowsSort: asc,
        transactions: [...rows].reverse(),
        currentPage: 1,
        totalPages: 2,
      });
      expect(figures(container)).toEqual(['$800.00', 'Continues on the next page']);
      unmount();
      // The last page has nothing newer: every day closes.
      const last = renderList({
        sort: asc,
        rowsSort: asc,
        transactions: [...rows].reverse(),
        currentPage: 2,
        totalPages: 2,
      });
      expect(figures(last.container)).toEqual(['$800.00', '$1000.00']);
    });

    it('signs and colours a negative close as the balance column does', () => {
      const { container } = renderList({ startingBalance: -10 });
      const figure = container.querySelector('[data-testid="day-closing-balance-figure"] > span') as HTMLElement;
      expect(figure.textContent).toBe('-$10.00');
      expect(figure.className).toMatch(/text-red-600/);
    });

    it('keeps the day net on one account while there is no balance to walk from', () => {
      const { container } = renderList({ startingBalance: undefined });
      expect(container.querySelector('[data-testid="day-closing-balance"]')).toBeNull();
      const groups = container.querySelectorAll('th[scope="colgroup"]');
      expect(groups[1].querySelector('.ui-register-group-net')?.textContent).toBe('$-75.00');
    });

    it('keeps the day net across accounts, where there is no running balance', () => {
      const { container } = renderList({ isSingleAccountView: false, startingBalance: undefined });
      expect(container.querySelector('[data-testid="day-closing-balance"]')).toBeNull();
      const groups = container.querySelectorAll('th[scope="colgroup"]');
      expect(groups[0].querySelector('.ui-register-group-net')?.textContent).toBe('$200.00');
      expect(groups[1].querySelector('.ui-register-group-net')?.textContent).toBe('$-75.00');
    });
  });

  it('keeps the Date column when the register is not in date order', () => {
    const payeeSort = { field: 'payee', direction: 'asc' } as const;
    const { container } = renderList({ sort: payeeSort, rowsSort: payeeSort });
    expect(container.querySelector('th[scope="colgroup"]')).toBeNull();
    expect(container.querySelector('tfoot')).toBeNull();
  });
});

describe('Folio register, category', () => {
  it('prints the category as ledger text, and keeps the capsule in Standard', () => {
    style.value = 'folio';
    const folio = renderList();
    expect(folio.container.querySelector('.ui-register-cat')).not.toBeNull();
    expect(folio.container.querySelector('.ui-register-cat.rounded-full')).toBeNull();
    expect(screen.getAllByText('Groceries').length).toBeGreaterThan(0);
    folio.unmount();

    style.value = 'standard';
    const standard = renderList();
    expect(standard.container.querySelector('.ui-register-cat')).toBeNull();
  });
});

describe('Folio register, Description hidden', () => {
  beforeEach(() => {
    style.value = 'folio';
    useHiddenColumnsStore.getState().setHidden('transactions', []);
  });

  it('prints the memo after the payee until the reader hides Description, then drops it', () => {
    const { container, unmount } = renderList();
    expect(container.querySelector('.ui-register-memo')).not.toBeNull();
    unmount();

    useHiddenColumnsStore.getState().setHidden('transactions', ['description']);
    const hidden = renderList();
    expect(hidden.container.querySelectorAll('tbody tr.ui-register-row').length).toBeGreaterThan(0);
    expect(hidden.container.querySelector('.ui-register-memo')).toBeNull();
    expect(screen.queryByText('Weekly shop')).toBeNull();
  });
});

describe('Pebble register', () => {
  beforeEach(() => {
    style.value = 'pebble';
    useHiddenColumnsStore.getState().setHidden('transactions', []);
  });

  it('drops the description after the payee when the reader hides Description', () => {
    const { container, unmount } = renderList();
    const rowsText = () =>
      Array.from(container.querySelectorAll('[data-testid="pebble-row"]')).map((r) => r.textContent);
    expect(rowsText().some((t) => t?.includes(' · '))).toBe(true);
    unmount();

    useHiddenColumnsStore.getState().setHidden('transactions', ['description']);
    const hidden = renderList();
    const rows = Array.from(hidden.container.querySelectorAll('[data-testid="pebble-row"]'));
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.textContent?.includes(' · '))).toBe(false);
  });

  it('draws day blocks of rows instead of a table body', () => {
    const { container } = renderList();
    expect(container.querySelectorAll('[data-testid="pebble-row"]')).toHaveLength(3);
    expect(container.querySelector('tbody')).toBeNull();
  });

  it('heads each day with its closing balance below md, where the rows draw none, and its net from md (issue #2486)', () => {
    const { container } = renderList();
    const sections = Array.from(container.querySelectorAll('section'));
    expect(sections).toHaveLength(2);
    const balances = sections.map((section) => section.querySelector('[data-testid="day-closing-balance"]'));
    // Jan 15 closed at 800, the balance beside its newest row, never 850.
    expect(
      balances.map((el) => el?.querySelector('[data-testid="day-closing-balance-figure"]')?.textContent),
    ).toEqual(['$1000.00', '$800.00']);
    balances.forEach((el) => expect(el?.className).toMatch(/(^|\s)md:hidden(\s|$)/));
    const net = within(sections[1].querySelector('div') as HTMLElement).getByText('$-75.00');
    expect(net.closest('.md\\:inline')).toBeTruthy();
    // The rows' own balance column is the one hidden below md.
    expect(sections[1].querySelector('[data-testid="pebble-row"] .md\\:block')?.textContent).toBe('$800.00');
  });

  it('withholds the close of a day continued on the previous page', () => {
    const { container } = renderList({ currentPage: 2, totalPages: 2 });
    const first = container.querySelector('section [data-testid="day-closing-balance-figure"]');
    expect(first?.textContent).toBe('Continues on the previous page');
  });

  it.each([
    ['across accounts', { isSingleAccountView: false, startingBalance: undefined }],
    ['on one account with no balance to walk from', { startingBalance: undefined }],
  ])('heads each day with its net alone where there is no running balance (%s)', (_label, extra) => {
    const { container } = renderList(extra);
    expect(container.querySelector('[data-testid="day-closing-balance"]')).toBeNull();
    const heading = container.querySelectorAll('section')[1].querySelector('div') as HTMLElement;
    expect(within(heading).getByText('$-75.00').className).not.toMatch(/hidden/);
  });

  it('labels the inspector region and shows the first row until another is clicked', () => {
    renderList();
    const inspector = screen.getByRole('complementary', { name: 'Selected transaction' });
    expect(within(inspector).getByText('Employer')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('pebble-row')[1]);
    expect(within(screen.getByRole('complementary')).getByText('Grocery Store')).toBeTruthy();
  });

  it('redraws only the rows whose inspected state changed when another row is clicked', () => {
    renderList();
    rowFigureRenders.count = 0;
    // From the first row (inspected by default) to the third: those two
    // change, the second keeps its render.
    fireEvent.click(screen.getAllByTestId('pebble-row')[2]);
    expect(within(screen.getByRole('complementary')).getByText('Cafe')).toBeTruthy();
    expect(rowFigureRenders.count).toBe(2);
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

  it('offers Edit and Delete on an investment cash leg, and Delete removes the investment transaction', async () => {
    const { transactionsApi } = await import('@/lib/transactions');
    const { investmentsApi } = await import('@/lib/investments');
    (investmentsApi.deleteTransaction as any).mockResolvedValue(undefined);
    const onEdit = vi.fn();
    const onRefresh = vi.fn();
    const leg = makeTx({ id: 'leg', payeeName: 'Buy XEQT', linkedInvestmentTransactionId: 'inv-1' });
    renderList({ transactions: [leg], onEdit, onRefresh });
    const inspector = screen.getByRole('complementary');
    expect(within(inspector).queryByRole('button', { name: 'View' })).toBeNull();
    fireEvent.click(within(inspector).getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'leg' }));

    fireEvent.click(within(inspector).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete Investment Transaction')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(investmentsApi.deleteTransaction).toHaveBeenCalledWith('inv-1');
    expect(transactionsApi.delete).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
  });

  it('drops the inspector to the first day block, past the sort strip and the day heading', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const top = this.tagName === 'UL' ? 172 : 100;
        return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      });
    try {
      const { container } = renderList();
      const register = container.querySelector('.ui-pebble-register') as HTMLElement;
      expect(register.style.getPropertyValue('--ui-pebble-first-block')).toBe('72px');
      expect(screen.getByRole('complementary').className).toContain('mt-[var(--ui-pebble-first-block,0px)]');
    } finally {
      spy.mockRestore();
    }
  });

  it('is reachable from the keyboard', () => {
    renderList();
    const row = screen.getAllByTestId('pebble-row')[2];
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(within(screen.getByRole('complementary')).getByText('Cafe')).toBeTruthy();
  });

  it('shows the payee logo in the row avatar when the payee has one', () => {
    const withLogo = [
      makeTx({ id: 'l', payee: { id: 'p1', name: 'Grocery Store', hasLogo: true } as any }),
      makeTx({ id: 'n', payeeName: 'Cafe' }),
    ];
    renderList({ transactions: withLogo });
    const [logoRow, plainRow] = screen.getAllByTestId('pebble-row');
    expect(within(logoRow).getByRole('img', { name: 'Grocery Store' })).toBeTruthy();
    expect(within(plainRow).queryByRole('img')).toBeNull();
  });

  it('opens the payee instead of the row when the payee icon is clicked', () => {
    const onPayeeClick = vi.fn();
    renderList({
      onPayeeClick,
      transactions: [
        makeTx({ id: 'a', transactionDate: '2024-01-16', amount: 200, payeeId: 'payee-1', payeeName: 'Employer' }),
        makeTx({ id: 'b', transactionDate: '2024-01-15', amount: -50, payeeId: 'payee-2' }),
      ],
    });
    const secondRow = screen.getAllByTestId('pebble-row')[1];
    fireEvent.click(within(secondRow).getByRole('button', { name: 'View Grocery Store details' }));
    expect(onPayeeClick).toHaveBeenCalledWith('payee-2');
    // The click opened the payee, not the row it sits in: the inspector still
    // shows the first (default-inspected) row rather than switching to this one.
    expect(within(screen.getByRole('complementary')).getByText('Employer')).toBeTruthy();
  });

  it('leaves the avatar a plain, non-interactive disc when the row has no payee to open', () => {
    const onPayeeClick = vi.fn();
    renderList({ onPayeeClick, transactions: [makeTx({ id: 'a', payeeId: null, isTransfer: true })] });
    const row = screen.getAllByTestId('pebble-row')[0];
    expect(within(row).queryByRole('button', { name: /View .* details/ })).toBeNull();
  });

  it('draws the category icon in place of the dot when the category has one', () => {
    const iconTx = makeTx({
      id: 'i',
      category: { id: 'cat-1', name: 'Groceries', color: '#22c55e', icon: null } as any,
    });
    const { container } = renderList({
      isSingleAccountView: false,
      startingBalance: undefined,
      transactions: [iconTx],
      categoryIconMap: new Map([['cat-1', 'chart-bar']]),
    });
    const row = container.querySelector('[data-testid="pebble-row"]') as HTMLElement;
    expect(row.querySelector('span[style*="color"] > svg')).toBeTruthy();
  });

  it('cycles the status from the row without opening it, by click and keyboard', async () => {
    const { transactionsApi } = await import('@/lib/transactions');
    (transactionsApi.updateStatus as any).mockResolvedValue({ ...rows[1], status: TransactionStatus.CLEARED });
    renderList();
    const row = screen.getAllByTestId('pebble-row')[1];
    // Two controls, one per layout (the phone line and the wider row; CSS
    // shows one), both the same status button on the same handler.
    const buttons = within(row).getAllByRole('button', { name: 'Pending' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      (transactionsApi.updateStatus as any).mockClear();
      fireEvent.click(button);
      expect(transactionsApi.updateStatus).toHaveBeenCalledWith('b', TransactionStatus.CLEARED);
      // The row stayed uninspected: the inspector still shows the first row.
      expect(within(screen.getByRole('complementary')).getByText('Employer')).toBeTruthy();
      fireEvent.keyDown(button, { key: 'Enter' });
      expect(within(screen.getByRole('complementary')).getByText('Employer')).toBeTruthy();
    }
  });

  it('offers neither the Columns chooser nor the Density toggle', () => {
    renderList({ totalPages: 1, totalItems: 3, pageSize: 25, currentPage: 1, onPageChange: vi.fn() });
    expect(screen.queryByRole('button', { name: /columns/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /density/i })).toBeNull();
  });
});

describe('A provisional amount in every register style (issue #2397)', () => {
  const provisionalRows = [
    makeTx({ id: 'est', transactionDate: '2024-01-16', amount: 80, payeeName: 'From USD', isTransfer: true, amountIsProvisional: true }),
    makeTx({ id: 'firm', transactionDate: '2024-01-15', amount: -50, amountIsProvisional: false }),
  ];

  beforeEach(() => {
    useHiddenColumnsStore.getState().setHidden('transactions', []);
  });

  it('Standard: labels only the provisional row and offers Confirm amount on it alone', () => {
    style.value = 'standard';
    const onConfirmAmount = vi.fn();
    renderList({ transactions: provisionalRows, onConfirmAmount });
    expect(screen.getAllByTestId('provisional-amount-badge')).toHaveLength(1);
    const confirm = screen.getAllByRole('button', { name: 'Confirm amount' });
    expect(confirm).toHaveLength(1);
    fireEvent.click(confirm[0]);
    expect(onConfirmAmount).toHaveBeenCalledWith(expect.objectContaining({ id: 'est' }));
  });

  it('Standard: a joint account shared to the reader keeps the label but offers no action', () => {
    style.value = 'standard';
    const joint = new Map([['acc-1', { canCreate: true, canEdit: true, canDelete: true }]]);
    renderList({ transactions: provisionalRows, onConfirmAmount: vi.fn(), jointPermissionsByAccount: joint });
    expect(screen.getAllByTestId('provisional-amount-badge')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Confirm amount' })).toBeNull();
  });

  it('Standard: a row another user owns keeps the label but offers no action, before any account has loaded', () => {
    style.value = 'standard';
    useAuthStore.setState({ user: { id: 'u' } as any, actingAsUserId: null });
    try {
      const foreign = provisionalRows.map((tx) => ({ ...tx, userId: 'someone-else' }));
      const view = renderList({ transactions: foreign, onConfirmAmount: vi.fn() });
      expect(screen.getAllByTestId('provisional-amount-badge')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Confirm amount' })).toBeNull();
      view.unmount();
    } finally {
      useAuthStore.setState({ user: null, actingAsUserId: null });
    }
  });

  it('Standard: an acting delegate keeps the label but is not offered the action, which the server refuses them', () => {
    style.value = 'standard';
    useAuthStore.setState({ user: { id: 'delegate' } as any, actingAsUserId: 'u' });
    try {
      const view = renderList({ transactions: provisionalRows, onConfirmAmount: vi.fn() });
      expect(screen.getAllByTestId('provisional-amount-badge')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Confirm amount' })).toBeNull();
      view.unmount();
    } finally {
      useAuthStore.setState({ user: null, actingAsUserId: null });
    }
  });

  it('Standard: the owner signed in as themselves is offered the action on their own row', () => {
    style.value = 'standard';
    useAuthStore.setState({ user: { id: 'u' } as any, actingAsUserId: null });
    try {
      const view = renderList({ transactions: provisionalRows, onConfirmAmount: vi.fn() });
      expect(screen.getAllByRole('button', { name: 'Confirm amount' })).toHaveLength(1);
      view.unmount();
    } finally {
      useAuthStore.setState({ user: null, actingAsUserId: null });
    }
  });

  it('Standard: with no signed-in identity known, ownership is left to the server', () => {
    style.value = 'standard';
    useAuthStore.setState({ user: null, actingAsUserId: null });
    renderList({ transactions: provisionalRows, onConfirmAmount: vi.fn() });
    expect(screen.getAllByRole('button', { name: 'Confirm amount' })).toHaveLength(1);
  });

  it('Folio: labels the provisional amount in its column', () => {
    style.value = 'folio';
    renderList({ transactions: provisionalRows, onConfirmAmount: vi.fn() });
    expect(screen.getAllByTestId('provisional-amount-badge')).toHaveLength(1);
  });

  it('Pebble: labels the row and the inspector, and the inspector confirms it', () => {
    style.value = 'pebble';
    const onConfirmAmount = vi.fn();
    renderList({ transactions: provisionalRows, onConfirmAmount });
    const [estRow, firmRow] = screen.getAllByTestId('pebble-row');
    expect(within(estRow).getByTestId('provisional-amount-badge')).toHaveTextContent('Estimated amount');
    expect(within(firmRow).queryByTestId('provisional-amount-badge')).toBeNull();
    const inspector = screen.getByRole('complementary');
    expect(within(inspector).getByTestId('provisional-amount-badge')).toBeTruthy();
    fireEvent.click(within(inspector).getByRole('button', { name: 'Confirm amount' }));
    expect(onConfirmAmount).toHaveBeenCalledWith(expect.objectContaining({ id: 'est' }));
  });

  it('Pebble: a confirmed row inspected shows neither label nor action', () => {
    style.value = 'pebble';
    renderList({ transactions: provisionalRows, onConfirmAmount: vi.fn() });
    fireEvent.click(screen.getAllByTestId('pebble-row')[1]);
    const inspector = screen.getByRole('complementary');
    expect(within(inspector).getByText('Grocery Store')).toBeTruthy();
    expect(within(inspector).queryByTestId('provisional-amount-badge')).toBeNull();
    expect(within(inspector).queryByRole('button', { name: 'Confirm amount' })).toBeNull();
  });
});
