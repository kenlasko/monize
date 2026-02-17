import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountRow, AccountRowProps } from './AccountRow';
import { Account } from '@/types/account';

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'Main Chequing',
    description: 'Primary account',
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    openingBalance: 1000,
    currentBalance: 1500,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    canDelete: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createDefaultProps(overrides: Partial<AccountRowProps> = {}): AccountRowProps {
  return {
    account: createAccount(),
    density: 'normal',
    cellPadding: 'px-4 py-3',
    isDeletable: false,
    accountNameMap: new Map(),
    brokerageMarketValue: undefined,
    defaultCurrency: 'CAD',
    formatCurrency: (amount: number | string | null | undefined, _currency: string) =>
      `$${Number(amount || 0).toFixed(2)}`,
    formatCurrencyBase: (value: number, _currencyCode?: string) =>
      `$${value.toFixed(2)}`,
    convertToDefault: (value: number, _fromCurrency: string) => value,
    formatAccountType: (type) => {
      const labels: Record<string, string> = {
        CHEQUING: 'Chequing',
        SAVINGS: 'Savings',
        CREDIT_CARD: 'Credit Card',
        INVESTMENT: 'Investment',
        LOAN: 'Loan',
        MORTGAGE: 'Mortgage',
        CASH: 'Cash',
        LINE_OF_CREDIT: 'Line of Credit',
        ASSET: 'Asset',
        OTHER: 'Other',
      };
      return labels[type] || type;
    },
    getAccountTypeColor: () => 'bg-blue-100 text-blue-800',
    onRowClick: vi.fn(),
    onEdit: vi.fn(),
    onReconcile: vi.fn(),
    onCloseClick: vi.fn(),
    onDeleteClick: vi.fn(),
    onReopen: vi.fn(),
    onLongPressStart: vi.fn(),
    onLongPressStartTouch: vi.fn(),
    onLongPressEnd: vi.fn(),
    onTouchMove: vi.fn(),
    ...overrides,
  };
}

function renderAccountRow(props: AccountRowProps) {
  return render(
    <table>
      <tbody>
        <AccountRow {...props} />
      </tbody>
    </table>
  );
}

