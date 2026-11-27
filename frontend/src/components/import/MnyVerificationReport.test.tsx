import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyVerificationReport } from './MnyVerificationReport';
import { KMY_FORMAT } from '@/lib/binary-import-format';
import type {
  MnyAccountVerification,
  MnyHoldingVerification,
  MnyImportResult,
} from '@/lib/import-mny';

function line(
  overrides: Partial<MnyAccountVerification> = {},
): MnyAccountVerification {
  return {
    accountName: 'Chequing',
    accountType: 'CHEQUING',
    accountId: 'acct-uuid',
    expectedBalance: 2500.5,
    importedBalance: 2500.5,
    delta: 0,
    transactionCount: 120,
    matches: true,
    ...overrides,
  };
}

function holding(
  overrides: Partial<MnyHoldingVerification> = {},
): MnyHoldingVerification {
  return {
    accountName: 'Brokerage - Investments',
    symbol: 'VOO',
    lotQuantity: 137.5,
    replayQuantity: 137.5,
    importedQuantity: 137.5,
    delta: 0,
    matches: true,
    ...overrides,
  };
}

function result(overrides: Partial<MnyImportResult> = {}): MnyImportResult {
  return {
    accountsCreated: 3,
    payeesCreated: 40,
    categoriesCreated: 30,
    tagsCreated: 0,
    tagLinksApplied: 0,
    transactionsCreated: 120,
    splitsCreated: 8,
    transfersLinked: 12,
    securitiesCreated: 0,
    investmentTransactionsCreated: 0,
    pricesImported: 0,
    exchangeRatesImported: 0,
    billsCreated: 0,
    skipped: {
      accounts: 0,
      payees: 0,
      categories: 0,
      tags: 0,
      transactions: 0,
      bills: 0,
    },
    existingDataRemoved: false,
    holdings: [],
    verification: [line()],
    warnings: [],
    ...overrides,
  };
}

