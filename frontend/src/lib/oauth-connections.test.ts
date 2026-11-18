import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [{ id: 'g' }] }),
    delete: vi.fn().mockResolvedValue({ data: undefined }),
  },
}));

import apiClient from '@/lib/api';
import { oauthConnectionsApi } from './oauth-connections';

describe('oauthConnectionsApi', () => {
  it('lists and revokes through /oauth-connections', async () => {
    await expect(oauthConnectionsApi.list()).resolves.toEqual([{ id: 'g' }]);
    expect(apiClient.get).toHaveBeenCalledWith('/oauth-connections');

    await oauthConnectionsApi.revoke('a/b');
    expect(apiClient.delete).toHaveBeenCalledWith('/oauth-connections/a%2Fb');
  });
});
