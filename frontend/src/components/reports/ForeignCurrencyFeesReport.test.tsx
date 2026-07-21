import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ForeignCurrencyFeesReport } from './ForeignCurrencyFeesReport';
import type { Account } from '@/types/account';

const mockGetAccounts = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...a: unknown[]) => mockGetAccounts(...a) },
}));

const mockGetFxFeeSummary = vi.fn();
const mockGetAll = vi.fn();
const mockGetById = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getFxFeeSummary: (...a: unknown[]) => mockGetFxFeeSummary(...a),
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getById: (...a: unknown[]) => mockGetById(...a),
  },
}));

const mockExportCsv = vi.fn();
vi.mock('@/lib/fx-fees-csv', () => ({
  exportForeignTransactionsCsv: (...a: unknown[]) => mockExportCsv(...a),
}));

// Convert to default currency (CAD) by a fixed 1.4 for USD, identity otherwise.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number, from: string) =>
      from === 'USD' ? amount * 1.4 : amount,
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
          ? [{ month: '2026-01', currencyCode: 'EUR', feeTotal: 10, count: 1 }]
          : [{ month: '2026-01', currencyCode: 'USD', feeTotal: 5, count: 1 }],
      ),
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
    // Mixed currencies -> convert to CAD: 10 (CAD acct) + 5*1.4 (USD acct) = 17.
    expect(chartProps.current.currencyCode).toBe('CAD');
    expect(chartProps.current.data).toEqual([{ month: '2026-01', total: 17, count: 2 }]);
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
    expect(chartProps.current.data).toEqual([{ month: '2026-01', total: 5, count: 1 }]);
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
});
