'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { MnyPreviewBill } from '@/lib/import-mny';
import { Th } from '@/components/ui/Table';
import { BinaryImportFormat, MNY_FORMAT } from '@/lib/binary-import-format';

interface MnyBillsPanelProps {
  bills: MnyPreviewBill[];
  /** Handles the user has ticked. Only these are imported. */
  selectedHandles: ReadonlySet<number>;
  /** True when this Money version has no `BILL` table at all (Money 2001). */
  unsupported: boolean;
  /** Series the mapper could not use -- not the ones detected as inactive. */
  skipped: number;
  onToggleBill: (handle: number) => void;
  onSetAllBills: (include: boolean) => void;
  /** Which file format this is; Money when omitted. */
  format?: BinaryImportFormat;
}

/**
 * The bills the import will create, as a checkbox list.
 *
 * This panel is the safety net for active-series detection being imperfect.
 * Money's `BILL` table accumulates an instance row per occurrence -- the
 * maintainer's file has 1,844 rows for roughly 20 real bills -- and PR #192
 * imported every one of them, then bulk-deactivated the rest. Here the mapper
 * offers only the series it detected as live, and anything the user unticks is
 * never created at all rather than created inactive.
 */
export function MnyBillsPanel({
  bills,
  selectedHandles,
  unsupported,
  skipped,
  onToggleBill,
  onSetAllBills,
  format = MNY_FORMAT,
}: MnyBillsPanelProps) {
  const t = useTranslations('import');
  const ts = useTranslations('scheduledTransactions');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  if (unsupported) {
    return (
      <div className="mb-6 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
        <p className="text-sm text-blue-700 dark:text-blue-300">
          {t('mnyBills.unsupported')}
        </p>
      </div>
    );
  }

  if (bills.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground">
          {t(format.copy.billsHeading, { count: bills.length })}
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onSetAllBills(true)}
            className="text-xs text-primary hover:underline"
          >
            {t('mnyReview.selectAll')}
          </button>
          <button
            type="button"
            onClick={() => onSetAllBills(false)}
            className="text-xs text-primary hover:underline"
          >
            {t('mnyReview.selectNone')}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-2">
        {t(format.copy.billsExplainer)}
      </p>

      <div className="bg-card border border-border rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <Th className="px-3 py-2">
                {t('mnyBills.table.include')}
              </Th>
              <Th className="px-3 py-2">
                {t('mnyBills.table.bill')}
              </Th>
              <Th className="px-3 py-2">
                {t('mnyBills.table.account')}
              </Th>
              <Th className="px-3 py-2">
                {t('mnyBills.table.frequency')}
              </Th>
              <Th className="px-3 py-2">
                {t('mnyBills.table.nextDue')}
              </Th>
              <Th align="right" className="px-3 py-2">
                {t('mnyBills.table.amount')}
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {bills.map((bill) => {
              const included = selectedHandles.has(bill.handle);

              return (
                <tr key={bill.handle} className={included ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => onToggleBill(bill.handle)}
                      aria-label={t('mnyBills.table.includeBill', {
                        name: bill.name,
                      })}
                      className="rounded border-border"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">
                      {bill.name}
                    </span>
                    {bill.isTransfer && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 rounded">
                        {t('mnyBills.table.transfer')}
                      </span>
                    )}
                    {bill.isInvestment && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 rounded">
                        {t('mnyBills.table.investment')}
                      </span>
                    )}
                    {bill.splitCount > 0 && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 rounded">
                        {t('mnyBills.table.splits', { count: bill.splitCount })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {bill.accountName}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {ts(`frequency.${bill.frequency}`)}
                    {bill.approximate && (
                      <span className="block text-xs text-amber-700 dark:text-amber-400">
                        {t('mnyBills.table.approximate')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDate(bill.nextDueDate)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-foreground">
                    {formatCurrency(bill.amount, bill.currencyCode)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {skipped > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t(format.copy.billsSkipped, { count: skipped })}
        </p>
      )}
    </div>
  );
}
