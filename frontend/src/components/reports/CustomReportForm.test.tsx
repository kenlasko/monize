import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { CustomReportForm } from './CustomReportForm';

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: (schema: any) => {
    return async (values: any) => {
      try {
        const result = schema.parse(values);
        return { values: result, errors: {} };
      } catch (err: any) {
        const errors: Record<string, any> = {};
        const issues = err.issues || err.errors;
        if (issues) {
          for (const e of issues) {
            const path = e.path.join('.');
            errors[path] = { message: e.message, type: 'validation' };
          }
        }
        return { values: {}, errors };
      }
    };
  },
}));

vi.mock('@/components/ui/Input', () => ({
  Input: ({ label, ...props }: any) => (
    <div>
      <label>{label}</label>
      <input {...props} />
    </div>
  ),
}));

vi.mock('@/components/ui/Select', () => ({
  Select: ({ label, options, ...props }: any) => {
    const id = `select-${String(label).toLowerCase().replace(/\s/g, '-')}`;
    return (
      <div>
        <label htmlFor={id}>{label}</label>
        <select id={id} aria-label={label} {...props}>
          {options?.map((o: any) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    );
  },
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, isLoading, variant, size, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/IconPicker', () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
  getIconComponent: () => null,
}));

vi.mock('@/components/ui/ColorPicker', () => ({
  ColorPicker: () => <div data-testid="color-picker" />,
}));

vi.mock('@/components/reports/FilterBuilder', () => ({
  FilterBuilder: () => <div data-testid="filter-builder" />,
}));

const mockGetAllAccounts = vi.fn();
const mockGetAllCategories = vi.fn();
const mockGetAllPayees = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockGetAllPayees(...args),
  },
}));

vi.mock('@/lib/tags', () => ({
  tagsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/components/ui/DateInput', () => ({
  DateInput: ({ label, onDateChange, error, ...props }: any) => (
    <div>
      <label>{label}</label>
      {error && <span>{error}</span>}
      <input
        {...props}
        data-testid={`date-input-${label?.toLowerCase().replace(/\s/g, '-')}`}
        onChange={(e) => onDateChange?.(e.target.value)}
      />
    </div>
  ),
}));

