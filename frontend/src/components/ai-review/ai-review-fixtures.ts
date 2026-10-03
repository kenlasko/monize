import type { AiReviewItem } from '@/types/ai-review';

/** A request as `GET /ai-review-requests` answers it; `overrides` win. */
export function makeReviewItem(overrides: Partial<AiReviewItem> = {}): AiReviewItem {
  return {
    id: 'req-1',
    kind: 'transaction_review',
    status: 'pending',
    instruction: 'Split this purchase by the items in the order',
    transactionId: 'tx-1',
    ruleId: 'rule-1',
    ruleName: 'Allegro orders',
    emailReceipt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    expiresAt: '2026-10-01T10:00:00.000Z',
    transaction: {
      id: 'tx-1',
      date: '2026-08-30',
      amount: -25,
      currencyCode: 'USD',
      payeeName: 'Allegro',
      description: null,
      accountId: 'acc-1',
      accountName: 'Checking',
      categoryName: null,
      isSplit: false,
    },
    ...overrides,
  };
}

/** The rebuilt confirmation card of a proposed split. */
export const PROPOSED_ACTION = {
  actionId: 'act-1',
  type: 'update_transaction' as const,
  preview: {
    accountName: 'Checking',
    amount: -25,
    currencyCode: 'USD',
    transactionDate: '2026-08-30',
    payeeName: 'Allegro',
    splits: [
      { categoryName: 'Groceries', amount: -15, memo: 'Milk' },
      { categoryName: 'Household', amount: -10, memo: 'Soap' },
    ],
  },
  descriptor: { transactionId: 'tx-1' },
  signature: 'sig-1',
  expiresAt: 1_900_000_000_000,
};
