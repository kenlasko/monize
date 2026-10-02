import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import toast from 'react-hot-toast';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import { BankSyncConnectionCard } from './BankSyncConnectionCard';
import type { Account } from '@/types/account';
import type {
  BankSyncAccount,
  BankSyncConnection,
  BankSyncFailure,
  BankSyncResult,
} from '@/types/bank-sync';

const mockUpdateConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockReauthorize = vi.fn();
const mockUpdateAccount = vi.fn();
const mockSyncAccount = vi.fn();
const mockSyncConnection = vi.fn();
const mockGetLinkDefaults = vi.fn();
const mockMatchAccounts = vi.fn();
const mockPreviewAccount = vi.fn();

vi.mock('@/lib/bank-sync', () => ({
  bankSyncApi: {
    updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
    deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
    reauthorize: (...args: unknown[]) => mockReauthorize(...args),
    updateAccount: (...args: unknown[]) => mockUpdateAccount(...args),
    syncAccount: (...args: unknown[]) => mockSyncAccount(...args),
    syncConnection: (...args: unknown[]) => mockSyncConnection(...args),
    getLinkDefaults: (...args: unknown[]) => mockGetLinkDefaults(...args),
    matchAccounts: (...args: unknown[]) => mockMatchAccounts(...args),
    previewAccount: (...args: unknown[]) => mockPreviewAccount(...args),
  },
}));

vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2026-09-30',
}));

// The account form is the Accounts page's own and has its own tests; here only
// what the row hands it (its prefill and what happens to the account it makes).
let accountModalProps: {
  formModal: { showForm: boolean };
  initialValues?: Record<string, unknown>;
  onCreated?: (created: Account) => void;
} | null = null;
vi.mock('@/components/accounts/AccountFormModal', () => ({
  AccountFormModal: (props: NonNullable<typeof accountModalProps>) => {
    accountModalProps = props;
    return props.formModal.showForm ? <div data-testid="account-form-modal" /> : null;
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number, code?: string) => `${code ?? '???'} ${amount.toFixed(2)}`,
      formatNumber: (amount: number) => `n ${amount.toFixed(2)}`,
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => `on ${d.slice(0, 10)}`,
    dateFormat: 'YYYY-MM-DD',
    datePattern: 'YYYY-MM-DD',
  }),
}));

vi.mock('@/hooks/useRelativeTime', () => ({
  useRelativeTime: () => (value: string) => `rel(${value})`,
}));

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const account = (over: Partial<Account>): Account =>
  ({
    id: 'a1',
    name: 'Checking',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'EUR',
    currentBalance: 1000,
    isClosed: false,
    isFavourite: false,
    favouriteSortOrder: 0,
    isJoint: false,
    ...over,
  }) as Account;

const bankAccount = (over: Partial<BankSyncAccount> = {}): BankSyncAccount => ({
  id: 'ba-1',
  connectionId: 'c1',
  displayName: 'Everyday',
  identifierMasked: 'PL12 **** 3456',
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
  ...over,
});

const connection = (over: Partial<BankSyncConnection> = {}): BankSyncConnection => ({
  id: 'c1',
  provider: 'enable_banking',
  institutionName: 'Alpha Bank',
  institutionCountry: 'PL',
  status: 'active',
  validUntil: inDays(60),
  autoSync: false,
  notifySuccess: 'when_imported',
  tagOperationType: true,
  lastError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  accounts: [bankAccount()],
  ...over,
});

const result = (over: Partial<BankSyncResult> = {}): BankSyncResult => ({
  bankAccountId: 'ba-1',
  imported: 0,
  skipped: 0,
  refused: {},
  pending: 0,
  beforeCutoff: 0,
  bankBalance: null,
  ...over,
});

const failure = (bankAccountId: string, message = 'The bank did not answer.'): BankSyncFailure => ({
  bankAccountId,
  error: { code: 'unavailable', message },
});

/** An axios failure: a timeout has no response, a refusal or a crash has a status. */
const axiosFailure = (status?: number) =>
  new AxiosError(
    'failed',
    status === undefined ? 'ECONNABORTED' : 'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    status === undefined
      ? undefined
      : {
          status,
          statusText: '',
          headers: {},
          config: { headers: new AxiosHeaders() },
          data: { message: `Server said ${status}` },
        },
  );

const originalLocation = window.location;
const assign = vi.fn();

const defaultAccounts = [
  account({ id: 'a1', name: 'Checking' }),
  account({ id: 'a2', name: 'Savings' }),
];

function renderCard(
  conn: BankSyncConnection,
  options: {
    accounts?: Account[];
    linked?: string[];
    disabled?: boolean;
  } = {},
) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <BankSyncConnectionCard
      connection={conn}
      accounts={options.accounts ?? defaultAccounts}
      linkedAccountIds={new Set(options.linked ?? [])}
      disabled={options.disabled}
      onChanged={onChanged}
    />,
  );
  return { onChanged, ...view };
}

const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

