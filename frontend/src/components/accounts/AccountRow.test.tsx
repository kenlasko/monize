import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountRow, AccountRowProps, buildAccountActions } from './AccountRow';
import type { LogicalAccount } from '@/lib/logical-accounts';
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
    institution: null, institutionId: null,
    openingBalance: 1000,
    currentBalance: 1500,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    favouriteSortOrder: 0,
    excludeFromNetWorth: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    interestBookingMode: 'AUTO',
    overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    linkedLoanAccountId: null,
    mortgageType: 'ANNUITY',
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    statementDueDay: null,
    statementSettlementDay: null,
    canDelete: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createDefaultProps(overrides: Partial<AccountRowProps> = {}): AccountRowProps {
  return {
    account: createAccount(),
    index: 0,
    density: 'normal',
    cellPadding: 'px-4 py-3',
    isDeletable: false,
    accountNameMap: new Map(),
    brokerageMarketValue: undefined,
    defaultCurrency: 'CAD',
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
    actionLabels: {
      viewTransactions: 'View Transactions',
      details: 'Details',
      edit: 'Edit',
      reconcile: 'Reconcile',
      close: 'Close',
      closeTitleDisabled: 'Balance must be zero',
      closeTitleEnabled: 'Close account',
      reopen: 'Reopen',
      delete: 'Delete',
    },
    onDetails: vi.fn(),
    onEdit: vi.fn(),
    onReconcile: vi.fn(),
    onCloseClick: vi.fn(),
    onDeleteClick: vi.fn(),
    onReopen: vi.fn(),
    getRowHandlers: () => ({
      onClick: vi.fn(),
      onContextMenu: vi.fn(),
      onMouseDown: vi.fn(),
      onMouseUp: vi.fn(),
      onMouseLeave: vi.fn(),
      onTouchStart: vi.fn(),
      onTouchMove: vi.fn(),
      onTouchEnd: vi.fn(),
      onTouchCancel: vi.fn(),
    }),
    ...overrides,
  };
}

/**
 * An orphan brokerage entity (no linked cash half) worth `combinedValue` --
 * the shape the Close action reads to decide whether the account is empty.
 */
