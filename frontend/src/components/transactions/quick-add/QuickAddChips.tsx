'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { entryDecimalPlaces } from '@/lib/format';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { Payee } from '@/types/payee';
import type {
  QuickAddAccountRef,
  QuickAddCategoryRef,
  QuickAddInterpretation,
  QuickAddKind,
  QuickAddPayeeRef,
  QuickAddPins,
} from '@/types/quick-add';
import { QuickAddChip } from './QuickAddChip';
import { QuickAddFieldEditor } from './QuickAddFieldEditor';
import {
  chipFields,
  chipState,
  fieldOf,
  isClearedChip,
  quickAddFigure,
  type QuickAddChipField,
} from './quick-add-chips';

interface QuickAddChipsProps {
  reading: QuickAddInterpretation;
  /** The reader's pins: a field they cleared reads as their own choice of none. */
  pins: QuickAddPins;
  /** A newer reading is on its way: shown, marked busy, and not actionable. */
  stale: boolean;
  editing: QuickAddChipField | null;
  onEditingChange: (field: QuickAddChipField | null) => void;
  accounts: Account[];
  payees: Payee[];
  categories: Category[];
  onPin: (patch: Partial<QuickAddPins>) => void;
}

/**
 * The "Read As" row: one chip per field of the reading, and under it the
 * editor of the chip that is open. Escape closes the editor before it can
 * close the dialog, and hands the focus back to the chip.
 */
export function QuickAddChips({
  reading,
  pins,
  stale,
  editing,
  onEditingChange,
  accounts,
  payees,
  categories,
  onPin,
}: QuickAddChipsProps) {
  const t = useTranslations('transactions');
  const { formatCurrency, formatNumber, defaultCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const editorId = `${baseId}-editor`;
  const chipRefs = useRef(new Map<QuickAddChipField, HTMLButtonElement | null>());
  const transfer = reading.kind.value === 'transfer';
  const fields = chipFields(reading);

  const labelOf = (field: QuickAddChipField): string => {
    switch (field) {
      case 'kind':
        return t('quickAdd.fields.kind');
      case 'amount':
        return t('form.fields.amount');
      case 'date':
        return t('form.fields.date');
      case 'account':
        return transfer ? t('form.fields.fromAccount') : t('form.fields.account');
      case 'toAccount':
        return t('form.fields.toAccount');
      case 'payee':
        return t('form.fields.payee');
      case 'category':
        return t('form.fields.category');
    }
  };

  const currency = reading.account.value?.currencyCode;
  // The editor's other candidates; the chip's own figure is `chipText`'s.
  const formatValue = (field: QuickAddChipField, value: unknown): string => {
    switch (field) {
      case 'kind':
        return t(`quickAdd.kinds.${value as QuickAddKind}`);
      case 'amount':
        // Without an account the currency is not known yet, so the figure
        // carries no symbol rather than the reader's default one.
        return currency
          ? formatCurrency(value as number, currency)
          : formatNumber(value as number, entryDecimalPlaces(defaultCurrency));
      case 'date':
        return formatDate(value as string);
      case 'account':
      case 'toAccount':
        return (value as QuickAddAccountRef).name;
      case 'payee':
        return (value as QuickAddPayeeRef).name;
      case 'category':
        return (value as QuickAddCategoryRef).name;
    }
  };

  /** What a chip reads: its value, the reader's own "none", or null for a missing one. */
  const chipText = (field: QuickAddChipField): string | null => {
    if (isClearedChip(reading, field, pins)) {
      return field === 'payee' ? t('quickAdd.cleared.payee') : t('quickAdd.cleared.category');
    }
    const value = fieldOf(reading, field).value;
    if (value === null) return null;
    // A figure typed in another currency reads in that one, never the account's.
    if (field === 'amount') {
      return quickAddFigure(reading, value as number, { formatCurrency, formatNumber, defaultCurrency });
    }
    return formatValue(field, value);
  };

  const close = useCallback(() => {
    if (editing === null) return;
    const chip = chipRefs.current.get(editing);
    onEditingChange(null);
    chip?.focus();
  }, [editing, onEditingChange]);

  // Captured on the document, ahead of Modal's own Escape, which would close
  // the whole dialog and take the entry with it.
  useEffect(() => {
    if (editing === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [editing, close]);

  return (
    <div className="space-y-3">
      <div role="group" aria-labelledby={headingId} aria-busy={stale}>
        <p id={headingId} className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('quickAdd.readAs')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {fields.map((field) => {
            return (
              <QuickAddChip
                key={field}
                ref={(element) => {
                  chipRefs.current.set(field, element);
                }}
                fieldLabel={labelOf(field)}
                valueText={chipText(field)}
                state={chipState(reading, field, pins)}
                expanded={editing === field}
                editorId={editorId}
                stale={stale}
                onClick={() => onEditingChange(editing === field ? null : field)}
              />
            );
          })}
          {reading.memo && (
            // Not a control: nothing pins a memo, and Full Form edits it. It is
            // the description the save stores, so an address in it is drawn as
            // the register draws it. Named in text: a span's aria-label is not read out.
            <Badge
              size="md"
              variant="blue"
              data-testid="quick-add-memo"
              className="max-w-full border border-solid border-blue-300 py-1 dark:border-blue-700"
            >
              <span className="sr-only">{t('quickAdd.memoLabel')}</span>
              <span className="truncate">
                <LinkifiedText text={reading.memo} />
              </span>
            </Badge>
          )}
        </div>
      </div>
      {editing !== null && fields.includes(editing) && (
        <QuickAddFieldEditor
          key={editing}
          id={editorId}
          field={editing}
          fieldLabel={labelOf(editing)}
          reading={reading}
          stale={stale}
          accounts={accounts}
          payees={payees}
          categories={categories}
          formatValue={formatValue}
          onPin={(patch, done) => {
            onPin(patch);
            if (done) close();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
