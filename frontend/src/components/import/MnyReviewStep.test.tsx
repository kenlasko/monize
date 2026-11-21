import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyReviewStep } from './MnyReviewStep';
import { KMY_FORMAT } from '@/lib/binary-import-format';
import type { MnyPreview, MnyPreviewAccount } from '@/lib/import-mny';

function account(
  overrides: Partial<MnyPreviewAccount> = {},
): MnyPreviewAccount {
  return {
    key: 'acct-1',
    handle: 1,
    name: 'Chequing',
    moneyName: 'Chequing',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'USD',
    transactionCount: 120,
    investmentCount: 0,
    openingBalance: 100,
    finalBalance: 2500.5,
    closed: false,
    favourite: false,
    ...overrides,
  };
}

function preview(overrides: Partial<MnyPreview> = {}): MnyPreview {
  return {
    stagedFileId: 'staged-1',
    filename: 'finances.mny',
    sizeBytes: 1024,
    era: 'moneyPlus',
    passwordProtected: false,
    baseCurrency: 'USD',
    accounts: [account()],
    bills: [],
    counts: {
      accountsIncluded: 1,
      accountsInFile: 3,
      payeesToCreate: 40,
      payeesInFile: 500,
      categoriesToCreate: 30,
      categoriesInFile: 128,
      tagsToCreate: 0,
      tagsInFile: 0,
      transactionsToCreate: 120,
      transfersToLink: 12,
      transactionsSkipped: 0,
      securitiesToCreate: 0,
      securitiesInFile: 0,
      investmentsToCreate: 0,
      investmentsSkipped: 0,
      shareTransfersPaired: 0,
      pricesToImport: 0,
      exchangeRatesToImport: 0,
      billsDetected: 0,
      billsSkipped: 0,
    },
    fileCounts: {
      accounts: 3,
      payees: 500,
      categories: 128,
      securities: 0,
      securityPrices: 0,
      exchangeRates: 0,
      bills: 0,
      transactions: 120,
    },
    missingTables: [],
    missingFields: [],
    warnings: [],
    options: {
      wipeExistingData: false,
      referencedOnlyPayees: true,
      referencedOnlyCategories: true,
      importClosedAccounts: true,
      importPrices: true,
      importExchangeRates: true,
      accounts: [],
      bills: [],
    },
    ...overrides,
  };
}

