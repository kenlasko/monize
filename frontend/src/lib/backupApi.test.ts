import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { backupApi, isEncryptedBackupFile } from './backupApi';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
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
  (globalThis as any).CompressionStream = FakeCompressionStream;
  // Polyfill Blob.prototype.stream for jsdom — pass the bytes through
  // unchanged via a simple ReadableStream so the gzip pipeline can complete.
  if (!Blob.prototype.stream) {
    Blob.prototype.stream = function (this: Blob) {
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
      headers: {},
    });
    expect(result).toBe(mockBlob);
  });

  it('exportBackup forwards encryption password as a header', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: new Blob() });
    await backupApi.exportBackup('my-pw');
    expect(apiClient.post).toHaveBeenCalledWith('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
      headers: { 'X-Export-Password': 'my-pw' },
    });
  });

  it('restoreBackup uploads gzipped uncompressed file', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { message: 'ok', restored: { transactions: 5 } },
    });

    const file = new File(['{"data":"test"}'], 'backup.json', { type: 'application/json' });
    const result = await backupApi.restoreBackup({ file, isEncrypted: false });

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
    await backupApi.restoreBackup({ file, isEncrypted: false });

    const body = vi.mocked(apiClient.post).mock.calls[0][1];
    expect(body).toBe(file);
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

  it('restoreBackup sends an encrypted file untouched with the encrypted content-type', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { message: 'ok', restored: {} },
    });
    const file = new File([new Uint8Array([0x4d, 0x5a, 0x42, 0x45])], 'backup.mzbe');
    await backupApi.restoreBackup({ file, isEncrypted: true, backupPassword: 'bk' });
    const call = vi.mocked(apiClient.post).mock.calls[0];
    expect(call[1]).toBe(file);
    expect((call[2] as any).headers['Content-Type']).toBe('application/octet-stream');
    expect((call[2] as any).headers['X-Backup-Password']).toBe('bk');
  });

  it('getEncryptionStatus calls GET /backup/encryption', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { enabled: true, needsBackupPassword: false },
    });
    const result = await backupApi.getEncryptionStatus();
    expect(apiClient.get).toHaveBeenCalledWith('/backup/encryption');
    expect(result).toEqual({ enabled: true, needsBackupPassword: false });
  });

  it('enableLocalEncryption posts the password', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { enabled: true } });
    await backupApi.enableLocalEncryption('my-pw');
    expect(apiClient.post).toHaveBeenCalledWith(
      '/backup/encryption/enable-local',
      { password: 'my-pw' },
    );
  });

  it('setBackupPassword posts the new password', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { enabled: true } });
    await backupApi.setBackupPassword('a-strong-password');
    expect(apiClient.post).toHaveBeenCalledWith(
      '/backup/encryption/backup-password',
      { backupPassword: 'a-strong-password' },
    );
  });

  it('disableEncryption issues DELETE /backup/encryption', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: { enabled: false } });
    await backupApi.disableEncryption();
    expect(apiClient.delete).toHaveBeenCalledWith('/backup/encryption');
  });
});

describe('isEncryptedBackupFile', () => {
  it('detects the MZBE magic header regardless of file name', async () => {
    const file = new File(
      [new Uint8Array([0x4d, 0x5a, 0x42, 0x45, 0x01, 0x01])],
      'renamed-backup.bin',
    );
    expect(await isEncryptedBackupFile(file)).toBe(true);
  });

  it('returns false for an unencrypted JSON backup', async () => {
    const file = new File(['{"version":1}'], 'backup.json');
    expect(await isEncryptedBackupFile(file)).toBe(false);
  });

  it('falls back to the .mzbe extension when the header is absent', async () => {
    const file = new File(['not-really-encrypted'], 'backup.mzbe');
    expect(await isEncryptedBackupFile(file)).toBe(true);
  });
});
