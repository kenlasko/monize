import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { institutionsApi, institutionLogoUrl } from './institutions';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('./apiCache', () => ({
  dedupe: (_key: string, fn: () => unknown) => fn(),
  invalidateCache: vi.fn(),
}));

describe('institutionsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('institutionLogoUrl builds the same-origin logo path', () => {
    expect(institutionLogoUrl('abc')).toBe('/api/v1/institutions/abc/logo');
  });

  it('getAll fetches /institutions', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'i-1' }] });
    const result = await institutionsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/institutions');
    expect(result).toHaveLength(1);
  });

  it('getById fetches /institutions/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'i-1' } });
    await institutionsApi.getById('i-1');
    expect(apiClient.get).toHaveBeenCalledWith('/institutions/i-1');
  });

  it('create posts to /institutions', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'i-1' } });
    await institutionsApi.create({ name: 'TD', website: 'td.com' });
    expect(apiClient.post).toHaveBeenCalledWith('/institutions', {
      name: 'TD',
      website: 'td.com',
    });
  });

  it('update patches /institutions/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'i-1' } });
    await institutionsApi.update('i-1', { name: 'New' });
    expect(apiClient.patch).toHaveBeenCalledWith('/institutions/i-1', {
      name: 'New',
    });
  });

  it('delete removes /institutions/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: {} });
    await institutionsApi.delete('i-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/institutions/i-1');
  });

  it('refreshLogo posts to /institutions/:id/refresh-logo', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'i-1' } });
    await institutionsApi.refreshLogo('i-1');
    expect(apiClient.post).toHaveBeenCalledWith('/institutions/i-1/refresh-logo');
  });

  it('getAccounts fetches /institutions/:id/accounts', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await institutionsApi.getAccounts('i-1');
    expect(apiClient.get).toHaveBeenCalledWith('/institutions/i-1/accounts');
  });

  it('assignAccount posts the account id', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'a-1' } });
    await institutionsApi.assignAccount('i-1', 'a-1');
    expect(apiClient.post).toHaveBeenCalledWith('/institutions/i-1/accounts', {
      accountId: 'a-1',
    });
  });

  it('unassignAccount deletes the account link', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: { id: 'a-1' } });
    await institutionsApi.unassignAccount('i-1', 'a-1');
    expect(apiClient.delete).toHaveBeenCalledWith(
      '/institutions/i-1/accounts/a-1',
    );
  });
});
