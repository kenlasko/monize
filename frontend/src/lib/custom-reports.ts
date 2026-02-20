import apiClient from './api';
import {
  CustomReport,
  CreateCustomReportData,
  UpdateCustomReportData,
  ReportResult,
  TimeframeType,
} from '@/types/custom-report';
import { getCached, setCache, invalidateCache } from './apiCache';

export interface ExecuteReportParams {
  timeframeType?: TimeframeType;
  startDate?: string;
  endDate?: string;
}

export const customReportsApi = {
  // Create a new custom report
  create: async (data: CreateCustomReportData): Promise<CustomReport> => {
    const response = await apiClient.post<CustomReport>('/reports/custom', data);
    invalidateCache('reports:');
    return response.data;
  },

  // Get all custom reports for the current user
  getAll: async (): Promise<CustomReport[]> => {
    const cached = getCached<CustomReport[]>('reports:all');
    if (cached) return cached;
    const response = await apiClient.get<CustomReport[]>('/reports/custom');
    setCache('reports:all', response.data, 300_000);
    return response.data;
  },

  // Get a specific custom report by ID
  getById: async (id: string): Promise<CustomReport> => {
    const response = await apiClient.get<CustomReport>(`/reports/custom/${id}`);
    return response.data;
  },

  // Update a custom report
  update: async (id: string, data: UpdateCustomReportData): Promise<CustomReport> => {
    const response = await apiClient.patch<CustomReport>(`/reports/custom/${id}`, data);
    invalidateCache('reports:');
    return response.data;
  },

  // Delete a custom report
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/reports/custom/${id}`);
    invalidateCache('reports:');
  },

  // Execute a custom report and get aggregated data
  execute: async (id: string, params?: ExecuteReportParams): Promise<ReportResult> => {
    const response = await apiClient.post<ReportResult>(
      `/reports/custom/${id}/execute`,
      params || {},
    );
    return response.data;
  },

  // Toggle favourite status
  toggleFavourite: async (id: string, isFavourite: boolean): Promise<CustomReport> => {
    const response = await apiClient.patch<CustomReport>(`/reports/custom/${id}`, {
      isFavourite,
    });
    invalidateCache('reports:');
    return response.data;
  },
};
