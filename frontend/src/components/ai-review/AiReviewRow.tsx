'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TransactionConfirmationCard } from '@/components/ai/TransactionConfirmationCard';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CellLabel, Td } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import type { ProposalCardState } from '@/hooks/useAiReviewInbox';
import type { PendingAction } from '@/types/ai';
import { draftParserIds, isApprovable, isSendableToAssistant, reviewItemLabel, type AiReviewItem, type AiReviewStatus } from '@/types/ai-review';

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

export interface AiReviewRowProps {
  item: AiReviewItem;
  card?: ProposalCardState;
  dismissing: boolean;
  /** Whether the list offers a selection (a column of checkboxes); a row that can be neither approved nor sent gets an empty cell. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: (item: AiReviewItem) => void;
  onApprove: (item: AiReviewItem, action: Omit<PendingAction, 'status'>) => void;
  onDismiss: (item: AiReviewItem) => void;
  /** The list's row density: the cell inset comes from `useTableDensity`. */
  density?: DensityLevel;
  /**
   * Render the request as one card cell instead of the date, request, amount and status cells. The inbox sets it on a
   * phone at Normal density only (Model B); the card carries the same four values, and the confirmation card below it
   * spans the card's columns.
   */
  wrapped?: boolean;
}

/**
 * One request: its transaction, the rule's instruction and status, then, when
 * an agent proposed an edit, the ordinary confirmation card on a row of its own
 * (the split display is the card's, not re-implemented here).
 *
 * A request of kind `email_parser_draft` is about emails, not a transaction: it
 * says how many emails and which sender, waits for an agent while `pending`, and
 * once `proposed` (an agent saved a DRAFT parser) points to the parser settings
 * where the draft is tested and approved. There is no card: approving the parser
 * there marks this request applied.
 */
