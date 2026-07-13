import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { useLoanRateEditing } from './useLoanRateEditing';
import { RateHistorySidebar } from './RateHistorySidebar';
import { Account } from '@/types/account';
import { LoanRateChange } from '@/types/loan-rate-change';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';

vi.mock('@/lib/loan-rate-changes', () => ({
  loanRateChangesApi: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    applyScheduledPayment: vi.fn(),
    detect: vi.fn(),
  },
}));

// Recharts needs a real layout width; stub it so the table (the part under
// test) renders deterministically in jsdom.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const account = {
  id: 'loan-1',
  accountType: 'MORTGAGE',
  currencyCode: 'CAD',
} as Account;

const rateChanges: LoanRateChange[] = [
  {
    id: 'rc-1',
    accountId: 'loan-1',
    effectiveDate: '2022-05-13',
    annualRate: 1.75,
    newPaymentAmount: 3200,
    source: 'initial',
    note: null,
  } as LoanRateChange,
  {
    id: 'rc-2',
    accountId: 'loan-1',
    effectiveDate: '2022-08-05',
    annualRate: 3.25,
    newPaymentAmount: null,
    source: 'inferred',
    note: null,
  } as LoanRateChange,
];

function Harness({ rows, onChanged }: { rows: LoanRateChange[]; onChanged: () => void }) {
  const editing = useLoanRateEditing(account, onChanged);
  return (
    <RateHistorySidebar
      account={account}
      rateChanges={rows}
      editing={editing}
      endDate="2025-03-28"
    />
  );
}

describe('RateHistorySidebar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists each recorded rate change with its rate, source badge, and payment', () => {
    render(<Harness rows={rateChanges} onChanged={() => {}} />);

    expect(screen.getByText('Rate History')).toBeInTheDocument();
    expect(screen.getByText('1.75%')).toBeInTheDocument();
    expect(screen.getByText('3.25%')).toBeInTheDocument();
    expect(screen.getByText('Initial')).toBeInTheDocument();
    expect(screen.getByText('Inferred')).toBeInTheDocument();
    // A row with no recorded payment shows "unchanged".
    expect(screen.getByText(/unchanged/)).toBeInTheDocument();
  });

  it('keeps the Add and Detect actions available even with no rate changes', () => {
    render(<Harness rows={[]} onChanged={() => {}} />);
    expect(screen.getByText(/No rate changes recorded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add rate change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detect from history' })).toBeInTheDocument();
  });

  it('detects rate changes from history after confirmation', async () => {
    (loanRateChangesApi.detect as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: rateChanges,
      replacedCount: 2,
      warnings: [],
    });
    const onChanged = vi.fn();
    render(<Harness rows={rateChanges} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Detect from history' }));
    const buttons = screen.getAllByRole('button', { name: 'Detect from history' });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(loanRateChangesApi.detect).toHaveBeenCalledWith('loan-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
