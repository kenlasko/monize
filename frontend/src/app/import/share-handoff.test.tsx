import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@/test/render';
import ImportPage from './page';

/**
 * The Web Share Target hands files to the import wizard by navigating to
 * `/import?share=<id>`, and the wizard then drives itself from them without the
 * user touching a file input.
 *
 * That makes the wizard's reference data a PREREQUISITE rather than something
 * that merely arrives eventually: `handleFiles` matches the file's categories
 * against the user's categories, its symbol against their securities, and its
 * filename against their accounts. Run before those lists load, every match
 * fails -- and a failed category match is not neutral, it is an offer to CREATE
 * a category the user already has.
 *
 * The picker path cannot reach that state in practice (a human cannot click
 * before five parallel requests land); an automatic hand-off on mount reaches it
 * every time. So the ordering is the thing under test.
 */

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: Record<string, unknown>) => <img alt="" {...props} />,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const searchParams = { value: new URLSearchParams('share=bundle-1') };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/import',
  useSearchParams: () => searchParams.value,
}));

// The reader is mutable because the hand-off is an OWNERSHIP-bearing read: a
// bundle belongs to the first authenticated reader that observes it, so the
// wizard must take nothing while the store is still resolving who that is.
const VIEWER_ID = 'u1';
const auth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@b.c', hasPassword: true } as { id: string } | null,
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      user: auth.user,
      isAuthenticated: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: (s: unknown) => unknown) => {
    const state = { preferences: { defaultCurrency: 'USD' }, isLoaded: true, _hasHydrated: true };
    return selector ? selector(state) : state;
  },
}));

