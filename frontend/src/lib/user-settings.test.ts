import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { userSettingsApi } from './user-settings';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('userSettingsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getProfile fetches /users/me', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'u-1', firstName: 'Test' } });
    const result = await userSettingsApi.getProfile();
    expect(apiClient.get).toHaveBeenCalledWith('/users/me');
    expect(result.firstName).toBe('Test');
  });

  it('updateProfile patches /users/profile', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'u-1' } });
    await userSettingsApi.updateProfile({ name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/users/profile', { name: 'Updated' });
  });

  it('getPreferences fetches /users/preferences', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { theme: 'dark' } });
    const result = await userSettingsApi.getPreferences();
    expect(apiClient.get).toHaveBeenCalledWith('/users/preferences');
    expect(result.theme).toBe('dark');
  });

  it('updatePreferences patches /users/preferences', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { theme: 'light' } });
    await userSettingsApi.updatePreferences({ theme: 'light' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/users/preferences', { theme: 'light' });
  });

  it('changePassword posts to /users/change-password', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    await userSettingsApi.changePassword({ currentPassword: 'old', newPassword: 'new' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/users/change-password', {
      currentPassword: 'old', newPassword: 'new',
    });
  });

  it('deleteAccount calls DELETE /users/account', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await userSettingsApi.deleteAccount();
    expect(apiClient.delete).toHaveBeenCalledWith('/users/account');
  });

  it('getSmtpStatus fetches /notifications/smtp-status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { configured: true } });
    const result = await userSettingsApi.getSmtpStatus();
    expect(apiClient.get).toHaveBeenCalledWith('/notifications/smtp-status');
    expect(result.configured).toBe(true);
  });

  it('sendTestEmail posts to /notifications/test-email', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'sent' } });
    const result = await userSettingsApi.sendTestEmail();
    expect(apiClient.post).toHaveBeenCalledWith('/notifications/test-email');
    expect(result.message).toBe('sent');
  });
});
