import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@/test/render';
import { AccountInfoWidget } from './AccountInfoWidget';
import { Account } from '@/types/account';
import type { Transaction } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (val: number, currency: string) => `${currency} ${val.toFixed(2)}`,
      formatNumber: (val: number) => String(val),
    }),
  };
});

// The loan/mortgage rows derive from the account's payment history, so the two
// APIs that supply it are stubbed here; non-debt accounts never reach them.
const getAllTransactions = vi.fn();
const getAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => getAllTransactions(...args),
    getAllPages: (...args: unknown[]) => getAllPages(...args),
  },
}));

const getRateChanges = vi.fn();
vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: {
    getAll: (...args: unknown[]) => getRateChanges(...args),
  },
}));

beforeEach(() => {
  getAllTransactions.mockReset().mockResolvedValue({
    data: [] as Transaction[],
    pagination: { hasMore: false },
  });
  getAllPages.mockReset().mockResolvedValue([] as Transaction[]);
  getRateChanges.mockReset().mockResolvedValue([]);
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
    // The column default every account carries.
    mortgageType: 'ANNUITY',
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

  // The balance is coloured by its sign alone. Branching on the account type
  // painted every liability red regardless of what it held, so a paid-off or
  // overpaid credit card was reported as debt.
  it.each([
    ['CREDIT_CARD'],
    ['LOAN'],
    ['MORTGAGE'],
    ['LINE_OF_CREDIT'],
  ] as const)('does not style a positive %s balance in red', async (accountType) => {
    // LOAN/MORTGAGE load their payment history on mount, so let it settle.
    await act(async () => {
      render(
        <AccountInfoWidget
          account={makeAccount({ accountType, currentBalance: 250 })}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
    });
    const amount = screen.getByText('CAD 250.00');
    expect(amount.className).not.toContain('text-red');
    expect(amount.className).toContain('text-gray-900');
  });

  it('styles a zero credit-card balance neutrally', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ accountType: 'CREDIT_CARD' })}
        currentBalance={0}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    const amount = screen.getByText('CAD 0.00');
    expect(amount.className).not.toContain('text-red');
  });

  it('styles a negative chequing balance in red', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ accountType: 'CHEQUING', currentBalance: -120.75 })}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    const amount = screen.getByText('CAD -120.75');
    expect(amount.className).toContain('text-red-600');
  });

  it('styles a negative credit-card balance in red', () => {
    render(
      <AccountInfoWidget
        account={makeAccount({ accountType: 'CREDIT_CARD' })}
        currentBalance={-1500}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    const amount = screen.getByText('CAD -1500.00');
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

  it('links to the account detail page from the details icon', async () => {
    await act(async () => {
      render(
        <AccountInfoWidget
          account={makeAccount({ id: 'loan-9', accountType: 'MORTGAGE' })}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
    });
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

  describe('mortgage figures', () => {
    const makeMortgage = (overrides: Partial<Account> = {}) =>
      makeAccount({
        id: 'mtg-1',
        accountType: 'MORTGAGE',
        name: 'Home Mortgage',
        openingBalance: -300000,
        currentBalance: -250000,
        interestRate: 4.5,
        paymentAmount: 1800,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        ...overrides,
      });

    const renderMortgage = async (account: Account) => {
      await act(async () => {
        render(<AccountInfoWidget account={account} onEdit={vi.fn()} onCollapse={vi.fn()} />);
      });
    };

    /** The value rendered beside a details-list label. */
    const detailValue = (label: string) =>
      screen.getByText(label).closest('div')?.querySelector('dd')?.textContent;

    it('shows the rate from the rate history, including when the scalar is unset', async () => {
      // Recording a rate change never writes account.interestRate, so the scalar
      // is the OLD rate -- and on a loan configured only through the rate
      // history it is null. Gating the row on the scalar hid Interest Rate
      // entirely while the payoff beside it was projected at that very rate.
      getAllTransactions.mockResolvedValue({
        data: [
          { id: 't1', transactionDate: '2026-06-15', amount: 600 } as Transaction,
        ],
        pagination: { hasMore: false },
      });
      getRateChanges.mockResolvedValue([
        {
          id: 'r1',
          effectiveDate: '2026-01-01',
          annualRate: 12,
          newPaymentAmount: 2000,
          source: 'manual',
        },
      ]);

      await renderMortgage(
        makeMortgage({ interestRate: null as unknown as number }),
      );

      await waitFor(() => expect(detailValue('Interest Rate')).toBe('12%'));
    });

    it('shows rate, payment, payoff date and remaining interest for a mortgage', async () => {
      getAllTransactions.mockResolvedValue({
        data: [
          { id: 't1', transactionDate: '2026-05-15', amount: 1800 },
          { id: 't2', transactionDate: '2026-06-15', amount: 1800 },
          { id: 't3', transactionDate: '2026-07-15', amount: 1800 },
        ] as Transaction[],
        pagination: { hasMore: false },
      });
      await renderMortgage(makeMortgage());

      expect(screen.getByText('Interest Rate')).toBeInTheDocument();
      expect(screen.getByText('4.5%')).toBeInTheDocument();
      expect(screen.getByText('Current Payment')).toBeInTheDocument();
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
      expect(screen.getByText('Est. Remaining Interest')).toBeInTheDocument();
      // Every figure resolved, so none of them reads as unavailable.
      await waitFor(() => expect(screen.queryByText('N/A')).not.toBeInTheDocument());
    });

    it('shows an interest-only mortgage\'s next installment and bullet, each dated', async () => {
      // docs/specs/mortgage-types.md section 5.6: no constant payment is
      // stored for the method; the installment is a dated answer, and the
      // bullet stands beside it.
      getAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      await renderMortgage(
        makeMortgage({
          mortgageType: 'INTEREST_ONLY',
          paymentAmount: null,
          openingBalance: -300000,
          currentBalance: -300000,
          interestRate: 2,
          paymentStartDate: '2024-01-01',
          amortizationMonths: 360,
          originalPrincipal: 300000,
        }),
      );

      await waitFor(() => expect(screen.getByText('Next Installment')).toBeInTheDocument());
      expect(screen.queryByText('Current Payment')).not.toBeInTheDocument();
      expect(detailValue('Next Installment')).toMatch(/^CAD 500\.00, due /);
      expect(detailValue('Final Payment')).toMatch(/^CAD 300,?500\.00, due .*2053/);
    });

    it('leaves the loan rows off an account type that does not amortize', async () => {
      await renderMortgage(makeMortgage({ accountType: 'CHEQUING', currentBalance: 500 }));

      expect(screen.queryByText('Current Payment')).not.toBeInTheDocument();
      expect(screen.queryByText('Est. Payoff')).not.toBeInTheDocument();
      expect(screen.queryByText('Est. Remaining Interest')).not.toBeInTheDocument();
      expect(getAllTransactions).not.toHaveBeenCalled();
      expect(getRateChanges).not.toHaveBeenCalled();
    });

    // A failed history load is not an empty history: the rows stay, saying the
    // figures are unavailable rather than projecting from no payments at all.
    it('shows the loan rows as unavailable when the history fails to load', async () => {
      getAllTransactions.mockRejectedValue(new Error('network'));
      await renderMortgage(makeMortgage());

      expect(screen.getByText('Current Payment')).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByText('N/A')).toHaveLength(3));
    });

    it('reports a settled mortgage as paid off with no interest remaining', async () => {
      await renderMortgage(makeMortgage({ currentBalance: 0 }));

      await waitFor(() => expect(detailValue('Est. Payoff')).toBe('Paid off'));
      // Nothing is left to pay, so the remaining interest is a known zero --
      // not "N/A", which would report a finished mortgage as uncomputable.
      expect(detailValue('Est. Remaining Interest')).toBe('CAD 0.00');
    });

    it('marks the loan rows busy while the history is loading', async () => {
      getAllTransactions.mockReturnValue(new Promise(() => {}));
      await renderMortgage(makeMortgage());

      expect(screen.getAllByLabelText('Loading...')).toHaveLength(3);
      expect(screen.queryByText('N/A')).not.toBeInTheDocument();
    });
  });

  describe('account switcher', () => {
    const others = [
      makeAccount({ id: 'a-2', name: 'Savings', accountType: 'SAVINGS' }),
      makeAccount({ id: 'a-3', name: 'Old Chequing', isClosed: true }),
    ];

    it('hides the caret when no switch handler is supplied', () => {
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[makeAccount(), ...others]}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      expect(
        screen.queryByRole('button', { name: 'Switch to another account' }),
      ).not.toBeInTheDocument();
    });

    it('hides the caret when the filter offers no other account', () => {
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[makeAccount()]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      expect(
        screen.queryByRole('button', { name: 'Switch to another account' }),
      ).not.toBeInTheDocument();
    });

    it('offers exactly the accounts the filter offers, minus the current one', () => {
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[makeAccount(), ...others]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
      const names = screen.getAllByRole('menuitem').map((item) => item.textContent);
      // Sorted by name like the Accounts filter, each qualified by its type;
      // a closed account offered by the filter is offered here too.
      expect(names).toEqual(['Old ChequingChequing', 'SavingsSavings']);
    });

    it('does not offer an account the filter has narrowed away', () => {
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[makeAccount(), others[0]]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
      expect(screen.queryByRole('menuitem', { name: /Old Chequing/ })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Savings/ })).toBeInTheDocument();
    });

    it('lifts the starred accounts into their own section, above the rest', () => {
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[
            makeAccount(),
            ...others,
            makeAccount({
              id: 'a-4',
              name: 'Zephyr Savings',
              accountType: 'SAVINGS',
              isFavourite: true,
              favouriteSortOrder: 1,
            }),
          ]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));

      // Last alphabetically, first in the menu: the section decides, not the name.
      const names = screen.getAllByRole('menuitem').map((item) => item.textContent);
      expect(names).toEqual([
        'Zephyr SavingsSavings',
        'Old ChequingChequing',
        'SavingsSavings',
      ]);
      expect(
        within(screen.getByRole('group', { name: 'Favourites' }))
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['Zephyr SavingsSavings']);
      expect(
        within(screen.getByRole('group', { name: 'Other accounts' }))
          .getAllByRole('menuitem'),
      ).toHaveLength(2);
    });

    it('orders the starred accounts the way the user arranged them', () => {
      // `favouriteSortOrder`, not the name -- the same order the Accounts page
      // and every account `<select>` put them in.
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[
            makeAccount(),
            makeAccount({
              id: 'a-4',
              name: 'Alpha',
              isFavourite: true,
              favouriteSortOrder: 2,
            }),
            makeAccount({
              id: 'a-5',
              name: 'Beta',
              isFavourite: true,
              favouriteSortOrder: 1,
            }),
          ]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));

      expect(
        within(screen.getByRole('group', { name: 'Favourites' }))
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['BetaChequing', 'AlphaChequing']);
    });

    it('leaves the menu unsectioned when nothing is starred', () => {
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[makeAccount(), ...others]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));

      expect(screen.queryAllByRole('group')).toHaveLength(0);
    });

    it('leaves the menu unsectioned when the only starred account is this one', () => {
      // The switcher never offers the account already on screen, so a
      // "Favourites" heading would have nothing under it -- and an "Other
      // accounts" heading over the whole list says nothing.
      render(
        <AccountInfoWidget
          account={makeAccount({ isFavourite: true, favouriteSortOrder: 1 })}
          switchableAccounts={[
            makeAccount({ isFavourite: true, favouriteSortOrder: 1 }),
            ...others,
          ]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));

      expect(screen.queryAllByRole('group')).toHaveLength(0);
      expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    });

    it('finds a starred account by typing its name', () => {
      // The filter only appears past `EntitySwitcher`'s threshold, which is
      // also the only size at which the sections earn their keep.
      const many = Array.from({ length: 10 }, (_, index) =>
        makeAccount({ id: `filler-${index}`, name: `Filler ${index}` }),
      );
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[
            makeAccount(),
            ...many,
            makeAccount({
              id: 'a-4',
              name: 'Zephyr Savings',
              accountType: 'SAVINGS',
              isFavourite: true,
              favouriteSortOrder: 1,
            }),
          ]}
          onSwitchAccount={vi.fn()}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
      fireEvent.change(screen.getByPlaceholderText('Filter accounts...'), {
        target: { value: 'zephyr' },
      });

      // The section it sits in does not narrow what the filter can reach, and
      // the now-empty "Other accounts" heading goes with its rows.
      expect(
        screen.getAllByRole('menuitem').map((item) => item.textContent),
      ).toEqual(['Zephyr SavingsSavings']);
      expect(
        screen.queryByRole('group', { name: 'Other accounts' }),
      ).not.toBeInTheDocument();
    });

    it('reports the chosen account id and closes the menu', () => {
      const onSwitchAccount = vi.fn();
      render(
        <AccountInfoWidget
          account={makeAccount()}
          switchableAccounts={[makeAccount(), ...others]}
          onSwitchAccount={onSwitchAccount}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Savings/ }));
      expect(onSwitchAccount).toHaveBeenCalledWith('a-2');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
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