describe('MnyVerificationReport', () => {
  const defaultProps = {
    result: result(),
    currencyCode: 'USD',
    filename: 'finances.mny',
    onDone: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('leads with the reconciliation verdict, not the counts', () => {
    render(<MnyVerificationReport {...defaultProps} />);

    expect(
      screen.getByText(/All 1 accounts reconcile/),
    ).toBeInTheDocument();
  });

  it('names how many accounts differ when some do', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          verification: [
            line(),
            line({
              accountName: 'Savings',
              importedBalance: 2400,
              expectedBalance: 2500,
              delta: -100,
              matches: false,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText(/1 accounts do not match/)).toBeInTheDocument();
    expect(screen.getByText('Check')).toBeInTheDocument();
  });

  it('shows both balances and the difference per account', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          verification: [
            line({
              expectedBalance: 2500,
              importedBalance: 2400,
              delta: -100,
              matches: false,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('$2,500.00')).toBeInTheDocument();
    expect(screen.getByText('$2,400.00')).toBeInTheDocument();
    expect(screen.getByText('-$100.00')).toBeInTheDocument();
  });

  it('reports what was created', () => {
    render(<MnyVerificationReport {...defaultProps} />);

    // "120" also appears as the account's transaction count in the table, so
    // read the tiles by their labels.
    const tileValue = (label: string) =>
      screen.getByText(label).parentElement?.textContent;
    expect(tileValue('Transfers')).toContain('12');
    expect(tileValue('Split legs')).toContain('8');
    expect(tileValue('Payees')).toContain('40');
  });

  it('shows how many rows were tagged from classifications, even when every tag already existed', () => {
    const { unmount } = render(<MnyVerificationReport {...defaultProps} />);
    expect(screen.queryByText('Rows tagged from classifications')).toBeNull();
    unmount();

    // A re-import into a populated profile creates no tag but links rows to
    // the existing ones; the count of links is what tells the user it worked.
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({ tagsCreated: 0, tagLinksApplied: 67 })}
      />,
    );
    const tileValue = (label: string) =>
      screen.getByText(label).parentElement?.textContent;
    expect(tileValue('Rows tagged from classifications')).toContain('67');
  });

  it('says so when existing data was wiped first', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({ existingDataRemoved: true })}
      />,
    );

    expect(
      screen.getByText(/Your existing data was removed before this import/),
    ).toBeInTheDocument();
  });

  it('shows how many bond purchases were imported without a series', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({ bondRowsWithoutSeries: 1 })}
      />,
    );
    expect(
      screen.getByText(/1 bond purchase was imported without a series/),
    ).toBeInTheDocument();
  });

  it('says how many rows a Money file\'s Transfer category was left off', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({ categoriesNotFitting: 2 })}
      />,
    );
    expect(
      screen.getByText(/2 transactions or split lines were imported without a category/),
    ).toBeInTheDocument();
  });

  it('shows no bond series line when the count is absent', () => {
    render(<MnyVerificationReport {...defaultProps} />);
    expect(screen.queryByText(/imported without a series/)).not.toBeInTheDocument();
  });

  it('lists warnings with their counts', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          warnings: [
            { code: 'balanceMismatch', count: 3, samples: ['Savings'] },
          ],
        })}
      />,
    );

    expect(
      screen.getByText(/3 accounts ended with a balance that differs/),
    ).toBeInTheDocument();
  });

  it('finishes on request', () => {
    render(<MnyVerificationReport {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(defaultProps.onDone).toHaveBeenCalled();
  });

  describe('holdings', () => {
    it('shows nothing when the file carried no tax lots', () => {
      render(<MnyVerificationReport {...defaultProps} />);

      expect(
        screen.queryByText('Holdings verification'),
      ).not.toBeInTheDocument();
    });

    it('reconciles each holding against the shares Money records', () => {
      render(
        <MnyVerificationReport
          {...defaultProps}
          result={result({ holdings: [holding()] })}
        />,
      );

      expect(screen.getByText('Holdings verification')).toBeInTheDocument();
      expect(screen.getByText('VOO')).toBeInTheDocument();
      // Money's lots and Monize's holding, both through the shared quantity
      // formatter so the report reads in the user's number locale.
      expect(screen.getAllByText('137.5')).toHaveLength(2);
    });

    // A wrong share count is exactly the PR #192 failure mode, so it has to be
    // visible in the verdict, not only in a row far down the page.
    it('says so in the banner when only the holdings disagree', () => {
      render(
        <MnyVerificationReport
          {...defaultProps}
          result={result({
            holdings: [
              holding({ importedQuantity: 60, delta: -60, matches: false }),
            ],
          })}
        />,
      );

      expect(
        screen.getByText(/1 holding does not match the shares/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/All 1 accounts reconcile/)).toBeNull();
    });

    it('keeps the all-clear verdict when every holding matches', () => {
      render(
        <MnyVerificationReport
          {...defaultProps}
          result={result({ holdings: [holding()] })}
        />,
      );

      expect(screen.getByText(/All 1 accounts reconcile/)).toBeInTheDocument();
    });

    it('counts the investment rows it created', () => {
      render(
        <MnyVerificationReport
          {...defaultProps}
          result={result({
            securitiesCreated: 86,
            investmentTransactionsCreated: 412,
            pricesImported: 68000,
          })}
        />,
      );

      expect(screen.getByText('86')).toBeInTheDocument();
      expect(screen.getByText('412')).toBeInTheDocument();
      expect(screen.getByText('68000')).toBeInTheDocument();
    });
  });

  describe('report download', () => {
    const createObjectURL = vi.fn(() => 'blob:report');
    const revokeObjectURL = vi.fn();
    let clickSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      Object.defineProperty(URL, 'createObjectURL', {
        value: createObjectURL,
        writable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: revokeObjectURL,
        writable: true,
      });
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);
    });

    afterEach(() => clickSpy.mockRestore());

    it('downloads the full result as JSON, named after the file', () => {
      // A user chasing a discrepancy needs the numbers, not a screenshot.
      render(<MnyVerificationReport {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: 'Download report' }));

      expect(createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
    });
  });

  it('badges loan and mortgage lines so they are findable in a long table', () => {
    // Loans are where PR #192's phantom-row filter silently produced empty
    // accounts, so a user checking this report has to be able to spot them.
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({
          verification: [
            line(),
            line({ accountName: 'Mortgage', accountType: 'MORTGAGE' }),
          ],
        })}
      />,
    );

    // Two matches: the account's own name, and the type badge beside it. The
    // chequing line above it gets no badge at all.
    expect(screen.getAllByText('Mortgage')).toHaveLength(2);
    expect(screen.queryByText('Chequing Account')).not.toBeInTheDocument();
  });

  it('counts the scheduled bills it created', () => {
    render(
      <MnyVerificationReport
        {...defaultProps}
        result={result({ billsCreated: 21 })}
      />,
    );

    expect(screen.getByText('Scheduled bills')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
  });
});

