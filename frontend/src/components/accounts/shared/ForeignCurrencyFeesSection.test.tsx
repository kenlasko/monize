import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ForeignCurrencyFeesSection } from './ForeignCurrencyFeesSection';
import type { Account } from '@/types/account';

const mockGetFxFeeSummary = vi.fn();
const mockGetAll = vi.fn();
const mockGetById = vi.fn();

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getFxFeeSummary: (...args: unknown[]) => mockGetFxFeeSummary(...args),
    getAll: (...args: unknown[]) => mockGetAll(...args),
    getById: (...args: unknown[]) => mockGetById(...args),
  },
}));

const mockExportCsv = vi.fn();
vi.mock('@/lib/fx-fees-csv', () => ({
  exportForeignTransactionsCsv: (...args: unknown[]) => mockExportCsv(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Capture chart props so tests can assert on the aggregated monthly fee data.
const chartProps: { current: any } = { current: null };
vi.mock('./ForeignCurrencyFeeChart', () => ({
  ForeignCurrencyFeeChart: (props: any) => {
    chartProps.current = props;
    // Render leftControls (the currency filter) so filter interactions work.
    return <div data-testid="fee-chart">{props.leftControls}</div>;
  },
}));

// Lightweight list stub exposing the callbacks the section wires up.
const listProps: { current: any } = { current: null };
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: (props: any) => {
    listProps.current = props;
    return (
      <div data-testid="transaction-list">
        {props.transactions.map((tx: any) => (
          <button key={tx.id} onClick={() => props.onEdit(tx)}>
            {tx.payeeName}
          </button>
        ))}
        <button onClick={() => props.onRefresh()}>refresh-list</button>
        {props.onExport && (
          <button onClick={() => props.onExport()}>export-list</button>
        )}
      </div>
    );
  },
}));

vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: ({ onSuccess }: any) => (
    <div data-testid="transaction-form">
      <button onClick={onSuccess}>save-form</button>
    </div>
  ),
}));

// Simple multiselect stub: one button per option, clicking selects just it.
vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ options, onChange, value }: any) => (
    <div data-testid="currency-filter" data-selected={value.join(',')}>
      {options.map((o: any) => (
        <button key={o.value} onClick={() => onChange([o.value])}>
          {`option-${o.label}`}
        </button>
      ))}
      <button onClick={() => onChange([])}>clear-currencies</button>
    </div>
  ),
}));

const account = {
  id: 'acc-1',
  name: 'Travel Card',
  currencyCode: 'CAD',
  fxFeePercent: 2.5,
} as unknown as Account;

// Same account with no foreign-transaction fee configured.
const noFeeAccount = {
  ...account,
  fxFeePercent: 0,
} as unknown as Account;

const summaryRows = [
  { month: '2025-01', currencyCode: 'EUR', feeTotal: 10, count: 2 },
  { month: '2025-01', currencyCode: 'USD', feeTotal: 5, count: 1 },
  { month: '2025-02', currencyCode: 'EUR', feeTotal: 2.5, count: 1 },
];

const page1 = {
  data: [
    { id: 'tx-1', payeeName: 'Hotel Paris', isTransfer: false, isSplit: false },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
};

async function renderSection(acct: Account = account) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ForeignCurrencyFeesSection account={acct} />);
  });
  return result!;
}

