import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { SecurityTransactionHistory } from './SecurityTransactionHistory';
import { investmentsApi } from '@/lib/investments';
import { getSelectByLabel } from '@/test/icon-select';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityTransactionHistory: vi.fn(),
    createTransaction: vi.fn().mockResolvedValue({}),
    getTransaction: vi.fn().mockResolvedValue({ id: 't1', securityId: 'sec-1' }),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

// Stub the heavy shared form; we only verify the edit wiring here.
vi.mock('@/components/investments/InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: ({
    transaction,
    onSuccess,
    onCancel,
  }: {
    transaction?: { id: string };
    onSuccess?: () => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="edit-form">
      <span>Editing {transaction?.id}</span>
      <button onClick={() => onSuccess?.()}>Save edit</button>
      <button onClick={() => onCancel?.()}>Cancel edit</button>
    </div>
  ),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'YYYY-MM-DD', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyPrecise: (n: number) => {
        const abs = Math.abs(n);
        let digits = 2;
        if (n !== 0 && abs < 0.005) {
          digits = Math.min(6, Math.max(2, -Math.floor(Math.log10(abs)) + 2));
        }
        return `$${n.toFixed(digits)}`;
      },
    }),
  };
});
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const security = {
  id: 'sec-1',
  symbol: 'ACME',
  name: 'Acme Corp',
  currencyCode: 'USD',
  isActive: false,
} as any;

const historyData = {
  securityId: 'sec-1',
  symbol: 'ACME',
  name: 'Acme Corp',
  currencyCode: 'USD',
  isActive: false,
  accounts: [
    { accountId: 'a1', accountName: 'Account A', isClosed: false, currentQuantity: 0.0003 },
    { accountId: 'a2', accountName: 'Account B', isClosed: true, currentQuantity: 50 },
  ],
  transactions: [
    { id: 't1', transactionDate: '2025-01-01', accountId: 'a1', accountName: 'Account A', action: 'ADD_SHARES', quantity: 100, price: null, commission: 0, totalAmount: 0, description: null, runningQuantityAccount: 100, runningQuantityAll: 100 },
    { id: 't2', transactionDate: '2025-02-01', accountId: 'a2', accountName: 'Account B', action: 'ADD_SHARES', quantity: 50, price: null, commission: 0, totalAmount: 0, description: null, runningQuantityAccount: 50, runningQuantityAll: 150 },
    { id: 't3', transactionDate: '2025-03-01', accountId: 'a1', accountName: 'Account A', action: 'REMOVE_SHARES', quantity: 99.9997, price: null, commission: 0, totalAmount: 0, description: null, runningQuantityAccount: 0.0003, runningQuantityAll: 50.0003 },
  ],
  currentQuantityAll: 50.0003,
};

async function renderHistory(props: Partial<Record<string, unknown>> = {}) {
  await act(async () => {
    render(
      <SecurityTransactionHistory
        security={security}
        onChanged={(props.onChanged as () => void) ?? vi.fn()}
      />,
    );
  });
}

