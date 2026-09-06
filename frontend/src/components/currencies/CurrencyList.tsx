'use client';

import { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { CurrencyInfo, CurrencyUsage } from '@/lib/exchange-rates';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { FX_RATE_DISPLAY_DECIMALS } from '@/lib/format';

import { DensityLevel, useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { SortIcon } from '@/components/ui/SortIcon';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CellLabel } from '@/components/ui/Table';

export type CurrencySortField = 'code' | 'name' | 'symbol' | 'decimals' | 'rate';
export type SortDirection = 'asc' | 'desc';

const logger = createLogger('CurrencyList');

/**
 * Every field this list sorts by, with its position in the tier header's own
 * order. The phone's slim control header renders all of them: the chosen field
 * is persisted (`monize-currencies-sort-field`, set on the Currencies page) and
 * two of the five columns are hidden at phone width (Name below `sm`, Decimals
 * below `lg`), so a header offering fewer would strand a phone on a sort order
 * it can neither see nor undo. Usage, Status and Actions are absent because the
 * tier header offers no sort control for them.
 *
 * It is a `Record` keyed by the union rather than a hand-written array because
 * the slim `<th>` announces a direction UNCONDITIONALLY, and that is only
 * honest while the buttons name every field the list can be sorted by. Here the
 * compiler holds that: a sixth sort field is a type error until it is given a
 * position, and the derived list cannot omit one. `as const satisfies
 * ReadonlyArray<CurrencySortField>` would have accepted a proper subset --
 * leaving "sorted ascending" announced over five unsorted glyphs.
 */
const SORT_FIELD_ORDER: Record<CurrencySortField, number> = {
  code: 0,
  name: 1,
  symbol: 2,
  decimals: 3,
  rate: 4,
};

const SORT_FIELDS: readonly CurrencySortField[] = (
  Object.keys(SORT_FIELD_ORDER) as CurrencySortField[]
).sort((a, b) => SORT_FIELD_ORDER[a] - SORT_FIELD_ORDER[b]);

/** The Usage column's figure: accounts plus securities, zero when unused. */
function currencyUsageTotal(usage: { accounts: number; securities: number } | undefined): number {
  return (usage?.accounts || 0) + (usage?.securities || 0);
}

/** The "Default" marker on the user's base currency, in both layouts. */
function DefaultCurrencyBadge({ isDefault }: { isDefault: boolean }) {
  const t = useTranslations('currencies');
  if (!isDefault) return null;
  return (
    <span className="ml-2 inline-flex text-xs leading-5 font-semibold rounded-full px-1.5 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
      {t('list.defaultBadge')}
    </span>
  );
}

/**
 * The Active/Inactive pill, in both layouts.
 *
 * Two decisions live here rather than at each call site: a dense row drops to
 * the abbreviated labels (the full words do not fit that row height), and the
 * pill's colour is the status, not the layout.
 */
function CurrencyStatusPill({
  currency,
  density,
  className = '',
}: {
  currency: CurrencyInfo;
  density: DensityLevel;
  className?: string;
}) {
  const t = useTranslations('currencies');
  return (
    <span
      className={`inline-flex text-xs leading-5 font-semibold rounded-full ${
        density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'
      } ${
        currency.isActive
          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
          : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
      }${className ? ` ${className}` : ''}`}
    >
      {density === 'dense'
        ? currency.isActive ? t('list.statusBadge.activeShort') : t('list.statusBadge.inactiveShort')
        : currency.isActive ? t('list.statusBadge.active') : t('list.statusBadge.inactive')}
    </span>
  );
}

/**
 * What the Usage column shows: the account and security counts it is used by,
 * under the tooltip that spells them out, or the "-" placeholder when nothing
 * references the currency. Both layouts render it from here so neither can
 * disagree about what "unused" looks like.
 */
function CurrencyUsageText({
  usage,
}: {
  usage: { accounts: number; securities: number } | undefined;
}) {
  const t = useTranslations('currencies');
  if (currencyUsageTotal(usage) === 0) {
    return <span className="text-gray-400 dark:text-gray-500">-</span>;
  }
  return (
    <span title={t('list.usageTooltip', { accounts: usage?.accounts || 0, securities: usage?.securities || 0 })}>
      {usage?.accounts ? t('list.usageAccounts', { count: usage.accounts }) : ''}
      {usage?.accounts && usage?.securities ? ', ' : ''}
      {usage?.securities ? t('list.usageSecurities', { count: usage.securities }) : ''}
    </span>
  );
}

/**
 * The exchange rate against the user's default currency, in both layouts.
 *
 * Three states, and which one a currency is in is a decision rather than a
 * label: the base currency has no rate to state ("-"), a resolved rate is
 * rendered at `FX_RATE_DISPLAY_DECIMALS` -- an exchange rate is not money, so
 * it is never shown at money's 4dp -- and an unresolved lookup is "N/A", never
 * 1 and never a blank that reads as zero.
 */
function CurrencyRateValue({
  currency,
  defaultCurrency,
  exchangeRate,
  isDefault,
}: {
  currency: CurrencyInfo;
  defaultCurrency: string;
  exchangeRate: number | null;
  isDefault: boolean;
}) {
  if (isDefault) {
    return <span className="text-gray-400 dark:text-gray-500">-</span>;
  }
  if (!exchangeRate) {
    return <span className="text-gray-400 dark:text-gray-500">N/A</span>;
  }
  return (
    <span title={`1 ${currency.code} = ${exchangeRate.toFixed(FX_RATE_DISPLAY_DECIMALS)} ${defaultCurrency}`}>
      {exchangeRate.toFixed(FX_RATE_DISPLAY_DECIMALS)}
    </span>
  );
}

interface CurrencyActionLabels {
  edit: string;
  activate: string;
  deactivate: string;
  delete: string;
}

interface CurrencyActionHandlers {
  onEdit: (currency: CurrencyInfo) => void;
  onToggleActive: (currency: CurrencyInfo) => void;
  onDelete: (currency: CurrencyInfo) => void;
}

/**
 * Builds the standard row actions for a currency. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`. Delete is desktop-omitted
 * (only the sheet surfaces it) via `includeDelete`.
 */
function buildCurrencyActions(
  currency: CurrencyInfo,
  totalUsage: number,
  isDefault: boolean,
  labels: CurrencyActionLabels,
  handlers: CurrencyActionHandlers,
  opts: { includeDelete: boolean },
): RowAction[] {
  const canToggleOrDelete = !isDefault && totalUsage === 0;
  return [
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(currency),
      hidden: currency.isSystem,
    },
    currency.isActive
      ? {
          key: 'toggle',
          label: labels.deactivate,
          icon: 'deactivate',
          tone: 'warning',
          onClick: () => handlers.onToggleActive(currency),
          hidden: !canToggleOrDelete,
        }
      : {
          key: 'toggle',
          label: labels.activate,
          icon: 'activate',
          tone: 'success',
          onClick: () => handlers.onToggleActive(currency),
          hidden: !canToggleOrDelete,
        },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDelete(currency),
      hidden: !opts.includeDelete || currency.isSystem || !canToggleOrDelete,
    },
  ];
}

