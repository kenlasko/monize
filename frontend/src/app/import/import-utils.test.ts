import { describe, it, expect } from 'vitest';
import {
  suggestAccountType,
  formatAccountType,
  formatCategoryPath,
  isInvestmentBrokerageAccount,
  ACCOUNT_TYPE_OPTIONS,
  SECURITY_TYPE_OPTIONS,
} from './import-utils';
import type { ImportStep, MatchConfidence, ImportFileData, BulkImportResult } from './import-utils';
import { Account } from '@/types/account';

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'Test Account',
    description: null,
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 0,
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
    canDelete: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('suggestAccountType', () => {
  describe('credit card detection', () => {
    it('returns CREDIT_CARD for "visa" in name', () => {
      expect(suggestAccountType('Visa Gold')).toBe('CREDIT_CARD');
    });

    it('returns CREDIT_CARD for "mastercard" in name', () => {
      expect(suggestAccountType('Mastercard Platinum')).toBe('CREDIT_CARD');
    });

    it('returns CREDIT_CARD for "amex" in name', () => {
      expect(suggestAccountType('AMEX Rewards')).toBe('CREDIT_CARD');
    });

    it('returns CREDIT_CARD for "credit card" in name', () => {
      expect(suggestAccountType('My Credit Card')).toBe('CREDIT_CARD');
    });

    it('returns CREDIT_CARD for "creditcard" (no space) in name', () => {
      expect(suggestAccountType('MyCreditCard')).toBe('CREDIT_CARD');
    });

    it('returns CREDIT_CARD for "credit" alone in name', () => {
      expect(suggestAccountType('Credit Account')).toBe('CREDIT_CARD');
    });
  });

  describe('savings detection', () => {
    it('returns SAVINGS for "savings" in name', () => {
      expect(suggestAccountType('High Interest Savings')).toBe('SAVINGS');
    });

    it('returns SAVINGS for "saving" (singular) in name', () => {
      expect(suggestAccountType('My Saving Account')).toBe('SAVINGS');
    });
  });

  describe('mortgage detection', () => {
    it('returns MORTGAGE for "mortgage" in name', () => {
      expect(suggestAccountType('Home Mortgage')).toBe('MORTGAGE');
    });
  });

  describe('line of credit detection', () => {
    it('returns LINE_OF_CREDIT for "line of credit" in name', () => {
      expect(suggestAccountType('Personal Line of Credit')).toBe('LINE_OF_CREDIT');
    });

    it('returns LINE_OF_CREDIT for "lineofcredit" (no spaces) in name', () => {
      expect(suggestAccountType('MyLineOfCredit')).toBe('LINE_OF_CREDIT');
    });

    it('returns LINE_OF_CREDIT for "loc" as standalone word in name', () => {
      expect(suggestAccountType('My LOC')).toBe('LINE_OF_CREDIT');
    });

    it('does not match "loc" inside another word', () => {
      // "block" contains "loc" but not as a standalone word
      expect(suggestAccountType('Block Account')).toBe('CHEQUING');
    });
  });

  describe('loan detection', () => {
    it('returns LOAN for "loan" in name', () => {
      expect(suggestAccountType('Car Loan')).toBe('LOAN');
    });
  });

  describe('investment detection', () => {
    it('returns INVESTMENT for "invest" in name', () => {
      expect(suggestAccountType('My Investments')).toBe('INVESTMENT');
    });

    it('returns INVESTMENT for "brokerage" in name', () => {
      expect(suggestAccountType('Brokerage Account')).toBe('INVESTMENT');
    });

    it('returns INVESTMENT for "rrsp" in name', () => {
      expect(suggestAccountType('RRSP Account')).toBe('INVESTMENT');
    });

    it('returns INVESTMENT for "tfsa" in name', () => {
      expect(suggestAccountType('TFSA')).toBe('INVESTMENT');
    });

    it('returns INVESTMENT for "401k" in name', () => {
      expect(suggestAccountType('Company 401k')).toBe('INVESTMENT');
    });

    it('returns INVESTMENT for "ira" in name', () => {
      expect(suggestAccountType('Roth IRA')).toBe('INVESTMENT');
    });
  });

  describe('cash detection', () => {
    it('returns CASH for "cash" as standalone word in name', () => {
      expect(suggestAccountType('Cash Wallet')).toBe('CASH');
    });

    it('does not match "cash" inside another word', () => {
      // "cashew" contains "cash" but the regex uses \bcash\b
      expect(suggestAccountType('Cashew Fund')).toBe('CHEQUING');
    });
  });

  describe('asset detection', () => {
    it('returns ASSET for "asset" as standalone word in name', () => {
      expect(suggestAccountType('My Asset')).toBe('ASSET');
    });

    it('does not match "asset" inside another word', () => {
      expect(suggestAccountType('Reasset Account')).toBe('CHEQUING');
    });
  });

  describe('default behavior', () => {
    it('returns CHEQUING for unrecognized names', () => {
      expect(suggestAccountType('Main Account')).toBe('CHEQUING');
    });

    it('returns CHEQUING for empty string', () => {
      expect(suggestAccountType('')).toBe('CHEQUING');
    });

    it('is case-insensitive', () => {
      expect(suggestAccountType('VISA')).toBe('CREDIT_CARD');
      expect(suggestAccountType('visa')).toBe('CREDIT_CARD');
      expect(suggestAccountType('Visa')).toBe('CREDIT_CARD');
    });
  });

  describe('priority ordering', () => {
    // Credit card check comes before savings, so "Credit Savings" should match credit first
    it('prioritizes credit card over savings when both match', () => {
      expect(suggestAccountType('Credit Savings')).toBe('CREDIT_CARD');
    });

    // Mortgage check comes before loan
    it('prioritizes mortgage over loan when both match', () => {
      expect(suggestAccountType('Mortgage Loan')).toBe('MORTGAGE');
    });
  });
});

