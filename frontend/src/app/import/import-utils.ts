import { ParsedQifResponse } from '@/lib/import';
export { formatAccountType, isInvestmentBrokerageAccount } from '@/lib/account-utils';

export type ImportFileType = 'qif' | 'ofx' | 'csv';
export type ImportStep = 'upload' | 'csvColumnMapping' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'multiAccountReview' | 'complete';
export type MatchConfidence = 'exact' | 'partial' | 'type' | 'none';

export interface ImportFileData {
  fileName: string;
  fileContent: string;
  fileType: ImportFileType;
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
    loanAccountsNeedingSetup?: Array<{
      accountId: string;
      accountName: string;
      accountType: string;
      currencyCode?: string;
    }>;
  }>;
  loanAccountsNeedingSetup?: Array<{
    accountId: string;
    accountName: string;
    accountType: string;
    currencyCode?: string;
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
  { value: 'OPTION', label: 'Option' },
  { value: 'GIC', label: 'GIC' },
  { value: 'CRYPTO', label: 'Cryptocurrency' },
  { value: 'CASH', label: 'Cash/Money Market' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * Map stock exchanges to their primary currency.
 * Mirrors the backend EXCHANGE_CURRENCY_MAP so the frontend can show
 * the derived currency before submission.
 */
export const EXCHANGE_CURRENCY_MAP: Record<string, string> = {
  NYSE: 'USD',
  NASDAQ: 'USD',
  AMEX: 'USD',
  NYSEARCA: 'USD',
  ARCA: 'USD',
  BATS: 'USD',
  TSX: 'CAD',
  'TSX-V': 'CAD',
  TSXV: 'CAD',
  NEO: 'CAD',
  CSE: 'CAD',
  LSE: 'GBP',
  LON: 'GBP',
  XETRA: 'EUR',
  FRA: 'EUR',
  FRANKFURT: 'EUR',
  EPA: 'EUR',
  PARIS: 'EUR',
  AMS: 'EUR',
  MIL: 'EUR',
  STO: 'SEK',
  TYO: 'JPY',
  TOKYO: 'JPY',
  HKG: 'HKD',
  HKEX: 'HKD',
  SHA: 'CNY',
  SHE: 'CNY',
  ASX: 'AUD',
  KRX: 'KRW',
  TAI: 'TWD',
  SGX: 'SGD',
  BSE: 'INR',
  NSE: 'INR',
};

/** Derive currency from an exchange code, or return null if unknown. */
export function getCurrencyFromExchange(exchange: string | undefined | null): string | null {
  if (!exchange) return null;
  const normalized = exchange.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return EXCHANGE_CURRENCY_MAP[normalized] || null;
}
