import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@/test/render';
import toast from 'react-hot-toast';
import { InvestmentRegisterPanel } from './InvestmentRegisterPanel';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import type { Account } from '@/types/account';
import { TransactionStatus, type Transaction } from '@/types/transaction';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: vi.fn(),
    getRegisterFilterOptions: vi.fn(),
    getTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
    getRegisterFilterOptions: vi.fn(),
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn() },
}));

vi.mock('@/lib/apiCache', () => ({
  invalidateBalanceCaches: vi.fn(),
}));

// The forms are large trees with their own data loading; the panel's contract
// with them is that it mounts them against the right account, and hands the
// brokerage form every account a trade can be funded from.
vi.mock('./InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: ({
    defaultAccountId,
    allAccounts,
    duplicateFrom,
    onConversionStateChange,
  }: {
    defaultAccountId?: string;
    allAccounts?: { id: string }[];
    duplicateFrom?: { id: string };
    onConversionStateChange?: (needsConversion: boolean) => void;
  }) => (
    <div data-testid="investment-form">
      {defaultAccountId}
      <span data-testid="form-duplicate-from">{duplicateFrom?.id ?? ''}</span>
      <span data-testid="form-all-accounts">
        {allAccounts === undefined ? 'undefined' : allAccounts.map((a) => a.id).join(',')}
      </span>
      <button
        data-testid="form-needs-conversion"
        onClick={() => onConversionStateChange?.(true)}
      >
        show conversion
      </button>
    </div>
  ),
}));
vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: ({ defaultAccountId }: { defaultAccountId?: string }) => (
    <div data-testid="cash-form">{defaultAccountId}</div>
  ),
}));
// `TransactionList` is deliberately NOT stubbed: it owns its own delete, and the
// bug in issue #1192 was the panel deleting a second time on top of it. A stub
// cannot show that.

const brokerage = {
  id: 'brok',
  name: 'TFSA - Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  linkedAccountId: 'cash',
  currencyCode: 'CAD',
  currentBalance: 0,
  isClosed: false,
} as Account;

const cash = {
  id: 'cash',
  name: 'TFSA - Cash',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_CASH',
  linkedAccountId: 'brok',
  currencyCode: 'CAD',
  currentBalance: 3500,
  isClosed: false,
} as Account;

/** An account outside the pair -- what "Funds From" is supposed to offer. */
const chequing = {
  id: 'chq',
  name: 'Everyday Chequing',
  accountType: 'CHEQUING',
  accountSubType: null,
  linkedAccountId: null,
  currencyCode: 'CAD',
  currentBalance: 2000,
  isClosed: false,
} as Account;

const cashTransaction: Transaction = {
  id: 'cash-tx-1',
  userId: 'user-1',
  accountId: 'cash',
  account: { id: 'cash', name: 'TFSA - Cash', accountType: 'INVESTMENT' } as never,
  transactionDate: '2026-01-05',
  payeeId: null,
  payeeName: 'Contribution',
  payee: null,
  categoryId: null,
  category: null,
  amount: 500,
  currencyCode: 'CAD',
  exchangeRate: 1,
  originalAmount: null,
  originalCurrencyCode: null,
  description: 'Cash deposit',
  referenceNumber: null,
  status: TransactionStatus.UNRECONCILED,
  isCleared: false,
  isReconciled: false,
  isVoid: false,
  reconciledDate: null,
  isSplit: false,
  parentTransactionId: null,
  isTransfer: false,
  linkedTransactionId: null,
  createdAt: '2026-01-05T00:00:00Z',
  updatedAt: '2026-01-05T00:00:00Z',
};

const standalone = {
  id: 'solo',
  name: 'Self-directed',
  accountType: 'INVESTMENT',
  accountSubType: null,
  linkedAccountId: null,
  currencyCode: 'CAD',
  currentBalance: 100,
  isClosed: false,
} as Account;

