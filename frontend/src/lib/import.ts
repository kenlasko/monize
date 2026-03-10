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

export interface CsvColumnMappingConfig {
  date: number;
  amount?: number;
  debit?: number;
  credit?: number;
  payee?: number;
  category?: number;
  memo?: number;
  referenceNumber?: number;
  dateFormat: DateFormat;
  hasHeader: boolean;
  delimiter: string;
}

export interface CsvTransferRule {
  type: 'payee' | 'category';
  pattern: string;
  accountName: string;
}

export interface CsvHeadersResponse {
  headers: string[];
  sampleRows: string[][];
  rowCount: number;
}

export interface SavedColumnMapping {
  id: string;
  name: string;
  columnMappings: CsvColumnMappingConfig;
  transferRules: CsvTransferRule[];
  createdAt: string;
  updatedAt: string;
}

export interface ImportOfxRequest {
  content: string;
  accountId: string;
  categoryMappings: CategoryMapping[];
  accountMappings: AccountMapping[];
  dateFormat?: DateFormat;
}

export interface ImportCsvRequest {
  content: string;
  accountId: string;
  columnMapping: CsvColumnMappingConfig;
  transferRules?: CsvTransferRule[];
  categoryMappings: CategoryMapping[];
  accountMappings: AccountMapping[];
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

  // OFX
  parseOfx: async (content: string): Promise<ParsedQifResponse> => {
    const response = await apiClient.post('/import/ofx/parse', { content }, { timeout: 60000 });
    return response.data;
  },

  importOfx: async (data: ImportOfxRequest): Promise<ImportResult> => {
    const response = await apiClient.post('/import/ofx', data, { timeout: 300000 });
    return response.data;
  },

  // CSV
  parseCsvHeaders: async (content: string, delimiter?: string): Promise<CsvHeadersResponse> => {
    const response = await apiClient.post('/import/csv/headers', { content, delimiter }, { timeout: 60000 });
    return response.data;
  },

  parseCsv: async (content: string, columnMapping: CsvColumnMappingConfig, transferRules?: CsvTransferRule[]): Promise<ParsedQifResponse> => {
    const response = await apiClient.post('/import/csv/parse', { content, columnMapping, transferRules }, { timeout: 60000 });
    return response.data;
  },

  importCsv: async (data: ImportCsvRequest): Promise<ImportResult> => {
    const response = await apiClient.post('/import/csv', data, { timeout: 300000 });
    return response.data;
  },

  // Column Mappings
  getColumnMappings: async (): Promise<SavedColumnMapping[]> => {
    const response = await apiClient.get('/import/column-mappings');
    return response.data;
  },

  createColumnMapping: async (data: { name: string; columnMappings: CsvColumnMappingConfig; transferRules?: CsvTransferRule[] }): Promise<SavedColumnMapping> => {
    const response = await apiClient.post('/import/column-mappings', data);
    return response.data;
  },

  updateColumnMapping: async (id: string, data: { name?: string; columnMappings?: CsvColumnMappingConfig; transferRules?: CsvTransferRule[] }): Promise<SavedColumnMapping> => {
    const response = await apiClient.put(`/import/column-mappings/${id}`, data);
    return response.data;
  },

  deleteColumnMapping: async (id: string): Promise<void> => {
    await apiClient.delete(`/import/column-mappings/${id}`);
  },
};
