import apiClient from '@/lib/api';
import type { DashboardTriviaResponse } from '@/types/dashboard-trivia';

export const dashboardTriviaApi = {
  get: async (): Promise<DashboardTriviaResponse> =>
    (await apiClient.get<DashboardTriviaResponse>('/ai/trivia')).data,
};
