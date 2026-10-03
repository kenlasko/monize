'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TransactionConfirmationCard } from '@/components/ai/TransactionConfirmationCard';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Td } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { ProposalCardState } from '@/hooks/useAiReviewInbox';
import type { PendingAction } from '@/types/ai';
import type { AiReviewItem, AiReviewStatus } from '@/types/ai-review';

/** Requests still open: the person may dismiss them. */
const DISMISSIBLE: readonly AiReviewStatus[] = ['pending', 'claimed', 'proposed'];

const STATUS_VARIANT: Record<AiReviewStatus, BadgeVariant> = {
  pending: 'gray',
  claimed: 'blue',
  proposed: 'purple',
  applied: 'green',
  rejected: 'gray',
  expired: 'amber',
};

/** Phone cells are tighter than the desktop's `px-4`. */
const CELL = 'px-2 py-3 align-top sm:px-4';

export interface AiReviewRowProps {
  item: AiReviewItem;
  card?: ProposalCardState;
  dismissing: boolean;
  onApprove: (item: AiReviewItem, action: Omit<PendingAction, 'status'>) => void;
  onDismiss: (item: AiReviewItem) => void;
}

/**
 * One request: its transaction, the rule's instruction and status, then, when
 * an agent proposed an edit, the ordinary confirmation card on a row of its own
 * (the split display is the card's, not re-implemented here).
 */
export function AiReviewRow({ item, card, dismissing, onApprove, onDismiss }: AiReviewRowProps) {
  const t = useTranslations('aiReview');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const { transaction, proposal } = item;

  const action = proposal && 'action' in proposal ? proposal.action : null;
  const proposalError = proposal && 'error' in proposal ? proposal.error : null;
  const showCard = action !== null && (item.status === 'proposed' || card?.status === 'confirmed');
  const canDismiss = DISMISSIBLE.includes(item.status) && !showCard && proposalError === null;

  return (
    <>
      <tr>
        <Td className={`${CELL} whitespace-nowrap`}>{transaction ? formatDate(transaction.date) : ''}</Td>
        <Td className={`${CELL} min-w-0 break-words`}>
          <div className="font-medium">
            {transaction ? (
              (transaction.payeeName ?? <span className="text-gray-500 dark:text-gray-400">{t('row.noPayee')}</span>)
            ) : (
              <span className="text-gray-500 dark:text-gray-400">{t('row.transactionMissing')}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {item.kind === 'email_receipt' ? (
              <>
                {item.emailReceipt
                  ? t('row.emailReceipt', { subject: item.emailReceipt.subject, sender: item.emailReceipt.fromAddress })
                  : t('row.emailReceiptMissing')}{' '}
                <Link href="/email-receipts" className="text-blue-600 hover:underline dark:text-blue-400">
                  {t('row.viewEmailReceipts')}
                </Link>
              </>
            ) : item.ruleName ? (
              t('row.rule', { name: item.ruleName })
            ) : (
              t('row.manualRequest')
            )}
          </div>
          <p className="mt-1 whitespace-pre-line text-sm text-gray-700 dark:text-gray-300">{item.instruction}</p>
          {item.kind === 'email_receipt' && item.status === 'pending' && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t.rich('row.waitingForAgent', {
                link: (chunks) => (
                  <Link href="/settings/ai" className="text-blue-600 hover:underline dark:text-blue-400">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
          {item.agentNote && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('row.agentNote', { reason: item.agentNote.reason })}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('row.dates', { created: formatDate(new Date(item.createdAt)), expires: formatDate(new Date(item.expiresAt)) })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            {transaction && (
              <Link
                href={`/transactions?targetTransactionId=${item.transactionId}`}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {t('row.viewTransaction')}
              </Link>
            )}
            {canDismiss && (
              <Button variant="outline" size="sm" onClick={() => onDismiss(item)} disabled={dismissing}>
                {t('actions.dismiss')}
              </Button>
            )}
          </div>
        </Td>
        <Td align="right" className={`${CELL} whitespace-nowrap`}>
          {transaction ? formatCurrency(transaction.amount, transaction.currencyCode) : ''}
        </Td>
        <Td className={CELL}>
          <Badge variant={STATUS_VARIANT[item.status]}>{t(`status.${item.status}`)}</Badge>
        </Td>
      </tr>
      {(showCard || proposalError !== null) && (
        <tr>
          <Td colSpan={4} className="px-2 pb-4 pt-0 sm:px-4">
            {showCard && action && (
              <TransactionConfirmationCard
                action={{ ...action, status: card?.status ?? 'pending', errorMessage: card?.errorMessage, resultId: card?.resultId }}
                cancelLabel={t('actions.dismiss')}
                onConfirm={() => onApprove(item, action)}
                onCancel={() => onDismiss(item)}
              />
            )}
            {proposalError !== null && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-900/20">
                <p className="text-sm font-semibold text-red-800 dark:text-red-200">{t('proposal.errorTitle')}</p>
                <p className="mt-1 text-sm text-red-700 dark:text-red-300">{proposalError}</p>
                <div className="mt-2 flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => onDismiss(item)} disabled={dismissing}>
                    {t('actions.dismiss')}
                  </Button>
                </div>
              </div>
            )}
          </Td>
        </tr>
      )}
    </>
  );
}
