import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InstitutionAccountsManager } from './InstitutionAccountsManager';
import { Institution } from '@/types/institution';
import { Account } from '@/types/account';
import { institutionsApi } from '@/lib/institutions';
import { accountsApi } from '@/lib/accounts';

vi.mock('@/lib/institutions', () => ({
  institutionsApi: {
    getAccounts: vi.fn(),
    assignAccount: vi.fn(),
    unassignAccount: vi.fn(),
  },
  institutionLogoUrl: (id: string) => `/api/v1/institutions/${id}/logo`,
}));
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn() },
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const institution: Institution = {
  id: 'i-1',
  userId: 'u-1',
  name: 'TD',
  website: 'https://td.com',
  country: 'CA',
  hasLogo: false,
  logoFetchedAt: null,
  createdAt: '',
  updatedAt: '',
  accountCount: 1,
};

const account = (id: string, name: string): Account =>
  ({ id, name, institutionId: null }) as Account;

const investmentAccount = (
  id: string,
  name: string,
  subType: 'INVESTMENT_CASH' | 'INVESTMENT_BROKERAGE',
  linkedAccountId: string,
): Account =>
  ({
    id,
    name,
    institutionId: null,
    accountType: 'INVESTMENT',
    accountSubType: subType,
    linkedAccountId,
  }) as Account;

async function renderManager(onChanged = vi.fn(), onClose = vi.fn()) {
  await act(async () => {
    render(
      <InstitutionAccountsManager
        institution={institution}
        isOpen
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
  });
  return { onChanged, onClose };
}

describe('InstitutionAccountsManager', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the accounts assigned to the institution', async () => {
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([
      account('a-1', 'Chequing'),
    ]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([
      account('a-1', 'Chequing'),
      account('a-2', 'Savings'),
    ]);

    await renderManager();

    await waitFor(() =>
      expect(screen.getByText('Chequing')).toBeInTheDocument(),
    );
  });

  it('navigates to the filtered Transactions page when an account is clicked', async () => {
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([
      account('a-1', 'Chequing'),
    ]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([account('a-1', 'Chequing')]);

    const onClose = vi.fn();
    await renderManager(vi.fn(), onClose);
    await waitFor(() =>
      expect(screen.getByText('Chequing')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Chequing'));
    });

    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=a-1');
  });

  it('removes an assigned account', async () => {
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([
      account('a-1', 'Chequing'),
    ]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([account('a-1', 'Chequing')]);
    vi.mocked(institutionsApi.unassignAccount).mockResolvedValue(
      account('a-1', 'Chequing'),
    );

    const { onChanged } = await renderManager();
    await waitFor(() =>
      expect(screen.getByText('Chequing')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Remove'));
    });

    await waitFor(() =>
      expect(institutionsApi.unassignAccount).toHaveBeenCalledWith('i-1', 'a-1'),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a linked investment pair as a single main account', async () => {
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([
      investmentAccount('a-cash', 'TFSA - Cash', 'INVESTMENT_CASH', 'a-brok'),
      investmentAccount('a-brok', 'TFSA - Brokerage', 'INVESTMENT_BROKERAGE', 'a-cash'),
    ]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([
      investmentAccount('a-cash', 'TFSA - Cash', 'INVESTMENT_CASH', 'a-brok'),
      investmentAccount('a-brok', 'TFSA - Brokerage', 'INVESTMENT_BROKERAGE', 'a-cash'),
    ]);

    await renderManager();

    // The pair collapses to one row showing the main account name.
    await waitFor(() => expect(screen.getByText('TFSA')).toBeInTheDocument());
    expect(screen.queryByText('TFSA - Cash')).not.toBeInTheDocument();
    expect(screen.queryByText('TFSA - Brokerage')).not.toBeInTheDocument();
    expect(screen.getAllByText('Remove')).toHaveLength(1);
  });

  it('filters assigned accounts by active/closed status', async () => {
    const open = { id: 'a-1', name: 'Open Chequing', institutionId: 'i-1', isClosed: false } as Account;
    const closed = { id: 'a-2', name: 'Old Savings', institutionId: 'i-1', isClosed: true } as Account;
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([open, closed]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([]);

    await renderManager();

    // "All" is the default, so both accounts are listed.
    await waitFor(() =>
      expect(screen.getByText('Open Chequing')).toBeInTheDocument(),
    );
    expect(screen.getByText('Old Savings')).toBeInTheDocument();

    // "Active" hides closed accounts.
    await act(async () => {
      fireEvent.click(screen.getByText('Active'));
    });
    expect(screen.getByText('Open Chequing')).toBeInTheDocument();
    expect(screen.queryByText('Old Savings')).not.toBeInTheDocument();

    // "Closed" shows only closed accounts.
    await act(async () => {
      fireEvent.click(screen.getByText('Closed'));
    });
    expect(screen.getByText('Old Savings')).toBeInTheDocument();
    expect(screen.queryByText('Open Chequing')).not.toBeInTheDocument();
  });

  it('shows a no-match message when the filter excludes every account', async () => {
    const open = { id: 'a-1', name: 'Open Chequing', institutionId: 'i-1', isClosed: false } as Account;
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([open]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([]);

    await renderManager();
    await waitFor(() =>
      expect(screen.getByText('Open Chequing')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Closed'));
    });

    expect(
      screen.getByText('No accounts match the selected filter.'),
    ).toBeInTheDocument();
  });

  it('shows the empty state when no accounts are assigned', async () => {
    vi.mocked(institutionsApi.getAccounts).mockResolvedValue([]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([account('a-2', 'Savings')]);

    await renderManager();

    await waitFor(() =>
      expect(
        screen.getByText('No accounts are assigned to this institution yet.'),
      ).toBeInTheDocument(),
    );
  });
});
