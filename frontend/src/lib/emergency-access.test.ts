import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import apiClient from './api';
import { emergencyAccessApi } from './emergency-access';

type MockClient = Record<string, ReturnType<typeof vi.fn>>;
const client = apiClient as unknown as MockClient;

describe('emergencyAccessApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('get() GETs /emergency-access and returns the body', async () => {
    client.get.mockResolvedValue({ data: { enabled: true } });
    const result = await emergencyAccessApi.get();
    expect(client.get).toHaveBeenCalledWith('/emergency-access');
    expect(result).toEqual({ enabled: true });
  });

  it('updateSettings() PUTs the payload to /emergency-access/settings', async () => {
    client.put.mockResolvedValue({ data: { enabled: false } });
    const payload = {
      enabled: false,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      message: null,
    };
    const result = await emergencyAccessApi.updateSettings(payload);
    expect(client.put).toHaveBeenCalledWith(
      '/emergency-access/settings',
      payload,
    );
    expect(result).toEqual({ enabled: false });
  });

  it('addContact() POSTs to /emergency-access/contacts', async () => {
    client.post.mockResolvedValue({
      data: { id: 'c1', firstName: 'Carol', email: 'c@x.com' },
    });
    const payload = { firstName: 'Carol', email: 'c@x.com' };
    await emergencyAccessApi.addContact(payload);
    expect(client.post).toHaveBeenCalledWith(
      '/emergency-access/contacts',
      payload,
    );
  });

  it('updateContact() PATCHes /emergency-access/contacts/:id', async () => {
    client.patch.mockResolvedValue({ data: { id: 'c1' } });
    await emergencyAccessApi.updateContact('c1', {
      firstName: 'Carol',
      email: 'c@x.com',
    });
    expect(client.patch).toHaveBeenCalledWith(
      '/emergency-access/contacts/c1',
      { firstName: 'Carol', email: 'c@x.com' },
    );
  });

  it('removeContact() DELETEs /emergency-access/contacts/:id', async () => {
    client.delete.mockResolvedValue({ data: { ok: true } });
    await emergencyAccessApi.removeContact('c1');
    expect(client.delete).toHaveBeenCalledWith(
      '/emergency-access/contacts/c1',
    );
  });

  it('reset() POSTs /emergency-access/reset', async () => {
    client.post.mockResolvedValue({ data: { enabled: true } });
    const result = await emergencyAccessApi.reset();
    expect(client.post).toHaveBeenCalledWith('/emergency-access/reset');
    expect(result).toEqual({ enabled: true });
  });

  it('previewClaim() POSTs /emergency-access/claim/preview with the token', async () => {
    client.post.mockResolvedValue({
      data: { contactFirstName: 'Carol', message: null },
    });
    const result = await emergencyAccessApi.previewClaim('abc');
    expect(client.post).toHaveBeenCalledWith(
      '/emergency-access/claim/preview',
      { token: 'abc' },
    );
    expect(result).toEqual({ contactFirstName: 'Carol', message: null });
  });

  it('completeClaim() POSTs /emergency-access/claim/complete with token + password', async () => {
    client.post.mockResolvedValue({ data: { ok: true } });
    await emergencyAccessApi.completeClaim('abc', 'CorrectHorse99!');
    expect(client.post).toHaveBeenCalledWith(
      '/emergency-access/claim/complete',
      { token: 'abc', newPassword: 'CorrectHorse99!' },
    );
  });
});
