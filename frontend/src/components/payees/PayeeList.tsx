'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Payee } from '@/types/payee';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { HIGHLIGHT_FLASH, HIGHLIGHT_FLASH_CELL, useScrollIntoViewWhen } from '@/hooks/useHighlightTarget';
import { SortIcon } from '@/components/ui/SortIcon';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CellLabel } from '@/components/ui/Table';
import {
  PayeeNameButton,
  PayeeUncategorizedBadge,
  PayeeStatusBadge,
  PayeeDefaultCategory,
  payeeDayText,
  payeeNotesText,
} from '@/components/payees/PayeeListParts';

const logger = createLogger('PayeeList');

type PayeeActionLabels = {
  edit: string;
  delete: string;
  merge: string;
  reactivate: string;
};

/**
 * Builds the standard row actions for a payee. Shared by the desktop `RowActions`
 * cell and the mobile `RowActionSheet` so both surfaces stay in sync.
 */
function buildPayeeActions(
  payee: Payee,
  labels: PayeeActionLabels,
  handlers: {
    onEdit: (payee: Payee) => void;
    onDelete: (payee: Payee) => void;
    onMerge?: (payee: Payee) => void;
    onReactivate?: (payeeId: string) => void;
  },
): RowAction[] {
  return [
    {
      key: 'reactivate',
      label: labels.reactivate,
      icon: 'reactivate',
      tone: 'success',
      onClick: () => handlers.onReactivate?.(payee.id),
      hidden: payee.isActive || !handlers.onReactivate,
    },
    {
      key: 'merge',
      label: labels.merge,
      icon: 'merge',
      tone: 'accent',
      onClick: () => handlers.onMerge?.(payee),
      hidden: !handlers.onMerge || !payee.isActive,
    },
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(payee),
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDelete(payee),
    },
  ];
}

// Re-export DensityLevel from shared hook
export type { DensityLevel };

export type SortField = 'name' | 'category' | 'count' | 'createdAt' | 'aliases' | 'lastUsed';
export type SortDirection = 'asc' | 'desc';

/**
 * Every field this list sorts by, with its position in the tier header's own
 * order. The phone's slim control header renders all six: the chosen field is
 * persisted (`monize-payees-sort-field`, set on the Payees page) and FIVE of
 * the six columns they name are hidden at phone width (Default Category below
 * `sm`, Count below `md`, Aliases, Last Used and Created below `lg`; only Name
 * survives), so a header offering fewer would strand a phone on a sort order it
 * can neither see nor undo. Status, Notes and Actions are absent because the
 * tier header offers no sort control for them -- they are columns, not fields.
 *
 * `createdAt` is the one field whose VALUE the card does not print (see the
 * `wrapped` prop doc for why Created is the omitted column). That is not
 * stranding: the button still re-sorts, every other button is an escape from
 * it, and the tier table -- one density tap away -- shows the dates.
 *
 * It is a `Record` keyed by the union rather than a hand-written array because
 * the slim `<th>` announces a direction UNCONDITIONALLY, and that is only
 * honest while the buttons name every field the list can be sorted by. Here the
 * compiler holds that: a seventh sort field is a type error until it is given a
 * position, and the derived list cannot omit one. `as const satisfies
 * ReadonlyArray<SortField>` would have accepted a proper subset -- leaving
 * "sorted ascending" announced over six unsorted glyphs.
 */
const SORT_FIELD_ORDER: Record<SortField, number> = {
  name: 0,
  category: 1,
  count: 2,
  aliases: 3,
  lastUsed: 4,
  createdAt: 5,
};

const SORT_FIELDS: readonly SortField[] = (
  Object.keys(SORT_FIELD_ORDER) as SortField[]
).sort((a, b) => SORT_FIELD_ORDER[a] - SORT_FIELD_ORDER[b]);

