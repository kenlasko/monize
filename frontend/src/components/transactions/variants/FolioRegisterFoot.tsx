'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { HIDEABLE_COLUMNS } from '@/lib/hidden-columns';
import { REGISTER_COLUMN_ORDER, registerColumnClass, type RegisterColumnId } from '../register-columns';

const HIDEABLE: readonly string[] = HIDEABLE_COLUMNS.transactions;

export interface FolioRegisterFootProps {
  totals: { count: number; payments: number; deposits: number; net: number };
  currencyCode: string | undefined;
  cellPadding: string;
  selectionMode: boolean | undefined;
  isSingleAccountView: boolean;
  showRunningBalance: boolean;
  /** The table's hidden set: Folio's Description plus the reader's own. */
  hidden: ReadonlySet<string>;
}

/**
 * The Folio register's totals row. One cell per column the rows draw, walked
 * from `REGISTER_COLUMN_ORDER` with each column's own tier class, never a
 * colSpan: the tiers hide columns with a class, so a span sized from the
 * columns in the DOM put the totals under Status and Actions at mid widths
 * and past the table's edge on a phone, where it widened the table and
 * squeezed the payee to nothing (#2305).
 */
export function FolioRegisterFoot({
  totals,
  currencyCode,
  cellPadding,
  selectionMode,
  isSingleAccountView,
  showRunningBalance,
  hidden,
}: FolioRegisterFootProps) {
  const t = useTranslations('transactions');
  const { formatCurrency } = useNumberFormat();

  // What the rows draw under date groups: no Date column, no FX columns
  // (Folio is never the fee surface), Account only across accounts.
  const drawn = (id: RegisterColumnId): boolean => {
    if (id === 'date' || id === 'paidCurrency' || id === 'paidAmount' || id === 'feePaid') return false;
    if (id === 'account') return !isSingleAccountView;
    if (id === 'balance') return showRunningBalance;
    return !HIDEABLE.includes(id) || !hidden.has(id);
  };

  const cell = (id: RegisterColumnId) => {
    switch (id) {
      case 'payee':
        return (
          <td key={id} className={cellPadding}>
            {t('list.folio.entriesShown', { count: totals.count })}
          </td>
        );
      case 'amount':
        return (
          <React.Fragment key={id}>
            <td className={`${cellPadding} ui-register-money text-right`}>
              {formatCurrency(totals.payments, currencyCode)}
            </td>
            <td className={`${cellPadding} ui-register-money ui-register-deposit text-right`}>
              {formatCurrency(totals.deposits, currencyCode)}
            </td>
          </React.Fragment>
        );
      case 'balance':
        return (
          <td key={id} className={`${cellPadding} ui-register-money text-right`}>
            {totals.net > 0 ? '+' : totals.net < 0 ? '-' : ''}
            {formatCurrency(Math.abs(totals.net), currencyCode)}
          </td>
        );
      default:
        return <td key={id} className={`${cellPadding} ${registerColumnClass(id)}`} />;
    }
  };

  return (
    <tfoot>
      <tr className="ui-register-foot">
        {selectionMode && <td className={cellPadding} />}
        {REGISTER_COLUMN_ORDER.filter(drawn).map(cell)}
      </tr>
    </tfoot>
  );
}
