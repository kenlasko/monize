'use client';

import { Fragment, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ImportPreviewCheckbox } from '@/components/import-preview/ImportPreviewCheckbox';
import { ImportPreviewChoice } from '@/components/import-preview/ImportPreviewChoice';
import { ImportPreviewExpandButton } from '@/components/import-preview/ImportPreviewExpandButton';
import { ImportPreviewPayeeCell } from '@/components/import-preview/ImportPreviewPayeeCell';
import { Badge } from '@/components/ui/Badge';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { Td } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { KNOWN_REFUSAL_REASONS } from '@/lib/bank-sync-summary';
import { OUTCOME_VARIANTS, previewAmount } from '@/lib/bank-sync-preview';
import type { UncheckedChoice } from '@/lib/import-preview';
import { gainLossColor } from '@/lib/format';
import type { BankSyncPreviewLabels, BankSyncPreviewRow } from '@/types/bank-sync';
import { PreviewRowDetails, previewDetailsId } from './BankSyncPreviewRowDetails';

/** Body cells: tighter than the default so five columns fit one screen. */
export const CELL_CLASS = 'px-3 align-top';

/** What both layouts of a row print, worked out once. */
function useRowDisplay(row: BankSyncPreviewRow, accountCurrency: string) {
  const t = useTranslations('settings.bankSync.preview');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber } = useNumberFormat();

  const amount = previewAmount(row.amount);
  // A row is shown in the currency the bank sent it in; one without a currency
  // is a bare number, never labelled with the account's.
  const currency = row.currencyCode ?? (row.outcome === 'refused' ? null : accountCurrency);
  const amountText =
    amount === null
      ? t('amountUnknown')
      : currency
        ? formatCurrency(amount, currency)
        : formatNumber(amount, 2);
  const refusal =
    row.refusalReason !== null &&
    (KNOWN_REFUSAL_REASONS as readonly string[]).includes(row.refusalReason)
      ? row.refusalReason
      : 'other';

  return {
    dateText: row.transactionDate ? formatDate(row.transactionDate) : t('dateUnknown'),
    payeeText: row.payeeName ?? row.payeeText ?? t('noPayee'),
    amountText,
    // An unreadable amount is unknown, so it takes no sign colour.
    amountClass: amount === null ? '' : gainLossColor(amount),
    status: row.outcome === 'refused' ? t(`refusal.${refusal}`) : t(`outcome.${row.outcome}`),
    dimmed: row.outcome !== 'new',
  };
}

export interface PreviewRowControls {
  /** Whether the row has a box at all: a new row always, an exception only in the Exceptions tab. */
  boxed: boolean;
  /**
   * For a `new` row: checked means it will be imported. For an `excluded` row:
   * checked means it will be removed from the exceptions.
   */
  checked: boolean;
  /** What an unchecked `new` row does. */
  choice: UncheckedChoice;
  onCheckedChange: (checked: boolean) => void;
  onChoiceChange: (choice: UncheckedChoice) => void;
  /** An import or a removal is running: nothing can be changed under it. */
  disabled: boolean;
}

interface PreviewRowProps {
  row: BankSyncPreviewRow;
  accountCurrency: string;
  labels: BankSyncPreviewLabels;
  controls: PreviewRowControls;
}

function RowBox({ row, controls, payeeText }: { row: BankSyncPreviewRow; controls: PreviewRowControls; payeeText: string }) {
  const t = useTranslations('settings.bankSync.preview');
  if (!controls.boxed) return null;
  return (
    <ImportPreviewCheckbox
      state={controls.checked ? 'all' : 'none'}
      onChange={controls.onCheckedChange}
      disabled={controls.disabled}
      label={t(row.outcome === 'new' ? 'selectRow' : 'selectException', { payee: payeeText })}
    />
  );
}

const hasDetails = (row: BankSyncPreviewRow): boolean => row.outcome === 'new' && row.externalKey !== null;

