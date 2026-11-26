import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountInfoBar } from './AccountInfoBar';
import { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (val: number, currency: string) => `${currency} ${val.toFixed(2)}`,
    }),
  };
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const makeAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'a-1',
    name: 'Everyday Chequing',
    accountType: 'CHEQUING',
    currencyCode: 'CAD',
    institution: null,
    institutionId: null,
    currentBalance: 1234.5,
    isClosed: false,
    ...overrides,
  }) as Account;

describe('AccountInfoBar', () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it('shows the name and institution on the left and the live balance on the right', () => {
    render(
      <AccountInfoBar
        account={makeAccount()}
        currentBalance={-42}
        institution={{ id: 'i-1', name: 'Maple Bank' } as never}
        onEdit={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Everyday Chequing' })).toBeInTheDocument();
    expect(screen.getByText('Maple Bank')).toBeInTheDocument();
    expect(screen.getByText('CAD -42.00')).toBeInTheDocument();
  });

  it('marks a balance that includes an estimated amount, and not one that does not', () => {
    const { rerender } = render(
      <AccountInfoBar account={makeAccount({ provisionalCount: 1 })} onEdit={vi.fn()} onExpand={vi.fn()} />,
    );
    expect(screen.getByTestId('provisional-mark')).toBeInTheDocument();
    expect(screen.getByTestId('account-info-bar')).toHaveTextContent('CAD 1234.50');
    rerender(<AccountInfoBar account={makeAccount({ provisionalCount: 0 })} onEdit={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.queryByTestId('provisional-mark')).not.toBeInTheDocument();
    rerender(<AccountInfoBar account={makeAccount()} onEdit={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.queryByTestId('provisional-mark')).not.toBeInTheDocument();
  });

  it("falls back to the account's stored balance", () => {
    render(<AccountInfoBar account={makeAccount()} onEdit={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.getByText('CAD 1234.50')).toBeInTheDocument();
  });

  it('keeps only the expand chevron on a phone', () => {
    render(<AccountInfoBar account={makeAccount()} onEdit={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.getByLabelText('View account details')).toHaveClass('hidden', 'lg:inline-flex');
    expect(screen.getByLabelText('Edit account settings')).toHaveClass('hidden', 'lg:inline-flex');
    expect(screen.getByLabelText('Show account info')).not.toHaveClass('hidden');
  });

  it('offers the account switcher beside the name on every width', () => {
    render(
      <AccountInfoBar
        account={makeAccount()}
        switchableAccounts={[makeAccount(), makeAccount({ id: 'a-2', name: 'Savings' })]}
        onSwitchAccount={vi.fn()}
        onEdit={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Switch to another account' });
    // Nothing between the caret and the bar hides it below `lg`.
    expect(trigger.closest('.hidden')).toBeNull();
  });

  it('wires the details, edit and expand icons', () => {
    const onEdit = vi.fn();
    const onExpand = vi.fn();
    render(<AccountInfoBar account={makeAccount()} onEdit={onEdit} onExpand={onExpand} />);

    fireEvent.click(screen.getByLabelText('View account details'));
    expect(mockPush).toHaveBeenCalledWith('/accounts/a-1');
    fireEvent.click(screen.getByLabelText('Edit account settings'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Show account info'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('draws no card of its own when floating: the floating bar provides the surface', () => {
    render(<AccountInfoBar account={makeAccount()} onEdit={vi.fn()} onExpand={vi.fn()} floating />);
    const bar = screen.getByTestId('account-info-floating-bar');
    expect(bar.className).not.toMatch(/rounded|border|bg-|shadow|mb-4/);
    expect(screen.queryByTestId('account-info-bar')).not.toBeInTheDocument();
  });
});
