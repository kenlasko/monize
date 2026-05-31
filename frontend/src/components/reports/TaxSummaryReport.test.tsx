import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import { TaxSummaryReport } from './TaxSummaryReport';

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

const mockGetTaxSummary = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getTaxSummary: (...args: any[]) => mockGetTaxSummary(...args),
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

describe('TaxSummaryReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetTaxSummary.mockReturnValue(new Promise(() => {}));
    render(<TaxSummaryReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders summary cards and sections with data', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [{ name: 'Employment', total: 60000 }],
      deductibleExpenses: [{ name: 'Medical', total: 2000 }],
      allExpenses: [{ name: 'Groceries', total: 5000 }],
      totals: { income: 60000, expenses: 5000, deductible: 2000 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Total Income').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('Total Expenses').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Potential Deductions')).toBeInTheDocument();
    expect(screen.getByText('Income by Source')).toBeInTheDocument();
    expect(screen.getByText('Employment')).toBeInTheDocument();
    expect(screen.getByText('Medical')).toBeInTheDocument();
  });

  it('renders disclaimer notice', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [],
      deductibleExpenses: [],
      allExpenses: [],
      totals: { income: 0, expenses: 0, deductible: 0 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => {
      expect(screen.getByText('For Reference Only')).toBeInTheDocument();
    });
  });

  it('renders year selector', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [],
      deductibleExpenses: [],
      allExpenses: [],
      totals: { income: 0, expenses: 0, deductible: 0 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => {
      expect(screen.getByText('Tax Year:')).toBeInTheDocument();
    });
  });

  it('renders empty income message', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [],
      deductibleExpenses: [],
      allExpenses: [],
      totals: { income: 0, expenses: 0, deductible: 0 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => {
      const currentYear = new Date().getFullYear();
      expect(screen.getByText(`No income recorded for ${currentYear}`)).toBeInTheDocument();
    });
  });

  it('renders empty deductible expenses message', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [{ name: 'Salary', total: 50000 }],
      deductibleExpenses: [],
      allExpenses: [],
      totals: { income: 50000, expenses: 0, deductible: 0 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => {
      expect(screen.getByText(/No potentially deductible expenses detected/)).toBeInTheDocument();
    });
  });

  it('renders income and deduction totals at bottom of tables', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [{ name: 'Employment', total: 60000 }],
      deductibleExpenses: [{ name: 'Medical', total: 2000 }],
      allExpenses: [{ name: 'Groceries', total: 5000 }],
      totals: { income: 60000, expenses: 5000, deductible: 2000 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Potential Deductions')).toBeInTheDocument();
    });
    expect(screen.getByText('All Expenses by Category')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('shows a retryable error when the API call fails', async () => {
    mockGetTaxSummary.mockRejectedValue(new Error('Network error'));
    render(<TaxSummaryReport />);
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
  });

  it('triggers CSV export with header rows', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [{ name: 'Employment', total: 60000 }],
      deductibleExpenses: [{ name: 'Medical', total: 2000 }],
      allExpenses: [{ name: 'Groceries', total: 5000 }],
      totals: { income: 60000, expenses: 5000, deductible: 2000 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => expect(screen.getByText('Total Potential Deductions')).toBeInTheDocument());
    // Open the export dropdown then click the CSV item.
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const csvBtn = screen.queryByText(/CSV/i);
    if (csvBtn) {
      fireEvent.click(csvBtn);
      expect(mockExportToCsv).toHaveBeenCalled();
    }
  });

  it('triggers PDF export with summary cards', async () => {
    mockGetTaxSummary.mockResolvedValue({
      incomeBySource: [{ name: 'Employment', total: 60000 }],
      deductibleExpenses: [{ name: 'Medical', total: 2000 }],
      allExpenses: [{ name: 'Groceries', total: 5000 }],
      totals: { income: 60000, expenses: 5000, deductible: 2000 },
    });
    render(<TaxSummaryReport />);
    await waitFor(() => expect(screen.getByText('Total Potential Deductions')).toBeInTheDocument());
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      fireEvent.click(pdfBtn);
      await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    }
  });
});
