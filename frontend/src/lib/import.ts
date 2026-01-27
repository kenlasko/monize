import api from './api';

export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'YYYY-DD-MM';

export interface ParsedQifResponse {
  accountType: string;
  transactionCount: number;
  categories: string[];
  transferAccounts: string[];
  securities: string[];
  dateRange: {
    start: string;
    end: string;
  };
  detectedDateFormat: DateFormat;
  sampleDates: string[];
}

export interface CategoryMapping {
  originalName: string;
  categoryId?: string;
  createNew?: string;
  parentCategoryId?: string;
}

export interface AccountMapping {
  originalName: string;
  accountId?: string;
  createNew?: string;
  accountType?: string;
}

export interface SecurityMapping {
  originalName: string;
  securityId?: string;
  createNew?: string;
  securityName?: string;
  securityType?: string;
}

export interface ImportQifRequest {
  content: string;
  accountId: string;
  categoryMappings: CategoryMapping[];
  accountMappings: AccountMapping[];
  securityMappings?: SecurityMapping[];
  skipDuplicates?: boolean;
  dateFormat?: DateFormat;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
  categoriesCreated: number;
  accountsCreated: number;
  payeesCreated: number;
  securitiesCreated: number;
}

export const importApi = {
  parseQif: async (content: string): Promise<ParsedQifResponse> => {
    const response = await api.post('/import/qif/parse', { content });
    return response.data;
  },

  importQif: async (data: ImportQifRequest): Promise<ImportResult> => {
    const response = await api.post('/import/qif', data);
    return response.data;
  },
};
