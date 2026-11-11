import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@/test/render';
import { ScheduledTransactionForm } from './ScheduledTransactionForm';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { accountsApi } from '@/lib/accounts';

// The Custom frequency in the scheduled-transaction form
// (docs/specs/custom-recurrence.md): the editor under the frequency, the rule
// it saves, the first occurrence beside the due date, the warning that a new
// pattern deletes edited occurrences, and where Custom is not offered.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'EUR' }) };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateForDate: vi.fn().mockResolvedValue(null),
    getCurrencies: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/components/transactions/CurrencyPickerButton', () => ({
  CurrencyPickerButton: () => <div data-testid="currency-picker" />,
}));

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const main = {
  id: ACCOUNT_ID,
  name: 'Main',
  currencyCode: 'EUR',
  isClosed: false,
  accountType: 'CHEQUING',
  accountSubType: null,
  scheduledTransactionId: null,
};

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn() },
}));
vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));
vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: vi.fn().mockResolvedValue([]), create: vi.fn(), getById: vi.fn() },
}));
vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: vi.fn().mockResolvedValue([]), getUsage: vi.fn().mockResolvedValue({}), create: vi.fn() },
}));
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { create: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurities: vi.fn().mockResolvedValue([]), getSecurityPrices: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

/** A monthly bill on the 1st; 2026-11-01 is a Sunday. */
const monthly = {
  id: 'sched-1',
  name: 'Rent',
  accountId: ACCOUNT_ID,
  account: main,
  payeeId: null,
  payeeName: null,
  categoryId: null,
  amount: -1200,
  currencyCode: 'EUR',
  description: '',
  frequency: 'MONTHLY',
  customRecurrence: null,
  nextDueDate: '2026-11-01',
  startDate: '2026-01-01',
  endDate: null,
  occurrencesRemaining: null,
  isActive: true,
  autoPost: false,
  reminderDaysBefore: 3,
  isTransfer: false,
  isSplit: false,
  tagIds: [],
  splits: [],
} as any;

const monWedFri = { unit: 'WEEK', interval: 1, weekdays: [1, 3, 5], weekStartsOn: 1 };

async function renderForm(scheduledTransaction?: any) {
  await act(async () => {
    render(<ScheduledTransactionForm scheduledTransaction={scheduledTransaction} />);
  });
}

async function chooseFrequency(value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value } });
  });
}

async function save() {
  await act(async () => {
    fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
  });
  await act(async () => {});
}

function frequencyValues(): string[] {
  return Array.from((screen.getByLabelText('Frequency') as HTMLSelectElement).options).map((o) => o.value);
}

