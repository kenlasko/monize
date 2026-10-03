import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { BulkConfirmationCard } from './BulkConfirmationCard';
import type { PendingAction } from '@/types/ai';

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    actionId: 'bulk-1',
    type: 'create_transactions',
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    signature: 'sig',
    descriptor: { type: 'create_transactions' },
    preview: {
      rows: [
        {
          status: 'ok',
          accountName: 'Checking',
          amount: -12.5,
          currencyCode: 'USD',
          transactionDate: '2026-01-15',
          payeeName: 'Starbucks',
          categoryName: 'Dining',
        },
        {
          status: 'error',
          accountName: 'Nope',
          transactionDate: '2026-01-16',
          error: 'Unknown account: Nope',
        },
      ],
    },
    ...overrides,
  };
}

describe('BulkConfirmationCard', () => {
  it('renders all rows, flags the bad one, and shows a valid/skipped summary', () => {
    render(
      <BulkConfirmationCard
        action={makeAction()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Create these transactions?'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Starbucks/)).toBeInTheDocument();
    // Flagged row shows its error and a skipped badge.
    expect(screen.getByText('Unknown account: Nope')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    // "1 transaction · 1 skipped" summary.
    expect(screen.getByText(/1 transaction.*1 skipped/)).toBeInTheDocument();
  });

  it('approves all valid rows via the single button', () => {
    const onConfirm = vi.fn();
    render(
      <BulkConfirmationCard
        action={makeAction()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables approval when no row is valid', () => {
    render(
      <BulkConfirmationCard
        action={makeAction({
          preview: {
            rows: [{ status: 'error', error: 'bad', transactionDate: 'x' }],
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Approve all' }),
    ).toBeDisabled();
  });

  it('shows a created count and skipped note on success', () => {
    render(
      <BulkConfirmationCard
        action={makeAction({
          status: 'confirmed',
          resultCount: 1,
          resultSkipped: [{ index: 1, reason: 'Unknown account' }],
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 transaction created/)).toBeInTheDocument();
    expect(screen.getByText(/1 row skipped/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View transaction' }),
    ).toBeInTheDocument();
  });

  it('renders investment rows with action and quantity', () => {
    render(
      <BulkConfirmationCard
        action={makeAction({
          type: 'create_investment_transactions',
          preview: {
            rows: [
              {
                status: 'ok',
                investmentAction: 'BUY',
                symbol: 'AAPL',
                transactionDate: '2026-01-15',
                quantity: 10,
                price: 150,
                totalAmount: 1500,
                securityCurrency: 'USD',
              },
            ],
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Create these investment transactions?'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Buy AAPL/)).toBeInTheDocument();
  });

  describe('batch_actions envelope', () => {
    it('renders an update batch with the edit title and success copy', () => {
      const { rerender } = render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Apply these transaction edits?'),
      ).toBeInTheDocument();

      rerender(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update' },
            status: 'confirmed',
            resultCount: 1,
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText(/1 transaction updated/)).toBeInTheDocument();
    });

    it('shows each row\'s split lines instead of a single category', () => {
      // A row that rewrites a split set has no single category. Showing one
      // would describe the card as doing something other than what approving
      // it writes.
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  accountName: 'WS Chequing',
                  amount: -100,
                  currencyCode: 'USD',
                  transactionDate: '2026-01-15',
                  payeeName: 'Rogers',
                  categoryName: null,
                  splits: [
                    { categoryName: 'Automobile: Accessories', amount: -60 },
                    { categoryName: 'Groceries', amount: -40 },
                  ],
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(
        screen.getByText(/Automobile: Accessories.*Groceries/),
      ).toBeInTheDocument();
    });

    it('flags reconciled rows in an update batch', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  accountName: 'Checking',
                  amount: -12.5,
                  currencyCode: 'USD',
                  transactionDate: '2026-01-15',
                  payeeName: 'Starbucks',
                  isReconciled: true,
                },
                {
                  status: 'ok',
                  accountName: 'Checking',
                  amount: -8,
                  currencyCode: 'USD',
                  transactionDate: '2026-01-16',
                  payeeName: 'Cafe',
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      // Only the reconciled row carries the badge.
      expect(screen.getAllByText('Reconciled')).toHaveLength(1);
    });

    it('renders a create_payee batch with payee names and title', () => {
      const { rerender } = render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_payee' },
            preview: {
              rows: [
                { status: 'ok', name: 'Hydro One', categoryName: 'Utilities' },
                { status: 'ok', name: 'City Water' },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Create these payees?')).toBeInTheDocument();
      expect(screen.getByText('Hydro One')).toBeInTheDocument();
      expect(screen.getByText('Utilities')).toBeInTheDocument();

      rerender(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_payee' },
            status: 'confirmed',
            resultCount: 2,
            preview: { rows: [] },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText(/2 payees created/)).toBeInTheDocument();
    });

    it('shows a cleared contact field instead of rendering the change as blank', () => {
      // null means the edit clears the field and undefined means it does not
      // touch it. Dropping both on truthiness -- which is what `.filter(Boolean)`
      // does -- makes a row that empties every contact detail look identical to
      // a row that changes nothing, and in bulk mode there is no second card to
      // show what is really being approved.
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update_payee' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  name: 'Hydro One',
                  categoryName: 'Utilities',
                  email: null,
                  phone: null,
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Utilities · None · None')).toBeInTheDocument();
    });

    it('omits a contact field the edit does not mention', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update_payee' },
            preview: {
              rows: [
                { status: 'ok', name: 'Hydro One', categoryName: 'Utilities' },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Utilities')).toBeInTheDocument();
      expect(screen.queryByText(/None/)).not.toBeInTheDocument();
    });

    it('shows the address a bulk edit sets, since no individual card will', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update_payee' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  name: 'Starbucks',
                  address: '1912 Pike Pl, Seattle',
                  // What the server sends: the stored E.164 form.
                  phone: '+12064488762',
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      // Address last, so the value long enough to wrap does it at the end.
      expect(
        // ...shown the way a person reads a number, not as stored.
        screen.getByText('+1 206 448 8762 · 1912 Pike Pl, Seattle'),
      ).toBeInTheDocument();
    });

    it('renders a delete_payee batch with the delete title', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'delete_payee' },
            preview: { rows: [{ status: 'ok', name: 'Old Payee' }] },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Delete these payees?')).toBeInTheDocument();
      expect(screen.getByText('Old Payee')).toBeInTheDocument();
    });

    it('renders a create_security batch with symbols and title', () => {
      const { rerender } = render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_security' },
            preview: {
              rows: [
                { status: 'ok', symbol: 'AAPL', securityName: 'Apple Inc.' },
                { status: 'ok', symbol: 'MSFT', securityName: 'Microsoft' },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Create these securities?')).toBeInTheDocument();
      expect(screen.getByText('AAPL')).toBeInTheDocument();

      rerender(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_security' },
            status: 'confirmed',
            resultCount: 2,
            preview: { rows: [] },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText(/2 securities created/)).toBeInTheDocument();
    });

    it('renders a delete batch with the delete title', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'delete' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Delete these transactions?'),
      ).toBeInTheDocument();
    });

    it('renders a transfer batch with From → To rows and transfer title', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_transfer' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  fromAccountName: 'Checking',
                  toAccountName: 'Savings',
                  amount: 200,
                  currencyCode: 'USD',
                  toAmount: 200,
                  toCurrencyCode: 'USD',
                  transactionDate: '2026-03-01',
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Create these transfers?')).toBeInTheDocument();
      expect(screen.getByText(/Checking → Savings/)).toBeInTheDocument();
    });

    it('appends a custom payee to a transfer row secondary line', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_transfer' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  fromAccountName: 'Checking',
                  toAccountName: 'Savings',
                  amount: 200,
                  currencyCode: 'USD',
                  toAmount: 200,
                  toCurrencyCode: 'USD',
                  transactionDate: '2026-03-01',
                  payeeName: 'Shared rent',
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText(/Shared rent/)).toBeInTheDocument();
    });

    it('appends the new-payee marker to a transfer row whose label will be created', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'create_transfer' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  fromAccountName: 'Checking',
                  toAccountName: 'Savings',
                  amount: 200,
                  currencyCode: 'USD',
                  toAmount: 200,
                  toCurrencyCode: 'USD',
                  transactionDate: '2026-03-01',
                  payeeName: 'Brand New Label',
                  payeeWillBeCreated: true,
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText(/Brand New Label \(new payee\)/),
      ).toBeInTheDocument();
    });

    it('renders an investment update batch with investment rows and edit copy', () => {
      const { rerender } = render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update_investment' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  investmentAction: 'SELL',
                  symbol: 'VTI',
                  transactionDate: '2026-02-01',
                  quantity: 5,
                  price: 210,
                  totalAmount: 1050,
                  securityCurrency: 'USD',
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Apply these investment transaction edits?'),
      ).toBeInTheDocument();
      // Rendered with the investment row layout (action + symbol).
      expect(screen.getByText(/Sell VTI/)).toBeInTheDocument();
      // Success copy + the investments view link.
      rerender(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'update_investment' },
            status: 'confirmed',
            resultCount: 1,
            preview: { rows: [] },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText(/1 investment transaction updated/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'View investments' }),
      ).toBeInTheDocument();
    });

    it('renders an investment delete batch with the delete title and success copy', () => {
      const { rerender } = render(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'delete_investment' },
            preview: {
              rows: [
                {
                  status: 'ok',
                  investmentAction: 'BUY',
                  symbol: 'VTI',
                  transactionDate: '2026-02-01',
                  quantity: 10,
                  totalAmount: 2000,
                  securityCurrency: 'USD',
                },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Delete these investment transactions?'),
      ).toBeInTheDocument();

      rerender(
        <BulkConfirmationCard
          action={makeAction({
            type: 'batch_actions',
            descriptor: { type: 'batch_actions', operation: 'delete_investment' },
            status: 'confirmed',
            resultCount: 2,
            preview: { rows: [] },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText(/2 investment transactions deleted/),
      ).toBeInTheDocument();
    });
  });

  it('shows retry on error and an expired notice', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <BulkConfirmationCard
        action={makeAction({ status: 'error', errorMessage: 'Server error' })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Server error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <BulkConfirmationCard
        action={makeAction({ status: 'expired' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('This confirmation expired. Ask again to retry.'),
    ).toBeInTheDocument();
  });

  describe('rule effects on a created row', () => {
    const ruleEffects = (structure: unknown) => ({
      changes: { addTagIds: [], removeTagIds: [], structure },
      aiReviewRequests: [],
      labels: { categories: { 'cat-1': 'Loans: Interest' }, payees: {}, tags: {}, rules: {}, accounts: { loan: 'Loan account' } },
    });
    const okRow = (effects?: unknown) => ({
      status: 'ok' as const,
      accountName: 'Checking',
      amount: -640.15,
      currencyCode: 'USD',
      transactionDate: '2026-10-05',
      payeeName: 'Bank',
      ...(effects ? { ruleEffects: effects } : {}),
    });

    it('lists the transfer or split a rule will write, per row, so the card shows the balance it moves', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            preview: {
              rows: [
                okRow(ruleEffects({ kind: 'transfer', accountId: 'loan', clearCategory: true })),
                okRow(
                  ruleEffects({
                    kind: 'split',
                    parts: [
                      { amount: -400.15, transferAccountId: 'loan', categoryId: null, payeeId: null, memo: null },
                      { amount: -240, transferAccountId: null, categoryId: 'cat-1', payeeId: null, memo: null },
                    ],
                  }),
                ),
                okRow(),
              ],
            } as never,
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const blocks = screen.getAllByTestId('rule-effects');
      expect(blocks).toHaveLength(2);
      expect(within(blocks[0]).getByText('Becomes a transfer with Loan account')).toBeInTheDocument();
      expect(within(blocks[1]).getByText('Will be split into 2 parts')).toBeInTheDocument();
      expect(within(blocks[1]).getByText('Part 1: -$400.15 to Loan account')).toBeInTheDocument();
    });

    it('shows nothing for a flagged row, which is never created', () => {
      render(
        <BulkConfirmationCard
          action={makeAction({
            preview: {
              rows: [{ ...okRow(ruleEffects({ kind: 'transfer', accountId: 'loan', clearCategory: true })), status: 'error', error: 'Unknown account' }],
            } as never,
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('rule-effects')).toBeNull();
    });
  });
});