async function renderPanel(
  holdingsAccount: Account,
  cashAccount: Account | null,
  onDataChanged?: () => void,
) {
  await act(async () => {
    render(
      <InvestmentRegisterPanel
        holdingsAccount={holdingsAccount}
        cashAccount={cashAccount}
        onDataChanged={onDataChanged}
      />,
    );
  });
}

/** Put the cash ledger on screen. */
async function switchToCash() {
  await act(async () => {
    fireEvent.click(screen.getByText('Cash'));
  });
}

/** Delete the cash register's only row, confirmation included. */
async function deleteFirstCashRow() {
  const rowDelete = screen
    .getAllByRole('button')
    .filter((b) => b.textContent === 'Delete')[0];
  await act(async () => {
    fireEvent.click(rowDelete);
  });
  const confirm = screen
    .getAllByRole('button')
    .filter((b) => b.textContent === 'Delete')
    .pop()!;
  await act(async () => {
    fireEvent.click(confirm);
  });
}

/** Switch to the cash ledger and delete its only row. */
async function deleteTheCashRow() {
  await switchToCash();
  await deleteFirstCashRow();
}

describe('InvestmentRegisterPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      pagination: { total: 0, page: 1, limit: 25, totalPages: 0 },
    });
    (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [cashTransaction],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
    });
    (transactionsApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (
      transactionsApi.getRegisterFilterOptions as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ payees: [], categories: [] });
    (
      investmentsApi.getRegisterFilterOptions as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ actions: [], symbols: [] });
    (accountsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      brokerage,
      cash,
      chequing,
    ]);
  });

  describe('scoping', () => {
    // The brokerage's own ledger carries the cash rows its trades generated.
    // Widening the cash register to the pair would put those in a register the
    // user reads as their cash account.
    it('scopes the cash register to the cash ledger alone', async () => {
      await renderPanel(brokerage, cash);

      expect(transactionsApi.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ['cash'] }),
      );
      const call = (transactionsApi.getAll as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.accountIds).not.toContain('brok');
    });

    it('scopes the brokerage register to the holdings account alone', async () => {
      await renderPanel(brokerage, cash);

      expect(investmentsApi.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'brok' }),
      );
    });

    it('scopes both registers to itself for a standalone account', async () => {
      await renderPanel(standalone, standalone);

      expect(investmentsApi.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'solo' }),
      );
      expect(transactionsApi.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ['solo'] }),
      );
    });

    it('asks for no cash register when the account has no cash ledger', async () => {
      await renderPanel(brokerage, null);

      expect(transactionsApi.getAll).not.toHaveBeenCalled();
      expect(investmentsApi.getTransactions).toHaveBeenCalled();
    });
  });

  describe('the toggle', () => {
    it('offers both ledgers when there is a cash half', async () => {
      await renderPanel(brokerage, cash);

      expect(screen.getByText('Brokerage')).toBeInTheDocument();
      expect(screen.getByText('Cash')).toBeInTheDocument();
    });

    it('shows the cash register once the cash ledger is chosen', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('Cash'));
      });

      expect(screen.getByText('Contribution')).toBeInTheDocument();
    });

    it('offers no toggle when there is no second ledger to switch to', async () => {
      await renderPanel(brokerage, null);

      expect(screen.queryByText('Cash')).not.toBeInTheDocument();
    });
  });

  // Issue #1188. The register draws a Balance column for a single-account view,
  // and the number in it is the backend's starting balance run down the page.
  // The panel read the rows off the response and dropped the starting balance
  // beside them, so every row's balance cell rendered the empty marker.
  describe('the running balance', () => {
    it('shows the balance the rows run from', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 3500,
      });

      await renderPanel(brokerage, cash);
      await switchToCash();

      expect(screen.getByText('Balance')).toBeInTheDocument();
      expect(screen.getByText('$3,500.00')).toBeInTheDocument();
    });

    // The starting balance is computed for one page of one account and means
    // nothing beside another page's rows, so it is adopted from the same
    // response as the rows rather than lagging a request behind them.
    it('moves the balance with the rows it was computed for', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 3500,
      });

      await renderPanel(brokerage, cash);
      await switchToCash();

      // The write's reload answers with the register as it now stands.
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            ...cashTransaction,
            id: 'cash-tx-2',
            payeeName: 'Withdrawal',
            amount: -750,
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 2750,
      });
      await deleteFirstCashRow();

      await waitFor(() => {
        expect(screen.getByText('Withdrawal')).toBeInTheDocument();
        expect(screen.getByText('$2,750.00')).toBeInTheDocument();
      });
      expect(screen.queryByText('$3,500.00')).not.toBeInTheDocument();
    });

    // A failed reload is not a register with no starting balance: the rows on
    // screen stay, so the balances beside them have to stay too rather than
    // collapsing to the empty marker under unchanged rows.
    it('keeps the balance when a reload fails', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 3500,
      });

      await renderPanel(brokerage, cash);
      await switchToCash();

      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network'),
      );
      await deleteFirstCashRow();
      await act(async () => {});

      expect(screen.getByText('Contribution')).toBeInTheDocument();
      expect(screen.getByText('$3,500.00')).toBeInTheDocument();
    });
  });

  describe('writes', () => {
    // A trade settles into the cash ledger and a cash row can carry an
    // investment split, so either side moves balances that the cached account
    // list and portfolio summary are showing.
    it('drops the balance caches after deleting a trade', async () => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            accountId: 'brok',
            action: 'BUY',
            transactionDate: '2026-01-05',
            quantity: 1,
            price: 10,
            totalAmount: 10,
            security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      (investmentsApi.deleteTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      await renderPanel(brokerage, cash);

      // Row action, then the confirmation it opens.
      const deleteActions = screen.getAllByText('Delete');
      await act(async () => {
        fireEvent.click(deleteActions[0]);
      });
      const confirm = screen
        .getAllByRole('button')
        .filter((b) => b.textContent === 'Delete')
        .pop()!;
      await act(async () => {
        fireEvent.click(confirm);
      });

      await waitFor(() => {
        expect(investmentsApi.deleteTransaction).toHaveBeenCalledWith('tx-1');
      });
      expect(invalidateBalanceCaches).toHaveBeenCalled();
    });

    // Issue #1192. The two lists have opposite delete contracts:
    // `InvestmentTransactionList` asks its parent to perform the delete, while
    // `TransactionList` performs its own and only reports it afterwards. The
    // cash register was given a handler shaped like the brokerage one, so every
    // cash row was deleted twice -- the second request 404'd on the row the
    // first had removed, and the user saw "not found" beside "deleted".
    it('deletes a cash row exactly once', async () => {
      await renderPanel(brokerage, cash);

      await deleteTheCashRow();

      await waitFor(() => {
        expect(transactionsApi.delete).toHaveBeenCalledWith('cash-tx-1');
      });
      expect(transactionsApi.delete).toHaveBeenCalledTimes(1);
    });

    it('reports no error after deleting a cash row', async () => {
      await renderPanel(brokerage, cash);

      await deleteTheCashRow();

      await waitFor(() => expect(transactionsApi.delete).toHaveBeenCalled());
      await act(async () => {});
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalled();
    });

    it('drops the balance caches after deleting a cash row', async () => {
      await renderPanel(brokerage, cash);

      await deleteTheCashRow();

      await waitFor(() => expect(invalidateBalanceCaches).toHaveBeenCalled());
    });

    // Issue #1190: the figures above this panel are derived from these rows, so
    // the view around it has to be told a write happened.
    it('tells the surrounding view about a cash write', async () => {
      const onDataChanged = vi.fn();
      await renderPanel(brokerage, cash, onDataChanged);

      await deleteTheCashRow();

      await waitFor(() => expect(onDataChanged).toHaveBeenCalled());
    });
  });

  // Issue #1191. The pair is not the set of accounts a trade can be funded
  // from: a purchase is as often paid for out of a chequing account or another
  // brokerage's cash. Given only the two accounts it had, the form's "Funds
  // From" picker offered nothing but the linked cash account.
  describe('the brokerage form', () => {
    it('is handed every account, not just the pair', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });

      await waitFor(() =>
        expect(screen.getByTestId('form-all-accounts')).toHaveTextContent(
          'brok,cash,chq',
        ),
      );
    });

    // A failed lookup is not an empty list. Passing `[]` would tell the form the
    // user has no other accounts; leaving it undefined keeps its own fallback.
    it('supplies no account list at all when the lookup fails', async () => {
      (accountsApi.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('offline'),
      );
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });

      expect(screen.getByTestId('form-all-accounts')).toHaveTextContent('undefined');
    });
  });

  // Issue #1193: this register is the surface the bug was reported against. It
  // passed no density props, so the list fell through to its own
  // `useState('normal')` and the level reset on every remount -- which is what
  // a page refresh, a tab switch, or navigating away and back all are.
  describe('filters', () => {
    const trade = {
      id: 'tx-1',
      accountId: 'brok',
      action: 'BUY',
      transactionDate: '2026-01-05',
      quantity: 1,
      price: 10,
      totalAmount: 10,
      security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
    };

    beforeEach(() => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [trade],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      (
        transactionsApi.getRegisterFilterOptions as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        // Deliberately not the register row's own payee: the option has to be
        // found in the picker, not in the list behind it.
        payees: [{ id: 'payee-1', name: 'Payroll' }],
        categories: [{ id: 'cat-1', name: 'Investments', parentId: null }],
      });
      (
        investmentsApi.getRegisterFilterOptions as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        // XEQT is not held any more; its trades are still in the register, and
        // are exactly what somebody filtering by symbol tends to be after.
        actions: ['BUY', 'SELL'],
        symbols: ['VTI', 'XEQT'],
      });
    });

    /** Open the filter row of whichever register is on screen. */
    const openFilters = async () => {
      await act(async () => {
        fireEvent.click(screen.getByText('Filter'));
      });
    };

    it('offers the brokerage register a filter row', async () => {
      await renderPanel(brokerage, cash);
      await openFilters();

      expect(screen.getByLabelText('Symbol')).toBeInTheDocument();
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
    });

    it('offers the symbols the rows use, sold-out positions included', async () => {
      await renderPanel(brokerage, cash);
      await openFilters();

      const symbolPicker = screen.getByLabelText('Symbol');
      const offered = Array.from(symbolPicker.querySelectorAll('option')).map(
        (o) => o.textContent,
      );
      expect(offered).toContain('VTI');
      expect(offered).toContain('XEQT');
    });

    it('narrows the trades to the chosen symbol', async () => {
      await renderPanel(brokerage, cash);
      await openFilters();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Symbol'), {
          target: { value: 'VTI' },
        });
      });

      await waitFor(() => {
        expect(investmentsApi.getTransactions).toHaveBeenLastCalledWith(
          expect.objectContaining({ symbol: 'VTI', page: 1 }),
        );
      });
    });

    it('offers the cash register its own kind of filter', async () => {
      await renderPanel(brokerage, cash);
      await switchToCash();
      await openFilters();

      // Payees and categories, which is what a cash row is filed under -- the
      // brokerage side's symbol and action mean nothing here.
      expect(screen.getByText('Payees')).toBeInTheDocument();
      expect(screen.getByText('Categories')).toBeInTheDocument();
      expect(screen.queryByLabelText('Symbol')).not.toBeInTheDocument();
    });

    it("asks for the filter options of this account's cash ledger", async () => {
      await renderPanel(brokerage, cash);
      await switchToCash();

      await waitFor(() => {
        expect(transactionsApi.getRegisterFilterOptions).toHaveBeenCalledWith([
          'cash',
        ]);
      });
    });

    it('keeps the rows on screen while a filter reload runs', async () => {
      // Swapping the table for three skeleton lines shortens the page under the
      // reader, and the browser answers by scrolling to the top -- which is
      // what applying a filter here used to do. The rows stay until the next
      // payload lands.
      let resolveSecond!: (value: unknown) => void;
      await renderPanel(brokerage, cash);
      // The table is what the skeleton branch replaces, so the table is what
      // has to survive the reload.
      const rowCount = () => document.querySelectorAll('tbody tr').length;
      await waitFor(() => expect(rowCount()).toBeGreaterThan(0));

      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise((res) => {
          resolveSecond = res;
        }),
      );
      await openFilters();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Symbol'), {
          target: { value: 'VTI' },
        });
      });

      // Mid-flight: the previous page's rows are still drawn.
      expect(rowCount()).toBeGreaterThan(0);

      await act(async () => {
        resolveSecond({
          data: [trade],
          pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        });
      });
    });

    it('narrows the cash rows to the chosen payee', async () => {
      await renderPanel(brokerage, cash);
      await switchToCash();
      await openFilters();

      // The picker is a dropdown: open it, then choose.
      await act(async () => {
        fireEvent.click(screen.getByText('All payees'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Payroll'));
      });

      await waitFor(() => {
        expect(transactionsApi.getAll).toHaveBeenLastCalledWith(
          expect.objectContaining({ payeeIds: ['payee-1'], page: 1 }),
        );
      });
    });
  });

  describe('editing a cash row', () => {
    /** Click the register's only row. */
    const clickTheRow = async () => {
      await act(async () => {
        fireEvent.click(screen.getByText('Cash deposit'));
      });
    };

    it("edits a trade's cash leg as the trade", async () => {
      // Its amount, date and payee are consequences of the trade, so the cash
      // form over it edits the wrong thing -- and offers to change figures the
      // trade owns.
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ ...cashTransaction, linkedInvestmentTransactionId: 'itx-9' }],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      (investmentsApi.getTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'itx-9',
        action: 'BUY',
      });

      await renderPanel(brokerage, cash);
      await switchToCash();
      await clickTheRow();

      expect(investmentsApi.getTransaction).toHaveBeenCalledWith('itx-9');
      expect(screen.getByTestId('investment-form')).toBeInTheDocument();
      expect(screen.queryByTestId('cash-form')).not.toBeInTheDocument();
    });

    it('fetches a transfer in full before editing it', async () => {
      // The counterpart is not in the list payload, so the form would open
      // without knowing where the money went.
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ ...cashTransaction, isTransfer: true }],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      (transactionsApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...cashTransaction,
        isTransfer: true,
        linkedTransactionId: 'cash-tx-2',
      });

      await renderPanel(brokerage, cash);
      await switchToCash();
      await clickTheRow();

      expect(transactionsApi.getById).toHaveBeenCalledWith('cash-tx-1');
      expect(screen.getByTestId('cash-form')).toBeInTheDocument();
    });

    it('edits an ordinary cash row as itself', async () => {
      await renderPanel(brokerage, cash);
      await switchToCash();
      await clickTheRow();

      expect(screen.getByTestId('cash-form')).toBeInTheDocument();
      expect(screen.queryByTestId('investment-form')).not.toBeInTheDocument();
    });
  });

  describe('the two registers read as one', () => {
    // A toggle is a change of ledger, not a change of page: a heading that
    // renames itself, a button that gains a plus, or a gap that appears on one
    // side make the switch look like a navigation.
    const headingText = 'Recent Transactions';

    // Both sides hold rows, so both draw a table -- an empty register is a
    // different layout on either side, and not the one being compared here.
    beforeEach(() => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            accountId: 'brok',
            action: 'BUY',
            transactionDate: '2026-01-05',
            quantity: 1,
            price: 10,
            totalAmount: 10,
            security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
    });

    it('gives both ledgers the same heading', async () => {
      await renderPanel(brokerage, cash);
      expect(screen.getByText(headingText)).toBeInTheDocument();

      await switchToCash();
      expect(screen.getByText(headingText)).toBeInTheDocument();
    });

    it('marks the new-row button the same way on both', async () => {
      await renderPanel(brokerage, cash);
      expect(screen.getByText('+ New Brokerage Transaction')).toBeInTheDocument();

      await switchToCash();
      expect(screen.getByText('+ New Cash Transaction')).toBeInTheDocument();
    });

    it('titles each form the way the Investments page titles it', async () => {
      // One register drawn on two pages should not announce itself differently
      // on each: these modals opened with no heading at all.
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });
      expect(screen.getByText('New Investment Transaction')).toBeInTheDocument();

      await switchToCash();
      await act(async () => {
        fireEvent.click(screen.getByText('+ New Cash Transaction'));
      });
      expect(screen.getByText('New Transaction')).toBeInTheDocument();
    });

    it('opens the brokerage form at the width the Investments page opens it', async () => {
      // Same form, same modal, two pages: it was `6xl` here and `xl` there, so
      // the same dialogue arrived half the screen wider depending on the route
      // taken to it.
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });

      expect(document.querySelector('.max-w-xl')).toBeInTheDocument();
      expect(document.querySelector('.max-w-6xl')).not.toBeInTheDocument();
    });

    it('widens for the currency conversion section, and narrows again after', async () => {
      await renderPanel(brokerage, cash);
      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('form-needs-conversion'));
      });
      expect(document.querySelector('.max-w-3xl')).toBeInTheDocument();

      // Reopening starts narrow rather than at the last form's size. Escape is
      // one of the routes out that has to reset it, alongside cancel, the
      // backdrop and the back button -- they all land on the same close.
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });
      expect(document.querySelector('.max-w-xl')).toBeInTheDocument();
    });

    it('duplicates a trade into a new entry, and a later New starts blank', async () => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            accountId: 'brok',
            action: 'DIVIDEND',
            transactionDate: '2026-01-05',
            quantity: null,
            price: null,
            totalAmount: 12,
            security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getAllByText('Duplicate')[0]);
      });
      expect(screen.getByText('Duplicate Investment Transaction')).toBeInTheDocument();
      expect(screen.getByTestId('form-duplicate-from')).toHaveTextContent('tx-1');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });
      expect(screen.getByText('New Investment Transaction')).toBeInTheDocument();
      expect(screen.getByTestId('form-duplicate-from')).toHaveTextContent('');
    });

    it('says Edit Transaction when a row is being edited', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      await renderPanel(brokerage, cash);
      await switchToCash();

      await act(async () => {
        fireEvent.click(screen.getByText('Cash deposit'));
      });

      expect(screen.getByText('Edit Transaction')).toBeInTheDocument();
    });

    it('keeps the same gap between the heading and the strip below it', async () => {
      // The spacer is what that gap is; without it the cash register's rows sat
      // higher than the brokerage register's and the page jumped on the toggle.
      await renderPanel(brokerage, cash);
      const SPACER = '[class="mt-3 sm:mt-4"]';
      const brokerageSpacers = document.querySelectorAll(SPACER).length;

      await switchToCash();
      expect(document.querySelectorAll(SPACER)).toHaveLength(brokerageSpacers);
      expect(brokerageSpacers).toBeGreaterThan(0);
    });
  });

  describe('paging', () => {
    // Two pages of trades, so the pager is drawn at all.
    const manyTrades = {
      data: [
        {
          id: 'tx-1',
          accountId: 'brok',
          action: 'BUY',
          transactionDate: '2026-01-05',
          quantity: 1,
          price: 10,
          totalAmount: 10,
          security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
        },
      ],
      pagination: { total: 60, page: 1, limit: 25, totalPages: 3 },
    };

    /**
     * Where each pager sits relative to the rows it pages.
     *
     * The claim is about reading order, not about which component rendered it.
     * A register has one at each end: the strip above the rows, so the controls
     * are met before scrolling past everything they could have helped skip, and
     * a second below, so a reader who did scroll finds them where they finished.
     */
    const pagerPositions = () => {
      const table = document.querySelector('table')!;
      return screen.getAllByTitle('Next page').map((pager) =>
        // Node.DOCUMENT_POSITION_FOLLOWING: the table comes after the pager.
        pager.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING
          ? 'above'
          : 'below',
      );
    };

    beforeEach(() => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue(
        manyTrades,
      );
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 60, page: 1, limit: 25, totalPages: 3 },
      });
    });

    it('pages the brokerage register from both ends of its rows', async () => {
      await renderPanel(brokerage, cash);

      expect(pagerPositions()).toEqual(['above', 'below']);
    });

    it("puts the cash register's pagers in the same places", async () => {
      // The point of the change: one account's two ledgers, one toggle apart,
      // page from the same rows of controls.
      await renderPanel(brokerage, cash);
      await switchToCash();

      expect(pagerPositions()).toEqual(['above', 'below']);
    });

    it('asks for the next page of trades when the top pager advances', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getAllByTitle('Next page')[0]);
      });

      expect(investmentsApi.getTransactions).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountIds: 'brok', page: 2 }),
      );
    });

    // Both ends drive the same state. A second pager wired to a stale page
    // number, or to nothing, is worse than not drawing one.
    it('asks for the next page of trades when the bottom pager advances', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getAllByTitle('Next page')[1]);
      });

      expect(investmentsApi.getTransactions).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountIds: 'brok', page: 2 }),
      );
    });

    // An inert pager at the end of a list says nothing; the count does.
    it('draws the count below a register that fits on one page', async () => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...manyTrades,
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      await renderPanel(brokerage, cash);

      // The strip above keeps its pager -- that line answers "did the filter
      // work?" -- so what changes is only what is drawn below the rows.
      expect(pagerPositions()).toEqual(['above']);
      expect(screen.getByText('1 transaction')).toBeInTheDocument();
    });

    it('keeps one density toggle, which the bottom pager does not repeat', async () => {
      await renderPanel(brokerage, cash);

      expect(screen.getAllByTitle('Toggle row density')).toHaveLength(1);
    });
  });

  describe('row density', () => {
    // The toolbar carrying the toggle only renders once the register has rows.
    beforeEach(() => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            accountId: 'brok',
            action: 'BUY',
            transactionDate: '2026-01-05',
            quantity: 1,
            price: 10,
            totalAmount: 10,
            security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
    });

    it('keeps the chosen level when the panel is remounted', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByTitle('Toggle row density'));
      });
      expect(screen.getByTitle('Toggle row density')).toHaveTextContent('Compact');

      cleanup();
      await renderPanel(brokerage, cash);

      expect(screen.getByTitle('Toggle row density')).toHaveTextContent('Compact');
    });

    it('keeps the chosen level across a switch to the cash ledger and back', async () => {
      // Switching ledgers unmounts the brokerage list outright, so this is the
      // remount case again, reached without leaving the page.
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByTitle('Toggle row density'));
        fireEvent.click(screen.getByTitle('Toggle row density'));
      });
      expect(screen.getByTitle('Toggle row density')).toHaveTextContent('Dense');

      await act(async () => {
        fireEvent.click(screen.getByText('Cash'));
      });
      // The cash ledger is on screen -- its own New button says so, since both
      // registers now share the heading.
      expect(screen.getByText('+ New Cash Transaction')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Brokerage'));
      });
      expect(screen.getByTitle('Toggle row density')).toHaveTextContent('Dense');
    });
  });
});
