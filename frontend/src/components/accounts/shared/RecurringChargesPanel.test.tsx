import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@/test/render';
import { RecurringChargesPanel } from './RecurringChargesPanel';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
  };
});vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => d }),
}));

// The lazily-loaded scheduled-bill form is replaced with a stub that echoes the
// template it was given and can fire onSuccess.
const mockFormProps = vi.fn();
vi.mock('@/components/scheduled-transactions/ScheduledTransactionForm', () => ({
  ScheduledTransactionForm: (props: { templateTransaction?: unknown; onSuccess?: () => void }) => {
    mockFormProps(props.templateTransaction);
    return (
      <div data-testid="scheduled-form">
        <button type="button" onClick={() => props.onSuccess?.()}>
          save-bill
        </button>
      </div>
    );
  },
}));

// `getAll`/`getAllPages` are mocked purely so the panel can be caught reaching
// for them: detection is a server-side question now, and enumerating the
// account's transactions to answer it is the defect this suite guards.
const mockGetAll = vi.fn();
const mockGetAllPages = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getAllPages: (...a: unknown[]) => mockGetAllPages(...a),
    getRecurringCharges: (...a: unknown[]) => mockGetRecurringCharges(...a),
  },
}));

const mockGetScheduled = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...a: unknown[]) => mockGetScheduled(...a),
  },
}));

function charge(overrides: Record<string, unknown> = {}) {
  return {
    payeeName: 'Netflix',
    payeeId: 'pay-netflix',
    amounts: [15],
    dates: ['2026-04-01', '2026-05-01', '2026-06-01'],
    frequency: 'monthly',
    currentAmount: 15,
    previousAmount: 15,
    categoryName: 'Streaming',
    categoryId: 'cat-streaming',
    ...overrides,
  };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'st-1',
    accountId: 'acc-1',
    name: 'Rent',
    payeeName: 'Landlord',
    payeeId: 'pay-landlord',
    amount: -1200,
    currencyCode: 'CAD',
    frequency: 'MONTHLY',
    nextDueDate: '2026-07-01',
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRecurringCharges.mockResolvedValue([charge()]);
  mockGetScheduled.mockResolvedValue([schedule()]);
});

async function renderPanel() {
  await act(async () => {
    render(<RecurringChargesPanel accountId="acc-1" currencyCode="CAD" />);
  });
}

