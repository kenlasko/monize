import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { UpcomingBillsReport } from './UpcomingBillsReport';
import { formatDate } from '@/lib/utils';

// Capture the push mock so tests can assert on it
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      defaultCurrency: 'CAD',
    }),
  };
});
// Partial mock: the report's date parsing is pinned here, but `cn` and the
// rest of the module are the real ones -- the components in this tree use them.
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const mockGetAll = vi.fn();

/**
 * One occurrence per schedule, at its next due date, priced at its own amount.
 *
 * The report no longer expands a recurrence in the browser: the server sends
 * occurrences, each already carrying the amount THAT occurrence would post
 * (issue #1247). This default keeps the fixtures in the tests that are about
 * something else -- badges, navigation, payees -- to a single schedule list, and
 * a test that is about occurrences programs `mockGetOccurrences` itself.
 */
const occurrencesFrom = (schedules: any[]): any[] =>
  schedules
    .filter((s) => s.isActive !== false)
    .map((s) => ({
      scheduledTransactionId: s.id,
      originalDate: s.nextDueDate,
      dueDate: s.nextDueDate,
      amount:
        s.effectiveAmount !== undefined ? s.effectiveAmount : Number(s.amount),
      amountComplete:
        s.effectiveAmount !== undefined
          ? s.effectiveAmount !== null
          : true,
      currencyCode: s.currencyCode ?? 'CAD',
      overrideId: null,
      moved: false,
      accountId: s.accountId ?? 'acc-1',
      transferAccountId: s.transferAccountId ?? null,
      isTransfer: !!s.isTransfer,
    }));

/** One server occurrence, for a test that programs the endpoint itself. */
const makeOccurrence = (overrides: Record<string, unknown> = {}): any => ({
  scheduledTransactionId: 'st-1',
  originalDate: '2026-02-19',
  dueDate: '2026-02-19',
  amount: -100,
  amountComplete: true,
  currencyCode: 'CAD',
  overrideId: null,
  moved: false,
  accountId: 'acc-1',
  transferAccountId: null,
  isTransfer: false,
  ...overrides,
});

const defaultOccurrences = async () =>
  occurrencesFrom((await mockGetAll()) ?? []);

