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
    password?: string;
    oidcIdToken?: string;
    backupPassword?: string;
  }): Promise<RestoreResult> => {
    // Three accepted file shapes:
    //   *.mzbe       -> Monize encrypted envelope, sent as-is
    //   *.gz/*.json.gz -> already gzipped, sent as-is
    //   anything else -> assume raw JSON, gzip it client-side
    const ext = params.file.name.toLowerCase();
    const isEncrypted = ext.endsWith('.mzbe');
    const isAlreadyCompressed = isEncrypted || ext.endsWith('.gz');
    const body = isAlreadyCompressed
      ? params.file
      : await compressGzip(await params.file.arrayBuffer());

    const headers: Record<string, string> = {
      'Content-Type': isEncrypted ? 'application/octet-stream' : 'application/gzip',
    };
    if (params.password) {
      headers['X-Restore-Password'] = params.password;
    }
    if (params.oidcIdToken) {
      headers['X-Restore-OIDC-Token'] = params.oidcIdToken;
    }
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