interface CurrencyListProps {
  currencies: CurrencyInfo[];
  usage: CurrencyUsage;
  defaultCurrency: string;
  getRate: (fromCurrency: string, toCurrency?: string) => number | null;
  onEdit: (currency: CurrencyInfo) => void;
  onToggleActive: (currency: CurrencyInfo) => void;
  onRefresh: () => void;
  sortField?: CurrencySortField;
  sortDirection?: SortDirection;
  onSort?: (field: CurrencySortField) => void;
}

interface CurrencyRowProps {
  currency: CurrencyInfo;
  usage: { accounts: number; securities: number } | undefined;
  defaultCurrency: string;
  exchangeRate: number | null;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (currency: CurrencyInfo) => void;
  onToggleActive: (currency: CurrencyInfo) => void;
  onDelete: (currency: CurrencyInfo) => void;
  getRowHandlers: (currency: CurrencyInfo) => LongPressRowHandlers;
  index: number;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and every other
   * density renders the tier row below, unchanged.
   *
   * The card carries every value the tier row shows at Normal density -- code,
   * name, symbol, decimals, usage, rate, the "Default" marker and the
   * Active/Inactive pill. NO column is omitted for width: the phone tier row
   * shows only code, symbol and rate (Name, Usage and Status are
   * `hidden sm:table-cell`, Decimals `hidden lg:table-cell`), so the card is
   * how the other five get back on screen, and eight columns still fit two
   * lines because six of them are three characters, a symbol, a digit and a
   * count. Only the Actions column is left out: those actions are what the
   * long-press (and right-click) sheet these same row handlers open already
   * carries.
   *
   * The two breakpoints are not the same one. The tier row's Actions cell is
   * `sm:table-cell` and `wrapped` covers everything below 640px, so at Normal
   * density the actions move to that sheet on exactly the widths where the
   * tier table did not show them either -- this list has no `min-[480px]`
   * window. Compact density, one tap away, is the way back to the tier table.
   */
  wrapped?: boolean;
}

