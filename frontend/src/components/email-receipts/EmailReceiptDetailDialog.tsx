'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ParsedReceiptView } from '@/components/email-receipts/ParsedReceiptView';
import { ReceiptTransactionPicker } from '@/components/email-receipts/ReceiptTransactionPicker';
import { ReceiptStateBadge } from '@/components/email-receipts/ReceiptStateBadge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { isReceiptActionable, readParsedReceipt } from '@/lib/email-receipts-format';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptDetail, EmailReceiptStatus } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptDetail');

/** States in which the email has no transaction and no candidates to choose from. */
const PICKABLE_STATUSES: readonly EmailReceiptStatus[] = ['unmatched', 'no_parser', 'parse_failed'];

interface EmailReceiptDetailDialogProps {
  receiptId: string;
  /** Category id to label; `null` while the category list has not loaded. */
  categoryLabels: ReadonlyMap<string, string> | null;
  onClose: () => void;
  /** A change was written (a link): the list behind the dialog reloads. */
  onChanged: () => void;
}

type DetailState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: EmailReceiptDetail };

/**
 * One stored email: who sent it, what state it is in and why, what the parser
 * read from it, and, when several transactions fit, which one to link it to.
 *
 * The email's text is plain text in a `<pre>` (the server stores it already
 * converted from HTML), never markup: an email is hostile input. Mount it only
 * while open and key it on the receipt, so its state starts fresh for each one.
 */
export function EmailReceiptDetailDialog({ receiptId, categoryLabels, onClose, onChanged }: EmailReceiptDetailDialogProps) {
  const t = useTranslations('emailReceipts.detail');
  const tState = useTranslations('emailReceipts.state');
  const tc = useTranslations('common');
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  // Bumped by the retry button; each value is one request.
  const [attempt, setAttempt] = useState(0);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .get(receiptId)
      .then((detail) => {
        if (!cancelled) setState({ status: 'ready', detail });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [receiptId, attempt]);

  const handleLink = async (transactionId: string) => {
    setLinkingId(transactionId);
    setLinkError(null);
    try {
      const detail = await emailReceiptsApi.receipts.link(receiptId, transactionId);
      setState({ status: 'ready', detail });
      toast.success(t('linked'));
      onChanged();
    } catch (error) {
      setLinkError(getErrorMessage(error, t('linkFailed')));
    } finally {
      setLinkingId(null);
    }
  };

  let body;
  if (state.status === 'error') {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={
            <Button
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {t('error.retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (state.status === 'loading') {
    body = <LoadingSpinner text={t('loading')} />;
  } else {
    const { detail } = state;
    const parsed = readParsedReceipt(detail.parsed);
    const canLink = detail.candidates.length > 0 && isReceiptActionable(detail);
    // An email the matcher could not tie to a transaction can be tied by hand.
    const canPick = PICKABLE_STATUSES.includes(detail.status) && isReceiptActionable(detail);
    const reasonKey = detail.statusReason ? `reasons.${detail.statusReason}` : null;

    body = (
      <div className="space-y-6">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{t('from')}</dt>
            <dd className="break-words text-gray-900 dark:text-gray-100">{detail.fromAddress}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{t('received')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{formatDateTime(detail.receivedAt)}</dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-gray-500 dark:text-gray-400">{t('subject')}</dt>
            <dd className="break-words text-gray-900 dark:text-gray-100">{detail.subject}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('state')}</dt>
            <dd>
              <ReceiptStateBadge receipt={detail} />
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('parser')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{detail.parserName ?? t('noParser')}</dd>
          </div>
          {detail.matchKind && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t('matchedBy')}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{t(`matchKinds.${detail.matchKind}`)}</dd>
            </div>
          )}
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{t('transaction')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {detail.transaction ? (
                <>
                  {t('transactionSummary', {
                    date: formatDate(detail.transaction.date),
                    amount: formatCurrency(detail.transaction.amount, detail.transaction.currencyCode),
                    payee: detail.transaction.payeeName ?? t('noPayee'),
                  })}{' '}
                  <Link
                    href={`/transactions?targetTransactionId=${detail.transaction.id}`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {t('viewTransaction')}
                  </Link>
                </>
              ) : (
                <span className="text-gray-500 dark:text-gray-400">{t('noTransaction')}</span>
              )}
            </dd>
          </div>
        </dl>

        {(detail.statusReason || detail.requestNote) && (
          <div className="space-y-1 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            {detail.statusReason && (
              <p className="text-gray-700 dark:text-gray-300">
                {reasonKey && t.has(reasonKey) ? t(reasonKey) : t('reasonUnknown', { reason: detail.statusReason })}
              </p>
            )}
            {detail.requestNote && (
              <p className="text-gray-700 dark:text-gray-300">
                {t('requestNote', { state: tState(detail.displayState ?? 'request_missing'), note: detail.requestNote })}
              </p>
            )}
          </div>
        )}

        <section aria-labelledby="receipt-parsed-heading" className="space-y-2">
          <h3 id="receipt-parsed-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('parsedHeading')}
          </h3>
          {parsed ? (
            <ParsedReceiptView parsed={parsed} categoryLabels={categoryLabels} />
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('notParsed')}</p>
          )}
        </section>

        {detail.candidates.length > 0 && (
          <section aria-labelledby="receipt-candidates-heading" className="space-y-2">
            <h3 id="receipt-candidates-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('candidatesHeading')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('candidatesHelp')}</p>
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {detail.candidates.map((candidate) => (
                <li key={candidate.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {t('transactionSummary', {
                        date: formatDate(candidate.date),
                        amount: formatCurrency(candidate.amount, candidate.currencyCode),
                        payee: candidate.payeeName ?? t('noPayee'),
                      })}
                    </div>
                    {candidate.description && (
                      <div className="break-words text-gray-500 dark:text-gray-400">
                        <LinkifiedText text={candidate.description} />
                      </div>
                    )}
                  </div>
                  {canLink && (
                    <Button
                      variant="outline"
                      size="sm"
                      isLoading={linkingId === candidate.id}
                      disabled={linkingId !== null}
                      onClick={() => void handleLink(candidate.id)}
                    >
                      {t('linkButton')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {canPick && (
          <ReceiptTransactionPicker receivedAt={detail.receivedAt} linkingId={linkingId} onLink={(id) => void handleLink(id)} />
        )}

        {linkError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {linkError}
          </p>
        )}

        <section aria-labelledby="receipt-text-heading" className="space-y-2">
          <h3 id="receipt-text-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('textHeading')}
          </h3>
          {detail.bodyText === '' ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('noText')}</p>
          ) : (
            <pre
              tabIndex={0}
              aria-label={t('textLabel')}
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            >
              {detail.bodyText}
            </pre>
          )}
        </section>

        <div className="flex justify-end border-t border-gray-200 pt-4 dark:border-gray-700">
          <Button variant="outline" onClick={onClose}>
            {tc('close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Modal isOpen onClose={onClose} maxWidth="3xl" padding="md" pushHistory title={t('title')}>
      {body}
    </Modal>
  );
}
