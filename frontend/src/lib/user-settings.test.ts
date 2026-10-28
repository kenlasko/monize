import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { userSettingsApi } from './user-settings';
import { getCached, setCache, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('userSettingsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
  });

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

  it('clears report caches when the reporting basis changes successfully', async () => {
    setCache('budgets:summary', { totalSpent: 1200 });
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { reportingBasis: 'accrual' } });
    await userSettingsApi.updatePreferences({ reportingBasis: 'accrual' });
    expect(getCached('budgets:summary')).toBeUndefined();
    expect(apiClient.patch).toHaveBeenLastCalledWith('/users/preferences', { reportingBasis: 'accrual' });
  });

  it('changePassword posts to /users/change-password', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    await userSettingsApi.changePassword({ currentPassword: 'old', newPassword: 'new' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/users/change-password', {
      currentPassword: 'old', newPassword: 'new',
    });
  });

  it('deleteAccount posts to /users/delete-account with credentials', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    await userSettingsApi.deleteAccount({ password: 'mypass' });
    expect(apiClient.post).toHaveBeenCalledWith('/users/delete-account', { password: 'mypass' }, { timeout: 120000 });
  });

  it('deleteData posts to /users/delete-data with options', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { deleted: { transactions: 50 } } });
    const result = await userSettingsApi.deleteData({
      password: 'mypass',
      deleteAccounts: true,
      deleteCategories: false,
      deletePayees: false,
      deleteExchangeRates: false,
    });
    expect(apiClient.post).toHaveBeenCalledWith('/users/delete-data', {
      password: 'mypass',
      deleteAccounts: true,
      deleteCategories: false,
      deletePayees: false,
      deleteExchangeRates: false,
    }, { timeout: 120000 });
    expect(result.deleted.transactions).toBe(50);
  });

  it('deleteData drops cached lists so the next page load refetches', async () => {
    // Regression: deleting categories from Settings left the Categories page
    // serving its 5-minute cached list until a hard refresh.
    setCache('categories:all', [{ id: 'cat-1' }], 300_000);
    setCache('accounts:all', [{ id: 'acc-1' }], 300_000);
    vi.mocked(apiClient.post).mockResolvedValue({ data: { deleted: { categories: 12 } } });

    await userSettingsApi.deleteData({ password: 'mypass', deleteCategories: true });

    expect(getCached('categories:all')).toBeUndefined();
    expect(getCached('accounts:all')).toBeUndefined();
  });

  it('deleteData leaves the cache intact when the request fails', async () => {
    setCache('categories:all', [{ id: 'cat-1' }], 300_000);
    vi.mocked(apiClient.post).mockRejectedValue(new Error('wrong password'));

    await expect(
      userSettingsApi.deleteData({ password: 'nope' }),
    ).rejects.toThrow('wrong password');

    expect(getCached('categories:all')).toEqual([{ id: 'cat-1' }]);
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

describe('userSettingsApi.updatePreferences cache scope (INV-CACHE-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    setCache('investments:summary:all', { totalPortfolioValue: 1 });
    setCache('accounts:all:false', [{ id: 'a' }]);
    setCache('budgets:dashboard', { id: 'b' });
    vi.mocked(apiClient.patch).mockResolvedValue({ data: {} });
  });

  const expectDropped = () => {
    expect(getCached('investments:summary:all')).toBeUndefined();
    expect(getCached('accounts:all:false')).toBeUndefined();
    expect(getCached('budgets:dashboard')).toBeUndefined();
  };

  it('a reporting-currency change drops every cached figure', async () => {
    await userSettingsApi.updatePreferences({ defaultCurrency: 'CAD' });
    expectDropped();
  });

  it('a timezone change drops every cached figure', async () => {
    await userSettingsApi.updatePreferences({ timezone: 'Europe/Warsaw' });
    expectDropped();
  });

  it.each([true, false])('an accrual feature change (%s) drops every cached figure', async (enabled) => {
    await userSettingsApi.updatePreferences({ accrualEnabled: enabled });
    expectDropped();
  });

  it('a rejected accrual feature change keeps the valid cached figures', async () => {
    vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('save failed'));
    await expect(userSettingsApi.updatePreferences({ accrualEnabled: false })).rejects.toThrow('save failed');
    expect(getCached('budgets:dashboard')).toEqual({ id: 'b' });
  });

  it('an unrelated preference leaves the caches', async () => {
    await userSettingsApi.updatePreferences({ theme: 'dark' });
    expect(getCached('investments:summary:all')).toEqual({ totalPortfolioValue: 1 });
    expect(getCached('accounts:all:false')).toEqual([{ id: 'a' }]);
    expect(getCached('budgets:dashboard')).toEqual({ id: 'b' });
  });
});
