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
    columnMapping: defaultMapping(),
    onColumnMappingChange: vi.fn(),
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
    expect(screen.getByText('Date *')).toBeInTheDocument();
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
});
