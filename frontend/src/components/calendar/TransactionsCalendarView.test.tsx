import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { CALENDAR_MAX_PER_SCHEDULE } from '@/hooks/useCalendarMonthData';
import { SWIPE_ANIMATION_MS, SWIPE_PAGINATE_ATTR } from '@/hooks/swipe-gesture';
import { TransactionsCalendarView } from './TransactionsCalendarView';
import calendarNs from '@/i18n/messages/en/calendar.json';
import { useViewModeStore } from '@/store/viewModeStore';
import { useAuthStore } from '@/store/authStore';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import { SCHEDULED_KIND_CHIP_CLASSES } from '@/lib/scheduled-kind';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import type {
  Account,
  DailyBalanceTotal,
  DailyBalanceTotalsResponse,
} from '@/types/account';
import type {
  ScheduledOccurrence,
  ScheduledTransaction,
} from '@/types/scheduled-transaction';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/transactions',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      defaultCurrency: 'CAD',
    }),
  };
});

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAllPages: (...args: unknown[]) => mockGetAllPages(...args),
  },
}));

const mockGetOccurrences = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getOccurrences: (...args: unknown[]) => mockGetOccurrences(...args),
  },
}));

const mockListDayNotes = vi.fn();
const mockUpsertDayNote = vi.fn();
const mockRemoveDayNote = vi.fn();
vi.mock('@/lib/calendar-day-notes', () => ({
  calendarDayNotesApi: {
    list: (...args: unknown[]) => mockListDayNotes(...args),
    upsert: (...args: unknown[]) => mockUpsertDayNote(...args),
    remove: (...args: unknown[]) => mockRemoveDayNote(...args),
  },
}));

const mockGetDailyBalanceTotals = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getDailyBalanceTotals: (...args: unknown[]) => mockGetDailyBalanceTotals(...args),
  },
}));

const TODAY = '2026-06-15';

const accounts = [
  { id: 'chequing-1', accountType: 'CHEQUING', linkedAccountId: null },
  { id: 'card-1', accountType: 'CREDIT_CARD', linkedAccountId: null },
  { id: 'brokerage-1', accountType: 'INVESTMENT', linkedAccountId: 'sleeve-1' },
  { id: 'sleeve-1', accountType: 'CASH', linkedAccountId: null },
] as unknown as Account[];

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'chequing-1',
    transactionDate: '2026-06-10',
    amount: -25,
    currencyCode: 'CAD',
    status: TransactionStatus.CLEARED,
    payeeName: 'Grocer',
    ...overrides,
  } as Transaction;
}

function schedule(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'st-1',
    name: 'Rent',
    amount: -1200,
    currencyCode: 'CAD',
    accountId: 'chequing-1',
    settlementAccountId: 'chequing-1',
    isTransfer: false,
    isInvestment: false,
    ...overrides,
  } as ScheduledTransaction;
}

function occurrence(overrides: Partial<ScheduledOccurrence> = {}): ScheduledOccurrence {
  return {
    scheduledTransactionId: 'st-1',
    originalDate: '2026-06-20',
    dueDate: '2026-06-20',
    amount: -1200,
    amountComplete: true,
    directionAmount: -1200,
    currencyCode: 'CAD',
    overrideId: null,
    moved: false,
    accountId: 'chequing-1',
    transferAccountId: null,
    isTransfer: false,
    ...overrides,
  };
}

/**
 * A daily-balance-totals response covering the June 2026 grid.
 *
 * The days it carries are only the ones a test asserts on: a day the response
 * does not mention draws no figure, which is the fifth state the layer has.
 */
function balanceTotals(
  overrides: Partial<DailyBalanceTotalsResponse> = {},
): DailyBalanceTotalsResponse {
  return {
    startDate: '2026-05-31',
    endDate: '2026-07-04',
    today: TODAY,
    currencyCode: 'CAD',
    days: [],
    forecast: { complete: true, gaps: [], unforecastableAccountIds: [] },
    scopeEmpty: false,
    ...overrides,
  };
}

function balanceDay(
  date: string,
  overrides: Partial<DailyBalanceTotal> = {},
): DailyBalanceTotal {
  return {
    date,
    total: 100,
    knownSubtotal: 100,
    isProjected: false,
    missingRatePairs: [],
    ...overrides,
  };
}

/** The store state a test needs for the Balances layer to be on. */
function withBalancesLayer() {
  useViewModeStore.setState({
    surfaces: {
      transactions: { view: 'calendar', layers: ['transactions', 'balances'] },
      investments: { view: 'table', layers: ['transactions'] },
    },
  });
}

const onEditTransaction = vi.fn();
const onCreateOnDay = vi.fn();

