import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { backupApi } from './backupApi';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

// jsdom does not implement CompressionStream — provide a fake that just
// passes the input bytes through so we can verify the request body type.
class FakeCompressionStream {
  readable: ReadableStream;
  writable: WritableStream;
  constructor(_format: string) {
    const { readable, writable } = new TransformStream();
    this.readable = readable;
    this.writable = writable;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error mock global for jsdom
  globalThis.CompressionStream = FakeCompressionStream;
  // Polyfill Blob.prototype.stream for jsdom — pass the bytes through
  // unchanged via a simple ReadableStream so the gzip pipeline can complete.
  if (!Blob.prototype.stream) {
    Blob.prototype.stream = function () {
      const blob = this;
      return new ReadableStream({
        async start(controller) {
          const buf = await blob.arrayBuffer();
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
    } as any;
  }
});

describe('backupApi', () => {
  it('exportBackup posts to /backup/export with blob response type', async () => {
    const mockBlob = new Blob(['data']);
    vi.mocked(apiClient.post).mockResolvedValue({ data: mockBlob });

    const result = await backupApi.exportBackup();
    expect(apiClient.post).toHaveBeenCalledWith('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
    });
    expect(result).toBe(mockBlob);
  });

  it('restoreBackup uploads gzipped uncompressed file', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { message: 'ok', restored: { transactions: 5 } },
    });

    const file = new File(['{"data":"test"}'], 'backup.json', { type: 'application/json' });
    const result = await backupApi.restoreBackup({ file });

    expect(apiClient.post).toHaveBeenCalledWith(
      '/backup/restore',
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/gzip',
        }),
        timeout: 300000,
      }),
    );
    expect(result.message).toBe('ok');
  });

  it('restoreBackup uploads .gz file directly without re-compressing', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { message: 'ok', restored: {} },
    });

    const file = new File(['compressed'], 'backup.json.gz', { type: 'application/gzip' });
    await backupApi.restoreBackup({ file });

    const body = vi.mocked(apiClient.post).mock.calls[0][1];
    expect(body).toBe(file);
  });

  it('restoreBackup adds restore password header when provided', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'ok', restored: {} } });

    const file = new File(['data'], 'backup.json.gz');
    await backupApi.restoreBackup({ file, password: 'secret' });

    const config = vi.mocked(apiClient.post).mock.calls[0][2];
    expect(config?.headers?.['X-Restore-Password']).toBe('secret');
  });

  it('restoreBackup adds OIDC token header when provided', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { message: 'ok', restored: {} } });

    const file = new File(['data'], 'backup.json.gz');
    await backupApi.restoreBackup({ file, oidcIdToken: 'oidc-token' });

    const config = vi.mocked(apiClient.post).mock.calls[0][2];
    expect(config?.headers?.['X-Restore-OIDC-Token']).toBe('oidc-token');
  });

  it('getAutoBackupSettings fetches settings', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { enabled: true } });
    await backupApi.getAutoBackupSettings();
    expect(apiClient.get).toHaveBeenCalledWith('/backup/auto-backup-settings');
  });

  it('updateAutoBackupSettings patches settings', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { enabled: true } });
    await backupApi.updateAutoBackupSettings({ enabled: true } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/backup/auto-backup-settings', {
      enabled: true,
    });
  });

  it('validateFolder posts the folder path', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { valid: true } });
    const result = await backupApi.validateFolder('/tmp/backup');
    expect(apiClient.post).toHaveBeenCalledWith('/backup/validate-folder', {
      folderPath: '/tmp/backup',
    });
    expect(result.valid).toBe(true);
  });

  it('browseFolders posts the folder path', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { current: '/tmp', directories: ['a', 'b'] },
    });
    const result = await backupApi.browseFolders('/tmp');
    expect(apiClient.post).toHaveBeenCalledWith('/backup/browse-folders', {
      folderPath: '/tmp',
    });
    expect(result.directories).toHaveLength(2);
  });

  it('runAutoBackup posts to /backup/run-auto-backup', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { message: 'ok', filename: 'backup.gz' },
    });
    const result = await backupApi.runAutoBackup();
    expect(apiClient.post).toHaveBeenCalledWith('/backup/run-auto-backup');
    expect(result.filename).toBe('backup.gz');
  });
});
