'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { editCashRow } from '@/lib/cash-row-edit';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useFormModal } from '@/hooks/useFormModal';
import { useBrokerageFilterOptions } from '@/hooks/useBrokerageFilterOptions';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import {
  InvestmentTransactionList,
  type TransactionFilters,
} from '@/components/investments/InvestmentTransactionList';
import { ListBottomPager } from '@/components/ui/ListBottomPager';
import {
  CashFilterBar,
  CashFilterToggleButton,
  countActiveCashFilters,
  EMPTY_CASH_FILTERS,
  useCashFilterOptions,
  type CashFilterValues,
} from '@/components/investments/CashRegisterFilters';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { investmentTransactionModalClass } from '@/components/investments/investment-transaction-modal';
import { TransactionList } from '@/components/transactions/TransactionList';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import {
  InvestmentViewToggle,
  type InvestmentTransactionView,
} from '@/components/investments/InvestmentViewToggle';
import type { Account } from '@/types/account';
import type { InvestmentTransaction } from '@/types/investment';
import type { Transaction } from '@/types/transaction';

const PAGE_SIZE = 25;

interface InvestmentRegisterPanelProps {
  /** The account holding the securities: the brokerage half, or a standalone. */
  holdingsAccount: Account;
  /**
   * The ledger holding the money: the cash half of a pair, or the account
   * itself when it keeps its own cash. Null for a brokerage with no cash
   * ledger, which offers the brokerage register alone.
   */
  cashAccount: Account | null;
  /**
   * Raised after any write on either ledger, so the surrounding view can
   * re-fetch what it derives from these rows. A cash deposit moves the cash
   * balance the Holdings by Account list is showing, and reloading this panel
   * alone left that figure at its pre-write value until the page was reloaded
   * (issue #1190).
   */
  onDataChanged?: () => void;
}

/**
 * Both ledgers of one investment account, behind a single toggle.
 *
 * An investment account is stored as two accounts -- securities on one, money
 * on the other -- and this is where that stops being the user's problem: the
 * trades and the cash register sit under one heading, and the toggle chooses
 * which is on screen. Each side keeps its own pagination and its own form, and
 * every write drops the balance caches, because a trade moves cash and a cash
 * row can carry an investment split.
 */
