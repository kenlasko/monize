import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
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

  it('lists the files an approval will save as attachments', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({
          preview: {
            ...makeAction().preview,
            attachments: [
              {
                filename: 'receipt.png',
                contentType: 'image/png',
                byteSize: 2048,
              },
              {
                filename: 'invoice.pdf',
                contentType: 'application/pdf',
                byteSize: 1024 * 1024,
              },
            ],
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    // `kB` rather than `KB`: sizes go through `useNumberFormat().formatBytes`
    // now, so the unit abbreviation is CLDR's for the reader's locale, and
    // English's is the SI-style lowercase prefix. MB and GB are unchanged.
    expect(screen.getByText('receipt.png (2.0 kB)')).toBeInTheDocument();
    expect(screen.getByText('invoice.pdf (1.0 MB)')).toBeInTheDocument();
  });

  it('shows no attachments section when the preview carries none', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
  });

  it('warns when an update targets a reconciled transaction', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({
          type: 'update_transaction',
          descriptor: { type: 'update_transaction' },
          preview: {
            accountName: 'Checking',
            amount: -12.5,
            currencyCode: 'USD',
            transactionDate: '2026-01-15',
            payeeName: 'Starbucks',
            categoryName: 'Dining',
            isReconciled: true,
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/reconciled/i)).toBeInTheDocument();
  });

  it('shows the reference number an update sets, and no row when it sets none', () => {
    const update = (referenceNumber?: string) =>
      makeAction({
        type: 'update_transaction',
        descriptor: { type: 'update_transaction' },
        preview: {
          accountName: 'Checking',
          amount: -12.5,
          currencyCode: 'USD',
          transactionDate: '2026-01-15',
          payeeName: 'Starbucks',
          categoryName: 'Dining',
          ...(referenceNumber === undefined ? {} : { referenceNumber }),
        },
      });
    const { unmount } = render(
      <TransactionConfirmationCard action={update('EX-20931')} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText('Ref #')).toBeInTheDocument();
    expect(screen.getByText('EX-20931')).toBeInTheDocument();
    unmount();

    render(<TransactionConfirmationCard action={update()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText('Ref #')).not.toBeInTheDocument();
  });

  it('does not warn about reconciliation for a create action', () => {
    render(
      <TransactionConfirmationCard
        action={makeAction({ preview: { ...makeAction().preview, isReconciled: true } })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // isReconciled is only meaningful for update/delete; a create never warns.
    expect(screen.queryByText(/reconciled/i)).not.toBeInTheDocument();
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

  it('names the scheduled bill or deposit that approving the trade marks as paid', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction({ scheduledName: 'Monthly XCNS' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Marks as paid').nextElementSibling).toHaveTextContent('Monthly XCNS');
  });

  it('names the due day of the occurrence it marks paid, in the reader\'s date format', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction({ scheduledName: 'Monthly XCNS', scheduledDueDate: '2026-10-15' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const value = screen.getByText('Marks as paid').nextElementSibling;
    expect(value).toHaveTextContent(/^Monthly XCNS \(due .+\)$/);
  });

  it('says nothing about a schedule for a trade that pays none', () => {
    render(<TransactionConfirmationCard action={makeInvestmentAction()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText('Marks as paid')).not.toBeInTheDocument();
  });

  it('shows the resolved bond series, the accrued interest and the redemption split of a bond redemption', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction({
          investmentAction: 'REDEEM',
          symbol: 'EDO',
          securityName: 'EDO bonds',
          securityCurrency: 'PLN',
          quantity: 10,
          price: 100,
          commission: 0,
          totalAmount: 1000,
          cashCurrency: 'PLN',
          cashAmount: 1470.5,
          accruedInterest: 470.5,
          bondSeriesCode: 'EDO0423',
          bondRedemptionSplit: {
            principal: 1000,
            interest: 470.5,
            deduction: 0,
            payout: 1470.5,
            outcome: 'filled',
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Series')).toBeInTheDocument();
    expect(screen.getByText('EDO0423')).toBeInTheDocument();
    expect(screen.getByText('Accrued interest')).toBeInTheDocument();
    expect(screen.getByText('Redemption split')).toBeInTheDocument();
    expect(
      screen.getByText(/Principal .*1,000\.00.* \+ interest .*470\.50.* = payout .*1,470\.50/),
    ).toBeInTheDocument();
    // No fee was taken out, and the figures agree with the split: no warning.
    expect(screen.queryByText('Early-redemption fee deducted')).toBeNull();
    expect(screen.queryByText(/Check them before approving/)).toBeNull();
  });

  it('names the early-redemption fee, and warns when the figures differ from the split', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction({
          investmentAction: 'REDEEM',
          securityCurrency: 'PLN',
          bondSeriesCode: 'EDO1036',
          bondRedemptionSplit: {
            principal: 100,
            interest: 7.2,
            deduction: 3,
            payout: 107.2,
            outcome: 'differs',
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Early-redemption fee deducted')).toBeInTheDocument();
    expect(screen.getByText(/Check them before approving/)).toBeInTheDocument();
  });

  it('shows no series or split row for an ordinary investment transaction', () => {
    render(
      <TransactionConfirmationCard
        action={makeInvestmentAction()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByText('Series')).toBeNull();
    expect(screen.queryByText('Redemption split')).toBeNull();
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

    it('shows the tags an edit adds (marking new ones) and removes', () => {
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
              categoryName: 'Groceries',
              tagNames: ['Trip', 'Family'],
              newTagNames: ['Family'],
              removeTagNames: ['Old'],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Add tags')).toBeInTheDocument();
      expect(screen.getByText('Trip, Family (new tag)')).toBeInTheDocument();
      expect(screen.getByText('Remove tags')).toBeInTheDocument();
      expect(screen.getByText('Old')).toBeInTheDocument();
    });

    it('shows the tags a split line keeps', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_transaction',
            descriptor: { type: 'update_transaction' },
            preview: {
              accountName: 'Checking',
              amount: -30,
              currencyCode: 'USD',
              transactionDate: '2026-02-01',
              splits: [
                { categoryName: 'Food', amount: -20, tagNames: ['Trip'] },
                { categoryName: 'Home', amount: -10 },
              ],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText(/Food: .*20.* · tags: Trip/)).toBeInTheDocument();
      expect(screen.queryByText(/Home: .*tags/)).toBeNull();
    });

    it('shows the tags a transfer edit adds and removes', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_transfer',
            descriptor: { type: 'update_transfer' },
            preview: {
              fromAccountName: 'Checking',
              toAccountName: 'Savings',
              amount: 100,
              currencyCode: 'USD',
              transactionDate: '2026-02-01',
              tagNames: ['Trip'],
              removeTagNames: ['Old'],
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Add tags')).toBeInTheDocument();
      expect(screen.getByText('Trip')).toBeInTheDocument();
      expect(screen.getByText('Remove tags')).toBeInTheDocument();
      expect(screen.getByText('Old')).toBeInTheDocument();
    });

    it('renders a tag rename with the name it has now and only what changes', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_tag',
            descriptor: { type: 'update_tag' },
            preview: { name: 'Travel', previousName: 'Trip', tagColor: null },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Edit this tag?')).toBeInTheDocument();
      expect(screen.getByText('Current name')).toBeInTheDocument();
      expect(screen.getByText('Trip')).toBeInTheDocument();
      expect(screen.getByText('New name')).toBeInTheDocument();
      expect(screen.getByText('Travel')).toBeInTheDocument();
      // A cleared colour says so; an icon the edit leaves alone is not shown.
      expect(screen.getByText('Colour')).toBeInTheDocument();
      expect(screen.queryByText('Icon')).toBeNull();
    });

    it('says how often a deleted tag is used, with no view link', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'delete_tag',
            status: 'confirmed',
            descriptor: { type: 'delete_tag' },
            preview: { name: 'Trip', tagUseCount: 3 },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Use')).toBeInTheDocument();
      expect(screen.getByText('Used 3 times')).toBeInTheDocument();
      expect(screen.getByText('Tag deleted')).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('links a created tag to the tags page', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'create_tag',
            status: 'confirmed',
            descriptor: { type: 'create_tag' },
            preview: { name: 'Trip', tagColor: '#FF5733', tagIcon: null },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('#FF5733')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'View tags' })).toHaveAttribute(
        'href',
        '/tags',
      );
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

    it('shows the website on a payee card when the action sets one', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'create_payee',
            descriptor: { type: 'create_payee' },
            preview: {
              name: 'Hydro One',
              categoryName: 'Utilities',
              website: 'https://hydroone.com',
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('https://hydroone.com')).toBeInTheDocument();
    });

    it('omits the website row when the edit says nothing about it', () => {
      // A rename that left the address alone must not read as clearing it.
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'update_payee',
            descriptor: { type: 'update_payee' },
            preview: { name: 'Hydro One', categoryName: 'Utilities' },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByText('Website')).toBeNull();
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
  describe('rule effects', () => {
    const effects = {
      changes: {
        categoryId: 'cat-1',
        payeeId: 'pay-1',
        addTagIds: ['tag-1', 'tag-9'],
        removeTagIds: ['tag-2'],
      },
      aiReviewRequests: [{ ruleId: 'r1', instruction: 'Check the receipt' }],
      labels: {
        categories: { 'cat-1': 'Food: Coffee' },
        payees: { 'pay-1': 'Starbucks' },
        tags: { 'tag-1': 'coffee', 'tag-2': 'treat' },
        rules: { r1: 'Coffee' },
      },
    };

    it('lists what the rules will also do on a created transaction, by name', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({ preview: { ...makeAction().preview, ruleEffects: effects } })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const block = screen.getByTestId('rule-effects');
      expect(within(block).getByText('Your rules will also:')).toBeInTheDocument();
      expect(within(block).getByText('Set the category to Food: Coffee')).toBeInTheDocument();
      expect(within(block).getByText('Set the payee to Starbucks')).toBeInTheDocument();
      // A tag that no longer exists reads as a deleted item, never as its id.
      expect(within(block).getByText('Tags added: coffee and a deleted item')).toBeInTheDocument();
      expect(within(block).getByText('Tags removed: treat')).toBeInTheDocument();
      expect(within(block).getByText('Queue 1 AI review request')).toBeInTheDocument();
      expect(block.textContent).not.toMatch(/tag-|cat-1|pay-1/);
    });

    it('lists only the effects that exist', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            preview: {
              ...makeAction().preview,
              ruleEffects: { ...effects, changes: { addTagIds: ['tag-1'], removeTagIds: [] }, aiReviewRequests: [] },
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const block = screen.getByTestId('rule-effects');
      expect(within(block).getAllByRole('listitem')).toHaveLength(1);
      expect(within(block).getByText('Tags added: coffee')).toBeInTheDocument();
    });

    it('lists them on a transfer card too', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            type: 'create_transfer',
            descriptor: { type: 'create_transfer' },
            preview: {
              fromAccountName: 'Checking',
              toAccountName: 'Savings',
              amount: 100,
              currencyCode: 'USD',
              transactionDate: '2026-01-15',
              ruleEffects: effects,
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(within(screen.getByTestId('rule-effects')).getByText('Set the payee to Starbucks')).toBeInTheDocument();
    });

    it('renders nothing when no rule has an effect', () => {
      const { container } = render(
        <TransactionConfirmationCard action={makeAction()} onConfirm={vi.fn()} onCancel={vi.fn()} />,
      );
      expect(screen.queryByTestId('rule-effects')).toBeNull();
      expect(screen.queryByText('Your rules will also:')).toBeNull();
      expect(container.textContent).not.toContain('Your rules');
    });

    it('renders nothing for effects that change nothing', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({
            preview: {
              ...makeAction().preview,
              ruleEffects: { ...effects, changes: { addTagIds: [], removeTagIds: [] }, aiReviewRequests: [] },
            },
          })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('rule-effects')).toBeNull();
    });
  });

  describe('an action type this client does not know', () => {
    it('is titled generically and shows no other action\'s rows', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({ type: 'archive_everything' as never, preview: {} })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Approve this action?')).toBeInTheDocument();
      expect(screen.queryByText('Create this payee?')).toBeNull();
      expect(screen.queryByText('Name')).toBeNull();
    });

    it('confirms it without claiming a payee was created', () => {
      render(
        <TransactionConfirmationCard
          action={makeAction({ type: 'archive_everything' as never, status: 'confirmed' })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('Action completed')).toBeInTheDocument();
    });
  });
});
