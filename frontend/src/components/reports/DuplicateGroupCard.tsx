'use client';

import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import { useDuplicateLabels } from '@/components/reports/useDuplicateLabels';
import type {
  DuplicateConfidence,
  DuplicateGroup,
  DuplicateTransactionItem,
} from '@/types/built-in-reports';

const CONFIDENCE_STYLES: Readonly<
  Record<DuplicateConfidence, { surface: string; badge: BadgeVariant }>
> = {
  very_high: { surface: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800', badge: 'purple' },
  high: { surface: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800', badge: 'red' },
  medium: { surface: 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800', badge: 'amber' },
  low: { surface: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800', badge: 'gray' },
};

interface DuplicateGroupCardProps {
  group: DuplicateGroup;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (tx: DuplicateTransactionItem) => void;
  categoryColorMap: ReadonlyMap<string, string | null>;
  categoryIconMap: ReadonlyMap<string, string | null>;
}

export function DuplicateGroupCard({
  group,
  selected,
  onToggle,
  onOpen,
  categoryColorMap,
  categoryIconMap,
}: DuplicateGroupCardProps) {
  const t = useTranslations('reports');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { confidenceLabel, reasonLabel, categoryLabel } = useDuplicateLabels();
  const styles = CONFIDENCE_STYLES[group.confidence];

  return (
    <div className={`rounded-lg border ${styles.surface} overflow-hidden`}>
      <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-inherit">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={styles.badge}>{confidenceLabel(group.confidence)}</Badge>
          <span className="text-sm text-gray-600 dark:text-gray-400">{reasonLabel(group)}</span>
        </div>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('duplicateTransactions.transactionCount', { count: group.transactions.length })}
        </span>
      </div>
      <div className={TABLE_BODY_CLASS}>
        {group.transactions.map((tx) => {
          const payee = tx.payeeName || t('duplicateTransactions.unknownPayee');
          return (
            <div
              key={tx.id}
              className={`px-4 py-3 flex items-center gap-3 hover:bg-white/50 dark:hover:bg-gray-800/50 cursor-pointer ${selected.has(tx.id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              onClick={() => onOpen(tx)}
            >
              <input
                type="checkbox"
                checked={selected.has(tx.id)}
                onChange={() => onToggle(tx.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={t('duplicateTransactions.selectRow', {
                  payee,
                  date: formatDate(tx.transactionDate),
                })}
                className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus-visible:ring-blue-500 h-4 w-4 cursor-pointer flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {formatDate(tx.transactionDate)}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                    {payee}
                  </span>
                </div>
                {tx.description && (
                  <div className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    <LinkifiedText text={tx.description} />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <CategoryPill
                    name={categoryLabel(tx)}
                    color={tx.categoryId ? categoryColorMap.get(tx.categoryId) ?? null : null}
                    icon={tx.categoryId ? categoryIconMap.get(tx.categoryId) ?? null : null}
                    density="dense"
                  />
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {tx.accountName || t('duplicateTransactions.unknownAccount')}
                  </span>
                  {tx.status === 'RECONCILED' && (
                    <Badge variant="green">{t('duplicateTransactions.statusReconciled')}</Badge>
                  )}
                  {tx.status === 'CLEARED' && (
                    <Badge variant="blue">{t('duplicateTransactions.statusCleared')}</Badge>
                  )}
                </div>
              </div>
              <div className={`text-sm font-medium ${gainLossColor(tx.amount)}`}>
                {formatCurrency(tx.amount, tx.currencyCode)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
