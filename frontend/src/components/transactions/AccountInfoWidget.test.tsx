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

  it('renders optional fields and a closed badge when present', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({
          accountType: 'CREDIT_CARD',
          accountNumber: '****1234',
          creditLimit: 5000,
          interestRate: 19.99,
          isClosed: true,
        })}
        onEdit={vi.fn()} onCollapse={vi.fn()}
      />,
    );
    expect(screen.getByText('****1234')).toBeInTheDocument();
    expect(screen.getByText('CAD 5000.00')).toBeInTheDocument();
    expect(screen.getByText('19.99%')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
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

  it('omits optional fields that are absent', () => {
    render(<AccountInfoWidget account={makeAccount()} onEdit={vi.fn()} onCollapse={vi.fn()} />);
    expect(screen.queryByText('Account Number')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit Limit')).not.toBeInTheDocument();
    expect(screen.queryByText('Settlement Day')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment Due')).not.toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });
});
