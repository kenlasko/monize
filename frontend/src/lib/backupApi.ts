import apiClient from './api';

export interface RestoreResult {
  message: string;
  restored: Record<string, number>;
}

export const backupApi = {
  exportBackup: async (): Promise<Blob> => {
    const response = await apiClient.post('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
    });
    return response.data;
  },

  restoreBackup: async (data: {
    password?: string;
    oidcIdToken?: string;
    data: Record<string, unknown>;
  }): Promise<RestoreResult> => {
    const response = await apiClient.post<RestoreResult>('/backup/restore', data, {
      timeout: 120000,
    });
    return response.data;
  },
};