describe('formatAccountType', () => {
  it('formats CHEQUING correctly', () => {
    expect(formatAccountType('CHEQUING')).toBe('Chequing');
  });

  it('formats SAVINGS correctly', () => {
    expect(formatAccountType('SAVINGS')).toBe('Savings');
  });

  it('formats CREDIT_CARD correctly', () => {
    expect(formatAccountType('CREDIT_CARD')).toBe('Credit Card');
  });

  it('formats INVESTMENT correctly', () => {
    expect(formatAccountType('INVESTMENT')).toBe('Investment');
  });

  it('formats LOAN correctly', () => {
    expect(formatAccountType('LOAN')).toBe('Loan');
  });

  it('formats MORTGAGE correctly', () => {
    expect(formatAccountType('MORTGAGE')).toBe('Mortgage');
  });

  it('formats CASH correctly', () => {
    expect(formatAccountType('CASH')).toBe('Cash');
  });

  it('formats LINE_OF_CREDIT correctly', () => {
    expect(formatAccountType('LINE_OF_CREDIT')).toBe('Line of Credit');
  });

  it('formats ASSET correctly', () => {
    expect(formatAccountType('ASSET')).toBe('Asset');
  });

  it('formats OTHER correctly', () => {
    expect(formatAccountType('OTHER')).toBe('Other');
  });

  it('returns the raw type string for unknown types', () => {
    // Force an unknown type via type assertion to test fallback
    expect(formatAccountType('UNKNOWN_TYPE' as any)).toBe('UNKNOWN_TYPE');
  });
});

describe('formatCategoryPath', () => {
  it('replaces colons with colon-space in category paths', () => {
    expect(formatCategoryPath('Expenses:Food')).toBe('Expenses: Food');
  });

  it('handles multiple colons in a path', () => {
    expect(formatCategoryPath('Expenses:Food:Groceries')).toBe('Expenses: Food: Groceries');
  });

  it('returns same string when no colons present', () => {
    expect(formatCategoryPath('Expenses')).toBe('Expenses');
  });

  it('handles empty string', () => {
    expect(formatCategoryPath('')).toBe('');
  });

  it('does not double-space when colon already followed by space', () => {
    // The first replace turns ":" into ": ", creating ":  " (double space).
    // The second replace normalizes ":  " back to ": ".
    expect(formatCategoryPath('Expenses: Food')).toBe('Expenses: Food');
  });

  it('handles path with consecutive colons', () => {
    expect(formatCategoryPath('A::B')).toBe('A: : B');
  });
});

describe('isInvestmentBrokerageAccount', () => {
  it('returns true for accounts with INVESTMENT_BROKERAGE subType', () => {
    const account = createAccount({ accountSubType: 'INVESTMENT_BROKERAGE' });
    expect(isInvestmentBrokerageAccount(account)).toBe(true);
  });

  it('returns false for accounts with INVESTMENT_CASH subType', () => {
    const account = createAccount({ accountSubType: 'INVESTMENT_CASH' });
    expect(isInvestmentBrokerageAccount(account)).toBe(false);
  });

  it('returns false for accounts with null subType', () => {
    const account = createAccount({ accountSubType: null });
    expect(isInvestmentBrokerageAccount(account)).toBe(false);
  });

  it('returns false for regular chequing account', () => {
    const account = createAccount({ accountType: 'CHEQUING', accountSubType: null });
    expect(isInvestmentBrokerageAccount(account)).toBe(false);
  });
});

