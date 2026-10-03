'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDateFormat } from '@/hooks/useDateFormat';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import type { EmailReceiptMailbox, EmailReceiptPollResult } from '@/types/email-receipts';

interface MailboxStatusProps {
  mailbox: EmailReceiptMailbox;
  /** Called with the refreshed mailbox after a poll, so the status line follows it. */
  onRefreshed: (mailbox: EmailReceiptMailbox) => void;
  onDeleted: () => void;
}

/**
 * What the last poll did, and the two actions on the mailbox itself: poll now
 * and delete. Shared by both login methods, because neither changes what a
 * poll reports or what deleting the mailbox removes.
 *
 * A date that is `null` is "never", not a blank: a mailbox that has not been
 * polled yet and one whose polls fail look different here.
 */
export function MailboxStatus({ mailbox, onRefreshed, onDeleted }: MailboxStatusProps) {
  const t = useTranslations('emailReceipts.mailbox.status');
  const tc = useTranslations('common');
  const { formatDateTime } = useDateFormat();

  const [isPolling, setIsPolling] = useState(false);
  const [pollResult, setPollResult] = useState<EmailReceiptPollResult | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handlePoll = async () => {
    setIsPolling(true);
    setPollResult(null);
    setPollError(null);
    try {
      const result = await emailReceiptsApi.mailbox.pollNow();
      setPollResult(result);
      try {
        const refreshed = await emailReceiptsApi.mailbox.get();
        if (refreshed) onRefreshed(refreshed);
      } catch {
        // The poll itself answered; a status line that could not refresh is not
        // worth replacing its result with an error.
      }
    } catch (error) {
      setPollError(getErrorMessage(error, t('pollFailed')));
    } finally {
      setIsPolling(false);
    }
  };

  const handleDelete = async () => {
    setConfirmDelete(false);
    setIsDeleting(true);
    try {
      await emailReceiptsApi.mailbox.remove();
      toast.success(t('deleted'));
      onDeleted();
    } catch (error) {
      toast.error(getErrorMessage(error, t('deleteFailed')));
    } finally {
      setIsDeleting(false);
    }
  };

  const never = t('never');
  const pollProblem = pollResult && !pollResult.ok ? (pollResult.error ?? t('pollFailed')) : null;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t('lastPolled')}</dt>
          <dd className="text-gray-900 dark:text-gray-100">
            {mailbox.lastPolledAt ? formatDateTime(mailbox.lastPolledAt) : never}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t('lastSuccess')}</dt>
          <dd className="text-gray-900 dark:text-gray-100">
            {mailbox.lastSuccessAt ? formatDateTime(mailbox.lastSuccessAt) : never}
          </dd>
        </div>
      </dl>

      {mailbox.lastError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {mailbox.lastErrorAt
            ? t('lastErrorAt', { error: mailbox.lastError, at: formatDateTime(mailbox.lastErrorAt) })
            : t('lastError', { error: mailbox.lastError })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" isLoading={isPolling} disabled={isDeleting} onClick={() => void handlePoll()}>
          {t('pollNow')}
        </Button>
        <Button variant="outline" disabled={isPolling || isDeleting} onClick={() => setConfirmDelete(true)}>
          {t('deleteButton')}
        </Button>
      </div>

      {pollResult && pollResult.ok && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {t('pollResult', {
            fetched: pollResult.fetched,
            skipped: pollResult.skipped,
            processed: pollResult.processed,
          })}
        </p>
      )}
      {(pollProblem || pollError) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {pollProblem ?? pollError}
        </p>
      )}

      <ConfirmDialog
        isOpen={confirmDelete}
        title={t('deleteDialog.title')}
        message={t('deleteDialog.message')}
        confirmLabel={tc('delete')}
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