export function AiReviewRow({
  item,
  card,
  dismissing,
  selectable = false,
  selected = false,
  onToggleSelected,
  onApprove,
  onDismiss,
  density = 'normal',
  wrapped = false,
}: AiReviewRowProps) {
  const t = useTranslations('aiReview');
  const { cellPadding } = useTableDensity(density);
  const cell = `${cellPadding} align-top`;
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber, formatShareQuantity } = useNumberFormat();
  const { transaction, proposal, parserDraft, trade } = item;
  const draftIds = parserDraft ? draftParserIds(parserDraft) : [];

  const action = proposal && 'action' in proposal ? proposal.action : null;
  const proposalError = proposal && 'error' in proposal ? proposal.error : null;
  const showCard = action !== null && (item.status === 'proposed' || card?.status === 'confirmed');
  const rowName = reviewItemLabel(item) ?? t('row.noPayee');
  const canDismiss = DISMISSIBLE.includes(item.status) && !showCard && proposalError === null;
  // A trade request an agent has not answered yet holds no trade and no
  // transaction: it is about an email, not a missing transaction.
  const tradeRequest = item.kind === 'email_trade';
  const tradeCurrency = action?.preview.securityCurrency ?? trade?.currency ?? null;

  const dateText = transaction
    ? formatDate(transaction.date)
    : trade
      ? formatDate(trade.date)
      : parserDraft || tradeRequest
        ? formatDate(new Date(item.createdAt))
        : '';
  const amountText = transaction
    ? formatCurrency(transaction.amount, transaction.currencyCode)
    : trade
      ? tradeCurrency
        ? formatCurrency(trade.totalAmount, tradeCurrency)
        : formatNumber(trade.totalAmount, 2)
      : '';
  const statusBadge = <Badge variant={STATUS_VARIANT[item.status]}>{t(`status.${item.status}`)}</Badge>;
  const requestContent = (
    <>
      <div className="font-medium">
        {parserDraft ? (
          t('row.parserDraft', { count: parserDraft.emailCount, domain: parserDraft.domain })
        ) : trade ? (
          t('row.trade', {
            action: trade.action,
            // A cash dividend may state no shares; its sentence names none.
            ...(trade.quantity !== null ? { quantity: formatShareQuantity(trade.quantity) } : {}),
            symbol: trade.symbol,
          })
        ) : tradeRequest ? (
          // "Not read yet" only while an agent may still answer it; a closed one never will.
          item.status === 'pending' || item.status === 'claimed' ? (
            t('row.tradePending')
          ) : (
            t('row.tradeEmail')
          )
        ) : transaction ? (
          (transaction.payeeName ?? <span className="text-gray-500 dark:text-gray-400">{t('row.noPayee')}</span>)
        ) : (
          <span className="text-gray-500 dark:text-gray-400">{t('row.transactionMissing')}</span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        {parserDraft ? (
          <Link href="/email-receipts?tab=emails" className="text-blue-600 hover:underline dark:text-blue-400">
            {t('row.viewEmailReceipts')}
          </Link>
        ) : item.kind === 'email_receipt' || item.kind === 'email_trade' ? (
          <>
            {/* A forward's sender is what its text claims: the card names who forwarded it. */}
            {item.emailReceipt
              ? item.emailReceipt.forwardedBy
                ? t('row.emailReceiptForwarded', {
                    subject: item.emailReceipt.subject,
                    sender: item.emailReceipt.fromAddress,
                    forwarder: item.emailReceipt.forwardedBy,
                  })
                : t('row.emailReceipt', { subject: item.emailReceipt.subject, sender: item.emailReceipt.fromAddress })
              : t('row.emailReceiptMissing')}{' '}
            {/* The email's own detail when it still exists; the list when it was deleted. */}
            <Link
              href={
                item.emailReceipt
                  ? `/email-receipts?tab=emails&email=${encodeURIComponent(item.emailReceipt.id)}`
                  : '/email-receipts?tab=emails'
              }
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('row.viewEmailReceipts')}
            </Link>
          </>
        ) : item.ruleName ? (
          t('row.rule', { name: item.ruleName })
        ) : (
          t('row.manualRequest')
        )}
      </div>
      {/* A parser draft request's instruction is the fixed text an agent reads, not a sentence for the person. */}
      {/* A receipt request's fixed instruction is shown in the reader's language; a rule's is their own words. */}
      {!parserDraft && (
        <p className="mt-1 whitespace-pre-line text-sm text-gray-700 dark:text-gray-300">
          {item.instructionKey ? t(`row.receiptInstruction.${item.instructionKey}`) : item.instruction}
        </p>
      )}
      {(item.kind === 'email_receipt' || tradeRequest || parserDraft) && item.status === 'pending' && (
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
      {parserDraft && item.status === 'proposed' && (
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
          {t.rich('row.parserDraftReady', {
            link: (chunks) => (
              <Link href="/email-receipts?tab=profiles" className="text-blue-600 hover:underline dark:text-blue-400">
                {chunks}
              </Link>
            ),
          })}
          {draftIds.length > 0 && (
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              {t('row.parserDraftIds', { ids: draftIds.join(', ') })}
            </span>
          )}
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
    </>
  );

  return (
    <>
      <tr className="ui-docket-row">
        {selectable && (
          <Td className={`${cell} w-10`}>
            {(isApprovable(item) || isSendableToAssistant(item)) && (
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelected?.(item)}
                aria-label={t('bulk.selectRow', { name: rowName })}
                className="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 dark:border-gray-600"
              />
            )}
          </Td>
        )}
        {wrapped ? (
          <Td className={cell}>
            {/* One card: the request on the left, its amount on the right, then the date and the status. */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5">
              <div className="min-w-0 break-words">{requestContent}</div>
              <div className="text-right whitespace-nowrap">
                {amountText !== '' && (
                  <>
                    <CellLabel>{t('columns.amount')}</CellLabel>
                    {amountText}
                  </>
                )}
              </div>
              <div className="col-span-2 flex flex-wrap items-end gap-x-4 gap-y-1">
                {dateText !== '' && (
                  <div className="whitespace-nowrap">
                    <CellLabel>{t('columns.date')}</CellLabel>
                    {dateText}
                  </div>
                )}
                {statusBadge}
              </div>
            </div>
          </Td>
        ) : (
          <>
            <Td className={`${cell} ui-docket-no whitespace-nowrap`}>{dateText}</Td>
            <Td className={`${cell} min-w-0 break-words`}>{requestContent}</Td>
            <Td align="right" className={`${cell} whitespace-nowrap`}>
              {amountText}
            </Td>
            <Td className={cell}>{statusBadge}</Td>
          </>
        )}
      </tr>
      {(showCard || proposalError !== null) && (
        <tr>
          <Td colSpan={(wrapped ? 1 : 4) + (selectable ? 1 : 0)} className="px-2 pb-4 pt-0 sm:px-4">
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