const CurrencyRow = memo(function CurrencyRow({
  currency,
  usage,
  defaultCurrency,
  exchangeRate,
  density,
  cellPadding,
  onEdit,
  onToggleActive,
  onDelete,
  getRowHandlers,
  index,
  wrapped = false,
}: CurrencyRowProps) {
  const t = useTranslations('currencies');
  const tc = useTranslations('common');

  const totalUsage = currencyUsageTotal(usage);
  const isDefault = currency.code === defaultCurrency;

  const actions = buildCurrencyActions(
    currency,
    totalUsage,
    isDefault,
    { edit: tc('actions.edit'), activate: t('list.actions.activate'), deactivate: t('list.actions.deactivate'), delete: tc('actions.delete') },
    { onEdit, onToggleActive, onDelete },
    { includeDelete: false },
  );

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- the "Default" marker, the status pill, the usage
  // text and the rate are the same components the tier branch renders, so the
  // two cannot disagree about a currency's status, its usage or its rate.
  if (wrapped) {
    return (
      <tr
        className="hover:bg-gray-100 dark:hover:bg-gray-800 select-none bg-white dark:bg-gray-900"
        {...getRowHandlers(currency)}
      >
        <td className="p-0">
          {/* The inset is the density table's, not a hand-picked one: two
              insets on one screen misalign, and the header above these cards is
              padded from the same table. */}
          <div className={cellPadding}>
            {/* A grid, not a flex row, and `minmax(0,1fr)` rather than a plain
                `1fr`: a track that may be zero lets the name truncate, where a
                flex item's `min-w-0` still contributes the full width of its
                nowrap text to the table's minimum. On a phone that is not
                merely a scrollbar -- mobile Chrome sizes the viewport
                `position: fixed` attaches to from the widest content on the
                page. */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start">
              {/* A fixed slot rather than an `auto` track: an ISO code is
                  exactly three characters (the form validates `length(3)`), so
                  this is the card's natural anchor and a fixed width keeps the
                  name column starting at the same x on every row. It needs no
                  caption -- it is the row's identity, and the header's first
                  sort button already names it. */}
              <span className="w-12 shrink-0 text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
                {currency.code}
              </span>
              {/* `flex-wrap` is what keeps the NAME the identity of the card.
                  The name is the only shrinkable item here (`truncate` floors
                  its min-width at zero) while the "Default" marker and the
                  status pill cannot shrink below their one word, so on a narrow
                  phone they would otherwise take their full width out of the
                  name's. Wrapping lets them drop to their own line instead, and
                  a short name -- the common case -- still keeps them inline.
                  Both are self-describing pills, so neither takes a caption. */}
              <div className="min-w-0 flex flex-wrap items-center gap-y-1">
                <span className="truncate text-sm text-gray-700 dark:text-gray-300">
                  {currency.name}
                </span>
                <DefaultCurrencyBadge isDefault={isDefault} />
                <CurrencyStatusPill currency={currency} density={density} className="ml-2" />
              </div>
              {/* The key figure, on the right of line 1. `whitespace-nowrap`
                  because a locale that groups with a space would otherwise wrap
                  in the middle of the number, and no `truncate`: a silently cut
                  rate is worse than a crowded one. The caption is its own node
                  above the value's, so a test still matches the rate alone. */}
              <div className="text-right whitespace-nowrap">
                <CellLabel>{t('list.columns.rate', { currency: defaultCurrency })}</CellLabel>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  <CurrencyRateValue
                    currency={currency}
                    defaultCurrency={defaultCurrency}
                    exchangeRate={exchangeRate}
                    isDefault={isDefault}
                  />
                </div>
              </div>
              {/* Line 2 is its own grid for the same reason line 1 is: the
                  usage text truncates, so it needs a track with a zero minimum
                  rather than a flex slot. Symbol and Decimals are one glyph and
                  one digit, so all three captioned values share the line. */}
              <div className="col-span-3 grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-4">
                <div>
                  <CellLabel>{t('list.columns.symbol')}</CellLabel>
                  <div className="text-sm text-gray-600 dark:text-gray-400">{currency.symbol}</div>
                </div>
                <div>
                  <CellLabel>{t('list.columns.decimals')}</CellLabel>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {currency.decimalPlaces}
                  </div>
                </div>
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.usage')}</CellLabel>
                  <div className="text-sm text-gray-600 dark:text-gray-400 truncate">
                    <CurrencyUsageText usage={usage} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={`hover:bg-gray-100 dark:hover:bg-gray-800 select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(currency)}
    >
      {/* Code */}
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
          {currency.code}
        </span>
        <DefaultCurrencyBadge isDefault={isDefault} />
      </td>
      {/* Name - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-700 dark:text-gray-300 hidden sm:table-cell`}>
        {currency.name}
      </td>
      {/* Symbol */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-600 dark:text-gray-400 text-center`}>
        {currency.symbol}
      </td>
      {/* Decimals - hidden in compact/dense */}
      {density === 'normal' && (
        <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 text-center hidden lg:table-cell`}>
          {currency.decimalPlaces}
        </td>
      )}
      {/* Usage */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-600 dark:text-gray-400 hidden sm:table-cell`}>
        <CurrencyUsageText usage={usage} />
      </td>
      {/* Exchange Rate */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-600 dark:text-gray-400 text-right`}>
        <CurrencyRateValue
          currency={currency}
          defaultCurrency={defaultCurrency}
          exchangeRate={exchangeRate}
          isDefault={isDefault}
        />
      </td>
      {/* Status */}
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        <CurrencyStatusPill currency={currency} density={density} />
      </td>
      {/* Actions - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden sm:table-cell`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

export function CurrencyList({
  currencies,
  usage,
  defaultCurrency,
  getRate,
  onEdit,
  onToggleActive,
  onRefresh,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
}: CurrencyListProps) {
  const t = useTranslations('currencies');
  const [deleteCurrency, setDeleteCurrency] = useState<CurrencyInfo | null>(null);
  const { density } = useDensityPreference('currencies');
  const [localSortField, setLocalSortField] = useState<CurrencySortField>('code');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;


  const handleSort = useCallback((field: CurrencySortField) => {
    if (onSort) {
      onSort(field);
    } else {
      if (localSortField === field) {
        setLocalSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection('asc');
      }
    }
  }, [onSort, localSortField]);

  // Long-press opens a per-row action sheet on mobile (and via right-click).
  const [contextCurrency, setContextCurrency] = useState<CurrencyInfo | null>(null);

  const { getRowHandlers } = useLongPress<CurrencyInfo>({
    onLongPress: setContextCurrency,
  });

  const { cellPadding, headerPadding } = useTableDensity(density);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each currency is a wrapped card carrying the name, usage
  // and status this table hides below `sm` and the decimals it hides below
  // `lg`; Compact and Dense keep the tier table, unchanged, and so does every
  // non-phone width. Exactly one branch renders per row, chosen here.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  // One label per sortable column, read by BOTH headers, so the slim phone
  // header and the tier header cannot come to name the same field differently.
  const sortFieldLabels: Record<CurrencySortField, string> = {
    code: t('list.columns.code'),
    name: t('list.columns.name'),
    symbol: t('list.columns.symbol'),
    decimals: t('list.columns.decimals'),
    rate: t('list.columns.rate', { currency: defaultCurrency }),
  };

  const handleConfirmDelete = async () => {
    if (!deleteCurrency) return;
    try {
      await exchangeRatesApi.deleteCurrency(deleteCurrency.code);
      toast.success(t('list.toasts.deleted'));
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeleteCurrency(null);
    }
  };

  if (currencies.length === 0) {
    return (
      <EmptyState
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        }
        title={t('list.empty.title')}
        description={t('list.empty.subtitle')}
      />
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <DensityToggleBar view="currencies" />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the column
              header is dropped -- but the controls in that header row must not
              go with it: these `<th>`s are how the list is sorted, the chosen
              field is persisted by the Currencies page, and two of the five
              sortable columns are hidden at phone width (Name below `sm`,
              Decimals below `lg`), so a phone could be left sorted by a field
              it can neither see nor undo. A slim control header
              carries all five as buttons -- the card shows all five values --
              and no column label of its own: the single card cell below holds
              code, name, symbol, decimals, usage, rate and status at once, so
              naming this header after any one of them would misdescribe the
              column to a screen reader. Each button names itself with the
              label of the field it sorts by. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
            <tr>
              {/* The one column is always sorted by something, and `aria-sort`
                  is the only place that direction is announced -- the arrow in
                  each button's label is a glyph, not a state. Announcing it
                  unconditionally is honest here because the buttons name every
                  member of `CurrencySortField`. */}
              <th
                className={`${headerPadding} text-left`}
                aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {SORT_FIELDS.map((field) => (
                    <button
                      key={field}
                      type="button"
                      onClick={() => handleSort(field)}
                      className="flex items-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
                    >
                      {sortFieldLabels[field]}
                      <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
                    </button>
                  ))}
                </div>
              </th>
            </tr>
            ) : (
            <tr>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('code')}
              >
                {sortFieldLabels.code}<SortIcon field="code" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                onClick={() => handleSort('name')}
              >
                {sortFieldLabels.name}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('symbol')}
              >
                {sortFieldLabels.symbol}<SortIcon field="symbol" sortField={sortField} sortDirection={sortDirection} />
              </th>
              {density === 'normal' && (
                <th
                  className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                  onClick={() => handleSort('decimals')}
                >
                  {sortFieldLabels.decimals}<SortIcon field="decimals" sortField={sortField} sortDirection={sortDirection} />
                </th>
              )}
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('list.columns.usage')}
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('rate')}
              >
                {sortFieldLabels.rate}<SortIcon field="rate" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('list.columns.status')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('list.columns.actions')}
              </th>
            </tr>
            )}
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {currencies.map((currency, index) => (
              <CurrencyRow
                key={currency.code}
                currency={currency}
                usage={usage[currency.code]}
                defaultCurrency={defaultCurrency}
                exchangeRate={getRate(currency.code)}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onToggleActive={onToggleActive}
                onDelete={setDeleteCurrency}
                getRowHandlers={getRowHandlers}
                index={index}
                wrapped={wrapped}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Long-press Context Menu */}
      <RowActionSheet
        isOpen={!!contextCurrency}
        title={contextCurrency?.code ?? ''}
        subtitle={contextCurrency?.name}
        actions={contextCurrency
          ? buildCurrencyActions(
              contextCurrency,
              (usage[contextCurrency.code]?.accounts || 0) + (usage[contextCurrency.code]?.securities || 0),
              contextCurrency.code === defaultCurrency,
              { edit: t('list.contextMenu.editCurrency'), activate: t('list.contextMenu.activate'), deactivate: t('list.contextMenu.deactivate'), delete: t('list.contextMenu.deleteCurrency') },
              { onEdit, onToggleActive, onDelete: setDeleteCurrency },
              { includeDelete: true },
            )
          : []}
        onClose={() => setContextCurrency(null)}
      />

      <ConfirmDialog
        isOpen={deleteCurrency !== null}
        title={t('list.deleteConfirm.title', { code: deleteCurrency?.code ?? '' })}
        message={t('list.deleteConfirm.message')}
        confirmLabel={t('list.deleteConfirm.confirmLabel')}
        cancelLabel={t('list.deleteConfirm.cancelLabel')}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteCurrency(null)}
      />
    </div>
  );
}