describe('RecurringChargesPanel', () => {
  it('lists scheduled bills for the account', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Landlord')).toBeInTheDocument());
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    // Expense: signed and coloured red.
    const amount = screen.getByText('-$1200.00');
    expect(amount).toBeInTheDocument();
    expect(amount.className).toContain('text-red-600');
    expect(screen.getByText(/Next due 2026-07-01/)).toBeInTheDocument();
  });

  it('describes a Custom schedule by its rule', async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({
        frequency: 'CUSTOM',
        customRecurrence: { unit: 'MONTH', interval: 1, monthDays: [1, 15] },
      }),
    ]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText(/Every month on the 1st and 15th/)).toBeInTheDocument());
  });

  it('colours scheduled bills by kind (income green, transfer blue)', async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({ id: 'inc', payeeName: 'Payroll', payeeId: 'pay-job', amount: 2500 }),
      schedule({
        id: 'xfer',
        payeeName: 'To Savings',
        payeeId: null,
        amount: -300,
        isTransfer: true,
        transferAccountId: 'sav-1',
      }),
    ]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Payroll')).toBeInTheDocument());

    const income = screen.getByText('+$2500.00');
    expect(income.className).toContain('text-green-600');

    // Transfers carry no +/- sign and are coloured blue.
    const transfer = screen.getByText('$300.00');
    expect(transfer.className).toContain('text-blue-600');
  });

  // Issue #1247: the amount shown is what the next occurrence would post today,
  // in the settlement currency, not the persisted snapshot.
  it("shows the server's effective amount for an FX-sensitive schedule", async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({
        id: 'st-inv',
        payeeName: 'Monthly ETF buy',
        payeeId: null,
        // The security-currency cash impact, pinned at 1.50 when it was EUR.
        amount: -1000,
        currencyCode: 'CAD',
        isInvestment: true,
        // The security is USD now, and USD -> CAD resolves at 1.35.
        effectiveAmount: -1350,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
      }),
    ]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Monthly ETF buy')).toBeInTheDocument(),
    );

    expect(screen.getByText('-$1350.00')).toBeInTheDocument();
    expect(screen.queryByText('-$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('-$1500.00')).not.toBeInTheDocument();
  });

  it('signs and colours the row by the occurrence, not the stored amount', async () => {
    // A mixed-sign split parent stored at -10 (an ordinary -100 line beside a
    // SELL line worth +90) whose investment line re-priced to +120: the occurrence
    // is an inflow of 20. Keyed off the stored sign, the row rendered '-$20.00'
    // in red -- the sign, the colour and the number describing two events.
    mockGetScheduled.mockResolvedValue([
      schedule({
        id: 'st-split',
        payeeName: 'Share sale, net of fee',
        payeeId: null,
        amount: -10,
        isSplit: true,
        splits: [
          { id: 'sp-1', kind: 'category', amount: -100 },
          { id: 'sp-2', kind: 'investment', amount: 90, investmentAction: 'SELL' },
        ],
        effectiveAmount: 20,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
      }),
    ]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Share sale, net of fee')).toBeInTheDocument(),
    );

    const amount = screen.getByText('+$20.00');
    expect(amount).toBeInTheDocument();
    expect(amount.className).toContain('text-green-600');
    expect(screen.queryByText('-$20.00')).not.toBeInTheDocument();
  });

  it('keeps an unpriceable bill a bill rather than a grey reminder', async () => {
    // `Number(null)` is 0, which `occurrenceKind` must not reach: the fallback is
    // the schedule's own sign, so the row stays red and marked unavailable.
    mockGetScheduled.mockResolvedValue([
      schedule({
        id: 'st-inv',
        payeeName: 'Monthly ETF buy',
        payeeId: null,
        amount: -1000,
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        // A top-level investment is one scalar times one positive rate, so the
        // server can still prove which way it goes.
        effectiveDirectionAmount: -1000,
        effectiveCurrencyCode: 'CAD',
      }),
    ]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Monthly ETF buy')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
    const row = screen.getByText('Monthly ETF buy').closest('li')!;
    expect(row.innerHTML).toContain('text-red-600');
  });

  it('shows no sign or colour for a direction the server could not derive', async () => {
    // A mixed-sign split whose investment line cannot be priced posts on either
    // side of zero: '+' green or '-' red would both be a guess with a symbol in
    // front of it (issue #1247 re-audit).
    mockGetScheduled.mockResolvedValue([
      schedule({
        id: 'st-split',
        payeeName: 'Sell shares, pay the fee',
        payeeId: null,
        amount: 10,
        isSplit: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveDirectionAmount: null,
        effectiveCurrencyCode: 'CAD',
      }),
    ]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Sell shares, pay the fee')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
    const row = screen.getByText('Sell shares, pay the fee').closest('li')!;
    expect(row.innerHTML).not.toContain('text-red-600');
    expect(row.innerHTML).not.toContain('text-green-600');
  });

  it('prints the date the occurrence actually falls on, not the recurrence slot', async () => {
    // An override addressed to the slot moved this occurrence, and the panel is
    // already sorted by the moved date -- printing `nextDueDate` beside the
    // re-priced amount announced a payment on a day the user had changed
    // (issue #1247).
    mockGetScheduled.mockResolvedValue([
      schedule({
        nextDueDate: '2026-07-01',
        nextOverride: {
          id: 'ovr-1',
          originalDate: '2026-07-01',
          overrideDate: '2026-07-10',
          amount: -1250,
          effectiveAmount: -1250,
        },
      }),
    ]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Landlord')).toBeInTheDocument());

    expect(screen.getByText(/Next due 2026-07-10/)).toBeInTheDocument();
    expect(screen.queryByText(/Next due 2026-07-01/)).not.toBeInTheDocument();
    // The amount on that line is the occurrence's own too.
    expect(screen.getByText('-$1250.00')).toBeInTheDocument();
  });

  it('marks an unresolvable occurrence unavailable, not stale', async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({
        id: 'st-inv',
        payeeName: 'Monthly ETF buy',
        payeeId: null,
        amount: -1000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveCurrencyCode: 'CAD',
      }),
    ]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Monthly ETF buy')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
    expect(screen.queryByText('-$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('-$1500.00')).not.toBeInTheDocument();
  });

  it('flags detected charges not already scheduled', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    expect(screen.getByText('Possible recurring charges')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(mockGetRecurringCharges).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1' }),
    );
  });

  it('does not flag a detected charge that matches a scheduled bill by payee', async () => {
    mockGetScheduled.mockResolvedValue([
      schedule({ id: 'st-2', payeeId: 'pay-netflix', payeeName: 'Netflix' }),
    ]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    // Netflix appears only as the scheduled bill, never as a "possible" charge.
    expect(screen.queryByText('Possible recurring charges')).not.toBeInTheDocument();
  });

  it('excludes scheduled bills from other accounts', async () => {
    mockGetScheduled.mockResolvedValue([schedule({ accountId: 'other-acc' })]);
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    expect(screen.queryByText('Landlord')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
  });

  it('filters out irregular cadences', async () => {
    mockGetRecurringCharges.mockResolvedValue([charge({ frequency: 'irregular' })]);
    mockGetScheduled.mockResolvedValue([]);
    await renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText('No recurring charges detected on this account'),
      ).toBeInTheDocument(),
    );
  });

  it('shows the empty state when detection finds nothing', async () => {
    mockGetRecurringCharges.mockResolvedValue([]);
    mockGetScheduled.mockResolvedValue([]);
    await renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText('No recurring charges detected on this account'),
      ).toBeInTheDocument(),
    );
  });

  // The panel used to read a year of the account's transactions, distil the
  // distinct payee ids and send those back as a query parameter. That request
  // grew with the account's payee cardinality: around 250 payees puts ~9 KB of
  // UUIDs in the URL, past the request-line limit of a typical proxy, and the
  // catch below turned the failure into "no recurring charges" -- the same
  // user-visible failure as issue #1229, at the next size threshold.
  it('asks by account, in a request whose size cannot grow with the account', async () => {
    await renderPanel();
    await waitFor(() => expect(mockGetRecurringCharges).toHaveBeenCalled());
    const small = mockGetRecurringCharges.mock.calls[0][0];

    // A far denser account: hundreds of distinct payees behind the same panel.
    vi.clearAllMocks();
    mockGetScheduled.mockResolvedValue([]);
    mockGetRecurringCharges.mockResolvedValue(
      Array.from({ length: 400 }, (_, i) =>
        charge({ payeeId: `pay-${i}`, payeeName: `Payee ${i}` }),
      ),
    );
    await renderPanel();
    await waitFor(() => expect(mockGetRecurringCharges).toHaveBeenCalled());
    const large = mockGetRecurringCharges.mock.calls[0][0];

    // Byte-identical: the request carries an account, never a list of ids.
    expect(JSON.stringify(large)).toEqual(JSON.stringify(small));
    expect(small).not.toHaveProperty('payeeIds');
  });

  it('never enumerates the account\'s transactions to build the request', async () => {
    await renderPanel();
    await waitFor(() => expect(mockGetRecurringCharges).toHaveBeenCalled());

    // Both doors to the register: neither is the way to ask this question.
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(mockGetAllPages).not.toHaveBeenCalled();
  });

  it('opens the pre-filled bill form for a detected charge and reloads on success', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Create a scheduled bill for Netflix'));
    });
    await waitFor(() => expect(screen.getByTestId('scheduled-form')).toBeInTheDocument());
    // The form is seeded with a negative (expense) amount and the charge's payee.
    expect(mockFormProps).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1', payeeId: 'pay-netflix', amount: -15 }),
    );

    // Saving closes the modal and re-fetches (scheduled + transactions again).
    const scheduledCallsBefore = mockGetScheduled.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByText('save-bill'));
    });
    await waitFor(() =>
      expect(mockGetScheduled.mock.calls.length).toBeGreaterThan(scheduledCallsBefore),
    );
  });
});
