import apiClient from './api';

export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'YYYY-DD-MM';

/** Well-known date formats for the dropdown picker. */
export const DATE_FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
  { value: 'YYYY-DD-MM', label: 'YYYY-DD-MM' },
];

/**
 * Auto-detect the date format from an array of sample date strings.
 * Examines the values to determine which of the built-in formats best matches.
 * Returns null if no format can be confidently detected.
 */
/**
 * Strip trailing time components from a date string for format detection.
 * Handles "01/15/2026 14:30:00", "2026-01-15T12:00:00Z", "01/15/2026 2:30 PM", etc.
 */
function stripTimeForDetection(dateStr: string): string {
  const tIndex = dateStr.indexOf('T');
  if (tIndex > 0) return dateStr.substring(0, tIndex);
  const spaceMatch = dateStr.match(/^(\S+)\s+\d{1,2}:\d{2}/);
  if (spaceMatch) return spaceMatch[1];
  return dateStr;
}

export function detectCsvDateFormat(samples: string[]): string | null {
  const dates = samples.filter((s) => s && s.trim());
  if (dates.length === 0) return null;

  const first = stripTimeForDetection(dates[0].trim());

  // Check for ISO-like (YYYY prefix)
  if (first.match(/^\d{4}[-/.]/)) {
    // Disambiguate YYYY-MM-DD vs YYYY-DD-MM
    for (const date of dates) {
      const m = stripTimeForDetection(date.trim()).match(/^\d{4}[-/.](\d{1,2})[-/.](\d{1,2})$/);
      if (m) {
        const p2 = parseInt(m[1]);
        const p3 = parseInt(m[2]);
        if (p2 > 12) return 'YYYY-DD-MM';
        if (p3 > 12) return 'YYYY-MM-DD';
      }
    }
    return 'YYYY-MM-DD';
  }

  // Check for numeric date with separators (- / .)
  const numericMatch = first.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (numericMatch) {
    // Disambiguate MM/DD/YYYY vs DD/MM/YYYY
    for (const date of dates) {
      const m = stripTimeForDetection(date.trim()).match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
      if (m) {
        const p1 = parseInt(m[1]);
        const p2 = parseInt(m[2]);
        if (p1 > 12) return 'DD/MM/YYYY';
        if (p2 > 12) return 'MM/DD/YYYY';
      }
    }
    // Ambiguous (both parts <= 12) -- default to MM/DD/YYYY
    return 'MM/DD/YYYY';
  }

  // No recognizable date pattern
  return null;
}

export interface ParsedQifResponse {
  accountType: string;
  accountName?: string;
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
  createNewParentCategoryName?: string;
  // Loan category fields
  isLoanCategory?: boolean;
  loanAccountId?: string;
  createNewLoan?: string;
  newLoanType?: 'LOAN' | 'MORTGAGE';
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
  subcategory?: number;
  memo?: number;
  referenceNumber?: number;
  dateFormat: string;
  reverseSign?: boolean;
  hasHeader: boolean;
  delimiter: string;
  amountTypeColumn?: number;
  incomeValues?: string[];
  expenseValues?: string[];
  transferOutValues?: string[];
  transferInValues?: string[];
  transferAccountColumn?: number;
}

/**
 * Auto-detect column mappings from CSV header names.
 * Returns a partial CsvColumnMappingConfig with matched columns.
 */
export function autoMatchCsvColumns(headers: string[]): Partial<CsvColumnMappingConfig> {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const result: Partial<CsvColumnMappingConfig> = {};

  const patterns: Record<string, string[]> = {
    date: ['date', 'transaction date', 'trans date', 'posting date', 'trade date', 'settlement date', 'value date'],
    amount: ['amount', 'sum', 'total', 'value', 'transaction amount'],
    debit: ['debit', 'withdrawal', 'debit amount', 'withdrawals'],
    credit: ['credit', 'deposit', 'credit amount', 'deposits'],
    payee: ['payee', 'description', 'merchant', 'name', 'vendor', 'beneficiary', 'transaction description'],
    category: ['category', 'type', 'class', 'transaction type'],
    subcategory: ['subcategory', 'sub-category', 'sub category'],
    memo: ['memo', 'note', 'notes', 'comment', 'comments', 'remarks', 'details', 'additional info'],
    referenceNumber: ['reference', 'ref', 'check', 'check number', 'check no', 'reference number', 'ref no', 'transaction id', 'confirmation', 'receipt'],
  };

  const used = new Set<number>();

  for (const [field, keywords] of Object.entries(patterns)) {
    // Try exact match first, then substring match
    let matchIndex = normalized.findIndex((h, i) => !used.has(i) && keywords.includes(h));
    if (matchIndex === -1) {
      matchIndex = normalized.findIndex((h, i) => !used.has(i) && keywords.some((k) => h.includes(k)));
    }
    if (matchIndex !== -1) {
      used.add(matchIndex);
      (result as Record<string, number>)[field] = matchIndex;
    }
  }

  // If amount matched, prefer it over debit/credit
  if (result.amount !== undefined) {
    delete result.debit;
    delete result.credit;
  } else if (result.debit !== undefined && result.credit !== undefined) {
    // Both debit and credit matched without amount -- keep split mode
    delete result.amount;
  }

  return result;
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
  loanAccountsNeedingSetup?: Array<{
    accountId: string;
    accountName: string;
    accountType: string;
  }>;
}

export interface ParsedQifMultiAccountResponse {
  isMultiAccount: boolean;
  categoryDefs: Array<{
    name: string;
    description: string;
    isIncome: boolean;
  }>;
  tagDefs: Array<{
    name: string;
    description: string;
  }>;
  accounts: Array<{
    accountName: string;
    accountType: string;
    transactionCount: number;
    dateRange: { start: string; end: string };
  }>;
  totalTransactionCount: number;
  securities: string[];
  detectedDateFormat: DateFormat;
  sampleDates: string[];
}

export interface ImportQifMultiAccountRequest {
  content: string;
  currencyCode: string;
  dateFormat?: DateFormat;
  securityMappings?: SecurityMapping[];
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

  // Multi-account QIF
  parseQifMultiAccount: async (content: string): Promise<ParsedQifMultiAccountResponse> => {
    const response = await apiClient.post('/import/qif/multi-account/parse', { content }, { timeout: 60000 });
    return response.data;
  },

  importQifMultiAccount: async (data: ImportQifMultiAccountRequest): Promise<ImportResult> => {
    const response = await apiClient.post('/import/qif/multi-account', data, { timeout: 300000 });
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