describe('MnyVerificationReport with a KMyMoney import', () => {
  const props = {
    result: result({
      holdings: [holding()],
      verification: [
        line({ expectedBalance: 100, importedBalance: 100, mappedBalance: 100 }),
      ],
    }),
    currencyCode: 'USD',
    filename: 'budget.kmy',
    onDone: vi.fn(),
    format: KMY_FORMAT,
  };

  beforeEach(() => vi.clearAllMocks());

  it('reconciles against the KMyMoney file and labels the columns for it', () => {
    render(<MnyVerificationReport {...props} />);

    expect(
      screen.getByText(/every balance matches the one computed from your KMyMoney file/),
    ).toBeInTheDocument();
    expect(screen.getByText('From KMyMoney file')).toBeInTheDocument();
    expect(screen.getByText('Shares in KMyMoney')).toBeInTheDocument();
    expect(screen.getByText(/against the share balance KMyMoney computes/)).toBeInTheDocument();
  });

  it('words a balance difference and a holdings difference for KMyMoney', () => {
    const { rerender } = render(
      <MnyVerificationReport
        {...props}
        result={result({ verification: [line({ matches: false, delta: 5 })] })}
      />,
    );
    expect(screen.getByText(/^1 account does not match the balance computed from your KMyMoney file/)).toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        result={result({ holdings: [holding({ matches: false, delta: 1 })] })}
      />,
    );
    expect(screen.getByText(/not match the shares computed from your KMyMoney file/)).toBeInTheDocument();
  });

  it('shows the payee alias and default category tiles when the counts are above zero', () => {
    const { rerender } = render(<MnyVerificationReport {...props} />);
    expect(screen.queryByText('Payee aliases')).not.toBeInTheDocument();
    expect(screen.queryByText('Default categories')).not.toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        result={result({ payeeAliasesCreated: 7, payeeDefaultCategoriesSet: 0 })}
      />,
    );
    expect(screen.getByText('Payee aliases')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('Default categories')).not.toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        result={result({ payeeAliasesCreated: 0, payeeDefaultCategoriesSet: 3 })}
      />,
    );
    expect(screen.queryByText('Payee aliases')).not.toBeInTheDocument();
    expect(screen.getByText('Default categories')).toBeInTheDocument();
  });

  it('never shows the payee tiles for a Money report, whatever the counts', () => {
    render(
      <MnyVerificationReport
        result={result({ payeeAliasesCreated: 7, payeeDefaultCategoriesSet: 3 })}
        currencyCode="USD"
        filename="finances.mny"
        onDone={vi.fn()}
      />,
    );
    expect(screen.queryByText('Payee aliases')).not.toBeInTheDocument();
    expect(screen.queryByText('Default categories')).not.toBeInTheDocument();
  });

  it('shows what the import rows sum to only when it differs from the file figure', () => {
    const { rerender } = render(<MnyVerificationReport {...props} />);
    expect(screen.queryByText(/Import rows sum to/)).not.toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        result={result({
          verification: [
            line({ expectedBalance: 100, importedBalance: 100, mappedBalance: 90, mappedDiffers: true }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Import rows sum to $90.00')).toBeInTheDocument();
  });

  it('words one reconciled account and several differing accounts in the singular and the plural', () => {
    const { rerender } = render(<MnyVerificationReport {...props} />);
    expect(screen.getByText(/^Your only account reconciles: every balance matches/)).toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        result={result({ verification: [line(), line({ accountName: 'Savings' })] })}
      />,
    );
    expect(screen.getByText(/^All 2 accounts reconcile: every balance matches/)).toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        result={result({
          verification: [line({ matches: false, delta: 5 }), line({ accountName: 'Savings', matches: false, delta: 5 })],
        })}
      />,
    );
    expect(screen.getByText(/^2 accounts do not match the balance/)).toBeInTheDocument();
  });

  it('formats the payee tiles with the reader\'s number format', () => {
    render(
      <MnyVerificationReport
        {...props}
        result={result({ payeeAliasesCreated: 1234, payeeDefaultCategoriesSet: 5678 })}
      />,
    );
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('5,678')).toBeInTheDocument();
  });

  it.each([
    ['the backend says the mapped balance differs', true, true],
    ['the backend says it does not, whatever the figures', false, false],
    ['the backend sent no verdict', undefined, false],
  ])('shows the mapped line by the backend verdict alone: %s', (_label, differs, shown) => {
    render(
      <MnyVerificationReport
        {...props}
        result={result({
          verification: [
            line({ expectedBalance: 100, importedBalance: 100, mappedBalance: 90, mappedDiffers: differs }),
          ],
        })}
      />,
    );
    expect(screen.queryByText(/Import rows sum to/) !== null).toBe(shown);
  });

  it('formats each account in its own currency, falling back to the base currency', () => {
    render(
      <MnyVerificationReport
        {...props}
        result={result({
          verification: [
            line({ accountName: 'Euro', expectedBalance: 10, importedBalance: 10, currencyCode: 'EUR' }),
            line({ accountName: 'Base', expectedBalance: 20, importedBalance: 20 }),
          ],
        })}
      />,
    );
    expect(screen.getAllByText('€10.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$20.00').length).toBeGreaterThan(0);
  });

  it('says the day the figures are cut off at, for KMyMoney only', () => {
    const { rerender } = render(
      <MnyVerificationReport {...props} result={result({ fileAsOf: '2026-06-01', verification: [line()] })} />,
    );
    expect(screen.getByText(/^Balances and share counts are as of .*2026/)).toBeInTheDocument();

    rerender(<MnyVerificationReport {...props} result={result({ verification: [line()] })} />);
    expect(screen.queryByText(/Balances and share counts are as of/)).not.toBeInTheDocument();

    rerender(
      <MnyVerificationReport
        {...props}
        format={undefined}
        result={result({ fileAsOf: '2026-06-01', verification: [line()] })}
      />,
    );
    expect(screen.queryByText(/Balances and share counts are as of/)).not.toBeInTheDocument();
  });

  it('names the report after the file with .kmy and .xml stripped', () => {
    const createObjectURL = vi.fn(() => 'blob:report');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
    const names: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });

    const { rerender } = render(<MnyVerificationReport {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
    rerender(<MnyVerificationReport {...props} filename="budget.xml" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));

    expect(names).toEqual(['budget-import-report.json', 'budget-import-report.json']);
    clickSpy.mockRestore();
  });
});
