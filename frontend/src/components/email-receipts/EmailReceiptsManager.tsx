'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { EnvelopeIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { EmailReceiptDetailDialog } from '@/components/email-receipts/EmailReceiptDetailDialog';
import { ParserEditorDialog } from '@/components/email-receipts/ParserEditorDialog';
import { RecognizeWithAiDialog } from '@/components/email-receipts/RecognizeWithAiDialog';
import { ReceiptStateBadge } from '@/components/email-receipts/ReceiptStateBadge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RowActions, type RowAction } from '@/components/ui/row-actions';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useAiConfigured } from '@/hooks/useAiConfigured';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReceiptParserLookups } from '@/hooks/useReceiptParserLookups';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { canRecognizeWithAi, isReceiptActionable, senderDomain } from '@/lib/email-receipts-format';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  EMAIL_RECEIPT_STATUSES,
  type EmailReceiptAiMode,
  type EmailReceiptListItem,
  type EmailReceiptStatus,
} from '@/types/email-receipts';

const logger = createLogger('EmailReceipts');

const FILTERS = ['all', ...EMAIL_RECEIPT_STATUSES] as const;
type ReceiptFilter = (typeof FILTERS)[number];

/** States from which the detail dialog can link the email to a transaction. */
const LINKABLE_STATUSES: readonly EmailReceiptStatus[] = ['ambiguous', 'unmatched', 'no_parser', 'parse_failed'];

/** The list answers one filter; `items === null` is a request that failed. */
interface LoadedList {
  filter: ReceiptFilter;
  items: EmailReceiptListItem[] | null;
}

/** The AI mode of the mailbox, as far as it is known: `none` is a loaded answer of "no mailbox". */
type MailboxAi = { status: 'loading' } | { status: 'failed' } | { status: 'none' } | { status: 'ready'; aiMode: EmailReceiptAiMode };

type Confirmation = { kind: 'ignore' | 'delete'; receipt: EmailReceiptListItem };

interface Notice {
  tone: 'success' | 'error';
  text: string;
  /** A place to go next, such as the parsers list a draft lands in. */
  link?: { href: string; label: string };
}

/**
 * The receipts page body: every stored order-confirmation email with its state
 * and the actions on it.
 *
 * A list belongs to the filter that asked for it (`LoadedList.filter`), so a
 * slow answer for a filter the reader has left is never drawn under the new one
 * and no action can be aimed at a row of the other list. `null` is loading or
 * failed, never an empty list; only a loaded, empty answer says "nothing here".
 * Actions that need the AI are offered only when the mailbox's AI mode is known
 * to be on: an unknown mode (the lookup failed) is not "on".
 */
