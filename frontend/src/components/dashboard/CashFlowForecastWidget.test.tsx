import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { CashFlowForecastWidget } from './CashFlowForecastWidget';
import type { CashFlowForecastConfig } from './widget-config';
import type { Account } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

const mockUpdateConfig = vi.fn();
// Typed as the stored preference can hold it, not as the widget wants it, so a
// case can store a value that is not a period.
const configState: { current: Omit<CashFlowForecastConfig, 'period'> & { period: string } } = {
  current: { period: 'month', accountIds: [] },
};
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig: mockUpdateConfig }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, c?: string) => `${c ?? ''} ${n.toFixed(2)}`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
    defaultCurrency: 'CAD',
  }),
}));

const mockGetTransactions = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAll: (...a: unknown[]) => mockGetTransactions(...a) },
}));

// The real builders, recorded: the widget's job is to hand them the same
// inputs the Bills & Deposits chart does.
const forecastSpies = vi.hoisted(() => ({
  buildForecast: vi.fn(),
  buildMultiAccountForecast: vi.fn(),
}));
vi.mock('@/lib/forecast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/forecast')>();
  forecastSpies.buildForecast.mockImplementation(actual.buildForecast);
  forecastSpies.buildMultiAccountForecast.mockImplementation(actual.buildMultiAccountForecast);
  return {
    ...actual,
    buildForecast: forecastSpies.buildForecast,
    buildMultiAccountForecast: forecastSpies.buildMultiAccountForecast,
  };
});

const account = (overrides: Partial<Account>): Account =>
  ({
    id: 'acc-chq',
    name: 'Chequing',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'CAD',
    currentBalance: 1000,
    isClosed: false,
    isFavourite: false,
    ...overrides,
  }) as Account;

const ACCOUNTS: Account[] = [
  account({ id: 'acc-chq', name: 'Chequing' }),
  account({ id: 'acc-sav', name: 'Savings', currentBalance: 5000 }),
  account({ id: 'acc-house', name: 'House', accountType: 'ASSET' }),
];

/** A local `YYYY-MM-DD` some days from now. */
const daysAhead = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const FUTURE_ROWS = [
  {
    id: 'tx-rent',
    accountId: 'acc-chq',
    payeeName: 'Landlord',
    amount: '-400.0000',
    status: 'UNRECONCILED',
    transactionDate: `${daysAhead(3)}T00:00:00.000Z`,
  },
  {
    id: 'tx-void',
    accountId: 'acc-chq',
    payeeName: 'Voided',
    amount: '-999.0000',
    status: 'VOID',
    transactionDate: `${daysAhead(4)}T00:00:00.000Z`,
  },
];

async function renderWidget(props: Partial<Parameters<typeof CashFlowForecastWidget>[0]> = {}) {
  await act(async () => {
    render(
      <CashFlowForecastWidget
        scheduledTransactions={[]}
        accounts={ACCOUNTS}
        isLoading={false}
        {...props}
      />,
    );
  });
}

