import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { adminApi } from './admin';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('adminApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getUsers fetches /admin/users', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'u-1' }] });
    const result = await adminApi.getUsers();
    expect(apiClient.get).toHaveBeenCalledWith('/admin/users');
    expect(result).toHaveLength(1);
  });

  it('updateUserRole patches role', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'u-1', role: 'admin' } });
    const result = await adminApi.updateUserRole('u-1', 'admin');
    expect(apiClient.patch).toHaveBeenCalledWith('/admin/users/u-1/role', { role: 'admin' });
    expect(result.role).toBe('admin');
  });

  it('updateUserStatus patches status', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'u-1', isActive: false } });
    await adminApi.updateUserStatus('u-1', false);
    expect(apiClient.patch).toHaveBeenCalledWith('/admin/users/u-1/status', { isActive: false });
  });

  it('deleteUser calls DELETE /admin/users/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await adminApi.deleteUser('u-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/admin/users/u-1');
  });

  it('resetUserPassword posts to reset endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { temporaryPassword: 'abc123' } });
    const result = await adminApi.resetUserPassword('u-1');
    expect(apiClient.post).toHaveBeenCalledWith('/admin/users/u-1/reset-password');
    expect(result.temporaryPassword).toBe('abc123');
  });
});