describe('ForeignCurrencyFeesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartProps.current = null;
    listProps.current = null;
    mockGetFxFeeSummary.mockResolvedValue(summaryRows);
    mockGetAll.mockResolvedValue(page1);
    mockExportCsv.mockResolvedValue(1);
  });

  it('exports the current filter to CSV via the list toolbar', async () => {
    await renderSection();
    await waitFor(() => {
      expect(screen.getByText('export-list')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('export-list'));
    });

    // No currency selected -> exports every paid currency on the account.
    expect(mockExportCsv).toHaveBeenCalledWith({
      accountIds: ['acc-1'],
      currencyCodes: ['EUR', 'USD'],
    });
  });

  it('exports only the selected currency when the filter is set', async () => {
    await renderSection();
    await waitFor(() => {
      expect(screen.getByText('option-EUR')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('option-EUR'));
    });

    await act(async () => {
      fireEvent.click(screen.getByText('export-list'));
    });

    expect(mockExportCsv).toHaveBeenCalledWith({
      accountIds: ['acc-1'],
      currencyCodes: ['EUR'],
    });
  });

  it('renders the fees title, chart, and transaction list for a fee account', async () => {
    await renderSection();

    await waitFor(() => {
      expect(screen.getByText('Foreign Currency Transaction Fees')).toBeInTheDocument();
    });
    expect(screen.getByTestId('fee-chart')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
    });
    expect(mockGetFxFeeSummary).toHaveBeenCalledWith('acc-1');
  });

  it('shows only the transaction list (no fee chart) when no fee is configured', async () => {
    await renderSection(noFeeAccount);

    // The transactions register still loads because foreign transactions exist.
    await waitFor(() => {
      expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
    });
    // Heading is the plain "Foreign Currency Transactions", not the fees title.
    expect(screen.getByText('Foreign Currency Transactions')).toBeInTheDocument();
    expect(
      screen.queryByText('Foreign Currency Transaction Fees'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('fee-chart')).not.toBeInTheDocument();
    // The currency filter still rides along so the list stays filterable.
    expect(screen.getByTestId('currency-filter')).toBeInTheDocument();
    expect(mockGetAll).toHaveBeenCalledWith({
      accountId: 'acc-1',
      originalCurrencyCodes: ['EUR', 'USD'],
      page: 1,
      limit: 25,
    });
  });

  it('renders nothing when a fee account has no foreign transactions', async () => {
    mockGetFxFeeSummary.mockResolvedValue([]);
    const { container } = await renderSection();

    // No foreign transactions -> neither the fee chart nor the list appears.
    await waitFor(() => {
      expect(mockGetFxFeeSummary).toHaveBeenCalledWith('acc-1');
    });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('fee-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transaction-list')).not.toBeInTheDocument();
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  it('aggregates per-currency rows into one fee total per month for the chart', async () => {
    await renderSection();

    await waitFor(() => {
      expect(chartProps.current?.isLoading).toBe(false);
    });
    expect(chartProps.current.data).toEqual([
      { month: '2025-01', total: 15, count: 3 },
      { month: '2025-02', total: 2.5, count: 1 },
    ]);
    expect(chartProps.current.currencyCode).toBe('CAD');
  });

  it('loads foreign transactions for every paid currency when no filter is set', async () => {
    await renderSection();

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith({
        accountId: 'acc-1',
        originalCurrencyCodes: ['EUR', 'USD'],
        page: 1,
        limit: 25,
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Hotel Paris')).toBeInTheDocument();
    });
  });

  it('filters both the chart and the list when a currency is selected', async () => {
    await renderSection();
    await waitFor(() => {
      expect(screen.getByText('option-EUR')).toBeInTheDocument();
    });
    mockGetAll.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByText('option-EUR'));
    });

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith({
        accountId: 'acc-1',
        originalCurrencyCodes: ['EUR'],
        page: 1,
        limit: 25,
      });
    });
    expect(chartProps.current.data).toEqual([
      { month: '2025-01', total: 10, count: 2 },
      { month: '2025-02', total: 2.5, count: 1 },
    ]);
  });

  it('opens the edit modal from the list and refreshes on save', async () => {
    await renderSection();
    await waitFor(() => {
      expect(screen.getByText('Hotel Paris')).toBeInTheDocument();
    });
    expect(mockGetFxFeeSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('Hotel Paris'));
    });
    expect(screen.getByTestId('transaction-form')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('save-form'));
    });

    // Saving closes the modal and reloads both the summary and the list.
    await waitFor(() => {
      expect(mockGetFxFeeSummary).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
  });

  it('fetches the full transaction before editing a split or transfer', async () => {
    const splitTx = {
      id: 'tx-2',
      payeeName: 'Split Vendor',
      isTransfer: false,
      isSplit: true,
    };
    mockGetAll.mockResolvedValue({
      data: [splitTx],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
    });
    mockGetById.mockResolvedValue({ ...splitTx, splits: [] });
    await renderSection();
    await waitFor(() => {
      expect(screen.getByText('Split Vendor')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Split Vendor'));
    });

    expect(mockGetById).toHaveBeenCalledWith('tx-2');
    expect(screen.getByTestId('transaction-form')).toBeInTheDocument();
  });

  it('reloads data when the list requests a refresh (e.g. after delete)', async () => {
    await renderSection();
    await waitFor(() => {
      expect(screen.getByText('refresh-list')).toBeInTheDocument();
    });
    expect(mockGetFxFeeSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('refresh-list'));
    });

    await waitFor(() => {
      expect(mockGetFxFeeSummary).toHaveBeenCalledTimes(2);
    });
  });
});