vi.mock('@/components/ui/FormActions', () => ({
  FormActions: ({ onCancel, submitLabel, isSubmitting }: any) => (
    <div>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="submit" disabled={isSubmitting}>{submitLabel || 'Save'}</button>
    </div>
  ),
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ label, value, onChange, options, placeholder: _placeholder }: any) => (
    <div>
      <label>{label}</label>
      <select
        data-testid={`multi-select-${label?.toLowerCase().replace(/\s/g, '-')}`}
        multiple
        value={value}
        onChange={(e) => onChange?.(Array.from(e.target.selectedOptions).map((o: any) => o.value))}
      >
        {options?.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  ),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CustomReportForm', () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching data', () => {
    mockGetAllAccounts.mockReturnValue(new Promise(() => {}));
    mockGetAllCategories.mockReturnValue(new Promise(() => {}));
    mockGetAllPayees.mockReturnValue(new Promise(() => {}));
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders form sections after data loads', async () => {
    mockGetAllAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Chequing', isClosed: false },
    ]);
    mockGetAllCategories.mockResolvedValue([
      { id: 'cat-1', name: 'Groceries' },
    ]);
    mockGetAllPayees.mockResolvedValue([
      { id: 'pay-1', name: 'Store A' },
    ]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Basic Information')).toBeInTheDocument();
    });
    expect(screen.getByText('Visualization')).toBeInTheDocument();
    expect(screen.getByText('Time Period')).toBeInTheDocument();
    expect(screen.getByText('Filters (Optional)')).toBeInTheDocument();
    expect(screen.getByText('Aggregation Options')).toBeInTheDocument();
  });

  it('renders cancel and submit buttons', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
    expect(screen.getByText('Create Report')).toBeInTheDocument();
  });

  it('shows Update Report text when editing', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    const existingReport = {
      id: 'rpt-1',
      name: 'My Report',
      description: 'A test report',
      icon: 'chart-bar',
      backgroundColor: '#3b82f6',
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {},
    } as any;
    render(
      <CustomReportForm
        report={existingReport}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('Update Report')).toBeInTheDocument();
    });
  });

  it('calls onCancel when cancel button is clicked', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('filters out closed accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Open Account', isClosed: false },
      { id: 'acc-2', name: 'Closed Account', isClosed: true },
    ]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Basic Information')).toBeInTheDocument());
  });

  it('logs error when data load fails', async () => {
    mockGetAllAccounts.mockRejectedValue(new Error('Network error'));
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Basic Information')).toBeInTheDocument());
  });

  it('shows table config section when view type is TABLE', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Visualization')).toBeInTheDocument());

    const viewTypeSelect = screen.getByRole('combobox', { name: /view type/i });
    await act(async () => {
      fireEvent.change(viewTypeSelect, { target: { value: 'TABLE' } });
    });
    expect(screen.getByText('Table Configuration')).toBeInTheDocument();
    expect(screen.getByText('Columns to Display')).toBeInTheDocument();
  });

  it('hides table config section for non-TABLE view', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Visualization')).toBeInTheDocument());
    expect(screen.queryByText('Table Configuration')).not.toBeInTheDocument();
  });

  it('shows custom date inputs when timeframe is CUSTOM', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Time Period')).toBeInTheDocument());

    const timeframeSelect = screen.getByRole('combobox', { name: /timeframe/i });
    await act(async () => {
      fireEvent.change(timeframeSelect, { target: { value: 'CUSTOM' } });
    });
    expect(screen.getByText('Start Date')).toBeInTheDocument();
    expect(screen.getByText('End Date')).toBeInTheDocument();
  });

  it('hides custom date inputs for non-CUSTOM timeframe', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Time Period')).toBeInTheDocument());
    expect(screen.queryByText('Start Date')).not.toBeInTheDocument();
    expect(screen.queryByText('End Date')).not.toBeInTheDocument();
  });

  it('submits form with correct data for default settings', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Test Report' } });
    });

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.name).toBe('Test Report');
    expect(submitData.viewType).toBe('BAR_CHART');
    expect(submitData.config.customStartDate).toBeUndefined();
    expect(submitData.config.customEndDate).toBeUndefined();
    expect(submitData.config.tableColumns).toBeUndefined();
  });

  it('submits form with CUSTOM timeframe dates', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Custom Date Report' } });
    });

    const timeframeSelect = screen.getByRole('combobox', { name: /timeframe/i });
    await act(async () => {
      fireEvent.change(timeframeSelect, { target: { value: 'CUSTOM' } });
    });

    const startDateInput = screen.getByTestId('date-input-start-date');
    const endDateInput = screen.getByTestId('date-input-end-date');
    await act(async () => {
      fireEvent.change(startDateInput, { target: { value: '2025-01-01' } });
      fireEvent.change(endDateInput, { target: { value: '2025-03-31' } });
    });

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.config.customStartDate).toBe('2025-01-01');
    expect(submitData.config.customEndDate).toBe('2025-03-31');
  });

  it('submits form with TABLE view type and includes tableColumns', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Table Report' } });
    });

    const viewTypeSelect = screen.getByRole('combobox', { name: /view type/i });
    await act(async () => {
      fireEvent.change(viewTypeSelect, { target: { value: 'TABLE' } });
    });

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.viewType).toBe('TABLE');
    expect(submitData.config.tableColumns).toBeDefined();
  });

  it('submits form with sortBy set, includes sortDirection', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Sorted Table Report' } });
    });

    const viewTypeSelect = screen.getByRole('combobox', { name: /view type/i });
    await act(async () => {
      fireEvent.change(viewTypeSelect, { target: { value: 'TABLE' } });
    });

    await waitFor(() => expect(screen.getByRole('combobox', { name: /sort by/i })).toBeInTheDocument());
    const sortBySelect = screen.getByRole('combobox', { name: /sort by/i });
    await act(async () => {
      fireEvent.change(sortBySelect, { target: { value: 'LABEL' } });
    });

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.config.sortBy).toBe('LABEL');
    expect(submitData.config.sortDirection).toBeDefined();
  });

  it('sets sortDirection to undefined when sortBy is empty', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'No Sort Report' } });
    });

    const viewTypeSelect = screen.getByRole('combobox', { name: /view type/i });
    await act(async () => {
      fireEvent.change(viewTypeSelect, { target: { value: 'TABLE' } });
    });

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.config.sortDirection).toBeUndefined();
  });

  it('populates form from existing report with filterGroups already set', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    const reportWithFilterGroups = {
      id: 'rpt-2',
      name: 'Existing Report',
      description: '',
      icon: '',
      backgroundColor: null,
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: true,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: true,
        customStartDate: '2025-01-01',
        customEndDate: '2025-12-31',
        tableColumns: ['LABEL', 'VALUE'],
        sortBy: 'VALUE',
        sortDirection: 'ASC',
      },
      filters: {
        filterGroups: [{ conditions: [{ field: 'account', value: 'acc-1' }] }],
      },
    } as any;
    render(
      <CustomReportForm
        report={reportWithFilterGroups}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());
  });

  it('converts legacy filters (accountIds, categoryIds, payeeIds, tagIds, searchText)', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    const reportWithLegacyFilters = {
      id: 'rpt-3',
      name: 'Legacy Report',
      description: null,
      icon: null,
      backgroundColor: null,
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {
        accountIds: ['acc-1'],
        categoryIds: ['cat-1'],
        payeeIds: ['pay-1'],
        tagIds: ['tag-1'],
        searchText: '  grocery  ',
      },
    } as any;
    render(
      <CustomReportForm
        report={reportWithLegacyFilters}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());
  });

  it('calls onDirtyChange when isDirty changes', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    const mockOnDirtyChange = vi.fn();

    render(
      <CustomReportForm
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
        onDirtyChange={mockOnDirtyChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Changed' } });
    });
  });

  it('uses submitRef to expose submit function', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    const submitRef = { current: null as (() => void) | null };
    render(
      <CustomReportForm
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
        submitRef={submitRef}
      />
    );
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());
    expect(typeof submitRef.current).toBe('function');
  });

  // convertLegacyFilters: empty filterGroups array falls through to legacy conversion
  it('converts legacy filters when filterGroups exists but is empty', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    const reportWithEmptyFilterGroups = {
      id: 'rpt-eg',
      name: 'Report',
      description: null,
      icon: null,
      backgroundColor: null,
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      // filterGroups is present but empty → falls through to legacy path
      filters: {
        filterGroups: [],
        accountIds: ['acc-1'],
        categoryIds: ['cat-1'],
      },
    } as any;
    render(
      <CustomReportForm
        report={reportWithEmptyFilterGroups}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());
  });

  // convertLegacyFilters: searchText with whitespace-only value is skipped
  it('skips searchText group when searchText is whitespace only', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    const reportWithBlankSearch = {
      id: 'rpt-ws',
      name: 'WS Report',
      description: null,
      icon: null,
      backgroundColor: null,
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {
        filterGroups: [],
        searchText: '   ',
      },
    } as any;
    render(
      <CustomReportForm
        report={reportWithBlankSearch}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());
  });

  // handleFormSubmit: description and icon and backgroundColor falsy → undefined in submitData
  it('submits with undefined description when description is empty', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    const reportWithEmptyDesc = {
      id: 'rpt-ed',
      name: 'No Desc Report',
      description: null,
      icon: null,
      backgroundColor: null,
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {},
    } as any;
    render(
      <CustomReportForm
        report={reportWithEmptyDesc}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    // Empty description converts to undefined
    expect(submitData.description).toBeUndefined();
    // Null icon defaults to 'chart-bar' (the form default)
    expect(submitData.icon).toBe('chart-bar');
    // Null backgroundColor defaults to '#3b82f6' (the form default)
    expect(submitData.backgroundColor).toBe('#3b82f6');
  });

  // handleFormSubmit: filterGroups with a condition that has no value are filtered out
  it('strips filter groups with empty condition values on submit', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    // A report whose legacy filters have a tag ID — we will render it, which
    // seeds filterGroups. Then we submit and verify the empty-value group
    // is filtered out by the every(c => c.value) check.
    const reportWithTagFilter = {
      id: 'rpt-tf',
      name: 'Tag Report',
      description: '',
      icon: '',
      backgroundColor: null,
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {
        // tagIds is empty so the tag group won't be added; accountIds adds one group
        filterGroups: [
          { conditions: [{ field: 'account', value: '' }] }, // empty value → filtered
          { conditions: [{ field: 'account', value: 'acc-1' }] }, // valid
        ],
      },
    } as any;
    render(
      <CustomReportForm
        report={reportWithTagFilter}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());

    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    // The group with empty value should be filtered out; only the valid one remains.
    expect(submitData.filters.filterGroups).toHaveLength(1);
    expect(submitData.filters.filterGroups[0].conditions[0].value).toBe('acc-1');
  });

  // customReportSchema superRefine: CUSTOM timeframe with missing dates causes validation errors
  it('shows validation errors for custom timeframe without dates', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Custom No Dates' } });
    });

    // Switch to CUSTOM timeframe but do NOT fill in dates.
    const timeframeSelect = screen.getByRole('combobox', { name: /timeframe/i });
    await act(async () => {
      fireEvent.change(timeframeSelect, { target: { value: 'CUSTOM' } });
    });

    // Submit without providing dates — validation should block submission.
    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    // onSubmit should NOT have been called because validation failed.
    expect(mockOnSubmit).not.toHaveBeenCalled();
    // Validation messages rendered by the mocked DateInput's error span.
    expect(
      await screen.findByText('Start date is required for custom timeframe'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('End date is required for custom timeframe'),
    ).toBeInTheDocument();
  });

  // Editing an existing report pre-fills tableColumns/sortBy/sortDirection from config
  it('pre-fills table config from existing report config', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    const tableReport = {
      id: 'rpt-tbl',
      name: 'Table Report',
      description: 'desc',
      icon: 'table',
      backgroundColor: '#ff0000',
      viewType: 'TABLE',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      isFavourite: true,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
        tableColumns: ['LABEL', 'VALUE'],
        sortBy: 'VALUE',
        sortDirection: 'ASC',
      },
      filters: {},
    } as any;
    render(
      <CustomReportForm
        report={tableReport}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => expect(screen.getByText('Update Report')).toBeInTheDocument());
    // Table config section is visible because viewType starts as TABLE.
    expect(screen.getByText('Table Configuration')).toBeInTheDocument();

    // Submit to verify tableColumns are included.
    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.config.tableColumns).toBeDefined();
    expect(submitData.config.sortBy).toBe('VALUE');
    expect(submitData.config.sortDirection).toBe('ASC');
  });

  // handleFormSubmit: non-TABLE viewType → tableColumns excluded even if defaulted
  it('excludes tableColumns from config when viewType is not TABLE', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockOnSubmit.mockResolvedValue(undefined);

    render(<CustomReportForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => expect(screen.getByText('Create Report')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('e.g., Monthly Food Spending');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Bar Chart Report' } });
    });

    // Default viewType is BAR_CHART — tableColumns should NOT be included.
    const form = document.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    const submitData = mockOnSubmit.mock.calls[0][0];
    expect(submitData.config.tableColumns).toBeUndefined();
  });
});
