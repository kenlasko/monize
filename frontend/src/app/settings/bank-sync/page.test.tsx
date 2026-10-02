import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import BankSyncSettingsPage from './page';
import type { BankSyncConnection, BankSyncStatus } from '@/types/bank-sync';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-layout">{children}</div>
  ),
}));

const mockGetStatus = vi.fn();
const mockListConnections = vi.fn();
const mockGetAccounts = vi.fn();
const mockDeleteConnection = vi.fn();

vi.mock('@/lib/bank-sync', () => ({
  bankSyncApi: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    listConnections: (...args: unknown[]) => mockListConnections(...args),
    listInstitutions: vi.fn().mockResolvedValue([]),
    deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...args: unknown[]) => mockGetAccounts(...args) },
}));

const mockUseDemoMode = vi.fn(() => false);
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

const status = (over: Partial<BankSyncStatus> = {}): BankSyncStatus => ({
  encryptionAvailable: true,
  providers: ['enable_banking'],
  credentials: {
    provider: 'enable_banking',
    applicationId: 'app-1',
    privateKeySet: true,
  },
  redirectUrl: 'https://monize.example/settings/bank-sync/callback',
  ...over,
});

const connection = (over: Partial<BankSyncConnection> = {}): BankSyncConnection => ({
  id: 'c1',
  provider: 'enable_banking',
  institutionName: 'Alpha Bank',
  institutionCountry: 'PL',
  status: 'active',
  validUntil: '2099-01-01T00:00:00.000Z',
  autoSync: false,
  notifySuccess: 'when_imported',
  tagOperationType: true,
  lastError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  accounts: [],
  ...over,
});

