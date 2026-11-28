import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@/test/render';
import { useReceiptParserLookups } from './useReceiptParserLookups';

const payeesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const categoriesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const accountsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const exchangeRatesApi = vi.hoisted(() => ({ getCurrencies: vi.fn() }));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi,
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi,
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi,
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const category = (id: string, name: string, parentId: string | null = null) => ({
  id,
  name,
  parentId,
  categoryType: 'expense' as const,
  isSystem: false,
  children: [],
});

const account = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  currencyCode: 'CAD',
  isClosed: false,
  ...over,
});

describe('useReceiptParserLookups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountsApi.getAll.mockResolvedValue([]);
    exchangeRatesApi.getCurrencies.mockResolvedValue([]);
  });

  it('loads every account A-Z, closed ones too, marking the ones a trade can be booked to, and the active currencies', async () => {
    payeesApi.getAll.mockResolvedValue([]);
    categoriesApi.getAll.mockResolvedValue([]);
    accountsApi.getAll.mockResolvedValue([
      account('a-usd', 'RRSP USD', { currencyCode: 'USD' }),
      account('a-cash', 'RRSP Cash', { accountSubType: 'INVESTMENT_CASH' }),
      account('a-chq', 'Chequing', { accountType: 'CHEQUING', accountSubType: null }),
      account('a-closed', 'Old RRSP', { isClosed: true }),
      account('a-joint', 'Joint RRSP', { isJoint: true }),
      account('a-cad', 'RRSP CAD'),
    ]);
    exchangeRatesApi.getCurrencies.mockResolvedValue([
      { code: 'CAD', isActive: true },
      { code: 'USD', isActive: true },
      { code: 'EUR', isActive: false },
    ]);
    const { result } = renderHook(() => useReceiptParserLookups());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(accountsApi.getAll).toHaveBeenCalledWith(true);
    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.lookups.accounts.map((a) => [a.label, a.currencyCode, a.tradable])).toEqual([
      ['Chequing', 'CAD', false],
      ['Joint RRSP', 'CAD', false],
      ['Old RRSP', 'CAD', false],
      ['RRSP CAD', 'CAD', true],
      ['RRSP Cash', 'CAD', false],
      ['RRSP USD', 'USD', true],
    ]);
    expect(state.lookups.currencyCodes).toEqual(['CAD', 'USD']);
  });

  it('is an error when the accounts cannot be read', async () => {
    payeesApi.getAll.mockResolvedValue([]);
    categoriesApi.getAll.mockResolvedValue([]);
    accountsApi.getAll.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useReceiptParserLookups());
    await waitFor(() => expect(result.current.state.status).toBe('error'));
  });

  it('loads payees (inactive ones too) and categories in tree order', async () => {
    payeesApi.getAll.mockResolvedValue([{ id: 'p-1', name: 'Allegro' }]);
    categoriesApi.getAll.mockResolvedValue([
      category('c-2', 'Cables', 'c-1'),
      { ...category('c-1', 'Electronics'), icon: 'cart' },
    ]);
    const { result } = renderHook(() => useReceiptParserLookups());
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(payeesApi.getAll).toHaveBeenCalledWith('all');
    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.lookups.payees.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: 'p-1', label: 'Allegro' },
    ]);
    expect(state.lookups.categories.map((c) => c.label)).toEqual(['Electronics', 'Electronics: Cables']);
    // Rows carry their mark for the parser editor's pickers; a category with no
    // icon or colour gets none, so its row leaves no blank slot.
    expect(state.lookups.payees[0].icon).toBeDefined();
    expect(state.lookups.categories.map((c) => c.icon !== undefined)).toEqual([true, false]);
  });

  it('is an error, not empty lists, when either request fails, and reloads on demand', async () => {
    payeesApi.getAll.mockRejectedValueOnce(new Error('boom'));
    categoriesApi.getAll.mockResolvedValue([]);
    const { result } = renderHook(() => useReceiptParserLookups());
    await waitFor(() => expect(result.current.state.status).toBe('error'));

    payeesApi.getAll.mockResolvedValue([]);
    act(() => result.current.reload());
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });
});
