import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { TransferIncomeLineForm } from './TransferIncomeLineForm';
import type { Account } from '@/types/account';

const accounts = [
  { id: 'acc-hisa', name: 'HISA' },
  { id: 'acc-rrsp', name: 'RRSP' },
] as Account[];

describe('TransferIncomeLineForm (issue #2141)', () => {
  it('offers the given accounts and saves the chosen one with its amount', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <TransferIncomeLineForm
        accounts={accounts}
        currencyCode="CAD"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('From Account'), {
      target: { value: 'acc-hisa' },
    });
    const amount = screen.getByLabelText('Planned Amount');
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '2000' } });
    fireEvent.blur(amount);
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ transferAccountId: 'acc-hisa', amount: 2000 }),
    );
  });

  it('refuses to save without an account', async () => {
    const onSave = vi.fn();
    render(
      <TransferIncomeLineForm
        accounts={accounts}
        currencyCode="CAD"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Add'));

    expect(
      await screen.findByText('Choose the account the transfers come from'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
