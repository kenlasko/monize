'use client';

import { useState, useMemo, useCallback, memo, Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { DateInput } from '@/components/ui/DateInput';
import { InvestmentTransaction } from '@/types/investment';
import {
  buildInvestmentTxActions,
  InvestmentPriceValue,
  InvestmentSharesValue,
  InvestmentTotalValue,
  InvestmentTransactionCardBody,
  useInvestmentActionInfo,
} from '@/components/investments/InvestmentTransactionListParts';
import { TransactionStatus } from '@/types/transaction';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { nextCycleStatus } from '@/lib/transaction-status-cycle';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import toast from 'react-hot-toast';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DensityLevel, useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference, type DensityView } from '@/store/densityStore';
import { Account } from '@/types/account';
import { getLocalDateString } from '@/lib/utils';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { useIsMobile } from '@/hooks/useIsMobile';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import { DensityToggle } from '@/components/ui/DensityToggle';
import { ListTopToolbar } from '@/components/ui/ListTopToolbar';

export interface TransactionFilters {
  symbol?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
}

interface InvestmentTransactionListProps {
  transactions: InvestmentTransaction[];
  accounts?: Account[];
  isLoading: boolean;
  onDelete?: (id: string) => void;
  onEdit?: (transaction: InvestmentTransaction) => void;
  onNewTransaction?: () => void;
  /**
   * Called after a status change committed. A VOID crossing moves holdings
   * and the linked cash balance, so the parent refetches rather than patching
   * the row locally.
   */
  onStatusChanged?: () => void;
  filters?: TransactionFilters;
  onFiltersChange?: (filters: TransactionFilters) => void;
  availableSymbols?: string[];
  /**
   * The actions the rows on this register actually use. The Action picker
   * offers these instead of the full vocabulary, which is twenty-odd wide while
   * a household brokerage uses four. Empty or absent -- still loading, or the
   * lookup failed -- means "no information", so the picker keeps offering
   * everything rather than emptying itself.
   */
  availableActions?: string[];
  /** Which surface's remembered row density this register reads. */
  densityView?: DensityView;
  viewToggle?: React.ReactNode;
  /**
   * Paging, when this list owns it. Supplied together, they put the pager in
   * the strip above the table -- the same strip, in the same place, as the cash
   * register beside it (`ListTopToolbar`), and the density toggle moves into it
   * so the two registers of one account read identically. Left out, the list
   * keeps the toggle in its heading and the surrounding page draws whatever
   * pager it draws; the Investments page pages both of its registers below the
   * table, and is consistent with itself that way.
   */
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}

