import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { customReportsApi } from './custom-reports';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('customReportsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create posts to /reports/custom', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'r-1' } });
    const result = await customReportsApi.create({ name: 'My Report' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/reports/custom', { name: 'My Report' });
    expect(result.id).toBe('r-1');
  });

  it('getAll fetches /reports/custom', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'r-1' }] });
    const result = await customReportsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/reports/custom');
    expect(result).toHaveLength(1);
  });

  it('getById fetches /reports/custom/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'r-1' } });
    await customReportsApi.getById('r-1');
    expect(apiClient.get).toHaveBeenCalledWith('/reports/custom/r-1');
  });

  it('update patches /reports/custom/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'r-1' } });
    await customReportsApi.update('r-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/reports/custom/r-1', { name: 'Updated' });
  });

  it('delete calls DELETE /reports/custom/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await customReportsApi.delete('r-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/reports/custom/r-1');
  });

  it('execute posts to /reports/custom/:id/execute', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { rows: [] } });
    await customReportsApi.execute('r-1', { startDate: '2025-01-01' });
    expect(apiClient.post).toHaveBeenCalledWith('/reports/custom/r-1/execute', { startDate: '2025-01-01' });
  });

  it('execute sends empty object when no params', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { rows: [] } });
    await customReportsApi.execute('r-1');
    expect(apiClient.post).toHaveBeenCalledWith('/reports/custom/r-1/execute', {});
  });

  it('toggleFavourite patches isFavourite', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'r-1', isFavourite: true } });
    const result = await customReportsApi.toggleFavourite('r-1', true);
    expect(apiClient.patch).toHaveBeenCalledWith('/reports/custom/r-1', { isFavourite: true });
    expect(result.isFavourite).toBe(true);
  });
});