const linkSelect = () => screen.getByLabelText('Monize account') as HTMLSelectElement;
const optionLabels = () => Array.from(linkSelect().options).map((o) => o.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  accountModalProps = null;
  // The newest transaction in the account being linked, and the default after it.
  mockGetLinkDefaults.mockResolvedValue({
    newestTransactionDate: '2026-02-01',
    defaultSyncFromDate: '2026-02-02',
  });
  Object.defineProperty(window, 'location', {
    value: { ...originalLocation, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe('BankSyncConnectionCard', () => {
  describe('the connection', () => {
    it('shows the bank, its status and when the consent ends', () => {
      renderCard(connection({ validUntil: '2030-05-20T00:00:00.000Z' }));

      expect(screen.getByRole('heading', { name: 'Alpha Bank' })).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Access valid until on 2030-05-20')).toBeInTheDocument();
      expect(screen.queryByText('Expires soon')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Renew consent' })).toBeNull();
    });

    it('flags a consent that ends within a week and offers to renew it', () => {
      renderCard(connection({ validUntil: inDays(3) }));

      expect(screen.getByText('Expires soon')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Renew consent' })).toBeInTheDocument();
    });

    it('does not flag a consent that ends in more than a week', () => {
      renderCard(connection({ validUntil: inDays(8) }));

      expect(screen.queryByText('Expires soon')).toBeNull();
    });

    it('shows an expired connection as expired, offers renewal and no sync', () => {
      renderCard(
        connection({
          status: 'expired',
          accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })],
        }),
      );

      expect(screen.getByText('Expired')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Renew consent' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sync all' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    });

    it('treats an active connection past its valid-until as expired', () => {
      renderCard(connection({ status: 'active', validUntil: inDays(-1) }));

      expect(screen.getByText('Expired')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Renew consent' })).toBeInTheDocument();
    });

    it('shows a failed connection with the bank error and offers to renew it', () => {
      renderCard(connection({ status: 'failed', lastError: 'Access denied at the bank', accounts: [] }));

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Access denied at the bank')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Renew consent' })).toBeInTheDocument();
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('says a pending connection was not completed, and offers to renew instead of telling the reader to disconnect', () => {
      renderCard(connection({ status: 'pending', accounts: [] }));

      expect(screen.getByText(/authorization at the bank was not completed/)).toBeInTheDocument();
      expect(screen.getByText(/Renew consent to try again/)).toBeInTheDocument();
      expect(screen.queryByText(/Disconnect and connect again/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Renew consent' })).toBeInTheDocument();
    });

    it('shows the accounts a pending connection already has, so renewing keeps them in view', () => {
      renderCard(
        connection({
          status: 'pending',
          accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })],
        }),
      );

      expect(screen.getByText(/authorization at the bank was not completed/)).toBeInTheDocument();
      expect(screen.getByText('Bank accounts')).toBeInTheDocument();
      expect(screen.getByText('Everyday')).toBeInTheDocument();
      // A pending connection cannot be synced.
      expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sync all' })).toBeNull();
    });

    it('does not say the bank reported no accounts for a pending connection that has none yet', () => {
      renderCard(connection({ status: 'pending', accounts: [] }));

      expect(screen.queryByText(/has not reported any accounts/)).toBeNull();
    });

    it('says the bank reported no accounts, rather than showing an empty list', () => {
      renderCard(connection({ accounts: [] }));

      expect(screen.getByText(/has not reported any accounts/)).toBeInTheDocument();
    });
  });

  describe('renew consent', () => {
    it('starts the authorization and sends the browser to the bank', async () => {
      mockReauthorize.mockResolvedValue({
        connectionId: 'c1',
        authorizationUrl: 'https://bank.example/authorize?state=z',
      });
      renderCard(connection({ status: 'expired' }));

      await click('Renew consent');

      expect(mockReauthorize).toHaveBeenCalledWith('c1');
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://bank.example/authorize?state=z'),
      );
    });

    it.each(['pending', 'failed'] as const)('starts a renewal of a %s connection', async (status) => {
      mockReauthorize.mockResolvedValue({
        connectionId: 'c1',
        authorizationUrl: 'https://bank.example/authorize?state=z',
      });
      renderCard(connection({ status }));

      await click('Renew consent');

      expect(mockReauthorize).toHaveBeenCalledWith('c1');
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://bank.example/authorize?state=z'),
      );
    });

    it('does not navigate to an address that is not https', async () => {
      mockReauthorize.mockResolvedValue({
        connectionId: 'c1',
        authorizationUrl: 'javascript:alert(1)',
      });
      renderCard(connection({ status: 'expired' }));

      await click('Renew consent');

      expect(assign).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Renew consent' })).toBeEnabled();
    });

    it('shows the server message when renewal cannot be started', async () => {
      mockReauthorize.mockRejectedValue({ response: { data: { message: 'Credentials missing' } } });
      renderCard(connection({ status: 'expired' }));

      await click('Renew consent');

      expect(toast.error).toHaveBeenCalledWith('Credentials missing');
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('automatic sync', () => {
    it('saves on change', async () => {
      mockUpdateConnection.mockResolvedValue(connection({ autoSync: true }));
      renderCard(connection({ autoSync: false }));

      const toggle = screen.getByRole('switch', { name: 'Sync automatically once a day' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(mockUpdateConnection).toHaveBeenCalledWith('c1', { autoSync: true });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toast.success).toHaveBeenCalledWith('Automatic sync turned on');
    });

    it('reverts the switch when saving fails', async () => {
      mockUpdateConnection.mockRejectedValue({ response: { data: { message: 'Nope' } } });
      renderCard(connection({ autoSync: true }));

      const toggle = screen.getByRole('switch', { name: 'Sync automatically once a day' });
      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toast.error).toHaveBeenCalledWith('Nope');
    });

    it('follows the server when a reload brings a different value', () => {
      const { rerender } = renderCard(connection({ autoSync: false }));
      const toggle = screen.getByRole('switch', { name: 'Sync automatically once a day' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      rerender(
        <BankSyncConnectionCard
          connection={connection({ autoSync: true })}
          accounts={defaultAccounts}
          linkedAccountIds={new Set()}
          onChanged={vi.fn()}
        />,
      );

      expect(screen.getByRole('switch', { name: 'Sync automatically once a day' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  });

  describe('tagging with the bank\'s operation type', () => {
    const toggle = () =>
      screen.getByRole('switch', { name: 'Tag transactions with the bank\'s operation type' });

    it('shows the setting the server holds, on by default', () => {
      renderCard(connection());
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
    });

    it('explains itself in a tooltip', () => {
      renderCard(connection());
      expect(
        screen.getByRole('button', { name: /named after the bank's operation type/ }),
      ).toBeInTheDocument();
    });

    it('saves on change, sending only that setting', async () => {
      mockUpdateConnection.mockResolvedValue(connection({ tagOperationType: false }));
      renderCard(connection({ tagOperationType: true }));

      await act(async () => {
        fireEvent.click(toggle());
      });

      expect(mockUpdateConnection).toHaveBeenCalledWith('c1', { tagOperationType: false });
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
      expect(toast.success).toHaveBeenCalledWith('Operation type tags turned off');
    });

    it('says so when it is turned back on', async () => {
      mockUpdateConnection.mockResolvedValue(connection({ tagOperationType: true }));
      renderCard(connection({ tagOperationType: false }));
      await act(async () => {
        fireEvent.click(toggle());
      });
      expect(mockUpdateConnection).toHaveBeenCalledWith('c1', { tagOperationType: true });
      expect(toast.success).toHaveBeenCalledWith('Operation type tags turned on');
    });

    it('puts the switch back and says why when saving fails', async () => {
      mockUpdateConnection.mockRejectedValue({ response: { data: { message: 'Nope' } } });
      renderCard(connection({ tagOperationType: true }));

      await act(async () => {
        fireEvent.click(toggle());
      });

      expect(toggle()).toHaveAttribute('aria-checked', 'true');
      expect(toast.error).toHaveBeenCalledWith('Nope');
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('says it could not change the setting when the server gave no reason', async () => {
      mockUpdateConnection.mockRejectedValue({ response: { data: {} } });
      renderCard(connection({ tagOperationType: true }));
      await act(async () => {
        fireEvent.click(toggle());
      });
      expect(toast.error).toHaveBeenCalledWith('Could not change the operation type tags');
    });

    it('follows the server when a reload brings a different value', () => {
      const { rerender } = renderCard(connection({ tagOperationType: true }));
      rerender(
        <BankSyncConnectionCard
          connection={connection({ tagOperationType: false })}
          accounts={defaultAccounts}
          linkedAccountIds={new Set()}
          onChanged={vi.fn()}
        />,
      );
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
    });

    it('is not offered while the authorization is pending, when no sync can run', () => {
      renderCard(connection({ status: 'pending' }));
      expect(
        screen.queryByRole('switch', { name: 'Tag transactions with the bank\'s operation type' }),
      ).toBeNull();
    });
  });

  describe('the success notification setting', () => {
    const select = () => screen.getByRole('combobox', { name: 'Notify after the daily sync' });

    it('offers the three modes and shows the one the server holds', () => {
      renderCard(connection({ notifySuccess: 'always' }));

      expect(select()).toHaveValue('always');
      expect(
        within(select())
          .getAllByRole('option')
          .map((option) => [option.getAttribute('value'), option.textContent]),
      ).toEqual([
        ['always', 'After every sync'],
        ['when_imported', 'Only when transactions were imported'],
        ['never', 'Never'],
      ]);
    });

    it('saves on change, sending only the setting that changed', async () => {
      mockUpdateConnection.mockResolvedValue(connection({ notifySuccess: 'never' }));
      renderCard(connection({ notifySuccess: 'when_imported' }));

      await act(async () => {
        fireEvent.change(select(), { target: { value: 'never' } });
      });

      expect(mockUpdateConnection).toHaveBeenCalledWith('c1', { notifySuccess: 'never' });
      expect(select()).toHaveValue('never');
      expect(toast.success).toHaveBeenCalledWith('Notification setting saved');
    });

    it('puts the setting back and says why when saving fails', async () => {
      mockUpdateConnection.mockRejectedValue({ response: { data: { message: 'Nope' } } });
      renderCard(connection({ notifySuccess: 'when_imported' }));

      await act(async () => {
        fireEvent.change(select(), { target: { value: 'always' } });
      });

      expect(select()).toHaveValue('when_imported');
      expect(toast.error).toHaveBeenCalledWith('Nope');
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('says it could not change the setting when the server gave no reason', async () => {
      mockUpdateConnection.mockRejectedValue({ response: { data: {} } });
      renderCard(connection({ notifySuccess: 'when_imported' }));

      await act(async () => {
        fireEvent.change(select(), { target: { value: 'never' } });
      });

      expect(select()).toHaveValue('when_imported');
      expect(toast.error).toHaveBeenCalledWith('Could not change the notification setting');
    });

    it('does not write when the same mode is chosen again', async () => {
      renderCard(connection({ notifySuccess: 'when_imported' }));
      await act(async () => {
        fireEvent.change(select(), { target: { value: 'when_imported' } });
      });
      expect(mockUpdateConnection).not.toHaveBeenCalled();
    });

    it('follows the server when a reload brings a different value', () => {
      const { rerender } = renderCard(connection({ notifySuccess: 'when_imported' }));
      rerender(
        <BankSyncConnectionCard
          connection={connection({ notifySuccess: 'never' })}
          accounts={defaultAccounts}
          linkedAccountIds={new Set()}
          onChanged={vi.fn()}
        />,
      );
      expect(select()).toHaveValue('never');
    });

    it('is not offered while the authorization is pending, when no daily sync can run', () => {
      renderCard(connection({ status: 'pending' }));
      expect(screen.queryByRole('combobox', { name: 'Notify after the daily sync' })).toBeNull();
    });

    it('gives each connection card its own control', () => {
      render(
        <>
          <BankSyncConnectionCard
            connection={connection({ id: 'c1' })}
            accounts={defaultAccounts}
            linkedAccountIds={new Set()}
            onChanged={vi.fn()}
          />
          <BankSyncConnectionCard
            connection={connection({ id: 'c2' })}
            accounts={defaultAccounts}
            linkedAccountIds={new Set()}
            onChanged={vi.fn()}
          />
        </>,
      );
      const ids = screen
        .getAllByRole('combobox', { name: 'Notify after the daily sync' })
        .map((element) => element.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('sync all and disconnect', () => {
    const linked = () =>
      connection({ accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })] });

    it('offers Sync all only when an account is linked', () => {
      renderCard(connection());

      expect(screen.queryByRole('button', { name: 'Sync all' })).toBeNull();
    });

    it('syncs every account and toasts the summed result', async () => {
      mockSyncConnection.mockResolvedValue([
        result({ imported: 2, skipped: 1 }),
        result({ bankAccountId: 'ba-2', imported: 3, skipped: 4 }),
      ]);
      const { onChanged } = renderCard(linked());

      await click('Sync all');

      expect(mockSyncConnection).toHaveBeenCalledWith('c1');
      expect(toast.success).toHaveBeenCalledWith(
        '5 transactions imported, 5 skipped as already imported, none refused',
      );
      expect(onChanged).toHaveBeenCalled();
    });

    it('names the failed account in an error toast and still summarises the accounts that synced', async () => {
      mockSyncConnection.mockResolvedValue([
        result({ imported: 2, skipped: 1 }),
        failure('ba-2', 'The bank sync provider did not answer.'),
      ]);
      const { onChanged } = renderCard(
        connection({
          accounts: [
            bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' }),
            bankAccount({ id: 'ba-2', displayName: 'Savings pot', accountId: 'a2', syncFromDate: '2026-01-01' }),
          ],
        }),
      );

      await click('Sync all');

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith(
        '2 transactions imported, 1 skipped as already imported, none refused. Could not sync: Savings pot (The bank sync provider did not answer.)',
        { duration: 10000 },
      );
      expect(onChanged).toHaveBeenCalled();
    });

    it('names a failed account by its masked number when it has no display name, and by a label when it has neither', async () => {
      mockSyncConnection.mockResolvedValue([failure('ba-1', 'Busy.'), failure('ba-2', 'Busy.')]);
      renderCard(
        connection({
          accounts: [
            bankAccount({ displayName: null, identifierMasked: '**** 1234', accountId: 'a1', syncFromDate: '2026-01-01' }),
            bankAccount({
              id: 'ba-2',
              displayName: null,
              identifierMasked: null,
              accountId: 'a2',
              syncFromDate: '2026-01-01',
            }),
          ],
        }),
      );

      await click('Sync all');

      expect(toast.error).toHaveBeenCalledWith(
        'Could not sync: **** 1234 (Busy.) and Unnamed bank account (Busy.)',
        { duration: 10000 },
      );
    });

    it('reports every account failing as an error, never as a success with zero rows', async () => {
      mockSyncConnection.mockResolvedValue([failure('ba-1')]);
      renderCard(linked());

      await click('Sync all');

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        'Could not sync: Everyday (The bank did not answer.)',
        { duration: 10000 },
      );
    });

    describe('an account that needs its preview (code needs_preview)', () => {
      const needsPreview = (bankAccountId: string): BankSyncFailure => ({
        bankAccountId,
        error: { code: 'needs_preview', message: 'Open the preview for this bank account.' },
      });
      const twoLinked = () =>
        connection({
          accounts: [
            bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' }),
            bankAccount({
              id: 'ba-2',
              displayName: 'Savings pot',
              accountId: 'a2',
              syncFromDate: '2026-01-01',
            }),
          ],
        });

      it('names what to do in the reader\'s language, not the server\'s sentence, and is not an error', async () => {
        mockSyncConnection.mockResolvedValue([needsPreview('ba-1')]);
        renderCard(linked());

        await click('Sync all');

        expect(toast).toHaveBeenCalledWith(
          'Open the preview for Everyday and confirm the first import',
          { duration: 8000 },
        );
        expect(toast.error).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
        const spoken = vi.mocked(toast).mock.calls.map((call) => String(call[0])).join(' ');
        expect(spoken).not.toContain('server');
      });

      it('lists every such account in one sentence', async () => {
        mockSyncConnection.mockResolvedValue([needsPreview('ba-1'), needsPreview('ba-2')]);
        renderCard(twoLinked());

        await click('Sync all');

        expect(toast).toHaveBeenCalledWith(
          'Open the preview for Everyday and Savings pot and confirm the first import',
          { duration: 8000 },
        );
      });

      it('is added to what the other accounts did, which keeps its success', async () => {
        mockSyncConnection.mockResolvedValue([
          result({ imported: 2, skipped: 1 }),
          needsPreview('ba-2'),
        ]);
        renderCard(twoLinked());

        await click('Sync all');

        expect(toast.success).toHaveBeenCalledWith(
          '2 transactions imported, 1 skipped as already imported, none refused. Open the preview for Savings pot and confirm the first import',
          { duration: 8000 },
        );
        expect(toast.error).not.toHaveBeenCalled();
      });

      it('is added to a real failure beside it without becoming one', async () => {
        mockSyncConnection.mockResolvedValue([failure('ba-1', 'Busy.'), needsPreview('ba-2')]);
        renderCard(twoLinked());

        await click('Sync all');

        expect(toast.error).toHaveBeenCalledWith(
          'Could not sync: Everyday (Busy.). Open the preview for Savings pot and confirm the first import',
          { duration: 10000 },
        );
      });
    });

    it('says the result is not known yet when the request timed out or the server crashed', async () => {
      for (const status of [undefined, 500, 504]) {
        vi.clearAllMocks();
        mockSyncConnection.mockRejectedValue(axiosFailure(status));
        const view = renderCard(linked());

        await click('Sync all');

        expect(toast.error).toHaveBeenCalledWith(
          'The result of the sync is not known yet. Reload the page to see what was imported.',
        );
        view.unmount();
      }
    });

    it('keeps the server message for a 4xx refusal', async () => {
      mockSyncConnection.mockRejectedValue(axiosFailure(409));
      renderCard(linked());

      await click('Sync all');

      expect(toast.error).toHaveBeenCalledWith('Server said 409');
    });

    it('reports a failed sync and still reloads what the server recorded', async () => {
      mockSyncConnection.mockRejectedValue({ response: { data: { message: 'Consent expired' } } });
      const { onChanged } = renderCard(linked());

      await click('Sync all');

      expect(toast.error).toHaveBeenCalledWith('Consent expired');
      expect(onChanged).toHaveBeenCalled();
    });

    it('confirms before disconnecting', async () => {
      mockDeleteConnection.mockResolvedValue(undefined);
      const { onChanged } = renderCard(linked());

      await click('Disconnect');
      expect(mockDeleteConnection).not.toHaveBeenCalled();
      expect(screen.getByText('Disconnect Alpha Bank')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(
          within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
        );
      });

      await waitFor(() => expect(mockDeleteConnection).toHaveBeenCalledWith('c1'));
      expect(onChanged).toHaveBeenCalled();
    });

    it('does nothing when the disconnect is cancelled', async () => {
      renderCard(linked());

      await click('Disconnect');
      await click('Cancel');

      expect(mockDeleteConnection).not.toHaveBeenCalled();
    });

    it('disables the controls in demo mode', () => {
      renderCard(linked(), { disabled: true });

      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Sync all' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
      expect(linkSelect()).toBeDisabled();
    });
  });

  describe('the Monize account picker', () => {
    it('offers Not linked first, then only accounts the server would accept', () => {
      renderCard(connection(), {
        accounts: [
          account({ id: 'ok', name: 'Open EUR' }),
          account({ id: 'closed', name: 'Closed EUR', isClosed: true }),
          account({ id: 'broker', name: 'Broker', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE' }),
          account({ id: 'usd', name: 'Dollars', currencyCode: 'USD' }),
          account({ id: 'joint', name: 'Someone elses', isJoint: true }),
          account({ id: 'taken', name: 'Taken' }),
        ],
        linked: ['taken'],
      });

      expect(optionLabels()).toEqual(['Not linked', 'Create a new account', 'Open EUR (EUR)']);
    });

    it('excludes exactly the accounts the server refuses for ownership: another owner\'s, not one the user owns and shares out', () => {
      renderCard(connection(), {
        accounts: [
          account({ id: 'mine', name: 'Mine' }),
          // The user owns it and has shared it with someone: it stays assignable.
          account({ id: 'shared-out', name: 'Shared out', isJoint: false, jointGranteeCount: 2 }),
          account({ id: 'shared-out-undefined', name: 'Shared out too', isJoint: undefined, jointGranteeCount: 1 }),
          // Another owner shared it with the user: the server answers 400 for it.
          account({ id: 'shared-in', name: 'Shared in', isJoint: true, ownerLabel: 'Alex' }),
        ],
      });

      expect(optionLabels()).toEqual([
        'Not linked',
        'Create a new account',
        'Mine (EUR)',
        'Shared out (EUR)',
        'Shared out too (EUR)',
      ]);
    });

    it('does not filter by currency when the bank account has none', () => {
      renderCard(connection({ accounts: [bankAccount({ currencyCode: null })] }), {
        accounts: [
          account({ id: 'eur', name: 'Euros' }),
          account({ id: 'usd', name: 'Dollars', currencyCode: 'USD' }),
        ],
      });

      expect(optionLabels()).toEqual([
        'Not linked',
        'Create a new account',
        'Dollars (USD)',
        'Euros (EUR)',
      ]);
    });

    it('keeps the current link selected even though it is linked', () => {
      renderCard(connection({ accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })] }), {
        linked: ['a1'],
      });

      expect(linkSelect().value).toBe('a1');
      expect(optionLabels()).toContain('Checking (EUR)');
    });

    it('says when no account can be linked', () => {
      renderCard(connection(), { accounts: [account({ id: 'usd', currencyCode: 'USD' })] });

      expect(screen.getByText(/No open Monize account of this currency/)).toBeInTheDocument();
    });

    it('asks for the start date before linking, filled with the default the server chose', async () => {
      mockUpdateAccount.mockResolvedValue(bankAccount({ accountId: 'a2' }));
      const { onChanged } = renderCard(connection());

      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: 'a2' } });
      });

      // Nothing is written until the dialog is confirmed.
      expect(mockUpdateAccount).not.toHaveBeenCalled();
      expect(mockGetLinkDefaults).toHaveBeenCalledWith('ba-1', 'a2');
      expect(await screen.findByText('Link to Savings')).toBeInTheDocument();
      expect(screen.getByLabelText('Import transactions from')).toHaveValue('2026-02-02');
      expect(screen.getByText(/never imported/)).toBeInTheDocument();

      await click('Link account');

      await waitFor(() => expect(mockUpdateAccount).toHaveBeenCalled());
      expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', {
        accountId: 'a2',
        syncFromDate: '2026-02-02',
      });
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('links without a date when the person clears the field, leaving it to the server', async () => {
      mockUpdateAccount.mockResolvedValue(bankAccount({ accountId: 'a2' }));
      renderCard(connection());

      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: 'a2' } });
      });
      fireEvent.change(await screen.findByLabelText('Import transactions from'), {
        target: { value: '' },
      });
      await click('Link account');

      await waitFor(() => expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', { accountId: 'a2' }));
      expect(mockUpdateAccount.mock.calls[0][1]).not.toHaveProperty('syncFromDate');
    });

    it('sends the start date only when the user set one', async () => {
      mockUpdateAccount.mockResolvedValue(bankAccount({ accountId: 'a2' }));
      renderCard(connection());

      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: 'a2' } });
      });
      fireEvent.change(await screen.findByLabelText('Import transactions from'), {
        target: { value: '2026-03-15' },
      });
      await click('Link account');

      await waitFor(() =>
        expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', {
          accountId: 'a2',
          syncFromDate: '2026-03-15',
        }),
      );
    });

    describe('what the dialog says about the account being linked', () => {
      const openDialog = async () => {
        await act(async () => {
          fireEvent.change(linkSelect(), { target: { value: 'a2' } });
        });
        return screen.findByLabelText('Import transactions from');
      };

      it('names the newest transaction in the account', async () => {
        renderCard(connection());
        await openDialog();
        expect(screen.getByText('Newest transaction in this account: on 2026-02-01')).toBeInTheDocument();
        expect(screen.queryByText(/The account is empty/)).not.toBeInTheDocument();
      });

      it('says the account is empty, with the number of days the server\'s default covers', async () => {
        mockGetLinkDefaults.mockResolvedValue({
          newestTransactionDate: null,
          defaultSyncFromDate: '2026-09-20',
        });
        renderCard(connection());
        await openDialog();
        // Today is 2026-09-30: ten days, from the answer, not a literal.
        expect(
          screen.getByText('The account is empty: the import covers the last 10 days'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Newest transaction/)).not.toBeInTheDocument();
      });

      it('warns about duplicates only for a date on or before the newest transaction', async () => {
        renderCard(connection());
        const input = await openDialog();
        // The default starts the day after the newest transaction: no warning.
        expect(screen.queryByText(/may create duplicates/)).not.toBeInTheDocument();

        fireEvent.change(input, { target: { value: '2026-02-01' } });
        expect(screen.getByText(/may create duplicates/)).toBeInTheDocument();

        fireEvent.change(input, { target: { value: '2026-01-01' } });
        expect(screen.getByText(/may create duplicates/)).toBeInTheDocument();

        fireEvent.change(input, { target: { value: '2026-02-02' } });
        expect(screen.queryByText(/may create duplicates/)).not.toBeInTheDocument();
      });

      it('does not warn about duplicates for an account with no transactions', async () => {
        mockGetLinkDefaults.mockResolvedValue({
          newestTransactionDate: null,
          defaultSyncFromDate: '2026-07-03',
        });
        renderCard(connection());
        const input = await openDialog();
        fireEvent.change(input, { target: { value: '2020-01-01' } });
        expect(screen.queryByText(/may create duplicates/)).not.toBeInTheDocument();
      });

      it('says so when the account could not be read, and claims neither an empty account nor a risk', async () => {
        mockGetLinkDefaults.mockRejectedValue(new Error('down'));
        mockUpdateAccount.mockResolvedValue(bankAccount({ accountId: 'a2' }));
        renderCard(connection());
        const input = await openDialog();

        expect(screen.getByText(/Could not read the newest transaction/)).toBeInTheDocument();
        expect(screen.queryByText(/The account is empty/)).not.toBeInTheDocument();
        expect(input).toHaveValue('');

        // The link can still be made; the server chooses the date.
        await click('Link account');
        await waitFor(() => expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', { accountId: 'a2' }));
      });

      it('waits for the answer before drawing the form', async () => {
        let resolve!: (value: unknown) => void;
        mockGetLinkDefaults.mockReturnValue(new Promise((r) => (resolve = r)));
        renderCard(connection());
        await act(async () => {
          fireEvent.change(linkSelect(), { target: { value: 'a2' } });
        });
        expect(screen.getByText('Reading the account...')).toBeInTheDocument();
        expect(screen.queryByLabelText('Import transactions from')).not.toBeInTheDocument();

        await act(async () => {
          resolve({ newestTransactionDate: null, defaultSyncFromDate: '2026-07-03' });
        });
        expect(await screen.findByLabelText('Import transactions from')).toHaveValue('2026-07-03');
      });

      it('reads the defaults of an existing link too, to keep its date and warn about duplicates', async () => {
        renderCard(
          connection({ accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })] }),
        );
        await click('Change start date');
        const input = await screen.findByLabelText('Import transactions from');
        expect(mockGetLinkDefaults).toHaveBeenCalledWith('ba-1', 'a1');
        // The date the link holds, not the default.
        expect(input).toHaveValue('2026-01-01');
        expect(screen.getByText(/may create duplicates/)).toBeInTheDocument();
      });
    });

    it('keeps the dialog open and shows the server message when linking fails', async () => {
      mockUpdateAccount.mockRejectedValue({
        response: { data: { message: 'Account already linked' } },
      });
      renderCard(connection());

      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: 'a2' } });
      });
      await screen.findByLabelText('Import transactions from');
      await click('Link account');

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Account already linked'));
      expect(screen.getByText('Link to Savings')).toBeInTheDocument();
    });

    it('leaves the link alone when the dialog is cancelled', async () => {
      renderCard(connection());

      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: 'a2' } });
      });
      await screen.findByLabelText('Import transactions from');
      await click('Cancel');

      expect(mockUpdateAccount).not.toHaveBeenCalled();
      expect(linkSelect().value).toBe('');
    });

    it('unlinks straight away when Not linked is chosen', async () => {
      mockUpdateAccount.mockResolvedValue(bankAccount());
      const { onChanged } = renderCard(
        connection({ accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })] }),
      );

      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: '' } });
      });

      expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', { accountId: null });
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('changes the start date of an existing link, and needs a date to do it', async () => {
      mockUpdateAccount.mockResolvedValue(bankAccount({ accountId: 'a1' }));
      renderCard(
        connection({ accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })] }),
      );

      await click('Change start date');
      const input = await screen.findByLabelText('Import transactions from');
      expect(input).toHaveValue('2026-01-01');

      fireEvent.change(input, { target: { value: '' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.change(input, { target: { value: '2026-02-01' } });
      await click('Save');

      await waitFor(() =>
        expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', {
          accountId: 'a1',
          syncFromDate: '2026-02-01',
        }),
      );
    });
  });

  describe('syncing one account', () => {
    const linked = (over: Partial<BankSyncAccount> = {}) =>
      connection({
        accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01', ...over })],
      });

    it('toasts the counts, with plurals', async () => {
      mockSyncAccount.mockResolvedValue(result({ imported: 1, skipped: 0 }));
      const { onChanged } = renderCard(linked());

      await click('Sync now');

      expect(mockSyncAccount).toHaveBeenCalledWith('ba-1');
      expect(toast.success).toHaveBeenCalledWith(
        '1 transaction imported, none skipped, none refused',
      );
      expect(onChanged).toHaveBeenCalled();
    });

    it('reports a sync that found nothing as such, not as a failure', async () => {
      mockSyncAccount.mockResolvedValue(result({ imported: 0, skipped: 12 }));
      renderCard(linked());

      await click('Sync now');

      expect(toast.success).toHaveBeenCalledWith(
        'No transactions imported, 12 skipped as already imported, none refused',
      );
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('names each refusal reason, as an error, when rows were refused', async () => {
      mockSyncAccount.mockResolvedValue(
        result({ imported: 3, refused: { currency_mismatch: 2, invalid_amount: 1, brand_new: 1 } }),
      );
      renderCard(linked());

      await click('Sync now');

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        '3 transactions imported, none skipped, 4 refused. Refused: 2 in another currency, 1 with an invalid amount, and 1 for another reason',
        { duration: 8000 },
      );
    });

    it('says the result is not known yet when the request timed out or the server crashed', async () => {
      for (const status of [undefined, 500, 503]) {
        vi.clearAllMocks();
        mockSyncAccount.mockRejectedValue(axiosFailure(status));
        const { onChanged, unmount } = renderCard(linked());

        await click('Sync now');

        expect(toast.error).toHaveBeenCalledWith(
          'The result of the sync is not known yet. Reload the page to see what was imported.',
        );
        // The row is read again: it shows whatever the server recorded.
        expect(onChanged).toHaveBeenCalled();
        unmount();
      }
    });

    it('keeps the server message for a 4xx refusal', async () => {
      mockSyncAccount.mockRejectedValue(axiosFailure(409));
      renderCard(linked());

      await click('Sync now');

      expect(toast.error).toHaveBeenCalledWith('Server said 409');
    });

    it('shows the server message when the sync is refused, and reloads the failure it recorded', async () => {
      mockSyncAccount.mockRejectedValue({
        response: { data: { message: 'A sync of this account is already running' } },
      });
      const { onChanged } = renderCard(linked());

      await click('Sync now');

      expect(toast.error).toHaveBeenCalledWith('A sync of this account is already running');
      expect(onChanged).toHaveBeenCalled();
    });

    it('does not offer a sync for an account that is not linked', () => {
      renderCard(connection());

      expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    });

    it('says a deleted row stays deleted', () => {
      renderCard(linked());

      expect(
        screen.getByRole('button', { name: /is not imported again by a later sync/ }),
      ).toBeInTheDocument();
    });
  });

  describe('what the last sync did', () => {
    it('says the account was never synced', () => {
      renderCard(connection());

      expect(screen.getByText('Not synced yet', { selector: 'span' })).toBeInTheDocument();
    });

    it('shows when, the outcome and the counts', () => {
      renderCard(
        connection({
          accounts: [
            bankAccount({
              accountId: 'a1',
              syncFromDate: '2026-01-01',
              lastSyncedAt: '2026-09-01T10:00:00.000Z',
              lastSyncStatus: 'succeeded',
              lastImportedCount: 4,
              lastSkippedCount: 10,
              lastRefusedCount: 0,
            }),
          ],
        }),
      );

      expect(screen.getByText('Last synced rel(2026-09-01T10:00:00.000Z)')).toBeInTheDocument();
      expect(screen.getByText('Succeeded')).toBeInTheDocument();
      expect(
        screen.getByText('4 transactions imported, 10 skipped as already imported, none refused'),
      ).toBeInTheDocument();
    });

    it('hides the counters of an account that was never synced, even when the server sends zeros', () => {
      renderCard(
        connection({
          accounts: [
            bankAccount({
              accountId: 'a1',
              syncFromDate: '2026-01-01',
              lastSyncedAt: null,
              lastImportedCount: 0,
              lastSkippedCount: 0,
              lastRefusedCount: 0,
            }),
          ],
        }),
      );

      expect(screen.getByText('Not synced yet', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByText(/transactions? imported/)).toBeNull();
      expect(screen.queryByText(/No transactions imported/)).toBeNull();
    });

    it('shows a failure with its message and no counts it does not hold', () => {
      renderCard(
        connection({
          accounts: [
            bankAccount({
              accountId: 'a1',
              syncFromDate: '2026-01-01',
              lastSyncedAt: '2026-09-01T10:00:00.000Z',
              lastSyncStatus: 'failed',
              lastSyncError: 'The bank did not answer',
            }),
          ],
        }),
      );

      expect(screen.getByText('Failed', { selector: 'span' })).toBeInTheDocument();
      expect(screen.getByText('The bank did not answer')).toBeInTheDocument();
      expect(screen.queryByText(/transactions imported/)).toBeNull();
    });
  });

  describe('balances', () => {
    const synced = (over: Partial<BankSyncAccount>) =>
      connection({
        accounts: [
          bankAccount({
            accountId: 'a1',
            syncFromDate: '2026-01-01',
            lastSyncedAt: '2026-09-01T10:00:00.000Z',
            lastSyncStatus: 'succeeded',
            ...over,
          }),
        ],
      });

    it('shows the bank balance, the Monize balance and their difference in one currency', () => {
      renderCard(
        synced({ bankBalance: '1234.5000', bankBalanceCurrency: 'EUR', bankBalanceDate: '2026-09-01' }),
        { accounts: [account({ id: 'a1', currentBalance: 1000 })] },
      );

      expect(screen.getByText('EUR 1234.50 as of on 2026-09-01')).toBeInTheDocument();
      expect(screen.getByText('EUR 1000.00')).toBeInTheDocument();
      expect(screen.getByText('Difference')).toBeInTheDocument();
      expect(screen.getByText('EUR 234.50')).toBeInTheDocument();
    });

    it('shows a known zero balance as a number, not as unknown', () => {
      renderCard(
        synced({ bankBalance: '0.0000', bankBalanceCurrency: 'EUR', bankBalanceDate: null }),
        { accounts: [account({ id: 'a1', currentBalance: 0 })] },
      );

      // The bank's zero, Monize's zero and their difference, all figures.
      expect(screen.getAllByText('EUR 0.00', { selector: 'dd' })).toHaveLength(3);
      expect(screen.queryByText('Not reported by the bank')).toBeNull();
    });

    it('says the bank did not report a balance, and shows no difference', () => {
      renderCard(synced({ bankBalance: null }), {
        accounts: [account({ id: 'a1', currentBalance: 1000 })],
      });

      expect(screen.getByText('Not reported by the bank')).toBeInTheDocument();
      expect(screen.getByText('EUR 1000.00')).toBeInTheDocument();
      expect(screen.queryByText('Difference')).toBeNull();
    });

    it('says not synced yet, not "not reported", before the first sync', () => {
      renderCard(
        connection({
          accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01', bankBalance: null })],
        }),
        { accounts: [account({ id: 'a1' })] },
      );

      expect(screen.queryByText('Not reported by the bank')).toBeNull();
      expect(screen.getAllByText('Not synced yet').length).toBeGreaterThan(0);
    });

    it('hides the difference, and says why, when the currencies differ', () => {
      renderCard(
        synced({ bankBalance: '500.0000', bankBalanceCurrency: 'PLN', bankBalanceDate: '2026-09-01' }),
        { accounts: [account({ id: 'a1', currentBalance: 1000, currencyCode: 'EUR' })] },
      );

      expect(screen.getByText('PLN 500.00 as of on 2026-09-01')).toBeInTheDocument();
      expect(screen.getByText('EUR 1000.00')).toBeInTheDocument();
      expect(screen.queryByText('Difference')).toBeNull();
      expect(
        screen.getByText(/bank balance is in PLN and the Monize account is in EUR/),
      ).toBeInTheDocument();
    });

    it('shows the bank balance of an account that is not linked, with no Monize figure', () => {
      renderCard(
        connection({
          accounts: [
            bankAccount({
              lastSyncedAt: '2026-09-01T10:00:00.000Z',
              bankBalance: '10.0000',
              bankBalanceCurrency: 'EUR',
            }),
          ],
        }),
      );

      expect(screen.getByText('EUR 10.00')).toBeInTheDocument();
      expect(screen.queryByText('Monize balance')).toBeNull();
      expect(screen.queryByText('Difference')).toBeNull();
    });
  });

  describe('the bank account type (BS19)', () => {
    it('shows the type as a badge beside the masked number', () => {
      renderCard(connection({ accounts: [bankAccount({ cashAccountType: 'CARD' })] }));
      const line = screen.getByText('PL12 **** 3456').parentElement as HTMLElement;
      expect(within(line).getByText('Card')).toBeInTheDocument();
    });

    it.each([
      ['CACC', 'Current account'],
      ['SVGS', 'Savings'],
      ['LOAN', 'Loan'],
      ['card', 'Card'],
      ['OTHR', 'Account type OTHR'],
    ])('names %s as %s', (code, label) => {
      renderCard(connection({ accounts: [bankAccount({ cashAccountType: code })] }));
      expect(screen.getByText(label)).toBeInTheDocument();
    });

    it('shows no type when the bank stated none', () => {
      renderCard(connection({ accounts: [bankAccount({ cashAccountType: null })] }));
      expect(screen.queryByText('Card')).not.toBeInTheDocument();
      expect(screen.queryByText(/Account type/)).not.toBeInTheDocument();
      expect(screen.getByText('PL12 **** 3456')).toBeInTheDocument();
    });

    it('uses the translated type as the label when the bank gave none, keeping the number beneath', () => {
      renderCard(
        connection({
          accounts: [bankAccount({ displayName: null, cashAccountType: 'CARD' })],
        }),
      );
      expect(screen.getAllByText('Card')).toHaveLength(2); // the label and the badge
      expect(screen.getByText('PL12 **** 3456')).toBeInTheDocument();
    });

    it('falls back to the number, then to a generic label, when there is no label and no type', () => {
      renderCard(connection({ accounts: [bankAccount({ displayName: null })] }));
      expect(screen.getByText('PL12 **** 3456')).toBeInTheDocument();
    });

    it('prefers the bank\'s own label to the type', () => {
      renderCard(connection({ accounts: [bankAccount({ displayName: 'Everyday', cashAccountType: 'CACC' })] }));
      expect(screen.getByText('Everyday')).toBeInTheDocument();
    });
  });

  describe('a card linked to the wrong kind of account (BS19)', () => {
    const cardLinkedTo = (monizeType: Account['accountType'], bankType: string | null = 'CARD') =>
      renderCard(
        connection({
          accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01', cashAccountType: bankType })],
        }),
        { accounts: [account({ id: 'a1', name: 'Checking', accountType: monizeType }), account({ id: 'a2', name: 'Savings' })] },
      );

    it('warns on the row while a card is linked to a chequing account', () => {
      cardLinkedTo('CHEQUING');
      expect(screen.getByRole('status')).toHaveTextContent(
        'The bank reports this account as a card, but the type of Checking is Chequing, not Credit Card.',
      );
    });

    it('warns while a credit card account is linked to a bank account that is not a card', () => {
      cardLinkedTo('CREDIT_CARD', 'CACC');
      expect(screen.getByRole('status')).toHaveTextContent(
        'The type of Checking is Credit Card, but the bank reports this account as: Current account.',
      );
    });

    it('says nothing when a card is linked to a credit card, or when the bank stated no type', () => {
      const { unmount } = cardLinkedTo('CREDIT_CARD');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      unmount();
      cardLinkedTo('CHEQUING', null);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('does not warn about an account that is not linked', () => {
      renderCard(connection({ accounts: [bankAccount({ cashAccountType: 'CARD' })] }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    describe('in the link dialog', () => {
      const openDialog = async (bankType: string | null, accountId = 'a2') => {
        mockUpdateAccount.mockResolvedValue(bankAccount({ accountId }));
        renderCard(connection({ accounts: [bankAccount({ cashAccountType: bankType })] }), {
          accounts: [
            account({ id: 'a2', name: 'Savings', accountType: 'CHEQUING' }),
            account({ id: 'cc', name: 'Visa', accountType: 'CREDIT_CARD' }),
          ],
        });
        await act(async () => {
          fireEvent.change(linkSelect(), { target: { value: accountId } });
        });
        await screen.findByLabelText('Import transactions from');
      };
      const linkButton = () => screen.getByRole('button', { name: 'Link account' });
      const confirmation = () => screen.getByLabelText('I understand, link these accounts anyway');

      it('shows an amber warning and keeps Link account off until the person confirms', async () => {
        await openDialog('CARD');
        expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
          'The bank reports this account as a card, but the type of Savings is Chequing',
        );
        expect(linkButton()).toBeDisabled();

        fireEvent.click(confirmation());
        expect(linkButton()).toBeEnabled();

        fireEvent.click(confirmation());
        expect(linkButton()).toBeDisabled();
      });

      it('links once confirmed', async () => {
        await openDialog('CARD');
        fireEvent.click(confirmation());
        await click('Link account');
        await waitFor(() => expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', expect.objectContaining({ accountId: 'a2' })));
      });

      it('also guards a credit card account linked to a bank account that is not a card', async () => {
        await openDialog('CACC', 'cc');
        expect(linkButton()).toBeDisabled();
        fireEvent.click(confirmation());
        expect(linkButton()).toBeEnabled();
      });

      it('asks nothing when the two agree, or when the bank stated no type', async () => {
        await openDialog('CARD', 'cc');
        expect(screen.queryByLabelText('I understand, link these accounts anyway')).not.toBeInTheDocument();
        expect(linkButton()).toBeEnabled();
      });

      it('asks nothing for a bank account of unknown type', async () => {
        await openDialog(null);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(linkButton()).toBeEnabled();
      });

      it('warns but does not block when only the start date of an existing link is changed', async () => {
        renderCard(
          connection({
            accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01', cashAccountType: 'CARD' })],
          }),
          { accounts: [account({ id: 'a1', name: 'Checking', accountType: 'CHEQUING' })] },
        );
        await click('Change start date');
        await screen.findByLabelText('Import transactions from');
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.queryByLabelText('I understand, link these accounts anyway')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      });
    });
  });

  describe('creating a new account from the bank account (BS16)', () => {
    const create = async (bank: Partial<BankSyncAccount> = {}) => {
      const view = renderCard(connection({ accounts: [bankAccount(bank)] }));
      await act(async () => {
        fireEvent.change(linkSelect(), { target: { value: '__create_new__' } });
      });
      return view;
    };

    it('opens Monize\'s own account form instead of linking anything', async () => {
      await create();
      expect(screen.getByTestId('account-form-modal')).toBeInTheDocument();
      expect(mockUpdateAccount).not.toHaveBeenCalled();
      expect(mockGetLinkDefaults).not.toHaveBeenCalled();
      expect(linkSelect().value).toBe('');
    });

    it('prefills the label, currency, number and type, and leaves the opening balance empty', async () => {
      await create({
        displayName: 'Everyday',
        accountIdentifier: 'PL61109010140000071219812874',
        cashAccountType: 'SVGS',
        currencyCode: 'EUR',
      });
      expect(accountModalProps?.initialValues).toEqual({
        name: 'Everyday',
        currencyCode: 'EUR',
        accountNumber: 'PL61109010140000071219812874',
        accountType: 'SAVINGS',
        openingBalance: null,
      });
    });

    it.each([
      ['CARD', 'CREDIT_CARD'],
      ['SVGS', 'SAVINGS'],
      ['LOAN', 'LOAN'],
      ['CACC', 'CHEQUING'],
      ['OTHR', 'CHEQUING'],
      [null, 'CHEQUING'],
    ])('maps the bank type %p to the account type %s', async (bankType, expected) => {
      await create({ cashAccountType: bankType });
      expect(accountModalProps?.initialValues).toMatchObject({ accountType: expected });
    });

    it('names an account the bank gave no label by its translated type and masked number', async () => {
      await create({ displayName: null, cashAccountType: 'CARD', identifierMasked: '**** 2743' });
      expect(accountModalProps?.initialValues).toMatchObject({ name: 'Card **** 2743' });
    });

    it('names it by the masked number alone when there is no label and no type, and invents no number or currency', async () => {
      await create({
        displayName: null,
        cashAccountType: null,
        identifierMasked: '**** 2743',
        accountIdentifier: null,
        currencyCode: null,
      });
      const values = accountModalProps?.initialValues ?? {};
      expect(values).toMatchObject({ name: '**** 2743' });
      expect(values).not.toHaveProperty('currencyCode');
      expect(values).not.toHaveProperty('accountNumber');
    });

    it('links the account the form saved, with the default start date, and reloads', async () => {
      mockUpdateAccount.mockResolvedValue(bankAccount({ accountId: 'new' }));
      const { onChanged } = await create();

      await act(async () => {
        accountModalProps?.onCreated?.(account({ id: 'new', name: 'Everyday', accountType: 'CHEQUING' }));
      });

      // No date is sent: the server defaults an empty account to 89 days back.
      expect(mockUpdateAccount).toHaveBeenCalledWith('ba-1', { accountId: 'new' });
      expect(toast.success).toHaveBeenCalledWith('Account created and linked');
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('says the account was created but not linked when the link is refused, and still reloads', async () => {
      mockUpdateAccount.mockRejectedValue({ response: { data: { message: 'Currency mismatch' } } });
      const { onChanged } = await create();

      await act(async () => {
        accountModalProps?.onCreated?.(account({ id: 'new' }));
      });

      expect(toast.error).toHaveBeenCalledWith('Currency mismatch');
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('does not link on its own when the person changed the type to one that does not look like the bank\'s', async () => {
      const { onChanged } = await create({ cashAccountType: 'CARD' });

      await act(async () => {
        accountModalProps?.onCreated?.(
          account({ id: 'new', name: 'Everyday', accountType: 'CHEQUING' }),
        );
      });

      expect(mockUpdateAccount).not.toHaveBeenCalled();
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      // The link dialog opens for the new account, with the confirmation to tick.
      expect(await screen.findByText('Link to Everyday')).toBeInTheDocument();
      expect(
        await screen.findByLabelText('I understand, link these accounts anyway'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Link account' })).toBeDisabled();
    });

    it('is offered in demo mode as disabled with the rest of the controls', () => {
      renderCard(connection(), { disabled: true });
      expect(linkSelect()).toBeDisabled();
    });
  });

  describe('match by account number (BS16)', () => {
    const matched = (linked: number, suggestions: number) => ({
      connection: connection(),
      linked: Array.from({ length: linked }, (_, i) => ({ bankAccountId: `b${i}`, accountId: `a${i}` })),
      suggestions: Array.from({ length: suggestions }, (_, i) => ({
        bankAccountId: `s${i}`,
        accountIds: ['x', 'y'],
      })),
    });

    it('is offered for an active connection with an unlinked bank account', () => {
      renderCard(connection());
      expect(screen.getByRole('button', { name: 'Match by account number' })).toBeInTheDocument();
    });

    it('is not offered when every bank account is linked, or the connection cannot be read', () => {
      const { unmount } = renderCard(
        connection({ accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01' })] }),
      );
      expect(screen.queryByRole('button', { name: 'Match by account number' })).not.toBeInTheDocument();
      unmount();
      renderCard(connection({ status: 'expired' }));
      expect(screen.queryByRole('button', { name: 'Match by account number' })).not.toBeInTheDocument();
    });

    it('asks the server, reloads, and says how many accounts were linked', async () => {
      mockMatchAccounts.mockResolvedValue(matched(1, 0));
      const { onChanged } = renderCard(connection());
      await click('Match by account number');
      expect(mockMatchAccounts).toHaveBeenCalledWith('c1');
      expect(toast.success).toHaveBeenCalledWith(
        '1 bank account was linked to the account with the same number',
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('counts several', async () => {
      mockMatchAccounts.mockResolvedValue(matched(2, 0));
      renderCard(connection());
      await click('Match by account number');
      expect(toast.success).toHaveBeenCalledWith(
        '2 bank accounts were linked to the accounts with the same numbers',
      );
    });

    it('says when an account matched more than one of the person\'s accounts and was left alone', async () => {
      mockMatchAccounts.mockResolvedValue(matched(0, 1));
      renderCard(connection());
      await click('Match by account number');
      expect(toast).toHaveBeenCalledWith(
        '1 bank account matches more than one of your accounts: choose its account yourself',
        { duration: 8000 },
      );
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('says both when some were linked and some are ambiguous', async () => {
      mockMatchAccounts.mockResolvedValue(matched(1, 2));
      renderCard(connection());
      await click('Match by account number');
      expect(toast.success).toHaveBeenCalledWith(
        '1 bank account was linked to the account with the same number. 2 bank accounts match more than one of your accounts: choose their accounts yourself',
      );
    });

    it('says when nothing matched', async () => {
      mockMatchAccounts.mockResolvedValue(matched(0, 0));
      renderCard(connection());
      await click('Match by account number');
      expect(toast).toHaveBeenCalledWith(
        'No bank account was linked: none has an account number that matches one of your accounts.',
      );
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('shows the server message when the match fails, and still reloads', async () => {
      mockMatchAccounts.mockRejectedValue({ response: { data: { message: 'The bank did not answer.' } } });
      const { onChanged } = renderCard(connection());
      await click('Match by account number');
      expect(toast.error).toHaveBeenCalledWith('The bank did not answer.');
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('is off while it runs, and in demo mode', async () => {
      let resolve!: (value: unknown) => void;
      mockMatchAccounts.mockReturnValue(new Promise((r) => (resolve = r)));
      renderCard(connection());
      await click('Match by account number');
      expect(screen.getByRole('button', { name: 'Matching...' })).toBeDisabled();
      await act(async () => {
        resolve(matched(0, 0));
      });
    });

    it('is disabled in demo mode', () => {
      renderCard(connection(), { disabled: true });
      expect(screen.getByRole('button', { name: 'Match by account number' })).toBeDisabled();
    });
  });

  describe('preview before the first import (BS18)', () => {
    const linked = (over: Partial<BankSyncAccount> = {}) =>
      connection({
        accounts: [bankAccount({ accountId: 'a1', syncFromDate: '2026-01-01', ...over })],
      });

    const preview = (over: Record<string, unknown> = {}) => ({
      bankAccountId: 'ba-1',
      currencyCode: 'EUR',
      rows: [],
      labels: { categories: {}, payees: {}, tags: {} },
      summary: { new: 0, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
      monizeBalance: '1000.0000',
      balanceAfter: '1000.0000',
      bankBalance: null,
      difference: null,
      planFingerprint: 'f'.repeat(64),
      ...over,
    });

    it('opens the preview instead of syncing when the link has had no successful sync', async () => {
      mockPreviewAccount.mockResolvedValue(preview());
      renderCard(linked({ needsPreview: true }));

      await click('Sync now');

      expect(mockSyncAccount).not.toHaveBeenCalled();
      await waitFor(() => expect(mockPreviewAccount).toHaveBeenCalledWith('ba-1'));
      expect(await screen.findByText('Preview import into Checking')).toBeInTheDocument();
    });

    it('offers no second Preview button while Sync now is the preview, and explains why', () => {
      renderCard(linked({ needsPreview: true }));
      expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
      expect(screen.getByText(/first import is confirmed from a preview/)).toBeInTheDocument();
    });

    it('syncs directly after a successful sync, and offers the preview as a second button', async () => {
      mockSyncAccount.mockResolvedValue(result({ imported: 1 }));
      mockPreviewAccount.mockResolvedValue(preview());
      renderCard(linked({ needsPreview: false }));
      expect(screen.queryByText(/first import is confirmed from a preview/)).not.toBeInTheDocument();

      await click('Sync now');
      expect(mockSyncAccount).toHaveBeenCalledWith('ba-1');
      expect(mockPreviewAccount).not.toHaveBeenCalled();

      await click('Preview');
      await waitFor(() => expect(mockPreviewAccount).toHaveBeenCalledWith('ba-1'));
      expect(await screen.findByText('Preview import into Checking')).toBeInTheDocument();
    });

    it('imports from the preview, toasts the result, closes it and reloads', async () => {
      const newRow = (externalKey: string) => ({
        outcome: 'new',
        externalKey,
        refusalReason: null,
        transactionDate: '2026-01-05',
        amount: '-5.0000',
        currencyCode: 'EUR',
        payeeText: 'Shop',
        description: null,
        referenceNumber: null,
        payeeName: 'Shop',
        categoryName: null,
        tagNames: [],
        payee: null,
        rules: [],
        operationTag: null,
      });
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [newRow('ref:a'), newRow('ref:b')],
          summary: { new: 2, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      mockSyncAccount.mockResolvedValue(result({ imported: 2 }));
      const { onChanged } = renderCard(linked({ needsPreview: true }));

      await click('Sync now');
      await click('Import 2 transactions');

      await waitFor(() =>
        expect(mockSyncAccount).toHaveBeenCalledWith('ba-1', 'f'.repeat(64), {
          importKeys: ['ref:a', 'ref:b'],
          excludeKeys: [],
        }),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('2 transactions imported'));
      await waitFor(() =>
        expect(screen.queryByText('Preview import into Checking')).not.toBeInTheDocument(),
      );
    });

    it('holds Sync all back while a linked account is waiting for its first confirmed import, and says why', () => {
      renderCard(linked({ needsPreview: true }));
      const syncAll = screen.getByRole('button', { name: 'Sync all' });
      expect(syncAll).toBeDisabled();
      const hint = screen.getByText(/Sync all waits until the first import of each newly linked account/);
      expect(syncAll).toHaveAttribute('aria-describedby', hint.id);
    });

    it('offers Sync all once every linked account has had a successful sync', async () => {
      mockSyncConnection.mockResolvedValue([result()]);
      renderCard(linked({ needsPreview: false }));
      expect(screen.queryByText(/Sync all waits until/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sync all' })).toBeEnabled();
      await click('Sync all');
      expect(mockSyncConnection).toHaveBeenCalledWith('c1');
    });

    it('is not held back by an account that is not linked', () => {
      renderCard(
        connection({
          accounts: [
            bankAccount({ id: 'ba-1', accountId: 'a1', syncFromDate: '2026-01-01', needsPreview: false }),
            bankAccount({ id: 'ba-2', accountId: null, needsPreview: false }),
          ],
        }),
      );
      expect(screen.getByRole('button', { name: 'Sync all' })).toBeEnabled();
    });

    it('reloads when the preview is closed, in case it recorded a lapsed consent', async () => {
      mockPreviewAccount.mockResolvedValue(preview());
      const { onChanged } = renderCard(linked({ needsPreview: true }));
      await click('Sync now');
      await screen.findByText('Preview import into Checking');
      // The header's X and the footer's button are both named Close.
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
      });
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(mockSyncAccount).not.toHaveBeenCalled();
    });
  });
});
