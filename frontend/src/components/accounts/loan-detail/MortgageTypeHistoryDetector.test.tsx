import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import toast from 'react-hot-toast';
import { MortgageTypeHistoryDetector } from './MortgageTypeHistoryDetector';
import { accountsApi } from '@/lib/accounts';
import type { Account, MortgageTypeHistoryDetection } from '@/types/account';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    detectMortgageTypeFromHistory: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const detect = vi.mocked(accountsApi.detectMortgageTypeFromHistory);

const account = {
  id: 'mortgage-1',
  accountType: 'MORTGAGE',
  currencyCode: 'CAD',
  mortgageType: 'ANNUITY',
} as Account;

const canadian: MortgageTypeHistoryDetection = {
  type: 'CANADIAN_FIXED',
  confidence: 'high',
  reason: 'CONSTANT_INSTALLMENT_SEMI_ANNUAL',
  quotedAnnualRate: 5.24,
  paymentFrequency: 'MONTHLY',
  samples: [
    { date: '2026-07-01', principal: 707.85, interest: 1662.15, balanceBefore: 385710.9 },
    { date: '2026-08-01', principal: 708.9, interest: 1661.1, balanceBefore: 385003.05 },
    { date: '2026-09-01', principal: 709.95, interest: 1660.05, balanceBefore: null },
  ],
};

async function runDetect() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Detect Mortgage Type' }));
  });
}

describe('MortgageTypeHistoryDetector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the suggestion, its reason and the installments it was read from', async () => {
    detect.mockResolvedValue(canadian);
    render(<MortgageTypeHistoryDetector account={account} onUseMortgageType={vi.fn()} />);
    await runDetect();

    expect(detect).toHaveBeenCalledWith('mortgage-1');
    const dialog = screen.getByRole('dialog', { name: 'Mortgage type from your payments' });
    expect(dialog).toHaveTextContent('Current type: Annuity (Level Payment)');
    expect(dialog).toHaveTextContent('Suggested type: Canadian Fixed Rate');
    expect(dialog).toHaveTextContent(
      'The total is the same every time, and the interest matches the quoted rate compounded twice a year.',
    );
    expect(dialog).toHaveTextContent('Interest rate in effect: 5.24%');
    expect(screen.getAllByRole('row')).toHaveLength(4);
    // A balance the server did not know is said to be unknown, not zero.
    expect(dialog).toHaveTextContent('Unknown');
  });

  it('hands the confirmed type to the edit form and saves nothing itself', async () => {
    detect.mockResolvedValue(canadian);
    const onUse = vi.fn();
    render(<MortgageTypeHistoryDetector account={account} onUseMortgageType={onUse} />);
    await runDetect();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Account With This Type' }));
    expect(onUse).toHaveBeenCalledWith('CANADIAN_FIXED');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancelling leaves the account alone', async () => {
    detect.mockResolvedValue(canadian);
    const onUse = vi.fn();
    render(<MortgageTypeHistoryDetector account={account} onUseMortgageType={onUse} />);
    await runDetect();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers no change when the suggestion is the type the mortgage already has', async () => {
    detect.mockResolvedValue({
      ...canadian,
      type: 'ANNUITY',
      reason: 'CONSTANT_INSTALLMENT_NOMINAL',
    });
    render(<MortgageTypeHistoryDetector account={account} onUseMortgageType={vi.fn()} />);
    await runDetect();

    expect(screen.getByText('This mortgage already has the suggested type.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit Account With This Type' }),
    ).not.toBeInTheDocument();
  });

  it('explains a refusal and an empty history', async () => {
    detect.mockResolvedValue({
      type: null,
      confidence: 'low',
      reason: 'TOO_FEW_SAMPLES',
      quotedAnnualRate: null,
      paymentFrequency: null,
      samples: [],
    });
    render(<MortgageTypeHistoryDetector account={account} onUseMortgageType={vi.fn()} />);
    await runDetect();

    expect(screen.getByText('No type suggested.')).toBeInTheDocument();
    expect(
      screen.getByText('At least two consecutive installments are needed to compare.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/No posted installment with both a principal and an interest part/)).toBeInTheDocument();
    expect(screen.getByText(/No interest rate is recorded for these dates/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit Account With This Type' }),
    ).not.toBeInTheDocument();
  });

  it('reports a failed request rather than an empty answer', async () => {
    detect.mockRejectedValue(new Error('network'));
    render(<MortgageTypeHistoryDetector account={account} onUseMortgageType={vi.fn()} />);
    await runDetect();

    expect(toast.error).toHaveBeenCalledWith(
      'The payment history could not be read because the request failed. Try again.',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