function renderView(
  overrides: Partial<React.ComponentProps<typeof TransactionsCalendarView>> = {},
) {
  return render(
    <TransactionsCalendarView
      accounts={accounts}
      scheduledTransactions={[schedule()]}
      filters={{ accountIds: ['chequing-1', 'card-1'] }}
      scopeAccountIds={['chequing-1', 'card-1']}
      weekStartsOn={0}
      today={TODAY}
      categoryColorMap={new Map()}
      categoryIconMap={new Map()}
      categoryLabelMap={new Map()}
      onEditTransaction={onEditTransaction}
      onCreateOnDay={onCreateOnDay}
      {...overrides}
    />,
  );
}

/** The cell for a day, located by the accessible name MonthGrid gives it. */
function cell(label: string) {
  return screen.getByLabelText(label);
}

/** One touch point, the way `useSwipeToPaginate`'s own spec builds them. */
function touch(
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientX: number,
  clientY: number,
): TouchEvent {
  const point = { clientX, clientY, identifier: 0 } as Touch;
  const init: TouchEventInit = { bubbles: true, cancelable: type === 'touchmove' };
  if (type === 'touchend') {
    init.changedTouches = [point];
    init.touches = [];
  } else {
    init.touches = [point];
    init.changedTouches = [point];
  }
  return new TouchEvent(type, init);
}

/** Drag the grid horizontally and let the commit animation finish. */
async function swipeGrid(deltaX: number) {
  const zone = screen.getByRole('grid').parentElement!;
  const startX = 500;
  await act(async () => {
    zone.dispatchEvent(touch('touchstart', startX, 200));
    zone.dispatchEvent(touch('touchmove', startX + deltaX, 202));
    zone.dispatchEvent(touch('touchend', startX + deltaX, 202));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SWIPE_ANIMATION_MS + 80));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllPages.mockResolvedValue([]);
  mockGetOccurrences.mockResolvedValue([]);
  mockGetDailyBalanceTotals.mockResolvedValue(balanceTotals());
  mockListDayNotes.mockResolvedValue([]);
  mockUpsertDayNote.mockResolvedValue({
    startDate: '2026-06-10',
    endDate: '2026-06-10',
    body: 'Saved',
    updatedAt: '2026-06-10T00:00:00.000Z',
  });
  mockRemoveDayNote.mockResolvedValue(undefined);
  useAuthStore.setState({ actingAsUserId: null });
  useViewModeStore.setState({
    surfaces: {
      transactions: { view: 'calendar', layers: ['transactions'] },
      investments: { view: 'table', layers: ['transactions'] },
    },
  });
});

