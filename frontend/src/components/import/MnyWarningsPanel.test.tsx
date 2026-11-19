import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyWarningsPanel } from './MnyWarningsPanel';
import { KMY_FORMAT } from '@/lib/binary-import-format';
import type { MnyFlaggedRow, MnyWarningSummary } from '@/lib/import-mny';

function flaggedRow(overrides: Partial<MnyFlaggedRow> = {}): MnyFlaggedRow {
  return {
    handle: 101,
    accountName: 'Chequing',
    date: '2024-03-15',
    amount: -250.5,
    currencyCode: 'CAD',
    payeeName: 'Acme Supplies',
    reference: null,
    memo: null,
    detail: 'legs -300 vs total -250.5',
    ...overrides,
  };
}

function warning(
  overrides: Partial<MnyWarningSummary> = {},
): MnyWarningSummary {
  return {
    code: 'splitSumMismatch',
    count: 2,
    samples: ['htrn=101', 'htrn=102'],
    rows: [flaggedRow(), flaggedRow({ handle: 102, date: '2024-02-15' })],
    rowsTruncated: false,
    ...overrides,
  };
}

function renderPanel(warnings: MnyWarningSummary[]) {
  return render(<MnyWarningsPanel warnings={warnings} heading="Warnings" />);
}

describe('MnyWarningsPanel', () => {
  it('renders nothing when there are no warnings', () => {
    const { container } = renderPanel([]);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the grouped count and the samples', () => {
    renderPanel([warning()]);

    expect(
      screen.getByText(/2 splits had legs that do not add up/),
    ).toBeInTheDocument();
    expect(screen.getByText('htrn=101, htrn=102')).toBeInTheDocument();
  });

  describe('the flagged transaction list', () => {
    it('starts collapsed', () => {
      renderPanel([warning()]);

      expect(screen.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(screen.queryByText('Acme Supplies')).toBeNull();
    });

    it('expands to the transactions behind the warning', () => {
      // The point of the whole panel: a count says something is wrong, this
      // says which transactions to go and fix in Money.
      renderPanel([warning()]);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(screen.getAllByText('Acme Supplies')).toHaveLength(2);
      expect(screen.getAllByText('Chequing')).toHaveLength(2);
      expect(
        screen.getAllByText('legs -300 vs total -250.5'),
      ).toHaveLength(2);
    });

    it('collapses again', () => {
      renderPanel([warning()]);
      const toggle = screen.getByRole('button');

      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Acme Supplies')).toBeNull();
    });

    it('tells the user how to act on the list', () => {
      renderPanel([warning()]);

      fireEvent.click(screen.getByRole('button'));

      expect(
        screen.getByText(/Open these in Microsoft Money/),
      ).toBeInTheDocument();
    });

    it('says the list is partial when the server capped it', () => {
      // Never let a capped list read as the whole of the problem.
      renderPanel([
        warning({ count: 3265, rows: [flaggedRow()], rowsTruncated: true }),
      ]);

      fireEvent.click(screen.getByRole('button'));

      expect(
        screen.getByText(/Showing the first 1 of 3265/),
      ).toBeInTheDocument();
    });

    it('falls back to the Money handle when the row has no detail', () => {
      renderPanel([warning({ rows: [flaggedRow({ detail: null })] })]);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('htrn=101')).toBeInTheDocument();
    });

    it('shows the cheque number and memo, which is how Money is searched', () => {
      renderPanel([
        warning({
          rows: [flaggedRow({ reference: '204', memo: 'Quarterly premium' })],
        }),
      ]);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Ref 204')).toBeInTheDocument();
      expect(screen.getByText('Quarterly premium')).toBeInTheDocument();
    });

    it('marks the fields Money left empty rather than showing blanks', () => {
      renderPanel([
        warning({
          rows: [
            flaggedRow({ date: null, accountName: null, payeeName: null }),
          ],
        }),
      ]);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getAllByText('Not set')).toHaveLength(3);
    });
  });

  describe('warnings that are not about a transaction', () => {
    it('explains when a loan interest category cannot be inferred', () => {
      renderPanel([
        warning({
          code: 'loanInterestCategoryUnclear',
          count: 1,
          samples: ['Mortgage'],
          rows: [],
        }),
      ]);

      expect(
        screen.getByText(/loan's interest category was left unset/),
      ).toBeInTheDocument();
      expect(screen.getByText('Mortgage')).toBeInTheDocument();
    });

    it('renders as a plain line with no expander', () => {
      renderPanel([
        {
          code: 'missingTable',
          count: 1,
          samples: ['BILL'],
          rows: [],
          rowsTruncated: false,
        },
      ]);

      expect(screen.queryByRole('button')).toBeNull();
      expect(
        screen.getByText(/This Money version has no 1 table/),
      ).toBeInTheDocument();
    });

    it('renders as a plain line when the backend sent no rows field', () => {
      // A report polled from a backend that predates flagged rows.
      renderPanel([{ code: 'missingTable', count: 1, samples: [] }]);

      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});

describe('MnyWarningsPanel with a KMyMoney import', () => {
  const renderKmy = (warnings: MnyWarningSummary[]) =>
    render(<MnyWarningsPanel warnings={warnings} heading="Warnings" format={KMY_FORMAT} />);

  it('reads the KMyMoney sentence for the code', () => {
    renderKmy([warning({ code: 'unbalancedTransaction', count: 3, rows: [] })]);

    expect(screen.getByText(/3 transactions do not balance \(KMyMoney marks them/)).toBeInTheDocument();
  });

  it('points the footer at KMyMoney, in full and truncated', () => {
    renderKmy([warning({ code: 'singleSplitTransaction' })]);
    fireEvent.click(screen.getByRole('button'));
    expect(
      screen.getByText('Open these in KMyMoney to check or correct them, then save and import again.'),
    ).toBeInTheDocument();
  });

  it('says how many of the flagged rows are shown when truncated', () => {
    renderKmy([warning({ code: 'singleSplitTransaction', count: 90, rowsTruncated: true })]);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/Showing the first 2 of 90. Open these in KMyMoney/)).toBeInTheDocument();
  });
});
