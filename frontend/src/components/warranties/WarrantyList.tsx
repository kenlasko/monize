'use client';

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListTopToolbar } from '@/components/ui/ListTopToolbar';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { SortIcon } from '@/components/ui/SortIcon';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { CellLabel, TABLE_BODY_CLASS, TABLE_CLASS, TH_CLASS, Td, Th } from '@/components/ui/Table';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { WarrantyStatusBadge, useWarrantyDaysLeftText } from '@/components/warranties/WarrantyStatusBadge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { cn } from '@/lib/utils';
import { withCurrencyCode } from '@/lib/format';
import type { Warranty, WarrantySort, WarrantySortDir } from '@/types/warranty';

/**
 * The direction a field sorts in when first chosen; pressing the active field
 * again flips it (`ListWarrantiesDto.sortDir`). A `Record` over the union so a
 * new sort field is a compile error until it is given a direction and a phone
 * chip.
 */
export const DEFAULT_SORT_DIRECTION: Record<WarrantySort, WarrantySortDir> = {
  expiresOn: 'asc',
  name: 'asc',
  purchaseDate: 'desc',
};

const SORT_FIELDS = Object.keys(DEFAULT_SORT_DIRECTION) as WarrantySort[];

interface WarrantyActionHandlers {
  onEdit: (warranty: Warranty) => void;
  onArchive: (warranty: Warranty) => void;
  onUnarchive: (warranty: Warranty) => void;
  onDelete: (warranty: Warranty) => void;
}

interface WarrantyActionLabels {
  edit: string;
  archive: string;
  unarchive: string;
  delete: string;
}

/** One action list for both the inline `RowActions` and the long-press sheet. */
function buildWarrantyActions(
  warranty: Warranty,
  labels: WarrantyActionLabels,
  handlers: WarrantyActionHandlers,
  disabled: boolean,
): RowAction[] {
  const archived = warranty.archivedAt !== null;
  return [
    { key: 'edit', label: labels.edit, icon: 'edit', tone: 'primary', disabled, onClick: () => handlers.onEdit(warranty) },
    {
      key: 'archive',
      label: labels.archive,
      icon: 'close',
      tone: 'warning',
      hidden: archived,
      disabled,
      onClick: () => handlers.onArchive(warranty),
    },
    {
      key: 'unarchive',
      label: labels.unarchive,
      icon: 'reopen',
      tone: 'primary',
      hidden: !archived,
      disabled,
      onClick: () => handlers.onUnarchive(warranty),
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      disabled,
      onClick: () => handlers.onDelete(warranty),
    },
  ];
}

interface WarrantyRowProps {
  warranty: Warranty;
  density: DensityLevel;
  cellPadding: string;
  actions: RowAction[];
  readOnly: boolean;
  wrapped: boolean;
  getRowHandlers: (warranty: Warranty) => LongPressRowHandlers;
  onOpen: (warranty: Warranty) => void;
}

