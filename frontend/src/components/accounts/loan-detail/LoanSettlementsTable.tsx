'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { transactionHref } from '@/components/rules/RuleApplications';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useLongPress } from '@/hooks/useLongPress';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { LoanSettlementRow } from '@/types/account';

/** The loan's settled installments as the page's request answered them. */
export type LoanSettlementsState =
  | { status: 'ready'; rows: LoanSettlementRow[] }
  /** The request failed: unknown, never "nothing settled". */
  | { status: 'error' };

interface LoanSettlementsTableProps {
  settlements: LoanSettlementsState;
  currencyCode: string;
  onRetry: () => void;
}

/**
 * Whether the reader folded the table away: browser-local, like the other
 * page-level view preferences, since it is a fact about the screen.
 */
export const SETTLEMENTS_COLLAPSED_STORAGE_KEY = 'monize-loan-settlements-collapsed';

/** A control inside the clickable row keeps its own press (`docs/frontend/ui-conventions.md`). */
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * The installments payment matching settled on this loan, newest first: the
 * due date, the settled bank row, and the lines and the debt the server
 * stored when it priced the installment (the claim's `pricing`). Nothing is
 * derived here; a figure the claim did not record reads as not recorded.
 * The title toggles the table, like the Rate History panel's header, and
 * counts the rows once they are known; a failed request shows no count.
 */
export function LoanSettlementsTable({ settlements, currencyCode, onRetry }: LoanSettlementsTableProps) {
  const t = useTranslations('accounts.loanDetail.paymentMatching.settled');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber } = useNumberFormat();
  const [storedCollapsed, setCollapsed] = useLocalStorage<boolean>(
    SETTLEMENTS_COLLAPSED_STORAGE_KEY,
    false,
  );
  // A hand-edited or corrupted entry is not a reason to hide the table.
  const collapsed = storedCollapsed === true;

  const open = useCallback(
    (row: LoanSettlementRow) => router.push(transactionHref(row.transactionId)),
    [router],
  );
  const { getRowHandlers } = useLongPress<LoanSettlementRow>({ onLongPress: open, onClick: open });

  const money = (value: number | null) =>
    value === null ? (
      <span className="text-gray-500 dark:text-gray-400">{t('notRecorded')}</span>
    ) : (
      formatCurrency(value, currencyCode)
    );

  let body;
  if (settlements.status === 'error') {
    body = (
      <div role="alert">
        <EmptyState
          className="py-6"
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={onRetry}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (settlements.rows.length === 0) {
    body = <EmptyState className="py-6" title={t('empty.title')} description={t('empty.body')} />;
  } else {
    body = (
      <div className="max-h-96 overflow-auto">
        <table className={TABLE_CLASS}>
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <Th>{t('colDueDate')}</Th>
              <Th>{t('colTransaction')}</Th>
              <Th align="right">{t('colPrincipal')}</Th>
              <Th align="right">{t('colInterest')}</Th>
              <Th align="right">{t('colExtra')}</Th>
              <Th align="right">{t('colDebtBefore')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {settlements.rows.map((row) => (
              <tr key={row.claimId} className={`cursor-pointer ${HOVER_ROW_ON_CARD}`} {...getRowHandlers(row)}>
                <Td className="whitespace-nowrap">{formatDate(row.dueDate)}</Td>
                <Td className="whitespace-nowrap">
                  <Link
                    href={transactionHref(row.transactionId)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                    onClick={stop}
                    onMouseDown={stop}
                    onTouchStart={stop}
                    onContextMenu={stop}
                  >
                    {formatDate(row.postedDate)}
                    <span className="sr-only"> {t('openTransaction')}</span>
                  </Link>
                  {row.transactionStatus === 'VOID' && (
                    <Badge variant="gray" size="sm" className="ml-2">
                      {t('void')}
                    </Badge>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">{money(row.principal)}</Td>
                <Td align="right" className="whitespace-nowrap">{money(row.interest)}</Td>
                <Td align="right" className="whitespace-nowrap">{money(row.extraPrincipal)}</Td>
                <Td align="right" className="whitespace-nowrap">{money(row.debtBefore)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-left group"
        >
          <span
            aria-hidden="true"
            className="text-gray-400 dark:text-gray-500 group-hover:text-blue-600 dark:group-hover:text-blue-400"
          >
            {collapsed ? '▸' : '▾'}
          </span>
          {settlements.status === 'ready'
            ? t('titleWithCount', { count: formatNumber(settlements.rows.length, 0) })
            : t('title')}
        </button>
      </h4>
      {!collapsed && body}
    </div>
  );
}