async function renderPage() {
  await act(async () => {
    render(<BankSyncSettingsPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseDemoMode.mockReturnValue(false);
  mockGetStatus.mockResolvedValue(status());
  mockListConnections.mockResolvedValue([]);
  mockGetAccounts.mockResolvedValue([]);
});

describe('BankSyncSettingsPage', () => {
  it('shows the header, and no empty state, while it loads', () => {
    mockGetStatus.mockReturnValue(new Promise(() => {}));
    mockListConnections.mockReturnValue(new Promise(() => {}));
    render(<BankSyncSettingsPage />);

    expect(screen.getAllByText('Bank Sync').length).toBeGreaterThan(0);
    expect(screen.queryByText('No banks connected')).toBeNull();
  });

  it('links back to Settings', async () => {
    await renderPage();

    expect(screen.getByRole('link', { name: /Back to Settings/ })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('shows the credentials and, with no connections, the empty state', async () => {
    await renderPage();

    expect(screen.getByText('Enable Banking application')).toBeInTheDocument();
    expect(screen.getByText('app-1')).toBeInTheDocument();
    expect(screen.getByText('No banks connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeEnabled();
  });

  it('lists each connection with its accounts', async () => {
    mockListConnections.mockResolvedValue([
      connection(),
      connection({ id: 'c2', institutionName: 'Beta Credit' }),
    ]);
    await renderPage();

    expect(screen.getByRole('heading', { name: 'Alpha Bank' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Beta Credit' })).toBeInTheDocument();
    expect(screen.queryByText('No banks connected')).toBeNull();
  });

  it('cannot connect a bank before credentials are stored, and says why', async () => {
    mockGetStatus.mockResolvedValue(status({ credentials: null }));
    await renderPage();

    expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeDisabled();
    expect(screen.getByText(/Set up your Enable Banking credentials above/)).toBeInTheDocument();
  });

  it('cannot connect a bank when credentials have no key stored', async () => {
    mockGetStatus.mockResolvedValue(
      status({
        credentials: { provider: 'enable_banking', applicationId: 'app-1', privateKeySet: false },
      }),
    );
    await renderPage();

    expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeDisabled();
  });

  it('opens the connect dialog', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect a bank' }));
    });

    expect(screen.getByLabelText('Country')).toBeInTheDocument();
  });

  describe('a failed read is not an empty list', () => {
    it('shows an error with retry when the connections cannot be read', async () => {
      mockListConnections.mockRejectedValueOnce(new Error('down'));
      await renderPage();

      expect(screen.getByRole('alert')).toHaveTextContent('Could not load your bank connections.');
      expect(screen.queryByText('No banks connected')).toBeNull();

      mockListConnections.mockResolvedValueOnce([connection()]);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });

      expect(await screen.findByRole('heading', { name: 'Alpha Bank' })).toBeInTheDocument();
      expect(screen.queryByText('Could not load your bank connections.')).toBeNull();
    });

    it('treats a failed accounts read as a failed read of the connections', async () => {
      mockListConnections.mockResolvedValue([connection()]);
      mockGetAccounts.mockRejectedValueOnce(new Error('down'));
      await renderPage();

      expect(screen.getByText('Could not load your bank connections.')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Alpha Bank' })).toBeNull();
    });

    it('shows an error with retry when the status cannot be read, and keeps connections', async () => {
      mockGetStatus.mockRejectedValueOnce(new Error('down'));
      mockListConnections.mockResolvedValue([connection()]);
      await renderPage();

      expect(screen.getByText('Could not load bank sync')).toBeInTheDocument();
      expect(screen.queryByText('Enable Banking application')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Alpha Bank' })).toBeInTheDocument();
      // Not knowing whether credentials are stored is not "none stored".
      expect(screen.queryByText('No application is set up yet.')).toBeNull();

      mockGetStatus.mockResolvedValueOnce(status());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });
      expect(await screen.findByText('Enable Banking application')).toBeInTheDocument();
    });
  });

  it('never offers an account another bank account is linked to', async () => {
    mockListConnections.mockResolvedValue([
      connection({
        accounts: [
          {
            id: 'ba-1',
            connectionId: 'c1',
            displayName: 'First',
            identifierMasked: null,
            accountIdentifier: null,
            cashAccountType: null,
            currencyCode: 'EUR',
            accountId: 'a1',
            syncFromDate: '2026-01-01',
            lastSyncedAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            lastImportedCount: null,
            lastSkippedCount: null,
            lastRefusedCount: null,
            bankBalance: null,
            bankBalanceCurrency: null,
            bankBalanceDate: null,
            needsPreview: false,
          },
          {
            id: 'ba-2',
            connectionId: 'c1',
            displayName: 'Second',
            identifierMasked: null,
            accountIdentifier: null,
            cashAccountType: null,
            currencyCode: 'EUR',
            accountId: null,
            syncFromDate: null,
            lastSyncedAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            lastImportedCount: null,
            lastSkippedCount: null,
            lastRefusedCount: null,
            bankBalance: null,
            bankBalanceCurrency: null,
            bankBalanceDate: null,
            needsPreview: false,
          },
        ],
      }),
    ]);
    mockGetAccounts.mockResolvedValue([
      { id: 'a1', name: 'Checking', currencyCode: 'EUR', isClosed: false, accountSubType: null, currentBalance: 0, isFavourite: false, favouriteSortOrder: 0 },
      { id: 'a2', name: 'Savings', currencyCode: 'EUR', isClosed: false, accountSubType: null, currentBalance: 0, isFavourite: false, favouriteSortOrder: 0 },
    ]);
    await renderPage();

    const [first, second] = screen.getAllByLabelText('Monize account') as HTMLSelectElement[];
    expect(Array.from(first.options).map((o) => o.textContent)).toEqual([
      'Not linked',
      'Create a new account',
      'Checking (EUR)',
      'Savings (EUR)',
    ]);
    expect(first.value).toBe('a1');
    expect(Array.from(second.options).map((o) => o.textContent)).toEqual([
      'Not linked',
      'Create a new account',
      'Savings (EUR)',
    ]);
  });

  describe('demo mode', () => {
    it('shows the restriction and disables the writes', async () => {
      mockUseDemoMode.mockReturnValue(true);
      mockListConnections.mockResolvedValue([connection()]);
      await renderPage();

      expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Edit credentials' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    });
  });

  it('reloads the connections after a change made on a card', async () => {
    mockListConnections.mockResolvedValue([connection()]);
    await renderPage();
    expect(mockListConnections).toHaveBeenCalledTimes(1);

    // Disconnect is a write that reloads the list.
    mockDeleteConnection.mockResolvedValue(undefined);
    mockListConnections.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!);
    });

    await waitFor(() => expect(mockListConnections).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No banks connected')).toBeInTheDocument();
  });
});