const WarrantyRow = memo(function WarrantyRow({
  warranty,
  density,
  cellPadding,
  actions,
  readOnly,
  wrapped,
  getRowHandlers,
  onOpen,
}: WarrantyRowProps) {
  const t = useTranslations('warranties');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber, defaultCurrency } = useNumberFormat();
  const daysLeftText = useWarrantyDaysLeftText();

  const expires = warranty.isLifetime || warranty.expiresOn === null
    ? t('list.lifetime')
    : formatDate(warranty.expiresOn);
  const purchased = formatDate(warranty.purchaseDate);
  // A price in a currency that is not the reader's says which one it is.
  const price = warranty.purchasePrice !== null && warranty.currencyCode !== null
    ? withCurrencyCode(
        formatCurrency(warranty.purchasePrice, warranty.currencyCode),
        warranty.currencyCode,
        defaultCurrency,
      )
    : t('list.noPrice');
  const daysLeft = daysLeftText(warranty);
  const documents = formatNumber(warranty.documentCount, 0);
  const claims = formatNumber(warranty.openClaimCount, 0);

  const rowProps = {
    role: 'row',
    tabIndex: 0,
    className: `group cursor-pointer select-none ${INTERACTIVE_ROW_FOCUS_CLASS} ${HOVER_ROW_ON_CARD}`,
    ...getRowHandlers(warranty),
    onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
      // Enter on an action button is the button's, not the row's.
      if (event.target === event.currentTarget) activateOnKey(() => onOpen(warranty))(event);
    },
  };

  const identity = (
    <div className="min-w-0">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">{warranty.name}</div>
      {/* The vendor's logo from the view's own payee; a free-text vendor
          draws its initial, so the vendor text lines up on every row. */}
      {warranty.vendorName && (
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <PayeeLogo payee={warranty.payee} name={warranty.vendorName} size={20} />
          <span className="min-w-0 break-words">{warranty.vendorName}</span>
        </div>
      )}
    </div>
  );

  // Phone at Normal density: one card per warranty, every column captioned
  // (the header is replaced by the sort chips). The same values as the tier
  // row below; actions move to the long-press sheet.
  if (wrapped) {
    return (
      <tr {...rowProps}>
        <td className="p-0">
          <div className={cellPadding}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-start">
              {identity}
              <WarrantyStatusBadge warranty={warranty} />
              <div className="col-span-2 grid grid-cols-2 gap-x-4">
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.expiresOn')}</CellLabel>
                  <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{expires}</div>
                  {daysLeft !== null && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{daysLeft}</div>
                  )}
                </div>
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.purchaseDate')}</CellLabel>
                  <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{purchased}</div>
                </div>
              </div>
              <div className="col-span-2 grid grid-cols-3 gap-x-4">
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.price')}</CellLabel>
                  <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{price}</div>
                </div>
                <div>
                  <CellLabel>{t('list.columns.documents')}</CellLabel>
                  <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{documents}</div>
                </div>
                <div>
                  <CellLabel>{t('list.columns.claims')}</CellLabel>
                  <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{claims}</div>
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr {...rowProps}>
      <Td className={cellPadding}>{identity}</Td>
      <Td className={cellPadding}>
        <WarrantyStatusBadge warranty={warranty} showDaysLeft={density !== 'dense'} />
      </Td>
      <Td className={cn(cellPadding, 'hidden sm:table-cell whitespace-nowrap')}>{expires}</Td>
      <Td className={cn(cellPadding, 'hidden md:table-cell whitespace-nowrap')}>{purchased}</Td>
      <Td align="right" className={cn(cellPadding, 'hidden md:table-cell whitespace-nowrap')}>{price}</Td>
      <Td align="right" className={cn(cellPadding, 'hidden lg:table-cell whitespace-nowrap')}>{documents}</Td>
      <Td align="right" className={cn(cellPadding, 'hidden lg:table-cell whitespace-nowrap')}>{claims}</Td>
      {!readOnly && (
        <Td align="right" className={cn(cellPadding, 'hidden min-[480px]:table-cell whitespace-nowrap font-medium')}>
          <RowActions actions={actions} density={density} />
        </Td>
      )}
    </tr>
  );
});

export interface WarrantyListEmpty {
  title: string;
  description?: string;
  action?: ReactNode;
}

export interface WarrantyListProps extends WarrantyActionHandlers {
  warranties: readonly Warranty[];
  /** A row's primary action: open the warranty's detail page. Edit stays a row action. */
  onOpen: (warranty: Warranty) => void;
  sort: WarrantySort;
  sortDir: WarrantySortDir;
  onSort: (sort: WarrantySort) => void;
  /** What an empty page says, decided by the page that knows which filters are on. */
  empty: WarrantyListEmpty;
  /** Buttons for the strip above the rows (Add; Export and Import later). */
  toolbarActions?: ReactNode;
  /**
   * No Edit, Archive or Delete: no actions column and no long-press sheet. An
   * acting delegate reads warranties but never changes them.
   */
  readOnly?: boolean;
  /**
   * True while the rows on screen answer a request the reader has already
   * moved away from: they stay visible, marked busy, and nothing on them acts.
   */
  stale?: boolean;
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}

/**
 * The warranties table: `Table.tsx` chrome, density from
 * `useDensityPreference('warranties')`, a phone card at Normal density, and the
 * row actions as one `RowAction[]` for the inline buttons and the long-press
 * sheet alike. Status and days left are the server's (WTY-002).
 */
