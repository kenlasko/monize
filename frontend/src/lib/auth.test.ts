import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { authApi } from './auth';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

describe('authApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('login posts credentials', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { tempToken: 'abc' } });
    const result = await authApi.login({ email: 'a@b.com', password: '123' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/auth/login', { email: 'a@b.com', password: '123' });
    expect(result.tempToken).toBe('abc');
  });

  it('register posts data', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { token: 'abc' } });
    await authApi.register({ email: 'a@b.com', password: '123', name: 'Test' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ email: 'a@b.com' }));
  });

  it('logout posts to /auth/logout', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    await authApi.logout();
    expect(apiClient.post).toHaveBeenCalledWith('/auth/logout');
  });

  it('getProfile fetches /auth/profile', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'u-1' } });
    const result = await authApi.getProfile();
    expect(apiClient.get).toHaveBeenCalledWith('/auth/profile');
    expect(result.id).toBe('u-1');
  });

  it('getAuthMethods fetches /auth/methods', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { local: true, oidc: false } });
    const result = await authApi.getAuthMethods();
    expect(result.local).toBe(true);
  });

  it('initiateOidc is a function', () => {
    expect(typeof authApi.initiateOidc).toBe('function');
  });

  it('forgotPassword posts email', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'sent' } });
    const result = await authApi.forgotPassword('a@b.com');
    expect(apiClient.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'a@b.com' });
    expect(result.message).toBe('sent');
  });

  it('resetPassword posts token and password', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'ok' } });
    await authApi.resetPassword('tok', 'newpass');
    expect(apiClient.post).toHaveBeenCalledWith('/auth/reset-password', { token: 'tok', newPassword: 'newpass' });
  });

  it('verify2FA posts tempToken, code, and rememberDevice', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { token: 'abc' } });
    await authApi.verify2FA('temp', '123456', true);
    expect(apiClient.post).toHaveBeenCalledWith('/auth/2fa/verify', {
      tempToken: 'temp', code: '123456', rememberDevice: true,
    });
  });

  it('setup2FA posts to /auth/2fa/setup', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { qrCodeDataUrl: 'data:image' } });
    const result = await authApi.setup2FA();
    expect(apiClient.post).toHaveBeenCalledWith('/auth/2fa/setup');
    expect(result.qrCodeDataUrl).toBeDefined();
  });

  it('confirmSetup2FA posts code', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'ok' } });
    await authApi.confirmSetup2FA('123456');
    expect(apiClient.post).toHaveBeenCalledWith('/auth/2fa/confirm-setup', { code: '123456' });
  });

  it('disable2FA posts code', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'ok' } });
    await authApi.disable2FA('123456');
    expect(apiClient.post).toHaveBeenCalledWith('/auth/2fa/disable', { code: '123456' });
  });

  it('getTrustedDevices fetches devices list', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'd-1' }] });
    const result = await authApi.getTrustedDevices();
    expect(apiClient.get).toHaveBeenCalledWith('/auth/2fa/trusted-devices');
    expect(result).toHaveLength(1);
  });

  it('revokeTrustedDevice deletes /auth/2fa/trusted-devices/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: { message: 'ok' } });
    await authApi.revokeTrustedDevice('d-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/auth/2fa/trusted-devices/d-1');
  });

  it('revokeAllTrustedDevices deletes all devices', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: { message: 'ok', count: 3 } });
    const result = await authApi.revokeAllTrustedDevices();
    expect(apiClient.delete).toHaveBeenCalledWith('/auth/2fa/trusted-devices');
    expect(result.count).toBe(3);
  });
});
