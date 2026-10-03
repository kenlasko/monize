'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS, TABLE_CLASS, Th, Td } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import type { ParsedReceipt } from '@/types/email-receipts';

interface ParsedReceiptViewProps {
  parsed: ParsedReceipt;
  /** The currency the amounts are shown in; the reader's own when the receipt names none. */
  currencyCode?: string;
  /**
   * Category id to its full label; an id that is not in it is shown as unknown.
   * `null` while the category list has not loaded (or failed): the column then
   * says so instead of calling every category unknown.
   */
  categoryLabels: ReadonlyMap<string, string> | null;
}

/**
 * What a parser read from one email: the order id, the stated totals and the
 * line items with their categories, and whether the read is complete.
 *
 * Amounts arrive in 1/10000 units and are converted exactly once
 * (`fromReceiptUnits`) before `formatCurrency`. A figure the email did not
 * state is `null` and renders as "not found", never as a zero that would read
 * as a stated free shipping.
 */
export function ParsedReceiptView({ parsed, currencyCode, categoryLabels }: ParsedReceiptViewProps) {
  const t = useTranslations('emailReceipts.parsed');
  const { formatCurrency } = useNumberFormat();

  const money = (units: number | null) =>
    units === null ? (
      <span className="text-gray-500 dark:text-gray-400">{t('notFound')}</span>
    ) : (
      formatCurrency(fromReceiptUnits(units), currencyCode)
    );

  const category = (id: string | null) => {
    if (id === null) return t('noCategory');
    if (categoryLabels === null) return t('categoryUnavailable');
    return categoryLabels.get(id) ?? t('unknownCategory');
  };

  const figures: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'orderId',
      label: t('orderId'),
      value: parsed.orderId ?? <span className="text-gray-500 dark:text-gray-400">{t('notFound')}</span>,
    },
    { key: 'total', label: t('total'), value: money(parsed.total) },
    { key: 'shipping', label: t('shipping'), value: money(parsed.shipping) },
    { key: 'discount', label: t('discount'), value: money(parsed.discount) },
  ];

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        {figures.map((figure) => (
          <div key={figure.key}>
            <dt className="text-gray-500 dark:text-gray-400">{figure.label}</dt>
            <dd className="font-medium text-gray-900 dark:text-gray-100">{figure.value}</dd>
          </div>
        ))}
      </dl>

      {parsed.items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('noItems')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <Th className="px-2 sm:px-4">{t('columns.item')}</Th>
                <Th align="right" className="px-2 sm:px-4">
                  {t('columns.qty')}
                </Th>
                <Th align="right" className="px-2 sm:px-4">
                  {t('columns.amount')}
                </Th>
                <Th className="px-2 sm:px-4">{t('columns.category')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {parsed.items.map((item, index) => (
                <tr key={`${index}-${item.name}`}>
                  <Td className="px-2 sm:px-4 break-words">{item.name}</Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {item.qty}
                  </Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {money(item.amount)}
                  </Td>
                  <Td className="px-2 sm:px-4">{category(item.categoryId)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={parsed.complete ? 'green' : 'amber'}>
          {parsed.complete ? t('complete') : t('incomplete')}
        </Badge>
        {!parsed.complete && parsed.reason && (
          <span className="text-gray-700 dark:text-gray-300">{t(`reasons.${parsed.reason}`)}</span>
        )}
        {parsed.source === 'ai' && <Badge variant="blue">{t('readByAi')}</Badge>}
      </div>
    </div>
  );
}
