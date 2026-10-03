import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@/test/render';
import { useReceiptParserLookups } from './useReceiptParserLookups';

const payeesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const categoriesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
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
  isIncome: false,
  isSystem: false,
  children: [],
});

describe('useReceiptParserLookups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads payees (inactive ones too) and categories in tree order', async () => {
    payeesApi.getAll.mockResolvedValue([{ id: 'p-1', name: 'Allegro' }]);
    categoriesApi.getAll.mockResolvedValue([category('c-2', 'Cables', 'c-1'), category('c-1', 'Electronics')]);
    const { result } = renderHook(() => useReceiptParserLookups());
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(payeesApi.getAll).toHaveBeenCalledWith('all');
    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.lookups.payees).toEqual([{ value: 'p-1', label: 'Allegro' }]);
    expect(state.lookups.categories.map((c) => c.label)).toEqual(['Electronics', 'Electronics: Cables']);
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
