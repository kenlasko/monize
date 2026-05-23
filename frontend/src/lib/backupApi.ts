import apiClient from './api';
import { AutoBackupSettings, UpdateAutoBackupSettingsData } from '@/types/auth';

export interface RestoreResult {
  message: string;
  restored: Record<string, number>;
}

export interface BackupEncryptionStatus {
  enabled: boolean;
  needsBackupPassword: boolean;
}

// Error code surfaced by the backend when an encrypted backup can't be
// decrypted with any password we tried. Frontend uses this to prompt the
// user for the password the backup was originally made with.
export const BACKUP_PASSWORD_REQUIRED_CODE = 'BACKUP_PASSWORD_REQUIRED';

// Encrypted Monize backups begin with the ASCII magic "MZBE" (see the backend
// backup-crypto.util envelope format). Sniffing the first four bytes lets the
// restore UI decide up front whether a password is needed, rather than
// attempting a restore and reacting to a failure.
const MZBE_MAGIC = [0x4d, 0x5a, 0x42, 0x45];

export async function isEncryptedBackupFile(file: File): Promise<boolean> {
  try {
    const header = new Uint8Array(
      await file.slice(0, MZBE_MAGIC.length).arrayBuffer(),
    );
    if (
      header.length === MZBE_MAGIC.length &&
      MZBE_MAGIC.every((byte, i) => header[i] === byte)
    ) {
      return true;
    }
  } catch {
    // Reading the header failed (unusual); fall back to the extension below.
  }
  return file.name.toLowerCase().endsWith('.mzbe');
}

async function compressGzip(data: ArrayBuffer): Promise<Blob> {
  const stream = new Blob([data]).stream().pipeThrough(
    new CompressionStream('gzip'),
  );
  return new Response(stream).blob();
}

export const backupApi = {
  exportBackup: async (encryptionPassword?: string): Promise<Blob> => {
    const headers: Record<string, string> = {};
    if (encryptionPassword) {
      headers['X-Export-Password'] = encryptionPassword;
    }
    const response = await apiClient.post('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
      headers,
    });
    return response.data;
  },

  restoreBackup: async (params: {
    file: File;
    isEncrypted: boolean;
    backupPassword?: string;
  }): Promise<RestoreResult> => {
    // Three accepted file shapes:
    //   encrypted    -> Monize encrypted envelope (.mzbe), sent as-is
    //   *.gz/*.json.gz -> already gzipped, sent as-is
    //   anything else -> assume raw JSON, gzip it client-side
    const isAlreadyCompressed =
      params.isEncrypted || params.file.name.toLowerCase().endsWith('.gz');
    const body = isAlreadyCompressed
      ? params.file
      : await compressGzip(await params.file.arrayBuffer());

    const headers: Record<string, string> = {
      'Content-Type': params.isEncrypted
        ? 'application/octet-stream'
        : 'application/gzip',
    };
    if (params.backupPassword) {
      headers['X-Backup-Password'] = params.backupPassword;
    }

    const response = await apiClient.post<RestoreResult>(
      '/backup/restore',
      body,
      { headers, timeout: 300000 },
    );
    return response.data;
  },

  getEncryptionStatus: async (): Promise<BackupEncryptionStatus> => {
    const response = await apiClient.get<BackupEncryptionStatus>(
      '/backup/encryption',
    );
    return response.data;
  },

  enableLocalEncryption: async (password: string): Promise<void> => {
    await apiClient.post('/backup/encryption/enable-local', { password });
  },

  setBackupPassword: async (backupPassword: string): Promise<void> => {
    await apiClient.post('/backup/encryption/backup-password', {
      backupPassword,
    });
  },

  disableEncryption: async (): Promise<void> => {
    await apiClient.delete('/backup/encryption');
  },

  getAutoBackupSettings: async (): Promise<AutoBackupSettings> => {
    const response = await apiClient.get<AutoBackupSettings>('/backup/auto-backup-settings');
    return response.data;
  },

  updateAutoBackupSettings: async (
    data: UpdateAutoBackupSettingsData,
  ): Promise<AutoBackupSettings> => {
    const response = await apiClient.patch<AutoBackupSettings>(
      '/backup/auto-backup-settings',
      data,
    );
    return response.data;
  },

  validateFolder: async (
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }> => {
    const response = await apiClient.post<{ valid: boolean; error?: string }>(
      '/backup/validate-folder',
      { folderPath },
    );
    return response.data;
  },

  browseFolders: async (
    path: string,
  ): Promise<{ current: string; directories: string[] }> => {
    const response = await apiClient.post<{ current: string; directories: string[] }>(
      '/backup/browse-folders',
      { folderPath: path },
    );
    return response.data;
  },

  runAutoBackup: async (): Promise<{ message: string; filename: string }> => {
    const response = await apiClient.post<{ message: string; filename: string }>(
      '/backup/run-auto-backup',
    );
    return response.data;
  },
};
