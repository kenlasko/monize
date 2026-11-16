import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import type { ImportDuplicateReviewFile } from '@/app/import/import-utils';
import type { ImportDuplicateRow } from '@/lib/import';
import { DuplicatesStep } from './DuplicatesStep';

function pair(over: Partial<ImportDuplicateRow> = {}): ImportDuplicateRow {
  return {
    row: 0,
    transactionDate: '2026-01-15',
    amount: -80,
    payee: 'HYDRO ONE',
    memo: 'Statement line',
    referenceNumber: 'CHQ 1042',
    existingTransaction: {
      id: 'tx-manual',
      transactionDate: '2026-01-13',
      amount: '-80.0000',
      payeeName: 'Hydro bill',
      categoryName: 'Utilities',
      description: null,
      referenceNumber: null,
      status: 'UNRECONCILED',
      isTransfer: false,
      isSplit: false,
      transferAccountName: null,
    },
    duplicateActions: ['import', 'merge', 'keep', 'replace'],
    ...over,
  };
}

const review = (rows: ImportDuplicateRow[], fileIndex = 0): ImportDuplicateReviewFile => ({
  fileIndex,
  fileName: `file-${fileIndex}.ofx`,
  accountName: 'Checking',
  currencyCode: 'USD',
  rows,
});

describe('DuplicatesStep', () => {
  it('shows each row of the file beside the transaction it looks like', () => {
    render(<DuplicatesStep review={[review([pair()])]} isLoading={false} onBack={vi.fn()} onImport={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '1 possible duplicate' })).toBeInTheDocument();
    expect(screen.getByText('HYDRO ONE')).toBeInTheDocument();
    expect(screen.getByText('Statement line')).toBeInTheDocument();
    // The file row's check number, which often tells two equal amounts apart.
    expect(screen.getByText('CHQ 1042')).toBeInTheDocument();
    expect(screen.getByText('Hydro bill')).toBeInTheDocument();
    expect(screen.getByText('Utilities')).toBeInTheDocument();
  });

  it('keeps every row unless the person chooses otherwise, and sends a decision for each', () => {
    const onImport = vi.fn();
    render(
      <DuplicatesStep
        review={[review([pair(), pair({ row: 3, existingTransaction: { ...pair().existingTransaction, id: 'tx-2' } })])]}
        isLoading={false}
        onBack={vi.fn()}
        onImport={onImport}
      />,
    );
    const groups = screen.getAllByRole('group');
    expect(within(groups[0]).getByRole('radio', { name: /Keep mine/ })).toBeChecked();
    fireEvent.click(within(groups[1]).getByRole('radio', { name: /^Merge/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onImport).toHaveBeenCalledWith(
      new Map([
        [
          0,
          [
            { row: 0, transactionId: 'tx-manual', action: 'keep' },
            { row: 3, transactionId: 'tx-2', action: 'merge' },
          ],
        ],
      ]),
    );
  });

  it('offers only the actions the pair allows, and has no "later" for a file', () => {
    render(
      <DuplicatesStep
        review={[review([pair({ duplicateActions: ['import', 'keep'] })])]}
        isLoading={false}
        onBack={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /Decide later/ })).not.toBeInTheDocument();
  });

  it('names each file when several have pairs, and goes back on Back', () => {
    const onBack = vi.fn();
    render(
      <DuplicatesStep
        review={[review([pair()], 0), review([pair()], 2)]}
        isLoading={false}
        onBack={onBack}
        onImport={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'file-0.ofx into Checking' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'file-2.ofx into Checking' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });
});
