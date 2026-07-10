import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { AssetSummaryCards } from './AssetSummaryCards';
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

function makeAsset(overrides: Partial<Account> = {}): Account {
  return {
    id: 'asset-1',
    accountType: 'ASSET',
    name: 'House',
    currencyCode: 'CAD',
    openingBalance: 100000,
    currentBalance: 120000,
    dateAcquired: null,
    assetCategoryId: null,
    ...overrides,
  } as Account;
}

describe('AssetSummaryCards', () => {
  it('renders value, purchase, and appreciation', () => {
    render(<AssetSummaryCards account={makeAsset()} categoryName="Real Estate" />);
    expect(screen.getByText('$120000.00')).toBeInTheDocument();
    expect(screen.getByText('$100000.00')).toBeInTheDocument();
    expect(screen.getByText('$20000.00')).toBeInTheDocument(); // appreciation
    expect(screen.getByText('Real Estate')).toBeInTheDocument();
  });

  it('shows Not set for annualized without an acquisition date', () => {
    render(<AssetSummaryCards account={makeAsset()} categoryName={null} />);
    // Annualized + Category both "Not set".
    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(2);
  });
});
