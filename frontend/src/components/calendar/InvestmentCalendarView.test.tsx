import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@/test/render';
import { InvestmentCalendarView } from './InvestmentCalendarView';
import calendarNs from '@/i18n/messages/en/calendar.json';
import commonNs from '@/i18n/messages/en/common.json';
import { useViewModeStore } from '@/store/viewModeStore';
import { useAuthStore } from '@/store/authStore';
import { TransactionsCalendarView } from './TransactionsCalendarView';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import { SWIPE_ANIMATION_MS, SWIPE_PAGINATE_ATTR } from '@/hooks/swipe-gesture';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { Account } from '@/types/account';
import type { InvestmentTransaction } from '@/types/investment';
import type { DailyInvestmentValue } from '@/types/net-worth';
import type { DailyMovementPoint, DailyMovementsResponse } from '@/types/investment';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/investments',
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

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD', rates: [], getMarketRate: () => null }),
}));

const mockGetAllTransactionPages = vi.fn();
const mockGetDailyMovements = vi.fn();
const mockGetDailyMovementDetail = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getAllTransactionPages: (...args: unknown[]) => mockGetAllTransactionPages(...args),
    getDailyMovements: (...args: unknown[]) => mockGetDailyMovements(...args),
    getDailyMovementDetail: (...args: unknown[]) => mockGetDailyMovementDetail(...args),
  },
}));

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAllPages: (...args: unknown[]) => mockGetAllPages(...args) },
}));

const mockListDayNotes = vi.fn();
vi.mock('@/lib/calendar-day-notes', () => ({
  calendarDayNotesApi: {
    list: (...args: unknown[]) => mockListDayNotes(...args),
    upsert: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { getOccurrences: vi.fn().mockResolvedValue([]) },
}));

const mockGetInvestmentsDaily = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsDaily: (...args: unknown[]) => mockGetInvestmentsDaily(...args) },
}));

const TODAY = '2026-06-15';

const accounts = [
  { id: 'brokerage-1', accountType: 'INVESTMENT', linkedAccountId: 'sleeve-1' },
  { id: 'sleeve-1', accountType: 'CASH', linkedAccountId: null },
] as unknown as Account[];

function brokerageRow(overrides: Partial<InvestmentTransaction> = {}): InvestmentTransaction {
  return {
    id: 'inv-1',
    accountId: 'brokerage-1',
    action: 'BUY',
    transactionDate: '2026-06-10',
    totalAmount: 505,
    quantity: 10,
    price: 50,
    commission: 5,
    status: TransactionStatus.CLEARED,
    security: { id: 'sec-1', symbol: 'ABC', name: 'ABC Corp', currencyCode: 'CAD' },
    ...overrides,
  } as InvestmentTransaction;
}

function cashRow(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'cash-1',
    accountId: 'sleeve-1',
    transactionDate: '2026-06-11',
    amount: 1000,
    currencyCode: 'CAD',
    status: TransactionStatus.CLEARED,
    payeeName: 'Payroll',
    ...overrides,
  } as Transaction;
}

function valuePoint(
  date: string,
  overrides: Partial<DailyInvestmentValue> = {},
): DailyInvestmentValue {
  return {
    date,
    value: 100000,
    fxComplete: true,
    pricesComplete: true,
    missingRatePairs: [],
    unpricedSecurityIds: [],
    ...overrides,
  };
}

function movementPoint(
  date: string,
  overrides: Partial<DailyMovementPoint> = {},
): DailyMovementPoint {
  return {
    date,
    isTradingDay: true,
    movement: 200,
    movementPercent: 0.2,
    complete: true,
    reasons: [],
    ...overrides,
  };
}

function movements(days: DailyMovementPoint[]): DailyMovementsResponse {
  return { currencyCode: 'CAD', today: TODAY, days };
}

const onEditInvestment = vi.fn();
const onEditCashTransaction = vi.fn();
const onCreateOnDay = vi.fn();

