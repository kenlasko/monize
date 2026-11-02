'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import type { QuoteTablePreview } from '@/types/investment';

/**
 * The page address the "table on a web page" provider reads, with a button
 * that reads it now and shows what was found -- the columns it recognised,
 * how many days, and the newest rows -- so an address is checked before it
 * is saved. The preview stores nothing.
 */
export function QuoteTableUrlField({
  registration,
  url,
  error,
}: {
  registration: UseFormRegisterReturn;
  url: string;
  error?: string;
}) {
  const t = useTranslations('securities');
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [preview, setPreview] = useState<QuoteTablePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runPreview = async () => {
    setLoading(true);
    setPreview(null);
    setPreviewError(null);
    try {
      setPreview(await investmentsApi.previewQuoteTable(url.trim()));
    } catch (err) {
      setPreviewError(getErrorMessage(err, t('form.quoteTable.previewFailed')));
    } finally {
      setLoading(false);
    }
  };

  const cell = (value: number | null) => (value === null ? '-' : formatNumber(value, 2));
  const columns = preview
    ? Object.values(preview.columns).filter(Boolean).join(', ')
    : '';

  return (
    <div className="space-y-2" data-testid="quote-table-url-field">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label={t('form.quoteTable.urlLabel')}
            type="url"
            inputMode="url"
            placeholder="https://"
            {...registration}
            error={error}
            aria-describedby="quote-table-url-help"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="mb-[1px]"
          onClick={runPreview}
          isLoading={loading}
          disabled={!url.trim() || loading}
        >
          {t('form.quoteTable.test')}
        </Button>
      </div>
      <p id="quote-table-url-help" className="text-sm text-gray-500 dark:text-gray-400">
        {t('form.quoteTable.urlHelp')}
      </p>

      {previewError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {previewError}
        </p>
      )}

      {preview && (
        <div
          className="rounded-md border border-gray-200 dark:border-gray-700 p-3 space-y-2"
          data-testid="quote-table-preview"
        >
          <p className="text-sm text-gray-700 dark:text-gray-200">
            {t('form.quoteTable.summary', {
              count: preview.totalRows,
              first: formatDate(preview.firstDate),
              last: formatDate(preview.lastDate),
            })}
          </p>
          <ul className="text-sm text-gray-500 dark:text-gray-400">
            <li>{t('form.quoteTable.columns', { columns })}</li>
            <li>
              {preview.currencyCode
                ? t('form.quoteTable.currency', { currency: preview.currencyCode })
                : t('form.quoteTable.noCurrency')}
            </li>
            {preview.skippedRows > 0 && (
              <li>{t('form.quoteTable.skipped', { count: preview.skippedRows })}</li>
            )}
          </ul>
          <div className="max-h-64 overflow-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th>{t('form.quoteTable.headers.date')}</Th>
                  <Th align="right">{t('form.quoteTable.headers.open')}</Th>
                  <Th align="right">{t('form.quoteTable.headers.high')}</Th>
                  <Th align="right">{t('form.quoteTable.headers.low')}</Th>
                  <Th align="right">{t('form.quoteTable.headers.close')}</Th>
                  <Th align="right">{t('form.quoteTable.headers.volume')}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {preview.rows.map((row) => (
                  <tr key={row.date}>
                    <Td className="whitespace-nowrap">{formatDate(row.date)}</Td>
                    <Td align="right">{cell(row.open)}</Td>
                    <Td align="right">{cell(row.high)}</Td>
                    <Td align="right">{cell(row.low)}</Td>
                    <Td align="right" className="font-medium">{cell(row.close)}</Td>
                    <Td align="right">
                      {row.volume === null ? '-' : formatNumber(row.volume, 0)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
