'use client';

import { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { Security } from '@/types/investment';
import { DensityLevel, useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { HIGHLIGHT_FLASH, HIGHLIGHT_FLASH_CELL, useScrollIntoViewWhen } from '@/hooks/useHighlightTarget';
import { SortIcon } from '@/components/ui/SortIcon';
import { usePreferencesStore } from '@/store/preferencesStore';
import { preferredCurrency } from '@/lib/default-currency';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { securityPositionValue } from '@/lib/security-value';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CellLabel } from '@/components/ui/Table';
import {
  SORT_FIELDS,
  buildSecurityActions,
  SecurityDescription,
  SecurityPriceSourceBadge,
  SecurityProviderBadge,
  SecurityTagChips,
  SecurityTypeText,
  SecurityValueFigure,
  type SecuritySortField,
} from './SecurityListParts';

export type { SecuritySortField };

export type SortDirection = 'asc' | 'desc';

/**
 * The favourite star, in both layouts.
 *
 * It is a control INSIDE a clickable row, so its click must not also open the
 * security -- that `stopPropagation` is the decision this shares, and it is why
 * both branches call it rather than each spelling the button out. It stays in
 * this file rather than moving to `SecurityListParts.tsx` because its
 * hand-written hover pair is a `ui-conventions` shrink-only fingerprint
 * recorded against THIS path; a copy in a new file would fail that guard
 * instead of shrinking its baseline.
 */
function FavouriteStar({
  security,
  onToggleFavourite,
}: {
  security: Security;
  onToggleFavourite?: (security: Security) => void;
}) {
  const t = useTranslations('securities');
  const handleToggleFavourite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavourite?.(security);
    },
    [onToggleFavourite, security],
  );
  return (
    <button
      type="button"
      onClick={handleToggleFavourite}
      onMouseDown={(e) => e.stopPropagation()}
      className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      title={security.isFavourite ? t('list.favouriteButton.remove') : t('list.favouriteButton.add')}
      aria-label={security.isFavourite ? t('list.favouriteButton.remove') : t('list.favouriteButton.add')}
      aria-pressed={security.isFavourite}
    >
      <svg
        className={`w-4 h-4 ${security.isFavourite ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-500'}`}
        fill={security.isFavourite ? 'currentColor' : 'none'}
        stroke="currentColor"
        viewBox="0 0 20 20"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
      </svg>
    </button>
  );
}

/**
 * The Active/Inactive pill, in both layouts.
 *
 * A dense row drops to the abbreviated labels (the full words do not fit that
 * row height); the colour is the status, never the layout. It stays in this file
 * for the same reason the star does: `rounded-full` + `text-xs` + `font-medium`
 * is the `ui-conventions` pill fingerprint, baselined against this path.
 */
