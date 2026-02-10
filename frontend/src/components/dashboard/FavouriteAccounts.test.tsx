import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { FavouriteAccounts } from './FavouriteAccounts';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: () => ({
    preferences: { defaultCurrency: 'CAD' },
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

describe('FavouriteAccounts', () => {
  it('renders loading state', () => {
    render(<FavouriteAccounts accounts={[]} isLoading={true} />);
    expect(screen.getByText('Favourite Accounts')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no favourites', () => {
    render(<FavouriteAccounts accounts={[]} isLoading={false} />);
    expect(screen.getByText(/No favourite accounts yet/)).toBeInTheDocument();
  });

  it('renders favourite accounts with balances', () => {
    const accounts = [
      { id: '1', name: 'Checking', currentBalance: 1500, currencyCode: 'CAD', isFavourite: true, isClosed: false, institution: 'TD Bank' },
      { id: '2', name: 'Savings', currentBalance: -200, currencyCode: 'CAD', isFavourite: true, isClosed: false },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
    expect(screen.getByText('TD Bank')).toBeInTheDocument();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
  });

  it('excludes closed accounts from display', () => {
    const accounts = [
      { id: '1', name: 'Open', currentBalance: 100, currencyCode: 'CAD', isFavourite: true, isClosed: false },
      { id: '2', name: 'Closed', currentBalance: 0, currencyCode: 'CAD', isFavourite: true, isClosed: true },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });
});
