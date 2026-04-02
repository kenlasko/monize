import apiClient from './api';
import { AutoBackupSettings, UpdateAutoBackupSettingsData } from '@/types/auth';

export interface RestoreResult {
  message: string;
  restored: Record<string, number>;
}

async function compressGzip(data: ArrayBuffer): Promise<Blob> {
  const stream = new Blob([data]).stream().pipeThrough(
    new CompressionStream('gzip'),
  );
  return new Response(stream).blob();
}

export const backupApi = {
  exportBackup: async (): Promise<Blob> => {
    const response = await apiClient.post('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
    });
    return response.data;
  },

  restoreBackup: async (params: {
    file: File;
    password?: string;
    oidcIdToken?: string;
  }): Promise<RestoreResult> => {
    const isAlreadyCompressed = params.file.name.endsWith('.gz');
    const body = isAlreadyCompressed
      ? params.file
      : await compressGzip(await params.file.arrayBuffer());

    const headers: Record<string, string> = {
      'Content-Type': 'application/gzip',
    };
    if (params.password) {
      headers['X-Restore-Password'] = params.password;
    }
    if (params.oidcIdToken) {
      headers['X-Restore-OIDC-Token'] = params.oidcIdToken;
    }

    const response = await apiClient.post<RestoreResult>(
      '/backup/restore',
      body,
      { headers, timeout: 300000 },
    );
    return response.data;
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
