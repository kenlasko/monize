import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountInfoWidget } from './AccountInfoWidget';
import { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number, currency: string) => `${currency} ${val.toFixed(2)}`,
    formatNumber: (val: number) => String(val),
  }),
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const makeAccount = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'a-1',
    name: 'Everyday Chequing',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    description: null,
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    institutionId: null,
    currentBalance: 1234.5,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    ...overrides,
  }) as Account;

describe('AccountInfoWidget', () => {
  it('shows the account name, balance and type', () => {
    render(<AccountInfoWidget account={makeAccount()} onEdit={vi.fn()} onCollapse={vi.fn()} />);
    expect(screen.getByText('Everyday Chequing')).toBeInTheDocument();
    expect(screen.getByText('CAD 1234.50')).toBeInTheDocument();
    expect(screen.getByText('Chequing')).toBeInTheDocument();
  });

  it('prefers the live chart-derived balance over the stale account balance', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ currentBalance: 1234.5 })}
        currentBalance={1500.25}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('CAD 1500.25')).toBeInTheDocument();
    expect(screen.queryByText('CAD 1234.50')).not.toBeInTheDocument();
  });

  it('shows a live balance of zero rather than falling back to the account balance', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ currentBalance: 1234.5 })}
        currentBalance={0}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('CAD 0.00')).toBeInTheDocument();
  });

  it('styles a negative live balance in red', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ currentBalance: 1234.5 })}
        currentBalance={-42}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    const amount = screen.getByText('CAD -42.00');
    expect(amount.className).toContain('text-red-600');
  });

  it('calls onEdit when the pencil button is clicked', () => {
    const onEdit = vi.fn();
    render(<AccountInfoWidget account={makeAccount()} onEdit={onEdit} onCollapse={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Edit account settings'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('calls onCollapse when the collapse button is clicked', () => {
    const onCollapse = vi.fn();
    render(<AccountInfoWidget account={makeAccount()} onEdit={vi.fn()} onCollapse={onCollapse} />);
    fireEvent.click(screen.getByLabelText('Hide account info'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('links to the account detail page from the details icon', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ id: 'loan-9', accountType: 'MORTGAGE' })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('View account details'));
    expect(mockPush).toHaveBeenCalledWith('/accounts/loan-9');
  });

  it('shows the details icon for every account type', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ id: 'chq-1', accountType: 'CHEQUING' })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('View account details'));
    expect(mockPush).toHaveBeenCalledWith('/accounts/chq-1');
  });

  it('renders optional fields and a closed badge when present', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({
          accountType: 'CREDIT_CARD',
          accountNumber: '4111111111111234',
          creditLimit: 5000,
          interestRate: 19.99,
          isClosed: true,
        })}
        onEdit={vi.fn()} onCollapse={vi.fn()}
      />,
    );
    // The credit-card number is masked to its first and last four digits.
    expect(screen.getByText('4111••••••••1234')).toBeInTheDocument();
    expect(screen.queryByText('4111111111111234')).not.toBeInTheDocument();
    expect(screen.getByText('CAD 5000.00')).toBeInTheDocument();
    expect(screen.getByText('19.99%')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('masks a non-credit-card account number to its last four digits', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ accountType: 'CHEQUING', accountNumber: '12345678' })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('••••5678')).toBeInTheDocument();
    expect(screen.queryByText('12345678')).not.toBeInTheDocument();
  });

  it('reveals and re-masks the account number via the eye toggle', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ accountType: 'CREDIT_CARD', accountNumber: '4111111111111234' })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('4111••••••••1234')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show account number'));
    expect(screen.getByText('4111111111111234')).toBeInTheDocument();
    expect(screen.queryByText('4111••••••••1234')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Hide account number'));
    expect(screen.getByText('4111••••••••1234')).toBeInTheDocument();
    expect(screen.queryByText('4111111111111234')).not.toBeInTheDocument();
  });

  it('re-masks the number when switching to another account', () => {
    const { rerender } = render(
      <AccountInfoWidget
        account={makeAccount({ id: 'a-1', accountNumber: '12345678' })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Show account number'));
    expect(screen.getByText('12345678')).toBeInTheDocument();

    // Switching accounts must not leak the previous account's revealed number.
    rerender(
      <AccountInfoWidget
        account={makeAccount({ id: 'a-2', accountNumber: '87654321' })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('••••4321')).toBeInTheDocument();
    expect(screen.queryByText('87654321')).not.toBeInTheDocument();
  });

  it('shows the institution name and logo when an institution is provided', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ institutionId: 'inst-1' })}
        institution={{ id: 'inst-1', name: 'TD Canada Trust', hasLogo: true }}
        onEdit={vi.fn()} onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('TD Canada Trust')).toBeInTheDocument();
    // The cached favicon is rendered with the institution name as alt text.
    expect(screen.getByRole('img', { name: 'TD Canada Trust' })).toBeInTheDocument();
  });

  it('links the institution logo to its website in a new tab', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ institutionId: 'inst-1' })}
        institution={{ id: 'inst-1', name: 'TD', hasLogo: true, website: 'https://td.com' }}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://td.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('does not render a logo link for a non-http(s) website scheme', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ institutionId: 'inst-1' })}
        institution={{ id: 'inst-1', name: 'TD', hasLogo: true, website: 'javascript:alert(1)' }}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('falls back to the legacy institution string when no entity is linked', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ institution: 'Legacy Bank' })}
        onEdit={vi.fn()} onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('Legacy Bank')).toBeInTheDocument();
  });

  it('shows statement settlement and due days as ordinals when populated', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({
          accountType: 'CREDIT_CARD',
          statementSettlementDay: 22,
          statementDueDay: 1,
        })}
        onEdit={vi.fn()} onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('Settlement Day')).toBeInTheDocument();
    expect(screen.getByText('22nd')).toBeInTheDocument();
    expect(screen.getByText('Payment Due')).toBeInTheDocument();
    expect(screen.getByText('1st')).toBeInTheDocument();
    // The settlement day carries an explanatory tooltip, as on the dashboard.
    expect(
      screen.getByLabelText(/last day of the billing cycle/i),
    ).toBeInTheDocument();
  });

  it('shows the soonest scheduled payment with payee, in red for a debit', () => {
    const scheduled = [
      { id: 's1', accountId: 'a-1', isActive: true, nextDueDate: '2026-07-15', amount: -120.5, currencyCode: 'CAD', payeeName: 'Landlord' },
      { id: 's2', accountId: 'a-1', isActive: true, nextDueDate: '2026-06-20', amount: -80, currencyCode: 'CAD', payee: { name: 'Hydro' } },
      { id: 's3', accountId: 'other', isActive: true, nextDueDate: '2026-06-01', amount: -999, currencyCode: 'CAD' },
    ] as any;
    render(
      <AccountInfoWidget
        account={makeAccount()}
        scheduledTransactions={scheduled}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('Next Payment')).toBeInTheDocument();
    // The 2026-06-20 bill is sooner than 2026-07-15; the other account is ignored.
    const amount = screen.getByText('CAD 80.00');
    expect(amount).toBeInTheDocument();
    expect(amount.className).toContain('text-red-600');
    // The payee for the soonest bill is shown.
    expect(screen.getByText('Hydro')).toBeInTheDocument();
    expect(screen.queryByText('Landlord')).not.toBeInTheDocument();
    expect(screen.queryByText('CAD 999.00')).not.toBeInTheDocument();
  });

  it('navigates to Bills & Deposits when the next payment is clicked', () => {
    mockPush.mockClear();
    const scheduled = [
      { id: 's1', accountId: 'a-1', isActive: true, nextDueDate: '2026-06-20', amount: -80, currencyCode: 'CAD', payeeName: 'Hydro' },
    ] as any;
    render(
      <AccountInfoWidget
        account={makeAccount()}
        scheduledTransactions={scheduled}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Next Payment'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('shows an incoming scheduled deposit in green', () => {
    const scheduled = [
      { id: 's1', accountId: 'a-1', isActive: true, nextDueDate: '2026-06-20', amount: 2500, currencyCode: 'CAD', payeeName: 'Employer' },
    ] as any;
    render(
      <AccountInfoWidget
        account={makeAccount()}
        scheduledTransactions={scheduled}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    const amount = screen.getByText('CAD 2500.00');
    expect(amount.className).toContain('text-green-600');
    expect(screen.getByText('Employer')).toBeInTheDocument();
  });

  it('uses the per-occurrence override date and amount when present', () => {
    const scheduled = [
      {
        id: 's1', accountId: 'a-1', isActive: true,
        nextDueDate: '2026-07-15', amount: -120.5, currencyCode: 'CAD',
        nextOverride: { overrideDate: '2026-05-01', amount: -42 },
      },
    ] as any;
    render(
      <AccountInfoWidget
        account={makeAccount()}
        scheduledTransactions={scheduled}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('CAD 42.00')).toBeInTheDocument();
  });

  it('ignores inactive scheduled transactions', () => {
    const scheduled = [
      { id: 's1', accountId: 'a-1', isActive: false, nextDueDate: '2026-06-20', amount: -80, currencyCode: 'CAD' },
    ] as any;
    render(
      <AccountInfoWidget
        account={makeAccount()}
        scheduledTransactions={scheduled}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(screen.queryByText('Next Payment')).not.toBeInTheDocument();
  });

  it('omits optional fields that are absent', () => {
    render(<AccountInfoWidget account={makeAccount()} onEdit={vi.fn()} onCollapse={vi.fn()} />);
    expect(screen.queryByText('Account Number')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit Limit')).not.toBeInTheDocument();
    expect(screen.queryByText('Settlement Day')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment Due')).not.toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });
});
