import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, fireEvent } from '@testing-library/react';
import { CsvTransferRules } from './CsvTransferRules';
import { CsvTransferRule } from '@/lib/import';
import { Account } from '@/types/account';

function makeAccount(overrides: Partial<Account> & { id: string; name: string }): Account {
  return {
    userId: 'u1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 0, currentBalance: 0,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false, statementDueDay: null, statementSettlementDay: null,
    paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null,
    termEndDate: null, amortizationMonths: null, originalPrincipal: null,
    createdAt: '', updatedAt: '',
    ...overrides,
  };
}

const mockAccounts: Account[] = [
  makeAccount({ id: '1', name: 'Chequing', currentBalance: 1000 }),
  makeAccount({ id: '2', name: 'Savings', accountType: 'SAVINGS', currentBalance: 5000 }),
  makeAccount({ id: '3', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE' }),
  makeAccount({ id: '4', name: 'Closed Account', isClosed: true, closedDate: '2025-01-01' }),
];

describe('CsvTransferRules', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No transfer rules" message when rules array is empty', () => {
    render(<CsvTransferRules rules={[]} onChange={onChange} accounts={mockAccounts} />);

    expect(screen.getByText(/No transfer rules defined/)).toBeInTheDocument();
  });

  it('renders existing rules with correct values', () => {
    const rules: CsvTransferRule[] = [
      { type: 'payee', pattern: 'Transfer', accountName: 'Savings' },
      { type: 'category', pattern: 'Internal', accountName: 'Chequing' },
    ];

    render(<CsvTransferRules rules={rules} onChange={onChange} accounts={mockAccounts} />);

    const patternInputs = screen.getAllByPlaceholderText('Pattern...');

    expect(patternInputs[0]).toHaveValue('Transfer');
    expect(patternInputs[1]).toHaveValue('Internal');

    // Account dropdowns should have correct values
    const accountSelects = screen.getAllByDisplayValue('Savings');
    expect(accountSelects).toHaveLength(1);
    expect(screen.getByDisplayValue('Chequing')).toBeInTheDocument();
  });

  it('clicking "Add Rule" calls onChange with a new rule appended', () => {
    const existingRules: CsvTransferRule[] = [
      { type: 'payee', pattern: 'Test', accountName: 'Chequing' },
    ];

    render(<CsvTransferRules rules={existingRules} onChange={onChange} accounts={mockAccounts} />);

    fireEvent.click(screen.getByText('Add Rule'));

    expect(onChange).toHaveBeenCalledWith([
      { type: 'payee', pattern: 'Test', accountName: 'Chequing' },
      { type: 'payee', pattern: '', accountName: '' },
    ]);
  });

  it('clicking remove button calls onChange with the rule removed', () => {
    const rules: CsvTransferRule[] = [
      { type: 'payee', pattern: 'First', accountName: 'Chequing' },
      { type: 'category', pattern: 'Second', accountName: 'Savings' },
    ];

    render(<CsvTransferRules rules={rules} onChange={onChange} accounts={mockAccounts} />);

    const removeButtons = screen.getAllByTitle('Remove rule');
    fireEvent.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith([
      { type: 'category', pattern: 'Second', accountName: 'Savings' },
    ]);
  });

  it('changing the type dropdown calls onChange with updated type', () => {
    const rules: CsvTransferRule[] = [
      { type: 'payee', pattern: 'Test', accountName: 'Chequing' },
    ];

    render(<CsvTransferRules rules={rules} onChange={onChange} accounts={mockAccounts} />);

    const select = screen.getByDisplayValue('Payee');
    fireEvent.change(select, { target: { value: 'category' } });

    expect(onChange).toHaveBeenCalledWith([
      { type: 'category', pattern: 'Test', accountName: 'Chequing' },
    ]);
  });

  it('changing pattern input calls onChange with updated pattern', () => {
    const rules: CsvTransferRule[] = [
      { type: 'payee', pattern: '', accountName: '' },
    ];

    render(<CsvTransferRules rules={rules} onChange={onChange} accounts={mockAccounts} />);

    const patternInput = screen.getByPlaceholderText('Pattern...');
    fireEvent.change(patternInput, { target: { value: 'NewPattern' } });

    expect(onChange).toHaveBeenCalledWith([
      { type: 'payee', pattern: 'NewPattern', accountName: '' },
    ]);
  });

  it('changing account dropdown calls onChange with updated accountName', () => {
    const rules: CsvTransferRule[] = [
      { type: 'payee', pattern: 'Test', accountName: '' },
    ];

    render(<CsvTransferRules rules={rules} onChange={onChange} accounts={mockAccounts} />);

    const accountSelect = screen.getByDisplayValue('Select account...');
    fireEvent.change(accountSelect, { target: { value: 'Savings' } });

    expect(onChange).toHaveBeenCalledWith([
      { type: 'payee', pattern: 'Test', accountName: 'Savings' },
    ]);
  });

  it('filters out closed and brokerage accounts from the dropdown', () => {
    const rules: CsvTransferRule[] = [
      { type: 'payee', pattern: 'Test', accountName: '' },
    ];

    render(<CsvTransferRules rules={rules} onChange={onChange} accounts={mockAccounts} />);

    const accountSelect = screen.getByDisplayValue('Select account...');
    const options = accountSelect.querySelectorAll('option');

    // "Select account..." + Chequing + Savings = 3 (no Brokerage or Closed Account)
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('Select account...');
    expect(options[1]).toHaveTextContent('Chequing');
    expect(options[2]).toHaveTextContent('Savings');
  });
});
