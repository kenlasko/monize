import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { UpcomingBills } from './UpcomingBills';
import dashboardMessages from '@/i18n/messages/en/dashboard.json';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
    }),
  };
});
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));
// Cross-device widget settings; each test sets the scope/view it needs.
const { widgetConfig, mockUpdateConfig } = vi.hoisted(() => ({
  widgetConfig: {
    current: {
      scope: 'dueSoon' as 'dueSoon' | 'all',
      view: 'list' as 'list' | 'calendar',
    },
  },
  mockUpdateConfig: vi.fn(),
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: widgetConfig.current, updateConfig: mockUpdateConfig }),
}));

function futureDateStr(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr(): string {
  return futureDateStr(0);
}

const defaultMaxItems = 20;

/**
 * The warning's tooltip, read from the catalog the widget renders from rather
 * than retyped here: the assertion this replaced queried a title string that no
 * locale contains, so it could never have found the warning it claimed to rule
 * out.
 */
const BELOW_ZERO_TITLE = dashboardMessages.upcomingBills.negativeBalanceWarning;

describe('UpcomingBills', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUpdateConfig.mockClear();
    widgetConfig.current = { scope: 'dueSoon', view: 'list' };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={true} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Upcoming Bills & Deposits')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no upcoming items', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('No overdue or upcoming bills, deposits, or transfers within their reminder windows.')).toBeInTheDocument();
  });

  it('renders upcoming bill with Tomorrow label', () => {
    const transactions = [
      {
        id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
        nextDueDate: futureDateStr(1), isActive: true, autoPost: false,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Bill')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('labels an estimated amount as one (issue #2096)', () => {
    const transactions = [
      {
        id: '1', name: 'Heating', amount: -999, currencyCode: 'CAD',
        effectiveAmount: -180, effectiveAmountComplete: true,
        nextDueDate: futureDateStr(1), isActive: true, autoPost: false,
        amountIsEstimated: true, nextOverride: null,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Estimated')).toBeInTheDocument();
  });

  it('renders Today label for bills due today', () => {
    const transactions = [
      {
        id: '1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
        nextDueDate: todayStr(), isActive: true, autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });

  it('renders days-away label for upcoming bills', () => {
    const transactions = [
      {
        id: '1', name: 'Insurance', amount: -200, currencyCode: 'CAD',
        nextDueDate: futureDateStr(5), isActive: true, autoPost: true,
        reminderDaysBefore: 7,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('5 days')).toBeInTheDocument();
  });

  // The widget lists occurrences and nothing else: the summed "Total due" row
  // went in #1264 and "Total incoming" followed it, so no row here stands for
  // more than the one occurrence printed beside it.
  it('shows no summary rows for bills, deposits or unknown occurrences', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '3', name: 'Payroll', amount: 3000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '4', name: 'Dividend', amount: 250, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // The per-item amounts stay; every summary line goes.
    expect(screen.getByText('-$15.99')).toBeInTheDocument();
    expect(screen.getByText('+$3000.00')).toBeInTheDocument();
    expect(screen.queryByText(/Total/i)).not.toBeInTheDocument();
    // Neither summed bucket is drawn, in whole or in part.
    expect(screen.queryByText('-$25.98')).not.toBeInTheDocument();
    expect(screen.queryByText('+$3250.00')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
  });

  it('renders an occurrence of unknown direction as unknown, with no total beside it', () => {
    // A mixed-sign split whose investment line cannot be priced could be a bill
    // or a deposit, so the row says so rather than being painted red or green
    // (issue #1247 re-audit). With the totals gone there is no bucket left for
    // it to be silently excluded from either.
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Payroll', amount: 3000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      {
        id: '3', name: 'Sell shares, pay the fee', amount: 10, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true, isSplit: true,
        effectiveAmount: null, effectiveAmountComplete: false,
        effectiveDirectionAmount: null,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    expect(screen.queryByText(/Total/i)).not.toBeInTheDocument();
  });

  it('shows a Deposit badge for incoming schedules', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Deposit')).toBeInTheDocument();
  });

  it('shows Transfer badge for transfer transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Savings Transfer', amount: -500, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  // Issue #1124: a schedule left at 0 because the amount is not known yet was
  // badged "Deposit" and printed as a green "+$0.00".
  it('badges a zero-amount schedule as a reminder, not a deposit', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Card Payment', amount: 0, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false, isTransfer: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Reminder')).toBeInTheDocument();
    expect(screen.queryByText('Deposit')).not.toBeInTheDocument();
    // No sign, and not painted as money arriving.
    const amount = screen.getByText('$0.00');
    expect(amount.className).toContain('text-gray-500');
  });

  it('keeps a zero-amount transfer badged as a transfer', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Card Payment', amount: 0, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false, isTransfer: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('filters out inactive scheduled transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Active Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Inactive Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: false, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Active Bill')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Bill')).not.toBeInTheDocument();
  });

  it('filters out transactions beyond their reminder window', () => {
    const transactions = [
      { id: '1', name: 'Far Future Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(10), isActive: true, autoPost: true, reminderDaysBefore: 3 },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('No overdue or upcoming bills, deposits, or transfers within their reminder windows.')).toBeInTheDocument();
  });

  it('shows a schedule beyond its reminder window under All upcoming', () => {
    // The reminder window says when to be nudged, not what exists. Under All
    // upcoming, a bill six months out is still a bill six months out.
    widgetConfig.current = { scope: 'all', view: 'list' };
    const transactions = [
      { id: '1', name: 'Far Future Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(180), isActive: true, autoPost: true, reminderDaysBefore: 3 },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Far Future Bill')).toBeInTheDocument();
  });

  it('still leaves an inactive schedule out under All upcoming', () => {
    widgetConfig.current = { scope: 'all', view: 'list' };
    const transactions = [
      { id: '1', name: 'Cancelled Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(5), isActive: false, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(
      screen.getByText('No active bills, deposits, or transfers scheduled.'),
    ).toBeInTheDocument();
  });

  it('switches the scope and the view through the header controls', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByRole('button', { name: 'All upcoming' }));
    expect(mockUpdateConfig).toHaveBeenCalledWith({ scope: 'all' });
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(mockUpdateConfig).toHaveBeenCalledWith({ view: 'calendar' });
  });

  it('keeps the scope buttons and an icon-only view switch on one row', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);

    // Icons rather than words: the labels survive as the accessible name and
    // the tooltip, which is what lets the view switch sit beside the scope
    // buttons instead of wrapping onto a line of its own.
    const listButton = screen.getByRole('button', { name: 'List' });
    expect(listButton).toHaveTextContent('');
    expect(listButton).toHaveAttribute('title', 'List');
    expect(listButton.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Calendar' })).toHaveAttribute('title', 'Calendar');

    const row = listButton.closest('[role="group"]')!.parentElement!;
    expect(row).toContainElement(screen.getByRole('button', { name: 'All upcoming' }));
    expect(row.className).not.toContain('flex-wrap');
    // On a phone the row owns the header's line and holds its ends apart, so
    // the scope pair stays against the left edge and the view switch sits
    // against the right; from `sm` up the two groups pack together again.
    expect(row.className).toContain('w-full');
    expect(row.className).toContain('justify-between');
    expect(row.className).toContain('sm:w-auto');
    expect(row.className).toContain('sm:justify-start');
  });

  it('lays the same occurrences out on a month grid in the calendar view', () => {
    // The grid shows the current month only, so the due date must not fall
    // past its end: pin mid-month (an unpinned run on the 30th put "today + 2"
    // in the next month and found no chip).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 10, 12));
    widgetConfig.current = { scope: 'all', view: 'calendar' };
    const dueDate = futureDateStr(2);
    const transactions = [
      { id: 'st-1', name: 'Rent', amount: -1200, currencyCode: 'CAD', nextDueDate: dueDate, frequency: 'MONTHLY', isActive: true, autoPost: false, futureOverrides: [] },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // The grid opens on the current month. Two days ahead crosses into the
    // next one at a month's end, where this used to fail on the 30th and 31st;
    // the chip is then on the next page of the grid.
    if (dueDate.slice(0, 7) !== todayStr().slice(0, 7)) {
      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    }

    // The chip carries the schedule and posts it, the same as a list row.
    const chip = screen.getAllByRole('button', { name: 'Rent' })[0];
    fireEvent.click(chip);
    expect(mockPush).toHaveBeenCalledWith('/bills?postBillId=st-1');
  });

  it('links the title to the bills page', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    expect(
      screen.getByRole('link', { name: 'Upcoming Bills & Deposits' }),
    ).toHaveAttribute('href', '/bills');
  });

  it('navigates to bills page with postBillId when a bill row is clicked', () => {
    const transactions = [
      { id: 'bill-42', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByText('Netflix'));
    expect(mockPush).toHaveBeenCalledWith('/bills?postBillId=bill-42');
  });

  it('navigates with postBillId when Enter is pressed on a focused bill row', () => {
    const transactions = [
      { id: 'bill-7', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const row = screen.getByRole('button', { name: /Spotify/i });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockPush).toHaveBeenCalledWith('/bills?postBillId=bill-7');
  });

  it('highlights the row edge on hover, matching the Top Movers widget', () => {
    const transactions = [
      { id: 'bill-9', name: 'Hydro', amount: -60, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const row = screen.getByRole('button', { name: /Hydro/i });
    expect(row.className).toContain('hover:border-blue-400');
    expect(row.className).toContain('dark:hover:border-blue-500');
  });

  it('shows payee name when available', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Phone Bill', amount: -80, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        payeeName: 'AT&T',
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('AT&T')).toBeInTheDocument();
  });

  it('does not show Manual badge when autoPost is true', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
  });

  it('shows bill amount with negative sign and red color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // The item row is the only place the amount appears -- no total section.
    const amountEl = screen.getByText('-$15.99');
    expect(amountEl.className).toContain('text-red');
  });

  it('shows deposit amount with plus sign and green color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // The item row is the only place the amount appears -- no total section.
    const amountEl = screen.getByText('+$5000.00');
    expect(amountEl.className).toContain('text-green');
  });

  it('sorts items by due date ascending', () => {
    const transactions = [
      { id: '1', name: 'Later Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(3), isActive: true, autoPost: true },
      { id: '2', name: 'Sooner Bill', amount: -30, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const items = screen.getAllByText(/Bill/);
    // The sooner bill should appear before the later one
    const soonerIdx = items.findIndex(el => el.textContent === 'Sooner Bill');
    const laterIdx = items.findIndex(el => el.textContent === 'Later Bill');
    expect(soonerIdx).toBeLessThan(laterIdx);
  });

  it('shows override amount instead of default when nextOverride exists', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Modified Bill', amount: -100, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: { amount: -75 },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // Should show the override amount (-75), not the default (-100)
    expect(screen.getAllByText('-$75.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('-$100.00')).not.toBeInTheDocument();
  });

  it('uses override amount for type determination (bill vs deposit)', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Overridden to Deposit', amount: -100, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: { amount: 50 },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // Override amount is positive, so it should be classified as a deposit
    expect(screen.getByText('Deposit')).toBeInTheDocument();
  });

  /**
   * `nextDueDate` is the recurrence slot; an override addressed to that slot can
   * move the occurrence. Reading the slot announces a payment on a day the user
   * has already changed (issue #1247).
   */
  it('shows the date an override moved the next occurrence to', () => {
    const slot = futureDateStr(1);
    const movedTo = futureDateStr(4);
    const transactions = [
      {
        id: '1', name: 'Moved Bill', amount: -100, currencyCode: 'CAD',
        nextDueDate: slot, isActive: true, autoPost: true,
        reminderDaysBefore: 7,
        nextOverride: { amount: -75, overrideDate: movedTo },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.getByText('4 days')).toBeInTheDocument();
    expect(screen.queryByText('Tomorrow')).not.toBeInTheDocument();
  });

  it('drops an occurrence an override moved beyond the reminder window', () => {
    const transactions = [
      {
        id: '1', name: 'Pushed Out', amount: -100, currencyCode: 'CAD',
        nextDueDate: futureDateStr(1), isActive: true, autoPost: true,
        reminderDaysBefore: 3,
        nextOverride: { amount: -75, overrideDate: futureDateStr(40) },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.queryByText('Pushed Out')).not.toBeInTheDocument();
  });

  it('uses default amount when nextOverride is null', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Normal Bill', amount: -200, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: null,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getAllByText('-$200.00').length).toBeGreaterThanOrEqual(1);
  });

  it('truncates list at maxItems and shows +N more link', () => {
    const dateStr = futureDateStr(1);
    const transactions = Array.from({ length: 6 }, (_, i) => ({
      id: String(i + 1), name: `Bill ${i + 1}`, amount: -10, currencyCode: 'CAD',
      nextDueDate: dateStr, isActive: true, autoPost: true,
    })) as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={4} />);
    // Only 4 of 6 items should be visible
    expect(screen.getByText('Bill 1')).toBeInTheDocument();
    expect(screen.getByText('Bill 4')).toBeInTheDocument();
    expect(screen.queryByText('Bill 5')).not.toBeInTheDocument();
    expect(screen.queryByText('Bill 6')).not.toBeInTheDocument();
    // "+2 more" link should appear
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('does not show +N more when items fit within maxItems', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Bill A', amount: -10, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Bill B', amount: -20, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={5} />);
    expect(screen.getByText('Bill A')).toBeInTheDocument();
    expect(screen.getByText('Bill B')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });

  // ---- Effective amounts (issue #1247) ----

  it("shows the server's effective amount for an FX-sensitive schedule", () => {
    // A scheduled SELL: the cash impact is an inflow, and the schedule settles
    // in the brokerage's cash currency. The occurrence is priced at today's
    // rate, not the one pinned when the row was written.
    //
    // The row is now the only figure the widget prints for this occurrence, so
    // it is the one that has to be re-priced: with the summary rows gone
    // (#1264 removed "Total due", and "Total incoming" followed) a stale
    // snapshot here has nothing left to disagree with, only the user.
    const transactions = [
      {
        id: '1',
        name: 'Monthly ETF sale',
        // The security-currency cash impact, pinned at 1.50 when it was EUR.
        amount: 1000,
        currencyCode: 'CAD',
        isInvestment: true,
        // The security is USD now, and USD -> CAD resolves at 1.35.
        effectiveAmount: 1350,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // Exactly one figure, and it reads 1,350.
    expect(screen.getAllByText('+$1350.00')).toHaveLength(1);
    // Neither the pre-FX impact nor the stale 1.50 figure.
    expect(screen.queryByText('+$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('+$1500.00')).not.toBeInTheDocument();
  });

  it('marks an unresolvable occurrence unavailable without touching its neighbours', () => {
    // The unpriceable row renders as unavailable; the resolvable one beside it
    // still prints its own figure. No total is drawn for either.
    const transactions = [
      {
        id: '1',
        name: 'Monthly ETF sale',
        amount: 1000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
      {
        id: '2',
        name: 'Dividend',
        amount: 15.99,
        currencyCode: 'CAD',
        effectiveAmount: 15.99,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // The row itself carries the unavailable marker, not a stale figure.
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
    expect(screen.queryByText('+$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('+$1500.00')).not.toBeInTheDocument();
    // No summary row survives to fold the missing item into a figure.
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    // The resolvable row, once: nothing invented a total from the half it knew.
    expect(screen.getAllByText('+$15.99')).toHaveLength(1);
  });

  it('does not let an unknown amount move an account into the negative-balance warning', () => {
    // A running balance built from an unknown amount is unknown, so the
    // projection stops for that account rather than treating the item as free.
    const transactions = [
      {
        id: '1',
        name: 'Monthly ETF buy',
        accountId: 'acc-1',
        amount: -1000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
      {
        id: '2',
        name: 'Netflix',
        accountId: 'acc-1',
        amount: -15.99,
        currencyCode: 'CAD',
        effectiveAmount: -15.99,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(2),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-1',
        accountType: 'CHECKING',
        currentBalance: 10,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // With the unknown item skipped and the projection stopped, no row claims a
    // measured overdraft.
    expect(screen.queryByRole('img', { name: BELOW_ZERO_TITLE })).not.toBeInTheDocument();
  });

  // ---- The below-zero warning ----

  it('warns on the item that takes an account below zero', () => {
    // The positive case the rest of this block is measured against: without it,
    // every "no warning" assertion below passes on a widget that never warns.
    const transactions = [
      {
        id: 'bill-1',
        name: 'Rent',
        accountId: 'acc-cash',
        amount: -1200,
        currencyCode: 'CAD',
        effectiveAmount: -1200,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        settlementAccountId: 'acc-cash',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-cash',
        accountType: 'CHECKING',
        currencyCode: 'CAD',
        currentBalance: 1000,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.getByRole('img', { name: BELOW_ZERO_TITLE })).toBeInTheDocument();
    // What the mark means is visible text, not a hover-only title a phone cannot read.
    expect(screen.getByText('Takes its account below zero')).toBeInTheDocument();
    expect(screen.queryByTitle(BELOW_ZERO_TITLE)).not.toBeInTheDocument();
  });

  it('charges a scheduled investment to its settlement account, not the brokerage', () => {
    // The purchase spends the linked cash account to exactly zero. Projected
    // onto the brokerage -- whose own balance is not the cash the trade spends
    // -- the same occurrence reads as a 5,000 overdraft, which is the warning
    // this test exists to keep off the widget (issue #1247).
    const transactions = [
      {
        id: 'buy-1',
        name: 'Monthly ETF buy',
        accountId: 'acc-brokerage',
        amount: -5000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: -5000,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        settlementAccountId: 'acc-cash',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'CAD',
        linkedAccountId: 'acc-cash',
        currentBalance: 0,
        futureTransactionsSum: 0,
      },
      {
        id: 'acc-cash',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        currencyCode: 'CAD',
        currentBalance: 5000,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.queryByRole('img', { name: BELOW_ZERO_TITLE })).not.toBeInTheDocument();
  });

  it('still warns when the settlement account cannot cover the purchase', () => {
    // The other side of the same fix: charging the right account is not the
    // same as never warning.
    const transactions = [
      {
        id: 'buy-1',
        name: 'Monthly ETF buy',
        accountId: 'acc-brokerage',
        amount: -5000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: -5000,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        settlementAccountId: 'acc-cash',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'CAD',
        linkedAccountId: 'acc-cash',
        currentBalance: 0,
        futureTransactionsSum: 0,
      },
      {
        id: 'acc-cash',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        currencyCode: 'CAD',
        currentBalance: 4999.99,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.getByRole('img', { name: BELOW_ZERO_TITLE })).toBeInTheDocument();
  });

  it('derives the settlement account from the linked cash account on an older backend', () => {
    // No `settlementAccountId` on the payload (a rolling deploy). The brokerage's
    // linked cash account is the answer, exactly as the cash-flow forecast has
    // always derived it -- absent is never a licence to charge `accountId`.
    const transactions = [
      {
        id: 'buy-1',
        name: 'Monthly ETF buy',
        accountId: 'acc-brokerage',
        amount: -5000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: -5000,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'CAD',
        linkedAccountId: 'acc-cash',
        currentBalance: 0,
        futureTransactionsSum: 0,
      },
      {
        id: 'acc-cash',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        currencyCode: 'CAD',
        currentBalance: 5000,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.queryByRole('img', { name: BELOW_ZERO_TITLE })).not.toBeInTheDocument();
  });

  it('does not warn on an account a run of bills lands on exactly zero', () => {
    // Every figure here is a decimal(20,4), and the balance ends at exactly
    // 0.0000 -- but the doubles behind them do not sum to a clean zero, so an
    // unrounded running balance finishes a fraction below it and warns.
    const transactions = [
      {
        id: 'bill-1',
        name: 'Hydro',
        accountId: 'acc-cash',
        amount: -949.37,
        currencyCode: 'CAD',
        effectiveAmount: -949.37,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        settlementAccountId: 'acc-cash',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-cash',
        accountType: 'CHECKING',
        currencyCode: 'CAD',
        currentBalance: 647.67,
        futureTransactionsSum: 301.7,
      },
    ] as any[];

    // The unrounded arithmetic this guards against: 647.67 + 301.70 - 949.37 is
    // exactly zero in decimal(20,4) and a shade below zero in binary floating
    // point, which is all `newBalance < 0` needs to raise the warning.
    expect(647.67 + 301.7 - 949.37).toBeLessThan(0);

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.queryByRole('img', { name: BELOW_ZERO_TITLE })).not.toBeInTheDocument();
  });

  it('withholds the warning when the occurrence is priced in another currency', () => {
    // An amount and its currency are one value. A payload claiming 1,100 USD
    // settles in a CAD account contradicts itself -- a live backend derives both
    // fields from that one account -- and this widget holds no rate table to
    // resolve it, so the projection is unknown. Compared as bare numbers,
    // 1,000 - 1,100 warns about an overdraft in units the account does not hold.
    const transactions = [
      {
        id: 'bill-1',
        name: 'US subscription',
        accountId: 'acc-cash',
        amount: -1100,
        currencyCode: 'USD',
        effectiveAmount: -1100,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'USD',
        settlementAccountId: 'acc-cash',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-cash',
        accountType: 'CHECKING',
        currencyCode: 'CAD',
        currentBalance: 1000,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.queryByRole('img', { name: BELOW_ZERO_TITLE })).not.toBeInTheDocument();
  });

  it('prioritizes manual items over auto-post items on the same day', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Manual Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const billElements = screen.getAllByText(/Bill/);
    const manualIdx = billElements.findIndex(el => el.textContent === 'Manual Bill');
    const autoIdx = billElements.findIndex(el => el.textContent === 'Auto Bill');
    expect(manualIdx).toBeLessThan(autoIdx);
  });
});
