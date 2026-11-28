import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { InvestmentTransactionList } from './InvestmentTransactionList';
import { investmentsApi } from '@/lib/investments';
import { TransactionStatus } from '@/types/transaction';
import { useDensityStore } from '@/store/densityStore';
import { usePreferencesStore } from '@/store/preferencesStore';

/**
 * The brokerage register in the Folio and Pebble UI styles at desktop and
 * tablet widths (issue #2510), drawn the way those styles draw the cash
 * register beside it: Folio as a ledger with the date as a group row, Pebble
 * as white day blocks. The phone layouts are pinned in
 * `InvestmentTransactionList.mobileWrapped.test.tsx`. The harness's default
 * `matchMedia` answers `false`, so these renders are not a phone.
 */

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    updateStatus: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _code?: string, digits?: number) => `$${n.toFixed(digits ?? 2)}`,
      formatQuantity: (n: number) => String(n),
      numberFormat: 'en-US',
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

const style = vi.hoisted(() => ({ value: 'standard' as 'standard' | 'folio' | 'pebble' }));
vi.mock('@/hooks/useUiStyle', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useUiStyle')>()),
  useUiStyle: () => style.value,
}));

vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2024-01-16',
}));

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'Questrade RRSP' },
  { id: 'a2', name: 'Wealthsimple TFSA' },
];

function makeTx(overrides: Record<string, unknown> = {}): any {
  return {
    id: 't1',
    action: 'BUY',
    transactionDate: '2024-01-15',
    accountId: 'a1',
    security: { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'CAD' },
    quantity: 10,
    price: 150,
    totalAmount: 1500,
    status: TransactionStatus.UNRECONCILED,
    ...overrides,
  };
}

// Two trades today (Jan 16, under the mocked calendar) and one yesterday,
// newest first as the server orders this register.
const DAYS = [
  makeTx({ id: 'a', transactionDate: '2024-01-16', status: TransactionStatus.CLEARED }),
  makeTx({ id: 'b', transactionDate: '2024-01-16', action: 'SELL', security: { symbol: 'MSFT', name: 'Microsoft', currencyCode: 'CAD' }, totalAmount: 900 }),
  makeTx({ id: 'c', transactionDate: '2024-01-15', accountId: 'a2' }),
];

function renderList(transactions: any[] = DAYS, onEdit = vi.fn()) {
  const view = render(
    <InvestmentTransactionList
      transactions={transactions}
      accounts={ACCOUNTS}
      isLoading={false}
      onEdit={onEdit}
      onDelete={vi.fn()}
    />,
  );
  return { ...view, onEdit };
}

const groupHeadings = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tbody th[scope="colgroup"]')).map((th) => th.textContent);

const seedHidden = (investmentRegister: string[]) =>
  usePreferencesStore.setState({
    preferences: { hiddenTableColumns: { investmentRegister } } as any,
  });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDensityStore.setState({ densities: { investments: 'normal' } });
  usePreferencesStore.setState({ preferences: null } as any);
});

afterEach(() => {
  style.value = 'standard';
});

describe('the brokerage register in Standard on a desktop width', () => {
  it('keeps its Date column and draws no ledger, group rows or legend', () => {
    const { container } = renderList();
    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
    expect(container.querySelector('table.ui-register')).toBeNull();
    expect(groupHeadings(container)).toEqual([]);
    expect(container.querySelector('.ui-register-legend')).toBeNull();
    expect(screen.getAllByText('2024-01-16')).toHaveLength(2);
  });
});

describe('the brokerage register in Folio on a desktop width (issue #2510)', () => {
  beforeEach(() => {
    style.value = 'folio';
  });

  it('is a ledger table whose rows carry the green-bar band', () => {
    const { container } = renderList();
    expect(container.querySelector('table.ui-register')).not.toBeNull();
    const rows = container.querySelectorAll('tbody tr.ui-register-row');
    expect(rows).toHaveLength(3);
    expect(Array.from(rows).map((r) => r.getAttribute('data-band'))).toEqual(['0', '1', '0']);
  });

  it('names each day in a group row spanning the table, in place of the Date column', () => {
    const { container } = renderList();
    expect(groupHeadings(container)).toEqual(['Tuesday, January 16', 'Monday, January 15']);
    expect(screen.queryByRole('columnheader', { name: 'Date' })).toBeNull();
    expect(screen.queryByText('2024-01-16')).toBeNull();
    // Every header cell is spanned: eight data columns less Date, plus Actions.
    const headerCells = container.querySelectorAll('thead th').length;
    expect(headerCells).toBe(8);
    container.querySelectorAll('tbody th[scope="colgroup"]').forEach((th) => {
      expect(th.className).toBe('ui-register-group');
      expect(th.getAttribute('colspan')).toBe(String(headerCells));
    });
  });

  it('prints no figure beside the date: a trade register has no running balance', () => {
    const { container } = renderList();
    container.querySelectorAll('tbody th[scope="colgroup"]').forEach((th) => {
      expect(th.textContent).not.toMatch(/\$/);
    });
  });

  it('draws Total as the ledger money column, header and cells', () => {
    const { container } = renderList();
    const total = screen.getByRole('columnheader', { name: 'Total' });
    expect(total.className).toContain('ui-register-money');
    expect(container.querySelectorAll('tbody td.ui-register-money')).toHaveLength(3);
  });

  it('prints each status as its mark, with the legend under the table', () => {
    const { container } = renderList();
    const [first] = Array.from(container.querySelectorAll('tbody tr.ui-register-row'));
    expect(within(first as HTMLElement).getByText('C')).toBeInTheDocument();
    const legend = container.querySelector('.ui-register-legend');
    expect(legend).not.toBeNull();
    expect(legend!.textContent).toContain('cleared');
    expect(legend!.textContent).toContain('reconciled');
  });

  it('drops the legend with the Status column', () => {
    seedHidden(['status']);
    const { container } = renderList();
    expect(container.querySelector('.ui-register-legend')).toBeNull();
  });

  it('keeps the Today divider before the first row dated today or earlier', () => {
    const { container } = renderList([
      makeTx({ id: 'f', transactionDate: '2024-01-20' }),
      ...DAYS,
    ]);
    expect(groupHeadings(container)).toEqual([
      'Saturday, January 20',
      'Tuesday, January 16',
      'Monday, January 15',
    ]);
    expect(screen.getByText('Today')).toBeInTheDocument();
  });
});

