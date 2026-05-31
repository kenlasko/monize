import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { UpcomingBillsReport } from './UpcomingBillsReport';

// Capture the push mock so tests can assert on it
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const mockGetAll = vi.fn();

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
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

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf, disabled }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-csv" onClick={onExportCsv} disabled={disabled}>CSV</button>
      <button data-testid="export-pdf" onClick={onExportPdf} disabled={disabled}>PDF</button>
    </div>
  ),
}));

// Fixed date: Feb 14, 2026
const now = new Date('2026-02-14T12:00:00');

const makeTransaction = (overrides: Record<string, any> = {}) => ({
  id: 'st-1',
  name: 'Rent',
  amount: -1500,
  frequency: 'MONTHLY',
  nextDueDate: '2026-02-15',
  isActive: true,
  isTransfer: false,
  autoPost: true,
  payee: { name: 'Landlord' },
  payeeName: 'Landlord',
  account: { name: 'Chequing' },
  ...overrides,
});

describe('UpcomingBillsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockReset();
    vi.useFakeTimers({ now, shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows loading state initially', () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<UpcomingBillsReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no scheduled transactions', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText(/No scheduled bills found/)).toBeInTheDocument();
    });
  });

  it('filters out transfers and inactive transactions', async () => {
    mockGetAll.mockResolvedValue([
      makeTransaction({ id: 'st-1', name: 'Rent', isTransfer: false, isActive: true }),
      makeTransaction({ id: 'st-2', name: 'Transfer', isTransfer: true, isActive: true }),
      makeTransaction({ id: 'st-3', name: 'Inactive', isTransfer: false, isActive: false }),
    ]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Active Bills')).toBeInTheDocument();
    });
    // Only Rent should appear as active bill count (1)
    const activeBillsValue = screen.getByText('Active Bills').nextElementSibling;
    expect(activeBillsValue?.textContent).toBe('1');
  });

  it('renders summary cards and view controls with data', async () => {
    const futureDateStr = '2026-02-19';
    mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: futureDateStr })]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Active Bills')).toBeInTheDocument();
    });
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('List')).toBeInTheDocument();
  });

  it('renders month navigation', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
  });

  describe('Month Navigation', () => {
    it('shows current month on load', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('February 2026')).toBeInTheDocument();
      });
    });

    it('navigates to previous month', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('February 2026')).toBeInTheDocument());

      // Find the left-arrow button (previous month)
      const monthHeading = screen.getByText('February 2026');
      const container = monthHeading.parentElement!;
      const buttons = container.querySelectorAll('button');
      fireEvent.click(buttons[0]);

      expect(screen.getByText('January 2026')).toBeInTheDocument();
    });

    it('navigates to next month', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('February 2026')).toBeInTheDocument());

      const monthHeading = screen.getByText('February 2026');
      const container = monthHeading.parentElement!;
      const buttons = container.querySelectorAll('button');
      fireEvent.click(buttons[1]);

      expect(screen.getByText('March 2026')).toBeInTheDocument();
    });

    it('navigates back to current month when Today is clicked', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('February 2026')).toBeInTheDocument());

      const monthHeading = screen.getByText('February 2026');
      const container = monthHeading.parentElement!;
      const buttons = container.querySelectorAll('button');
      fireEvent.click(buttons[1]); // next month
      expect(screen.getByText('March 2026')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Today'));
      expect(screen.getByText('February 2026')).toBeInTheDocument();
    });
  });

  describe('View Toggle', () => {
    it('shows calendar view by default', async () => {
      mockGetAll.mockResolvedValue([makeTransaction()]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('Calendar')).toBeInTheDocument());
      // Calendar days header should be visible
      expect(screen.getByText('Sun')).toBeInTheDocument();
    });

    it('switches to list view', async () => {
      // Use ONCE frequency so only one occurrence appears
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      // In list view the bill name should appear in a row
      await waitFor(() => {
        expect(screen.getAllByText('Rent').length).toBeGreaterThan(0);
      });
    });

    it('switches back to calendar view from list', async () => {
      mockGetAll.mockResolvedValue([makeTransaction()]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('Sun')).toBeInTheDocument();
    });
  });

  describe('Overdue Bills', () => {
    it('shows overdue summary card when there are overdue bills', async () => {
      // Feb 10 is in the past (today is Feb 14)
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-10' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('Overdue')).toBeInTheDocument();
      });
    });

    it('does not show overdue card when no bills are overdue', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('Active Bills')).toBeInTheDocument());
      expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    });

    it('shows overdue badge in list view', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-10' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        // The badge inside the list row
        const badges = screen.getAllByText('Overdue');
        // At least one badge (could also be in summary)
        expect(badges.length).toBeGreaterThan(0);
      });
    });

    it('shows overdue total amount', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-10', amount: -200 })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('Overdue')).toBeInTheDocument();
        // formatCurrencyCompact(-200) -> "$200"
        expect(screen.getByText('$200')).toBeInTheDocument();
      });
    });
  });

  describe('List View Details', () => {
    it('shows Auto badge for autoPost bills', async () => {
      // Use ONCE frequency to ensure single occurrence
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE', autoPost: true })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByText('Auto')).toBeInTheDocument();
      });
    });

    it('shows Manual badge for non-autoPost bills', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE', autoPost: false })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByText('Manual')).toBeInTheDocument();
      });
    });

    it('shows payee name in list view', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE', payee: { name: 'Hydro One' }, payeeName: 'Hydro One' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByText('Hydro One')).toBeInTheDocument();
      });
    });

    it('shows "No payee" when payee is missing', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE', payee: undefined, payeeName: undefined }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByText('No payee')).toBeInTheDocument();
      });
    });

    it('uses payeeName fallback when payee object is absent', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE', payee: null, payeeName: 'Fallback Name' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByText('Fallback Name')).toBeInTheDocument();
      });
    });

    it('shows positive amount formatted for income', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ id: 'st-2', name: 'Salary', amount: 3000, nextDueDate: '2026-02-19', frequency: 'ONCE' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        const amounts = screen.getAllByText('$3000');
        expect(amounts.length).toBeGreaterThan(0);
      });
    });

    it('navigates to /bills when clicking a bill row', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => expect(screen.getAllByText('Rent').length).toBeGreaterThan(0));
      fireEvent.click(screen.getAllByText('Rent')[0]);
      expect(mockPush).toHaveBeenCalledWith('/bills');
    });
  });

  describe('Calendar View Details', () => {
    it('shows bill name on the due date in calendar', async () => {
      // Rent due Feb 15 should appear in calendar
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-15', amount: -1500 })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('Sun')).toBeInTheDocument();
        expect(screen.getByText('Rent')).toBeInTheDocument();
      });
    });

    it('shows manual indicator icon for non-autoPost bills in calendar', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-15', autoPost: false })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        // The title attribute contains the auto/manual info
        const billEl = screen.getByTitle('Rent (Manual)');
        expect(billEl).toBeInTheDocument();
      });
    });

    it('shows auto title for autoPost bills in calendar', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-15', autoPost: true })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        const billEl = screen.getByTitle('Rent (Auto)');
        expect(billEl).toBeInTheDocument();
      });
    });

    it('shows +N more when day has more than 3 bills', async () => {
      const sameDayDate = '2026-02-15';
      const bills = [
        makeTransaction({ id: 'st-1', name: 'Bill 1', nextDueDate: sameDayDate, frequency: 'ONCE' }),
        makeTransaction({ id: 'st-2', name: 'Bill 2', nextDueDate: sameDayDate, frequency: 'ONCE' }),
        makeTransaction({ id: 'st-3', name: 'Bill 3', nextDueDate: sameDayDate, frequency: 'ONCE' }),
        makeTransaction({ id: 'st-4', name: 'Bill 4', nextDueDate: sameDayDate, frequency: 'ONCE' }),
      ];
      mockGetAll.mockResolvedValue(bills);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('+1 more')).toBeInTheDocument();
      });
    });

    it('navigates to /bills when clicking a bill in calendar', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-15', frequency: 'ONCE' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      expect(mockPush).toHaveBeenCalledWith('/bills');
    });
  });

  describe('Frequency Types', () => {
    const testFrequency = async (frequency: string, expectedCount: number) => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ nextDueDate: '2026-02-15', frequency }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        // At least the expected count of Rent entries appears in list view
        const rents = screen.getAllByText('Rent');
        expect(rents.length).toBeGreaterThanOrEqual(expectedCount);
      });
    };

    it('handles ONCE frequency (single occurrence)', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ nextDueDate: '2026-02-15', frequency: 'ONCE' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        const rents = screen.getAllByText('Rent');
        expect(rents.length).toBe(1);
      });
    });

    it('handles DAILY frequency (multiple occurrences)', async () => {
      await testFrequency('DAILY', 2);
    });

    it('handles WEEKLY frequency', async () => {
      await testFrequency('WEEKLY', 2);
    });

    it('handles BIWEEKLY frequency', async () => {
      await testFrequency('BIWEEKLY', 2);
    });

    it('handles EVERY4WEEKS frequency', async () => {
      await testFrequency('EVERY4WEEKS', 1);
    });

    it('handles QUARTERLY frequency', async () => {
      await testFrequency('QUARTERLY', 1);
    });

    it('handles YEARLY frequency', async () => {
      await testFrequency('YEARLY', 1);
    });
  });

  describe('Export', () => {
    it('calls exportToCsv when CSV button is clicked', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      expect(mockExportToCsv).toHaveBeenCalledWith(
        'upcoming-bills',
        expect.arrayContaining(['Bill Name', 'Due Date', 'Amount', 'Frequency', 'Account', 'Status']),
        expect.any(Array),
      );
    });

    it('calls exportToPdf when PDF button is clicked', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-pdf'));
      });
      await waitFor(() => {
        expect(mockExportToPdf).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Upcoming Bills Report', filename: 'upcoming-bills' }),
        );
      });
    });

    it('exports correct status for autoPost bill', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', autoPost: true, account: { name: 'Savings' } })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      const rows: (string | number)[][] = mockExportToCsv.mock.calls[0][2];
      // Status column (index 5) should be 'Auto'
      expect(rows[0][5]).toBe('Auto');
      // Account column (index 4) should be 'Savings'
      expect(rows[0][4]).toBe('Savings');
    });

    it('exports correct status for manual bill', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', autoPost: false, account: null })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      const rows: (string | number)[][] = mockExportToCsv.mock.calls[0][2];
      expect(rows[0][5]).toBe('Manual');
    });

    it('exports overdue bill with Overdue status', async () => {
      // Feb 10 is overdue (today is Feb 14)
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-10', frequency: 'ONCE', autoPost: true })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      const rows: (string | number)[][] = mockExportToCsv.mock.calls[0][2];
      expect(rows[0][5]).toBe('Overdue');
    });

    it('export dropdown is disabled when no bills', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      expect(screen.getByTestId('export-csv')).toBeDisabled();
      expect(screen.getByTestId('export-pdf')).toBeDisabled();
    });

    it('includes overdue count card in PDF export when overdue bills exist', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-10', frequency: 'ONCE' })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-pdf'));
      });
      await waitFor(() => {
        const call = mockExportToPdf.mock.calls[0][0];
        const overdueCard = call.summaryCards.find((c: any) => c.label === 'Overdue');
        expect(overdueCard).toBeDefined();
        expect(overdueCard.color).toBe('#dc2626');
      });
    });
  });

  describe('Error Handling', () => {
    it('shows a retryable error when the API call fails', async () => {
      mockGetAll.mockRejectedValue(new Error('Network error'));
      render(<UpcomingBillsReport />);
      // Should not throw; should render the shared error panel instead of an empty report.
      await waitFor(() => {
        expect(screen.getByText('Try again')).toBeInTheDocument();
      });
    });
  });

  describe('This Month Summary', () => {
    it('shows this month count and total', async () => {
      // Feb 19 is this month (Feb 2026), not overdue
      mockGetAll.mockResolvedValue([
        makeTransaction({ nextDueDate: '2026-02-19', frequency: 'ONCE', amount: -300 }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('This Month')).toBeInTheDocument();
        // formatCurrencyCompact(300) -> "$300"
        const thisMonthCard = screen.getByText('This Month').parentElement!;
        expect(thisMonthCard).toHaveTextContent('$300');
      });
    });
  });
});
