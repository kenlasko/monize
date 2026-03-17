import apiClient from './api';

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
};