function brokerageLogical(combinedValue: number | null): LogicalAccount {
  const primary = createAccount({
    isClosed: false,
    currentBalance: 0,
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE',
  });
  return {
    id: primary.id,
    primary,
    cash: null,
    memberIds: [primary.id],
    displayName: primary.name,
    isInvestment: true,
    cashRegisterId: null,
    holdingsAccountId: primary.id,
    combinedValue,
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

    it('renders an interactive favourite toggle when onToggleFavourite is given', () => {
      const onToggleFavourite = vi.fn();
      const account = createAccount({ isFavourite: false });
      renderAccountRow(
        createDefaultProps({ account, onToggleFavourite }),
      );

      const btn = screen.getByLabelText('Add to favourites');
      fireEvent.click(btn);

      expect(onToggleFavourite).toHaveBeenCalledWith(account);
    });

    it('shows the toggle as pressed for a delegate favourite', () => {
      renderAccountRow(
        createDefaultProps({
          account: createAccount({ isFavourite: true }),
          onToggleFavourite: vi.fn(),
        }),
      );

      expect(
        screen.getByLabelText('Remove from favourites'),
      ).toHaveAttribute('aria-pressed', 'true');
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
      expect(onReconcile).toHaveBeenCalledWith(account.id);
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

    it('disables Close button for brokerage accounts with non-zero market value', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          isClosed: false,
          currentBalance: 0,
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
        logical: brokerageLogical(25000),
      });
      renderAccountRow(props);

      const closeButton = screen.getByText('Close');
      expect(closeButton).toBeDisabled();
    });

    it('enables Close button for brokerage accounts with zero market value', () => {
      const props = createDefaultProps({
        density: 'normal',
        account: createAccount({
          isClosed: false,
          currentBalance: 0,
          accountSubType: 'INVESTMENT_BROKERAGE',
        }),
        logical: brokerageLogical(0),
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
      expect(screen.getByTitle(/Close account|Balance must be zero/)).toBeInTheDocument();
      expect(screen.getByTitle('Delete')).toBeInTheDocument();
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
      expect(onReconcile).toHaveBeenCalledWith(account.id);
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

      const closeButton = screen.getByTitle('Balance must be zero');
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
    // Builds a full set of long-press row handlers backed by spies so we can
    // assert AccountRow spreads them onto the <tr>.
    function makeRowHandlers() {
      const spies = {
        onClick: vi.fn(),
        onContextMenu: vi.fn(),
        onMouseDown: vi.fn(),
        onMouseUp: vi.fn(),
        onMouseLeave: vi.fn(),
        onTouchStart: vi.fn(),
        onTouchMove: vi.fn(),
        onTouchEnd: vi.fn(),
        onTouchCancel: vi.fn(),
      };
      return spies;
    }

    it('spreads the row click handler onto the row', () => {
      const handlers = makeRowHandlers();
      const account = createAccount();
      const props = createDefaultProps({ account, getRowHandlers: () => handlers });
      renderAccountRow(props);

      fireEvent.click(screen.getByText('Main Chequing'));
      expect(handlers.onClick).toHaveBeenCalled();
    });

    it('does not propagate row click when action buttons are clicked', () => {
      const handlers = makeRowHandlers();
      const onEdit = vi.fn();
      const account = createAccount({ isClosed: false });
      const props = createDefaultProps({ account, onEdit, getRowHandlers: () => handlers });
      renderAccountRow(props);

      // The actions column has stopPropagation on click.
      fireEvent.click(screen.getByText('Edit'));
      expect(onEdit).toHaveBeenCalledWith(account);
      expect(handlers.onClick).not.toHaveBeenCalled();
    });

    it('spreads the long-press handlers onto the row', () => {
      const handlers = makeRowHandlers();
      const account = createAccount();
      const props = createDefaultProps({ account, getRowHandlers: () => handlers });
      renderAccountRow(props);

      const row = screen.getByRole('row');
      fireEvent.mouseDown(row);
      expect(handlers.onMouseDown).toHaveBeenCalled();
      fireEvent.mouseUp(row);
      expect(handlers.onMouseUp).toHaveBeenCalled();
      fireEvent.mouseLeave(row);
      expect(handlers.onMouseLeave).toHaveBeenCalled();
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

  describe('institution brand icon', () => {
    it('renders the institution logo at normal density', () => {
      const props = createDefaultProps({
        institution: { id: 'i-1', name: 'TD', hasLogo: true },
      });
      renderAccountRow(props);
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        '/api/v1/institutions/i-1/logo',
      );
    });

    it('renders the account-type icon as fallback when there is no institution', () => {
      const props = createDefaultProps({ institution: undefined });
      const { container } = renderAccountRow(props);
      expect(screen.queryByRole('img')).toBeNull();
      // The generic "$" glyph gave way to the account-type icon, which says
      // what the row is; the badge chip itself stays.
      const badge = container.querySelector('span[aria-hidden="true"]');
      expect(badge).toBeTruthy();
      expect(badge?.querySelector('svg')).toBeTruthy();
    });

    it('hides the brand icon at dense density', () => {
      const props = createDefaultProps({
        density: 'dense',
        institution: { id: 'i-1', name: 'TD', hasLogo: true },
      });
      renderAccountRow(props);
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.queryByText('$')).toBeNull();
    });
  });

  describe('joint accounts', () => {
    const jointAccount = () =>
      createAccount({
        isJoint: true,
        ownerLabel: 'Olive Owner',
        jointPermissions: { canCreate: true, canEdit: true, canDelete: false },
        canDelete: false,
      });

    it('shows the Joint badge and the sharing owner on a grantee row', () => {
      renderAccountRow(createDefaultProps({ account: jointAccount() }));
      expect(screen.getByText('Joint')).toBeInTheDocument();
      expect(screen.getByText('Shared by Olive Owner')).toBeInTheDocument();
    });

    it('shows the Joint badge with the grantee count on an owner row', () => {
      renderAccountRow(
        createDefaultProps({
          account: createAccount({ jointGranteeCount: 2 }),
        }),
      );
      expect(screen.getByText('Joint')).toBeInTheDocument();
      expect(screen.getByText('Shared with 2 people')).toBeInTheDocument();
    });

    it('hides account-object actions on a joint row and offers the net-worth toggle', () => {
      const account = jointAccount();
      const actions = buildAccountActions(
        account,
        true,
        {
          viewTransactions: 'View Transactions',
          details: 'Details',
          edit: 'Edit',
          reconcile: 'Reconcile',
          close: 'Close',
          closeTitleDisabled: 'x',
          closeTitleEnabled: 'y',
          reopen: 'Reopen',
          delete: 'Delete',
          includeInNetWorth: 'Include in my net worth',
          excludeFromNetWorth: 'Exclude from my net worth',
        },
        {
          onDetails: vi.fn(),
          onEdit: vi.fn(),
          onReconcile: vi.fn(),
          onCloseClick: vi.fn(),
          onReopen: vi.fn(),
          onDeleteClick: vi.fn(),
          onToggleNetWorthExclusion: vi.fn(),
        },
      );
      const byKey = new Map(actions.map((a) => [a.key, a]));
      // The account object stays owner-only: every mutating account action
      // is hidden even though isDeletable was passed as true.
      for (const key of ['edit', 'reconcile', 'close', 'reopen', 'delete']) {
        expect(byKey.get(key)?.hidden, key).toBe(true);
      }
      expect(byKey.get('netWorthExclusion')?.hidden).toBe(false);
      expect(byKey.get('netWorthExclusion')?.label).toBe(
        'Exclude from my net worth',
      );
    });

    it('keeps every account action for own rows (no regression)', () => {
      const account = createAccount({ isClosed: false });
      const actions = buildAccountActions(
        account,
        true,
        {
          viewTransactions: 'View Transactions',
          details: 'Details',
          edit: 'Edit',
          reconcile: 'Reconcile',
          close: 'Close',
          closeTitleDisabled: 'x',
          closeTitleEnabled: 'y',
          reopen: 'Reopen',
          delete: 'Delete',
        },
        {
          onDetails: vi.fn(),
          onEdit: vi.fn(),
          onReconcile: vi.fn(),
          onCloseClick: vi.fn(),
          onReopen: vi.fn(),
          onDeleteClick: vi.fn(),
        },
      );
      const byKey = new Map(actions.map((a) => [a.key, a]));
      expect(byKey.get('edit')?.hidden).toBe(false);
      expect(byKey.get('delete')?.hidden).toBe(false);
      // No handler -> the joint-only action never appears for own rows.
      expect(byKey.get('netWorthExclusion')?.hidden).toBe(true);
    });
  });
  describe('a folded investment pair', () => {
    const brokerage = createAccount({
      id: 'brok',
      name: 'TFSA - Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      linkedAccountId: 'cash',
      currentBalance: 0,
      description: null,
    });
    const cash = createAccount({
      id: 'cash',
      name: 'TFSA - Cash',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: 'brok',
      currentBalance: 3500,
    });

    const logical = (combinedValue: number | null): LogicalAccount => ({
      id: 'brok',
      primary: brokerage,
      cash,
      memberIds: ['brok', 'cash'],
      displayName: 'TFSA',
      isInvestment: true,
      cashRegisterId: 'cash',
      holdingsAccountId: 'brok',
      combinedValue,
    });

    it('shows the entity name without the stored suffix', () => {
      renderAccountRow(
        createDefaultProps({
          account: brokerage,
          logical: logical(15500),
          brokerageMarketValue: 12000,
        }),
      );

      expect(screen.getByText('TFSA')).toBeInTheDocument();
      expect(screen.queryByText('TFSA - Brokerage')).not.toBeInTheDocument();
    });

    it('shows the combined total and what it is made of', () => {
      renderAccountRow(
        createDefaultProps({
          account: brokerage,
          logical: logical(15500),
          brokerageMarketValue: 12000,
        }),
      );

      expect(screen.getByText('$15500.00')).toBeInTheDocument();
      expect(
        screen.getByText('Investments $12000.00 · Cash $3500.00'),
      ).toBeInTheDocument();
    });

    it('drops the pairing chrome that existed to explain two rows', () => {
      const props = createDefaultProps({
        account: brokerage,
        logical: logical(15500),
        brokerageMarketValue: 12000,
        accountNameMap: new Map([['cash', 'TFSA - Cash']]),
      });
      renderAccountRow(props);

      expect(screen.queryByText(/Paired with/)).not.toBeInTheDocument();
      expect(screen.getByText('Investment')).toBeInTheDocument();
      expect(screen.queryByText('Brokerage')).not.toBeInTheDocument();
    });

    // Showing the cash it does know, in a total's place, would read as the
    // account being worth that much.
    it('shows no total when the combined value is unknown', () => {
      renderAccountRow(
        createDefaultProps({
          account: brokerage,
          logical: logical(null),
          brokerageMarketValue: 9000,
          unpricedHoldingsCount: 2,
        }),
      );

      expect(screen.getByText('—')).toBeInTheDocument();
      expect(screen.getByText('Total unavailable')).toBeInTheDocument();
      expect(screen.queryByText('$3500.00')).not.toBeInTheDocument();
      expect(screen.queryByText('$9000.00')).not.toBeInTheDocument();
    });
  });
  describe('actions on a folded pair', () => {
    const pairLogical = (over: Partial<LogicalAccount> = {}): LogicalAccount => {
      const primary = createAccount({
        id: 'brok',
        name: 'TFSA - Brokerage',
        isClosed: false,
        currentBalance: 0,
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        linkedAccountId: 'cash',
      });
      const cash = createAccount({
        id: 'cash',
        name: 'TFSA - Cash',
        isClosed: false,
        currentBalance: 0,
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        linkedAccountId: 'brok',
      });
      return {
        id: 'brok',
        primary,
        cash,
        memberIds: ['brok', 'cash'],
        displayName: 'TFSA',
        isInvestment: true,
        cashRegisterId: 'cash',
        holdingsAccountId: 'brok',
        combinedValue: 0,
        ...over,
      };
    };

    // Reconciling compares a cash ledger against a statement, and the pair's
    // cash lives in the other half -- reconciling the brokerage would open a
    // register of trade-generated rows against a statement of the cash account.
    it('reconciles the cash half, not the brokerage the row is built from', () => {
      const onReconcile = vi.fn();
      const logical = pairLogical();
      renderAccountRow(
        createDefaultProps({ account: logical.primary, logical, onReconcile }),
      );

      fireEvent.click(screen.getByText('Reconcile'));

      expect(onReconcile).toHaveBeenCalledWith('cash');
      expect(onReconcile).not.toHaveBeenCalledWith('brok');
    });

    it('offers Reconcile on a pair, which a lone brokerage row never had', () => {
      renderAccountRow(
        createDefaultProps({
          account: pairLogical().primary,
          logical: pairLogical(),
        }),
      );

      expect(screen.getByText('Reconcile')).toBeInTheDocument();
    });

    it('hides Reconcile for a brokerage with no cash ledger to reconcile', () => {
      renderAccountRow(
        createDefaultProps({
          account: brokerageLogical(0).primary,
          logical: brokerageLogical(0),
        }),
      );

      expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
    });

    it('enables Close only when the whole entity is empty', () => {
      renderAccountRow(
        createDefaultProps({
          account: pairLogical().primary,
          logical: pairLogical({ combinedValue: 0 }),
        }),
      );

      expect(screen.getByText('Close')).not.toBeDisabled();
    });

    it('disables Close when the pair still holds value anywhere', () => {
      renderAccountRow(
        createDefaultProps({
          account: pairLogical().primary,
          logical: pairLogical({ combinedValue: 3500 }),
        }),
      );

      expect(screen.getByText('Close')).toBeDisabled();
    });

    // An unknown total is not a zero one, so the account cannot be confirmed
    // empty and Close stays unavailable rather than guessing.
    it('disables Close when the total cannot be worked out', () => {
      renderAccountRow(
        createDefaultProps({
          account: pairLogical().primary,
          logical: pairLogical({ combinedValue: null }),
          actionLabels: {
            ...createDefaultProps().actionLabels,
            closeTitleUnknownValue: 'Total unknown',
          },
        }),
      );

      const close = screen.getByText('Close');
      expect(close).toBeDisabled();
      expect(close.closest('button')).toHaveAttribute('title', 'Total unknown');
    });
  });
});
