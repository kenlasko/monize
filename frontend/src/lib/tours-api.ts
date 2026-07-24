import apiClient from './api';
import type { TourProgressMap, TourStatus } from './tours/types';

export type { TourProgressMap, TourStatus } from './tours/types';

/**
 * Thin client for the authenticated guided-tour progress endpoints. Progress is
 * server-managed (the `tour_progress` jsonb column on user_preferences) and read
 * once by the tour host; saves are optimistic and fire-and-forget.
 */
export const toursApi = {
  /** The user's full completion map, keyed by tour id. */
  getProgress: async (): Promise<TourProgressMap> => {
    const response = await apiClient.get<TourProgressMap>(
      '/updates/tours/progress',
    );
    return response.data;
  },

  /** Record a tour as completed or dismissed. */
  saveProgress: async (
    tourId: string,
    status: TourStatus,
  ): Promise<{ saved: boolean }> => {
    const response = await apiClient.post<{ saved: boolean }>(
      '/updates/tours/progress',
      { tourId, status },
    );
    return response.data;
  },

  /** Clear all tour progress ("Reset tour progress"). */
  resetProgress: async (): Promise<{ reset: boolean }> => {
    const response = await apiClient.delete<{ reset: boolean }>(
      '/updates/tours/progress',
    );
    return response.data;
  },
};
