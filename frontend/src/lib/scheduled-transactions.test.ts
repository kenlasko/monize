import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { scheduledTransactionsApi } from './scheduled-transactions';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('scheduledTransactionsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create posts to /scheduled-transactions', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'st-1' } });
    const result = await scheduledTransactionsApi.create({ name: 'Rent' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/scheduled-transactions', { name: 'Rent' });
    expect(result.id).toBe('st-1');
  });

  it('getAll fetches /scheduled-transactions', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'st-1' }] });
    const result = await scheduledTransactionsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions');
    expect(result).toHaveLength(1);
  });

  it('getDue fetches /scheduled-transactions/due', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await scheduledTransactionsApi.getDue();
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/due');
  });

  it('getUpcoming fetches with days param', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await scheduledTransactionsApi.getUpcoming(14);
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/upcoming', {
      params: { days: 14 },
    });
  });

  it('getUpcoming without days passes undefined', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await scheduledTransactionsApi.getUpcoming();
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/upcoming', {
      params: undefined,
    });
  });

  it('getById fetches /scheduled-transactions/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'st-1' } });
    await scheduledTransactionsApi.getById('st-1');
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/st-1');
  });

  it('update patches /scheduled-transactions/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'st-1' } });
    await scheduledTransactionsApi.update('st-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/scheduled-transactions/st-1', { name: 'Updated' });
  });

  it('delete calls DELETE /scheduled-transactions/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await scheduledTransactionsApi.delete('st-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/scheduled-transactions/st-1');
  });

  it('post posts to /scheduled-transactions/:id/post', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'st-1' } });
    await scheduledTransactionsApi.post('st-1', { date: '2025-01-15' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/scheduled-transactions/st-1/post', { date: '2025-01-15' });
  });

  it('post sends empty object when no data', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'st-1' } });
    await scheduledTransactionsApi.post('st-1');
    expect(apiClient.post).toHaveBeenCalledWith('/scheduled-transactions/st-1/post', {});
  });

  it('skip posts to /scheduled-transactions/:id/skip', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'st-1' } });
    await scheduledTransactionsApi.skip('st-1');
    expect(apiClient.post).toHaveBeenCalledWith('/scheduled-transactions/st-1/skip');
  });

  it('getOverrides fetches overrides list', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'o-1' }] });
    const result = await scheduledTransactionsApi.getOverrides('st-1');
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides');
    expect(result).toHaveLength(1);
  });

  it('hasOverrides checks override status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { hasOverrides: true, count: 2 } });
    const result = await scheduledTransactionsApi.hasOverrides('st-1');
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides/check');
    expect(result.hasOverrides).toBe(true);
  });

  it('getOverrideByDate fetches override for specific date', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'o-1' } });
    await scheduledTransactionsApi.getOverrideByDate('st-1', '2025-02-01');
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides/date/2025-02-01');
  });

  it('createOverride posts override data', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'o-1' } });
    await scheduledTransactionsApi.createOverride('st-1', { amount: 500 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides', { amount: 500 });
  });

  it('getOverride fetches specific override', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'o-1' } });
    await scheduledTransactionsApi.getOverride('st-1', 'o-1');
    expect(apiClient.get).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides/o-1');
  });

  it('updateOverride patches override', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'o-1' } });
    await scheduledTransactionsApi.updateOverride('st-1', 'o-1', { amount: 600 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides/o-1', { amount: 600 });
  });

  it('deleteOverride deletes specific override', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await scheduledTransactionsApi.deleteOverride('st-1', 'o-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides/o-1');
  });

  it('deleteAllOverrides deletes all overrides', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: 3 });
    const result = await scheduledTransactionsApi.deleteAllOverrides('st-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/scheduled-transactions/st-1/overrides');
    expect(result).toBe(3);
  });
});
