import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TransactionConfirmationCard } from './TransactionConfirmationCard';
import type { PendingAction } from '@/types/ai';

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    actionId: 'a1',
    type: 'create_transaction',
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    signature: 'sig',
    descriptor: { type: 'create_transaction' },
    preview: {
      accountName: 'Checking',
      amount: -12.5,
      currencyCode: 'USD',
      transactionDate: '2026-01-15',
      payeeName: 'Starbucks',
      categoryName: 'Dining',
    },
    ...overrides,
  };
}

describe('TransactionConfirmationCard', () => {
  it('renders the preview and Approve/Cancel for a pending action', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Create this transaction?')).toBeInTheDocument();
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Starbucks')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('marks the payee as new when a payee will be created on approval', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({
          preview: {
            accountName: 'Checking',
            amount: -12.5,
            currencyCode: 'USD',
            transactionDate: '2026-01-15',
            payeeName: 'Brand New Store',
            payeeWillBeCreated: true,
            categoryName: 'Dining',
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Brand New Store (new payee)'),
    ).toBeInTheDocument();
  });

  it('keeps the payee name plain when it is recorded as free text', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({
          preview: {
            accountName: 'Checking',
            amount: -12.5,
            currencyCode: 'USD',
            transactionDate: '2026-01-15',
            payeeName: 'Brand New Store',
            payeeWillBeCreated: false,
            categoryName: 'Dining',
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Brand New Store')).toBeInTheDocument();
    expect(screen.queryByText('Brand New Store (new payee)')).toBeNull();
  });

  it('fires onConfirm / onCancel when the buttons are clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <TransactionConfirmationCard
        action={makeAction()}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a success state with a view link once confirmed', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({ status: 'confirmed', resultId: 'tx-1' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Transaction created')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View transaction' }),
    ).toHaveAttribute('href', '/transactions');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('shows an error message and a retry button on error', () => {
    const onConfirm = vi.fn();
    render(
      <TransactionConfirmationCard
        action={makeAction({ status: 'error', errorMessage: 'Boom' })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows an expired notice and no actions', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({ status: 'expired' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('This confirmation expired. Ask again to retry.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders categorize previews with current and new category', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({
          type: 'categorize_transaction',
          preview: {
            payeeName: 'Starbucks',
            amount: -12.5,
            currencyCode: 'USD',
            transactionDate: '2026-01-15',
            currentCategoryName: 'Uncategorized',
            newCategoryName: 'Dining',
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Update this category?')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
  });

  function makeInvestmentAction(
    previewOverrides: Partial<PendingAction['preview']> = {},
    overrides: Partial<PendingAction> = {},
  ): PendingAction {
    return makeAction({
      type: 'create_investment_transaction',
      descriptor: { type: 'create_investment_transaction' },
      preview: {
        accountName: 'Brokerage',
        transactionDate: '2026-01-15',
        investmentAction: 'BUY',
        symbol: 'AAPL',
        securityName: 'Apple Inc.',
        securityCurrency: 'USD',
        quantity: 10,
        price: 150,
        commission: 9.99,
        totalAmount: 1509.99,
        cashAccountName: 'Brokerage Cash',
        cashCurrency: 'USD',
        cashAmount: -1509.99,
        ...previewOverrides,
      },
      ...overrides,
    });
  }

  it('renders an investment transaction preview with security and action label', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Create this investment transaction?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Brokerage')).toBeInTheDocument();
    // Action enum is rendered via its localized label.
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('AAPL (Apple Inc.)')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('omits cash and security rows for a share-only action', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction({
          investmentAction: 'ADD_SHARES',
          commission: 0,
          totalAmount: 0,
          cashAccountName: null,
          cashCurrency: null,
          cashAmount: null,
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Add shares')).toBeInTheDocument();
    expect(screen.queryByText('Cash impact')).toBeNull();
    expect(screen.queryByText('Total')).toBeNull();
  });

  it('shows a view-investments link once an investment transaction is created', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction({}, { status: 'confirmed', resultId: 'it-1' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Investment transaction created'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View investments' }),
    ).toHaveAttribute('href', '/investments');
  });
});