describe('ScheduledTransactionForm: the Custom frequency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accountsApi.getAll).mockResolvedValue([main] as never);
    vi.mocked(scheduledTransactionsApi.update).mockResolvedValue({} as never);
  });

  it('offers Custom after Every 2 Years and shows no editor until it is chosen', async () => {
    await renderForm(monthly);
    expect(frequencyValues().slice(-2)).toEqual(['EVERY2YEARS', 'CUSTOM']);
    expect(screen.queryByRole('group', { name: 'Repeats' })).not.toBeInTheDocument();
  });

  it('starts a first Custom choice on the due date\'s weekday, every week, and saves the rule', async () => {
    await renderForm(monthly);
    await chooseFrequency('CUSTOM');
    expect(screen.getByRole('group', { name: 'Repeats' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sunday' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Every week on Sun')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    });
    await save();
    await waitFor(() => expect(scheduledTransactionsApi.update).toHaveBeenCalled());
    expect(vi.mocked(scheduledTransactionsApi.update).mock.calls[0][1]).toMatchObject({
      frequency: 'CUSTOM',
      customRecurrence: { unit: 'WEEK', interval: 1, weekdays: [3, 7], weekStartsOn: 1 },
    });
  });

  it('keeps each unit\'s days while the user switches between units', async () => {
    await renderForm(monthly);
    await chooseFrequency('CUSTOM');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    });
    // A first Monthly choice starts on the due date's day of the month.
    expect(screen.getByText('Every month on the 1st')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    });
    expect(screen.getByRole('button', { name: 'Sunday' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('refuses to save a rule with no day picked, saying why', async () => {
    await renderForm(monthly);
    await chooseFrequency('CUSTOM');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one day of the week.');
    await save();
    expect(scheduledTransactionsApi.update).not.toHaveBeenCalled();
  });

  it('loads a Custom schedule\'s rule, and sends null when the frequency moves off Custom', async () => {
    await renderForm({ ...monthly, frequency: 'CUSTOM', customRecurrence: monWedFri, nextDueDate: '2026-11-13' });
    expect(screen.getByText('Every week on Mon, Wed, and Fri')).toBeInTheDocument();
    expect(screen.getByText('Next occurrence: 2026-11-13')).toBeInTheDocument();

    await chooseFrequency('MONTHLY');
    expect(screen.queryByRole('group', { name: 'Repeats' })).not.toBeInTheDocument();
    await save();
    await waitFor(() => expect(scheduledTransactionsApi.update).toHaveBeenCalled());
    expect(vi.mocked(scheduledTransactionsApi.update).mock.calls[0][1]).toMatchObject({
      frequency: 'MONTHLY',
      customRecurrence: null,
    });
  });

  it('refuses to save a Custom schedule that arrived without a rule until one is picked', async () => {
    await renderForm({ ...monthly, frequency: 'CUSTOM', customRecurrence: null });
    expect(screen.getByRole('group', { name: 'Repeats' })).toBeInTheDocument();
    await save();
    expect(scheduledTransactionsApi.update).not.toHaveBeenCalled();
    expect(screen.getByText('This pattern cannot be saved. Pick the days again.')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    });
    await save();
    await waitFor(() => expect(scheduledTransactionsApi.update).toHaveBeenCalled());
    expect(vi.mocked(scheduledTransactionsApi.update).mock.calls[0][1]).toMatchObject({
      customRecurrence: { unit: 'WEEK', interval: 1, weekdays: [1, 7], weekStartsOn: 1 },
    });
  });

  it('sends the loaded rule back unchanged on an unedited save', async () => {
    await renderForm({ ...monthly, frequency: 'CUSTOM', customRecurrence: monWedFri, nextDueDate: '2026-11-13' });
    await save();
    await waitFor(() => expect(scheduledTransactionsApi.update).toHaveBeenCalled());
    expect(vi.mocked(scheduledTransactionsApi.update).mock.calls[0][1]).toMatchObject({
      customRecurrence: monWedFri,
    });
  });

  it('shows a new schedule\'s first occurrence beside the due date', async () => {
    await renderForm();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Next Due Date'), { target: { value: '2026-11-12' } });
      fireEvent.blur(screen.getByLabelText('Next Due Date'));
    });
    await chooseFrequency('CUSTOM');
    // 2026-11-12 is a Thursday, which the fresh rule picks.
    expect(screen.getByText('First occurrence: 2026-11-12')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    });
    expect(screen.getByText('First occurrence: 2026-11-13')).toBeInTheDocument();
  });

  it('shows the due date the server stores: as typed while the rule is unchanged, even off the pattern', async () => {
    await renderForm({ ...monthly, frequency: 'CUSTOM', customRecurrence: monWedFri, nextDueDate: '2026-11-13' });
    // Thursday 12 November is no Mon/Wed/Fri; the server keeps it as typed.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Next Due Date'), { target: { value: '2026-11-12' } });
      fireEvent.blur(screen.getByLabelText('Next Due Date'));
    });
    expect(
      screen.getByText('Next occurrence: 2026-11-12. This date is off the pattern; later occurrences follow it.'),
    ).toBeInTheDocument();

    // A rule change re-snaps it onto the pattern, as the server does.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    });
    expect(screen.getByText('Next occurrence: 2026-11-12')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    });
    expect(screen.getByText('Next occurrence: 2026-11-13')).toBeInTheDocument();
  });

  it('warns, before the save, of edited occurrences the new pattern no longer reaches', async () => {
    await renderForm({
      ...monthly,
      futureOverrides: [
        { id: 'o1', originalDate: '2026-12-01', overrideDate: '2026-12-02' },
        { id: 'o2', originalDate: '2027-01-01', overrideDate: '2027-01-01' },
      ],
    });
    // Still monthly on the 1st: both edits stay on the schedule.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await chooseFrequency('CUSTOM');
    // Every Sunday: 1 Dec 2026 is a Tuesday and 1 Jan 2027 a Friday.
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 edited occurrences (2026-12-01 and 2027-01-01) no longer fall on this pattern and will be removed when you save.',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 edited occurrence (2026-12-01) no longer falls on this pattern and will be removed when you save.',
    );
  });

  it.each([
    ['transfer', { isTransfer: true, transferAccountId: '44444444-4444-4444-8444-444444444444' }],
    [
      'split',
      {
        isSplit: true,
        splits: [
          { id: 's1', categoryId: null, transferAccountId: null, amount: -600, memo: '' },
          { id: 's2', categoryId: null, transferAccountId: null, amount: -600, memo: '' },
        ],
      },
    ],
    ['investment', { isInvestment: true, investmentAction: 'BUY' }],
  ])('shows the same editor in %s mode', async (_mode, shape) => {
    await renderForm({ ...monthly, ...shape, frequency: 'CUSTOM', customRecurrence: monWedFri });
    expect(screen.getByRole('group', { name: 'Repeats' })).toBeInTheDocument();
    expect(screen.getByText('Every week on Mon, Wed, and Fri')).toBeInTheDocument();
  });

  it('does not offer Custom for a loan\'s payment schedule', async () => {
    vi.mocked(accountsApi.getAll).mockResolvedValue([
      main,
      { ...main, id: 'loan-1', name: 'Car loan', accountType: 'LOAN', scheduledTransactionId: 'sched-1' },
    ] as never);
    await renderForm(monthly);
    expect(frequencyValues()).not.toContain('CUSTOM');
  });

  describe('a split with a leg into a loan', () => {
    const loan = { ...main, id: '55555555-5555-4555-8555-555555555555', name: 'Mortgage', accountType: 'MORTGAGE' };
    const splitIntoLoan = {
      ...monthly,
      isSplit: true,
      splits: [
        { id: 's1', categoryId: null, transferAccountId: loan.id, amount: -1000, memo: '' },
        { id: 's2', categoryId: null, transferAccountId: null, amount: -200, memo: '' },
      ],
    };

    beforeEach(() => {
      vi.mocked(accountsApi.getAll).mockResolvedValue([main, loan] as never);
    });

    it('does not offer Custom, which the server refuses there', async () => {
      await renderForm(splitIntoLoan);
      expect(frequencyValues()).not.toContain('CUSTOM');
    });

    it('keeps Custom on a schedule already Custom, saying why it cannot stay', async () => {
      await renderForm({ ...splitIntoLoan, frequency: 'CUSTOM', customRecurrence: monWedFri });
      expect(frequencyValues()).toContain('CUSTOM');
      expect(
        screen.getByText('A loan or mortgage payment cannot use a custom frequency; choose a fixed frequency.'),
      ).toBeInTheDocument();
    });
  });

  it('does not offer Custom for a payroll schedule with deduction rules', async () => {
    await renderForm({ ...monthly, payrollDeductions: [{ ruleId: 'r1' }] });
    expect(frequencyValues()).not.toContain('CUSTOM');
  });
});