const mocks = vi.hoisted(() => ({
  getAllAccounts: vi.fn(),
  getAllCategories: vi.fn(),
  getSecurities: vi.fn(),
  getCurrencies: vi.fn(),
  getColumnMappings: vi.fn(),
  parseQif: vi.fn(),
  readSharedBundle: vi.fn(),
  discardSharedBundle: vi.fn(),
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: mocks.getAllAccounts, create: vi.fn(), createInvestmentPair: vi.fn() },
}));
vi.mock('@/lib/categories', () => ({ categoriesApi: { getAll: mocks.getAllCategories } }));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurities: mocks.getSecurities, lookupSecurity: vi.fn() },
}));
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: { getCurrencies: mocks.getCurrencies },
}));
vi.mock('@/lib/import', () => ({
  importApi: {
    parseQif: mocks.parseQif,
    importQif: vi.fn(),
    parseOfx: mocks.parseQif,
    importOfx: vi.fn(),
    parseQifMultiAccount: vi.fn(),
    importQifMultiAccount: vi.fn(),
    parseCsvHeaders: vi.fn().mockResolvedValue({ headers: [], sampleRows: [], rowCount: 0, columnDateFormats: [] }),
    parseCsv: vi.fn(),
    importCsv: vi.fn(),
    getColumnMappings: mocks.getColumnMappings,
    createColumnMapping: vi.fn(),
    updateColumnMapping: vi.fn(),
    deleteColumnMapping: vi.fn(),
  },
  autoMatchCsvColumns: () => ({}),
  autoMatchInvestmentColumns: () => ({}),
  looksLikeInvestmentCsv: () => false,
}));
vi.mock('@/lib/import-mny', () => ({
  importMnyApi: { upload: vi.fn(), start: vi.fn(), getJob: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  readSharedBundle: mocks.readSharedBundle,
  discardSharedBundle: mocks.discardSharedBundle,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('import page share hand-off ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams.value = new URLSearchParams('share=bundle-1');
    mocks.getSecurities.mockResolvedValue([]);
    mocks.getCurrencies.mockResolvedValue([]);
    auth.user = { id: VIEWER_ID };
    mocks.getColumnMappings.mockResolvedValue([]);
    mocks.discardSharedBundle.mockResolvedValue(undefined);
    mocks.parseQif.mockResolvedValue({
      transactions: [],
      categories: ['Groceries'],
      transferAccounts: [],
      securities: [],
      accountType: 'CHEQUING',
      detectedDateFormat: null,
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    mocks.readSharedBundle.mockResolvedValue({
      index: { id: 'bundle-1', createdAt: Date.now(), files: [] },
      items: [],
      files: [new File(['!Type:Bank\n'], 'statement.qif', { type: '' })],
      expired: false,
    });
  });

  it('does not parse the shared file until the wizard has its reference data', async () => {
    // The user's real categories and accounts, arriving late -- which is what
    // five parallel requests always do relative to one local cache read.
    const categories = deferred<unknown[]>();
    const accounts = deferred<unknown[]>();
    mocks.getAllCategories.mockReturnValue(categories.promise);
    mocks.getAllAccounts.mockReturnValue(accounts.promise);

    await act(async () => {
      render(<ImportPage />);
    });

    // Nothing has been taken from the stash yet, and nothing parsed: parsing
    // against an empty category list would offer to create "Groceries" as new
    // even though the user already has it.
    await waitFor(() => expect(mocks.getAllCategories).toHaveBeenCalled());
    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
    expect(mocks.parseQif).not.toHaveBeenCalled();

    await act(async () => {
      accounts.resolve([
        {
          id: 'acc-1',
          name: 'Chequing',
          accountType: 'CHEQUING',
          currencyCode: 'USD',
          isClosed: false,
        },
      ]);
      categories.resolve([{ id: 'cat-1', name: 'Groceries', parentId: null }]);
    });

    // Only once the reference data is in does the hand-off run, and it then
    // parses against the real category list.
    await waitFor(() => expect(mocks.parseQif).toHaveBeenCalledTimes(1));
    expect(mocks.readSharedBundle).toHaveBeenCalledWith('bundle-1', VIEWER_ID);
  });

  // Reference data being in is not the only prerequisite: the read claims the
  // bundle for whoever makes it, so an unnamed reader must take nothing -- and
  // the bundle stays in the stash, offered again once the account is known.
  it('takes nothing while the reader is unnamed, and keeps the bundle', async () => {
    auth.user = null;
    mocks.getAllCategories.mockResolvedValue([{ id: 'cat-1', name: 'Groceries', parentId: null }]);
    mocks.getAllAccounts.mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Chequing',
        accountType: 'CHEQUING',
        currencyCode: 'USD',
        isClosed: false,
      },
    ]);

    await act(async () => {
      render(<ImportPage />);
    });

    await waitFor(() => expect(mocks.getAllCategories).toHaveBeenCalled());
    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
    expect(mocks.parseQif).not.toHaveBeenCalled();
    expect(mocks.discardSharedBundle).not.toHaveBeenCalled();
  });

  it('takes the files exactly once, and only then discards the bundle', async () => {
    mocks.getAllCategories.mockResolvedValue([{ id: 'cat-1', name: 'Groceries', parentId: null }]);
    mocks.getAllAccounts.mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Chequing',
        accountType: 'CHEQUING',
        currencyCode: 'USD',
        isClosed: false,
      },
    ]);

    await act(async () => {
      render(<ImportPage />);
    });

    await waitFor(() => expect(mocks.parseQif).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.discardSharedBundle).toHaveBeenCalledWith('bundle-1'),
    );
    // The wizard's reference data settling must not re-run the hand-off.
    expect(mocks.parseQif).toHaveBeenCalledTimes(1);
  });

  it('ignores a share id that is not a minted bundle id', async () => {
    searchParams.value = new URLSearchParams('share=../../etc/passwd');
    mocks.getAllCategories.mockResolvedValue([]);
    mocks.getAllAccounts.mockResolvedValue([]);

    await act(async () => {
      render(<ImportPage />);
    });

    await waitFor(() => expect(mocks.getAllCategories).toHaveBeenCalled());
    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
    expect(mocks.parseQif).not.toHaveBeenCalled();
  });
});