describe('SecurityTransactionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(investmentsApi.getSecurityTransactionHistory).mockResolvedValue(historyData as any);
  });

  it('loads and shows transactions with the cross-account running total', async () => {
    await renderHistory();
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });
    // Cross-account running totals are shown in "All accounts" mode.
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getAllByText('50.0003').length).toBeGreaterThan(0);
  });

  it('leaves the symbol, the inactive badge and the share count to the detail page', async () => {
    // Regression guard: this pane used to be a modal opened from the securities
    // list and carried its own heading. On the detail page that heading is the
    // page header, and rendering it again duplicated it on screen.
    await renderHistory();
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });
    expect(screen.queryByText('ACME')).not.toBeInTheDocument();
    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();
    expect(screen.queryByText('Current shares')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('filters to a single account and shows its per-account running total', async () => {
    await renderHistory();
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(getSelectByLabel('Account'), { target: { value: 'a1' } });
    });

    // Account B's transaction (running-all 150) is filtered out.
    expect(screen.queryByText('150')).not.toBeInTheDocument();
    // Account A's residual per-account running total is shown.
    expect(screen.getAllByText('0.0003').length).toBeGreaterThan(0);
  });

  it('adds an adjustment and reloads the history', async () => {
    const onChanged = vi.fn();
    await renderHistory({ onChanged });
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });
    expect(investmentsApi.getSecurityTransactionHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('+ Add transaction'));
    });
    expect(screen.getByText('Adjust shares')).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '0.0003' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Record adjustment'));
    });

    await waitFor(() => {
      expect(investmentsApi.createTransaction).toHaveBeenCalled();
    });
    // History reloaded and parent notified.
    await waitFor(() => {
      expect(investmentsApi.getSecurityTransactionHistory).toHaveBeenCalledTimes(2);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('opens the edit form for a transaction and reloads after saving', async () => {
    vi.mocked(investmentsApi.getTransaction).mockResolvedValue({
      id: 't1',
      securityId: 'sec-1',
    } as any);
    const onChanged = vi.fn();
    await renderHistory({ onChanged });
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });
    expect(investmentsApi.getSecurityTransactionHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('edit-form')).toBeInTheDocument();
    });
    expect(investmentsApi.getTransaction).toHaveBeenCalledWith('t1');

    await act(async () => {
      fireEvent.click(screen.getByText('Save edit'));
    });
    // History reloads and parent is notified after a successful edit.
    await waitFor(() => {
      expect(investmentsApi.getSecurityTransactionHistory).toHaveBeenCalledTimes(2);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('wraps each row into a labelled grid card below the mobile breakpoint', async () => {
    // One tree restyled by CSS: below `sm` the row is a `grid` card and every
    // bare figure names its column with a caption; from `sm` up it is the
    // ordinary table. jsdom applies no breakpoint, so assert the classes and
    // the captions that ride in the markup at every width.
    await renderHistory();
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });

    // Every data row carries the wrapped-card grid and restores the table row
    // at `sm`, so a phone needs no horizontal scroll.
    const dataRows = screen
      .getAllByRole('row')
      .filter((row) => row.className.includes('grid grid-cols-4'));
    expect(dataRows).toHaveLength(historyData.transactions.length);
    for (const row of dataRows) {
      expect(row.className).toContain('sm:table-row');
    }

    // The per-row captions name each column a phone reader can no longer see in
    // a header: one caption per data row, plus the desktop header cell that
    // stays in the DOM (hidden below `sm`).
    for (const caption of ['Quantity', 'Running Total', 'Price', 'Amount']) {
      expect(screen.getAllByText(caption).length).toBe(historyData.transactions.length + 1);
    }
  });

  it('keeps the Amount cell in the base desktop colour and shrinks figures to text-xs on a phone', async () => {
    // The `sm`+ resolved output must stay byte-identical to the pre-card table:
    // the Amount cell wears the muted `text-gray-700` the base table used (it
    // was briefly bumped to `text-gray-900`), and every figure cell renders
    // `text-xs` on the phone but `sm:text-sm` from `sm` up, so a quarter-width
    // card row cannot reopen horizontal scroll while the desktop size is unchanged.
    await renderHistory();
    await waitFor(() => {
      expect(getSelectByLabel('Account')).toBeInTheDocument();
    });

    const cells = screen.getAllByRole('cell');

    // The Amount cell is the only one at col-start-3 / col-span-2 / row-start-1.
    const amountCells = cells.filter(
      (c) =>
        c.className.includes('col-start-3') &&
        c.className.includes('col-span-2') &&
        c.className.includes('row-start-1'),
    );
    expect(amountCells).toHaveLength(historyData.transactions.length);
    for (const cell of amountCells) {
      const classes = cell.className.split(/\s+/);
      expect(classes).toContain('text-gray-700');
      expect(classes).toContain('dark:text-gray-300');
      expect(classes).not.toContain('text-gray-900');
    }

    // Every figure cell (MONEY_CELL) shrinks on the phone and restores at `sm`.
    const figureCells = cells.filter((c) => c.className.includes('sm:text-sm'));
    expect(figureCells.length).toBeGreaterThan(0);
    for (const cell of figureCells) {
      const classes = cell.className.split(/\s+/);
      expect(classes).toContain('text-xs');
      expect(classes).toContain('sm:text-sm');
      // Desktop size is unchanged: no bare `text-sm`, only the `sm:` variant.
      expect(classes).not.toContain('text-sm');
    }
  });

  it('shows an empty state when there are no transactions', async () => {
    vi.mocked(investmentsApi.getSecurityTransactionHistory).mockResolvedValue({
      ...historyData,
      accounts: [],
      transactions: [],
      currentQuantityAll: 0,
    } as any);
    await renderHistory();
    await waitFor(() => {
      expect(screen.getByText(/No transactions for this security/)).toBeInTheDocument();
    });
  });
});