function renderView(
  overrides: Partial<React.ComponentProps<typeof InvestmentCalendarView>> = {},
) {
  return render(
    <InvestmentCalendarView
      accounts={accounts}
      brokerageAccountIds={['brokerage-1']}
      cashAccountIds={['sleeve-1']}
      weekStartsOn={0}
      today={TODAY}
      onEditInvestment={onEditInvestment}
      onEditCashTransaction={onEditCashTransaction}
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

function withLayers(...layers: Array<'transactions' | 'values' | 'dailyChange'>) {
  useViewModeStore.setState({
    surfaces: {
      transactions: { view: 'table', layers: ['transactions'] },
      investments: { view: 'calendar', layers },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllTransactionPages.mockResolvedValue([]);
  mockGetAllPages.mockResolvedValue([]);
  mockGetInvestmentsDaily.mockResolvedValue([]);
  mockGetDailyMovements.mockResolvedValue(movements([]));
  mockListDayNotes.mockResolvedValue([]);
  useAuthStore.setState({ actingAsUserId: null });
  mockGetDailyMovementDetail.mockResolvedValue({
    date: '2026-06-11',
    currencyCode: 'CAD',
    movement: 200,
    movementPercent: 0.2,
    complete: true,
    reasons: [],
    gains: [],
    losses: [],
    unchangedCount: 0,
    remainder: 200,
  });
  withLayers('transactions');
});

describe('InvestmentCalendarView', () => {
  it('asks both registers for the grid range', async () => {
    renderView();

    await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
    expect(mockGetAllTransactionPages).toHaveBeenCalledWith({
      accountIds: 'brokerage-1',
      startDate: '2026-05-31',
      endDate: '2026-07-04',
    });
    expect(mockGetAllPages).toHaveBeenCalledWith({
      accountIds: ['sleeve-1'],
      startDate: '2026-05-31',
      endDate: '2026-07-04',
    });
  });

  it('asks the cash register nothing when the page has no linked sleeve', async () => {
    renderView({ cashAccountIds: [] });

    await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
    expect(mockGetAllPages).not.toHaveBeenCalled();
  });

  describe('the transactions layer', () => {
    it('draws a trade with its symbol, its action and its total', async () => {
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      renderView();

      const chip = await screen.findByRole('button', { name: /ABC/ });
      expect(within(cell('06/10/2026')).getByRole('button', { name: /ABC/ })).toBe(chip);
      expect(chip).toHaveTextContent('$505.00');
      expect(chip.className).toContain(ACCOUNT_TYPE_META.INVESTMENT.pillClass.split(' ')[0]);
    });

    it('opens the investment edit modal for the trade the reader clicked', async () => {
      const row = brokerageRow();
      mockGetAllTransactionPages.mockResolvedValue([row]);
      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /ABC/ }));

      expect(onEditInvestment).toHaveBeenCalledWith(row);
    });

    it('drops a cash leg whose trade is on screen, and keeps the trade (I5)', async () => {
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      mockGetAllPages.mockResolvedValue([
        cashRow({
          id: 'cash-leg',
          transactionDate: '2026-06-10',
          payeeName: 'ABC purchase',
          linkedInvestmentTransactionId: 'inv-1',
        }),
      ]);
      renderView();

      await screen.findByRole('button', { name: /ABC Buy/ });
      expect(screen.queryByRole('button', { name: /ABC purchase/ })).not.toBeInTheDocument();
    });

    it('keeps a cash leg whose trade is out of scope (I5)', async () => {
      mockGetAllTransactionPages.mockResolvedValue([]);
      mockGetAllPages.mockResolvedValue([
        cashRow({
          id: 'cash-leg',
          payeeName: 'ABC purchase',
          linkedInvestmentTransactionId: 'inv-1',
        }),
      ]);
      renderView();

      expect(await screen.findByRole('button', { name: /ABC purchase/ })).toBeInTheDocument();
    });

    it('keeps an ordinary cash deposit and opens the cash modal for it', async () => {
      const row = cashRow();
      mockGetAllPages.mockResolvedValue([row]);
      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /Payroll/ }));

      expect(onEditCashTransaction).toHaveBeenCalledWith(row);
    });

    it('starts a trade on the day the panel is showing', async () => {
      renderView();

      fireEvent.click(cell('06/10/2026'));
      fireEvent.click(
        await screen.findByRole('button', {
          name: calendarNs.day.newInvestmentTransaction,
        }),
      );

      expect(onCreateOnDay).toHaveBeenCalledWith('2026-06-10');
    });
  });

  describe('the values layer', () => {
    it('asks only for days up to today, whatever the grid shows', async () => {
      withLayers('transactions', 'values');
      renderView();

      await waitFor(() => expect(mockGetInvestmentsDaily).toHaveBeenCalled());
      expect(mockGetInvestmentsDaily).toHaveBeenCalledWith({
        startDate: '2026-05-31',
        endDate: TODAY,
        accountIds: 'brokerage-1',
        displayCurrency: undefined,
      });
    });

    it('prints a value on a day it knows and nothing after today', async () => {
      withLayers('transactions', 'values');
      mockGetInvestmentsDaily.mockResolvedValue([valuePoint('2026-06-15')]);
      renderView();

      expect(
        await within(cell('06/15/2026')).findByTestId('calendar-value-figure'),
      ).toHaveTextContent('$100000.00');
      // Decision 7: a market value is never projected, so a future day is blank
      // rather than unknown.
      expect(within(cell('06/20/2026')).queryByTestId('calendar-value-figure')).toBeNull();
      expect(within(cell('06/20/2026')).queryByTestId('unknown-amount')).toBeNull();
    });

    it('shows unknown, not a subtotal, when a holding had no price (example 6)', async () => {
      withLayers('transactions', 'values');
      mockGetInvestmentsDaily.mockResolvedValue([
        valuePoint('2026-06-15', {
          value: 40000,
          pricesComplete: false,
          unpricedSecurityIds: ['sec-1'],
        }),
      ]);
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      renderView();

      const dayCell = cell('06/15/2026');
      await waitFor(() =>
        expect(within(dayCell).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      expect(dayCell).not.toHaveTextContent('40000');

      // The banner names the security by its symbol, which is a price the
      // reader can add.
      expect(screen.getByText(/ABC/, { selector: 'li' })).toBeInTheDocument();

      fireEvent.click(dayCell);
      const panel = await screen.findByRole('complementary', { name: '06/15/2026' });
      expect(within(panel).getByText(/No price is available for ABC/)).toBeInTheDocument();
    });

    it('names a held security the month never traded, not its id', async () => {
      // The case example 6 actually describes: a position bought months ago and
      // unpriced ever since. It has no row in the month on screen, so the
      // month's own rows cannot name it and only the held set can. Printing the
      // id is a repair instruction the reader cannot follow.
      withLayers('transactions', 'values');
      mockGetAllTransactionPages.mockResolvedValue([]);
      mockGetInvestmentsDaily.mockResolvedValue([
        valuePoint('2026-06-15', {
          value: 40000,
          pricesComplete: false,
          unpricedSecurityIds: ['sec-gic'],
        }),
      ]);
      renderView({ heldSecurityLabels: new Map([['sec-gic', 'GIC-2029']]) });

      const dayCell = cell('06/15/2026');
      await waitFor(() =>
        expect(within(dayCell).getByTestId('unknown-amount')).toBeInTheDocument(),
      );

      expect(screen.getByText(/GIC-2029/, { selector: 'li' })).toBeInTheDocument();
      expect(screen.queryByText(/sec-gic/)).toBeNull();

      fireEvent.click(dayCell);
      const panel = await screen.findByRole('complementary', { name: '06/15/2026' });
      expect(within(panel).getByText(/No price is available for GIC-2029/)).toBeInTheDocument();
      expect(within(panel).queryByText(/sec-gic/)).toBeNull();
    });

    it('shows unknown and names the pair when a rate is missing', async () => {
      withLayers('transactions', 'values');
      mockGetInvestmentsDaily.mockResolvedValue([
        valuePoint('2026-06-15', {
          fxComplete: false,
          missingRatePairs: ['USD->CAD'],
        }),
      ]);
      renderView();

      await waitFor(() =>
        expect(within(cell('06/15/2026')).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      fireEvent.click(cell('06/15/2026'));
      const panel = await screen.findByRole('complementary', { name: '06/15/2026' });
      expect(within(panel).getByText(/USD->CAD/)).toBeInTheDocument();
    });

    it('reads an absent completeness flag as no information, never as withheld', async () => {
      withLayers('transactions', 'values');
      // An older backend mid-deploy sends neither flag.
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2026-06-15', value: 100000 } as DailyInvestmentValue,
      ]);
      renderView();

      expect(
        await within(cell('06/15/2026')).findByTestId('calendar-value-figure'),
      ).toBeInTheDocument();
    });

    it('asks nothing while the layer is off', async () => {
      renderView();

      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
      expect(mockGetInvestmentsDaily).not.toHaveBeenCalled();
    });

    it('leaves the transactions layer intact when only the values request fails', async () => {
      withLayers('transactions', 'values');
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      mockGetInvestmentsDaily.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.valuesFailed)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /ABC/ })).toBeInTheDocument();
    });
  });

  describe('when the month cannot be drawn', () => {
    it('withholds the layer past the row cap and says why', async () => {
      mockGetAllTransactionPages.mockResolvedValue(
        Array.from({ length: 1001 }, (_, i) => brokerageRow({ id: `inv-${i}` })),
      );
      renderView();

      expect(await screen.findByText(/more than the 1,?000/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /ABC/ })).not.toBeInTheDocument();
    });

    it('renders a retryable failure, never an empty month', async () => {
      mockGetAllTransactionPages.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.monthFailed)).toBeInTheDocument();
      expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    });
  });
  describe('the daily change layer', () => {
    it('asks only for days up to today', async () => {
      withLayers('dailyChange');
      renderView();

      await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
      expect(mockGetDailyMovements).toHaveBeenCalledWith({
        startDate: '2026-05-31',
        endDate: TODAY,
        accountIds: 'brokerage-1',
        displayCurrency: undefined,
      });
    });

    it('prints a complete day as a percentage (table B)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(movements([movementPoint('2026-06-11')]));
      renderView();

      const figure = await within(cell('06/11/2026')).findByTestId('calendar-change-figure');
      expect(figure).toHaveTextContent('0.20%');
      expect(figure.className).toContain('text-green-600');
    });

    it('colours a fall red and a flat session neutral', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-10', { movement: -100, movementPercent: -0.1 }),
          movementPoint('2026-06-11', { movement: 0, movementPercent: 0 }),
        ]),
      );
      renderView();

      const fall = await within(cell('06/10/2026')).findByTestId('calendar-change-figure');
      expect(fall.className).toContain('text-red-600');
      // Exactly zero is not a gain: a session that did not move is neutral.
      const flat = within(cell('06/11/2026')).getByTestId('calendar-change-figure');
      expect(flat.className).toContain('text-gray-500');
      expect(flat.className).not.toContain('text-green-600');
    });

    it('leaves a non-trading day blank, with no unknown marker (example 4)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-13', {
            isTradingDay: false,
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['notTradingDay'],
          }),
        ]),
      );
      renderView();

      await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
      const saturday = cell('06/13/2026');
      expect(within(saturday).queryByTestId('calendar-change-figure')).toBeNull();
      expect(within(saturday).queryByTestId('unknown-amount')).toBeNull();
    });

    it('leaves a zero-baseline day blank rather than unknown (example 5)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movementPercent: null,
            complete: false,
            reasons: ['zeroBaseline'],
          }),
        ]),
      );
      renderView();

      await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
      const day = cell('06/11/2026');
      expect(within(day).queryByTestId('calendar-change-figure')).toBeNull();
      expect(within(day).queryByTestId('unknown-amount')).toBeNull();
    });

    it('marks an unpriced trading day unknown (example 6)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['unpricedHolding'],
          }),
        ]),
      );
      renderView();

      await waitFor(() =>
        expect(within(cell('06/11/2026')).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      expect(within(cell('06/11/2026')).queryByTestId('calendar-change-figure')).toBeNull();
      // An unpriced holding IS a price to add, so this is the one reason the
      // marker's default was right about.
      expect(
        within(cell('06/11/2026')).getByRole('button', {
          name: commonNs.unknownAmount.noPrice,
        }),
      ).toBeInTheDocument();
    });

    it('points a missing rate at the rates, not at the security price', async () => {
      // The marker carries one of three causes for six server reasons, so the
      // mapping is made rather than assumed: telling a reader to add a price
      // when what is missing is a display rate sends them to the wrong screen.
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['missingRate'],
          }),
        ]),
      );
      renderView();

      const marker = await within(cell('06/11/2026')).findByTestId('unknown-amount');
      expect(marker).toBeInTheDocument();
      expect(
        within(cell('06/11/2026')).getByRole('button', {
          name: commonNs.unknownAmount.displayFx,
        }),
      ).toBeInTheDocument();
      expect(
        within(cell('06/11/2026')).queryByRole('button', {
          name: commonNs.unknownAmount.noPrice,
        }),
      ).toBeNull();
    });

    it('sends the scope\'s first day nowhere, because there is nothing to fix', async () => {
      // `decide` returns `noPriorValue` alone: the day before precedes the
      // scope's inception. Neither a price nor a rate is missing, so a marker
      // naming either invents an errand out of a boundary.
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['noPriorValue'],
          }),
        ]),
      );
      renderView();

      await waitFor(() =>
        expect(within(cell('06/11/2026')).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      expect(
        within(cell('06/11/2026')).getByRole('button', {
          name: commonNs.unknownAmount.noBaseline,
        }),
      ).toBeInTheDocument();
      expect(screen.getByText(calendarNs.change.reasons.noPriorValue)).toBeInTheDocument();
    });

    it('names every reason the month withheld a change for, in the banner', async () => {
      // The cell has one glyph and `DailyMovementDialog` opens only from a
      // percentage a COMPLETE day draws, so without the banner a withheld
      // change has no surface anywhere that says why.
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-10', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['missingRate'],
          }),
          movementPoint('2026-06-11', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['flowIncomplete'],
          }),
          // Blank, not withheld: there is nothing here for a reader to repair.
          movementPoint('2026-06-12', {
            movementPercent: null,
            complete: false,
            reasons: ['zeroBaseline'],
          }),
          // Likewise: a weekend had no session to report.
          movementPoint('2026-06-13', {
            isTradingDay: false,
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['notTradingDay'],
          }),
        ]),
      );
      renderView();

      expect(
        await screen.findByText(calendarNs.change.reasons.missingRate),
      ).toBeInTheDocument();
      expect(screen.getByText(calendarNs.change.reasons.flowIncomplete)).toBeInTheDocument();
      expect(screen.queryByText(calendarNs.change.reasons.zeroBaseline)).toBeNull();
      expect(screen.queryByText(calendarNs.change.reasons.notTradingDay)).toBeNull();
    });

    it('says nothing in the banner while the change layer is off', async () => {
      withLayers('transactions');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['missingRate'],
          }),
        ]),
      );
      renderView();

      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
      expect(screen.queryByText(calendarNs.change.reasons.missingRate)).toBeNull();
    });

    it('opens the breakdown for the day whose percentage was clicked', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(movements([movementPoint('2026-06-11')]));
      renderView();

      fireEvent.click(
        await within(cell('06/11/2026')).findByTestId('calendar-change-figure'),
      );

      await waitFor(() => expect(mockGetDailyMovementDetail).toHaveBeenCalled());
      expect(mockGetDailyMovementDetail).toHaveBeenCalledWith({
        date: '2026-06-11',
        accountIds: 'brokerage-1',
        displayCurrency: undefined,
      });
    });

    it('asks nothing while the layer is off', async () => {
      renderView();

      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
      expect(mockGetDailyMovements).not.toHaveBeenCalled();
    });

    it('leaves the other layers intact when only the movements request fails', async () => {
      withLayers('transactions', 'dailyChange');
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      mockGetDailyMovements.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.movementsFailed)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /ABC/ })).toBeInTheDocument();
    });
  });
  describe('day notes', () => {
    it('shows the same note the Transactions calendar shows for that date', async () => {
      // A note belongs to the day, not to a page: both calendars read one list
      // for the range they draw.
      mockListDayNotes.mockResolvedValue([
        { startDate: '2026-06-10', endDate: '2026-06-10', body: 'Ex-dividend date', updatedAt: '2026-06-09T12:00:00.000Z' },
      ]);

      const { unmount } = renderView();
      expect(
        await within(cell('06/10/2026')).findByTestId('calendar-day-note-marker'),
      ).toHaveTextContent('Ex-dividend date');
      unmount();

      useViewModeStore.setState({
        surfaces: {
          transactions: { view: 'calendar', layers: ['transactions'] },
          investments: { view: 'table', layers: ['transactions'] },
        },
      });

      render(
        <TransactionsCalendarView
          accounts={accounts}
          scheduledTransactions={[]}
          filters={{}}
          scopeAccountIds={[]}
          weekStartsOn={0}
          today={TODAY}
          categoryColorMap={new Map()}
          categoryIconMap={new Map()}
          categoryLabelMap={new Map()}
          onEditTransaction={vi.fn()}
          onCreateOnDay={vi.fn()}
        />,
      );

      expect(
        await within(cell('06/10/2026')).findByTestId('calendar-day-note-marker'),
      ).toHaveTextContent('Ex-dividend date');
    });

    it('offers no note surface at all in an acting-delegate session', async () => {
      useAuthStore.setState({ actingAsUserId: 'owner-1' });
      renderView();

      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
      expect(mockListDayNotes).not.toHaveBeenCalled();
    });
  });

  describe('swiping the grid', () => {
    it('turns the month the way it does on the Transactions calendar', async () => {
      // One gesture for both calendars: a reader who learns it on one page does
      // not have to learn it again on the other.
      renderView();
      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());

      await swipeGrid(-400);
      expect(await screen.findByRole('heading', { name: '07/2026' })).toBeInTheDocument();

      await swipeGrid(400);
      expect(await screen.findByRole('heading', { name: '06/2026' })).toBeInTheDocument();
    });

    it('claims the horizontal gesture, so a swipe does not leave the page instead', async () => {
      renderView();
      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());

      expect(screen.getByRole('grid').parentElement).toHaveAttribute(
        SWIPE_PAGINATE_ATTR,
        'true',
      );
    });
  });
});