function SecurityStatusPill({
  security,
  density,
}: {
  security: Security;
  density: DensityLevel;
}) {
  const t = useTranslations('securities');
  if (security.isActive) {
    return (
      <span className={`inline-flex items-center rounded-full text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2.5 py-0.5'}`}>
        {density === 'dense' ? t('list.statusBadge.activeShort') : t('list.statusBadge.active')}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2.5 py-0.5'}`}>
      {density === 'dense' ? t('list.statusBadge.inactiveShort') : t('list.statusBadge.inactive')}
    </span>
  );
}

// Map of securityId -> total quantity across all accounts
export type SecurityHoldings = Record<string, number>;

// Set of securityIds that have investment transactions
export type SecurityTransactions = Set<string>;

interface SecurityListProps {
  securities: Security[];
  holdings?: SecurityHoldings;
  transactionSecurityIds?: SecurityTransactions;
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  onToggleFavourite?: (security: Security) => void;
  onDelete?: (security: Security) => void;
  /** Opens the security's detail page; a click anywhere on the row calls it. */
  onOpen: (security: Security) => void;
  sortField?: SecuritySortField;
  sortDirection?: SortDirection;
  onSort?: (field: SecuritySortField) => void;
  /** Security id to flash/scroll to (e.g. arriving from a deep link). */
  highlightId?: string | null;
}

interface SecurityRowProps {
  security: Security;
  hasHoldings: boolean;
  hasTransactions: boolean;
  shares: number;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  onToggleFavourite?: (security: Security) => void;
  onDelete?: (security: Security) => void;
  getRowHandlers: (security: Security) => LongPressRowHandlers;
  index: number;
  defaultQuoteProvider: 'yahoo' | 'msn';
  /** The reader's own currency, so a value quoted in another one says which. */
  defaultCurrency: string;
  isHighlighted?: boolean;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and every other density
   * renders the tier row below, unchanged.
   *
   * The card carries EVERY column the tier row shows at Normal density except
   * Actions -- favourite, symbol, name (with its tags and description), value,
   * type, shares, currency, exchange, provider, source and status. Nothing is
   * omitted for width. Eleven columns still fit three lines because the width
   * pressure on a card is the UNSHRINKABLE items on line 1, not the column
   * count: there are three of them (the star, the symbol and the value), the
   * other eight are a word, a digit run, a three-letter code and three small
   * badges, and they sit on two further lines that shrink to nothing.
   *
   * Five of those eleven are ones a phone-width tier row does not show at all
   * -- Exchange, Currency and Status are `hidden sm:table-cell`, Provider and
   * Source `hidden md:table-cell` -- so the card is how they get back on
   * screen. The twelfth column, Actions, is `hidden sm:table-cell` as well and
   * is the one the card leaves out: those actions are what the long-press (and
   * right-click) sheet these same row handlers open already carries.
   *
   * The two breakpoints are not the same one. The tier row's Actions cell
   * returns at `sm` and `wrapped` covers everything below 640px, so at Normal
   * density the actions move to that sheet on exactly the widths where the tier
   * table did not show them either -- this list has no `min-[480px]` window.
   * Compact density, one tap away, is the way back to the tier table.
   *
   * One trade-off is deliberate and bounded: the symbol's slot has a ceiling,
   * so a symbol near the form's 20-character maximum is the one value on the
   * card that can be cut short (it keeps a `title`, and Compact density shows
   * it whole). It cannot wrap the way the name does -- an ISO-style ticker
   * broken across two lines stops reading as one ticker -- and without a
   * ceiling its nowrap text would set the table's minimum width, which on a
   * phone is not merely a scrollbar. Every realistic symbol is well inside it.
   */
  wrapped?: boolean;
}

const SecurityRow = memo(function SecurityRow({
  security,
  hasHoldings,
  hasTransactions,
  shares,
  density,
  cellPadding,
  onEdit,
  onToggleActive,
  onToggleFavourite,
  onDelete,
  getRowHandlers,
  index,
  defaultQuoteProvider,
  defaultCurrency,
  isHighlighted,
  wrapped = false,
}: SecurityRowProps) {
  const rowRef = useScrollIntoViewWhen<HTMLTableRowElement>(!!isHighlighted);
  const { formatShareQuantity } = useNumberFormat();
  const t = useTranslations('securities');
  const tc = useTranslations('common');

  const value = securityPositionValue(shares, security.lastPrice);

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's twelve cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- the star, the type text, the value figure, the
  // provider and source badges and the status pill below are the SAME
  // components the tier branch renders, so the two cannot come to disagree
  // about whether a position is unpriced, which provider is in force, or which
  // of a type's two labels a density gets.
  if (wrapped) {
    return (
      <tr
        ref={rowRef}
        className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none bg-white dark:bg-gray-900 ${
          !security.isActive ? 'opacity-60' : ''
        } ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
        {...getRowHandlers(security)}
      >
        <td className="p-0">
          {/* The inset is the density table's, not a hand-picked one: the slim
              header above these cards is padded from the same table, and two
              insets on one screen misalign.

              A grid, not a flex row, and `minmax(0,1fr)` rather than a plain
              `1fr`: a track that may be zero lets the name truncate, where a
              flex item's `min-w-0` still contributes the full width of its
              nowrap text to the table's minimum. On a phone that is not merely
              a scrollbar -- mobile Chrome sizes the viewport `position: fixed`
              attaches to from the widest content on the page. */}
          <div className={`${cellPadding} grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start`}>
            {/* Line 1, left: the two things that cannot shrink. The star is a
                fixed `w-4` glyph in a `p-1` button; the symbol is the row's
                identity, so it is never truncated in practice -- its slot has a
                floor (short codes line up down the card instead of stepping the
                name left and right) and a ceiling that bounds what a
                pathological 20-character symbol can take from the name. */}
            <div className="flex items-center gap-1.5">
              <FavouriteStar security={security} onToggleFavourite={onToggleFavourite} />
              <span
                className="min-w-[3.25rem] max-w-[6rem] truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                title={security.symbol}
              >
                {security.symbol}
              </span>
            </div>
            {/* The name yields the width, and everything the tier row hangs
                under it comes with it: a phone at Normal density showed the
                tags and the description before this card existed, so dropping
                them here would lose information the wrap is meant to recover.
                All three sit inside the zero-floored track, so none of them can
                widen the table.

                The name CLAMPS rather than truncates, and that is the same
                argument: the tier's name cell carries no `whitespace-nowrap`,
                so a phone at Normal density has always wrapped a long name over
                several lines and shown it whole. One line plus an ellipsis
                would have taken that away on the exact width this card
                converts, and a `title` is not the way back on a device with no
                pointer to hover. Two lines is the description's own limit, and
                a wrapping box in a `minmax(0,1fr)` track contributes no
                minimum, so the measured containment is unchanged. */}
            <div className="min-w-0">
              <div
                className="line-clamp-2 text-sm text-gray-900 dark:text-gray-100"
                title={security.name}
              >
                {security.name}
              </div>
              <SecurityTagChips security={security} />
              <SecurityDescription security={security} density={density} />
            </div>
            {/* The key figure, on the right of line 1. `whitespace-nowrap`
                because a locale that groups thousands with a space would
                otherwise break a six-figure value in half, and no `truncate`: a
                silently cut amount is worse than a crowded one. The caption is
                its own node above the value's, so a test still matches the
                figure alone. */}
            <div className="text-right whitespace-nowrap">
              <CellLabel>{t('list.columns.value')}</CellLabel>
              <SecurityValueFigure
                value={value}
                currencyCode={security.currencyCode}
                defaultCurrency={defaultCurrency}
                unknownClassName="justify-end"
              />
            </div>
            {/* Line 2 is its own grid for the same reason line 1 is: the type
                label is the one item here that can run long, so it needs a
                track with a zero minimum rather than a flex slot. Shares,
                currency and exchange are a digit run and two short codes. */}
            <div className="col-span-3 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-start gap-x-3">
              <div className="min-w-0">
                <CellLabel>{t('list.columns.type')}</CellLabel>
                <div className="truncate">
                  <SecurityTypeText security={security} density={density} />
                </div>
              </div>
              <div className="text-right">
                <CellLabel>{t('list.columns.shares')}</CellLabel>
                <div className="whitespace-nowrap">
                  <span
                    className="text-sm text-gray-900 dark:text-gray-100"
                    title={t('list.columnTitles.shares')}
                  >
                    {formatShareQuantity(shares)}
                  </span>
                </div>
              </div>
              <div>
                <CellLabel>{t('list.columns.currency')}</CellLabel>
                <div className="whitespace-nowrap">
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {security.currencyCode}
                  </span>
                </div>
              </div>
              <div>
                <CellLabel>{t('list.columns.exchange')}</CellLabel>
                <div className="whitespace-nowrap">
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {security.exchange || '-'}
                  </span>
                </div>
              </div>
            </div>
            {/* Line 3: the three badges. The status pill is self-describing and
                takes no caption; the other two are colour-coded words whose
                column the reader would otherwise have to guess. */}
            <div className="col-span-3 flex flex-wrap items-end gap-x-4 gap-y-1.5">
              <div>
                <CellLabel>{t('list.columns.provider')}</CellLabel>
                <SecurityProviderBadge
                  security={security}
                  defaultQuoteProvider={defaultQuoteProvider}
                />
              </div>
              <div>
                <CellLabel>{t('list.columns.source')}</CellLabel>
                <SecurityPriceSourceBadge security={security} />
              </div>
              <SecurityStatusPill security={security} density={density} />
            </div>
          </div>
        </td>
      </tr>
    );
  }

  // Built below the card branch, not above it: the row actions are consumed by
  // the tier `RowActions` cell alone -- the card sends them to the long-press
  // sheet the list mounts -- so building them for a wrapped row would be three
  // objects and four catalog lookups per row, per render, on the one surface
  // that never uses them.
  const actions = buildSecurityActions(
    security,
    hasHoldings,
    hasTransactions,
    {
      edit: tc('actions.edit'),
      activate: t('list.actions.activate'),
      deactivate: t('list.actions.deactivate'),
      delete: tc('actions.delete'),
    },
    { onEdit, onToggleActive, onDelete },
  );

  return (
    <tr
      ref={rowRef}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${
        !security.isActive ? 'opacity-60' : ''
      } ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
      {...getRowHandlers(security)}
    >
      <td className={`${cellPadding} whitespace-nowrap text-center`}>
        <FavouriteStar security={security} onToggleFavourite={onToggleFavourite} />
      </td>
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {security.symbol}
        </span>
      </td>
      <td className={`${cellPadding}`}>
        <span className="text-sm text-gray-900 dark:text-gray-100">
          {security.name}
        </span>
        <SecurityTagChips security={security} />
        <SecurityDescription security={security} density={density} />
      </td>
      <td className={`${cellPadding} whitespace-nowrap`}>
        <SecurityTypeText security={security} density={density} />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right`}>
        <span
          className="text-sm text-gray-900 dark:text-gray-100"
          title={t('list.columnTitles.shares')}
        >
          {formatShareQuantity(shares)}
        </span>
      </td>
      {/* What the position is worth: shares times the latest close, in the
          security's own currency (never converted, so the code is appended
          whenever that is not the reader's). A held position with no price is
          unknown rather than zero -- see `securityPositionValue`. */}
      <td className={`${cellPadding} whitespace-nowrap text-right`}>
        <SecurityValueFigure
          value={value}
          currencyCode={security.currencyCode}
          defaultCurrency={defaultCurrency}
          unknownClassName="justify-end"
        />
      </td>
      {density === 'normal' && (
        <>
          <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {security.exchange || '-'}
            </span>
          </td>
          <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {security.currencyCode}
            </span>
          </td>
          <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell`}>
            <SecurityProviderBadge
              security={security}
              defaultQuoteProvider={defaultQuoteProvider}
            />
          </td>
          <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell`}>
            <SecurityPriceSourceBadge security={security} />
          </td>
        </>
      )}
      {/* Status - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        <SecurityStatusPill security={security} density={density} />
      </td>
      {/* Actions - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden sm:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

export function SecurityList({
  securities,
  holdings = {},
  transactionSecurityIds = new Set(),
  onEdit,
  onToggleActive,
  onToggleFavourite,
  onDelete,
  onOpen,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
  highlightId,
}: SecurityListProps) {
  const t = useTranslations('securities');
  const { density } = useDensityPreference('securities');
  const [localSortField, setLocalSortField] = useState<SecuritySortField>('symbol');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  const defaultQuoteProvider =
    usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? 'yahoo';
  // Read once here rather than per row: the value column is native-currency, so
  // every row needs to know whether its code differs from the reader's.
  const defaultCurrency = preferredCurrency(
    usePreferencesStore((s) => s.preferences?.defaultCurrency),
  );

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;


  const handleSort = useCallback((field: SecuritySortField) => {
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
  const [contextSecurity, setContextSecurity] = useState<Security | null>(null);

  const { getRowHandlers } = useLongPress<Security>({
    onLongPress: setContextSecurity,
    // A plain click anywhere on the row opens the security, matching the
    // accounts list. The favourite star and the row actions stop propagation, so
    // they act on themselves rather than opening the page underneath.
    onClick: onOpen,
  });


  const { cellPadding, headerPadding } = useTableDensity(density);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each security is a wrapped card carrying the exchange,
  // currency and status this table hides below `sm` and the provider and source
  // it hides below `md`; Compact and Dense keep the tier table, unchanged, and
  // so does every non-phone width. Exactly one branch renders per row, chosen
  // here. `SecurityList` is mounted from one surface only (the Securities
  // page), so there is no narrower variant to exclude from wrapping.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  // One label per sortable column, read by BOTH headers, so the slim phone
  // header and the tier header cannot come to name the same field differently.
  const sortFieldLabels: Record<SecuritySortField, string> = {
    symbol: t('list.columns.symbol'),
    name: t('list.columns.name'),
    type: t('list.columns.type'),
    shares: t('list.columns.shares'),
    value: t('list.columns.value'),
    exchange: t('list.columns.exchange'),
    currency: t('list.columns.currency'),
    provider: t('list.columns.provider'),
    source: t('list.columns.source'),
  };

  if (securities.length === 0) {
    return (
      <div className="p-12 text-center">
        <svg
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('list.empty.title')}
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('list.empty.subtitle')}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <DensityToggleBar view="securities" />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the column
              header is dropped -- but the controls in that header row must not
              go with it: these `<th>`s are how the list is sorted, the chosen
              field is persisted by the Securities page
              (`monize-securities-sort-field`), and four of the nine sortable
              columns are invisible at phone width (Exchange and Currency below
              `sm`, Provider and Source below `md`), so a phone could be left
              sorted by a field it can neither see nor undo. A slim control
              header carries all nine as buttons -- the card shows all nine
              values -- and no column label of its own: the single card cell
              below holds every column at once, so naming this header after any
              one of them would misdescribe the column to a screen reader. The
              favourite column's `sr-only` header label goes with the rest: it
              is a name for a column, not a sort control, and there is no
              column left for it to name. Each button names itself with the
              label of the field it sorts by. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
            <tr>
              {/* The one column is always sorted by something, and `aria-sort`
                  is the only place that direction is announced -- the arrow in
                  each button's label is a glyph, not a state. Announcing it
                  unconditionally is honest here because the buttons name every
                  member of `SecuritySortField`. */}
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
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <span className="sr-only">{t('list.columns.favourite')}</span>
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('symbol')}
              >
                {sortFieldLabels.symbol}<SortIcon field="symbol" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('name')}
              >
                {sortFieldLabels.name}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('type')}
              >
                {sortFieldLabels.type}<SortIcon field="type" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('shares')}
              >
                {sortFieldLabels.shares}<SortIcon field="shares" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('value')}
                title={t('list.columnTitles.value')}
              >
                {sortFieldLabels.value}<SortIcon field="value" sortField={sortField} sortDirection={sortDirection} />
              </th>
              {density === 'normal' && (
                <>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                    onClick={() => handleSort('exchange')}
                  >
                    {sortFieldLabels.exchange}<SortIcon field="exchange" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                    onClick={() => handleSort('currency')}
                  >
                    {sortFieldLabels.currency}<SortIcon field="currency" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                    onClick={() => handleSort('provider')}
                    title={t('list.columnTitles.source')}
                  >
                    {sortFieldLabels.provider}<SortIcon field="provider" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                    onClick={() => handleSort('source')}
                    title={t('list.columnTitles.source')}
                  >
                    {sortFieldLabels.source}<SortIcon field="source" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                </>
              )}
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('list.columns.status')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.columns.actions')}
              </th>
            </tr>
            )}
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {securities.map((security, index) => (
              <SecurityRow
                key={security.id}
                security={security}
                hasHoldings={(holdings[security.id] || 0) > 0}
                hasTransactions={transactionSecurityIds.has(security.id)}
                shares={holdings[security.id] || 0}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onToggleActive={onToggleActive}
                onToggleFavourite={onToggleFavourite}
                onDelete={onDelete}
                getRowHandlers={getRowHandlers}
                index={index}
                defaultQuoteProvider={defaultQuoteProvider}
                defaultCurrency={defaultCurrency}
                isHighlighted={!!highlightId && security.id === highlightId}
                wrapped={wrapped}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Long-press action sheet */}
      <RowActionSheet
        isOpen={!!contextSecurity}
        title={contextSecurity?.symbol ?? ''}
        subtitle={contextSecurity?.name}
        actions={contextSecurity
          ? buildSecurityActions(
              contextSecurity,
              (holdings[contextSecurity.id] || 0) > 0,
              transactionSecurityIds.has(contextSecurity.id),
              {
                edit: t('list.contextMenu.editSecurity'),
                activate: t('list.contextMenu.activate'),
                deactivate: t('list.contextMenu.deactivate'),
                delete: t('list.contextMenu.delete'),
              },
              { onEdit, onToggleActive, onDelete },
            )
          : []}
        onClose={() => setContextSecurity(null)}
      />
    </div>
  );
}
