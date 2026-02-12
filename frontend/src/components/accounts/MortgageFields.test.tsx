import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/render';
import { MortgageFields } from './MortgageFields';
import { Account } from '@/types/account';
import { Category } from '@/types/category';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    previewMortgageAmortization: vi.fn(),
  },
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: (input: string) => { try { const r = new Function(`"use strict"; return (${input})`)(); return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) / 100 : undefined; } catch { return undefined; } },
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
  }),
}));

const mockAccounts: Account[] = [
  {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'Main Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 5000, currentBalance: 5000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  },
];

const mockCategories: Category[] = [
  {
    id: 'cat-1', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Interest Expenses', description: null, icon: null, color: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
];

describe('MortgageFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });
  const mockSetValue = vi.fn();
  const mockFormatCurrency = vi.fn((amount: number) => `$${amount.toFixed(2)}`);

  const defaultProps = {
    currencySymbol: '$',
    watchedCurrency: 'CAD',
    isCanadianMortgage: true,
    isVariableRate: false,
    interestRate: undefined as number | undefined,
    paymentFrequency: undefined as any,
    mortgagePaymentFrequency: undefined as any,
    paymentStartDate: undefined as string | undefined,
    openingBalance: undefined as number | undefined,
    originalPrincipal: undefined as number | undefined,
    termMonths: undefined as number | undefined,
    amortizationMonths: undefined as number | undefined,
    setValue: mockSetValue,
    register: mockRegister,
    errors: {},
    accounts: mockAccounts,
    categories: mockCategories,
    formatCurrency: mockFormatCurrency,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the heading and mortgage-specific fields', () => {
    render(<MortgageFields {...defaultProps} />);

    expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    expect(screen.getByText('Payment Frequency (required)')).toBeInTheDocument();
    expect(screen.getByText('First Payment Date (required)')).toBeInTheDocument();
    expect(screen.getByText('Interest Category')).toBeInTheDocument();
  });

  it('renders payment frequency options for mortgages', () => {
    render(<MortgageFields {...defaultProps} />);

    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Bi-Weekly')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
  });

  it('renders term options', () => {
    render(<MortgageFields {...defaultProps} />);

    expect(screen.getByText('Term Length')).toBeInTheDocument();
  });

  it('renders amortization options', () => {
    render(<MortgageFields {...defaultProps} />);

    expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
  });

  it('renders source account select', () => {
    render(<MortgageFields {...defaultProps} />);

    expect(screen.getByText('Payment From Account (required)')).toBeInTheDocument();
  });

  it('does not show mortgage preview when required fields are missing', () => {
    render(<MortgageFields {...defaultProps} />);

    expect(screen.queryByText('Mortgage Preview')).not.toBeInTheDocument();
  });
});
