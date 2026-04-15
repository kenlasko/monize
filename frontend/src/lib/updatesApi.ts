import apiClient from './api';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  dismissed: boolean;
  disabled: boolean;
  error: string | null;
}

export interface DismissResult {
  dismissed: boolean;
  version: string | null;
}

export const updatesApi = {
  getStatus: async (): Promise<UpdateStatus> => {
    const response = await apiClient.get<UpdateStatus>('/updates/status');
    return response.data;
  },

  dismiss: async (): Promise<DismissResult> => {
    const response = await apiClient.post<DismissResult>('/updates/dismiss');
    return response.data;
  },
};
