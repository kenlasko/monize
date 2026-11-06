import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, fireEvent } from '@testing-library/react';
import { CsvColumnMappingStep } from './CsvColumnMappingStep';
import { CsvColumnMappingConfig, SavedColumnMapping } from '@/lib/import';

function defaultMapping(): CsvColumnMappingConfig {
  return {
    date: 0,
    amount: undefined,
    debit: undefined,
    credit: undefined,
    payee: undefined,
    category: undefined,
    memo: undefined,
    referenceNumber: undefined,
    tags: undefined,
    reconciliationStatus: undefined,
    dateFormat: 'MM/DD/YYYY',
    hasHeader: true,
    delimiter: ',',
  };
}

function renderStep(overrides: Record<string, unknown> = {}) {
  const defaultProps = {
    headers: ['Date', 'Amount', 'Payee', 'Category'],
    sampleRows: [
      ['2024-01-01', '100.00', 'Store', 'Food'],
      ['2024-01-02', '50.00', 'Gas Station', 'Transport'],
    ],
    columnDateFormats: [],
    columnMapping: defaultMapping(),
    onColumnMappingChange: vi.fn(),
    onInvestmentModeChange: vi.fn(),
    transferRules: [],
    onTransferRulesChange: vi.fn(),
    accounts: [],
    savedMappings: [],
    onSaveMapping: vi.fn(),
    onLoadMapping: vi.fn(),
    onDeleteMapping: vi.fn(),
    onDelimiterChange: vi.fn(),
    onHasHeaderChange: vi.fn(),
    isLoading: false,
    onNext: vi.fn(),
    setStep: vi.fn(),
    ...overrides,
  };

  render(<CsvColumnMappingStep {...defaultProps} />);

  return defaultProps;
}