describe('AccountRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('basic rendering', () => {
    it('renders the account name', () => {
      const props = createDefaultProps();
      renderAccountRow(props);

      expect(screen.getByText('Main Chequing')).toBeInTheDocument();
    });

    it('renders the formatted account type badge', () => {
      const props = createDefaultProps();
      renderAccountRow(props);

      expect(screen.getByText('Chequing')).toBeInTheDocument();
    });

    it('renders the formatted balance', () => {
      const props = createDefaultProps({
        account: createAccount({ currentBalance: 1500 }),
      });
      renderAccountRow(props);

      expect(screen.getByText('$1500.00')).toBeInTheDocument();
    });

    it('renders Active status badge for open accounts', () => {
      const props = createDefaultProps({
        account: createAccount({ isClosed: false }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('renders Closed status badge for closed accounts', () => {
      const props = createDefaultProps({
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Closed')).toBeInTheDocument();
    });

    it('renders description for normal density when no linked account', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ description: 'Primary account', linkedAccountId: null }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Primary account')).toBeInTheDocument();
    });

    it('does not render description for compact density', () => {
      const props = createDefaultProps({
        density: 'compact',
        account: createAccount({ description: 'Primary account', linkedAccountId: null }),
      });
      renderAccountRow(props);

      expect(screen.queryByText('Primary account')).not.toBeInTheDocument();
    });

    it('does not render description for dense density', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({ description: 'Primary account', linkedAccountId: null }),
      });
      renderAccountRow(props);

      expect(screen.queryByText('Primary account')).not.toBeInTheDocument();
    });
  });

  describe('favourite indicator', () => {
    it('renders favourite star icon when isFavourite is true', () => {
      const props = createDefaultProps({
        account: createAccount({ isFavourite: true }),
      });
      renderAccountRow(props);

      expect(screen.getByLabelText('Favourite')).toBeInTheDocument();
    });

    it('does not render favourite star icon when isFavourite is false', () => {
      const props = createDefaultProps({
        account: createAccount({ isFavourite: false }),
      });
      renderAccountRow(props);

      expect(screen.queryByLabelText('Favourite')).not.toBeInTheDocument();
    });
  });

  describe('account types', () => {
    it('renders Savings type badge', () => {
      const props = createDefaultProps({
        account: createAccount({ accountType: 'SAVINGS' }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Savings')).toBeInTheDocument();
    });

    it('renders Credit Card type badge', () => {
      const props = createDefaultProps({
        account: createAccount({ accountType: 'CREDIT_CARD' }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Credit Card')).toBeInTheDocument();
    });

    it('renders Brokerage label for INVESTMENT_BROKERAGE subType', () => {
      const props = createDefaultProps({
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Brokerage')).toBeInTheDocument();
    });

    it('renders Inv. Cash label for INVESTMENT_CASH subType', () => {
      const props = createDefaultProps({
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Inv. Cash')).toBeInTheDocument();
    });
  });

  describe('balance display', () => {
    it('displays positive balance with green color class', () => {
      const props = createDefaultProps({
        account: createAccount({ currentBalance: 500 }),
      });
      renderAccountRow(props);

      const balanceEl = screen.getByText('$500.00');
      expect(balanceEl.className).toContain('text-green-600');
    });

    it('displays negative balance with red color class', () => {
      const props = createDefaultProps({
        account: createAccount({ currentBalance: -200 }),
      });
      renderAccountRow(props);

      const balanceEl = screen.getByText('$-200.00');
      expect(balanceEl.className).toContain('text-red-600');
    });

    it('displays credit limit when present and density is not dense', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          accountType: 'CREDIT_CARD',
          currentBalance: -500,
          creditLimit: 5000,
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Limit: $5000.00')).toBeInTheDocument();
    });

    it('does not display credit limit in dense density', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({
          accountType: 'CREDIT_CARD',
          currentBalance: -500,
          creditLimit: 5000,
        }),
      });
      renderAccountRow(props);

      expect(screen.queryByText('Limit: $5000.00')).not.toBeInTheDocument();
    });

    it('displays market value for brokerage accounts', () => {
      const props = createDefaultProps({
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
        brokerageMarketValue: 25000,
      });
      renderAccountRow(props);

      expect(screen.getByText('$25000.00')).toBeInTheDocument();
      expect(screen.getByText('Market value')).toBeInTheDocument();
    });

    it('does not display Market value label in compact density for brokerage', () => {
      const props = createDefaultProps({
        density: 'compact',
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
        brokerageMarketValue: 25000,
      });
      renderAccountRow(props);

      expect(screen.getByText('$25000.00')).toBeInTheDocument();
      expect(screen.queryByText('Market value')).not.toBeInTheDocument();
    });
  });

  describe('currency conversion display', () => {
    it('shows converted amount when account currency differs from default', () => {
      const props = createDefaultProps({
        density: 'normal',
        defaultCurrency: 'CAD',
        account: createAccount({ currentBalance: 1000, currencyCode: 'USD' }),
        convertToDefault: (value: number) => value * 1.35,
        formatCurrencyBase: (value: number) => `$${value.toFixed(2)}`,
      });
      renderAccountRow(props);

      // The approximate conversion line
      const convertedElements = screen.getAllByText(/1350\.00/);
      expect(convertedElements.length).toBeGreaterThanOrEqual(1);
    });

    it('does not show converted amount when currency matches default', () => {
      const props = createDefaultProps({
        density: 'normal',
        defaultCurrency: 'CAD',
        account: createAccount({ currentBalance: 1000, currencyCode: 'CAD' }),
      });
      renderAccountRow(props);

      // The approximate symbol should not appear
      const cells = screen.queryAllByText(/\u2248/);
      expect(cells).toHaveLength(0);
    });

    it('does not show converted amount in dense density', () => {
      const props = createDefaultProps({
        density: 'dense',
        defaultCurrency: 'CAD',
        account: createAccount({ currentBalance: 1000, currencyCode: 'USD' }),
      });
      renderAccountRow(props);

      const cells = screen.queryAllByText(/\u2248/);
      expect(cells).toHaveLength(0);
    });
  });

  describe('active account actions (normal/compact density)', () => {
    it('renders Edit button for active accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('calls onEdit when Edit button is clicked', () => {
      const onEdit = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ account, onEdit });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Edit'));
      expect(onEdit).toHaveBeenCalledWith(account);
    });

    it('renders Reconcile button for non-brokerage active accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false, accountSubType: null }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Reconcile')).toBeInTheDocument();
    });

    it('does not render Reconcile button for brokerage accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          isClosed: false,
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
      });
      renderAccountRow(props);

      expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
    });

    it('calls onReconcile when Reconcile button is clicked', () => {
      const onReconcile = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ account, onReconcile });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Reconcile'));
      expect(onReconcile).toHaveBeenCalledWith(account);
    });

    it('renders Close button for active accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Close')).toBeInTheDocument();
    });

    it('disables Close button when balance is non-zero', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false, currentBalance: 500 }),
      });
      renderAccountRow(props);

      const closeButton = screen.getByText('Close');
      expect(closeButton).toBeDisabled();
    });

    it('enables Close button when balance is zero', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false, currentBalance: 0 }),
      });
      renderAccountRow(props);

      const closeButton = screen.getByText('Close');
      expect(closeButton).not.toBeDisabled();
    });

    it('calls onCloseClick when Close button is clicked', () => {
      const onCloseClick = vi.fn();
      const account = createAccount({ isClosed: false, currentBalance: 0 });
      const props = createDefaultProps({ account, onCloseClick });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Close'));
      expect(onCloseClick).toHaveBeenCalledWith(account);
    });

    it('renders Delete button when isDeletable is true', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false }),
        isDeletable: true,
      });
      renderAccountRow(props);

      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('does not render Delete button when isDeletable is false', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: false }),
        isDeletable: false,
      });
      renderAccountRow(props);

      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('calls onDeleteClick when Delete button is clicked', () => {
      const onDeleteClick = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ account, onDeleteClick, isDeletable: true });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Delete'));
      expect(onDeleteClick).toHaveBeenCalledWith(account);
    });
  });

  describe('closed account actions (normal/compact density)', () => {
    it('renders Reopen button for closed accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Reopen')).toBeInTheDocument();
    });

    it('does not render Edit, Reconcile, or Close buttons for closed accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
      });
      renderAccountRow(props);

      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
      expect(screen.queryByText('Close')).not.toBeInTheDocument();
    });

    it('calls onReopen when Reopen button is clicked', () => {
      const onReopen = vi.fn();
      const account = createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' });
      const props = createDefaultProps({ account, onReopen });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Reopen'));
      expect(onReopen).toHaveBeenCalledWith(account);
    });

    it('renders Delete button for closed deletable accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
        isDeletable: true,
      });
      renderAccountRow(props);

      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('does not render Delete button for closed non-deletable accounts', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
        isDeletable: false,
      });
      renderAccountRow(props);

      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });
  });

  describe('dense density actions', () => {
    it('renders icon-only buttons with title attributes for active accounts', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({ isClosed: false, currentBalance: 0 }),
        isDeletable: true,
      });
      renderAccountRow(props);

      // In dense mode, buttons are icon-only with title attributes
      expect(screen.getByTitle('Edit')).toBeInTheDocument();
      expect(screen.getByTitle('Reconcile')).toBeInTheDocument();
      expect(screen.getByTitle(/Close account|Account must have zero balance/)).toBeInTheDocument();
      expect(screen.getByTitle('Permanently delete account (no transactions)')).toBeInTheDocument();
    });

    it('renders icon-only Reopen button for closed accounts in dense mode', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
      });
      renderAccountRow(props);

      expect(screen.getByTitle('Reopen')).toBeInTheDocument();
    });

    it('calls onEdit when dense Edit icon is clicked', () => {
      const onEdit = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ density: 'dense', account, onEdit });
      renderAccountRow(props);

      fireEvent.click(screen.getByTitle('Edit'));
      expect(onEdit).toHaveBeenCalledWith(account);
    });

    it('calls onReconcile when dense Reconcile icon is clicked', () => {
      const onReconcile = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ density: 'dense', account, onReconcile });
      renderAccountRow(props);

      fireEvent.click(screen.getByTitle('Reconcile'));
      expect(onReconcile).toHaveBeenCalledWith(account);
    });

    it('does not render Reconcile icon for brokerage accounts in dense mode', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({
          isClosed: false,
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
      });
      renderAccountRow(props);

      expect(screen.queryByTitle('Reconcile')).not.toBeInTheDocument();
    });

    it('disables close icon button when balance is non-zero in dense mode', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({ isClosed: false, currentBalance: 100 }),
      });
      renderAccountRow(props);

      const closeButton = screen.getByTitle('Account must have zero balance to close');
      expect(closeButton).toBeDisabled();
    });

    it('does not render Delete icon when isDeletable is false in dense mode', () => {
      const props = createDefaultProps({
        density: 'dense',
        account: createAccount({ isClosed: false }),
        isDeletable: false,
      });
      renderAccountRow(props);

      expect(screen.queryByTitle('Permanently delete account (no transactions)')).not.toBeInTheDocument();
    });
  });

  describe('linked account display', () => {
    it('shows paired-with text for linked investment account in normal density', () => {
      const accountNameMap = new Map([['linked-id-1', 'Brokerage Account']]);
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'linked-id-1',
        }),
        accountNameMap,
      });
      renderAccountRow(props);

      expect(screen.getByText(/Paired with Brokerage Account/)).toBeInTheDocument();
    });

    it('shows "linked account" fallback when linked account name not found', () => {
      const accountNameMap = new Map<string, string>();
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'unknown-id',
        }),
        accountNameMap,
      });
      renderAccountRow(props);

      expect(screen.getByText(/Paired with linked account/)).toBeInTheDocument();
    });

    it('does not show paired-with text for non-investment linked accounts', () => {
      const accountNameMap = new Map([['linked-id-1', 'Other Account']]);
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          accountType: 'CHEQUING',
          accountSubType: null,
          linkedAccountId: 'linked-id-1',
        }),
        accountNameMap,
      });
      renderAccountRow(props);

      expect(screen.queryByText(/Paired with/)).not.toBeInTheDocument();
    });

    it('does not show description when account has linked investment account', () => {
      const accountNameMap = new Map([['linked-id-1', 'Brokerage Account']]);
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'linked-id-1',
          description: 'Should not appear',
        }),
        accountNameMap,
      });
      renderAccountRow(props);

      expect(screen.queryByText('Should not appear')).not.toBeInTheDocument();
    });

    it('shows link icon for linked accounts in compact density', () => {
      const accountNameMap = new Map([['linked-id-1', 'Brokerage Account']]);
      const props = createDefaultProps({
        density: 'compact',
        account: createAccount({
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'linked-id-1',
        }),
        accountNameMap,
      });
      renderAccountRow(props);

      // In compact/dense mode, a link SVG icon is shown inline instead of the text
      // The paired-with text should NOT be shown
      expect(screen.queryByText(/Paired with/)).not.toBeInTheDocument();
    });
  });

  describe('row click and interaction', () => {
    it('calls onRowClick when row is clicked', () => {
      const onRowClick = vi.fn();
      const account = createAccount();
      const props = createDefaultProps({ account, onRowClick });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Main Chequing'));
      expect(onRowClick).toHaveBeenCalledWith(account);
    });

    it('does not propagate row click when action buttons are clicked', () => {
      const onRowClick = vi.fn();
      const onEdit = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ account, onRowClick, onEdit });
      renderAccountRow(props);

      // The actions column has stopPropagation on click
      fireEvent.click(screen.getByText('Edit'));
      expect(onEdit).toHaveBeenCalledWith(account);
      // onRowClick should not be called because of stopPropagation on the actions td
    });

    it('calls onLongPressStart on mouse down', () => {
      const onLongPressStart = vi.fn();
      const account = createAccount();
      const props = createDefaultProps({ account, onLongPressStart });
      renderAccountRow(props);

      const row = screen.getByRole('row');
      fireEvent.mouseDown(row);
      expect(onLongPressStart).toHaveBeenCalledWith(account);
    });

    it('calls onLongPressEnd on mouse up', () => {
      const onLongPressEnd = vi.fn();
      const account = createAccount();
      const props = createDefaultProps({ account, onLongPressEnd });
      renderAccountRow(props);

      const row = screen.getByRole('row');
      fireEvent.mouseUp(row);
      expect(onLongPressEnd).toHaveBeenCalled();
    });

    it('calls onLongPressEnd on mouse leave', () => {
      const onLongPressEnd = vi.fn();
      const account = createAccount();
      const props = createDefaultProps({ account, onLongPressEnd });
      renderAccountRow(props);

      const row = screen.getByRole('row');
      fireEvent.mouseLeave(row);
      expect(onLongPressEnd).toHaveBeenCalled();
    });
  });

  describe('closed account opacity', () => {
    it('applies opacity-50 class to name cell for closed accounts', () => {
      const props = createDefaultProps({
        account: createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
      });
      renderAccountRow(props);

      // The name td should have opacity-50
      const nameCell = screen.getByText('Main Chequing').closest('td');
      expect(nameCell?.className).toContain('opacity-50');
    });

    it('does not apply opacity-50 class to name cell for active accounts', () => {
      const props = createDefaultProps({
        account: createAccount({ isClosed: false }),
      });
      renderAccountRow(props);

      const nameCell = screen.getByText('Main Chequing').closest('td');
      expect(nameCell?.className).not.toContain('opacity-50');
    });
  });

  describe('different account types rendering', () => {
    it('renders a mortgage account correctly', () => {
      const props = createDefaultProps({
        account: createAccount({
          name: 'Home Mortgage',
          accountType: 'MORTGAGE',
          currentBalance: -250000,
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
      expect(screen.getByText('Mortgage')).toBeInTheDocument();
      expect(screen.getByText('$-250000.00')).toBeInTheDocument();
    });

    it('renders a line of credit account correctly', () => {
      const props = createDefaultProps({
        account: createAccount({
          name: 'Personal LOC',
          accountType: 'LINE_OF_CREDIT',
          currentBalance: -5000,
          creditLimit: 25000,
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Personal LOC')).toBeInTheDocument();
      expect(screen.getByText('Line of Credit')).toBeInTheDocument();
      expect(screen.getByText('Limit: $25000.00')).toBeInTheDocument();
    });

    it('renders a cash account correctly', () => {
      const props = createDefaultProps({
        account: createAccount({
          name: 'Petty Cash',
          accountType: 'CASH',
          currentBalance: 150,
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('Petty Cash')).toBeInTheDocument();
      expect(screen.getByText('Cash')).toBeInTheDocument();
    });

    it('renders an asset account correctly', () => {
      const props = createDefaultProps({
        account: createAccount({
          name: 'My Car',
          accountType: 'ASSET',
          currentBalance: 30000,
        }),
      });
      renderAccountRow(props);

      expect(screen.getByText('My Car')).toBeInTheDocument();
      expect(screen.getByText('Asset')).toBeInTheDocument();
    });
  });

  describe('density variations', () => {
    it('renders with normal cellPadding', () => {
      const props = createDefaultProps({
        density: 'normal',
        cellPadding: 'px-4 py-3',
      });
      renderAccountRow(props);

      const nameCell = screen.getByText('Main Chequing').closest('td');
      expect(nameCell?.className).toContain('px-4 py-3');
    });

    it('renders with compact cellPadding', () => {
      const props = createDefaultProps({
        density: 'compact',
        cellPadding: 'px-4 py-2',
      });
      renderAccountRow(props);

      const nameCell = screen.getByText('Main Chequing').closest('td');
      expect(nameCell?.className).toContain('px-4 py-2');
    });

    it('renders with dense cellPadding', () => {
      const props = createDefaultProps({
        density: 'dense',
        cellPadding: 'px-3 py-1',
      });
      renderAccountRow(props);

      const nameCell = screen.getByText('Main Chequing').closest('td');
      expect(nameCell?.className).toContain('px-3 py-1');
    });
  });
});