describe('CashFlowForecastWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.current = { period: 'month', accountIds: [] };
    mockGetTransactions.mockResolvedValue({ data: FUTURE_ROWS });
  });

  it('titles the widget and links the title to Bills & Deposits', async () => {
    await renderWidget();
    expect(screen.getByRole('link', { name: 'Cash Flow Forecast' })).toHaveAttribute('href', '/bills');
  });

  it('layers the posted future-dated rows onto the forecast, without the VOID one', async () => {
    await renderWidget({ accounts: [ACCOUNTS[0]] });

    expect(mockGetTransactions).toHaveBeenCalledWith({ startDate: daysAhead(1), limit: 200 });
    const futureArg = forecastSpies.buildForecast.mock.calls.at(-1)![4];
    expect(futureArg).toEqual([
      { id: 'tx-rent', accountId: 'acc-chq', name: 'Landlord', amount: -400, date: daysAhead(3) },
    ]);
    // The starting figure is the current balance and the ending one has the
    // future row in it.
    expect(screen.getByText('Starting').nextElementSibling).toHaveTextContent('CAD 1000.00');
    expect(screen.getByText('Ending').nextElementSibling).toHaveTextContent('CAD 600.00');
  });

  // Discussion #1784: an occurrence due before today and neither posted nor
  // skipped is still owed, so the widget's forecast applies it on today, as the
  // Bills & Deposits chart does.
  describe('overdue scheduled occurrences', () => {
    const overdueBill = (overrides: Partial<ScheduledTransaction> = {}) =>
      ({
        id: 'st-hydro',
        name: 'Hydro',
        amount: -250,
        frequency: 'ONCE',
        nextDueDate: daysAhead(-5),
        isActive: true,
        isTransfer: false,
        transferAccountId: null,
        isSplit: false,
        splits: [],
        endDate: null,
        occurrencesRemaining: null,
        nextOverride: null,
        accountId: 'acc-chq',
        ...overrides,
      }) as ScheduledTransaction;

    it('applies the overdue occurrence on today without moving the starting figure', async () => {
      await renderWidget({ accounts: [ACCOUNTS[0]], scheduledTransactions: [overdueBill()] });

      const { points } = forecastSpies.buildForecast.mock.results.at(-1)!.value;
      expect(points[0].date).toBe(daysAhead(0));
      expect(points[0].transactions).toEqual([
        expect.objectContaining({ amount: -250, overdueOriginalDate: daysAhead(-5) }),
      ]);
      // Starting is the balance the account shows; the overdue bill and the
      // future-dated rent are both in the ending figure.
      expect(screen.getByText('Starting').nextElementSibling).toHaveTextContent('CAD 1000.00');
      expect(screen.getByText('Ending').nextElementSibling).toHaveTextContent('CAD 350.00');
    });

    it('applies it on today in the one-line-per-account view too', async () => {
      configState.current = { period: 'month', accountIds: ['acc-chq', 'acc-sav'] };
      await renderWidget({ scheduledTransactions: [overdueBill({ accountId: 'acc-sav' })] });

      const { points } = forecastSpies.buildMultiAccountForecast.mock.results.at(-1)!.value;
      expect(points[0].date).toBe(daysAhead(0));
      expect(points[0].balances['acc-sav']).toBe(4750);
      expect(points[0].transactions).toEqual([
        expect.objectContaining({
          accountId: 'acc-sav',
          amount: -250,
          overdueOriginalDate: daysAhead(-5),
        }),
      ]);
      expect(screen.getByText('Starting').nextElementSibling).toHaveTextContent('CAD 6000.00');
    });
  });

  it('waits for the dashboard to load before fetching, and shows a placeholder', async () => {
    await renderWidget({ isLoading: true });
    expect(mockGetTransactions).not.toHaveBeenCalled();
    expect(screen.getByTestId('cash-flow-forecast-widget-loading')).toBeInTheDocument();
    expect(screen.queryByText('Starting')).not.toBeInTheDocument();
  });

  it('says the forecast cannot be shown when the scheduled transactions failed to load', async () => {
    await renderWidget({ error: true });
    expect(screen.getByText(/Couldn't load the transactions already dated after today/)).toBeInTheDocument();
  });

  it('says the forecast cannot be shown when the future-dated rows fail to load', async () => {
    mockGetTransactions.mockRejectedValue(new Error('boom'));
    await renderWidget();
    expect(
      screen.getByText(/Couldn't load the transactions already dated after today/),
    ).toBeInTheDocument();
    // Never a forecast projected from a balance missing those rows.
    expect(screen.queryByText('Starting')).not.toBeInTheDocument();
  });

  it('projects over the configured period and switches it from the header', async () => {
    configState.current = { period: '90days', accountIds: [] };
    await renderWidget();
    expect(forecastSpies.buildForecast.mock.calls.at(-1)![2]).toBe('90days');
    expect(screen.getByRole('button', { name: '90D' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '1Y' }));
    expect(mockUpdateConfig).toHaveBeenCalledWith({ period: 'year' });
  });

  it('falls back to the default period when the stored one is not a period', async () => {
    configState.current = { period: '3m', accountIds: [] };
    await renderWidget();
    expect(forecastSpies.buildForecast.mock.calls.at(-1)![2]).toBe('month');
  });

  it('draws one line per configured account', async () => {
    configState.current = { period: 'month', accountIds: ['acc-sav', 'acc-chq'] };
    await renderWidget();
    const call = forecastSpies.buildMultiAccountForecast.mock.calls.at(-1)!;
    // Picker order (alphabetical here), not the stored order.
    expect(call[3]).toEqual(['acc-chq', 'acc-sav']);
    expect(screen.getByRole('list', { name: 'Forecast lines' })).toBeInTheDocument();
  });

  it('offers only forecastable accounts in its settings and saves a new selection', async () => {
    await renderWidget();
    fireEvent.click(screen.getByLabelText('Configure Cash Flow Forecast'));
    fireEvent.click(screen.getByLabelText('Accounts to forecast'));

    const labels = Array.from(document.querySelectorAll('input[type="checkbox"]')).map(
      (input) => input.closest('label')?.textContent ?? '',
    );
    expect(labels).toEqual(['Chequing', 'Savings']);

    const savings = Array.from(document.querySelectorAll('label')).find(
      (label) => label.textContent === 'Savings',
    )!;
    fireEvent.click(savings.querySelector('input') as HTMLInputElement);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ accountIds: ['acc-sav'] });
  });
});
