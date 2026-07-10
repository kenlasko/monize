import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { AssetDetailView } from './AssetDetailView';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (a: number) => `$${a.toFixed(2)}`,
    formatPercent: (a: number) => `${a.toFixed(2)}%`,
  }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: Date) => `${d.getFullYear()}` }),
}));
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: () => <div data-testid="balance-history-chart" />,
}));

const mockGetAll = vi.fn();
const mockGetDailyBalances = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getDailyBalances: (...a: unknown[]) => mockGetDailyBalances(...a),
    update: vi.fn().mockResolvedValue({}),
  },
}));

const mockCategoriesGetAll = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: (...a: unknown[]) => mockCategoriesGetAll(...a) },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: { create: vi.fn().mockResolvedValue({}) },
}));

const asset = {
  id: 'asset-1',
  accountType: 'ASSET',
  name: 'House',
  currencyCode: 'CAD',
  openingBalance: 100000,
  currentBalance: 120000,
  dateAcquired: '2022-01-01',
  assetCategoryId: 'cat-1',
  linkedLoanAccountId: 'loan-1',
} as Account;

const loan = {
  id: 'loan-1',
  accountType: 'MORTGAGE',
  name: 'Mortgage',
  currencyCode: 'CAD',
  currentBalance: -80000,
  isClosed: false,
} as Account;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAll.mockResolvedValue([asset, loan]);
  mockCategoriesGetAll.mockResolvedValue([{ id: 'cat-1', name: 'Real Estate' }]);
  mockGetDailyBalances.mockImplementation((params: { accountIds: string }) =>
    Promise.resolve(
      params.accountIds === 'loan-1'
        ? [{ date: '2026-01-01', balance: -80000 }]
        : [{ date: '2026-01-01', balance: 120000 }],
    ),
  );
});

async function renderView(account = asset) {
  await act(async () => {
    render(<AssetDetailView account={account} />);
  });
}

describe('AssetDetailView', () => {
  it('renders value figures and the resolved category', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Real Estate')).toBeInTheDocument());
    expect(screen.getByText('Current Value')).toBeInTheDocument();
    expect(screen.getByText('$20000.00')).toBeInTheDocument(); // total appreciation (unique)
    expect(screen.getByRole('button', { name: 'Update Value' })).toBeInTheDocument();
  });

  it('shows the equity panel linked to the loan', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Linked to Mortgage')).toBeInTheDocument());
    // Equity = 120000 - 80000.
    expect(screen.getByText('$40000.00')).toBeInTheDocument();
    expect(mockGetDailyBalances).toHaveBeenCalledWith({ accountIds: 'loan-1' });
  });

  it('offers a loan picker when nothing is linked', async () => {
    await renderView({ ...asset, linkedLoanAccountId: null } as Account);
    await waitFor(() =>
      expect(
        screen.getByText('Link a loan or mortgage to track equity on this asset.'),
      ).toBeInTheDocument(),
    );
  });
});
