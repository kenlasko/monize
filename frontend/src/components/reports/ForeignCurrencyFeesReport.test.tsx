import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ForeignCurrencyFeesReport } from './ForeignCurrencyFeesReport';
import type { Account } from '@/types/account';

const mockGetAccounts = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...a: unknown[]) => mockGetAccounts(...a) },
}));

const mockGetFxFeeSummary = vi.fn();
const mockGetFxFeeTotals = vi.fn();
const mockGetAll = vi.fn();
const mockGetById = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getFxFeeSummary: (...a: unknown[]) => mockGetFxFeeSummary(...a),
    getFxFeeTotals: (...a: unknown[]) => mockGetFxFeeTotals(...a),
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getById: (...a: unknown[]) => mockGetById(...a),
  },
}));

const mockExportCsv = vi.fn();
vi.mock('@/lib/fx-fees-csv', () => ({
  exportForeignTransactionsCsv: (...a: unknown[]) => mockExportCsv(...a),
}));

// The reader reports in CAD; a foreign account's fees arrive already
// converted by the server (`convertedFeeTotal`).
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Account selector: expose a button per offered account so tests can select.
vi.mock('@/components/reports/ReportAccountMultiSelect', () => ({
  ReportAccountMultiSelect: ({ accounts, filter, onChange }: any) => (
    <div data-testid="account-select">
      {accounts.filter(filter).map((a: any) => (
        <button key={a.id} onClick={() => onChange([a.id])}>{`acct-${a.id}`}</button>
      ))}
    </div>
  ),
}));

const chartProps: { current: any } = { current: null };
vi.mock('@/components/accounts/shared/ForeignCurrencyFeeChart', () => ({
  ForeignCurrencyFeeChart: (props: any) => {
    chartProps.current = props;
    return <div data-testid="fee-chart" />;
  },
}));

const listProps: { current: any } = { current: null };
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: (props: any) => {
    listProps.current = props;
    return (
      <div data-testid="transaction-list">
        {props.onExport && <button onClick={() => props.onExport()}>export-list</button>}
      </div>
    );
  },
}));

vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: () => <div data-testid="transaction-form" />,
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ options, onChange, value }: any) => (
    <div data-testid="currency-filter" data-selected={value.join(',')}>
      {options.map((o: any) => (
        <button key={o.value} onClick={() => onChange([o.value])}>{`ccy-${o.label}`}</button>
      ))}
    </div>
  ),
}));

/** The server's totals over one month's fees. */
function feeTotals(
  currency: string,
  total: number,
  count: number,
  gap: { missingCurrencies: string[]; excludedCount: number } = { missingCurrencies: [], excludedCount: 0 },
) {
  // A fee left out makes every figure over its month a subtotal: null, with
  // the known part beside it.
  const figure = gap.missingCurrencies.length === 0 ? total : null;
  const bucket = (key: string, periodStart: string) => ({ key, periodStart, total: figure, knownTotal: total, count });
  const average = { periodAverage: figure, knownPeriodAverage: total };
  return {
    currency,
    total: figure,
    knownTotal: total,
    count,
    byGranularity: {
      month: { buckets: [bucket('2026-01', '2026-01-01')], ...average },
      quarter: { buckets: [bucket('2026-Q1', '2026-01-01')], ...average },
      year: { buckets: [bucket('2026', '2026-01-01')], ...average },
    },
    ...gap,
  };
}

const accounts = [
  { id: 'cad-1', name: 'CAD Travel', currencyCode: 'CAD', fxFeePercent: 2.5 },
  { id: 'usd-1', name: 'USD Card', currencyCode: 'USD', fxFeePercent: 1.5 },
  { id: 'plain', name: 'No Fee', currencyCode: 'CAD', fxFeePercent: 0 },
] as unknown as Account[];

async function renderReport() {
  await act(async () => {
    render(<ForeignCurrencyFeesReport />);
  });
}

describe('ForeignCurrencyFeesReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartProps.current = null;
    listProps.current = null;
    mockGetAccounts.mockResolvedValue(accounts);
    mockGetFxFeeSummary.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'cad-1'
          ? [{ month: '2026-01', currencyCode: 'EUR', feeTotal: 10, count: 1, convertedCurrency: 'CAD', convertedFeeTotal: 10 }]
          : // 5 USD of fees, converted at each fee's own date to 7 CAD.
            [{ month: '2026-01', currencyCode: 'USD', feeTotal: 5, count: 1, convertedCurrency: 'CAD', convertedFeeTotal: 7 }],
      ),
    );
    // Mixed currencies total in CAD: 10 (CAD acct) + the server's 7 for the
    // USD acct; the USD account alone totals its own 5 USD.
    mockGetFxFeeTotals.mockImplementation((ids: string[]) =>
      Promise.resolve(ids.length === 1 && ids[0] === 'usd-1' ? feeTotals('USD', 5, 1) : feeTotals('CAD', 17, 2)),
    );
    mockGetAll.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 25, total: 0, totalPages: 0, hasMore: false },
    });
    mockExportCsv.mockResolvedValue(0);
  });

  it('shows the no-eligible-accounts message when none have a fee', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'x', name: 'Plain', currencyCode: 'CAD', fxFeePercent: 0 },
    ] as unknown as Account[]);
    await renderReport();
    await waitFor(() => {
      expect(
        screen.getByText(/no accounts have a foreign-transaction fee/i),
      ).toBeInTheDocument();
    });
  });

  it('only offers accounts with a non-zero fee in the account selector', async () => {
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('acct-cad-1')).toBeInTheDocument();
    });
    expect(screen.getByText('acct-usd-1')).toBeInTheDocument();
    expect(screen.queryByText('acct-plain')).not.toBeInTheDocument();
  });

  it('defaults to all eligible accounts and converts mixed currencies to the default', async () => {
    await renderReport();

    await waitFor(() => {
      expect(chartProps.current?.isLoading).toBe(false);
    });
    // Both eligible accounts fetched (default = all eligible).
    expect(mockGetFxFeeSummary).toHaveBeenCalledWith('cad-1');
    expect(mockGetFxFeeSummary).toHaveBeenCalledWith('usd-1');
    // The totals are asked of the server over both accounts, in CAD.
    expect(mockGetFxFeeTotals).toHaveBeenCalledWith(['cad-1', 'usd-1'], []);
    expect(chartProps.current.currencyCode).toBe('CAD');
    expect(chartProps.current.data).toEqual([{ month: '2026-01', total: 17, knownSubtotal: 17, count: 2 }]);
  });

  // The page added each account's four-place conversions into its months, and
  // the chart added those into its quarters and total: three fees of 2.50496
  // read 7.50 where they come to 7.51. Every figure is now the server's
  // (issue #2413).
  it("hands the chart the server's columns, total and averages, never a sum of rows", async () => {
    const served = {
      currency: 'CAD',
      total: 7.51,
      knownTotal: 7.51,
      count: 3,
      byGranularity: {
        month: {
          buckets: [
            { key: '2026-01', periodStart: '2026-01-01', total: 2.5, knownTotal: 2.5, count: 1 },
            { key: '2026-02', periodStart: '2026-02-01', total: 2.5, knownTotal: 2.5, count: 1 },
            { key: '2026-03', periodStart: '2026-03-01', total: 2.5, knownTotal: 2.5, count: 1 },
          ],
          periodAverage: 2.5,
          knownPeriodAverage: 2.5,
        },
        quarter: {
          buckets: [{ key: '2026-Q1', periodStart: '2026-01-01', total: 7.51, knownTotal: 7.51, count: 3 }],
          periodAverage: 7.51,
          knownPeriodAverage: 7.51,
        },
        year: {
          buckets: [{ key: '2026', periodStart: '2026-01-01', total: 7.51, knownTotal: 7.51, count: 3 }],
          periodAverage: 7.51,
          knownPeriodAverage: 7.51,
        },
      },
      missingCurrencies: [],
      excludedCount: 0,
    };
    mockGetFxFeeTotals.mockResolvedValue(served);
    await renderReport();

    await waitFor(() => {
      expect(chartProps.current?.totals).toEqual(served);
    });
    expect(chartProps.current.data).toEqual([
      { month: '2026-01', total: 2.5, knownSubtotal: 2.5, count: 1 },
      { month: '2026-02', total: 2.5, knownSubtotal: 2.5, count: 1 },
      { month: '2026-03', total: 2.5, knownSubtotal: 2.5, count: 1 },
    ]);
  });

  it('asks the server again with the paid currencies chosen', async () => {
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('ccy-EUR')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('ccy-EUR'));
    });
    await waitFor(() => {
      expect(mockGetFxFeeTotals).toHaveBeenLastCalledWith(['cad-1', 'usd-1'], ['EUR']);
    });
  });

  it('says the totals failed rather than drawing no fees', async () => {
    mockGetFxFeeTotals.mockRejectedValue(new Error('down'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('fee-chart')).not.toBeInTheDocument();
  });

  it('leaves out a fee the server had no rate for on its date, never at face value', async () => {
    mockGetFxFeeTotals.mockResolvedValue(
      feeTotals('CAD', 10, 1, { missingCurrencies: ['USD'], excludedCount: 1 }),
    );
    await renderReport();

    await waitFor(() => {
      expect(chartProps.current?.isLoading).toBe(false);
    });
    // The month lost a fee: its total withheld, the known 10 beside it.
    expect(chartProps.current.data).toEqual([{ month: '2026-01', total: null, knownSubtotal: 10, count: 1 }]);
    expect(chartProps.current.totals.missingCurrencies).toEqual(['USD']);
    expect(document.body).toHaveTextContent('USD');
  });

  it('shows native currency (no conversion) for a single-account selection', async () => {
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('acct-usd-1')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('acct-usd-1'));
    });

    await waitFor(() => {
      expect(chartProps.current.currencyCode).toBe('USD');
    });
    // Native USD, no 1.4 conversion applied.
    expect(chartProps.current.data).toEqual([{ month: '2026-01', total: 5, knownSubtotal: 5, count: 1 }]);
  });

  it('exports across the effective accounts and paid currencies', async () => {
    mockExportCsv.mockResolvedValue(3);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('export-list')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('export-list'));
    });

    expect(mockExportCsv).toHaveBeenCalledWith({
      accountIds: ['cad-1', 'usd-1'],
      currencyCodes: ['EUR', 'USD'],
    });
  });

  it('restores the persisted account selection', async () => {
    window.localStorage.setItem(
      'monize-reports-foreign-currency-fees-accounts',
      JSON.stringify(['usd-1']),
    );
    await renderReport();
    await waitFor(() => {
      expect(mockGetFxFeeSummary).toHaveBeenCalled();
    });
    // Fee summaries are only fetched for the persisted account.
    expect(mockGetFxFeeSummary.mock.calls.map((call) => call[0])).toEqual(['usd-1']);
  });

  it('drops persisted account IDs that are no longer eligible', async () => {
    window.localStorage.setItem(
      'monize-reports-foreign-currency-fees-accounts',
      JSON.stringify(['usd-1', 'plain']),
    );
    await renderReport();
    // 'plain' has no FX fee, so it is not an option and is dropped.
    await waitFor(() => {
      expect(
        window.localStorage.getItem('monize-reports-foreign-currency-fees-accounts'),
      ).toBe(JSON.stringify(['usd-1']));
    });
  });
});