interface PayeeListProps {
  payees: Payee[];
  onEdit: (payee: Payee) => void;
  onRefresh: () => void;
  onDelete?: (payeeId: string) => void;
  onReactivate?: (payeeId: string) => void;
  onMerge?: (payee: Payee) => void;
  showStatusColumn?: boolean;
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
  categoryColorMap?: Map<string, string | null>;
  /** Inherited-aware icon per category id; see buildCategoryIconMap. */
  categoryIconMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  /** Payee id to flash/scroll to (e.g. arriving from a deep link). */
  highlightId?: string | null;
}

interface PayeeRowProps {
  payee: Payee;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (payee: Payee) => void;
  onDelete: (payee: Payee) => void;
  onReactivate?: (payeeId: string) => void;
  onMerge?: (payee: Payee) => void;
  onViewTransactions: (payee: Payee) => void;
  showStatusColumn: boolean;
  index: number;
  categoryColorMap?: Map<string, string | null>;
  /** Inherited-aware icon per category id; see buildCategoryIconMap. */
  categoryIconMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  formatDate: (date: string) => string;
  getRowHandlers: (payee: Payee) => LongPressRowHandlers;
  isHighlighted?: boolean;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and every other density
   * renders the tier row below, unchanged.
   *
   * The card carries SEVEN of this table's nine columns: the payee's Name
   * (drawn with its logo and its "N uncategorized" marker, both of which live
   * inside the Name cell rather than being columns of their own), the
   * transaction Count (captioned), the Default Category pill (captioned, since
   * its no-category branch is the bare word "None" rather than a
   * self-describing pill), the Active/Inactive pill (only where the tier table
   * would show that column, i.e. `showStatusColumn`), Last Used, Aliases and
   * Notes. FIVE of those seven are ones a phone-width tier row does not show at
   * all -- Default Category and Status are `hidden sm:table-cell`, Count
   * `hidden md:table-cell`, Aliases and Last Used `hidden lg:table-cell` -- so
   * the card is how they get back on screen. Name and Notes are the two a phone
   * already shows.
   *
   * TWO columns are left out, for different reasons:
   * - **Actions**, because the long-press (and right-click) sheet these same
   *   row handlers open already carries them.
   * - **Created**, because nine columns do not fit three lines. It is the
   *   lowest-value of the nine (a system timestamp, against a user's own
   *   notes), and it is the only omitted value no phone width shows today
   *   anyway -- it is `hidden lg:table-cell`, where Notes is visible on a phone
   *   at Normal density right now and so could not be dropped. Its sort button
   *   survives in the slim header (see `SORT_FIELD_ORDER`), and the tier table
   *   one density tap away shows the dates.
   *
   * The three lines are: Name (with logo and marker), Count and Aliases;
   * Default Category and Status; Last Used and Notes. The two counts share
   * line 1 at the maintainer's request (the phone review of this branch), so
   * the card's figures sit together and line 2 holds the two pills alone.
   * Aliases is not beside Last Used because line 3's second track is where
   * Notes has to live, and a line carrying three captions cannot also carry a
   * readable Notes at 320px in a locale whose Last Used caption is "Последнее
   * использование" -- the line-3 comment has the measurement.
   *
   * The two breakpoints are not the same one. The tier row's Actions cell is
   * `min-[480px]`, and `wrapped` covers everything below 640px, so between
   * 480px and 639px at Normal density the actions move from inline buttons to
   * that sheet -- which also means they stop being tab-reachable there. It is
   * the price of the card, paid for the five columns above, and the register,
   * the accounts list and the categories list make the same trade at the same
   * two widths, so they all behave alike. Compact density, one tap away, is the
   * way back to inline actions.
   */
  wrapped?: boolean;
}

