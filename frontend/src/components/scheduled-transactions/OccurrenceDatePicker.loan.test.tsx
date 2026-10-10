import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { OccurrenceDatePicker } from './OccurrenceDatePicker';
import type { LoanOccurrence, LoanOccurrencesProjection } from '@/types/scheduled-transaction';

// Issue #1643: a loan bill's occurrences are priced at their own due dates by
// the server (INV-LOAN-009); the picker shows each date's amount, never the
// template's, and a failed request as failed.

const mockGetLoanOccurrences = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  LOAN_OCCURRENCES_MAX_COUNT: 60,
  scheduledTransactionsApi: {
    getLoanOccurrences: (...args: unknown[]) => mockGetLoanOccurrences(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number, currency: string) => `${currency} ${amount.toFixed(2)}`,
    }),
  };
});

const mortgage = { id: 'loan-1', name: 'Mortgage', accountType: 'MORTGAGE' };

// Timeline A of issue #1637: 584.59 at 5.0 %, 560.00 stated from 2023-04-15.
const loanBill = {
  id: 's1',
  name: 'Mortgage payment',
  nextDueDate: '2023-02-03',
  frequency: 'MONTHLY' as const,
  amount: -560,
  currencyCode: 'CAD',
  categoryId: null,
  description: null,
  isSplit: true,
  isTransfer: false,
  isInvestment: false,
  transferAccount: null,
  splits: [
    { id: 'i', categoryId: 'cat-interest', transferAccountId: null, transferAccount: null, amount: -375, memo: 'Interest' },
    { id: 'p', categoryId: null, transferAccountId: 'loan-1', transferAccount: mortgage, amount: -185, memo: 'Principal' },
  ],
} as any;

const row = (dueDate: string, amount: number | null, over: Partial<LoanOccurrence> = {}): LoanOccurrence => ({
  originalDate: dueDate,
  dueDate,
  overrideId: null,
  amount,
  principal: null,
  interest: null,
  extraPrincipal: amount === null ? null : 0,
  annualRate: null,
  debtBefore: null,
  complete: amount !== null,
  missing: null,
  ...over,
});

const timelineA: LoanOccurrencesProjection = {
  scheduledTransactionId: 's1',
  loanAccountId: 'loan-1',
  status: 'priced',
  currencyCode: 'CAD',
  occurrences: [
    row('2023-02-03', 584.59, { principal: 167.92, interest: 416.67 }),
    row('2023-03-03', 584.59, { principal: 168.62, interest: 415.97 }),
    row('2023-04-03', 584.59, { principal: 169.33, interest: 415.26 }),
    row('2023-05-03', 560, { principal: 186.9, interest: 373.1 }),
    row('2023-06-03', 560, { principal: 187.6, interest: 372.4 }),
  ],
};

const renderPicker = async (st = loanBill, onSelect = vi.fn()) => {
  await act(async () => {
    render(<OccurrenceDatePicker isOpen scheduledTransaction={st} onSelect={onSelect} onClose={vi.fn()} />);
  });
  return onSelect;
};

const rowFor = (date: string) => screen.getByText(date).closest('button') as HTMLButtonElement;

describe('OccurrenceDatePicker: a loan bill priced per occurrence (issue #1643)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows 584.59 for the first three dates of timeline A and 560.00 from 2023-05-03', async () => {
    mockGetLoanOccurrences.mockResolvedValue(timelineA);
    await renderPicker();

    expect(mockGetLoanOccurrences).toHaveBeenCalledWith('s1', 5);
    for (const date of ['2023-02-03', '2023-03-03', '2023-04-03']) {
      expect(rowFor(date)).toHaveTextContent('CAD 584.59');
    }
    for (const date of ['2023-05-03', '2023-06-03']) {
      expect(rowFor(date)).toHaveTextContent('CAD 560.00');
    }
    // The template holds 560.00; the dates before the change never show it.
    expect(screen.getAllByText('CAD 560.00')).toHaveLength(2);
  });

  it('marks the date the payment changes, and only that date', async () => {
    mockGetLoanOccurrences.mockResolvedValue(timelineA);
    await renderPicker();

    expect(screen.getAllByText('Payment changes')).toHaveLength(1);
    expect(rowFor('2023-05-03')).toHaveTextContent('Payment changes');
  });

  it('hands the chosen occurrence and its loan to the editor', async () => {
    mockGetLoanOccurrences.mockResolvedValue(timelineA);
    const onSelect = await renderPicker();

    fireEvent.click(rowFor('2023-05-03'));
    expect(onSelect).toHaveBeenCalledWith('2023-05-03', {
      loanAccountId: 'loan-1',
      occurrence: timelineA.occurrences[3],
    });
  });

  it('renders an unknown amount as unknown with the reason, never the template amount', async () => {
    mockGetLoanOccurrences.mockResolvedValue({
      ...timelineA,
      occurrences: [
        row('2023-02-03', 584.59),
        row('2023-03-03', null, { missing: { kind: 'rate', date: '2023-03-03' } }),
        row('2023-04-03', null, { missing: { kind: 'earlier-occurrence', originalDate: '2023-03-03' } }),
        row('2023-05-03', null, { missing: { kind: 'earlier-occurrence', originalDate: '2023-03-03' } }),
        row('2023-06-03', null, { missing: { kind: 'earlier-occurrence', originalDate: '2023-03-03' } }),
      ],
    });
    await renderPicker();

    expect(rowFor('2023-03-03')).toHaveTextContent('Payment unknown');
    expect(rowFor('2023-03-03')).toHaveTextContent(/No interest rate is recorded for 2023-03-03/);
    expect(rowFor('2023-04-03')).toHaveTextContent(/depends on the occurrence of 2023-03-03/);
    expect(rowFor('2023-03-03')).not.toHaveTextContent('560.00');
    expect(screen.queryByText('Payment changes')).not.toBeInTheDocument();
  });

  it('shows a failed request as failed, and a retry asks again', async () => {
    mockGetLoanOccurrences.mockRejectedValueOnce(new Error('503'));
    await renderPicker();

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(rowFor('2023-02-03')).not.toHaveTextContent('CAD');

    mockGetLoanOccurrences.mockResolvedValue(timelineA);
    await act(async () => {
      fireEvent.click(screen.getByText('Retry'));
    });
    expect(mockGetLoanOccurrences).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(rowFor('2023-02-03')).toHaveTextContent('CAD 584.59');
  });

  it('lists dates only for a loan bill the pricing declines', async () => {
    mockGetLoanOccurrences.mockResolvedValue({ ...timelineA, status: 'declined', occurrences: [] });
    const onSelect = await renderPicker();

    expect(rowFor('2023-02-03')).not.toHaveTextContent('CAD');
    fireEvent.click(rowFor('2023-02-03'));
    expect(onSelect).toHaveBeenCalledWith('2023-02-03');
  });

  it('does not ask for a projection for a bill that pays no loan', async () => {
    const rent = { ...loanBill, isSplit: false, splits: [], transferAccount: null };
    await renderPicker(rent);

    expect(mockGetLoanOccurrences).not.toHaveBeenCalled();
    expect(screen.queryByText(/Working out/)).not.toBeInTheDocument();
  });
});
