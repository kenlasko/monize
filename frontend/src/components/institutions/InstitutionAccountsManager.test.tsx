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

async function renderManager(onChanged = vi.fn()) {
  await act(async () => {
    render(
      <InstitutionAccountsManager
        institution={institution}
        isOpen
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );
  });
  return { onChanged };
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
