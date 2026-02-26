import { ParsedQifResponse } from '@/lib/import';
export { formatAccountType, isInvestmentBrokerageAccount } from '@/lib/account-utils';

export type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';
export type MatchConfidence = 'exact' | 'partial' | 'type' | 'none';

export interface ImportFileData {
  fileName: string;
  fileContent: string;
  parsedData: ParsedQifResponse;
  selectedAccountId: string;
  matchConfidence: MatchConfidence;
}

export interface BulkImportResult {
  totalImported: number;
  totalSkipped: number;
  totalErrors: number;
  categoriesCreated: number;
  accountsCreated: number;
  payeesCreated: number;
  securitiesCreated: number;
  fileResults: Array<{
    fileName: string;
    accountName: string;
    imported: number;
    skipped: number;
    errors: number;
    errorMessages: string[];
  }>;
}

export function suggestAccountType(name: string): string {
  const n = name.toLowerCase();
  if (/line\s*of\s*credit|\bloc\b/.test(n)) return 'LINE_OF_CREDIT';
  if (/visa|mastercard|amex|credit\s*card|credit/.test(n)) return 'CREDIT_CARD';
  if (/savings?/.test(n)) return 'SAVINGS';
  if (/mortgage/.test(n)) return 'MORTGAGE';
  if (/loan/.test(n)) return 'LOAN';
  if (/invest|brokerage|rrsp|tfsa|401k|ira/.test(n)) return 'INVESTMENT';
  if (/\bcash\b/.test(n)) return 'CASH';
  if (/\basset\b/.test(n)) return 'ASSET';
  return 'CHEQUING';
}

export const formatCategoryPath = (path: string): string => {
  return path.replace(/:/g, ': ').replace(/:  /g, ': ');
};

export const ACCOUNT_TYPE_OPTIONS = [
  { value: 'CHEQUING', label: 'Chequing' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CREDIT_CARD', label: 'Credit Card' },
  { value: 'INVESTMENT', label: 'Investment' },
  { value: 'LOAN', label: 'Loan' },
  { value: 'LINE_OF_CREDIT', label: 'Line of Credit' },
  { value: 'MORTGAGE', label: 'Mortgage' },
  { value: 'CASH', label: 'Cash' },
  { value: 'ASSET', label: 'Asset' },
  { value: 'OTHER', label: 'Other' },
];

export const SECURITY_TYPE_OPTIONS = [
  { value: 'STOCK', label: 'Stock' },
  { value: 'ETF', label: 'ETF' },
  { value: 'MUTUAL_FUND', label: 'Mutual Fund' },
  { value: 'BOND', label: 'Bond' },
  { value: 'GIC', label: 'GIC' },
  { value: 'CASH', label: 'Cash/Money Market' },
  { value: 'OTHER', label: 'Other' },
];