describe('ACCOUNT_TYPE_OPTIONS', () => {
  it('is an array of objects with value and label properties', () => {
    expect(Array.isArray(ACCOUNT_TYPE_OPTIONS)).toBe(true);
    ACCOUNT_TYPE_OPTIONS.forEach((option) => {
      expect(option).toHaveProperty('value');
      expect(option).toHaveProperty('label');
      expect(typeof option.value).toBe('string');
      expect(typeof option.label).toBe('string');
    });
  });

  it('contains all expected account types', () => {
    const values = ACCOUNT_TYPE_OPTIONS.map((o) => o.value);
    expect(values).toContain('CHEQUING');
    expect(values).toContain('SAVINGS');
    expect(values).toContain('CREDIT_CARD');
    expect(values).toContain('INVESTMENT');
    expect(values).toContain('LOAN');
    expect(values).toContain('LINE_OF_CREDIT');
    expect(values).toContain('MORTGAGE');
    expect(values).toContain('CASH');
    expect(values).toContain('ASSET');
    expect(values).toContain('OTHER');
  });

  it('has 10 account type options', () => {
    expect(ACCOUNT_TYPE_OPTIONS).toHaveLength(10);
  });

  it('has correct labels for each type', () => {
    const map = Object.fromEntries(ACCOUNT_TYPE_OPTIONS.map((o) => [o.value, o.label]));
    expect(map['CHEQUING']).toBe('Chequing');
    expect(map['SAVINGS']).toBe('Savings');
    expect(map['CREDIT_CARD']).toBe('Credit Card');
    expect(map['INVESTMENT']).toBe('Investment');
    expect(map['LOAN']).toBe('Loan');
    expect(map['LINE_OF_CREDIT']).toBe('Line of Credit');
    expect(map['MORTGAGE']).toBe('Mortgage');
    expect(map['CASH']).toBe('Cash');
    expect(map['ASSET']).toBe('Asset');
    expect(map['OTHER']).toBe('Other');
  });
});

describe('SECURITY_TYPE_OPTIONS', () => {
  it('is an array of objects with value and label properties', () => {
    expect(Array.isArray(SECURITY_TYPE_OPTIONS)).toBe(true);
    SECURITY_TYPE_OPTIONS.forEach((option) => {
      expect(option).toHaveProperty('value');
      expect(option).toHaveProperty('label');
      expect(typeof option.value).toBe('string');
      expect(typeof option.label).toBe('string');
    });
  });

  it('contains all expected security types', () => {
    const values = SECURITY_TYPE_OPTIONS.map((o) => o.value);
    expect(values).toContain('STOCK');
    expect(values).toContain('ETF');
    expect(values).toContain('MUTUAL_FUND');
    expect(values).toContain('BOND');
    expect(values).toContain('GIC');
    expect(values).toContain('CASH');
    expect(values).toContain('OTHER');
  });

  it('has 7 security type options', () => {
    expect(SECURITY_TYPE_OPTIONS).toHaveLength(7);
  });

  it('has correct labels for each type', () => {
    const map = Object.fromEntries(SECURITY_TYPE_OPTIONS.map((o) => [o.value, o.label]));
    expect(map['STOCK']).toBe('Stock');
    expect(map['ETF']).toBe('ETF');
    expect(map['MUTUAL_FUND']).toBe('Mutual Fund');
    expect(map['BOND']).toBe('Bond');
    expect(map['GIC']).toBe('GIC');
    expect(map['CASH']).toBe('Cash/Money Market');
    expect(map['OTHER']).toBe('Other');
  });
});

describe('exported types', () => {
  it('ImportStep type accepts valid step values', () => {
    const steps: ImportStep[] = [
      'upload',
      'selectAccount',
      'mapCategories',
      'mapSecurities',
      'mapAccounts',
      'review',
      'complete',
    ];
    expect(steps).toHaveLength(7);
  });

  it('MatchConfidence type accepts valid confidence values', () => {
    const confidences: MatchConfidence[] = ['exact', 'partial', 'type', 'none'];
    expect(confidences).toHaveLength(4);
  });

  it('ImportFileData interface can be constructed', () => {
    const data: ImportFileData = {
      fileName: 'test.qif',
      fileContent: 'content',
      parsedData: {} as any,
      selectedAccountId: 'acc-1',
      matchConfidence: 'exact',
    };
    expect(data.fileName).toBe('test.qif');
    expect(data.matchConfidence).toBe('exact');
  });

  it('BulkImportResult interface can be constructed', () => {
    const result: BulkImportResult = {
      totalImported: 10,
      totalSkipped: 2,
      totalErrors: 1,
      categoriesCreated: 3,
      accountsCreated: 1,
      payeesCreated: 5,
      securitiesCreated: 0,
      fileResults: [
        {
          fileName: 'test.qif',
          accountName: 'Chequing',
          imported: 10,
          skipped: 2,
          errors: 1,
          errorMessages: ['Duplicate transaction'],
        },
      ],
    };
    expect(result.totalImported).toBe(10);
    expect(result.fileResults).toHaveLength(1);
    expect(result.fileResults[0].errorMessages).toContain('Duplicate transaction');
  });
});
