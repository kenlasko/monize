'use client';

import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { shownReceiptState, type EmailReceiptShownState } from '@/lib/email-receipts-format';
import type { EmailReceiptListItem } from '@/types/email-receipts';

const STATE_VARIANT: Record<EmailReceiptShownState, BadgeVariant> = {
  pending: 'gray',
  skipped: 'gray',
  no_parser: 'amber',
  parse_failed: 'red',
  unmatched: 'amber',
  ambiguous: 'amber',
  review_conflict: 'red',
  ignored: 'gray',
  proposed: 'purple',
  applied: 'green',
  dismissed: 'gray',
  expired: 'amber',
  pending_ai: 'blue',
  request_missing: 'red',
};

interface ReceiptStateBadgeProps {
  receipt: Pick<EmailReceiptListItem, 'status' | 'displayState'>;
}

/** The state of a stored email as a pill; a `review` email shows what its request says. */
export function ReceiptStateBadge({ receipt }: ReceiptStateBadgeProps) {
  const t = useTranslations('emailReceipts.state');
  const state = shownReceiptState(receipt);
  return <Badge variant={STATE_VARIANT[state]}>{t(state)}</Badge>;
}