export function InvestmentRegisterPanel({
  holdingsAccount,
  cashAccount,
  onDataChanged,
}: InvestmentRegisterPanelProps) {
  const t = useTranslations('accountDetail-investment');
  // The cash register's own chrome is the Investments page's, word for word:
  // one heading, one button label, translated once.
  const tInv = useTranslations('investments');
  // The cash register is the shared transactions list, so its pager counts
  // "transactions" out of that list's own catalog rather than a second copy of
  // the noun under `investments`.
  const tTx = useTranslations('transactions');
  const [view, setView] = useLocalStorage<InvestmentTransactionView>(
    'monize-account-detail-register-view',
    'brokerage',
  );

  const [brokerageTx, setBrokerageTx] = useState<InvestmentTransaction[]>([]);
  const [brokeragePage, setBrokeragePage] = useState(1);
  const [brokerageTotal, setBrokerageTotal] = useState(0);
  const [cashTx, setCashTx] = useState<Transaction[]>([]);
  const [cashPage, setCashPage] = useState(1);
  const [cashTotal, setCashTotal] = useState(0);
  // The balance the page's first row runs from. It is part of the same
  // payload as the rows and is only meaningful beside them, so it is adopted
  // in the same block -- a starting balance from one page against another
  // page's rows is a running balance for transactions nobody is looking at.
  const [cashStartingBalance, setCashStartingBalance] = useState<
    number | undefined
  >(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  // Each register is narrowed by its own kind of question -- a trade by symbol
  // and action, a cash row by payee and category -- so the two filters are
  // separate state, and each one's page returns to 1 when it changes.
  const [brokerageFilters, setBrokerageFilters] = useState<TransactionFilters>({});
  const [cashFilters, setCashFilters] = useState<CashFilterValues>(EMPTY_CASH_FILTERS);
  const [showCashFilters, setShowCashFilters] = useState(false);
  // Whether the brokerage form is currently showing its currency-conversion
  // section, which the modal widens to fit. The Investments page's copy of this
  // modal does the same, so the same form opens at the same size on both.
  const [brokerageFormNeedsConversion, setBrokerageFormNeedsConversion] =
    useState(false);
  // Every account the user can fund a trade from, for the brokerage form's
  // "Funds From" / "Deposit To" pickers. Undefined until it loads and after a
  // failure, because the form reads undefined as "not supplied" and falls back
  // to the pair -- an empty array would be a claim that the user has no other
  // accounts. See the effect below.
  const [allAccounts, setAllAccounts] = useState<Account[] | undefined>(undefined);
  // The key of the request the data on screen answered. Deriving the loading
  // flag from it, rather than setting one at the top of the effect, keeps the
  // payload and the request that produced it together -- and setState in an
  // effect body is banned for the cascading render it causes.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // The cash register is scoped to the cash ledger alone. Widening it to the
  // pair would put the brokerage's own rows -- the ones its trades generated
  // on the other side -- into a register the user reads as their cash account.
  const cashAccountId = cashAccount?.id ?? null;
  const holdingsAccountId = holdingsAccount.id;
  // Everything that changes which rows belong on screen -- the filters
  // included, or the register would answer a question nobody asked until the
  // next page change.
  const requestKey = [
    holdingsAccountId,
    cashAccountId ?? '',
    brokeragePage,
    cashPage,
    reloadKey,
    JSON.stringify(brokerageFilters),
    JSON.stringify(cashFilters),
  ].join('|');
  // Skeletons only before there is anything to show. Once the register has
  // rows, a filter or a page change keeps them on screen while the next
  // request runs: swapping a table for three skeleton lines shortens the page
  // under the reader, and the browser answers by scrolling them to the top --
  // which is what applying a filter here used to do.
  const isFirstLoad = loadedKey === null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [brokerage, cash] = await Promise.all([
        investmentsApi
          .getTransactions({
            accountIds: holdingsAccountId,
            page: brokeragePage,
            limit: PAGE_SIZE,
            symbol: brokerageFilters.symbol,
            action: brokerageFilters.action,
            startDate: brokerageFilters.startDate,
            endDate: brokerageFilters.endDate,
          })
          .catch(() => null),
        cashAccountId
          ? transactionsApi
              .getAll({
                accountIds: [cashAccountId],
                page: cashPage,
                limit: PAGE_SIZE,
                payeeIds: cashFilters.payeeIds.length ? cashFilters.payeeIds : undefined,
                categoryIds: cashFilters.categoryIds.length ? cashFilters.categoryIds : undefined,
                startDate: cashFilters.startDate || undefined,
                endDate: cashFilters.endDate || undefined,
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      // A failed request is not an empty register: keep whatever is on screen
      // rather than reporting no transactions.
      if (brokerage) {
        setBrokerageTx(brokerage.data);
        setBrokerageTotal(brokerage.pagination?.total ?? brokerage.data.length);
      }
      if (cash) {
        setCashTx(cash.data);
        setCashTotal(cash.pagination?.total ?? cash.data.length);
        setCashStartingBalance(cash.startingBalance);
      }
      setLoadedKey(requestKey);
    })();
    return () => {
      cancelled = true;
    };
    // `requestKey` carries the filters; listing them again would re-run the
    // effect on an object identity that says nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, holdingsAccountId, cashAccountId, brokeragePage, cashPage]);

  // The pair alone is not the set of accounts a trade can be funded from -- a
  // purchase is as often paid for out of a chequing account or another
  // brokerage's cash. The Investments page hands the same form the full list;
  // the detail page passed only the two accounts it had, so the picker offered
  // nothing but the linked cash account (issue #1191).
  useEffect(() => {
    let cancelled = false;
    accountsApi
      .getAll()
      .then((accounts) => {
        if (!cancelled) setAllAccounts(accounts);
      })
      // A failed lookup is not an empty list: leaving this undefined keeps the
      // form on its own fallback rather than showing an empty picker.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const afterWrite = useCallback(() => {
    // A trade settles into the cash ledger and a cash row can carry an
    // investment split, so either side moves balances the cached account list
    // and portfolio summary are showing.
    invalidateBalanceCaches();
    reload();
    // Dropped caches only make the *next* fetch honest. The holdings, the
    // portfolio summary and the allocation beside this panel are already
    // rendered, so they have to be told to fetch again.
    onDataChanged?.();
  }, [reload, onDataChanged]);

  // Narrowing a register changes which rows page 1 holds, so both filters take
  // their list back to it.
  const handleBrokerageFiltersChange = useCallback((next: TransactionFilters) => {
    setBrokerageFilters(next);
    setBrokeragePage(1);
  }, []);

  const handleCashFiltersChange = useCallback((next: CashFilterValues) => {
    setCashFilters(next);
    setCashPage(1);
  }, []);

  const brokerageForm = useFormModal<InvestmentTransaction>();
  const cashForm = useFormModal<Transaction>();

  // Every way out of the brokerage modal resets the conversion width, so
  // reopening it starts narrow rather than at the last form's size.
  const closeBrokerageForm = useCallback(() => {
    setBrokerageFormNeedsConversion(false);
    brokerageForm.close();
  }, [brokerageForm]);

  // A row in this register can be a trade's cash leg, whose numbers the trade
  // owns -- so it is edited as the trade, in the brokerage form mounted below,
  // rather than as a cash row. Same decision as the Investments page's copy of
  // this register (`editCashRow`).
  const handleEditCashRow = useCallback(
    (transaction: Transaction) =>
      editCashRow(transaction, {
        openInvestment: brokerageForm.openEdit,
        openCash: cashForm.openEdit,
        onLookupFailed: (error) =>
          toast.error(getErrorMessage(error, t('register.loadFailed'))),
      }),
    [brokerageForm.openEdit, cashForm.openEdit, t],
  );

  const handleDeleteBrokerage = useCallback(
    async (id: string) => {
      try {
        await investmentsApi.deleteTransaction(id);
        afterWrite();
      } catch (error) {
        toast.error(getErrorMessage(error, t('register.deleteFailed')));
      }
    },
    [afterWrite, t],
  );

  // There is deliberately no cash-delete handler here. `InvestmentTransactionList`
  // asks its parent to perform the delete; `TransactionList` performs its own and
  // only reports it afterwards, so the cash register needs `onRefresh` and
  // nothing else. Deleting again from here 404'd on the row the list had just
  // removed, putting a "not found" toast beside the success one (issue #1192).

  const accountsForForm = cashAccount
    ? [holdingsAccount, cashAccount]
    : [holdingsAccount];

  const toggle = cashAccount ? (
    <InvestmentViewToggle value={view} onChange={setView} />
  ) : undefined;
  // With no cash ledger there is nothing to switch to, so the brokerage
  // register is simply the register.
  const activeView: InvestmentTransactionView = cashAccount ? view : 'brokerage';

  // What the brokerage filter offers: what this account has actually traded.
  // Asked for whichever ledger is showing, because the register query resolves
  // the pair either way.
  const brokerageOptions = useBrokerageFilterOptions([holdingsAccountId]);

  // What the cash filter's pickers offer: this ledger's own payees and
  // categories, fetched while its register is the one on screen.
  const cashFilterOptions = useCashFilterOptions(
    activeView === 'cash',
    cashAccountId ? [cashAccountId] : [],
  );

  return (
    <div className="space-y-4">
      {activeView === 'brokerage' ? (
        <>
          {/* Paging goes to the list, which draws it in the strip above the
              table -- where the cash register beside it draws its own. */}
          <InvestmentTransactionList
            densityView="accountRegister"
            transactions={brokerageTx}
            accounts={accountsForForm}
            isLoading={isFirstLoad}
            onDelete={handleDeleteBrokerage}
            onEdit={brokerageForm.openEdit}
            onNewTransaction={brokerageForm.openCreate}
            onStatusChanged={reload}
            viewToggle={toggle}
            filters={brokerageFilters}
            onFiltersChange={handleBrokerageFiltersChange}
            availableSymbols={brokerageOptions.symbols}
            availableActions={brokerageOptions.actions}
            currentPage={brokeragePage}
            totalPages={Math.ceil(brokerageTotal / PAGE_SIZE) || 1}
            totalItems={brokerageTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setBrokeragePage}
          />
          <ListBottomPager
            currentPage={brokeragePage}
            totalPages={Math.ceil(brokerageTotal / PAGE_SIZE) || 1}
            totalItems={brokerageTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setBrokeragePage}
            itemName={tInv('transactionList.itemNamePlural')}
            totalLabel={tInv('transactionList.totalCount', {
              count: brokerageTotal,
            })}
          />
        </>
      ) : (
        <>
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
            <div className="flex items-center gap-3">
              {/* Both registers are "Recent Transactions": the toggle beside it
                  says which ledger is on screen, so a second heading naming the
                  ledger only made the title jump on the way. */}
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {tInv('transactionList.title')}
              </h3>
              {toggle}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={cashForm.openCreate}
                className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                <span className="sm:hidden">{tInv('page.newCashTransactionShort')}</span>
                <span className="hidden sm:inline">{tInv('page.newCashTransaction')}</span>
              </button>
              <CashFilterToggleButton
                activeCount={countActiveCashFilters(cashFilters)}
                onClick={() => setShowCashFilters((open) => !open)}
              />
            </div>
          </div>
          {showCashFilters && (
            <CashFilterBar
              options={cashFilterOptions}
              value={cashFilters}
              onChange={handleCashFiltersChange}
            />
          )}
          {/* The same gap the brokerage list keeps between its header and the
              strip below, so switching ledgers moves nothing. */}
          <div className="mt-3 sm:mt-4" />
          <TransactionList
            densityView="accountRegister"
            transactions={cashTx}
            onEdit={handleEditCashRow}
            onRefresh={afterWrite}
            isSingleAccountView
            currentPage={cashPage}
            totalPages={Math.ceil(cashTotal / PAGE_SIZE) || 1}
            totalItems={cashTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setCashPage}
            startingBalance={cashStartingBalance}
          />
        </div>
        {/* Outside the card the rows sit in, because the pager carries its own
            background -- the same place the Transactions page draws it. */}
        <ListBottomPager
          currentPage={cashPage}
          totalPages={Math.ceil(cashTotal / PAGE_SIZE) || 1}
          totalItems={cashTotal}
          pageSize={PAGE_SIZE}
          onPageChange={setCashPage}
          itemName={tTx('list.itemNamePlural')}
          totalLabel={tTx('page.totalCount', { count: cashTotal })}
        />
        </>
      )}

      <Modal
        isOpen={brokerageForm.showForm}
        onClose={closeBrokerageForm}
        {...brokerageForm.modalProps}
        maxWidth={brokerageFormNeedsConversion ? '3xl' : 'xl'}
        className={investmentTransactionModalClass(brokerageFormNeedsConversion)}
        // The same title the Investments page's copy of this modal carries,
        // from the same keys: one register drawn on two pages should not
        // announce itself differently on each.
        title={
          brokerageForm.editingItem
            ? tInv('page.editTransaction')
            : tInv('page.newInvestmentTransaction')
        }
      >
        <InvestmentTransactionForm
          accounts={accountsForForm}
          allAccounts={allAccounts}
          transaction={brokerageForm.editingItem}
          defaultAccountId={holdingsAccount.id}
          onSuccess={() => {
            closeBrokerageForm();
            afterWrite();
          }}
          onCancel={closeBrokerageForm}
          onDirtyChange={brokerageForm.setFormDirty}
          onConversionStateChange={setBrokerageFormNeedsConversion}
          submitRef={brokerageForm.formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...brokerageForm.unsavedChangesDialog} />

      {cashAccount && (
        <>
          <Modal
            isOpen={cashForm.showForm}
            onClose={cashForm.close}
            {...cashForm.modalProps}
            maxWidth="6xl"
            className="p-6 !max-w-[69rem]"
            title={cashForm.editingItem ? tInv('page.editTransaction') : tInv('page.newTransaction')}
          >
            <TransactionForm
              transaction={cashForm.editingItem}
              defaultAccountId={cashAccount.id}
              onSuccess={() => {
                cashForm.close();
                afterWrite();
              }}
              onCancel={cashForm.close}
              onDirtyChange={cashForm.setFormDirty}
              submitRef={cashForm.formSubmitRef}
            />
          </Modal>
          <UnsavedChangesDialog {...cashForm.unsavedChangesDialog} />
        </>
      )}
    </div>
  );
}
