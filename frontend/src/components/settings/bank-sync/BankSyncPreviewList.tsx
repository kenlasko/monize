'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ImportPreviewCheckbox } from '@/components/import-preview/ImportPreviewCheckbox';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Tabs, tabId, tabPanelId, type TabItem } from '@/components/ui/Tabs';
import { TABLE_BODY_CLASS, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { ImportPreviewSelectionApi } from '@/hooks/useImportPreviewSelection';
import {
  PREVIEW_FILTERS,
  exceptionKeys,
  filterPreviewRows,
  previewAmount,
  previewFilterCounts,
  selectableKeys,
  type PreviewFilter,
} from '@/lib/bank-sync-preview';
import { checkState } from '@/lib/import-preview';
import type { BankSyncPreview, BankSyncPreviewRow } from '@/types/bank-sync';
import { PreviewCard, PreviewRow, type PreviewRowControls } from './BankSyncPreviewRows';

const TAB_ID_PREFIX = 'bank-sync-preview';

/**
 * The rows are the only thing that scrolls. The modal is a fixed-height column
 * (`fixedHeight`): the header, this list's summary and tabs, and the footer
 * keep their own height, and the rows take every pixel left, so the footer's
 * Import button never leaves the screen and nothing sits below it. The floor
 * is for a viewport too short to give the rows any more: the modal's body then
 * scrolls instead of the rows shrinking to nothing.
 */
const LIST_SCROLL_CLASS = 'scrollbar-slim min-h-40 flex-1 overflow-y-auto';

/** A header cell that stays put while the rows scroll under it. */
const STICKY_TH_CLASS =
  'sticky top-0 z-10 border-b border-gray-200 bg-white px-3 dark:border-gray-700 dark:bg-gray-800';

interface PreviewListProps {
  preview: BankSyncPreview;
  filter: PreviewFilter;
  onFilterChange: (filter: PreviewFilter) => void;
  /** The person's choices about the new rows: which are unchecked, and what each of them does. */
  selection: ImportPreviewSelectionApi;
  /** The exceptions picked for removal. */
  removeKeys: ReadonlySet<string>;
  onRemoveKeysChange: (keys: ReadonlySet<string>) => void;
  onRemove: () => void;
  /** An import or a removal is running: nothing can be changed under it. */
  busy: boolean;
  removing: boolean;
}

/** One label and its figure; a pair per cell of the summary's two-column grid. */
function SummaryItem({
  label,
  strong = false,
  children,
}: {
  label: ReactNode;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="flex shrink-0 items-center gap-1 text-gray-500 dark:text-gray-400">{label}</dt>
      <dd
        className={`min-w-0 text-right tabular-nums text-gray-900 dark:text-gray-100${
          strong ? ' font-medium' : ''
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * The balances, the outcome tabs and the rows of one preview. The new rows are
 * checked unless the person unchecks them (and then each is skipped for now or
 * added to the exceptions); the Exceptions tab lists what was excepted, with a
 * way to take it back.
 */
export function BankSyncPreviewList({
  preview,
  filter,
  onFilterChange,
  selection,
  removeKeys,
  onRemoveKeysChange,
  onRemove,
  busy,
  removing,
}: PreviewListProps) {
  const t = useTranslations('settings.bankSync.preview');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  // A phone gets a card per row. Both layouts show the same figures, so this
  // selects a presentation, not a different answer.
  const isPhone = useIsMobile();

  const counts = previewFilterCounts(preview.rows);
  const tabs: TabItem<PreviewFilter>[] = PREVIEW_FILTERS.map((key) => ({
    key,
    label: t('filter.withCount', { label: t(`filter.${key}`), count: counts[key] }),
  }));
  const shown = filterPreviewRows(preview.rows, filter);

  const money = (amount: string) => {
    const value = previewAmount(amount);
    return value === null ? null : formatCurrency(value, preview.currencyCode);
  };
  const bank = preview.bankBalance;
  const bankAmount = bank ? previewAmount(bank.amount) : null;
  const differenceAmount = previewAmount(preview.difference);
  const currenciesDiffer =
    bank !== null && bankAmount !== null && bank.currencyCode !== preview.currencyCode;

  // The header box means "import" over the new rows of the list, and "remove"
  // over the exceptions of the Exceptions tab; the other tabs have none.
  const importKeys = filter === 'all' || filter === 'new' ? selectableKeys(shown) : [];
  const exceptionKeysShown = filter === 'excluded' ? exceptionKeys(shown) : [];
  const headerBox =
    importKeys.length > 0
      ? {
          state: selection.stateOf(importKeys),
          label: t('selectAllNew'),
          onChange: (checked: boolean) => selection.setAllChecked(importKeys, checked),
        }
      : exceptionKeysShown.length > 0
        ? {
            state: checkState(exceptionKeysShown, (key) => removeKeys.has(key)),
            label: t('selectAllExceptions'),
            onChange: (checked: boolean) => {
              const next = new Set(removeKeys);
              for (const key of exceptionKeysShown) {
                if (checked) next.add(key);
                else next.delete(key);
              }
              onRemoveKeysChange(next);
            },
          }
        : null;

  const controlsFor = (row: BankSyncPreviewRow): PreviewRowControls => {
    const key = row.externalKey;
    if (key !== null && row.outcome === 'new') {
      return {
        boxed: true,
        checked: selection.isChecked(key),
        choice: selection.choiceOf(key),
        onCheckedChange: (checked) => selection.setChecked(key, checked),
        onChoiceChange: (choice) => selection.setChoice(key, choice),
        disabled: busy,
      };
    }
    const isException = key !== null && row.outcome === 'excluded' && filter === 'excluded';
    return {
      boxed: isException,
      checked: key !== null && removeKeys.has(key),
      choice: 'skip',
      onCheckedChange: (checked) => {
        if (key === null) return;
        const next = new Set(removeKeys);
        if (checked) next.add(key);
        else next.delete(key);
        onRemoveKeysChange(next);
      },
      onChoiceChange: () => undefined,
      disabled: busy,
    };
  };
  const rowKey = (row: BankSyncPreviewRow, index: number) => row.externalKey ?? `row-${index}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="shrink-0 space-y-4">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <SummaryItem label={t('monizeBalance')}>{money(preview.monizeBalance)}</SummaryItem>
          <SummaryItem label={t('balanceAfter')} strong>
            {money(preview.balanceAfter)}
          </SummaryItem>
          <SummaryItem label={t('bankBalance')}>
            {bank !== null && bankAmount !== null
              ? bank.referenceDate
                ? t('bankBalanceAsOf', {
                    amount: formatCurrency(bankAmount, bank.currencyCode),
                    date: formatDate(bank.referenceDate),
                  })
                : formatCurrency(bankAmount, bank.currencyCode)
              : t('bankBalanceNotReported')}
          </SummaryItem>
          {differenceAmount !== null && (
            <SummaryItem
              label={
                <>
                  {t('difference')}
                  <InfoTooltip text={t('differenceHelp')} usePortal />
                </>
              }
            >
              {formatCurrency(differenceAmount, preview.currencyCode)}
            </SummaryItem>
          )}
        </dl>
        {currenciesDiffer && bank && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('differenceHidden', {
              bankCurrency: bank.currencyCode,
              monizeCurrency: preview.currencyCode,
            })}
          </p>
        )}

        <Tabs
          tabs={tabs}
          value={filter}
          onChange={onFilterChange}
          idPrefix={TAB_ID_PREFIX}
          ariaLabel={t('filterLabel')}
          wrap
        />
      </div>

      <div
        id={tabPanelId(TAB_ID_PREFIX, filter)}
        role="tabpanel"
        aria-labelledby={tabId(TAB_ID_PREFIX, filter)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {filter === 'excluded' && shown.length > 0 && (
          <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('exceptions.intro')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRemove}
              disabled={busy || removing || removeKeys.size === 0}
            >
              {removing ? t('exceptions.removing') : t('exceptions.remove', { count: removeKeys.size })}
            </Button>
          </div>
        )}
        {shown.length === 0 ? (
          <EmptyState title={filter === 'all' ? t('empty.all') : t('empty.filtered')} />
        ) : isPhone ? (
          <>
            {headerBox && (
              <label className="flex shrink-0 items-center gap-2 pb-2 text-sm text-gray-700 dark:text-gray-300">
                <ImportPreviewCheckbox
                  state={headerBox.state}
                  onChange={headerBox.onChange}
                  label={headerBox.label}
                  disabled={busy}
                />
                <span>{headerBox.label}</span>
              </label>
            )}
            <ul className={`${LIST_SCROLL_CLASS} ${TABLE_BODY_CLASS}`}>
              {shown.map((row, index) => (
                <PreviewCard
                  key={rowKey(row, index)}
                  row={row}
                  accountCurrency={preview.currencyCode}
                  labels={preview.labels}
                  controls={controlsFor(row)}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className={LIST_SCROLL_CLASS}>
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-20" />
                <col className="w-32" />
                <col />
                <col className="hidden w-[22%] lg:table-column" />
                <col className="w-40" />
                <col className="w-44" />
              </colgroup>
              <thead>
                <tr>
                  <Th className={STICKY_TH_CLASS}>
                    <span className="sr-only">{t('columns.select')}</span>
                    {headerBox && (
                      <ImportPreviewCheckbox
                        state={headerBox.state}
                        onChange={headerBox.onChange}
                        label={headerBox.label}
                        disabled={busy}
                      />
                    )}
                  </Th>
                  <Th className={STICKY_TH_CLASS}>{t('columns.date')}</Th>
                  <Th className={STICKY_TH_CLASS}>{t('columns.payee')}</Th>
                  <Th className={`${STICKY_TH_CLASS} hidden lg:table-cell`}>{t('columns.category')}</Th>
                  <Th align="right" className={STICKY_TH_CLASS}>
                    {t('columns.amount')}
                  </Th>
                  <Th className={STICKY_TH_CLASS}>{t('columns.status')}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {shown.map((row, index) => (
                  <PreviewRow
                    key={rowKey(row, index)}
                    row={row}
                    accountCurrency={preview.currencyCode}
                    labels={preview.labels}
                    controls={controlsFor(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
