import type { TransactionRule } from '@/types/transaction-rule';
import type { RuleApplication, RuleRunPreview } from '@/types/transaction-rule-run';

/** A valid stored rule; a case overrides only what it is about. */
export function makeRule(overrides: Partial<TransactionRule> = {}): TransactionRule {
  return {
    id: 'rule-1',
    name: 'Coffee shops',
    enabled: true,
    position: 0,
    triggers: ['create'],
    condition: {
      all: [{ field: 'referenceNumber', op: 'contains', value: 'coffee' }],
    },
    actions: [
      { type: 'add_tags', tagIds: ['tag-1'] },
      { type: 'set_payee', payeeId: 'payee-1', onlyIfEmpty: true },
    ],
    stopProcessing: false,
    activeFrom: null,
    activeTo: null,
    revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    invalid: false,
    invalidReasons: [],
    ...overrides,
  };
}

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const JOINT_ACCOUNT_ID = '11111111-1111-4111-8111-222222222222';
export const PAYEE_ID = '22222222-2222-4222-8222-222222222222';
export const FOOD_ID = '33333333-3333-4333-8333-333333333333';
export const COFFEE_ID = '33333333-3333-4333-8333-444444444444';
export const TAG_ID = '44444444-4444-4444-8444-444444444444';
export const TAG_WORK_ID = '44444444-4444-4444-8444-555555555555';

/** What the pickers' five list endpoints answer in the editor tests. */
export const lookupFixtures = {
  accounts: [
    { id: ACCOUNT_ID, name: 'Chequing', currencyCode: 'CAD', isClosed: false, isJoint: false },
    { id: JOINT_ACCOUNT_ID, name: 'Partner joint', currencyCode: 'CAD', isClosed: false, isJoint: true },
  ],
  payees: [{ id: PAYEE_ID, name: 'Corner Cafe' }],
  categories: [
    { id: FOOD_ID, name: 'Food', parentId: null },
    { id: COFFEE_ID, name: 'Coffee', parentId: FOOD_ID },
  ],
  tags: [
    { id: TAG_ID, name: 'Coffee run' },
    { id: TAG_WORK_ID, name: 'Work' },
  ],
  currencies: [
    { code: 'CAD', isActive: true },
    { code: 'USD', isActive: true },
    { code: 'EUR', isActive: false },
  ],
};

/** A preview with one row that gains a category and a tag; a case overrides only what it is about. */
export function makePreview(overrides: Partial<RuleRunPreview> = {}): RuleRunPreview {
  return {
    matched: [
      {
        transactionId: 'tx-1',
        date: '2026-08-14',
        payeeName: 'Corner Cafe',
        amount: -4.5,
        currencyCode: 'CAD',
        changes: {
          categoryId: { before: null, after: COFFEE_ID },
          tagIds: { before: [], after: [TAG_ID] },
        },
      },
    ],
    skipped: [],
    scanned: 12,
    conditionMatchedCount: 1,
    truncated: false,
    fingerprint: 'a'.repeat(64),
    labels: {
      accounts: { [ACCOUNT_ID]: 'Chequing' },
      categories: { [COFFEE_ID]: 'Food: Coffee' },
      payees: { [PAYEE_ID]: 'Corner Cafe' },
      tags: { [TAG_ID]: 'Coffee run' },
      rules: {},
    },
    ...overrides,
  };
}

export function makeApplication(overrides: Partial<RuleApplication> = {}): RuleApplication {
  return {
    id: 'app-1',
    transactionId: 'tx-1',
    date: '2026-08-14',
    payeeName: 'Corner Cafe',
    amount: -4.5,
    currencyCode: 'CAD',
    source: 'import',
    changes: { categoryId: { before: null, after: COFFEE_ID } },
    appliedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}
