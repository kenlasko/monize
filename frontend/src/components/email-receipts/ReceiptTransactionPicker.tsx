'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { shiftDate } from '@/lib/calendar-month';
import { createLogger } from '@/lib/logger';
import { transactionsApi } from '@/lib/transactions';
import type { Transaction } from '@/types/transaction';

const logger = createLogger('ReceiptTransactionPicker');

/** The matcher's own window around the day the email arrived (`match-receipt.ts`). */
export const RECEIPT_PICK_DAYS_BEFORE = 3;
export const RECEIPT_PICK_DAYS_AFTER = 14;
/** One bounded page; a longer list is narrowed with the search box, not paged. */
export const RECEIPT_PICK_PAGE_SIZE = 50;

/** What one request asked for, and what it answered: `rows === null` is a request that failed. */
interface Answer {
  key: string;
  rows: Transaction[] | null;
  hasMore: boolean;
}

interface ReceiptTransactionPickerProps {
  /** The email's `receivedAt` (an ISO timestamp); its UTC day is the matcher's `receivedDate`. */
  receivedAt: string;
  /** The transaction being linked right now, if any; every Link button waits while one is. */
  linkingId: string | null;
  onLink: (transactionId: string) => void;
  /**
   * `link` (the default) is the detail dialog's "choose the transaction this
   * email paid for". `ai` is "Recognize with AI": the same list, the same
   * exclusions, but the choice is handed to the AI rather than stored as a
   * link, and the copy says so.
   */
  mode?: 'link' | 'ai';
}

/**
 * "Choose transaction": the user's transactions in the window the matcher
 * searches (3 days before the email to 14 after), for an email the matcher could
 * not tie to one. Optional text search narrows the page.
 *
 * The list belongs to the request that produced it (`Answer.key`): a slow answer
 * for an earlier search is never drawn under a newer one, and while the new one
 * loads the old rows are not offered. A transfer or a voided transaction is not
 * offered at all, since the server refuses to link either; a failed read is an
 * error, never "no transactions".
 *
 * The window is calendar arithmetic on the `YYYY-MM-DD` day (`shiftDate`), never
 * a `Date` built from it.
 */
export function ReceiptTransactionPicker({ receivedAt, linkingId, onLink, mode = 'link' }: ReceiptTransactionPickerProps) {
  const t = useTranslations('emailReceipts.picker');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  const receivedDate = receivedAt.slice(0, 10);
  const from = shiftDate(receivedDate, -RECEIPT_PICK_DAYS_BEFORE);
  const to = shiftDate(receivedDate, RECEIPT_PICK_DAYS_AFTER);

  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Bumped by the retry button; each value is one request.
  const [attempt, setAttempt] = useState(0);

  const key = `${from}|${to}|${search}|${attempt}`;

  useEffect(() => {
    let cancelled = false;
    transactionsApi
      .getAll({
        startDate: from,
        endDate: to,
        limit: RECEIPT_PICK_PAGE_SIZE,
        ...(search !== '' ? { search } : {}),
      })
      .then((page) => {
        if (!cancelled) setAnswer({ key, rows: page.data, hasMore: page.pagination.hasMore });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setAnswer({ key, rows: null, hasMore: false });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, search, key]);

  const current = answer !== null && answer.key === key ? answer : null;
  const linkable = useMemo(
    () => (current?.rows ?? []).filter((row) => !row.isTransfer && !row.isVoid),
    [current],
  );

  return (
    <section aria-labelledby="receipt-picker-heading" className="space-y-2">
      <h3 id="receipt-picker-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t(mode === 'ai' ? 'ai.heading' : 'heading')}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t(mode === 'ai' ? 'ai.help' : 'help', { from: formatDate(from), to: formatDate(to) })}
      </p>

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(draft.trim());
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            id="receipt-picker-search"
            label={t('searchLabel')}
            value={draft}
            maxLength={200}
            autoComplete="off"
            placeholder={t('searchPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline">
          {t('searchButton')}
        </Button>
      </form>

      {current === null ? (
        <LoadingSpinner text={t('loading')} />
      ) : current.rows === null ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">{t('error')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('retry')}
          </Button>
        </div>
      ) : linkable.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{search === '' ? t('empty') : t('emptySearch')}</p>
      ) : (
        <>
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            {linkable.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {t('row', {
                      date: formatDate(row.transactionDate),
                      amount: formatCurrency(Number(row.amount), row.currencyCode),
                      payee: row.payeeName ?? t('noPayee'),
                    })}
                  </div>
                  {row.description && (
                    <div className="break-words text-gray-500 dark:text-gray-400">
                      <LinkifiedText text={row.description} />
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  isLoading={linkingId === row.id}
                  disabled={linkingId !== null}
                  onClick={() => onLink(row.id)}
                >
                  {t(mode === 'ai' ? 'ai.linkButton' : 'linkButton')}
                </Button>
              </li>
            ))}
          </ul>
          {current.hasMore && <p className="text-xs text-gray-500 dark:text-gray-400">{t('hasMore', { count: RECEIPT_PICK_PAGE_SIZE })}</p>}
        </>
      )}
    </section>
  );
}
