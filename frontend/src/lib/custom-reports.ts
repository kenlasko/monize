import apiClient from './api';
import {
  CustomReport,
  CreateCustomReportData,
  UpdateCustomReportData,
  ReportResult,
  TimeframeType,
} from '@/types/custom-report';

export interface ExecuteReportParams {
  timeframeType?: TimeframeType;
  startDate?: string;
  endDate?: string;
}

export const customReportsApi = {
  // Create a new custom report
  create: async (data: CreateCustomReportData): Promise<CustomReport> => {
    const response = await apiClient.post<CustomReport>('/reports/custom', data);
    return response.data;
  },

  // Get all custom reports for the current user
  getAll: async (): Promise<CustomReport[]> => {
    const response = await apiClient.get<CustomReport[]>('/reports/custom');
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
    return response.data;
  },

  // Delete a custom report
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/reports/custom/${id}`);
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
    return response.data;
  },
};
