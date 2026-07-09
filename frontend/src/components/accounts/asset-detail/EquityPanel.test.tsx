import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
import { EquityPanel } from './EquityPanel';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: () => <div data-testid="equity-chart" />,
}));

const mockUpdate = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { update: (...a: unknown[]) => mockUpdate(...a) },
}));

const asset = { id: 'asset-1', name: 'House', currencyCode: 'CAD', currentBalance: 500000 } as Account;
const loan = {
  id: 'loan-1',
  name: 'Mortgage',
  accountType: 'MORTGAGE',
  currencyCode: 'CAD',
  currentBalance: -300000,
} as Account;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({});
});

describe('EquityPanel', () => {
  it('links a chosen loan', async () => {
    const onChanged = vi.fn();
    render(
      <EquityPanel
        account={asset}
        linkedLoan={null}
        loanOptions={[loan]}
        assetValue={500000}
        equitySeries={[]}
        currency="CAD"
        isLoading={false}
        onChanged={onChanged}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'loan-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link Loan' }));
    });
    expect(mockUpdate).toHaveBeenCalledWith('asset-1', { linkedLoanAccountId: 'loan-1' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the equity breakdown and unlinks', async () => {
    const onChanged = vi.fn();
    render(
      <EquityPanel
        account={asset}
        linkedLoan={loan}
        loanOptions={[loan]}
        assetValue={500000}
        equitySeries={[{ date: '2026-01-01', balance: 200000 }]}
        currency="CAD"
        isLoading={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('$500000.00')).toBeInTheDocument(); // asset value
    expect(screen.getByText('$300000.00')).toBeInTheDocument(); // loan owed
    expect(screen.getByText('$200000.00')).toBeInTheDocument(); // equity
    expect(screen.getByText('Linked to Mortgage')).toBeInTheDocument();
    expect(screen.getByTestId('equity-chart')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    });
    expect(mockUpdate).toHaveBeenCalledWith('asset-1', { linkedLoanAccountId: null });
  });

  it('shows a hint when there are no loans to link', () => {
    render(
      <EquityPanel
        account={asset}
        linkedLoan={null}
        loanOptions={[]}
        assetValue={500000}
        equitySeries={[]}
        currency="CAD"
        isLoading={false}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByText('No loan or mortgage accounts are available to link.'),
    ).toBeInTheDocument();
  });
});