interface InvestmentTransactionRowProps {
  tx: InvestmentTransaction;
  accountName?: string;
  index: number;
  density: DensityLevel;
  cellPadding: string;
  defaultCurrency: string;
  formatDate: (date: string) => string;
  formatCurrency: (amount: number, currencyCode?: string, fractionDigits?: number) => string;
  formatQuantity: (value: number) => string;
  getRowHandlers: (tx: InvestmentTransaction) => LongPressRowHandlers;
  onEdit?: (tx: InvestmentTransaction) => void;
  onDeleteClick: (tx: InvestmentTransaction) => void;
  onCycleStatus: (tx: InvestmentTransaction) => void;
  hasActions: boolean;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and every other
   * density renders the tier row below, unchanged.
   *
   * The card carries EIGHT of this register's nine columns -- Date, Action,
   * Symbol (with the security name that hangs under it at Normal density),
   * Shares, Price, Total, Account and Status. FOUR of those are ones a
   * phone-width tier row does not show at all: Shares is `hidden
   * sm:table-cell`, Price `hidden md:table-cell`, Account and Status `hidden
   * lg:table-cell` -- so the card is how they get back on screen. Nothing is
   * omitted for width; the one column left out is **Actions**, because the
   * long-press (and right-click) sheet these same row handlers open already
   * carries Edit and Delete.
   *
   * The three lines are: Date, Action + Symbol (+ the security name), and the
   * Total; then Shares and Price; then the Account and the status button.
   *
   * Two of those are decisions worth stating rather than defects to fix here:
   *
   * - **Account is carried on both surfaces**, because it is a RESPONSIVE
   *   column on this register rather than a structural one -- unlike the cash
   *   register, which omits it from the DOM entirely on a single account's
   *   page. There is no `isSingleAccountView` here and neither mount site
   *   supplies one, so on the account detail page's panel the card repeats
   *   that page's own account on every row. Deriving "one account" from the
   *   rows instead would make the card and the tier table disagree about
   *   whether the column exists; making it structural is a change to both
   *   branches and to both callers, and is filed as a follow-up.
   * - **Price shows whatever the tier's Price cell shows**, which for the
   *   amount-only actions (DIVIDEND, INTEREST, CAPITAL_GAIN and their
   *   refinements) is the cash amount rather than a per-share price, and for
   *   the quantity-only ones (ADD_SHARES, REMOVE_SHARES) is an unrecorded
   *   price rendered as zero. The card calls the tier's own renderer, so the
   *   two cannot disagree; that the label overstates what the figure is, is a
   *   pre-existing property of the column and a separate follow-up. A layout
   *   mode does not re-decide what a value means.
   *
   * The two breakpoints are not the same one. The tier row's Actions cell is
   * `min-[480px]`, and `wrapped` covers everything below 640px, so between
   * 480px and 639px at Normal density the actions move from inline buttons to
   * that sheet -- which also means they stop being tab-reachable there. It is
   * the price of the card, paid for the four columns above, and the cash
   * register and the payees list make the same trade at the same two widths,
   * so they all behave alike. Compact density, one tap
   * away, is the way back to inline actions.
   *
   * Both surfaces that mount this list wrap: the Investments page and the
   * account detail page's register panel pass the same row-shaping props
   * (`accounts` differ in scope, nothing else), so neither has a column the
   * card cannot carry.
   */
  wrapped?: boolean;
}

