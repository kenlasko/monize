import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { SkippedRowsList } from './SkippedRowsList';
import type { ImportSkippedRow } from '@/lib/import';

function row(overrides: Partial<ImportSkippedRow> = {}): ImportSkippedRow {
  return {
    date: '2026-01-15',
    amount: -50,
    currencyCode: 'USD',
    payee: 'Grocery Store',
    reason: 'alreadyImported',
    ...overrides,
  };
}

describe('SkippedRowsList', () => {
  it('renders nothing when no row was skipped', () => {
    const { container } = render(<SkippedRowsList rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a result without the list', () => {
    const { container } = render(<SkippedRowsList rows={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each skipped row by its amount, payee and reason', () => {
    render(
      <SkippedRowsList
        rows={[
          row(),
          row({ amount: -200, payee: 'Savings', reason: 'duplicateTransfer' }),
        ]}
      />,
    );

    expect(screen.getByText('Skipped rows:')).toBeInTheDocument();
    expect(screen.getByText(/-\$50\.00, Grocery Store \(already imported\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/-\$200\.00, Savings \(transfer already recorded\)/),
    ).toBeInTheDocument();
  });

  it('leaves the payee out of a row that has none', () => {
    render(<SkippedRowsList rows={[row({ payee: '' })]} />);

    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent(/-\$50\.00 \(already imported\)$/);
    expect(item).not.toHaveTextContent(',');
  });

  it('shows the row date in the reader format, not the raw ISO date', () => {
    render(<SkippedRowsList rows={[row()]} />);

    const item = screen.getByRole('listitem');
    expect(item.textContent).toMatch(/2026/);
    expect(item.textContent?.startsWith('2026-01-15:')).toBe(false);
  });

  it('names a row whose date could not be read by its row and the date text', () => {
    render(
      <SkippedRowsList
        rows={[
          row({ date: '', reason: 'unreadableDate', rowNumber: 14, rawDate: '13/03/2026', payee: 'Cafe' }),
          row({ date: '', reason: 'unreadableDate', rowNumber: 20, rawDate: '', payee: '' }),
        ]}
      />,
    );

    const [first, second] = screen.getAllByRole('listitem');
    expect(first).toHaveTextContent('Row 14, "13/03/2026": -$50.00, Cafe (date could not be read)');
    expect(second).toHaveTextContent('Row 20: -$50.00 (no date)');
  });

  it('names an investment row the parse rejected by its row, date and what it was missing', () => {
    render(
      <SkippedRowsList
        rows={[
          row({ date: '2026-03-02', amount: 0, payee: '', reason: 'missingProceeds', rowNumber: 4 }),
          row({ date: '2026-03-05', payee: 'Broker', reason: 'missingSecurity', rowNumber: 7 }),
          row({ reason: 'missingQuantity', rowNumber: 8 }),
          row({ reason: 'missingAmount', rowNumber: 9 }),
          row({ reason: 'missingSplitRatio', rowNumber: 10 }),
        ]}
      />,
    );

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/^Row 4, .*2026: \$0\.00 \(sell without price or proceeds\)$/);
    expect(items[1]).toHaveTextContent(/^Row 7, .*2026: -\$50\.00, Broker \(missing security\)$/);
    expect(items[2]).toHaveTextContent('(missing quantity)');
    expect(items[3]).toHaveTextContent('(missing amount)');
    expect(items[4]).toHaveTextContent('(split without ratio)');
  });

  it('shows each amount in the currency of the account its row went into', () => {
    render(<SkippedRowsList rows={[row({ currencyCode: 'EUR' })]} />);

    expect(screen.getByRole('listitem').textContent).toMatch(/€50\.00/);
  });

  it('shows the first 50 rows when no limit is given', () => {
    const rows = Array.from({ length: 52 }, (_, i) => row({ payee: `Payee ${i + 1}` }));
    render(<SkippedRowsList rows={rows} />);

    expect(screen.getByText(/Payee 50 /)).toBeInTheDocument();
    expect(screen.queryByText(/Payee 51 /)).not.toBeInTheDocument();
    expect(screen.getByText('...and 2 more skipped rows')).toBeInTheDocument();
  });

  it('shows the first rows up to the limit and counts the rest', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ amount: -(i + 1), payee: `Payee ${i + 1}` }),
    );
    render(<SkippedRowsList rows={rows} limit={3} />);

    expect(screen.getByText(/Payee 3/)).toBeInTheDocument();
    expect(screen.queryByText(/Payee 4/)).not.toBeInTheDocument();
    expect(screen.getByText('...and 2 more skipped rows')).toBeInTheDocument();
  });

  it('counts the skipped rows the server did not name', () => {
    // The server names the first 50 skipped rows and counts all of them.
    const rows = Array.from({ length: 50 }, (_, i) => row({ payee: `Payee ${i + 1}` }));
    render(<SkippedRowsList rows={rows} total={120} />);

    expect(screen.getByText(/Payee 50 /)).toBeInTheDocument();
    expect(screen.getByText('...and 70 more skipped rows')).toBeInTheDocument();
  });

  it('counts the rest from the total under a limit', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row({ payee: `Payee ${i + 1}` }));
    render(<SkippedRowsList rows={rows} total={120} limit={3} />);

    expect(screen.getByText('...and 117 more skipped rows')).toBeInTheDocument();
  });

  it('adds no count when the total is every named row', () => {
    render(<SkippedRowsList rows={[row(), row()]} total={2} />);

    expect(screen.queryByText(/more skipped rows/)).not.toBeInTheDocument();
  });
});
