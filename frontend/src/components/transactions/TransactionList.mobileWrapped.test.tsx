import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { TransactionList } from './TransactionList';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each register row is a wrapped two-line card in a
 * single `<td>` (more of the register visible, no horizontal scroll); Compact
 * and Dense keep the tier table, and so does every non-phone width.
 *
 * These are the three combinations that decide it. The rest of the register's
 * suite runs under the harness's default `matchMedia` (`matches: false`), so
 * it exercises the desktop tier table exactly as before -- which is the point
 * of choosing the branch in JS rather than with CSS variants.
 */

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    dateFormat: 'browser',
    datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => d,
    formatDateWithoutYear: (d: Date | string) => String(d).slice(5),
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
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

function createTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountId: 'acc-1',
    account: { id: 'acc-1', name: 'Chequing', accountType: 'CHEQUING' } as any,
    transactionDate: '2024-01-15',
    payeeId: 'payee-1',
    payeeName: 'Grocery Store',
    payee: null,
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries', color: '#22c55e' } as any,
    amount: -50.0,
    currencyCode: 'CAD',
    exchangeRate: 1,
    originalAmount: null,
    originalCurrencyCode: null,
    description: 'Weekly groceries',
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

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

describe('the register on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each row as a wrapped card at Normal density', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card
    // rather than a table row with the columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // The full column header is replaced by a slim control header: one cell,
    // none of the column labels, but the day/month date toggle still reachable.
    const head = container.querySelector('thead');
    expect(head).toBeTruthy();
    expect(head!.querySelectorAll('th')).toHaveLength(1);
    expect(head!.textContent).not.toContain('Category');
    expect(head!.querySelector('button')).toBeTruthy();

    // More of the register than a phone-width tier table shows, all in the
    // one row: payee, amount, category and status.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('Grocery Store');
    expect(text).toContain('-$50.00');
    expect(text).toContain('Groceries');
    expect(text).toContain('Pending');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('puts the tags on a line of their own under the category, and only when there are any', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const tags = [
      { id: 'tag-1', name: 'Reimbursable', color: '#f59e0b' },
      { id: 'tag-2', name: 'Vacation', color: '#3b82f6' },
    ] as Transaction['tags'];
    const { container } = render(
      <TransactionList
        transactions={[
          createTransaction({ id: 'tx-tagged', tags }),
          createTransaction({ id: 'tx-plain' }),
        ]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Vacation')).toBeInTheDocument();
    });

    const [tagged, plain] = bodyRows(container);
    // Inline after the category, a single tag pushed the status and balance
    // onto a line of their own; the tags now take that line themselves,
    // under the category, and the second line keeps its shape.
    const taggedLines = Array.from(tagged.querySelectorAll('.col-span-3'));
    expect(taggedLines).toHaveLength(2);
    const [line2, tagLine] = taggedLines;
    expect(line2.textContent).toContain('Groceries');
    expect(line2.textContent).toContain('Pending');
    expect(line2.textContent).not.toContain('Reimbursable');
    expect(tagLine.textContent).toContain('Reimbursable');
    expect(tagLine.textContent).toContain('Vacation');
    expect(tagLine.textContent).not.toContain('Pending');

    // A row with no tags does not grow an empty third line.
    expect(plain.querySelectorAll('.col-span-3')).toHaveLength(1);
  });

  it('keeps the tier table at Compact density', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'compact' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.className).not.toContain('hidden');
  });

  it('keeps the tier table on a desktop width at Normal density', async () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a foreign-currency fee surface at Normal density', async () => {
    // showFxColumns is the FX fees report/section, whose subject is the
    // paid-currency / amount / fee columns the card does not carry -- so it
    // stays a table even on a phone at Normal density.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        showFxColumns
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the select-all-on-page box in the slim header in selection mode', async () => {
    // Hiding the header outright would have taken the select-all control with
    // it; the slim control header keeps it reachable on a phone.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        selectionMode
        isAllOnPageSelected={false}
        onToggleAllOnPage={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const head = container.querySelector('thead');
    expect(head!.querySelector('input[type="checkbox"]')).toBeTruthy();
  });
});