const PayeeRow = memo(function PayeeRow({
  payee,
  density,
  cellPadding,
  onEdit,
  onDelete,
  onReactivate,
  onMerge,
  onViewTransactions,
  showStatusColumn,
  index,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
  formatDate,
  getRowHandlers,
  isHighlighted,
  wrapped = false,
}: PayeeRowProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const rowRef = useScrollIntoViewWhen<HTMLTableRowElement>(!!isHighlighted);
  const actions = useMemo(
    () => buildPayeeActions(
      payee,
      { edit: tc('actions.edit'), delete: tc('actions.delete'), merge: tc('actions.merge'), reactivate: tc('actions.reactivate') },
      { onEdit, onDelete, onMerge, onReactivate },
    ),
    [payee, tc, onEdit, onDelete, onMerge, onReactivate],
  );

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- the name button, the "uncategorized" marker, the
  // default-category pill, the status pill and the two "-" placeholders are the
  // same components and helpers the tier branch renders, so the two cannot
  // disagree about a payee's category, its status or what "never used" means.
  if (wrapped) {
    return (
      <tr
        ref={rowRef}
        className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none bg-white dark:bg-gray-900 ${!payee.isActive ? 'opacity-60' : ''} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
        {...getRowHandlers(payee)}
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
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1.5 items-start">
              {/* The card has the room the tier row does not, so the logo is
                  drawn here at every width -- the tier cell's `max-sm:hidden`
                  is what this replaces. `BrandLogo` sizes itself from `size`,
                  so this track is a fixed 20px on every row and the names line
                  up down the card rather than stepping left and right. */}
              <PayeeLogo payee={payee} size={20} className="mt-0.5" />
              {/* `flex-wrap` is what keeps the NAME the identity of the card.
                  The name is the only shrinkable item here (`truncate` floors
                  its min-width at zero) while the "N uncategorized" marker
                  cannot shrink below its own words, so on a narrow phone it
                  would otherwise take its full width out of the name's.
                  Wrapping lets the marker drop to its own line instead, and a
                  short name -- the common case -- still keeps it inline. The
                  marker is self-describing, so it takes no caption. */}
              <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
                <PayeeNameButton
                  payee={payee}
                  onViewTransactions={onViewTransactions}
                  className="truncate max-w-full"
                />
                <PayeeUncategorizedBadge payee={payee} />
              </div>
              {/* The two figures, on the right of line 1: the Count and, beside
                  it, the Aliases -- on one line as the maintainer asked, so
                  the card's numbers sit together and line 2 is left to the two
                  pills. Each is a bare number with no column header to name
                  it, so it carries the header's own label; the caption is its
                  own node above the value's, so a test still matches the count
                  alone.

                  `whitespace-nowrap` goes on the VALUE, never on the wrapper:
                  this is an `auto` track, and an auto track's minimum is its
                  item's min-content -- so a nowrap wrapper would size the track
                  from whichever is wider, the number or the CAPTION. A caption
                  is a width input (`list.columns.count` is "Anzahl" in `de` and
                  "Количество" in `ru`), and letting it wrap keeps the track
                  sized by the figure it labels. The figure itself must not
                  wrap: a locale grouping thousands with a thin space would
                  otherwise break it in two. */}
              <div className="text-right">
                <CellLabel>{t('list.columns.count')}</CellLabel>
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                  {payee.transactionCount ?? 0}
                </div>
              </div>
              <div className="text-right">
                <CellLabel>{t('list.columns.aliases')}</CellLabel>
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                  {payee.aliasCount ?? 0}
                </div>
              </div>
              {/* Line 2, and its own grid for the same reason line 1 is: the
                  category pill truncates, so it needs a track with a zero
                  minimum rather than a flex slot.

                  The category slot IS captioned even though a pill is normally
                  self-describing, because its other branch is not a pill: a
                  payee with no default category renders the bare word "None",
                  and uncaptioned that is a line saying "None" with nothing to
                  say what of -- the column header used to do that job. The
                  caption goes on the slot rather than on the placeholder branch
                  alone, so the line does not change shape from row to row. The
                  status pill needs none: "Active" and "Inactive" name
                  themselves. It follows the tier table's own
                  `showStatusColumn`, so the card shows exactly the column the
                  table would, and `items-end` sits it on the pill's own line
                  rather than centred against the caption above it.

                  The pill takes `max-w-full` rather than `CategoryPill`'s own
                  160px cap: here its width is decided by a grid track, and a
                  160px pill in a track squeezed narrower by a long caption does
                  not shrink -- it overflows into the status pill beside it
                  (measured in `ru`, where the caption is "Категория по
                  умолчанию"). */}
              <div className="col-span-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3">
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.defaultCategory')}</CellLabel>
                  <PayeeDefaultCategory
                    payee={payee}
                    density={density}
                    categoryColorMap={categoryColorMap}
                    categoryIconMap={categoryIconMap}
                    categoryLabelMap={categoryLabelMap}
                    maxWidthClass="max-w-full"
                  />
                </div>
                {showStatusColumn && <PayeeStatusBadge payee={payee} />}
              </div>
              {/* Line 3: two EQUAL zero-minimum tracks (`grid-cols-2` is
                  `repeat(2, minmax(0,1fr))`), never `auto` beside a `1fr`.

                  An `auto` track takes its item's MAX-content when there is any
                  room, so a captioned value in one starves the `1fr` beside it
                  -- and a caption is a locale-sized width input, not a fixed
                  one: `list.columns.lastUsed` is "Последнее использование" in
                  `ru` and "Останнє використання" in `uk`, about 167px against
                  an English date's 88px. Measured in the replica at 320px, the
                  earlier `[auto auto minmax(0,1fr)]` line left Notes 19px in
                  `ru` while measuring a comfortable 127px in English: the very
                  "truncated column pretending to be a column" that got Created
                  dropped, arriving in eleven locales through a card that looked
                  fine in the language it was built in. Equal fr tracks give
                  Notes 140px at 320px in every locale; a long caption buys its
                  second line of height instead of the column beside it.

                  `whitespace-nowrap` sits on the VALUES, never on a wrapper,
                  for the other half of the same reason: a locale grouping
                  thousands with a thin space must not break a figure in two,
                  but a caption forced onto one line is what makes a track wide.
                  Notes truncates; it is the only thing on this line that may. */}
              <div className="col-span-4 grid grid-cols-2 items-start gap-x-4">
                <div>
                  <CellLabel>{t('list.columns.lastUsed')}</CellLabel>
                  <div className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {payeeDayText(payee.lastUsedDate, formatDate)}
                  </div>
                </div>
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.notes')}</CellLabel>
                  <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
                    {payeeNotesText(payee)}
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
      ref={rowRef}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${!payee.isActive ? 'opacity-60' : ''} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
      {...getRowHandlers(payee)}
    >
      <td className={`${cellPadding} whitespace-nowrap`}>
        <div className="flex flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:gap-2">
          {density !== 'dense' && (
            <PayeeLogo payee={payee} size={20} className="max-sm:hidden" />
          )}
          <PayeeNameButton payee={payee} onViewTransactions={onViewTransactions} />
          <PayeeUncategorizedBadge payee={payee} />
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        <PayeeDefaultCategory
          payee={payee}
          density={density}
          categoryColorMap={categoryColorMap}
          categoryIconMap={categoryIconMap}
          categoryLabelMap={categoryLabelMap}
        />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell`}>
        {payee.transactionCount ?? 0}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-center text-sm text-gray-600 dark:text-gray-400 hidden lg:table-cell`}>
        {payee.aliasCount ?? 0}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell`}>
        {payeeDayText(payee.lastUsedDate, formatDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell`}>
        {payeeDayText(payee.createdAt, formatDate)}
      </td>
      {showStatusColumn && (
        <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
          <PayeeStatusBadge payee={payee} />
        </td>
      )}
      {density === 'normal' && (
        <td className={`${cellPadding}`}>
          <div className="text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
            {payeeNotesText(payee)}
          </div>
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

export function PayeeList({
  payees,
  onEdit,
  onRefresh,
  onDelete,
  onReactivate,
  onMerge,
  showStatusColumn = false,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
  highlightId,
}: PayeeListProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const [deletePayee, setDeletePayee] = useState<Payee | null>(null);
  const [actionSheet, setActionSheet] = useState<{ open: boolean; payee: Payee | null }>({ open: false, payee: null });
  const { density } = useDensityPreference('payees');
  const [localSortField, setLocalSortField] = useState<SortField>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;


  const { cellPadding, headerPadding } = useTableDensity(density);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each payee is a wrapped card carrying the Default
  // Category, Count, Aliases, Last Used and Status this table hides below
  // `sm`/`md`/`lg`; Compact and Dense keep the tier table, unchanged, and so
  // does every non-phone width. Exactly one branch renders per row, chosen
  // here. This list has one mounting surface (`app/payees/page.tsx`), so there
  // is no caller whose columns the card cannot carry to exclude.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  // One label per sortable column, read by BOTH headers, so the slim phone
  // header and the tier header cannot come to name the same field differently.
  const sortFieldLabels: Record<SortField, string> = {
    name: t('list.columns.name'),
    category: t('list.columns.defaultCategory'),
    count: t('list.columns.count'),
    aliases: t('list.columns.aliases'),
    lastUsed: t('list.columns.lastUsed'),
    createdAt: t('list.columns.created'),
  };

  const handleSort = useCallback((field: SortField) => {
    if (onSort) {
      onSort(field);
    } else {
      if (localSortField === field) {
        setLocalSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection(field === 'count' || field === 'aliases' || field === 'lastUsed' || field === 'createdAt' ? 'desc' : 'asc');
      }
    }
  }, [onSort, localSortField]);

  const displayPayees = useMemo(() => {
    if (onSort) {
      return payees;
    }
    return [...payees].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortField === 'category') {
        const catA = a.defaultCategory ? (categoryLabelMap?.get(a.defaultCategory.id) ?? a.defaultCategory.name) : '';
        const catB = b.defaultCategory ? (categoryLabelMap?.get(b.defaultCategory.id) ?? b.defaultCategory.name) : '';
        comparison = catA.localeCompare(catB, undefined, { sensitivity: 'base' });
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
      } else if (sortField === 'aliases') {
        comparison = (a.aliasCount ?? 0) - (b.aliasCount ?? 0);
      } else if (sortField === 'lastUsed') {
        comparison = (a.lastUsedDate || '').localeCompare(b.lastUsedDate || '');
      } else if (sortField === 'createdAt') {
        comparison = (a.createdAt || '').localeCompare(b.createdAt || '');
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [payees, sortField, sortDirection, onSort, categoryLabelMap]);

  const handleViewTransactions = useCallback((payee: Payee) => {
    router.push(`/transactions?payeeId=${payee.id}`);
  }, [router]);

  // A row click opens the payee's detail page; editing stays one step away in
  // the row actions and on the detail page itself -- the same primary-click
  // decision the accounts and securities lists made.
  const handleViewDetails = useCallback((payee: Payee) => {
    router.push(`/payees/${payee.id}`);
  }, [router]);

  const { getRowHandlers } = useLongPress<Payee>({
    onLongPress: (payee) => setActionSheet({ open: true, payee }),
    onClick: handleViewDetails,
  });

  const handleConfirmDelete = async () => {
    if (!deletePayee) return;

    try {
      await payeesApi.delete(deletePayee.id);
      toast.success(t('list.toasts.deleted'));
      if (onDelete) {
        onDelete(deletePayee.id);
      } else {
        onRefresh();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeletePayee(null);
    }
  };

  if (payees.length === 0) {
    return (
      <EmptyState
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
        }
        title={t('list.empty.title')}
        description={t('list.empty.subtitle')}
      />
    );
  }

  return (
    <div>
      <DensityToggleBar view="payees" />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the column
              header is dropped -- but the controls in that header row must not
              go with it: these `<th>`s are how the list is sorted, the chosen
              field is persisted by the Payees page, and FIVE of the six
              sortable columns are hidden at phone width (Default Category
              below `sm`, Count below `md`, Aliases, Last Used and Created below
              `lg`), so a phone could be left sorted by a field it can neither
              see nor undo. A slim control header carries all six as buttons and
              no column label of its own: the single card cell below holds name,
              category, count, aliases, last used, status and notes at once, so
              naming this header after any one of them would misdescribe the
              column to a screen reader. Each button names itself with the label
              of the field it sorts by. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
            <tr>
              {/* The one column is always sorted by something, and `aria-sort`
                  is the only place that direction is announced -- the arrow in
                  each button's label is a glyph, not a state. Announcing it
                  unconditionally is honest here because the buttons name every
                  member of `SortField`. */}
              <th
                className={`${headerPadding} text-left`}
                aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
              >
                {/* These chips are TAPPED, so they carry a real hit target
                    (`min-h-[30px]` with `px-2 py-1`) rather than the ~16px
                    text-only chips the first converted lists shipped, and
                    `gap-y-1.5` keeps two wrapped rows of them from colliding. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {SORT_FIELDS.map((field) => (
                    <button
                      key={field}
                      type="button"
                      onClick={() => handleSort(field)}
                      className="flex min-h-[30px] items-center px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
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
                onClick={() => handleSort('name')}
              >
                {sortFieldLabels.name}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                onClick={() => handleSort('category')}
              >
                {sortFieldLabels.category}<SortIcon field="category" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                onClick={() => handleSort('count')}
              >
                {sortFieldLabels.count}<SortIcon field="count" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                onClick={() => handleSort('aliases')}
              >
                {sortFieldLabels.aliases}<SortIcon field="aliases" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                onClick={() => handleSort('lastUsed')}
              >
                {sortFieldLabels.lastUsed}<SortIcon field="lastUsed" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                onClick={() => handleSort('createdAt')}
              >
                {sortFieldLabels.createdAt}<SortIcon field="createdAt" sortField={sortField} sortDirection={sortDirection} />
              </th>
              {showStatusColumn && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                  {t('list.columns.status')}
                </th>
              )}
              {density === 'normal' && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  {t('list.columns.notes')}
                </th>
              )}
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.columns.actions')}
              </th>
            </tr>
            )}
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {displayPayees.map((payee, index) => (
              <PayeeRow
                key={payee.id}
                payee={payee}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onDelete={setDeletePayee}
                onReactivate={onReactivate}
                onMerge={onMerge}
                onViewTransactions={handleViewTransactions}
                showStatusColumn={showStatusColumn}
                index={index}
                categoryColorMap={categoryColorMap}
                categoryIconMap={categoryIconMap}
                categoryLabelMap={categoryLabelMap}
                formatDate={formatDate}
                getRowHandlers={getRowHandlers}
                isHighlighted={!!highlightId && payee.id === highlightId}
                wrapped={wrapped}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        isOpen={deletePayee !== null}
        title={t('list.deleteConfirm.title', { name: deletePayee?.name ?? '' })}
        message={t('list.deleteConfirm.message')}
        confirmLabel={t('list.deleteConfirm.confirmLabel')}
        cancelLabel={t('list.deleteConfirm.cancelLabel')}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletePayee(null)}
      />

      <RowActionSheet
        isOpen={actionSheet.open}
        title={actionSheet.payee?.name ?? ''}
        actions={actionSheet.payee
          ? buildPayeeActions(
              actionSheet.payee,
              { edit: tc('actions.edit'), delete: tc('actions.delete'), merge: tc('actions.merge'), reactivate: tc('actions.reactivate') },
              { onEdit, onDelete: setDeletePayee, onMerge, onReactivate },
            )
          : []}
        onClose={() => setActionSheet({ open: false, payee: null })}
      />
    </div>
  );
}
