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

  it('renders split lines in place of the single category for a split transaction', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({
          preview: {
            accountName: 'Checking',
            amount: -100,
            currencyCode: 'USD',
            transactionDate: '2026-01-15',
            payeeName: 'Costco',
            splits: [
              { categoryName: 'Groceries', amount: -60 },
              { categoryName: 'Household', amount: -40, memo: 'soap' },
            ],
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Splits')).toBeInTheDocument();
    expect(screen.getByText(/Groceries:/)).toBeInTheDocument();
    expect(screen.getByText(/Household:.*soap/)).toBeInTheDocument();
    // The single-category row is not shown for a split.
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
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
    // The link deep-links to the created transaction so the list flashes it.
    expect(
      screen.getByRole('link', { name: 'View transaction' }),
    ).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('falls back to the unfiltered list when no result id is present', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({ status: 'confirmed' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'View transaction' }),
    ).toHaveAttribute('href', '/transactions');
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

  function makeSecurityAction(
    previewOverrides: Partial<PendingAction['preview']> = {},
    overrides: Partial<PendingAction> = {},
  ): PendingAction {
    return makeAction({
      type: 'create_security',
      descriptor: { type: 'create_security' },
      preview: {
        symbol: 'AAPL',
        securityName: 'Apple Inc.',
        securityType: 'STOCK',
        exchange: 'NASDAQ',
        securityCurrency: 'USD',
        isFavourite: false,
        ...previewOverrides,
      },
      ...overrides,
    });
  }

  it('renders a security preview with symbol, type, exchange, and currency', () => {
    render(
      <TransactionConfirmationCard
        action={makeSecurityAction()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Create this security?')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('STOCK')).toBeInTheDocument();
    expect(screen.getByText('NASDAQ')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
    // Not pinned, so no favourite row.
    expect(screen.queryByText('Favourite')).toBeNull();
  });

  it('shows the favourite row when the security is pinned', () => {
    render(
      <TransactionConfirmationCard
        action={makeSecurityAction({ isFavourite: true })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Favourite')).toBeInTheDocument();
    expect(screen.getByText('Pinned to dashboard')).toBeInTheDocument();
  });

  it('deep-links the view-securities link to the created security', () => {
    render(
      <TransactionConfirmationCard
        action={makeSecurityAction({}, { status: 'confirmed', resultId: 'sec-1' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Security created')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View securities' }),
    ).toHaveAttribute('href', '/securities?highlight=sec-1');
  });

  it('falls back to the plain securities list when no result id is present', () => {
    render(
      <TransactionConfirmationCard
        action={makeSecurityAction({}, { status: 'confirmed' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'View securities' }),
    ).toHaveAttribute('href', '/securities');
  });

  it('renders an update_security card and success message', () => {
    render(
      <TransactionConfirmationCard
        action={makeSecurityAction(
          {},
          {
            type: 'update_security',
            descriptor: { type: 'update_security' },
            status: 'confirmed',
          },
        )}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Security updated')).toBeInTheDocument();
  });

  it('renders a delete_security card showing symbol and name only', () => {
    render(
      <TransactionConfirmationCard
        action={makeSecurityAction(
          {},
          { type: 'delete_security', descriptor: { type: 'delete_security' } },
        )}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Delete this security?')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    // Delete card omits the classification rows.
    expect(screen.queryByText('STOCK')).toBeNull();
  });

  describe('edit and delete actions', () => {
    it('renders an update_transaction card with the resulting values', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_transaction',
            descriptor: { type: 'update_transaction' },
            preview: {
              accountName: 'Checking',
              amount: -75,
              currencyCode: 'USD',
              transactionDate: '2026-02-01',
              payeeName: 'Store',
              categoryName: 'Groceries',
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Apply this transaction edit?'),
      ).toBeInTheDocument();
      expect(screen.getByText('Store')).toBeInTheDocument();
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    it('shows the updated success message and a view link', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_transaction',
            descriptor: { type: 'update_transaction' },
            status: 'confirmed',
            resultId: 'tx-1',
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Transaction updated')).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'View transaction' }),
      ).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
    });

    it('renders a delete_transaction card and offers no view link on success', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'delete_transaction',
            descriptor: { type: 'delete_transaction' },
            status: 'confirmed',
            resultId: 'tx-1',
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Transaction deleted')).toBeInTheDocument();
      // The record is gone, so there is no link to navigate to.
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('renders an update_investment_transaction card with investment fields', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_investment_transaction',
            descriptor: { type: 'update_investment_transaction' },
            preview: {
              accountName: 'Brokerage',
              investmentAction: 'SELL',
              transactionDate: '2026-02-01',
              symbol: 'VTI',
              securityName: 'Vanguard Total',
              securityCurrency: 'USD',
              quantity: 5,
              price: 210,
              totalAmount: 1049,
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Apply this investment transaction edit?'),
      ).toBeInTheDocument();
      expect(screen.getByText('VTI (Vanguard Total)')).toBeInTheDocument();
    });

    it('renders a delete_investment_transaction confirmed state without a link', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'delete_investment_transaction',
            descriptor: { type: 'delete_investment_transaction' },
            status: 'confirmed',
            resultId: 'it-1',
            preview: {
              accountName: 'Brokerage',
              investmentAction: 'BUY',
              transactionDate: '2026-02-01',
              symbol: 'VTI',
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Investment transaction deleted'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('payee actions', () => {
    it('renders a create_payee card with name and category', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'create_payee',
            descriptor: { type: 'create_payee' },
            preview: { name: 'Hydro One', categoryName: 'Utilities' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Create this payee?')).toBeInTheDocument();
      expect(screen.getByText('Hydro One')).toBeInTheDocument();
      expect(screen.getByText('Utilities')).toBeInTheDocument();
    });

    it('deep-links the view-payees link to the created payee', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'create_payee',
            descriptor: { type: 'create_payee' },
            status: 'confirmed',
            resultId: 'payee-1',
            preview: { name: 'Hydro One', categoryName: 'Utilities' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByRole('link', { name: 'View payees' }),
      ).toHaveAttribute('href', '/payees?highlight=payee-1');
    });

    it('renders an update_payee card and success message', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_payee',
            descriptor: { type: 'update_payee' },
            status: 'confirmed',
            preview: { name: 'Hydro One', categoryName: 'Bills' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Payee updated')).toBeInTheDocument();
    });

    it('renders a delete_payee card showing only the name', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'delete_payee',
            descriptor: { type: 'delete_payee' },
            preview: { name: 'Old Payee' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Delete this payee?')).toBeInTheDocument();
      expect(screen.getByText('Old Payee')).toBeInTheDocument();
    });
  });

  describe('transfer actions', () => {
    function makeTransferAction(
      previewOverrides: Partial<PendingAction['preview']> = {},
      overrides: Partial<PendingAction> = {},
    ): PendingAction {
      return makeAction({
        type: 'create_transfer',
        descriptor: { type: 'create_transfer' },
        preview: {
          fromAccountName: 'Checking',
          toAccountName: 'Savings',
          amount: 200,
          currencyCode: 'USD',
          toAmount: 200,
          toCurrencyCode: 'USD',
          transactionDate: '2026-03-01',
          ...previewOverrides,
        },
        ...overrides,
      });
    }

    it('renders a create_transfer card with From, To, and Amount', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Create this transfer?')).toBeInTheDocument();
      expect(screen.getByText('From')).toBeInTheDocument();
      expect(screen.getByText('Checking')).toBeInTheDocument();
      expect(screen.getByText('To')).toBeInTheDocument();
      expect(screen.getByText('Savings')).toBeInTheDocument();
      // Same-currency transfer: no separate "To amount" row.
      expect(screen.queryByText('To amount')).toBeNull();
    });

    it('shows the destination amount for a cross-currency transfer', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction({
            toAmount: 270,
            toCurrencyCode: 'CAD',
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('To amount')).toBeInTheDocument();
    });

    it('renders a custom payee row for a transfer with payeeName', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction({ payeeName: 'Shared rent' })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Payee')).toBeInTheDocument();
      expect(screen.getByText('Shared rent')).toBeInTheDocument();
    });

    it('appends the new-payee marker when the transfer label will create a payee', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction({
            payeeName: 'Brand New Label',
            payeeWillBeCreated: true,
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByText('Brand New Label (new payee)'),
      ).toBeInTheDocument();
    });

    it('omits the new-payee marker when the transfer label matched an existing payee', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction({
            payeeName: 'Shared rent',
            payeeWillBeCreated: false,
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Shared rent')).toBeInTheDocument();
      expect(screen.queryByText('Shared rent (new payee)')).toBeNull();
    });

    it('omits the payee row when no payeeName is set', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByText('Payee')).toBeNull();
    });

    it('renders the category row for a categorized transfer', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction(
            { categoryName: 'Investments: IKE' },
            {
              type: 'update_transfer',
              descriptor: { type: 'update_transfer' },
            },
          )}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Investments: IKE')).toBeInTheDocument();
    });

    it('omits the category row when the transfer has no category', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByText('Category')).toBeNull();
    });

    it('shows the transfer success message and a view link on confirm', () => {
      render(
        <TransactionConfirmationCard
          action={makeTransferAction(
            {},
            {
              type: 'update_transfer',
              descriptor: { type: 'update_transfer' },
              status: 'confirmed',
              resultId: 'tx-1',
            },
          )}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Transfer updated')).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'View transaction' }),
      ).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
    });
  });
});