describe('CsvColumnMappingStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('renders heading "CSV Column Mapping"', () => {
    renderStep();

    expect(screen.getByText('CSV Column Mapping')).toBeInTheDocument();
  });

  it('renders data preview table with sample rows', () => {
    renderStep();

    expect(screen.getByText('Data Preview')).toBeInTheDocument();
    expect(screen.getByText('2024-01-01')).toBeInTheDocument();
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.getByText('Gas Station')).toBeInTheDocument();
  });

  it('renders column mapping dropdowns', () => {
    renderStep();

    expect(screen.getByText('Column Mapping')).toBeInTheDocument();
    expect(screen.getByText('Date', { selector: 'label' })).toBeInTheDocument();
    // "Payee" appears in both the preview table header and the mapping label
    expect(screen.getAllByText('Payee')).toHaveLength(2);
    expect(screen.getByText('Memo')).toBeInTheDocument();
  });

  it('shows validation error when Next clicked without date column mapped', () => {
    const props = renderStep({
      columnMapping: { ...defaultMapping(), date: undefined },
    });

    fireEvent.click(screen.getByText('Next'));

    expect(screen.getByText('Date column is required')).toBeInTheDocument();
    expect(props.onNext).not.toHaveBeenCalled();
  });

  it('shows validation error when amount missing in single mode', () => {
    const props = renderStep({
      columnMapping: { ...defaultMapping(), amount: undefined },
    });

    fireEvent.click(screen.getByText('Next'));

    expect(screen.getByText('Amount column is required')).toBeInTheDocument();
    expect(props.onNext).not.toHaveBeenCalled();
  });

  it('shows validation error when debit/credit missing in split mode', () => {
    const props = renderStep({
      columnMapping: { ...defaultMapping(), debit: 1, credit: undefined },
    });

    // Switch to split mode
    const amountTypeSelect = screen.getByDisplayValue('Separate debit/credit');
    expect(amountTypeSelect).toBeInTheDocument();

    fireEvent.click(screen.getByText('Next'));

    expect(screen.getByText('Both debit and credit columns are required')).toBeInTheDocument();
    expect(props.onNext).not.toHaveBeenCalled();
  });

  it('calls onNext when valid mapping provided', () => {
    const props = renderStep({
      columnMapping: { ...defaultMapping(), date: 0, amount: 1 },
    });

    fireEvent.click(screen.getByText('Next'));

    expect(props.onNext).toHaveBeenCalledTimes(1);
  });

  it('calls onDelimiterChange when delimiter select changes', () => {
    const props = renderStep();

    const delimiterSelect = screen.getByDisplayValue('Comma (,)');
    fireEvent.change(delimiterSelect, { target: { value: ';' } });

    expect(props.onDelimiterChange).toHaveBeenCalledWith(';');
  });

  it('calls onHasHeaderChange when checkbox toggled', () => {
    const props = renderStep();

    const checkbox = screen.getByRole('checkbox', { name: /First row is header/i });
    fireEvent.click(checkbox);

    expect(props.onHasHeaderChange).toHaveBeenCalledWith(false);
  });

  it('shows "No saved mappings" when savedMappings is empty', () => {
    renderStep();

    expect(screen.getByText('No saved mappings')).toBeInTheDocument();
  });

  it('shows saved mappings dropdown when savedMappings provided', () => {
    const savedMappings: SavedColumnMapping[] = [
      {
        id: 'map-1',
        name: 'Bank Export',
        columnMappings: defaultMapping(),
        transferRules: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ];

    renderStep({ savedMappings });

    expect(screen.getByText('Load a saved mapping...')).toBeInTheDocument();
    // "Bank Export" appears in both the select option and the tag below
    expect(screen.getAllByText('Bank Export').length).toBeGreaterThanOrEqual(1);
  });

  it('calls onSaveMapping when Save Current clicked and name entered', () => {
    const props = renderStep();

    fireEvent.click(screen.getByText('Save Current'));

    const input = screen.getByPlaceholderText('Enter mapping name...');
    fireEvent.change(input, { target: { value: 'My Mapping' } });
    fireEvent.click(screen.getByText('Save'));

    expect(props.onSaveMapping).toHaveBeenCalledWith('My Mapping');
  });

  it('calls onLoadMapping when a saved mapping is selected', () => {
    const savedMappings: SavedColumnMapping[] = [
      {
        id: 'map-1',
        name: 'Bank Export',
        columnMappings: defaultMapping(),
        transferRules: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ];

    const props = renderStep({ savedMappings });

    const loadSelect = screen.getByDisplayValue('Load a saved mapping...');
    fireEvent.change(loadSelect, { target: { value: 'map-1' } });

    expect(props.onLoadMapping).toHaveBeenCalledWith(savedMappings[0]);
  });

  it('calls onDeleteMapping when delete button clicked on a saved mapping', () => {
    const savedMappings: SavedColumnMapping[] = [
      {
        id: 'map-1',
        name: 'Bank Export',
        columnMappings: defaultMapping(),
        transferRules: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ];

    const props = renderStep({ savedMappings });

    const deleteButton = screen.getByTitle('Delete');
    fireEvent.click(deleteButton);

    expect(props.onDeleteMapping).toHaveBeenCalledWith('map-1');
  });

  it('shows Sign dropdown in single amount mode', () => {
    renderStep({
      columnMapping: { ...defaultMapping(), amount: 1 },
    });

    expect(screen.getByText('Sign')).toBeInTheDocument();
    expect(screen.getByDisplayValue('As-is (positive = deposit)')).toBeInTheDocument();
  });

  it('calls onColumnMappingChange with reverseSign when Sign dropdown changed', () => {
    const props = renderStep({
      columnMapping: { ...defaultMapping(), amount: 1 },
    });

    const signSelect = screen.getByDisplayValue('As-is (positive = deposit)');
    fireEvent.change(signSelect, { target: { value: 'reverse' } });

    expect(props.onColumnMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({ reverseSign: true }),
    );
  });

  it('does not show Sign dropdown in split debit/credit mode', () => {
    renderStep({
      columnMapping: { ...defaultMapping(), amount: undefined, debit: 1, credit: 2 },
    });

    expect(screen.queryByText('Sign')).not.toBeInTheDocument();
  });

  it('shows "Will overwrite" when save name matches existing mapping', () => {
    const savedMappings: SavedColumnMapping[] = [
      {
        id: 'map-1',
        name: 'Bank Export',
        columnMappings: defaultMapping(),
        transferRules: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ];

    renderStep({ savedMappings });

    fireEvent.click(screen.getByText('Save Current'));

    const input = screen.getByPlaceholderText('Enter mapping name...');
    fireEvent.change(input, { target: { value: 'Bank Export' } });

    expect(screen.getByText('Will overwrite')).toBeInTheDocument();
  });

  it('hides save input when Cancel clicked', () => {
    renderStep();

    fireEvent.click(screen.getByText('Save Current'));
    expect(screen.getByPlaceholderText('Enter mapping name...')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('Enter mapping name...')).not.toBeInTheDocument();
  });

  it('saves mapping on Enter key press', () => {
    const props = renderStep();

    fireEvent.click(screen.getByText('Save Current'));

    const input = screen.getByPlaceholderText('Enter mapping name...');
    fireEvent.change(input, { target: { value: 'Quick Save' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(props.onSaveMapping).toHaveBeenCalledWith('Quick Save');
  });

  it('does not save when name is empty', () => {
    const props = renderStep();

    fireEvent.click(screen.getByText('Save Current'));

    const saveButton = screen.getByText('Save');
    expect(saveButton).toBeDisabled();

    expect(props.onSaveMapping).not.toHaveBeenCalled();
  });

  it('Back button calls setStep with upload', () => {
    const props = renderStep();

    fireEvent.click(screen.getByText('Back'));

    expect(props.setStep).toHaveBeenCalledWith('upload');
  });

  describe('transaction type column (via Sign dropdown)', () => {
    it('does not show transaction type settings by default', () => {
      renderStep({
        columnMapping: { ...defaultMapping(), amount: 1 },
      });

      expect(screen.queryByText('Transaction type column')).not.toBeInTheDocument();
      expect(screen.queryByText('Income keywords')).not.toBeInTheDocument();
      expect(screen.queryByText('Expense keywords')).not.toBeInTheDocument();
    });

    it('Sign dropdown includes "Use transaction type column" option', () => {
      renderStep({
        columnMapping: { ...defaultMapping(), amount: 1 },
      });

      const signSelect = screen.getByDisplayValue('As-is (positive = deposit)');
      expect(signSelect).toBeInTheDocument();
      expect(signSelect.querySelector('option[value="type-column"]')).toBeInTheDocument();
    });

    it('sets amountTypeColumn to 0 when "Use transaction type column" selected', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1 },
      });

      const signSelect = screen.getByDisplayValue('As-is (positive = deposit)');
      fireEvent.change(signSelect, { target: { value: 'type-column' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ amountTypeColumn: 0 }),
      );
    });

    it('shows keyword inputs when amountTypeColumn is set in mapping', () => {
      renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });

      expect(screen.getByText('Transaction type column')).toBeInTheDocument();
      expect(screen.getByText('Income keywords')).toBeInTheDocument();
      expect(screen.getByText('Expense keywords')).toBeInTheDocument();
      expect(screen.getByText('Transfer-out keywords')).toBeInTheDocument();
      expect(screen.getByText('Transfer-in keywords')).toBeInTheDocument();
    });

    it('Sign dropdown shows "Use transaction type column" when amountTypeColumn is set', () => {
      renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });

      const signSelect = screen.getByDisplayValue('Use transaction type column');
      expect(signSelect).toBeInTheDocument();
    });

    it('shows unique values found in sample data when column is selected', () => {
      renderStep({
        headers: ['Date', 'Amount', 'Payee', 'Type'],
        sampleRows: [
          ['2024-01-01', '100.00', 'Store', 'Expense'],
          ['2024-01-02', '50.00', 'Work', 'Income'],
          ['2024-01-03', '200.00', 'ATM', 'Transfer-Out'],
        ],
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 3 },
      });

      expect(screen.getByText('Values found: Expense, Income, Transfer-Out')).toBeInTheDocument();
    });

    it('displays existing expenseValues in keyword input', () => {
      renderStep({
        columnMapping: {
          ...defaultMapping(),
          amount: 1,
          amountTypeColumn: 2,
          expenseValues: ['Expense', 'Debit'],
        },
      });

      const expenseInput = screen.getByPlaceholderText('e.g. Expense, Debit');
      expect((expenseInput as HTMLInputElement).value).toBe('Expense, Debit');
    });

    it('calls onColumnMappingChange with parsed expenseValues when keywords entered', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });

      const expenseInput = screen.getByPlaceholderText('e.g. Expense, Debit');
      fireEvent.change(expenseInput, { target: { value: 'Expense, Withdrawal' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ expenseValues: ['Expense', 'Withdrawal'] }),
      );
    });

    it('clears amountType fields when Sign changed back to normal', () => {
      const onColumnMappingChange = vi.fn();
      renderStep({
        columnMapping: {
          ...defaultMapping(),
          amount: 1,
          amountTypeColumn: 2,
          expenseValues: ['Expense'],
          transferOutValues: ['Transfer-Out'],
        },
        onColumnMappingChange,
      });

      // Change Sign from "Use transaction type column" back to "As-is"
      const signSelect = screen.getByDisplayValue('Use transaction type column');
      fireEvent.change(signSelect, { target: { value: 'normal' } });

      const calls = onColumnMappingChange.mock.calls;
      const callArg = calls[calls.length - 1][0];
      expect(callArg.amountTypeColumn).toBeUndefined();
      expect(callArg.incomeValues).toBeUndefined();
      expect(callArg.expenseValues).toBeUndefined();
      expect(callArg.transferOutValues).toBeUndefined();
      expect(callArg.transferInValues).toBeUndefined();
      expect(callArg.transferAccountColumn).toBeUndefined();
      expect(callArg.reverseSign).toBeUndefined();
    });

    it('clears amountType fields when Sign changed to reverse', () => {
      const onColumnMappingChange = vi.fn();
      renderStep({
        columnMapping: {
          ...defaultMapping(),
          amount: 1,
          amountTypeColumn: 2,
          expenseValues: ['Expense'],
        },
        onColumnMappingChange,
      });

      const signSelect = screen.getByDisplayValue('Use transaction type column');
      fireEvent.change(signSelect, { target: { value: 'reverse' } });

      const calls = onColumnMappingChange.mock.calls;
      const callArg = calls[calls.length - 1][0];
      expect(callArg.amountTypeColumn).toBeUndefined();
      expect(callArg.reverseSign).toBe(true);
    });

    it('renders Transfer account column dropdown when amountTypeColumn is set', () => {
      renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });

      expect(screen.getByText('Transfer account column')).toBeInTheDocument();
      expect(screen.getByText('Use category column')).toBeInTheDocument();
    });

    it('calls onColumnMappingChange with transferAccountColumn when selected', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Type', 'Account'],
        sampleRows: [['2024-01-01', '100.00', 'Expense', 'Savings']],
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });

      const transferAcctSelect = screen.getByDisplayValue('Use category column');
      fireEvent.change(transferAcctSelect, { target: { value: '3' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ transferAccountColumn: 3 }),
      );
    });

    it('allows changing the transaction type column within the panel', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Type', 'OtherType'],
        sampleRows: [['2024-01-01', '100.00', 'Expense', 'Income']],
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });

      // Find the transaction type column select inside the panel
      const typeColumnLabel = screen.getByText('Transaction type column');
      const section = typeColumnLabel.closest('.p-3');
      const typeColumnSelect = section!.querySelector('select');
      expect(typeColumnSelect).toBeDefined();

      fireEvent.change(typeColumnSelect!, { target: { value: '3' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ amountTypeColumn: 3 }),
      );
    });
  });

  describe('tags and reconciliation status mapping', () => {
    it('renders the Tags column dropdown after Memo and Reference Number', () => {
      // Use neutral header names so the preview table doesn't collide with
      // the mapping form labels ("Tags", "Reconciliation Status").
      renderStep({
        headers: ['Date', 'Amount', 'Payee', 'Memo Col', 'Ref Col', 'Tag Col', 'Status Col'],
        sampleRows: [['2024-01-01', '100.00', 'Store', 'Note', 'REF1', 'Food; Groceries', 'Cleared']],
      });

      expect(screen.getByText('Tags')).toBeInTheDocument();
      expect(screen.getByText('Reconciliation Status')).toBeInTheDocument();

      // Verify the DOM order: Memo should come before Tags, Reference Number before Reconciliation Status.
      const memoLabel = screen.getByText('Memo');
      const tagsLabel = screen.getByText('Tags');
      const refLabel = screen.getByText('Reference Number');
      const statusLabel = screen.getByText('Reconciliation Status');

      expect(memoLabel.compareDocumentPosition(tagsLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(refLabel.compareDocumentPosition(statusLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('calls onColumnMappingChange with the tag column index when selected', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Payee', 'Tags'],
        sampleRows: [['2024-01-01', '100.00', 'Store', 'Food, Groceries']],
      });

      const labels = screen.getAllByText('Tags');
      // The mapping-form label (not the preview-table header) is the one that
      // labels the select we want.
      const tagsFieldLabel = labels[labels.length - 1];
      const tagsSelect = tagsFieldLabel.parentElement!.querySelector('select');
      expect(tagsSelect).toBeTruthy();
      fireEvent.change(tagsSelect!, { target: { value: '3' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ tags: 3 }),
      );
    });

    it('calls onColumnMappingChange with the status column index when selected', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Payee', 'Status'],
        sampleRows: [['2024-01-01', '100.00', 'Store', 'Cleared']],
      });

      const statusLabel = screen.getByText('Reconciliation Status');
      const statusSelect = statusLabel.parentElement!.querySelector('select');
      expect(statusSelect).toBeTruthy();
      fireEvent.change(statusSelect!, { target: { value: '3' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ reconciliationStatus: 3 }),
      );
    });

    it('clears tags mapping back to undefined when "Not mapped" is chosen', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), tags: 2 },
      });

      const labels = screen.getAllByText('Tags');
      const tagsFieldLabel = labels[labels.length - 1];
      const tagsSelect = tagsFieldLabel.parentElement!.querySelector('select') as HTMLSelectElement;
      expect(tagsSelect.value).toBe('2');

      fireEvent.change(tagsSelect, { target: { value: '' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ tags: undefined }),
      );
    });

    it('clears reconciliation status mapping back to undefined when "Not mapped" is chosen', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), reconciliationStatus: 2 },
      });

      const statusLabel = screen.getByText('Reconciliation Status');
      const statusSelect = statusLabel.parentElement!.querySelector('select') as HTMLSelectElement;
      expect(statusSelect.value).toBe('2');

      fireEvent.change(statusSelect, { target: { value: '' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ reconciliationStatus: undefined }),
      );
    });

    it('reflects saved mappings that include tags and status when loaded', () => {
      const saved: SavedColumnMapping = {
        id: 'm-1',
        name: 'Has Tags',
        columnMappings: {
          ...defaultMapping(),
          tags: 4,
          reconciliationStatus: 5,
        },
        transferRules: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const props = renderStep({ savedMappings: [saved] });

      const loadSelect = screen.getByDisplayValue('Load a saved mapping...');
      fireEvent.change(loadSelect, { target: { value: 'm-1' } });

      expect(props.onLoadMapping).toHaveBeenCalledWith(saved);
      expect(saved.columnMappings.tags).toBe(4);
      expect(saved.columnMappings.reconciliationStatus).toBe(5);
    });
  });

  describe('detected date format', () => {
    it('preselects the format the server detected for the date column over the whole file', () => {
      // The first sample rows read either way; the server saw a later row
      // dated after the 12th.
      const props = renderStep({
        sampleRows: [['01/03/2026', '100.00', 'Store', 'Food']],
        columnDateFormats: ['DD/MM/YYYY', null, null, null],
        columnMapping: { ...defaultMapping(), amount: 1 },
      });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ dateFormat: 'DD/MM/YYYY' }),
      );
    });

    it('uses the mapped date column, not the first column', () => {
      const props = renderStep({
        headers: ['Posted', 'Amount', 'Payee', 'Date'],
        columnDateFormats: ['YYYY-MM-DD', null, null, 'DD-MMM-YYYY'],
        columnMapping: { ...defaultMapping(), date: 3, amount: 1 },
      });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ dateFormat: 'DD-MMM-YYYY' }),
      );
    });

    it('keeps the mapping\'s format when the server detected none or the same one', () => {
      const props = renderStep({
        columnDateFormats: [null, null, null, null],
        columnMapping: { ...defaultMapping(), amount: 1 },
      });
      expect(props.onColumnMappingChange).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('MM/DD/YYYY')).toBeInTheDocument();
    });

    it('offers the month-name formats in the picker', () => {
      renderStep({ columnMapping: { ...defaultMapping(), amount: 1, dateFormat: 'MMM DD, YYYY' } });

      expect(screen.getByDisplayValue('MMM DD, YYYY')).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'DD-MMM-YYYY' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('e.g. DD.MM.YYYY')).not.toBeInTheDocument();
    });
  });

  describe('custom date format', () => {
    it('switches to custom mode and shows a free-text input when "Custom..." is chosen', () => {
      renderStep({ columnMapping: { ...defaultMapping(), amount: 1 } });

      const dateFormatSelect = screen.getByDisplayValue('MM/DD/YYYY');
      fireEvent.change(dateFormatSelect, { target: { value: '__custom__' } });

      expect(screen.getByPlaceholderText('e.g. DD.MM.YYYY')).toBeInTheDocument();
    });

    it('propagates a typed custom date format via onColumnMappingChange', () => {
      const props = renderStep({ columnMapping: { ...defaultMapping(), amount: 1 } });

      const dateFormatSelect = screen.getByDisplayValue('MM/DD/YYYY');
      fireEvent.change(dateFormatSelect, { target: { value: '__custom__' } });

      const customInput = screen.getByPlaceholderText('e.g. DD.MM.YYYY');
      fireEvent.change(customInput, { target: { value: 'DD.MM.YYYY' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ dateFormat: 'DD.MM.YYYY' }),
      );
    });

    it('treats a non-standard dateFormat in the mapping as custom on mount', () => {
      // No detected format -> autoDetectedFormat is null, so the mapping's
      // non-standard dateFormat drives the custom-mode detection.
      renderStep({
        sampleRows: [],
        columnMapping: { ...defaultMapping(), amount: 1, dateFormat: 'DD.MM.YYYY' },
      });

      const customInput = screen.getByPlaceholderText('e.g. DD.MM.YYYY') as HTMLInputElement;
      expect(customInput.value).toBe('DD.MM.YYYY');
    });

    it('returns to a standard format and clears custom mode', () => {
      const props = renderStep({
        sampleRows: [],
        columnMapping: { ...defaultMapping(), amount: 1, dateFormat: 'DD.MM.YYYY' },
      });

      // Currently custom; the select reads as the custom sentinel
      const dateFormatSelect = screen.getByDisplayValue('Custom...');
      fireEvent.change(dateFormatSelect, { target: { value: 'MM/DD/YYYY' } });

      // The component reports the standard format to the parent. (Visibility of
      // the custom input is parent-controlled via columnMapping.dateFormat, which
      // the mock does not re-render, so we only assert the callback here.)
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ dateFormat: 'MM/DD/YYYY' }),
      );
    });
  });

  describe('sign normal/reverse clearing', () => {
    it('clears type-column fields when Sign changed to "normal"', () => {
      const onColumnMappingChange = vi.fn();
      renderStep({
        columnMapping: {
          ...defaultMapping(),
          amount: 1,
          reverseSign: true,
        },
        onColumnMappingChange,
      });

      const signSelect = screen.getByDisplayValue('Reverse (positive = withdrawal)');
      fireEvent.change(signSelect, { target: { value: 'normal' } });

      const callArg = onColumnMappingChange.mock.calls.at(-1)![0];
      expect(callArg.reverseSign).toBeUndefined();
      expect(callArg.amountTypeColumn).toBeUndefined();
    });
  });

  describe('type-column keyword inputs', () => {
    it('propagates income keywords', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. Income, Deposit'), {
        target: { value: 'Income, Deposit' },
      });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ incomeValues: ['Income', 'Deposit'] }),
      );
    });

    it('propagates transfer-out keywords', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. Transfer-Out'), {
        target: { value: 'Transfer-Out, TO' },
      });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ transferOutValues: ['Transfer-Out', 'TO'] }),
      );
    });

    it('propagates transfer-in keywords', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2 },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. Transfer-In'), {
        target: { value: 'Transfer-In' },
      });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ transferInValues: ['Transfer-In'] }),
      );
    });

    it('sets income keywords to undefined when cleared', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2, incomeValues: ['Income'] },
      });
      const incomeInput = screen.getByPlaceholderText('e.g. Income, Deposit');
      fireEvent.change(incomeInput, { target: { value: '' } });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ incomeValues: undefined }),
      );
    });

    it('clears transferAccountColumn back to category default when "Use category column" is chosen', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Type', 'Account'],
        sampleRows: [['2024-01-01', '100.00', 'Expense', 'Savings']],
        columnMapping: { ...defaultMapping(), amount: 1, amountTypeColumn: 2, transferAccountColumn: 3 },
      });

      // With transferAccountColumn set, the select shows the column label, not the default
      const transferAcctSelect = screen.getByDisplayValue('Account (Col 4)');
      fireEvent.change(transferAcctSelect, { target: { value: '' } });

      const callArg = props.onColumnMappingChange.mock.calls.at(-1)![0];
      expect(callArg.transferAccountColumn).toBeUndefined();
    });
  });

  describe('investment mode', () => {
    const investmentHeaders = ['Trade Date', 'Action Col', 'Symbol Col', 'Qty Col', 'Price Col', 'Amount Col'];
    const investmentRows = [
      ['2024-01-01', 'Bought', 'AAPL', '10', '150.00', '-1500.00'],
      ['2024-01-02', 'Journal', 'MSFT', '5', '300.00', '-1500.00'],
    ];

    it('renders the kind select defaulting to banking', () => {
      renderStep();

      expect(screen.getByText('File contains')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Banking transactions')).toBeInTheDocument();
    });

    it('calls onInvestmentModeChange(true) when Investment is selected', () => {
      const props = renderStep();

      const kindSelect = screen.getByDisplayValue('Banking transactions');
      fireEvent.change(kindSelect, { target: { value: 'investment' } });

      expect(props.onInvestmentModeChange).toHaveBeenCalledWith(true);
    });

    it('calls onInvestmentModeChange(false) when switched back to Banking', () => {
      const props = renderStep({
        columnMapping: { ...defaultMapping(), amount: 1, investmentMode: true },
      });

      const kindSelect = screen.getByDisplayValue('Investment transactions');
      fireEvent.change(kindSelect, { target: { value: 'banking' } });

      expect(props.onInvestmentModeChange).toHaveBeenCalledWith(false);
    });

    it('shows investment column selects and hides Sign, Category, and transfer rules in investment mode', () => {
      renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: { ...defaultMapping(), amount: 5, investmentMode: true },
      });

      expect(screen.getByText('Action', { selector: 'label' })).toBeInTheDocument();
      expect(screen.getByText('Security (Symbol or Name)')).toBeInTheDocument();
      expect(screen.getByText('Quantity')).toBeInTheDocument();
      expect(screen.getByText('Price')).toBeInTheDocument();
      expect(screen.getByText('Commission')).toBeInTheDocument();

      expect(screen.queryByText('Sign')).not.toBeInTheDocument();
      expect(screen.queryByText('Category')).not.toBeInTheDocument();
      expect(screen.queryByText('Subcategory')).not.toBeInTheDocument();
      expect(screen.queryByText('Transfer Detection Rules')).not.toBeInTheDocument();
    });

    it('shows the Sign, Category, and transfer rules sections in banking mode', () => {
      // Neutral header names so the preview table does not collide with the
      // mapping form labels asserted below.
      renderStep({
        headers: ['Date Col', 'Amount Col', 'Payee Col', 'Cat Col'],
        columnMapping: { ...defaultMapping(), amount: 1 },
      });

      expect(screen.getByText('Sign')).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Transfer Detection Rules')).toBeInTheDocument();
      expect(screen.queryByText('Action', { selector: 'label' })).not.toBeInTheDocument();
    });

    it('shows validation error when Next clicked without an action column', () => {
      const props = renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: {
          ...defaultMapping(),
          amount: 5,
          investmentMode: true,
          actionColumn: undefined,
          securityColumn: 2,
        },
      });

      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('Action column is required for investment files')).toBeInTheDocument();
      expect(props.onNext).not.toHaveBeenCalled();
    });

    it('shows validation error when Next clicked without a security column', () => {
      const props = renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: {
          ...defaultMapping(),
          amount: 5,
          investmentMode: true,
          actionColumn: 1,
          securityColumn: undefined,
        },
      });

      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('Security column is required for investment files')).toBeInTheDocument();
      expect(props.onNext).not.toHaveBeenCalled();
    });

    it('calls onNext when action and security columns are mapped', () => {
      const props = renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: {
          ...defaultMapping(),
          amount: 5,
          investmentMode: true,
          actionColumn: 1,
          securityColumn: 2,
        },
      });

      fireEvent.click(screen.getByText('Next'));

      expect(props.onNext).toHaveBeenCalledTimes(1);
    });

    it('lists action values found and flags unmatched ones', () => {
      renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: {
          ...defaultMapping(),
          amount: 5,
          investmentMode: true,
          actionColumn: 1,
          securityColumn: 2,
        },
      });

      expect(screen.getByText('Action values found: Bought, Journal')).toBeInTheDocument();
      // 'Bought' matches the buy defaults; 'Journal' matches nothing.
      expect(
        screen.getByText('Not matched (imported as cash by amount sign): Journal'),
      ).toBeInTheDocument();
    });

    it('round-trips the action keyword editor', () => {
      const props = renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: {
          ...defaultMapping(),
          amount: 5,
          investmentMode: true,
          actionColumn: 1,
          securityColumn: 2,
        },
      });

      // Editor is collapsed by default
      expect(screen.queryByText('Buy')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Customize action keywords'));
      expect(screen.getByText('Buy')).toBeInTheDocument();

      // The Buy input carries the built-in defaults as its placeholder
      const buyInput = screen.getByPlaceholderText('buy, bought, purchase, buy to open, you bought');
      fireEvent.change(buyInput, { target: { value: 'acquisto, compra' } });

      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ actionKeywords: { buy: ['acquisto', 'compra'] } }),
      );
    });

    it('removes an action override when its keyword input is cleared', () => {
      const props = renderStep({
        headers: investmentHeaders,
        sampleRows: investmentRows,
        columnMapping: {
          ...defaultMapping(),
          amount: 5,
          investmentMode: true,
          actionColumn: 1,
          securityColumn: 2,
          actionKeywords: { buy: ['acquisto'] },
        },
      });

      fireEvent.click(screen.getByText('Customize action keywords'));

      const buyInput = screen.getByPlaceholderText('buy, bought, purchase, buy to open, you bought') as HTMLInputElement;
      expect(buyInput.value).toBe('acquisto');
      fireEvent.change(buyInput, { target: { value: '' } });

      // The only override is gone, so actionKeywords collapses to undefined
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ actionKeywords: undefined }),
      );
    });
  });

  describe('optional field mapping updates', () => {
    function labelledSelect(labelText: string) {
      const label = screen.getByText(labelText);
      return label.parentElement!.querySelector('select') as HTMLSelectElement;
    }

    it('maps the Category column', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Cat Col'],
        sampleRows: [['2024-01-01', '100.00', 'Food']],
      });
      fireEvent.change(labelledSelect('Category'), { target: { value: '2' } });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ category: 2 }),
      );
    });

    it('maps the Subcategory column', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Sub Col'],
        sampleRows: [['2024-01-01', '100.00', 'Dining']],
      });
      fireEvent.change(labelledSelect('Subcategory'), { target: { value: '2' } });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ subcategory: 2 }),
      );
    });

    it('maps the Memo column', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Memo Col'],
        sampleRows: [['2024-01-01', '100.00', 'note']],
      });
      fireEvent.change(labelledSelect('Memo'), { target: { value: '2' } });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ memo: 2 }),
      );
    });

    it('maps the Reference Number column', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Ref Col'],
        sampleRows: [['2024-01-01', '100.00', 'REF1']],
      });
      fireEvent.change(labelledSelect('Reference Number'), { target: { value: '2' } });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ referenceNumber: 2 }),
      );
    });

    it('maps the Payee column', () => {
      const props = renderStep({
        headers: ['Date', 'Amount', 'Merchant'],
        sampleRows: [['2024-01-01', '100.00', 'Store']],
      });
      const payeeLabels = screen.getAllByText('Payee');
      const payeeSelect = payeeLabels[payeeLabels.length - 1].parentElement!.querySelector('select') as HTMLSelectElement;
      fireEvent.change(payeeSelect, { target: { value: '2' } });
      expect(props.onColumnMappingChange).toHaveBeenCalledWith(
        expect.objectContaining({ payee: 2 }),
      );
    });
  });
});