export function WarrantyList({
  warranties,
  sort,
  sortDir,
  onSort,
  empty,
  toolbarActions,
  readOnly = false,
  stale = false,
  onOpen,
  onEdit,
  onArchive,
  onUnarchive,
  onDelete,
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: WarrantyListProps) {
  const t = useTranslations('warranties');
  const tc = useTranslations('common');
  const { density } = useDensityPreference('warranties');
  const { cellPadding, headerPadding } = useTableDensity(density);
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';
  const [sheetId, setSheetId] = useState<string | null>(null);

  const labels = useMemo<WarrantyActionLabels>(
    () => ({
      edit: tc('actions.edit'),
      archive: t('list.actions.archive'),
      unarchive: t('list.actions.unarchive'),
      delete: tc('actions.delete'),
    }),
    [t, tc],
  );

  const handlers = useMemo<WarrantyActionHandlers>(
    () => ({ onEdit, onArchive, onUnarchive, onDelete }),
    [onEdit, onArchive, onUnarchive, onDelete],
  );

  const open = useCallback(
    (warranty: Warranty) => {
      if (!stale) onOpen(warranty);
    },
    [stale, onOpen],
  );

  const { getRowHandlers } = useLongPress<Warranty>({
    onLongPress: (warranty) => {
      if (!readOnly) setSheetId(warranty.id);
    },
    onClick: open,
  });

  const rowActions = useMemo(
    () => warranties.map((warranty) => buildWarrantyActions(warranty, labels, handlers, stale)),
    [warranties, labels, handlers, stale],
  );

  // The sheet shows the warranty as the list holds it now.
  const sheetWarranty = sheetId ? warranties.find((w) => w.id === sheetId) ?? null : null;

  const sortLabels: Record<WarrantySort, string> = {
    name: t('list.columns.name'),
    expiresOn: t('list.columns.expiresOn'),
    purchaseDate: t('list.columns.purchaseDate'),
  };
  const headerClass = cn(TH_CLASS, headerPadding);
  // An empty page draws the buttons alone: "Showing 0 of 0" would repeat what
  // the empty state below already says.
  const paging =
    warranties.length > 0
      ? { currentPage, totalPages, totalItems, pageSize, onPageChange }
      : {};
  const toolbar = (
    <ListTopToolbar
      densityView="warranties"
      actions={toolbarActions}
      itemName={t('page.pager.itemName')}
      {...paging}
    />
  );

  if (warranties.length === 0) {
    return (
      <div>
        {toolbar}
        <EmptyState
          icon={<ShieldCheckIcon />}
          title={empty.title}
          description={empty.description}
          action={empty.action}
          help="warranties"
        />
      </div>
    );
  }

  return (
    <div>
      {toolbar}
      <div className={`overflow-x-auto ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
        <table className={TABLE_CLASS}>
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
              <tr>
                <th
                  className={`${headerPadding} text-left`}
                  aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('list.sortLabel')}</span>
                    {SORT_FIELDS.map((field) => (
                      <button
                        key={field}
                        type="button"
                        aria-pressed={sort === field}
                        onClick={() => onSort(field)}
                        className="flex min-h-[30px] items-center px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
                      >
                        {sortLabels[field]}
                        <SortIcon field={field} sortField={sort} sortDirection={sortDir} />
                      </button>
                    ))}
                  </div>
                </th>
              </tr>
            ) : (
              <tr>
                <SortableHeader field="name" sortField={sort} sortDirection={sortDir} onSort={onSort} className={headerClass}>
                  {sortLabels.name}
                </SortableHeader>
                <Th className={headerPadding}>{t('list.columns.status')}</Th>
                <SortableHeader
                  field="expiresOn"
                  sortField={sort}
                  sortDirection={sortDir}
                  onSort={onSort}
                  className={cn(headerClass, 'hidden sm:table-cell')}
                >
                  {sortLabels.expiresOn}
                </SortableHeader>
                <SortableHeader
                  field="purchaseDate"
                  sortField={sort}
                  sortDirection={sortDir}
                  onSort={onSort}
                  className={cn(headerClass, 'hidden md:table-cell')}
                >
                  {sortLabels.purchaseDate}
                </SortableHeader>
                <Th align="right" className={cn(headerPadding, 'hidden md:table-cell')}>
                  {t('list.columns.price')}
                </Th>
                <Th align="right" className={cn(headerPadding, 'hidden lg:table-cell')}>
                  {t('list.columns.documents')}
                </Th>
                <Th align="right" className={cn(headerPadding, 'hidden lg:table-cell')}>
                  {t('list.columns.claims')}
                </Th>
                {!readOnly && (
                  <Th align="right" className={cn(headerPadding, 'hidden min-[480px]:table-cell')}>
                    {t('list.columns.actions')}
                  </Th>
                )}
              </tr>
            )}
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {warranties.map((warranty, index) => (
              <WarrantyRow
                key={warranty.id}
                warranty={warranty}
                density={density}
                cellPadding={cellPadding}
                actions={rowActions[index]}
                readOnly={readOnly}
                wrapped={wrapped}
                getRowHandlers={getRowHandlers}
                onOpen={open}
              />
            ))}
          </tbody>
        </table>
      </div>
      <RowActionSheet
        isOpen={!readOnly && sheetWarranty !== null}
        title={sheetWarranty?.name ?? ''}
        actions={sheetWarranty ? buildWarrantyActions(sheetWarranty, labels, handlers, stale) : []}
        onClose={() => setSheetId(null)}
      />
    </div>
  );
}