describe('MnyReviewStep', () => {
  const defaultProps = {
    preview: preview(),
    excludedHandles: new Set<number>(),
    currencyOverrides: new Map<number, string>(),
    selectedBillHandles: new Set<number>(),
    options: preview().options,
    currencyOptions: [
      { value: 'USD', label: 'USD - US Dollar' },
      { value: 'CAD', label: 'CAD - Canadian Dollar' },
    ],
    isLoading: false,
    startError: null,
    onToggleAccount: vi.fn(),
    onSetAllAccounts: vi.fn(),
    onSetAccountCurrency: vi.fn(),
    onToggleBill: vi.fn(),
    onSetAllBills: vi.fn(),
    onSetOption: vi.fn(),
    onSetRename: vi.fn(),
    onBack: vi.fn(),
    onImport: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('names the file, its Money era and its base currency', () => {
    render(<MnyReviewStep {...defaultProps} />);

    // One paragraph carries all three, so match it whole rather than matching
    // "USD" which also appears in every currency dropdown.
    expect(
      screen.getByText(
        /finances\.mny -- Money Plus \/ Sunset format, base currency USD/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the final balance computed from the file, the verification baseline', () => {
    render(<MnyReviewStep {...defaultProps} />);

    expect(screen.getByText('$2,500.50')).toBeInTheDocument();
  });

  it('shows the tags a file\'s classifications become, against the items in the file', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          counts: { ...preview().counts, tagsToCreate: 1, tagsInFile: 2 },
        })}
      />,
    );

    const tile = screen.getByText('Tags from classifications').parentElement;
    expect(tile?.textContent).toContain('1');
    expect(tile?.textContent).toContain('of 2 in the file');
  });

  it('shows referenced-versus-total counts rather than just totals', () => {
    render(<MnyReviewStep {...defaultProps} />);

    expect(screen.getByText('40')).toBeInTheDocument();
    // A file with no classifications shows no tags tile at all.
    expect(screen.queryByText('Tags from classifications')).toBeNull();
    expect(screen.getByText(/of 500 in the file/)).toBeInTheDocument();
  });

  it('toggles an account when its checkbox is clicked', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Import Chequing'));

    expect(defaultProps.onToggleAccount).toHaveBeenCalledWith(1);
  });

  it('dims an excluded account and keeps it listed', () => {
    render(
      <MnyReviewStep {...defaultProps} excludedHandles={new Set([1])} />,
    );

    const checkbox = screen.getByLabelText('Import Chequing') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // Still listed: unticking an account must not hide its numbers.
    expect(checkbox.closest('tr')).toHaveClass('opacity-50');
    expect(screen.getByText('$2,500.50')).toBeInTheDocument();
  });

  it('disables the import button when nothing is selected', () => {
    render(
      <MnyReviewStep {...defaultProps} excludedHandles={new Set([1])} />,
    );

    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
  });

  it('reports a currency override, and clears it when set back to the file value', () => {
    render(<MnyReviewStep {...defaultProps} />);
    const select = screen.getByLabelText('Currency for Chequing');

    fireEvent.change(select, { target: { value: 'CAD' } });
    expect(defaultProps.onSetAccountCurrency).toHaveBeenCalledWith(1, 'CAD');

    fireEvent.change(select, { target: { value: 'USD' } });
    expect(defaultProps.onSetAccountCurrency).toHaveBeenCalledWith(1, null);
  });

  it('marks a closed account and a favourite', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [account({ closed: true, favourite: true })],
        })}
      />,
    );

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Favourite')).toBeInTheDocument();
  });

  it('badges a watch account as excluded from net worth', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [
            account({ excludeFromNetWorth: true }),
            account({ key: 'acct-2', handle: 2, name: 'Visa' }),
          ],
        })}
      />,
    );

    // One badge: the second account (and any response predating the field,
    // where excludeFromNetWorth is absent) draws none.
    expect(screen.getAllByText('Excluded from net worth')).toHaveLength(1);
  });

  it("shows the Money name when the account had to be renamed", () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [account({ name: 'Savings (2)', moneyName: 'Savings' })],
        })}
      />,
    );

    expect(screen.getByText(/named "Savings" in Money/)).toBeInTheDocument();
  });

  it("says which tables this Money version does not have", () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({ missingTables: ['BILL'] })}
      />,
    );

    expect(screen.getByText(/no BILL table/)).toBeInTheDocument();
  });

  it('shows how few of a file\'s bill rows are live series -- the 1,844-rows scenario', () => {
    // PR #192 imported all 1,844 rows. The review step has to make the gap
    // between the file's row count and the real bill count visible before the
    // user commits, not after.
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          counts: { ...preview().counts, billsDetected: 21 },
          fileCounts: { ...preview().fileCounts, bills: 1844 },
        })}
      />,
    );

    expect(screen.getByText('21')).toBeInTheDocument();
    expect(screen.getByText(/active of 1844 bill rows/)).toBeInTheDocument();
  });

  describe('investments', () => {
    const withInvestments = () =>
      preview({
        counts: {
          ...preview().counts,
          securitiesToCreate: 86,
          securitiesInFile: 98,
          investmentsToCreate: 412,
          shareTransfersPaired: 4,
          pricesToImport: 68000,
          exchangeRatesToImport: 120,
        },
        fileCounts: {
          ...preview().fileCounts,
          securities: 98,
          securityPrices: 68000,
          exchangeRates: 120,
        },
        accounts: [account({ investmentCount: 412 })],
      });

    it('summarises the securities, investments, prices and rates', () => {
      render(
        <MnyReviewStep {...defaultProps} preview={withInvestments()} />,
      );

      expect(screen.getByText('86')).toBeInTheDocument();
      expect(screen.getByText('412')).toBeInTheDocument();
      expect(screen.getByText('68000')).toBeInTheDocument();
      expect(screen.getByText(/4 share transfers/)).toBeInTheDocument();
    });

    it('shows an account its investment rows alongside its transactions', () => {
      render(
        <MnyReviewStep {...defaultProps} preview={withInvestments()} />,
      );

      expect(screen.getByText('+ 412 investments')).toBeInTheDocument();
    });

    it('hides the investment summary for a file with no securities', () => {
      render(<MnyReviewStep {...defaultProps} />);

      expect(screen.queryByText('Securities')).not.toBeInTheDocument();
    });

    it('lets the user turn the price and rate history off', () => {
      render(
        <MnyReviewStep {...defaultProps} preview={withInvestments()} />,
      );

      fireEvent.click(screen.getByText('Import price history'));

      expect(defaultProps.onSetOption).toHaveBeenCalledWith(
        'importPrices',
        false,
      );
    });
  });

  it('surfaces mapper warnings with their counts and samples', () => {
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          warnings: [
            {
              code: 'degeneratePayeeSkipped',
              count: 2,
              samples: ['#', '*'],
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByText(/2 placeholder payees Money keeps internally/),
    ).toBeInTheDocument();
    expect(screen.getByText('#, *')).toBeInTheDocument();
  });

  it('toggles an import option', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByLabelText(/Only import payees that are used/));

    expect(defaultProps.onSetOption).toHaveBeenCalledWith(
      'referencedOnlyPayees',
      false,
    );
  });

  it('selects and clears every account at once', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByText('Select none'));
    expect(defaultProps.onSetAllAccounts).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('Select all'));
    expect(defaultProps.onSetAllAccounts).toHaveBeenCalledWith(true);
  });

  it('starts the import and goes back', () => {
    render(<MnyReviewStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    expect(defaultProps.onImport).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  it('cannot untick the cash side Monize adds to an investment pair', () => {
    // It has no Money handle of its own, so there is nothing to exclude.
    render(
      <MnyReviewStep
        {...defaultProps}
        preview={preview({
          accounts: [
            account({
              key: 'acct-1-cash',
              handle: null,
              name: 'TFSA - Cash',
              accountType: 'INVESTMENT',
              accountSubType: 'INVESTMENT_CASH',
            }),
          ],
        })}
      />,
    );

    expect(screen.getByLabelText('Import TFSA - Cash')).toBeDisabled();
  });

  describe('when the import could not be started', () => {
    it('says nothing while there is nothing to say', () => {
      render(<MnyReviewStep {...defaultProps} />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows why, rather than leaving the button looking inert', () => {
      // The regression: a start that failed left the review step unchanged, so
      // pressing Start import appeared to do nothing at all.
      render(
        <MnyReviewStep
          {...defaultProps}
          startError={{
            code: 'mnyImportAlreadyRunning',
            message: 'An import is already running.',
          }}
        />,
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('The import could not be started');
      expect(alert).toHaveTextContent('An import is already running.');
      expect(
        screen.queryByRole('button', { name: 'Upload the file again' }),
      ).not.toBeInTheDocument();
    });

    it('offers a way back to the upload step when the staged file is gone', () => {
      render(
        <MnyReviewStep
          {...defaultProps}
          startError={{
            code: 'mnyStagedFileMissing',
            message: 'The uploaded Money file is no longer available.',
          }}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Upload the file again' }),
      );

      expect(defaultProps.onBack).toHaveBeenCalled();
    });

    it('falls back to generic copy when the backend sent no message', () => {
      render(
        <MnyReviewStep {...defaultProps} startError={{ message: '' }} />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        /Something went wrong while importing/,
      );
    });
  });
});

describe('MnyReviewStep with a KMyMoney import', () => {
  const kmyPreview = (overrides: Partial<MnyPreview> = {}) =>
    preview({
      filename: 'budget.kmy',
      sourceFormat: 'kmy',
      kmyFile: { container: 'gzip', fixVersion: 12, appVersion: '5.1.3', lastModified: null, asOf: '2026-06-01' },
      accounts: [account({ name: 'Savings (2)', moneyName: 'Savings' })],
      ...overrides,
    });
  const props = {
    preview: kmyPreview(),
    excludedHandles: new Set<number>(),
    currencyOverrides: new Map<number, string>(),
    selectedBillHandles: new Set<number>(),
    options: preview().options,
    currencyOptions: [{ value: 'USD', label: 'USD - US Dollar' }],
    isLoading: false,
    startError: null,
    onToggleAccount: vi.fn(),
    onSetAllAccounts: vi.fn(),
    onSetAccountCurrency: vi.fn(),
    onToggleBill: vi.fn(),
    onSetAllBills: vi.fn(),
    onSetOption: vi.fn(),
    onSetRename: vi.fn(),
    onBack: vi.fn(),
    onImport: vi.fn(),
    format: KMY_FORMAT,
  };

  beforeEach(() => vi.clearAllMocks());

  it('heads the step and summarises the file by its format version, with no era', () => {
    render(<MnyReviewStep {...props} />);

    expect(screen.getByRole('heading', { name: 'Review your KMyMoney file' })).toBeInTheDocument();
    expect(
      screen.getByText(/budget\.kmy: KMyMoney file, format version 12, base currency USD/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Money Plus/)).not.toBeInTheDocument();
  });

  it('says the day balances are cut off at, and not for a Money file', () => {
    const { unmount } = render(<MnyReviewStep {...props} />);
    expect(screen.getByText(/Balances are as of .*2026; transactions dated later/)).toBeInTheDocument();
    unmount();

    render(<MnyReviewStep {...props} preview={kmyPreview({ kmyFile: undefined })} />);
    expect(screen.queryByText(/Balances are as of/)).not.toBeInTheDocument();
  });

  it('never shows the missing-tables notice or the unsupported-bills note', () => {
    render(
      <MnyReviewStep
        {...props}
        preview={kmyPreview({ missingTables: ['BILL', 'LOT'] })}
      />,
    );

    expect(screen.queryByText(/has no .* table/)).not.toBeInTheDocument();
    expect(screen.queryByText(/predates scheduled bills/)).not.toBeInTheDocument();
  });

  it('says where a renamed account was named in KMyMoney', () => {
    render(<MnyReviewStep {...props} />);

    expect(screen.getByText('named "Savings" in KMyMoney')).toBeInTheDocument();
  });

  it('words the tags and schedules tiles for KMyMoney', () => {
    render(
      <MnyReviewStep
        {...props}
        preview={kmyPreview({
          counts: { ...preview().counts, tagsToCreate: 2, tagsInFile: 3, billsDetected: 4 },
          fileCounts: { ...preview().fileCounts, bills: 9 },
        })}
      />,
    );

    expect(screen.getByText('Tags')).toBeInTheDocument();
    expect(screen.getByText('Scheduled transactions')).toBeInTheDocument();
    expect(screen.getByText('active of 9 scheduled transactions')).toBeInTheDocument();
  });

  it('shows a payee aliases tile with the default category count when either is above zero', () => {
    const { rerender } = render(<MnyReviewStep {...props} />);
    expect(screen.queryByText('Payee aliases')).not.toBeInTheDocument();

    rerender(
      <MnyReviewStep
        {...props}
        preview={kmyPreview({
          counts: { ...preview().counts, payeeAliasesToCreate: 12, payeeDefaultCategoriesToSet: 3 },
        })}
      />,
    );
    expect(screen.getByText('Payee aliases')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3 payees get a default category')).toBeInTheDocument();

    rerender(
      <MnyReviewStep
        {...props}
        preview={kmyPreview({
          counts: { ...preview().counts, payeeAliasesToCreate: 0, payeeDefaultCategoriesToSet: 1 },
        })}
      />,
    );
    expect(screen.getByText('1 payee gets a default category')).toBeInTheDocument();
  });

  it('shows no payee aliases tile for a Money preview even if the counts were present', () => {
    render(
      <MnyReviewStep
        {...props}
        format={undefined}
        preview={preview({
          counts: { ...preview().counts, payeeAliasesToCreate: 12, payeeDefaultCategoriesToSet: 3 },
        })}
      />,
    );
    expect(screen.queryByText('Payee aliases')).not.toBeInTheDocument();
  });

  it('uses the KMyMoney hints on the options', () => {
    render(<MnyReviewStep {...props} />);

    expect(screen.getByText(/KMyMoney keeps payees after their last transaction/)).toBeInTheDocument();
    expect(screen.getByText(/KMyMoney creates its category tree from a template/)).toBeInTheDocument();
    expect(screen.getByText(/KMyMoney's own record of what each security was worth/)).toBeInTheDocument();
    expect(screen.getByText(/add the KMyMoney file to what you already have/)).toBeInTheDocument();
  });

  it('offers to upload again when the KMyMoney staged file is gone', () => {
    render(
      <MnyReviewStep
        {...props}
        startError={{ code: 'kmyStagedFileMissing', message: 'The uploaded KMyMoney file is no longer available.' }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Upload the file again' })).toBeInTheDocument();
  });

  it('falls back to the generic failure sentence with the KMyMoney guide link', () => {
    render(<MnyReviewStep {...props} startError={{ message: '' }} />);

    expect(screen.getByText(/Something went wrong while importing/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Learn more' }).getAttribute('href')).toContain(
      'troubleshooting-the-kmymoney-import',
    );
  });

  describe('names too long for Monize (issue #2313)', () => {
    const sepa = `SEPA-LASTSCHRIFT ${'Mandatsreferenz MR-0042 '.repeat(15)}`.trim();
    const shortened = sepa.slice(0, 255).trimEnd();
    const nameFixes = {
      entries: [
        {
          kind: 'payee' as const,
          handle: 2,
          original: sepa,
          originalLength: sepa.length,
          maxLength: 255,
        },
      ],
      omitted: 0,
    };
    const withFixes = (name: string, omitted = 0) => ({
      ...props,
      preview: kmyPreview({ nameFixes: { ...nameFixes, omitted } }),
      options: {
        ...preview().options,
        renames: [{ kind: 'payee' as const, handle: 2, name }],
      },
    });

    it('lists each one with the name the import will use, editable within its column', () => {
      render(<MnyReviewStep {...withFixes(shortened)} />);

      expect(
        screen.getByRole('heading', { name: '1 name is too long for Monize' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Payee')).toBeInTheDocument();
      expect(screen.getByText(sepa)).toBeInTheDocument();
      const input = screen.getByRole('textbox', {
        name: 'Payee: name in Monize',
      });
      expect(input).toHaveValue(shortened);
      expect(input).toHaveAttribute('maxLength', '255');
      expect(screen.getByRole('button', { name: 'Start import' })).toBeEnabled();
    });

    it('reports an edit as the rename for that element', () => {
      render(<MnyReviewStep {...withFixes(shortened)} />);

      fireEvent.change(
        screen.getByRole('textbox', { name: 'Payee: name in Monize' }),
        { target: { value: 'Stadtwerke' } },
      );

      expect(props.onSetRename).toHaveBeenCalledWith({
        kind: 'payee',
        handle: 2,
        name: 'Stadtwerke',
      });
    });

    it('will not start with a cleared name', () => {
      render(<MnyReviewStep {...withFixes('   ')} />);

      expect(screen.getByText('Enter a name.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
    });

    it('counts the names past the list that are shortened automatically', () => {
      render(<MnyReviewStep {...withFixes(shortened, 3)} />);

      expect(
        screen.getByText('3 more names are too long and will be shortened to fit.'),
      ).toBeInTheDocument();
    });

    it('marks a name the preview carries only the start of, with its whole length', () => {
      render(
        <MnyReviewStep
          {...withFixes(shortened)}
          preview={kmyPreview({
            nameFixes: {
              entries: [{ ...nameFixes.entries[0], original: 'SEPA', originalLength: 5000 }],
              omitted: 0,
            },
          })}
        />,
      );

      expect(screen.getByText(/^SEPA\u2026/)).toBeInTheDocument();
      expect(screen.getByText('5,000 characters')).toBeInTheDocument();
    });

    it('shows nothing when every name fits', () => {
      render(<MnyReviewStep {...props} />);

      expect(screen.queryByText(/too long for Monize/)).not.toBeInTheDocument();
    });
  });
});
