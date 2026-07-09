import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
import { UpdateValueDialog } from './UpdateValueDialog';
import type { Account } from '@/types/account';

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
  }) => (
    <input
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  ),
}));
vi.mock('@/components/ui/DateInput', () => ({
  DateInput: ({ value, onDateChange }: { value: string; onDateChange: (v: string) => void }) => (
    <input aria-label="date" value={value} onChange={(e) => onDateChange(e.target.value)} />
  ),
}));

const mockCreate = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { create: (...a: unknown[]) => mockCreate(...a) },
}));

const asset = {
  id: 'asset-1',
  name: 'House',
  currencyCode: 'CAD',
  currentBalance: 120000,
  assetCategoryId: 'cat-1',
} as Account;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({});
});

describe('UpdateValueDialog', () => {
  it('disables save until the value changes', () => {
    render(<UpdateValueDialog isOpen onClose={vi.fn()} account={asset} onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('records the delta as an adjustment transaction', async () => {
    const onComplete = vi.fn();
    const onClose = vi.fn();
    render(
      <UpdateValueDialog isOpen onClose={onClose} account={asset} onComplete={onComplete} />,
    );

    fireEvent.change(screen.getByLabelText('New Value'), { target: { value: '130000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'asset-1',
        amount: 10000,
        currencyCode: 'CAD',
        categoryId: 'cat-1',
      }),
    );
    expect(onComplete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