const mockGetOccurrences = vi.fn<(params?: unknown) => Promise<any[]>>(
  defaultOccurrences,
);

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getOccurrences: (...args: any[]) => mockGetOccurrences(...args),
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
/**
 * A rate table rather than an identity conversion.
 *
 * `convertToDefault` as `(n) => n` would make every currency behave like the
 * default, which is exactly the blindness this report had: it summed a CAD
 * occurrence beside a USD one as bare numbers. CAD is the default here, so the
 * existing single-currency fixtures convert 1:1 and only the mixed-currency
 * cases below can tell the difference. JPY deliberately has no rate.
 */
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number, from: string): number | null => {
      if (from === 'CAD') return amount;
      if (from === 'USD') return amount * 1.4;
      return null;
    },
  }),
}));

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
    // `clearAllMocks` clears calls, not implementations: a `mockResolvedValue`
    // from one test would otherwise answer every later one.
    mockGetOccurrences.mockReset();
    mockGetOccurrences.mockImplementation(defaultOccurrences);
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

  it('filters out inactive transactions but keeps transfers', async () => {
    mockGetAll.mockResolvedValue([
      makeTransaction({ id: 'st-1', name: 'Rent', isTransfer: false, isActive: true }),
      makeTransaction({ id: 'st-2', name: 'Transfer', isTransfer: true, isActive: true }),
      makeTransaction({ id: 'st-3', name: 'Inactive', isTransfer: false, isActive: false }),
    ]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Active Bills')).toBeInTheDocument();
    });
    // Rent and Transfer are active; Inactive is not.
    const activeBillsValue = screen.getByText('Active Bills').nextElementSibling;
    expect(activeBillsValue?.textContent).toBe('2');
    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();
  });

  // Issue #1124: a zero-amount transfer used as a payment reminder never
  // reached the calendar, because every transfer was filtered out.
  it('shows a zero-amount transfer on the calendar', async () => {
    mockGetAll.mockResolvedValue([
      makeTransaction({ id: 'st-9', name: 'Card Payment Reminder', amount: 0, isTransfer: true }),
    ]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Card Payment Reminder')).toBeInTheDocument();
    });
    expect(screen.getByText('Card Payment Reminder').closest('div')?.className).toContain('bg-blue-100');
  });

  it('shows a zero-amount reminder without painting it as a deposit', async () => {
    mockGetAll.mockResolvedValue([
      makeTransaction({ id: 'st-10', name: 'Water Bill', amount: 0, isTransfer: false }),
    ]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Water Bill')).toBeInTheDocument();
    });
    const chip = screen.getByText('Water Bill').closest('div');
    expect(chip?.className).not.toContain('bg-green-100');
    expect(chip?.className).toContain('bg-gray-100');
  });

  it('keeps transfer amounts out of the money totals', async () => {
    mockGetAll.mockResolvedValue([
      makeTransaction({ id: 'st-1', name: 'Rent', amount: -1500, nextDueDate: '2026-02-20' }),
      makeTransaction({ id: 'st-2', name: 'Card Payment', amount: -900, isTransfer: true, nextDueDate: '2026-02-20' }),
    ]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('This Month')).toBeInTheDocument();
    });
    // Both occurrences are counted, but only the bill's $1500 is summed.
    const card = screen.getByText('This Month').parentElement;
    expect(card?.textContent).toContain('2');
    expect(card?.textContent).toContain('1500');
    expect(card?.textContent).not.toContain('2400');
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

  /**
   * Recurrence expansion is the server's answer now
   * (`backend/src/common/scheduled-occurrences.spec.ts` proves the walk, the
   * window and the override date move). What matters here is that the report
   * draws exactly the occurrences it was given, and asks for the window it
   * claims to project.
   */
  describe('server-expanded occurrences', () => {
    it('asks for the three months it projects', async () => {
      mockGetAll.mockResolvedValue([makeTransaction()]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(mockGetOccurrences).toHaveBeenCalled());
      // Fixed clock: 2026-02-14, so three months out is 2026-05-14.
      expect(mockGetOccurrences).toHaveBeenCalledWith({ through: '2026-05-14' });
    });

    it('draws one row per occurrence the server sent', async () => {
      const st = makeTransaction({ nextDueDate: '2026-02-15', frequency: 'MONTHLY' });
      mockGetAll.mockResolvedValue([st]);
      mockGetOccurrences.mockResolvedValue([
        { ...occurrencesFrom([st])[0], dueDate: '2026-02-15', originalDate: '2026-02-15' },
        { ...occurrencesFrom([st])[0], dueDate: '2026-03-15', originalDate: '2026-03-15' },
        { ...occurrencesFrom([st])[0], dueDate: '2026-04-15', originalDate: '2026-04-15' },
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getAllByText('Rent')).toHaveLength(3);
      });
    });

    it('labels an estimated occurrence as one (issue #2096)', async () => {
      const st = makeTransaction({ nextDueDate: '2026-02-15', frequency: 'MONTHLY' });
      mockGetAll.mockResolvedValue([st]);
      mockGetOccurrences.mockResolvedValue([
        { ...occurrencesFrom([st])[0], estimated: true },
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByText('Estimated')).toBeInTheDocument();
      });
    });

    it('does not invent occurrences the server did not send', async () => {
      const st = makeTransaction({ nextDueDate: '2026-02-15', frequency: 'DAILY' });
      mockGetAll.mockResolvedValue([st]);
      mockGetOccurrences.mockResolvedValue([occurrencesFrom([st])[0]]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getAllByText('Rent')).toHaveLength(1);
      });
    });

    /**
     * The defect the audit of the first pass found: one schedule-level figure was
     * applied to every projected occurrence, so an occurrence the user had
     * re-priced was listed, totalled and exported at the template's amount.
     */
    it('prices each occurrence from its own override', async () => {
      const st = makeTransaction({
        nextDueDate: '2026-02-15',
        frequency: 'MONTHLY',
        amount: -1350,
        effectiveAmount: -1350,
      });
      mockGetAll.mockResolvedValue([st]);
      const base = occurrencesFrom([st])[0];
      mockGetOccurrences.mockResolvedValue([
        {
          ...base,
          dueDate: '2026-02-20',
          originalDate: '2026-02-15',
          amount: -675,
          overrideId: 'ovr-1',
          moved: true,
        },
        { ...base, dueDate: '2026-03-15', originalDate: '2026-03-15' },
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());
      fireEvent.click(screen.getByText('List'));

      // The list prints each occurrence's own amount; the schedule's 1350 belongs
      // only to the March occurrence that has no override.
      await waitFor(() => {
        expect(screen.getAllByText('$675').length).toBeGreaterThan(0);
      });
      expect(screen.getByText('$1350')).toBeInTheDocument();
      // The moved date, not the recurrence slot it replaced, in the reader's
      // own date format.
      expect(screen.getByText(formatDate('2026-02-20'))).toBeInTheDocument();
      expect(screen.queryByText(formatDate('2026-02-15'))).not.toBeInTheDocument();
      // February's total is the overridden 675, not the template's 1350.
      const thisMonthCard = screen.getByText('This Month').parentElement!;
      expect(thisMonthCard).toHaveTextContent('$675');
      expect(thisMonthCard).not.toHaveTextContent('$1350');
    });

    it('exports the overridden occurrence amount, not the schedule amount', async () => {
      const st = makeTransaction({
        nextDueDate: '2026-02-15',
        frequency: 'MONTHLY',
        amount: -1350,
        effectiveAmount: -1350,
      });
      mockGetAll.mockResolvedValue([st]);
      mockGetOccurrences.mockResolvedValue([
        {
          ...occurrencesFrom([st])[0],
          dueDate: '2026-02-20',
          originalDate: '2026-02-15',
          amount: -675,
          overrideId: 'ovr-1',
          moved: true,
        },
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));

      const rows = mockExportToCsv.mock.calls[0][2];
      expect(rows[0][1]).toBe('2026-02-20');
      expect(rows[0][2]).toBe(-675);

      await act(async () => {
        fireEvent.click(screen.getByTestId('export-pdf'));
      });
      const pdfRows = mockExportToPdf.mock.calls[0][0].tableData.rows;
      expect(pdfRows[0][2]).toBe(-675);
    });

    it('marks an unresolvable overridden occurrence unavailable and withholds the total', async () => {
      const st = makeTransaction({
        nextDueDate: '2026-02-15',
        frequency: 'MONTHLY',
        amount: -1350,
        effectiveAmount: -1350,
        autoPost: false,
      });
      mockGetAll.mockResolvedValue([st]);
      mockGetOccurrences.mockResolvedValue([
        {
          ...occurrencesFrom([st])[0],
          amount: null,
          amountComplete: false,
          overrideId: 'ovr-1',
        },
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByText('List')).toBeInTheDocument());

      // The card under "This Month" carries the marker, not a figure -- and
      // certainly not the schedule's own 1350.
      const thisMonthCard = screen.getByText('This Month').parentElement!;
      expect(thisMonthCard.textContent).not.toMatch(/\$\s?[\d,]/);
      expect(screen.queryByText('$1350')).not.toBeInTheDocument();
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

    /**
     * The cell under a named column of the first exported row.
     *
     * By name, not by index: these assertions were positional, so adding the
     * Currency column moved every one of them and three tests failed for a
     * reason that had nothing to do with what they were testing.
     */
    const exportedCell = (column: string): string | number => {
      const headers: string[] = mockExportToCsv.mock.calls[0][1];
      const rows: (string | number)[][] = mockExportToCsv.mock.calls[0][2];
      const index = headers.indexOf(column);
      expect(index).toBeGreaterThanOrEqual(0);
      return rows[0][index];
    };

    it('exports correct status for autoPost bill', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', autoPost: true, account: { name: 'Savings' } })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      expect(exportedCell('Status')).toBe('Auto');
      expect(exportedCell('Account')).toBe('Savings');
    });

    it('exports correct status for manual bill', async () => {
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19', autoPost: false, account: null })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      expect(exportedCell('Status')).toBe('Manual');
    });

    it('exports overdue bill with Overdue status', async () => {
      // Feb 10 is overdue (today is Feb 14)
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-10', frequency: 'ONCE', autoPost: true })]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      expect(exportedCell('Status')).toBe('Overdue');
    });

    it('exports the occurrence currency beside its amount', async () => {
      // A number with no currency is a number a spreadsheet will happily total
      // against a different one: the settlement currency is the other half of
      // what the amount means (issue #1247).
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19' })]);
      mockGetOccurrences.mockResolvedValue([
        makeOccurrence({ dueDate: '2026-02-19', amount: -1350, currencyCode: 'CAD' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('export-csv'));
      expect(exportedCell('Amount')).toBe(-1350);
      expect(exportedCell('Currency')).toBe('CAD');
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
        expect(screen.getByText('Try Again')).toBeInTheDocument();
      });
    });
  });

  // ---- Effective amounts (issue #1247) ----

  describe('effective amounts', () => {
    it("uses the server's effective amount in the list and the totals", async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({
          id: 'st-inv',
          name: 'Monthly ETF buy',
          frequency: 'ONCE',
          nextDueDate: '2026-02-19',
          // The security-currency cash impact, pinned at 1.50 when it was EUR.
          amount: -1000,
          isInvestment: true,
          // The security is USD now, and USD -> CAD resolves at 1.35.
          effectiveAmount: -1350,
          effectiveAmountComplete: true,
          effectiveCurrencyCode: 'CAD',
        }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('This Month')).toBeInTheDocument();
      });

      const thisMonthCard = screen.getByText('This Month').parentElement!;
      expect(thisMonthCard).toHaveTextContent('$1350');
      // Neither the pre-FX impact nor the stale 1.50 figure.
      expect(thisMonthCard).not.toHaveTextContent('$1000');
      expect(thisMonthCard).not.toHaveTextContent('$1500');
    });

    it('withholds a total containing an unresolvable occurrence', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({
          id: 'st-inv',
          name: 'Monthly ETF buy',
          frequency: 'ONCE',
          nextDueDate: '2026-02-19',
          amount: -1000,
          isInvestment: true,
          effectiveAmount: null,
          effectiveAmountComplete: false,
          effectiveCurrencyCode: 'CAD',
        }),
        makeTransaction({
          id: 'st-rent',
          name: 'Rent',
          frequency: 'ONCE',
          nextDueDate: '2026-02-20',
          amount: -1500,
          effectiveAmount: -1500,
          effectiveAmountComplete: true,
        }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('This Month')).toBeInTheDocument();
      });

      const thisMonthCard = screen.getByText('This Month').parentElement!;
      // Not the known part on its own under a total's caption, and not the
      // stale figure either.
      expect(thisMonthCard).not.toHaveTextContent('$1500');
      expect(thisMonthCard).not.toHaveTextContent('$2500');
      expect(thisMonthCard).not.toHaveTextContent('$3000');
      expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
    });

    it('degrades instead of failing when the occurrences endpoint is unavailable', async () => {
      // The endpoint is newer than the page, so during a rolling deploy the new
      // client can be served while a pod still runs the previous backend. A
      // rejected leg inside `Promise.all` took the whole report down.
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19' })]);
      mockGetOccurrences.mockRejectedValue(new Error('404 Not Found'));
      render(<UpcomingBillsReport />);

      await waitFor(() => {
        expect(screen.getByTestId('occurrences-unavailable')).toBeInTheDocument();
      });
      // The page is up: the schedule count still renders from the other leg.
      expect(screen.getByText('Active Bills')).toBeInTheDocument();
      // And the money is unknown, not a measured zero for a state nobody measured.
      const thisMonthCard = screen.getByText('This Month').parentElement!;
      expect(thisMonthCard).not.toHaveTextContent('$0');
      expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
    });

    it('keeps rendering a genuinely empty projection as empty', async () => {
      // `[]` is a real answer -- "nothing scheduled in the window" -- and must not
      // be shown as unavailable.
      mockGetAll.mockResolvedValue([makeTransaction({ nextDueDate: '2026-02-19' })]);
      mockGetOccurrences.mockResolvedValue([]);
      render(<UpcomingBillsReport />);

      await waitFor(() => {
        expect(screen.getByText('This Month')).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('occurrences-unavailable'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('This Month').parentElement!).toHaveTextContent(
        '$0',
      );
    });

    it('converts each occurrence before totalling, instead of adding currencies', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ id: 'st-usd', name: 'US subscription', frequency: 'ONCE', nextDueDate: '2026-02-19' }),
        makeTransaction({ id: 'st-cad', name: 'Rent', frequency: 'ONCE', nextDueDate: '2026-02-20' }),
      ]);
      mockGetOccurrences.mockResolvedValue([
        makeOccurrence({ scheduledTransactionId: 'st-usd', dueDate: '2026-02-19', amount: -500, currencyCode: 'USD' }),
        makeOccurrence({ scheduledTransactionId: 'st-cad', dueDate: '2026-02-20', amount: -1000, currencyCode: 'CAD' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('This Month')).toBeInTheDocument();
      });

      // 500 USD at 1.4 is 700 CAD, beside 1,000 CAD: 1,700 CAD.
      const thisMonthCard = screen.getByText('This Month').parentElement!;
      expect(thisMonthCard).toHaveTextContent('$1700');
      // What adding the two figures as bare numbers gave -- 12% light, printed
      // in the reader's own currency (issue #1247).
      expect(thisMonthCard).not.toHaveTextContent('$1500');
    });

    it('withholds a total it cannot convert, and says the rate is the reason', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({ id: 'st-jpy', name: 'Tokyo rent', frequency: 'ONCE', nextDueDate: '2026-02-19' }),
        makeTransaction({ id: 'st-cad', name: 'Rent', frequency: 'ONCE', nextDueDate: '2026-02-20' }),
      ]);
      mockGetOccurrences.mockResolvedValue([
        makeOccurrence({ scheduledTransactionId: 'st-jpy', dueDate: '2026-02-19', amount: -90000, currencyCode: 'JPY' }),
        makeOccurrence({ scheduledTransactionId: 'st-cad', dueDate: '2026-02-20', amount: -1000, currencyCode: 'CAD' }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByText('This Month')).toBeInTheDocument();
      });

      const thisMonthCard = screen.getByText('This Month').parentElement!;
      // Neither the convertible part under the total's caption nor the two
      // amounts added as numbers.
      expect(thisMonthCard).not.toHaveTextContent('$1000');
      expect(thisMonthCard).not.toHaveTextContent('$91000');
      expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
      // The row itself still shows its own amount in its own currency: what is
      // missing is the display rate, not the occurrence's amount.
      expect(screen.getByText('Tokyo rent')).toBeInTheDocument();
    });

    it('exports an explicit marker rather than a stale or empty amount', async () => {
      mockGetAll.mockResolvedValue([
        makeTransaction({
          id: 'st-inv',
          name: 'Monthly ETF buy',
          frequency: 'ONCE',
          nextDueDate: '2026-02-19',
          amount: -1000,
          isInvestment: true,
          effectiveAmount: null,
          effectiveAmountComplete: false,
          effectiveCurrencyCode: 'CAD',
        }),
      ]);
      render(<UpcomingBillsReport />);
      await waitFor(() => {
        expect(screen.getByTestId('export-csv')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('export-csv'));
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      // The amount column carries the marker, not -1000 and not an empty cell a
      // spreadsheet would total as zero.
      expect(rows[0][2]).toBe('Not available (no current exchange rate)');
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
