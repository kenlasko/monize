import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@/test/render';
import { PaymentSetupDialog } from './PaymentSetupDialog';
import type { Account } from '@/types/account';
import type { StatementCycle } from '@/types/credit-card-detail';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

const mockGetAll = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...a: unknown[]) => mockGetAll(...a) },
}));

const mockCreateTransfer = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { createTransfer: (...a: unknown[]) => mockCreateTransfer(...a) },
}));

const mockScheduledCreate = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { create: (...a: unknown[]) => mockScheduledCreate(...a) },
}));

const card = {
  id: 'cc-1',
  accountType: 'CREDIT_CARD',
  name: 'My Visa',
  currencyCode: 'CAD',
  currentBalance: -1200,
} as Account;

const cycle = { statementBalance: -1000, currencyCode: 'CAD' } as StatementCycle;

const chequing = {
  id: 'chq-1',
  accountType: 'CHEQUING',
  name: 'Everyday Chequing',
  currencyCode: 'CAD',
  isClosed: false,
} as Account;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAll.mockResolvedValue([card, chequing]);
  mockCreateTransfer.mockResolvedValue({});
  mockScheduledCreate.mockResolvedValue({});
});

async function open(props: Partial<React.ComponentProps<typeof PaymentSetupDialog>> = {}) {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  await act(async () => {
    render(
      <PaymentSetupDialog
        isOpen
        onClose={onClose}
        account={card}
        cycle={cycle}
        onComplete={onComplete}
        {...props}
      />,
    );
  });
  return { onClose, onComplete };
}

describe('PaymentSetupDialog', () => {
  it('records a one-time transfer from the funding account', async () => {
    const { onClose, onComplete } = await open();
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record Payment' }));
    });

    expect(mockCreateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: 'chq-1',
        toAccountId: 'cc-1',
        amount: 1000, // statement balance magnitude
        fromCurrencyCode: 'CAD',
      }),
    );
    expect(onComplete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('schedules a recurring monthly transfer', async () => {
    await open();
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Schedule monthly' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule Payment' }));
    });

    expect(mockScheduledCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'chq-1',
        transferAccountId: 'cc-1',
        isTransfer: true,
        frequency: 'MONTHLY',
        amount: -1000,
      }),
    );
  });

  it('shows a hint when there is no same-currency funding account', async () => {
    mockGetAll.mockResolvedValue([card]); // no funding account
    await open();
    await waitFor(() =>
      expect(
        screen.getByText(/No same-currency chequing, savings, or cash account/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
  });
});
