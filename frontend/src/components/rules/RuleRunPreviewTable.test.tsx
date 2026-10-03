import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@/test/render';
import { RuleRunPreviewTable } from './RuleRunPreviewTable';
import { ACCOUNT_ID, makePreview } from './rules-test-fixtures';
import type { RuleRunChanges, RuleRunPreview } from '@/types/transaction-rule-run';

const LOAN = '11111111-1111-4111-8111-000000000002';
const REPAYMENT = '22222222-2222-4222-8222-000000000001';
const OVERPAYMENT = '22222222-2222-4222-8222-000000000002';
const INTEREST = '33333333-3333-4333-8333-000000000002';

const labels = {
  accounts: { [LOAN]: 'Loan account', [ACCOUNT_ID]: 'Checking account' },
  categories: { [INTEREST]: 'Loans: Interest' },
  payees: { [REPAYMENT]: 'Loan repayment', [OVERPAYMENT]: 'Loan overpayment' },
  tags: {},
  rules: {},
};

function previewWith(changes: RuleRunChanges, amount: number, overrides: Partial<RuleRunPreview> = {}): RuleRunPreview {
  const base = makePreview();
  return {
    ...base,
    matched: [{ ...base.matched[0], amount, currencyCode: 'PLN', payeeName: 'Loan repayment', changes }],
    labels,
    ...overrides,
  };
}

describe('RuleRunPreviewTable: a structural change', () => {
  it('lists the parts of a split with their signed amounts and where each goes', () => {
    render(
      <RuleRunPreviewTable
        preview={previewWith(
          {
            structure: {
              before: null,
              after: {
                kind: 'split',
                parts: [
                  { amount: -1200.5, categoryId: null, transferAccountId: LOAN, payeeId: OVERPAYMENT, memo: null },
                  { amount: -300.25, categoryId: INTEREST, transferAccountId: null, payeeId: null, memo: 'Interest' },
                  { amount: -0.5, categoryId: null, transferAccountId: null, payeeId: null, memo: null },
                ],
              },
            },
          },
          -1501.25,
        )}
      />,
    );
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText('Will be split into 3 parts')).toBeInTheDocument();
    // The amounts read in the reader's number format and the row's currency.
    expect(within(row).getByText(/^Part 1: .*1,200\.50.* to Loan account, payee Loan overpayment$/)).toBeInTheDocument();
    expect(within(row).getByText(/^Part 2: .*300\.25.* as Loans: Interest, memo “Interest”$/)).toBeInTheDocument();
    expect(within(row).getByText(/^Part 3: .*0\.50.* uncategorised$/)).toBeInTheDocument();
  });

  it('names a deleted account or category instead of leaking the id', () => {
    render(
      <RuleRunPreviewTable
        preview={previewWith(
          {
            structure: {
              before: null,
              after: {
                kind: 'split',
                parts: [
                  { amount: -2, categoryId: null, transferAccountId: 'gone-account', payeeId: null, memo: null },
                  { amount: -1, categoryId: 'gone-category', transferAccountId: null, payeeId: null, memo: null },
                ],
              },
            },
          },
          -3,
        )}
      />,
    );
    expect(screen.getByText(/to a deleted item$/)).toBeInTheDocument();
    expect(screen.getByText(/as a deleted item$/)).toBeInTheDocument();
    expect(screen.queryByText(/gone-/)).not.toBeInTheDocument();
  });

  it('shows the account a conversion goes to, with the category it clears', () => {
    render(
      <RuleRunPreviewTable
        preview={previewWith(
          {
            categoryId: { before: INTEREST, after: null },
            structure: { before: null, after: { kind: 'transfer', accountId: LOAN, clearCategory: true } },
          },
          -640.15,
        )}
      />,
    );
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText('Becomes a transfer with Loan account')).toBeInTheDocument();
    expect(within(row).getByText('Category: Loans: Interest → none')).toBeInTheDocument();
  });

  it('says why a structural action left a row alone', () => {
    render(
      <RuleRunPreviewTable
        preview={previewWith({}, -1510.75, {
          matched: [],
          conditionMatchedCount: 1,
          skipped: [
            { transactionId: 'a', reason: 'split_sum_mismatch' },
            { transactionId: 'b', reason: 'transfer_currency_mismatch' },
            { transactionId: 'c', reason: 'row_has_splits' },
          ],
        })}
      />,
    );
    expect(screen.getByText(/the parts do not add up to its amount/)).toBeInTheDocument();
    expect(screen.getByText(/the transfer account uses another currency/)).toBeInTheDocument();
    expect(screen.getByText(/it is already split/)).toBeInTheDocument();
    expect(screen.queryByText(/the rule cannot change it/)).not.toBeInTheDocument();
  });
});
