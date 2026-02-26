import apiClient from './api';

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
  // Loan category fields
  isLoanCategory?: boolean;
  loanAccountId?: string;
  createNewLoan?: string;
  newLoanAmount?: number;
  newLoanInstitution?: string;
}

export interface AccountMapping {
  originalName: string;
  accountId?: string;
  createNew?: string;
  accountType?: string;
  currencyCode?: string;
}

export interface SecurityMapping {
  originalName: string;
  securityId?: string;
  createNew?: string;
  securityName?: string;
  securityType?: string;
  exchange?: string;
  currencyCode?: string;
}

export interface ImportQifRequest {
  content: string;
  accountId: string;
  categoryMappings: CategoryMapping[];
  accountMappings: AccountMapping[];
  securityMappings?: SecurityMapping[];
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
  createdMappings?: {
    categories: Record<string, string>;
    accounts: Record<string, string>;
    loans: Record<string, string>;
    securities: Record<string, string>;
  };
}

export const importApi = {
  parseQif: async (content: string): Promise<ParsedQifResponse> => {
    // Longer timeout for parsing large files (1 minute)
    const response = await apiClient.post('/import/qif/parse', { content }, { timeout: 60000 });
    return response.data;
  },

  importQif: async (data: ImportQifRequest): Promise<ImportResult> => {
    // Longer timeout for large imports (5 minutes)
    const response = await apiClient.post('/import/qif', data, { timeout: 300000 });
    return response.data;
  },
};