describe('the brokerage register in Pebble on a desktop width (issue #2510)', () => {
  beforeEach(() => {
    style.value = 'pebble';
  });

  it('groups the trades into day blocks titled Today, Yesterday, then the date', () => {
    const { container } = renderList([
      ...DAYS,
      makeTx({ id: 'd', transactionDate: '2024-01-10' }),
    ]);
    expect(container.querySelector('table')).toBeNull();
    const blocks = container.querySelectorAll('section');
    expect(Array.from(blocks).map((s) => s.getAttribute('aria-label'))).toEqual([
      'Today',
      'Yesterday',
      'Wednesday, January 10',
    ]);
    expect(within(blocks[0] as HTMLElement).getAllByTestId('pebble-trade-row')).toHaveLength(2);
    // The block's title is its date: no row repeats it, and no figure sits beside it.
    expect(screen.queryByText('2024-01-16')).toBeNull();
    blocks.forEach((s) => {
      expect(s.querySelector('h3')!.parentElement!.textContent).not.toMatch(/\$/);
    });
  });

  it('shows each trade\'s symbol, action, security name, account, status and total', () => {
    renderList();
    const [row] = screen.getAllByTestId('pebble-trade-row');
    expect(within(row).getByText('AAPL')).toBeInTheDocument();
    expect(within(row).getByText('Buy')).toBeInTheDocument();
    expect(within(row).getByText('Apple Inc.')).toBeInTheDocument();
    expect(within(row).getByText('Questrade RRSP')).toBeInTheDocument();
    expect(within(row).getAllByText('Cleared').length).toBeGreaterThan(0);
    expect(within(row).getByText('$1500.00')).toBeInTheDocument();
    expect(within(row).getByText('10')).toBeInTheDocument();
  });

  it('opens the editor on a click and on Enter, with no inspector', () => {
    const { onEdit } = renderList();
    const [row] = screen.getAllByTestId('pebble-trade-row');
    fireEvent.click(row);
    expect(onEdit).toHaveBeenCalledWith(DAYS[0]);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('cycles the status from its button without opening the editor', async () => {
    const { onEdit } = renderList();
    const [row] = screen.getAllByTestId('pebble-trade-row');
    const [button] = within(row).getAllByTitle('Click to cycle status');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(investmentsApi.updateStatus).toHaveBeenCalledWith('a', TransactionStatus.RECONCILED);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('leaves out a hidden column', () => {
    seedHidden(['shares', 'status']);
    renderList();
    const [row] = screen.getAllByTestId('pebble-trade-row');
    expect(within(row).queryByText('10')).toBeNull();
    expect(within(row).queryByText('Cleared')).toBeNull();
  });

  it('draws the Today divider ahead of the first block dated today or earlier', () => {
    const { container } = renderList([makeTx({ id: 'f', transactionDate: '2024-01-20' }), ...DAYS]);
    const labels = Array.from(container.querySelectorAll('section')).map((s) => s.getAttribute('aria-label'));
    expect(labels).toEqual(['Saturday, January 20', 'Today', 'Yesterday']);
    // The divider and the first block's title both read Today.
    expect(screen.getAllByText('Today')).toHaveLength(2);
  });

  it('says a filter left nothing, rather than drawing an empty block', () => {
    render(
      <InvestmentTransactionList
        transactions={[]}
        accounts={ACCOUNTS}
        isLoading={false}
        filters={{ symbol: 'ZZZ' }}
        onFiltersChange={vi.fn()}
      />,
    );
    expect(screen.getByText('No transactions match your filters.')).toBeInTheDocument();
  });

  it('offers no density toggle: the block list has no row density', () => {
    renderList();
    expect(screen.queryByTitle('Toggle row density')).toBeNull();
  });
});