const InvestmentTransactionRow = memo(function InvestmentTransactionRow({
  tx,
  accountName,
  index,
  density,
  cellPadding,
  defaultCurrency,
  formatDate,
  formatCurrency,
  formatQuantity,
  getRowHandlers,
  onEdit,
  onDeleteClick,
  onCycleStatus,
  hasActions,
  wrapped = false,
}: InvestmentTransactionRowProps) {
  const tc = useTranslations('common');
  const actionInfoFor = useInvestmentActionInfo();
  const actionInfo = actionInfoFor(tx.action);

  const actions = buildInvestmentTxActions(
    tx,
    { edit: tc('actions.edit'), delete: tc('actions.delete') },
    { onEdit, onDeleteClick },
  );

  // Same treatment as the cash register: a VOID row is struck through and
  // dimmed, because it records something that did not happen.
  const isVoid = tx.status === TransactionStatus.VOID;
  const voidText = isVoid ? 'line-through' : '';

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- the shares, the price and the total come from
  // the same three renderers the tier cells below call, so the two branches
  // cannot come to disagree about what a SPLIT's quantity means, when a price
  // is a dash, or what a redemption's total is. The row keeps its own
  // handlers, its VOID treatment and its hover, so the long-press sheet and
  // the row click work identically. Striping is not carried over: it only
  // exists at Compact and Dense, which never wrap.
  if (wrapped) {
    return (
      <tr
        {...getRowHandlers(tx)}
        className={`group hover:bg-gray-100 dark:hover:bg-gray-800 select-none bg-white dark:bg-gray-900 ${onEdit ? 'cursor-pointer' : ''} ${isVoid ? 'opacity-50' : ''}`}
      >
        <td className="p-0">
          {/* The inset is this table's own `cellPadding` -- the `wide` scale
              it already reads -- never a hand-picked literal. That keeps the
              card and the tier rows above and below it inset identically at
              every density, and it keeps the value in one place: a change to
              the scale reaches both layouts rather than one. The `wide`
              scale's phone inset is narrower than every other table's, which
              is why this card can hold two figures on a line at 320px. (The
              "Today" divider between the rows spells its own padding and is
              a shade wider; it renders in both layouts, so it is left exactly
              as it was and noted as a follow-up.) */}
          <div className={cellPadding}>
            <InvestmentTransactionCardBody
              tx={tx}
              accountName={accountName}
              defaultCurrency={defaultCurrency}
              formatDate={formatDate}
              formatCurrency={formatCurrency}
              formatQuantity={formatQuantity}
              actionInfo={actionInfo}
              onCycleStatus={onCycleStatus}
              voidText={voidText}
            />
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      {...getRowHandlers(tx)}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${onEdit ? 'cursor-pointer' : ''} ${isVoid ? 'opacity-50' : ''}`}
    >
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${voidText}`}>
        {formatDate(tx.transactionDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 hidden lg:table-cell`}>
        <span title={accountName}>{accountName || '-'}</span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className={`text-sm font-medium ${actionInfo.color}`}>
          {density === 'dense' ? actionInfo.shortLabel : actionInfo.label}
        </span>
      </td>
      <td className={`${cellPadding}`}>
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {tx.security?.symbol || '-'}
        </div>
        {density === 'normal' && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {tx.security?.name || ''}
          </div>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100 hidden sm:table-cell ${voidText}`}>
        <InvestmentSharesValue tx={tx} formatQuantity={formatQuantity} />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100 hidden md:table-cell ${voidText}`}>
        <InvestmentPriceValue
          tx={tx}
          formatCurrency={formatCurrency}
          defaultCurrency={defaultCurrency}
        />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100 ${voidText}`}>
        <InvestmentTotalValue
          tx={tx}
          formatCurrency={formatCurrency}
          defaultCurrency={defaultCurrency}
        />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-center hidden lg:table-cell`}>
        <StatusCellButton
          status={tx.status}
          dense={density === 'dense'}
          onCycle={() => onCycleStatus(tx)}
        />
      </td>
      {hasActions && (
        <td className={`${cellPadding} whitespace-nowrap text-right text-sm hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`} onClick={(e) => e.stopPropagation()}>
          <RowActions actions={actions} density={density} />
        </td>
      )}
    </tr>
  );
});

export function InvestmentTransactionList({
  transactions,
  accounts = [],
  isLoading,
  onDelete,
  onEdit,
  onNewTransaction,
  onStatusChanged,
  filters,
  onFiltersChange,
  availableSymbols = [],
  availableActions,
  densityView = 'investments',
  viewToggle,
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: InvestmentTransactionListProps) {
  const t = useTranslations('investments');
  // Whether paging is this list's to draw. All five props travel together, so
  // one of them is the question -- and the answer also decides where the
  // density toggle lives, because the strip is where it belongs once there is
  // a strip.
  const ownsPaging = onPageChange !== undefined;
  const ACTION_OPTIONS = [
    { value: '', label: t('transactionList.allActions') },
    { value: 'BUY', label: t('transactionList.actionBuy') },
    { value: 'SELL', label: t('transactionList.actionSell') },
    { value: 'DIVIDEND', label: t('transactionList.actionDividend') },
    { value: 'INTEREST', label: t('transactionList.actionInterest') },
    { value: 'CAPITAL_GAIN', label: t('transactionList.actionCapitalGain') },
    { value: 'REINVEST', label: t('transactionList.actionReinvest') },
    { value: 'SPLIT', label: t('transactionList.actionSplit') },
    { value: 'TRANSFER_IN', label: t('transactionList.actionTransferIn') },
    { value: 'TRANSFER_OUT', label: t('transactionList.actionTransferOut') },
    { value: 'ADD_SHARES', label: t('transactionList.actionAddShares') },
    { value: 'REMOVE_SHARES', label: t('transactionList.actionRemoveShares') },
    { value: 'REINVEST_INTEREST', label: t('transactionList.actionReinvestInterest') },
    { value: 'REINVEST_CAPITAL_GAIN_SHORT', label: t('transactionList.actionReinvestCapitalGainShort') },
    { value: 'REINVEST_CAPITAL_GAIN_LONG', label: t('transactionList.actionReinvestCapitalGainLong') },
    { value: 'CAPITAL_GAIN_SHORT', label: t('transactionList.actionCapitalGainShort') },
    { value: 'CAPITAL_GAIN_LONG', label: t('transactionList.actionCapitalGainLong') },
    { value: 'REDEEM', label: t('transactionList.actionRedeem') },
  ];
  // "All actions" always stands, and so does whatever is currently selected --
  // a filter set before the rows changed must stay visible in the control that
  // set it, or the user cannot see what is narrowing the list, let alone undo
  // it.
  const actionOptions = useMemo(() => {
    if (!availableActions || availableActions.length === 0) return ACTION_OPTIONS;
    const offered = new Set(availableActions);
    return ACTION_OPTIONS.filter(
      (opt) => opt.value === '' || offered.has(opt.value) || opt.value === filters?.action,
    );
    // ACTION_OPTIONS is rebuilt each render from the translator; the values are
    // what this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableActions, filters?.action, t]);
  // The same action vocabulary the rows read, so the delete confirmation and
  // the action sheet's title cannot name an action differently from the row
  // they were opened on.
  const actionInfoFor = useInvestmentActionInfo();
  const { formatCurrency, formatQuantity } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { defaultCurrency } = useExchangeRates();
  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a.name])), [accounts]);

  // Find the index where future investments end and today/past begin.
  // Mirrors TransactionList: rows are sorted DESC by transactionDate so the
  // future block leads. "Today" is the user's local date so users west of
  // UTC don't see a tomorrow-local row classified as past.
  const futureBoundaryIndex = useMemo(() => {
    const today = getLocalDateString();
    for (let i = 0; i < transactions.length; i++) {
      if (transactions[i].transactionDate <= today) {
        return i;
      }
    }
    return transactions.length;
  }, [transactions]);
  const { density } = useDensityPreference(densityView);
  const [showFilters, setShowFilters] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; transaction: InvestmentTransaction | null }>({ isOpen: false, transaction: null });

  // Long-press opens a per-row action sheet on mobile (and via right-click).
  const tc = useTranslations('common');
  const [contextTx, setContextTx] = useState<InvestmentTransaction | null>(null);

  const handleDeleteClick = useCallback((tx: InvestmentTransaction) => {
    setDeleteConfirm({ isOpen: true, transaction: tx });
  }, []);

  const { getRowHandlers } = useLongPress<InvestmentTransaction>({
    onLongPress: setContextTx,
    onClick: (transaction) => onEdit?.(transaction),
    enabled: !!(onDelete || onEdit),
  });

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirm.transaction && onDelete) {
      onDelete(deleteConfirm.transaction.id);
    }
    setDeleteConfirm({ isOpen: false, transaction: null });
  }, [deleteConfirm.transaction, onDelete]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ isOpen: false, transaction: null });
  }, []);

  // Same cycle as the cash register: UNRECONCILED -> CLEARED -> RECONCILED on
  // click; VOID is set or cleared only through the form, so a click on a VOID
  // row explains that instead. Status strings live in the transactions catalog
  // (shared with the cash register's status cell).
  const tStatus = useTranslations('transactions');
  const handleCycleStatus = useCallback(async (tx: InvestmentTransaction) => {
    const nextStatus = nextCycleStatus(tx.status);
    if (nextStatus === null) {
      toast.error(tStatus('list.status.voidError'));
      return;
    }
    try {
      await investmentsApi.updateStatus(tx.id, nextStatus);
      const statusLabels: Record<TransactionStatus, string> = {
        [TransactionStatus.UNRECONCILED]: tStatus('list.status.unreconciled'),
        [TransactionStatus.CLEARED]: tStatus('list.status.cleared'),
        [TransactionStatus.RECONCILED]: tStatus('list.status.reconciled'),
        [TransactionStatus.VOID]: tStatus('list.status.void'),
      };
      toast.success(tStatus('list.status.changed', { status: statusLabels[nextStatus] }));
      onStatusChanged?.();
    } catch (error) {
      toast.error(getErrorMessage(error, tStatus('list.status.updateError')));
    }
  }, [onStatusChanged, tStatus]);

  // Check if any filters are active
  const hasActiveFilters = filters && (filters.symbol || filters.action || filters.startDate || filters.endDate);

  // Wide scale: this register carries more columns than any other table.
  const { cellPadding, headerPadding } = useTableDensity(density, 'wide');

  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each trade is a wrapped card carrying the Shares this
  // table hides below `sm`, the Price it hides below `md` and the Account and
  // Status it hides below `lg`; Compact and Dense keep the tier table,
  // unchanged, and so does every non-phone width. Exactly one branch renders
  // per row, chosen here. Both mounting surfaces wrap: the Investments page
  // and the account detail page's register panel differ only in the scope of
  // the `accounts` they pass, so neither has a column the card cannot carry.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  // Eight data columns, plus Actions when this surface offers any. Loop
  // invariant, so it is resolved once rather than per row.
  const colCount = 8 + (onDelete || onEdit ? 1 : 0);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('transactionList.title')}
          </h3>
          {viewToggle}
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse flex justify-between">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (transactions.length === 0 && !hasActiveFilters) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('transactionList.title')}
            </h3>
            {viewToggle}
          </div>
          {onNewTransaction && (
            <button
              onClick={onNewTransaction}
              className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 sm:min-w-[14rem]"
            >
              {t('transactionList.newBrokerageTransaction')}
            </button>
          )}
        </div>
        <p className="text-gray-500 dark:text-gray-400">
          {t('transactionList.noTransactions')}
        </p>
      </div>
    );
  }

  const handleFilterChange = (key: keyof TransactionFilters, value: string) => {
    if (onFiltersChange) {
      onFiltersChange({
        ...filters,
        [key]: value || undefined,
      });
    }
  };

  const clearFilters = () => {
    if (onFiltersChange) {
      onFiltersChange({});
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('transactionList.title')}
            {hasActiveFilters && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                {t('transactionList.filtered')}
              </span>
            )}
          </h3>
          {viewToggle}
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
        {onNewTransaction && (
          <button
            onClick={onNewTransaction}
            className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 sm:min-w-[14rem]"
          >
            <span className="sm:hidden">{t('transactionList.newBrokerageTransactionShort')}</span>
            <span className="hidden sm:inline">{t('transactionList.newBrokerageTransaction')}</span>
          </button>
        )}
        {onFiltersChange && (
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md ${
              hasActiveFilters
                ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {t('transactionList.filter')}
            {hasActiveFilters && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">
                {[filters?.symbol, filters?.action, filters?.startDate, filters?.endDate].filter(Boolean).length}
              </span>
            )}
          </button>
        )}
        {!ownsPaging && (
          <DensityToggle view={densityView} size="md" className="ml-auto" />
        )}
        </div>
      </div>

      {/* Filter Bar */}
      {showFilters && onFiltersChange && (
        <div className="px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Symbol Filter */}
            <div>
              <label
                htmlFor="investment-tx-filter-symbol"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('transactionList.symbolFilterLabel')}
              </label>
              <select
                id="investment-tx-filter-symbol"
                name="investment-tx-filter-symbol"
                value={filters?.symbol || ''}
                onChange={(e) => handleFilterChange('symbol', e.target.value)}
                className="w-full text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">{t('transactionList.allSymbols')}</option>
                {availableSymbols.map((symbol) => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
            </div>

            {/* Action Filter */}
            <div>
              <label
                htmlFor="investment-tx-filter-action"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('transactionList.actionFilterLabel')}
              </label>
              <select
                id="investment-tx-filter-action"
                name="investment-tx-filter-action"
                value={filters?.action || ''}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="w-full text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
              >
                {actionOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Date Range — onDateChange always emits an ISO date string;
                pairing it with a manual onChange caused the user's date
                format preference to be ignored on these two inputs. */}
            <DateInput
              label={t('transactionList.fromDateLabel')}
              value={filters?.startDate || ''}
              onDateChange={(date) => handleFilterChange('startDate', date)}
            />
            <DateInput
              label={t('transactionList.toDateLabel')}
              value={filters?.endDate || ''}
              onDateChange={(date) => handleFilterChange('endDate', date)}
            />
          </div>

          {/* Clear Filters */}
          {hasActiveFilters && (
            <div className="mt-3 flex justify-end">
              <button
                onClick={clearFilters}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
              >
                {t('transactionList.clearFilters')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Spacer between controls and table */}
      <div className="mt-3 sm:mt-4" />

      {ownsPaging && (
        <ListTopToolbar
          densityView={densityView}
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={onPageChange}
          itemName={t('transactionList.itemNamePlural')}
        />
      )}

      {/* Brokerage Transactions Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the column
              header goes with the columns. Unlike the cash register and the
              list tables, there is nothing in this header row to keep: it
              holds no sort control (this register is ordered by the server and
              offers no sortable column at any width), no select-all box and no
              date-view toggle -- only the eight labels the card's own captions
              now carry. A slim header would therefore have nothing to put in
              it, and a `<th>` bearing one of those labels would misdescribe
              the single card cell below to a screen reader. */}
          {!wrapped && (
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                {t('transactionList.dateColumn')}
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell`}>
                {t('transactionList.accountColumn')}
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                {t('transactionList.actionColumn')}
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                {t('transactionList.symbolColumn')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('transactionList.sharesColumn')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
                {t('transactionList.priceColumn')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                {t('transactionList.totalColumn')}
              </th>
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell`}>
                {tStatus('list.header.status')}
              </th>
              {(onDelete || onEdit) && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                  {t('transactionList.actionsColumn')}
                </th>
              )}
            </tr>
          </thead>
          )}
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.length === 0 ? (
              <tr>
                {/* Both of this table's spanning rows span ONE column in the
                    wrapped layout, because every body row there is a single
                    card cell. The tier count stays the literal it has always
                    been rather than `colCount`: the two disagree only for a
                    caller passing neither `onDelete` nor `onEdit`, which
                    neither mounting surface does, and the tier DOM is pinned
                    byte-identical (the mismatch is logged as a follow-up
                    instead). */}
                <td colSpan={wrapped ? 1 : 9} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('transactionList.noTransactionsFiltered')}
                </td>
              </tr>
            ) : transactions.map((tx, index) => {
              return (
                <Fragment key={tx.id}>
                  {index === futureBoundaryIndex && futureBoundaryIndex > 0 && (
                    <tr>
                      <td colSpan={wrapped ? 1 : colCount} className="px-0 py-0">
                        <div className="flex items-center gap-3 px-4 py-1.5">
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                          <span className="text-xs font-medium text-blue-500 dark:text-blue-400 uppercase tracking-wider whitespace-nowrap">{t('transactionList.today')}</span>
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                        </div>
                      </td>
                    </tr>
                  )}
                  <InvestmentTransactionRow
                    tx={tx}
                    accountName={accountMap.get(tx.accountId)}
                    index={index}
                    density={density}
                    cellPadding={cellPadding}
                    defaultCurrency={defaultCurrency}
                    formatDate={formatDate}
                    formatCurrency={formatCurrency}
                    formatQuantity={formatQuantity}
                    getRowHandlers={getRowHandlers}
                    onEdit={onEdit}
                    onDeleteClick={handleDeleteClick}
                    onCycleStatus={handleCycleStatus}
                    hasActions={!!(onDelete || onEdit)}
                    wrapped={wrapped}
                  />
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={t('transactionList.deleteTitle')}
        message={deleteConfirm.transaction
          ? t('transactionList.deleteConfirmMessage', {
              action: actionInfoFor(deleteConfirm.transaction.action).label,
              security: deleteConfirm.transaction.security ? ` for ${deleteConfirm.transaction.security.symbol}` : '',
            })
          : t('transactionList.deleteConfirmGeneric')}
        confirmLabel={t('transactionList.deleteConfirmLabel')}
        cancelLabel={t('transactionList.cancelLabel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />

      <RowActionSheet
        isOpen={!!contextTx}
        title={contextTx?.security?.symbol ?? (contextTx ? actionInfoFor(contextTx.action).label : '')}
        subtitle={contextTx ? formatDate(contextTx.transactionDate) : undefined}
        actions={contextTx
          ? buildInvestmentTxActions(
              contextTx,
              { edit: tc('actions.edit'), delete: tc('actions.delete') },
              { onEdit, onDeleteClick: handleDeleteClick },
            )
          : []}
        onClose={() => setContextTx(null)}
      />
    </div>
  );
}
