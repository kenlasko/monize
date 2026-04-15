import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the axios client so we test updatesApi in isolation without
// dragging in interceptors, cookies, or the auth store.
vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import apiClient from './api';
import { updatesApi } from './updatesApi';

describe('updatesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus calls GET /updates/status and unwraps data', async () => {
    const payload = {
      currentVersion: '1.8.40',
      latestVersion: '1.9.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/kenlasko/monize/releases/tag/v1.9.0',
      releaseName: 'Monize 1.9.0',
      publishedAt: '2026-02-01T00:00:00Z',
      checkedAt: '2026-02-02T00:00:00Z',
      dismissed: false,
      disabled: false,
      error: null,
    };
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: payload });

    const result = await updatesApi.getStatus();

    expect(apiClient.get).toHaveBeenCalledWith('/updates/status');
    expect(result).toEqual(payload);
  });

  it('dismiss calls POST /updates/dismiss and unwraps data', async () => {
    const payload = { dismissed: true, version: '1.9.0' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: payload });

    const result = await updatesApi.dismiss();

    expect(apiClient.post).toHaveBeenCalledWith('/updates/dismiss');
    expect(result).toEqual(payload);
  });

  it('getStatus propagates errors from the axios client', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('network'));

    await expect(updatesApi.getStatus()).rejects.toThrow('network');
  });

  it('dismiss propagates errors from the axios client', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('boom'));

    await expect(updatesApi.dismiss()).rejects.toThrow('boom');
  });
});
