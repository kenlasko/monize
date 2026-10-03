'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ReceiptTransactionPicker } from '@/components/email-receipts/ReceiptTransactionPicker';
import { Button } from '@/components/ui/Button';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { stageChatHandoff } from '@/lib/ai-chat-handoff';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { buildReceiptAttachment } from '@/lib/email-receipt-chat';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptCandidateSummary, EmailReceiptListItem } from '@/types/email-receipts';

const logger = createLogger('RecognizeWithAi');

type Step = 'confirm' | 'candidates' | 'pick';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; transactionId?: string }
  | { kind: 'error'; message: string }
  /** The request waits in the review inbox; `handoffFailed` says the chat could have answered it but was not opened. */
  | { kind: 'queued'; handoffFailed: boolean };

type Candidates = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: EmailReceiptCandidateSummary[] };

interface RecognizeWithAiDialogProps {
  receipt: EmailReceiptListItem;
  /** An AI provider can answer in the chat (`useAiConfigured`); otherwise the request just waits in the inbox. */
  assistantReady: boolean;
  onClose: () => void;
  /** The request was queued (the email is now in review): the list behind the dialog reloads. */
  onChanged: () => void;
}

/**
 * "Recognize with AI" for one email: choose (or confirm) the transaction the
 * email paid for, queue an AI review request for it, then hand the email to the
 * assistant in the chat.
 *
 * The hand-off is STAGED, never sent: the chat opens with the order email as a
 * text attachment and the message already typed in the composer, and the user
 * reads it and presses Send (INV-SHARE-002's contract: nothing is asked of the
 * assistant on arrival). With no provider that can answer, the request just waits
 * in the AI review inbox for an agent, and the dialog says so.
 *
 * An email with a transaction asks for confirmation first (with a way to choose
 * another); an ambiguous one lists its candidates before the full picker; any
 * other opens the picker. The server refuses a transfer, a void or an investment
 * row, and the error is shown here.
 */
export function RecognizeWithAiDialog({ receipt, assistantReady, onClose, onChanged }: RecognizeWithAiDialogProps) {
  const t = useTranslations('emailReceipts.recognize');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  const needsCandidates = receipt.transaction === null && receipt.status === 'ambiguous';
  const [step, setStep] = useState<Step>(receipt.transaction ? 'confirm' : needsCandidates ? 'candidates' : 'pick');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [candidates, setCandidates] = useState<Candidates>({ status: 'loading' });
  // Bumped by the retry button; each value is one request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!needsCandidates) return;
    let cancelled = false;
    emailReceiptsApi.receipts
      .get(receipt.id)
      .then((detail) => {
        if (!cancelled) setCandidates({ status: 'ready', items: detail.candidates });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setCandidates({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [needsCandidates, receipt.id, attempt]);

  const summary = (tx: { date: string; amount: number; currencyCode: string; payeeName: string | null }) =>
    t('transactionSummary', {
      date: formatDate(tx.date),
      amount: formatCurrency(tx.amount, tx.currencyCode),
      payee: tx.payeeName ?? t('noPayee'),
    });

  const running = phase.kind === 'running';

  const run = async (transactionId?: string) => {
    setPhase({ kind: 'running', transactionId });
    let requestId: string;
    try {
      requestId = (await emailReceiptsApi.receipts.askAi(receipt.id, transactionId)).requestId;
    } catch (error) {
      logger.error(error);
      setPhase({ kind: 'error', message: getErrorMessage(error, t('failed')) });
      return;
    }
    // The email is in review now, whatever happens to the hand-off.
    onChanged();
    if (!assistantReady) {
      setPhase({ kind: 'queued', handoffFailed: false });
      return;
    }
    try {
      const detail = await emailReceiptsApi.receipts.get(receipt.id);
      if (detail.transaction === null) throw new Error('The email has no transaction after the request was queued');
      const id = stageChatHandoff({
        files: [buildReceiptAttachment(detail)],
        draft: t('chatPrompt', {
          date: formatDate(detail.transaction.date),
          payee: detail.transaction.payeeName ?? t('noPayee'),
          amount: formatCurrency(detail.transaction.amount, detail.transaction.currencyCode),
          requestId,
        }),
      });
      toast.success(t('opened'));
      router.push(`/ai?handoff=${id}`);
      onClose();
    } catch (error) {
      logger.error(error);
      setPhase({ kind: 'queued', handoffFailed: true });
    }
  };

  let body;
  if (phase.kind === 'queued') {
    body = (
      <div className="space-y-4">
        <p role="status" className="text-sm text-gray-700 dark:text-gray-300">
          {phase.handoffFailed ? t('handoffFailed') : t('queued')}{' '}
          <Link href="/ai-reviews" className="font-medium text-blue-600 underline dark:text-blue-400">
            {t('inboxLink')}
          </Link>
        </p>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {tc('close')}
          </Button>
        </div>
      </div>
    );
  } else {
    let content;
    if (step === 'confirm' && receipt.transaction) {
      content = (
        <div className="space-y-4">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('confirmMessage', { summary: summary(receipt.transaction) })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={running} onClick={() => setStep('pick')}>
              {t('chooseOther')}
            </Button>
            <Button isLoading={running} disabled={running} onClick={() => void run()}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      );
    } else if (step === 'candidates') {
      content = (
        <section aria-labelledby="recognize-candidates-heading" className="space-y-2">
          <h3 id="recognize-candidates-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('candidatesHeading')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('candidatesHelp')}</p>
          {candidates.status === 'loading' ? (
            <LoadingSpinner text={t('candidatesLoading')} />
          ) : candidates.status === 'error' ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-red-600 dark:text-red-400">{t('candidatesError')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCandidates({ status: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                {t('retry')}
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {candidates.items.map((candidate) => (
                <li key={candidate.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{summary(candidate)}</div>
                    {candidate.description && (
                      <div className="break-words text-gray-500 dark:text-gray-400">
                        <LinkifiedText text={candidate.description} />
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    isLoading={phase.kind === 'running' && phase.transactionId === candidate.id}
                    disabled={running}
                    onClick={() => void run(candidate.id)}
                  >
                    {t('useButton')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={running} onClick={() => setStep('pick')}>
              {t('searchOther')}
            </Button>
          </div>
        </section>
      );
    } else {
      content = (
        <div className="space-y-3">
          <ReceiptTransactionPicker
            mode="ai"
            receivedAt={receipt.receivedAt}
            linkingId={phase.kind === 'running' ? (phase.transactionId ?? null) : null}
            onLink={(transactionId) => void run(transactionId)}
          />
          {(receipt.transaction || needsCandidates) && (
            <div className="flex justify-start">
              <Button
                variant="outline"
                size="sm"
                disabled={running}
                onClick={() => setStep(receipt.transaction ? 'confirm' : 'candidates')}
              >
                {t('back')}
              </Button>
            </div>
          )}
        </div>
      );
    }
    body = (
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">{receipt.subject}</p>
        {content}
        {phase.kind === 'error' && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {phase.message}
          </p>
        )}
        <div className="flex justify-end border-t border-gray-200 pt-4 dark:border-gray-700">
          <Button variant="outline" disabled={running} onClick={onClose}>
            {tc('cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Modal isOpen onClose={onClose} maxWidth="2xl" padding="md" pushHistory title={t('title')}>
      {body}
    </Modal>
  );
}
