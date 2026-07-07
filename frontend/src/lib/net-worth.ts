import apiClient from './api';
import {
  MonthlyNetWorth,
  MonthlyInvestmentValue,
  DailyInvestmentValue,
  InvestmentBreakdown,
  InvestmentBreakdownGranularity,
} from '@/types/net-worth';

export const netWorthApi = {
  getMonthly: async (params?: {
    startDate?: string;
    endDate?: string;
  }): Promise<MonthlyNetWorth[]> => {
    const response = await apiClient.get<MonthlyNetWorth[]>(
      '/net-worth/monthly',
      { params },
    );
    return response.data;
  },

  getInvestmentsMonthly: async (params?: {
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<MonthlyInvestmentValue[]> => {
    const response = await apiClient.get<MonthlyInvestmentValue[]>(
      '/net-worth/investments-monthly',
      { params },
    );
    return response.data;
  },

  getInvestmentsDaily: async (params?: {
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<DailyInvestmentValue[]> => {
    const response = await apiClient.get<DailyInvestmentValue[]>(
      '/net-worth/investments-daily',
      { params },
    );
    return response.data;
  },

  getInvestmentsBreakdown: async (params: {
    granularity: InvestmentBreakdownGranularity;
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<InvestmentBreakdown> => {
    const response = await apiClient.get<InvestmentBreakdown>(
      '/net-worth/investments-breakdown',
      { params },
    );
    return response.data;
  },

  recalculate: async (): Promise<{ success: boolean }> => {
    const response = await apiClient.post<{ success: boolean }>(
      '/net-worth/recalculate',
    );
    return response.data;
  },
};
