import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { CustomReportForm } from './CustomReportForm';

vi.mock('@/lib/zodResolver', () => ({
  zodResolver: (schema: any) => {
    return async (values: any) => {
      try {
        const result = schema.parse(values);
        return { values: result, errors: {} };
      } catch (err: any) {
        const errors: Record<string, any> = {};
        if (err.errors) {
          for (const e of err.errors) {
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
  Select: ({ label, options, ...props }: any) => (
    <div>
      <label>{label}</label>
      <select {...props}>
        {options?.map((o: any) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/IconPicker', () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
  getIconComponent: () => null,
}));

vi.mock('@/components/ui/ColorPicker', () => ({
  ColorPicker: () => <div data-testid="color-picker" />,
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: () => <div data-testid="multi-select" />,
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
});