describe('TransactionsCalendarView', () => {
  it('asks the register for the grid range, not for the month alone', async () => {
    renderView();

    await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
    // June 2026 starts on a Monday, so a Sunday-start grid runs 31 May to 4 July.
    expect(mockGetAllPages.mock.calls[0][0]).toMatchObject({
      startDate: '2026-05-31',
      endDate: '2026-07-04',
      accountIds: ['chequing-1', 'card-1'],
    });
    expect(mockGetOccurrences).toHaveBeenCalledWith({
      through: '2026-07-04',
      maxPerSchedule: CALENDAR_MAX_PER_SCHEDULE,
    });
  });

  describe('the transactions layer', () => {
    it('puts a row on its own day, coloured by its account type', async () => {
      mockGetAllPages.mockResolvedValue([transaction()]);
      renderView();

      const chip = await screen.findByRole('button', { name: /Grocer/ });
      expect(within(cell('06/10/2026')).getByRole('button', { name: /Grocer/ })).toBe(chip);
      expect(chip.className).toContain(ACCOUNT_TYPE_META.CHEQUING.pillClass.split(' ')[0]);
    });

    it('strikes a void row through rather than dropping it', async () => {
      mockGetAllPages.mockResolvedValue([
        transaction({ status: TransactionStatus.VOID }),
      ]);
      renderView();

      const chip = await screen.findByRole('button', { name: /Grocer/ });
      expect(chip.className).toContain('line-through');
    });

    it('dims a row dated after the server today', async () => {
      mockGetAllPages.mockResolvedValue([
        transaction({ transactionDate: '2026-06-20' }),
      ]);
      renderView();

      const chip = await screen.findByRole('button', { name: /Grocer/ });
      expect(chip.className).toContain('opacity-60');
    });

    it('opens the register edit modal for the row the reader clicked', async () => {
      const row = transaction();
      mockGetAllPages.mockResolvedValue([row]);
      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /Grocer/ }));

      expect(onEditTransaction).toHaveBeenCalledWith(row);
    });
  });

  describe('the scheduled occurrences', () => {
    it('draws an occurrence with its name, its amount and a scheduled marker', async () => {
      mockGetOccurrences.mockResolvedValue([occurrence()]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(chip).toHaveTextContent('$-1200.00');
      expect(chip.className).toContain('border-dashed');
      expect(chip.className).toContain(SCHEDULED_KIND_CHIP_CLASSES.bill.split(' ')[0]);
      expect(within(chip).getByLabelText('Scheduled')).toBeInTheDocument();
    });

    it('links an occurrence to its schedule on Bills & Deposits', async () => {
      mockGetOccurrences.mockResolvedValue([occurrence()]);
      renderView();

      expect(await screen.findByRole('link', { name: /Rent/ })).toHaveAttribute(
        'href',
        '/bills?highlight=st-1',
      );
    });

    it('marks an occurrence due before today as overdue', async () => {
      mockGetOccurrences.mockResolvedValue([
        occurrence({ originalDate: '2026-06-05', dueDate: '2026-06-05' }),
      ]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(within(chip).getByLabelText('Overdue')).toBeInTheDocument();
    });

    it('shows an unpriceable occurrence as unknown, never as a number', async () => {
      mockGetOccurrences.mockResolvedValue([
        occurrence({ amount: null, amountComplete: false, directionAmount: null }),
      ]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(within(chip).getByTestId('unknown-amount')).toBeInTheDocument();
      expect(chip).not.toHaveTextContent('$');
      expect(chip.className).toContain(SCHEDULED_KIND_CHIP_CLASSES.unknown.split(' ')[0]);
    });

    it('places an occurrence on the day an override moved it to', async () => {
      mockGetOccurrences.mockResolvedValue([
        occurrence({ originalDate: '2026-06-20', dueDate: '2026-06-23', moved: true }),
      ]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(within(cell('06/23/2026')).getByRole('link', { name: /Rent/ })).toBe(chip);
    });

    it('leaves out an occurrence whose money never touches the accounts in scope', async () => {
      mockGetOccurrences.mockResolvedValue([occurrence()]);
      renderView({ scopeAccountIds: ['card-1'], filters: { accountIds: ['card-1'] } });

      await waitFor(() => expect(mockGetOccurrences).toHaveBeenCalled());
      expect(screen.queryByRole('link', { name: /Rent/ })).not.toBeInTheDocument();
    });

    it('keeps an investment occurrence on the account its cash leaves', async () => {
      // INV-OCCURRENCE-003: the brokerage is not the account that pays.
      mockGetOccurrences.mockResolvedValue([
        occurrence({ scheduledTransactionId: 'st-inv', accountId: 'brokerage-1' }),
      ]);
      renderView({
        scheduledTransactions: [
          schedule({
            id: 'st-inv',
            name: 'Monthly buy',
            accountId: 'brokerage-1',
            isInvestment: true,
            investmentFundingAccountId: 'chequing-1',
            settlementAccountId: 'chequing-1',
          }),
        ],
        scopeAccountIds: ['chequing-1'],
      });

      expect(await screen.findByRole('link', { name: /Monthly buy/ })).toBeInTheDocument();
    });
  });

  describe('the day panel', () => {
    it('opens on the day the reader picked and lists what is on it', async () => {
      mockGetAllPages.mockResolvedValue([transaction()]);
      renderView();

      await screen.findByRole('button', { name: /Grocer/ });
      fireEvent.click(cell('06/10/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      expect(within(panel).getByText('Grocer')).toBeInTheDocument();
    });

    it('shows the payee badge beside the payee, as the register does', async () => {
      // The day panel is a list of the same rows the register holds, so a payee
      // is recognised here by the same mark it carries there.
      mockGetAllPages.mockResolvedValue([
        transaction({
          payeeId: 'payee-1',
          payee: { id: 'payee-1', name: 'Grocer', hasLogo: true } as Transaction['payee'],
        }),
      ]);
      renderView();

      await screen.findByRole('button', { name: /Grocer/ });
      fireEvent.click(cell('06/10/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      const logo = within(panel).getByRole('img', { name: 'Grocer' });
      expect(logo).toBeInTheDocument();
      // To the LEFT of the name, which is the placement that was asked for.
      const name = within(panel).getByText('Grocer');
      expect(logo.compareDocumentPosition(name)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('keeps the row aligned when there is no payee to badge', async () => {
      // `PayeeLogo` falls back to a letter badge rather than to nothing, so a
      // free-text payee and a row that names none do not shift the column.
      mockGetAllPages.mockResolvedValue([transaction({ payeeName: null })]);
      renderView();

      fireEvent.click(cell('06/10/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      expect(within(panel).getByText('No payee')).toBeInTheDocument();
    });

    it('starts a new transaction on the day it is showing', async () => {
      renderView();

      fireEvent.click(cell('06/10/2026'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'New transaction on this day' }),
      );

      expect(onCreateOnDay).toHaveBeenCalledWith('2026-06-10');
    });

    it('says a day is empty rather than showing nothing at all', async () => {
      renderView();

      fireEvent.click(cell('06/10/2026'));

      expect(await screen.findByText('Nothing on this day.')).toBeInTheDocument();
    });

    it('signs each amount the way the register does: money in green, money out red', async () => {
      // The row's amount is already signed, so the panel decides nothing about
      // direction -- it colours what it was handed, through the same
      // `gainLossColor` the rest of the app signs a figure with.
      mockGetAllPages.mockResolvedValue([
        transaction({ id: 'tx-out', amount: -25, payeeName: 'Grocer' }),
        transaction({ id: 'tx-in', amount: 900, payeeName: 'Payroll' }),
      ]);
      renderView();

      await screen.findAllByRole('button', { name: /Grocer/ });
      fireEvent.click(cell('06/10/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      expect(within(panel).getByText('$900.00').className).toContain('text-green');
      expect(within(panel).getByText('$-25.00').className).toContain('text-red');
    });
  });

  describe('the month', () => {
    it('opens on the month of the server today', async () => {
      renderView();
      // The caption is the reader's own date format, through `formatMonth`.
      expect(await screen.findByRole('heading', { name: '06/2026' })).toBeInTheDocument();
    });

    it('asks for the next month when the reader steps forward', async () => {
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));

      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(2));
      expect(mockGetAllPages.mock.calls[1][0]).toMatchObject({
        startDate: '2026-06-28',
        endDate: '2026-08-01',
      });
    });

    it('turns the month on a swipe across the grid: left is forward, right is back', async () => {
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));

      await swipeGrid(-400);
      expect(await screen.findByRole('heading', { name: '07/2026' })).toBeInTheDocument();

      await swipeGrid(400);
      expect(await screen.findByRole('heading', { name: '06/2026' })).toBeInTheDocument();

      await swipeGrid(400);
      expect(await screen.findByRole('heading', { name: '05/2026' })).toBeInTheDocument();
    });

    it('asks for the month a swipe landed on, not the one it left', async () => {
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));

      await swipeGrid(-400);

      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(2));
      // The same grid range the Next month arrow asks for: one month change,
      // reached two ways.
      expect(mockGetAllPages.mock.calls[1][0]).toMatchObject({
        startDate: '2026-06-28',
        endDate: '2026-08-01',
      });
    });

    it('leaves a day selected in the month it left behind', async () => {
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));
      fireEvent.click(cell('06/10/2026'));
      expect(await screen.findByRole('complementary', { name: '06/10/2026' })).toBeInTheDocument();

      await swipeGrid(-400);

      expect(screen.queryByRole('complementary', { name: '06/10/2026' })).not.toBeInTheDocument();
    });

    it('claims the horizontal gesture, so a swipe does not leave the page instead', async () => {
      // `useSwipeNavigation` pages between whole sections of the app and cedes a
      // touch that starts inside a pagination zone. Without the marker a swipe
      // over the calendar would navigate away rather than turn the month.
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());

      expect(screen.getByRole('grid').parentElement).toHaveAttribute(
        SWIPE_PAGINATE_ATTR,
        'true',
      );
    });
  });

  describe('when the month cannot be drawn', () => {
    it('withholds the layer past the row cap and says why', async () => {
      mockGetAllPages.mockResolvedValue(
        Array.from({ length: 1001 }, (_, i) =>
          transaction({ id: `tx-${i}`, payeeName: 'Grocer' }),
        ),
      );
      renderView();

      expect(await screen.findByText(/more than the 1,?000/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Grocer/ })).not.toBeInTheDocument();
    });

    it('renders a retryable failure, never an empty month', async () => {
      mockGetAllPages.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText('This month could not be loaded.')).toBeInTheDocument();
      expect(screen.queryByRole('grid')).not.toBeInTheDocument();

      mockGetAllPages.mockResolvedValue([transaction()]);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('button', { name: /Grocer/ })).toBeInTheDocument();
    });
  });

  describe('a payload belongs to the request that produced it', () => {
    it('keeps the month the reader is on when an earlier request answers late', async () => {
      // A starts, B starts, B resolves, A resolves late -> B is still shown.
      let resolveJune: (rows: Transaction[]) => void = () => {};
      mockGetAllPages.mockImplementationOnce(
        () => new Promise<Transaction[]>((resolve) => { resolveJune = resolve; }),
      );
      mockGetAllPages.mockResolvedValue([
        transaction({ id: 'tx-july', transactionDate: '2026-07-08', payeeName: 'Julys row' }),
      ]);

      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
      expect(await screen.findByRole('button', { name: /Julys row/ })).toBeInTheDocument();

      await act(async () => {
        resolveJune([transaction({ id: 'tx-june', payeeName: 'Junes row' })]);
      });

      expect(screen.getByRole('button', { name: /Julys row/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Junes row/ })).not.toBeInTheDocument();
    });
  });

  describe('the scheduled half', () => {
    it('draws the month and names the gap when only the occurrences fail', async () => {
      // The occurrence endpoint refuses a `through` beyond five years, which
      // the toolbar's next-month button reaches. The register's rows arrived,
      // so a blank month with a retry button would hide what the reader asked
      // for -- and silence would read as "nothing is due".
      mockGetAllPages.mockResolvedValue([transaction()]);
      mockGetOccurrences.mockRejectedValue(new Error('through is beyond the horizon'));

      renderView();

      await waitFor(() =>
        expect(screen.getByText(calendarNs.banner.scheduledUnavailable)).toBeInTheDocument(),
      );
      expect(screen.getByRole('grid')).toBeInTheDocument();
      expect(screen.queryByText(calendarNs.errors.monthFailed)).not.toBeInTheDocument();
    });

    it('says so when the per-schedule cap cut a schedule short of the grid', async () => {
      mockGetAllPages.mockResolvedValue([]);
      mockGetOccurrences.mockResolvedValue(
        Array.from({ length: CALENDAR_MAX_PER_SCHEDULE }, () => occurrence()),
      );

      renderView();

      await waitFor(() =>
        expect(screen.getByText(calendarNs.banner.scheduledTruncated)).toBeInTheDocument(),
      );
    });

    it('stays quiet when every schedule came back whole', async () => {
      mockGetAllPages.mockResolvedValue([]);
      mockGetOccurrences.mockResolvedValue([occurrence()]);

      renderView();

      await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());
      expect(
        screen.queryByText(calendarNs.banner.scheduledUnavailable),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(calendarNs.banner.scheduledTruncated)).not.toBeInTheDocument();
    });
  });
  describe('the balances layer', () => {
    it('asks for the grid range with the account scope, and nothing else', async () => {
      withBalancesLayer();
      renderView();

      await waitFor(() => expect(mockGetDailyBalanceTotals).toHaveBeenCalled());
      expect(mockGetDailyBalanceTotals).toHaveBeenCalledWith({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
        accountIds: 'chequing-1,card-1',
        displayCurrency: undefined,
      });
    });

    it('asks nothing at all while the layer is off', async () => {
      renderView();

      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
      expect(mockGetDailyBalanceTotals).not.toHaveBeenCalled();
    });

    it('prints a settled day as a plain figure (example 1)', async () => {
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({
          days: [balanceDay('2026-06-15', { total: 2599.56, knownSubtotal: 2599.56 })],
        }),
      );
      renderView();

      const figure = await within(cell('06/15/2026')).findByTestId('calendar-balance-actual');
      expect(figure).toHaveTextContent('$2599.56');
      expect(figure.className).not.toContain('italic');
    });

    it('shows the unknown marker, not the partial sum, when a rate is missing (example 1)', async () => {
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({
          days: [
            balanceDay('2026-06-16', {
              total: null,
              knownSubtotal: 1234.56,
              missingRatePairs: ['USD->CAD'],
            }),
          ],
        }),
      );
      renderView();

      const dayCell = cell('06/16/2026');
      await waitFor(() =>
        expect(within(dayCell).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      expect(dayCell).not.toHaveTextContent('1234.56');

      fireEvent.click(dayCell);
      const panel = await screen.findByRole('complementary', { name: '06/16/2026' });
      expect(within(panel).getByText(/USD->CAD/)).toBeInTheDocument();
      // The partial sum is allowed here, and only under a caption saying so.
      expect(within(panel).getByText(/Partial: \$1234.56/)).toBeInTheDocument();
    });

    it('prints a projected day in italics with a clock marker (example 2)', async () => {
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({
          days: [balanceDay('2026-06-19', { total: 3100, knownSubtotal: 3100, isProjected: true })],
        }),
      );
      renderView();

      const figure = await within(cell('06/19/2026')).findByTestId(
        'calendar-balance-projected',
      );
      expect(figure).toHaveTextContent('$3100.00');
      expect(figure.className).toContain('italic');
      expect(within(figure).getByLabelText('Projected')).toBeInTheDocument();
    });

    it('reads projected off the response, never off the browser clock (I2)', async () => {
      withBalancesLayer();
      // The server calls 06/10 a projection; by the client's own `today` prop it
      // is five days past. The cell follows the response.
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({
          days: [balanceDay('2026-06-10', { isProjected: true })],
        }),
      );
      renderView();

      expect(
        await within(cell('06/10/2026')).findByTestId('calendar-balance-projected'),
      ).toBeInTheDocument();
    });

    it('withholds every projected day and names the schedule when a forecast is incomplete', async () => {
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({
          days: [
            balanceDay('2026-06-15', { total: 2600, knownSubtotal: 2600 }),
            balanceDay('2026-06-19', { total: null, knownSubtotal: 0, isProjected: true }),
          ],
          forecast: {
            complete: false,
            gaps: [
              {
                scheduledTransactionId: 'st-rent',
                name: 'Rent',
                reason: 'crossCurrencyTransfer',
                fromCurrency: 'USD',
                toCurrency: 'CAD',
              },
            ],
            unforecastableAccountIds: [],
          },
        }),
      );
      renderView();

      // History is untouched by a withheld projection.
      expect(
        await within(cell('06/15/2026')).findByTestId('calendar-balance-actual'),
      ).toHaveTextContent('$2600.00');
      expect(within(cell('06/19/2026')).getByTestId('unknown-amount')).toBeInTheDocument();
      expect(screen.getByText(/Rent/)).toBeInTheDocument();

      fireEvent.click(cell('06/19/2026'));
      const panel = await screen.findByRole('complementary', { name: '06/19/2026' });
      expect(within(panel).getByTestId('balance-forecast-unavailable')).toBeInTheDocument();
    });

    it('says the scope is empty rather than drawing a month of nothing', async () => {
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(balanceTotals({ scopeEmpty: true }));
      renderView({ scopeAccountIds: [] });

      expect(
        await screen.findByText(calendarNs.banner.balancesScopeEmpty),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('calendar-balance-actual')).not.toBeInTheDocument();
    });

    it('leaves the transactions layer intact when only the balances request fails', async () => {
      withBalancesLayer();
      mockGetAllPages.mockResolvedValue([transaction()]);
      mockGetDailyBalanceTotals.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.balancesFailed)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Grocer/ })).toBeInTheDocument();
      expect(screen.queryByText(calendarNs.errors.monthFailed)).not.toBeInTheDocument();

      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({ days: [balanceDay('2026-06-15', { total: 2600 })] }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(
        await within(cell('06/15/2026')).findByTestId('calendar-balance-actual'),
      ).toBeInTheDocument();
    });

    it('names every missing pair in the month once, in the banner', async () => {
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({
          days: [
            balanceDay('2026-06-16', { total: null, missingRatePairs: ['USD->CAD'] }),
            balanceDay('2026-06-17', { total: null, missingRatePairs: ['USD->CAD'] }),
          ],
        }),
      );
      renderView();

      const banner = await screen.findByText(/No exchange rate is available for USD->CAD/);
      expect(banner).toBeInTheDocument();
    });
  });
  describe('day notes', () => {
    it('asks for the grid range once, and not again when a filter moves', async () => {
      renderView();

      await waitFor(() => expect(mockListDayNotes).toHaveBeenCalled());
      expect(mockListDayNotes).toHaveBeenCalledWith({
        startDate: '2026-05-31',
        endDate: '2026-07-04',
      });
      expect(mockListDayNotes).toHaveBeenCalledTimes(1);
    });

    it('marks the day that carries one and shows its first line', async () => {
      mockListDayNotes.mockResolvedValue([
        { startDate: '2026-06-10', endDate: '2026-06-10', body: 'Call the landlord\nand the plumber', updatedAt: '2026-06-09T12:00:00.000Z' },
      ]);
      renderView();

      const marker = await within(cell('06/10/2026')).findByTestId('calendar-day-note-marker');
      expect(marker).toHaveTextContent('Call the landlord');
      expect(marker).not.toHaveTextContent('plumber');
    });

    it('marks every day a run covers, and draws the text only once', async () => {
      // A week away should read as one thing running across the grid rather
      // than as seven separate notes repeating the same sentence.
      mockListDayNotes.mockResolvedValue([
        {
          startDate: '2026-06-10',
          endDate: '2026-06-13',
          body: 'Away in Lisbon',
          updatedAt: '2026-06-09T12:00:00.000Z',
        },
      ]);
      renderView();

      const first = await within(cell('06/10/2026')).findByTestId('calendar-day-note-marker');
      expect(first).toHaveTextContent('Away in Lisbon');
      expect(first).toHaveAttribute('data-note-span', 'start');

      for (const [day, position] of [
        ['06/11/2026', 'middle'],
        ['06/12/2026', 'middle'],
        ['06/13/2026', 'end'],
      ] as const) {
        const marker = within(cell(day)).getByTestId('calendar-day-note-marker');
        expect(marker).toHaveAttribute('data-note-span', position);
        expect(marker).not.toHaveTextContent('Away in Lisbon');
      }

      expect(
        within(cell('06/14/2026')).queryByTestId('calendar-day-note-marker'),
      ).not.toBeInTheDocument();
    });

    it('opens the same note from the middle of a run, for editing', async () => {
      // Reaching the editor from any covered day is the whole point of a span.
      mockListDayNotes.mockResolvedValue([
        {
          startDate: '2026-06-10',
          endDate: '2026-06-13',
          body: 'Away in Lisbon',
          updatedAt: '2026-06-09T12:00:00.000Z',
        },
      ]);
      renderView();

      await within(cell('06/12/2026')).findByTestId('calendar-day-note-marker');
      fireEvent.click(cell('06/12/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/12/2026' });
      expect(within(panel).getByText('Away in Lisbon')).toBeInTheDocument();

      fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
      });

      // Anchored on the open day, carrying the whole span: the server resolves
      // the covering row from that day.
      expect(mockUpsertDayNote).toHaveBeenCalledWith('2026-06-12', {
        body: 'Away in Lisbon',
        startDate: '2026-06-10',
        endDate: '2026-06-13',
      });
    });

    it('reads the note in the day panel, and writes one from there', async () => {
      mockListDayNotes.mockResolvedValue([
        { startDate: '2026-06-10', endDate: '2026-06-10', body: 'Call the landlord', updatedAt: '2026-06-09T12:00:00.000Z' },
      ]);
      renderView();

      await within(cell('06/10/2026')).findByTestId('calendar-day-note-marker');
      fireEvent.click(cell('06/10/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      expect(within(panel).getByText('Call the landlord')).toBeInTheDocument();

      fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
      fireEvent.change(within(panel).getByLabelText(calendarNs.notes.title), {
        target: { value: 'Call the plumber' },
      });
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
      });

      expect(mockUpsertDayNote).toHaveBeenCalledWith('2026-06-10', {
        body: 'Call the plumber',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
      });
    });

    it('asks before a month change takes an unsaved draft away', async () => {
      renderView();

      await waitFor(() => expect(mockListDayNotes).toHaveBeenCalled());
      fireEvent.click(cell('06/10/2026'));
      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      fireEvent.click(within(panel).getByRole('button', { name: calendarNs.notes.add }));
      fireEvent.change(within(panel).getByLabelText(calendarNs.notes.title), {
        target: { value: 'Draft' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));

      expect(await screen.findByText(calendarNs.notes.discardMessage)).toBeInTheDocument();
      // The draft survives a cancel, and so does the month it belongs to.
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('heading', { name: '06/2026' })).toBeInTheDocument();
      expect(within(panel).getByLabelText(calendarNs.notes.title)).toHaveValue('Draft');
    });

    it('offers no note surface at all in an acting-delegate session', async () => {
      useAuthStore.setState({ actingAsUserId: 'owner-1' });
      renderView();

      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
      expect(mockListDayNotes).not.toHaveBeenCalled();

      fireEvent.click(cell('06/10/2026'));
      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      expect(
        within(panel).queryByRole('button', { name: calendarNs.notes.add }),
      ).not.toBeInTheDocument();
    });

    it('says so in the banner when the notes could not be loaded', async () => {
      mockListDayNotes.mockRejectedValue(new Error('offline'));
      renderView();

      expect(
        await screen.findByText(calendarNs.banner.notesUnavailable),
      ).toBeInTheDocument();
      expect(screen.getByRole('grid')).toBeInTheDocument();
    });

    it('offers no note to write while the list is absent', async () => {
      // The save is a whole-body upsert, so offering "Add a note" over a list
      // that never arrived invites the reader to replace a stored note the
      // client never saw. "This day has none" is a claim only a loaded list can
      // make; the banner above already says why there is none to read.
      mockListDayNotes.mockRejectedValue(new Error('offline'));
      renderView();

      await screen.findByText(calendarNs.banner.notesUnavailable);
      fireEvent.click(cell('06/10/2026'));
      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });

      expect(
        within(panel).queryByRole('button', { name: calendarNs.notes.add }),
      ).not.toBeInTheDocument();
      expect(mockUpsertDayNote).not.toHaveBeenCalled();
      // The rest of the day is untouched: the note half failing is not the
      // month failing.
      expect(
        within(panel).getByRole('button', { name: calendarNs.day.newTransaction }),
      ).toBeInTheDocument();
    });
  });
  describe('on a phone, and for a keyboard', () => {
    /** Answer every media query as a viewport of this width. */
    function viewport(width: number) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => {
        const max = /max-width:\s*(\d+)px/.exec(query);
        return {
          matches: max ? width <= Number(max[1]) : false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      });
    }

    it('opens the day over the month at 400px, and beside it at 1280px', async () => {
      viewport(400);
      const narrow = renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
      fireEvent.click(cell('06/10/2026'));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      narrow.unmount();

      viewport(1280);
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
      fireEvent.click(cell('06/10/2026'));

      expect(
        await screen.findByRole('complementary', { name: '06/10/2026' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('counts what a phone cell cannot label', async () => {
      viewport(400);
      mockGetAllPages.mockResolvedValue([
        transaction({ id: 'tx-1' }),
        transaction({ id: 'tx-2' }),
      ]);
      renderView();

      await screen.findAllByRole('button', { name: /Grocer/ });
      // The dots say what kind; the count says how many, which is the part a
      // row of dots cannot carry.
      expect(within(cell('06/10/2026')).getByText('2')).toBeInTheDocument();
    });

    it('announces the phone count, which is all a screen reader has there', async () => {
      // Below sm the chip list is `display: none` and the dots are decoration,
      // so the count is the only thing left that says how many items a day
      // holds. Hiding it from assistive technology leaves a month of bare dates.
      viewport(400);
      mockGetAllPages.mockResolvedValue([
        transaction({ id: 'tx-1' }),
        transaction({ id: 'tx-2' }),
      ]);
      renderView();

      await screen.findAllByRole('button', { name: /Grocer/ });
      const dayCell = cell('06/10/2026');

      expect(within(dayCell).getByText('2 items')).toBeInTheDocument();
      // The glyph itself stays decoration: the number is read once, as a count
      // of something, not twice as a stray digit.
      expect(within(dayCell).getByText('2')).toHaveAttribute('aria-hidden', 'true');
      expect(within(cell('06/11/2026')).queryByText(/item/)).toBeNull();
    });

    it('leaves the "+N more" line to the grid that draws the chips it counts', async () => {
      // Below sm the chips are dots and the count beside them already says how
      // many items the day holds, so a second line saying how many were left out
      // of a list nobody can see adds nothing. It is a breakpoint and not a
      // branch: the line is in the markup, drawn only from sm up.
      viewport(400);
      mockGetAllPages.mockResolvedValue([
        transaction({ id: 'tx-1' }),
        transaction({ id: 'tx-2' }),
        transaction({ id: 'tx-3' }),
        transaction({ id: 'tx-4' }),
      ]);
      renderView();

      await screen.findAllByRole('button', { name: /Grocer/ });
      const more = within(cell('06/10/2026')).getByRole('button', { name: '+1 more' });
      expect(more.classList.contains('hidden')).toBe(true);
      expect(more.classList.contains('sm:block')).toBe(true);
    });

    it('puts the day figure under the date on a phone, and beside it from sm up', async () => {
      // A date and a balance do not fit across a phone's cell, and the figure is
      // what the reader turned the Balances layer on for.
      viewport(400);
      withBalancesLayer();
      mockGetDailyBalanceTotals.mockResolvedValue(
        balanceTotals({ days: [balanceDay('2026-06-10')] }),
      );
      renderView();

      const figure = await within(cell('06/10/2026')).findByTestId('calendar-balance-actual');
      const row = figure.parentElement!;
      expect(row.className).toContain('flex-col');
      expect(row.className).toContain('sm:flex-row');
    });

    it('puts focus back on the day when the panel closes', async () => {
      viewport(1280);
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());

      const day = cell('06/10/2026');
      fireEvent.click(day);
      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });

      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
      });

      expect(cell('06/10/2026')).toHaveFocus();
    });

    it('marks the grid busy while a month is loading, and not after', async () => {
      let resolveRows: (rows: Transaction[]) => void = () => {};
      mockGetAllPages.mockImplementationOnce(
        () => new Promise<Transaction[]>((resolve) => { resolveRows = resolve; }),
      );
      renderView();

      const grid = await screen.findByRole('grid');
      expect(grid.parentElement).toHaveAttribute('aria-busy', 'true');

      await act(async () => {
        resolveRows([transaction()]);
      });

      expect(grid.parentElement).toHaveAttribute('aria-busy', 'false');
    });
  });
});
