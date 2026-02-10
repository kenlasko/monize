import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { AccountForm } from './AccountForm';
import { Account } from '@/types/account';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    previewLoanAmortization: vi.fn(),
    previewMortgageAmortization: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: vi.fn().mockResolvedValue([]),
  },
  CurrencyInfo: {},
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (n: number) => n,
  }),
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

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('AccountForm', () => {
  const mockOnSubmit = vi.fn().mockResolvedValue(undefined);
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders account name input', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Account Name')).toBeInTheDocument();
  });

  it('renders account type select with options', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Account Type')).toBeInTheDocument();
  });

  it('shows "Create Account" button for new account', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByRole('button', { name: /Create Account/i })).toBeInTheDocument();
  });

  it('shows "Update Account" button when editing', () => {
    const existingAccount: Account = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      userId: 'user-1',
      accountType: 'CHEQUING',
      accountSubType: null,
      linkedAccountId: null,
      name: 'My Chequing',
      description: null,
      currencyCode: 'CAD',
      accountNumber: null,
      institution: null,
      openingBalance: 1000,
      currentBalance: 1500,
      creditLimit: null,
      interestRate: null,
      isClosed: false,
      closedDate: null,
      isFavourite: false,
      paymentAmount: null,
      paymentFrequency: null,
      paymentStartDate: null,
      sourceAccountId: null,
      principalCategoryId: null,
      interestCategoryId: null,
      scheduledTransactionId: null,
      assetCategoryId: null,
      dateAcquired: null,
      isCanadianMortgage: false,
      isVariableRate: false,
      termMonths: null,
      termEndDate: null,
      amortizationMonths: null,
      originalPrincipal: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('shows Investment pair checkbox when INVESTMENT type is selected (new account)', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    // Select INVESTMENT type
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'INVESTMENT' } });

    await waitFor(() => {
      expect(screen.getByText(/Create as Cash \+ Brokerage pair/i)).toBeInTheDocument();
    });
  });

  it('shows loan fields when LOAN type is selected for a new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.getByText('Loan Payment Details')).toBeInTheDocument();
    });
  });

  it('shows favourite toggle', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Add to favourites')).toBeInTheDocument();
  });

  it('toggles favourite when star button is clicked', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const favButton = screen.getByTitle('Add to favourites');
    fireEvent.click(favButton);

    expect(screen.getByText('Favourite')).toBeInTheDocument();
  });

  it('shows Import QIF button only when editing an existing account', () => {
    const existingAccount: Account = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      userId: 'user-1',
      accountType: 'CHEQUING',
      accountSubType: null,
      linkedAccountId: null,
      name: 'My Chequing',
      description: null,
      currencyCode: 'CAD',
      accountNumber: null,
      institution: null,
      openingBalance: 1000,
      currentBalance: 1500,
      creditLimit: null,
      interestRate: null,
      isClosed: false,
      closedDate: null,
      isFavourite: false,
      paymentAmount: null,
      paymentFrequency: null,
      paymentStartDate: null,
      sourceAccountId: null,
      principalCategoryId: null,
      interestCategoryId: null,
      scheduledTransactionId: null,
      assetCategoryId: null,
      dateAcquired: null,
      isCanadianMortgage: false,
      isVariableRate: false,
      termMonths: null,
      termEndDate: null,
      amortizationMonths: null,
      originalPrincipal: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Import QIF')).toBeInTheDocument();
  });

  it('does not show Import QIF button for new accounts', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.queryByText('Import QIF')).not.toBeInTheDocument();
  });
});