export function EmailReceiptsManager() {
  const t = useTranslations('emailReceipts.receipts');
  const tc = useTranslations('common');
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const { state: lookups, reload: reloadLookups } = useReceiptParserLookups();

  const [filter, setFilter] = useState<ReceiptFilter>('all');
  const [loaded, setLoaded] = useState<LoadedList | null>(null);
  const [mailboxAi, setMailboxAi] = useState<MailboxAi>({ status: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [parserFor, setParserFor] = useState<EmailReceiptListItem | null>(null);
  const [recognizeFor, setRecognizeFor] = useState<EmailReceiptListItem | null>(null);
  // Whether the assistant in the chat can answer; unknown is not "yes".
  const { configured: assistantReady } = useAiConfigured();

  // Only the newest request may write the list, and a reload after an action
  // asks for the filter the reader is on NOW, not the one the handler saw.
  const latestLoad = useRef(0);
  const currentFilter = useRef<ReceiptFilter>(filter);
  useEffect(() => {
    currentFilter.current = filter;
  }, [filter]);

  const load = useCallback(async (forFilter: ReceiptFilter) => {
    const request = ++latestLoad.current;
    try {
      const items = await emailReceiptsApi.receipts.list(forFilter === 'all' ? undefined : forFilter);
      if (request !== latestLoad.current) return;
      setLoaded({ filter: forFilter, items });
    } catch (error) {
      if (request !== latestLoad.current) return;
      logger.error(error);
      setLoaded({ filter: forFilter, items: null });
    }
  }, []);

  const reload = useCallback(() => load(currentFilter.current), [load]);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.mailbox
      .get()
      .then((mailbox) => {
        if (cancelled) return;
        setMailboxAi(mailbox ? { status: 'ready', aiMode: mailbox.aiMode } : { status: 'none' });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setMailboxAi({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const aiOn = mailboxAi.status === 'ready' && mailboxAi.aiMode !== 'off';

  const categoryLabels = useMemo(
    () =>
      lookups.status === 'ready' ? new Map(lookups.lookups.categories.map((option) => [option.value, option.label])) : null,
    [lookups],
  );

  /** Runs one command on one email: busy while it runs, the list reloaded after it, the failure named. */
  const runCommand = async (receipt: EmailReceiptListItem, work: () => Promise<Notice | null>, failureText: string) => {
    setBusyId(receipt.id);
    setNotice(null);
    try {
      const result = await work();
      if (result) setNotice(result);
      await reload();
    } catch (error) {
      setNotice({ tone: 'error', text: getErrorMessage(error, failureText) });
      logger.error(error);
    } finally {
      setBusyId(null);
    }
  };

  const handleReprocess = (receipt: EmailReceiptListItem) =>
    runCommand(
      receipt,
      async () => {
        await emailReceiptsApi.receipts.reprocess(receipt.id);
        toast.success(t('toasts.reprocessed'));
        return null;
      },
      t('toasts.reprocessFailed'),
    );

  const handleDraftParser = (receipt: EmailReceiptListItem) =>
    runCommand(
      receipt,
      async () => {
        const parser = await emailReceiptsApi.receipts.draftParser(receipt.id);
        return {
          tone: 'success',
          text: t('notices.draftCreated', { name: parser.name }),
          link: { href: '/settings/email-receipts', label: t('notices.draftLink') },
        };
      },
      t('toasts.draftFailed'),
    );

  const handleConfirm = async () => {
    const target = confirmation;
    setConfirmation(null);
    if (!target) return;
    if (target.kind === 'ignore') {
      await runCommand(
        target.receipt,
        async () => {
          await emailReceiptsApi.receipts.ignore(target.receipt.id);
          toast.success(t('toasts.ignored'));
          return null;
        },
        t('toasts.ignoreFailed'),
      );
    } else {
      await runCommand(
        target.receipt,
        async () => {
          await emailReceiptsApi.receipts.remove(target.receipt.id);
          toast.success(t('toasts.deleted'));
          return null;
        },
        t('toasts.deleteFailed'),
      );
    }
  };

  const actionsFor = (receipt: EmailReceiptListItem): RowAction[] => {
    const actionable = isReceiptActionable(receipt);
    const disabled = busyId === receipt.id;
    return [
      {
        key: 'view',
        label: t('actions.view'),
        icon: 'view',
        tone: 'view',
        onClick: () => setDetailId(receipt.id),
        disabled,
      },
      {
        key: 'createParser',
        label: t('actions.createParser'),
        icon: 'edit',
        tone: 'primary',
        onClick: () => setParserFor(receipt),
        hidden: receipt.status !== 'no_parser',
        disabled,
      },
      {
        key: 'link',
        label: t('actions.link'),
        icon: 'transactions',
        tone: 'primary',
        onClick: () => setDetailId(receipt.id),
        // The candidates of an ambiguous email, or the picker of one the matcher
        // could not tie to a transaction.
        hidden: !LINKABLE_STATUSES.includes(receipt.status),
        disabled,
      },
      {
        // Offered whatever the mailbox's AI mode: the mode governs only what
        // happens by itself, and pressing this is the person's own consent.
        key: 'recognizeAi',
        label: t('actions.recognizeAi'),
        icon: 'reconcile',
        tone: 'accent',
        onClick: () => setRecognizeFor(receipt),
        hidden: !canRecognizeWithAi(receipt),
        disabled,
      },
      {
        key: 'draftParser',
        label: t('actions.draftParser'),
        icon: 'duplicate',
        tone: 'accent',
        onClick: () => void handleDraftParser(receipt),
        hidden: !aiOn || receipt.status !== 'no_parser',
        disabled,
      },
      {
        key: 'reprocess',
        label: t('actions.reprocess'),
        icon: 'reopen',
        tone: 'primary',
        onClick: () => void handleReprocess(receipt),
        hidden: !actionable || receipt.status === 'pending',
        disabled,
      },
      {
        key: 'ignore',
        label: t('actions.ignore'),
        icon: 'skip',
        tone: 'warning',
        onClick: () => setConfirmation({ kind: 'ignore', receipt }),
        hidden: !actionable,
        disabled,
      },
      {
        key: 'delete',
        label: tc('delete'),
        icon: 'delete',
        tone: 'delete',
        destructive: true,
        onClick: () => setConfirmation({ kind: 'delete', receipt }),
        disabled,
      },

    ];
  };

  const current = loaded !== null && loaded.filter === filter ? loaded : null;

  let body;
  if (current !== null && current.items === null) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={() => void reload()}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (current === null) {
    body = <LoadingSpinner text={t('loading')} />;
  } else if (current.items === null || current.items.length === 0) {
    const noMailbox = mailboxAi.status === 'none' && filter === 'all';
    body = (
      <EmptyState
        icon={<EnvelopeIcon />}
        title={filter === 'all' ? t('empty.title') : t('empty.filteredTitle')}
        description={noMailbox ? t('empty.noMailboxBody') : filter === 'all' ? t('empty.body') : t('empty.filteredBody')}
        action={
          noMailbox ? (
            <Link href="/settings/email-receipts" className={buttonClassName('primary', 'md')}>
              {t('empty.connectButton')}
            </Link>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th className="px-2 sm:px-4">{t('columns.received')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.email')}</Th>
              <Th className="hidden px-2 sm:table-cell sm:px-4">{t('columns.transaction')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.state')}</Th>
              <Th align="right" className="px-2 sm:px-4">
                {t('columns.actions')}
              </Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {current.items.map((receipt) => {
              const summary = receipt.transaction
                ? t('transactionSummary', {
                    date: formatDate(receipt.transaction.date),
                    amount: formatCurrency(receipt.transaction.amount, receipt.transaction.currencyCode),
                    payee: receipt.transaction.payeeName ?? t('noPayee'),
                  })
                : null;
              return (
                <tr key={receipt.id}>
                  <Td className="px-2 align-top whitespace-nowrap sm:px-4">{formatDateTime(receipt.receivedAt)}</Td>
                  <Td className="min-w-0 px-2 align-top break-words sm:px-4">
                    <div className="font-medium">{receipt.subject}</div>
                    <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{receipt.fromAddress}</div>
                    {summary && (
                      <div className="mt-1 text-xs text-gray-700 dark:text-gray-300 sm:hidden">{summary}</div>
                    )}
                  </Td>
                  <Td className="hidden px-2 align-top sm:table-cell sm:px-4">
                    {receipt.transaction ? (
                      <Link
                        href={`/transactions?targetTransactionId=${receipt.transaction.id}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {summary}
                      </Link>
                    ) : (
                      <span className="text-gray-500 dark:text-gray-400">{t('noTransaction')}</span>
                    )}
                  </Td>
                  <Td className="px-2 align-top sm:px-4">
                    <ReceiptStateBadge receipt={receipt} />
                  </Td>
                  <Td align="right" className="px-2 align-top sm:px-4">
                    <RowActions actions={actionsFor(receipt)} density="normal" maxInline={3} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const confirmCopy = confirmation?.kind === 'delete' ? 'deleteDialog' : 'ignoreDialog';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/ai-reviews" className="text-blue-600 hover:underline dark:text-blue-400">
          {t('links.reviewInbox')}
        </Link>
        <Link href="/settings/email-receipts" className="text-blue-600 hover:underline dark:text-blue-400">
          {t('links.settings')}
        </Link>
      </div>

      <div role="group" aria-label={t('filter.label')} className={`${SEGMENTED_GROUP_CLASS} max-w-full flex-wrap`}>
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            className={segmentClass(filter === option)}
          >
            {t(`filter.${option}`)}
          </button>
        ))}
      </div>

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200'
              : 'rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-200'
          }
        >
          {notice.text}
          {notice.link && (
            <>
              {' '}
              <Link href={notice.link.href} className="font-medium underline">
                {notice.link.label}
              </Link>
            </>
          )}
        </div>
      )}

      <Card className="overflow-hidden">{body}</Card>

      {detailId !== null && (
        <EmailReceiptDetailDialog
          key={detailId}
          receiptId={detailId}
          categoryLabels={categoryLabels}
          onClose={() => setDetailId(null)}
          onChanged={() => void reload()}
        />
      )}

      {parserFor !== null && (
        <ParserEditorDialog
          parser={null}
          prefill={{
            name: parserFor.fromDomain || senderDomain(parserFor.fromAddress),
            fromDomains: parserFor.fromDomain || senderDomain(parserFor.fromAddress),
          }}
          initialReceiptId={parserFor.id}
          lookups={lookups}
          onReloadLookups={reloadLookups}
          onClose={() => setParserFor(null)}
          onSaved={() => {
            setParserFor(null);
            void reload();
          }}
          onConflict={() => setParserFor(null)}
        />
      )}

      {recognizeFor !== null && (
        <RecognizeWithAiDialog
          key={recognizeFor.id}
          receipt={recognizeFor}
          assistantReady={assistantReady}
          onClose={() => setRecognizeFor(null)}
          onChanged={() => void reload()}
        />
      )}

      <ConfirmDialog
        isOpen={confirmation !== null}
        title={t(`${confirmCopy}.title`)}
        message={t(`${confirmCopy}.message`, { subject: confirmation?.receipt.subject ?? '' })}
        confirmLabel={confirmation?.kind === 'delete' ? tc('delete') : t('ignoreDialog.confirm')}
        variant={confirmation?.kind === 'delete' ? 'danger' : 'warning'}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}
