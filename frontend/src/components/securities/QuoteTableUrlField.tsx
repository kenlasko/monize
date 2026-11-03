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
  // Each answer is kept with the address it was asked for and shown only while
  // the field still holds that address: an edit hides it, and an answer that
  // arrives after the edit is never shown as if it were about the new one.
  const [checked, setChecked] = useState<{
    url: string;
    preview: QuoteTablePreview | null;
    error: string | null;
  } | null>(null);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const current = url.trim();
  const shown = checked !== null && checked.url === current ? checked : null;
  const preview = shown?.preview ?? null;
  const previewError = shown?.error ?? null;
  const loading = loadingUrl !== null && loadingUrl === current;

  const runPreview = async () => {
    const asked = current;
    setLoadingUrl(asked);
    try {
      const result = await investmentsApi.previewQuoteTable(asked);
      setChecked({ url: asked, preview: result, error: null });
    } catch (err) {
      setChecked({
        url: asked,
        preview: null,
        error: getErrorMessage(err, t('form.quoteTable.previewFailed')),
      });
    } finally {
      setLoadingUrl((now) => (now === asked ? null : now));
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
          disabled={!current || loading}
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