export function PreviewRow({ row, accountCurrency, labels, controls }: PreviewRowProps) {
  const { dateText, payeeText, amountText, amountClass, status, dimmed } = useRowDisplay(row, accountCurrency);
  const idPrefix = useId();
  const [expanded, setExpanded] = useState(false);
  const detailsId = previewDetailsId(idPrefix, row.externalKey ?? 'row');
  const unchecked = row.outcome === 'new' && !controls.checked;

  return (
    <Fragment>
      <tr className={dimmed ? 'text-gray-500 dark:text-gray-400' : undefined}>
        <Td className={CELL_CLASS}>
          <div className="flex items-center gap-2">
            <RowBox row={row} controls={controls} payeeText={payeeText} />
            {hasDetails(row) && (
              <ImportPreviewExpandButton
                expanded={expanded}
                detailsId={detailsId}
                rowLabel={payeeText}
                onToggle={() => setExpanded((open) => !open)}
              />
            )}
          </div>
        </Td>
        <Td className={`${CELL_CLASS} whitespace-nowrap`}>{dateText}</Td>
        <Td className={CELL_CLASS}>
          <ImportPreviewPayeeCell text={payeeText} payee={row.payee} />
          {row.description && (
            <div
              className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400"
              title={row.description}
            >
              <LinkifiedText text={row.description} />
            </div>
          )}
        </Td>
        <Td className={`${CELL_CLASS} hidden lg:table-cell`}>
          {row.categoryName && (
            <div className="min-w-0 truncate" title={row.categoryName}>
              {row.categoryName}
            </div>
          )}
          {row.tagNames.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.tagNames.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
        </Td>
        <Td align="right" className={`${CELL_CLASS} whitespace-nowrap tabular-nums`}>
          <span className={amountClass}>{amountText}</span>
        </Td>
        <Td className={`${CELL_CLASS} whitespace-nowrap`}>
          <Badge variant={OUTCOME_VARIANTS[row.outcome]}>{status}</Badge>
          {unchecked && (
            <ImportPreviewChoice
              rowId={idPrefix}
              rowLabel={payeeText}
              choice={controls.choice}
              onChange={controls.onChoiceChange}
              disabled={controls.disabled}
            />
          )}
        </Td>
      </tr>
      {expanded && hasDetails(row) && (
        <tr>
          <Td colSpan={6} className="px-3 pb-3">
            <PreviewRowDetails id={detailsId} row={row} labels={labels} />
          </Td>
        </tr>
      )}
    </Fragment>
  );
}

/** A row on a phone: date and amount, the payee, the description, then the outcome. */
export function PreviewCard({ row, accountCurrency, labels, controls }: PreviewRowProps) {
  const { dateText, payeeText, amountText, amountClass, status, dimmed } = useRowDisplay(row, accountCurrency);
  const idPrefix = useId();
  const [expanded, setExpanded] = useState(false);
  const detailsId = previewDetailsId(idPrefix, row.externalKey ?? 'row');
  const unchecked = row.outcome === 'new' && !controls.checked;

  return (
    <li
      className={`space-y-1 py-3 text-sm ${
        dimmed ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <RowBox row={row} controls={controls} payeeText={payeeText} />
          <span className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">{dateText}</span>
        </span>
        <span className={`whitespace-nowrap font-medium tabular-nums ${amountClass}`}>{amountText}</span>
      </div>
      <div className="flex items-center gap-1 font-medium">
        <div className="min-w-0 flex-1">
          <ImportPreviewPayeeCell text={payeeText} payee={row.payee} />
        </div>
        {hasDetails(row) && (
          <ImportPreviewExpandButton
            expanded={expanded}
            detailsId={detailsId}
            rowLabel={payeeText}
            onToggle={() => setExpanded((open) => !open)}
          />
        )}
      </div>
      {row.description && (
        <div
          className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400"
          title={row.description}
        >
          <LinkifiedText text={row.description} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <Badge variant={OUTCOME_VARIANTS[row.outcome]}>{status}</Badge>
        {row.categoryName && (
          <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">{row.categoryName}</span>
        )}
        {row.tagNames.map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>
      {unchecked && (
        <ImportPreviewChoice
          rowId={idPrefix}
          rowLabel={payeeText}
          choice={controls.choice}
          onChange={controls.onChoiceChange}
          disabled={controls.disabled}
        />
      )}
      {expanded && hasDetails(row) && <PreviewRowDetails id={detailsId} row={row} labels={labels} />}
    </li>
  );
}
