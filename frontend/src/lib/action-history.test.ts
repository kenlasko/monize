import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { actionHistoryApi } from './action-history';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

describe('actionHistoryApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getHistory without limit fetches /action-history with undefined params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await actionHistoryApi.getHistory();
    expect(apiClient.get).toHaveBeenCalledWith('/action-history', {
      params: undefined,
    });
  });

  it('getHistory passes limit param when provided', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await actionHistoryApi.getHistory(50);
    expect(apiClient.get).toHaveBeenCalledWith('/action-history', {
      params: { limit: 50 },
    });
  });

  it('getHistory returns the data array', async () => {
    const mockHistory = [
      {
        id: 'h-1',
        userId: 'u-1',
        entityType: 'transaction',
        entityId: 't-1',
        action: 'create',
        isUndone: false,
        description: 'Created tx',
        createdAt: '2025-01-01',
      },
    ];
    vi.mocked(apiClient.get).mockResolvedValue({ data: mockHistory });
    const result = await actionHistoryApi.getHistory();
    expect(result).toEqual(mockHistory);
  });

  it('undo posts to /action-history/undo', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { action: { id: 'h-1' }, description: 'undid create' },
    });
    const result = await actionHistoryApi.undo();
    expect(apiClient.post).toHaveBeenCalledWith('/action-history/undo');
    expect(result.description).toBe('undid create');
  });

  it('redo posts to /action-history/redo', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { action: { id: 'h-1' }, description: 'redid create' },
    });
    const result = await actionHistoryApi.redo();
    expect(apiClient.post).toHaveBeenCalledWith('/action-history/redo');
    expect(result.description).toBe('redid create');
  });
});
