import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, cleanup } from '@/test/render';
import { ReconcileTable } from './ReconcileTable';
import type { ComponentProps } from 'react';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { useDateDisplayStore } from '@/store/dateDisplayStore';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    dateFormat: 'browser',
    datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => String(d),
    formatDateWithoutYear: (d: string) => String(d).slice(5),
  }),
}));

function row(overrides: Partial<Transaction> & { id: string }): Transaction {
  return {
    transactionDate: '2026-02-01',
    amount: '-10.0000' as unknown as number,
    status: TransactionStatus.UNRECONCILED,
    payee: null,
    payeeName: null,
    category: null,
    ...overrides,
  } as Transaction;
}

const transactions = [
  row({ id: 'tx-c', transactionDate: '2026-02-10', amount: '-120.5000' as unknown as number, payeeName: 'Electric Co', status: TransactionStatus.CLEARED }),
  row({ id: 'tx-a', transactionDate: '2026-02-01', amount: '-50.2500' as unknown as number, payeeName: 'Grocery' }),
  row({ id: 'tx-b', transactionDate: '2026-02-05', amount: '3000.0000' as unknown as number, payeeName: 'Salary' }),
];

const defaults: ComponentProps<typeof ReconcileTable> = {
  transactions,
  selectedIds: new Set<string>(),
  onToggle: vi.fn(),
  sortField: 'date',
  sortDirection: 'asc',
  onSort: vi.fn(),
  groupByFlow: false,
  lastReconciledDate: null,
  overdueBefore: '2026-01-01',
  formatCurrency: (a: number | string | null | undefined) => `$${Number(a).toFixed(2)}`,
  moneyDecimals: 4,
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onCycleStatus: vi.fn(),
  reconciledLocked: false,
};

function renderTable(props: Partial<ComponentProps<typeof ReconcileTable>> = {}) {
  return render(<ReconcileTable {...defaults} {...props} />);
}

function renderedIds(): string[] {
  return screen
    .getAllByTestId(/^reconcile-row-/)
    .map((el) => el.getAttribute('data-testid')!.replace('reconcile-row-', ''));
}

describe('ReconcileTable', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('sorting', () => {
    it('renders in the order the active sort asks for', () => {
      renderTable();
      expect(renderedIds()).toEqual(['tx-a', 'tx-b', 'tx-c']);
    });

    it('honours a different column and direction', () => {
      renderTable({ sortField: 'amount', sortDirection: 'desc' });
      expect(renderedIds()).toEqual(['tx-b', 'tx-a', 'tx-c']);
    });

    it('asks the host to sort when a header is clicked', () => {
      renderTable();
      fireEvent.click(screen.getByText('Payee'));
      expect(defaults.onSort).toHaveBeenCalledWith('payee');
    });

    it('offers every data column as a sort target', () => {
      renderTable();
      for (const [label, field] of [
        ['Date', 'date'],
        ['Payee', 'payee'],
        ['Category', 'category'],
        ['Amount', 'amount'],
        ['Status', 'status'],
      ] as const) {
        fireEvent.click(screen.getByText(label));
        expect(defaults.onSort).toHaveBeenCalledWith(field);
      }
    });
  });

  describe('grouping', () => {
    it('draws no group headings when grouping is off', () => {
      renderTable();
      expect(screen.queryByText(/Money in/)).not.toBeInTheDocument();
    });

    it('splits into money in and money out with subtotals', () => {
      renderTable({ groupByFlow: true });
      expect(screen.getByText('Money in (1)')).toBeInTheDocument();
      expect(screen.getByText('Money out (2)')).toBeInTheDocument();
      expect(screen.getByText('Group subtotal $3000.00')).toBeInTheDocument();
      expect(screen.getByText('Group subtotal $-170.75')).toBeInTheDocument();
    });

    it('keeps every row when grouping', () => {
      renderTable({ groupByFlow: true });
      expect(renderedIds().sort()).toEqual(['tx-a', 'tx-b', 'tx-c']);
    });
  });

  describe('selection', () => {
    it('toggles from a click anywhere on the row', () => {
      renderTable();
      fireEvent.click(screen.getByTestId('reconcile-row-tx-a'));
      expect(defaults.onToggle).toHaveBeenCalledWith('tx-a');
    });

    it('toggles once, not twice, from the checkbox itself', () => {
      // The checkbox sits inside a row that also toggles; without
      // stopPropagation the click would select and immediately deselect.
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByRole('checkbox'));
      expect(defaults.onToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe('row actions (long-press / right-click sheet)', () => {
    const sheet = () => screen.getByRole('dialog');

    it('offers edit and delete inline from sm up, without toggling the row', () => {
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByLabelText('Edit'));
      expect(defaults.onEdit).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
      fireEvent.click(within(rowEl).getByLabelText('Delete'));
      expect(defaults.onDelete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
      expect(defaults.onToggle).not.toHaveBeenCalled();
    });

    it('collapses the actions column below sm -- phones use the sheet instead', () => {
      renderTable();
      const cell = within(screen.getByTestId('reconcile-row-tx-a'))
        .getByLabelText('Edit')
        .closest('td')!;
      expect(cell.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['hidden', 'sm:table-cell']),
      );
    });

    it('withholds the inline actions on a reconciled row while the lock is on', () => {
      renderTable({
        transactions: [row({ id: 'tx-r', status: TransactionStatus.RECONCILED })],
        reconciledLocked: true,
      });
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Delete')).not.toBeInTheDocument();
      expect(screen.getByText('Locked')).toBeInTheDocument();
    });

    it('keeps the inline actions on an unreconciled row while the lock is on', () => {
      // The lock is about reconciled rows. Hiding every action would make the
      // setting unusable for the screen it matters most on.
      renderTable({ reconciledLocked: true });
      expect(screen.getAllByLabelText('Edit').length).toBe(3);
    });

    it('opens the sheet from a right-click and edits from it', () => {
      renderTable();
      fireEvent.contextMenu(screen.getByTestId('reconcile-row-tx-a'));
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Edit' }));
      expect(defaults.onEdit).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
      // The action closes the sheet, and the right-click did not also toggle.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(defaults.onToggle).not.toHaveBeenCalled();
    });

    it('offers delete in the sheet', () => {
      renderTable();
      fireEvent.contextMenu(screen.getByTestId('reconcile-row-tx-a'));
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Delete' }));
      expect(defaults.onDelete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
    });

    it('names the sheet after the row', () => {
      renderTable();
      fireEvent.contextMenu(screen.getByTestId('reconcile-row-tx-a'));
      expect(within(sheet()).getByText('Grocery')).toBeInTheDocument();
      expect(within(sheet()).getByText('2026-02-01')).toBeInTheDocument();
    });

    it('opens the sheet from a press-and-hold, without toggling the row', () => {
      vi.useFakeTimers();
      try {
        renderTable();
        const rowEl = screen.getByTestId('reconcile-row-tx-a');
        fireEvent.mouseDown(rowEl, { button: 0 });
        act(() => {
          vi.advanceTimersByTime(750);
        });
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        // The click that trails the release is the long-press's own, not a
        // selection toggle.
        fireEvent.mouseUp(rowEl);
        fireEvent.click(rowEl);
        expect(defaults.onToggle).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('cycles the status from the shared status cell', () => {
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByTitle('Click to cycle status'));
      expect(defaults.onCycleStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
      expect(defaults.onToggle).not.toHaveBeenCalled();
    });

    it('disables the sheet actions on a reconciled row while the lock is on', () => {
      renderTable({
        transactions: [row({ id: 'tx-r', status: TransactionStatus.RECONCILED })],
        reconciledLocked: true,
      });
      fireEvent.contextMenu(screen.getByTestId('reconcile-row-tx-r'));
      const sheetEl = sheet();
      // The lock is named, so the greyed actions read as a state, not a fault.
      expect(within(sheetEl).getByText('Locked')).toBeInTheDocument();
      expect(within(sheetEl).getByRole('button', { name: 'Edit' })).toBeDisabled();
      expect(within(sheetEl).getByRole('button', { name: 'Delete' })).toBeDisabled();
      fireEvent.click(within(sheetEl).getByRole('button', { name: 'Edit' }));
      expect(defaults.onEdit).not.toHaveBeenCalled();
    });

    it('keeps the sheet actions live on an unreconciled row while the lock is on', () => {
      // The lock is about reconciled rows. Disabling every action would make
      // the setting unusable for the screen it matters most on.
      renderTable({ reconciledLocked: true });
      fireEvent.contextMenu(screen.getByTestId('reconcile-row-tx-a'));
      expect(within(sheet()).getByRole('button', { name: 'Edit' })).toBeEnabled();
    });
  });

  describe('stale highlighting', () => {
    it('marks nothing when the account has never been reconciled', () => {
      renderTable();
      expect(screen.queryByText('Missed')).not.toBeInTheDocument();
      expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    });

    it('marks a row the last reconciled statement left out', () => {
      renderTable({ lastReconciledDate: '2026-02-05', overdueBefore: '2026-01-01' });
      expect(screen.getByTestId('reconcile-row-tx-a')).toHaveAttribute('data-stale', 'missed');
      expect(screen.getByTestId('reconcile-row-tx-b')).toHaveAttribute('data-stale', 'missed');
      expect(screen.getByTestId('reconcile-row-tx-c')).not.toHaveAttribute('data-stale');
    });

    it('marks a row older than the overdue boundary', () => {
      renderTable({ lastReconciledDate: '2025-12-31', overdueBefore: '2026-02-08' });
      expect(screen.getByTestId('reconcile-row-tx-a')).toHaveAttribute('data-stale', 'overdue');
      expect(screen.getByTestId('reconcile-row-tx-c')).not.toHaveAttribute('data-stale');
    });

    it('survives an older backend that sends no staleness dates', () => {
      // During a rolling deploy the page can receive a response predating the
      // field. Absent means no information, so nothing is marked -- it must not
      // mark everything, and it must not throw.
      renderTable({ lastReconciledDate: null, overdueBefore: '' });
      expect(screen.queryByText('Missed')).not.toBeInTheDocument();
      expect(renderedIds()).toHaveLength(3);
    });
  });

  // Below `sm` the table must FIT the phone, not merely scroll: mobile Chrome
  // sizes the viewport that position:fixed elements attach to from the page's
  // widest content, overflow-x-auto included, so a table wider than the screen
  // made the edit modal render hundreds of pixels off it. These pin the
  // affordances that keep the table narrower than a phone; jsdom cannot
  // measure the layout itself, so the width property is held end to end by
  // the mobile reconcile spec in e2e/tests/mobile.spec.ts.
  describe('mobile layout', () => {
    const collapsedAt = (cell: HTMLElement) => {
      const classes = cell.className.split(/\s+/);
      return classes.includes('hidden') && classes.includes('sm:table-cell');
    };

    it('collapses the Category, Status and Actions columns below sm, and only those', () => {
      renderTable();
      const [headerRow] = screen.getAllByRole('row');
      const headerCells = within(headerRow).getAllByRole('columnheader');
      expect(headerCells).toHaveLength(7);
      expect(headerCells.map(collapsedAt)).toEqual([
        false, // select
        false, // date
        false, // payee
        true, // category
        false, // amount
        true, // status
        true, // actions
      ]);

      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      const cells = within(rowEl).getAllByRole('cell');
      expect(cells).toHaveLength(7);
      expect(cells.map(collapsedAt)).toEqual([
        false, // select
        false, // date
        false, // payee
        true, // category
        false, // amount
        true, // status
        true, // actions
      ]);
    });

    it('lets the stale chip wrap under the date instead of widening the column', () => {
      renderTable({ lastReconciledDate: '2026-02-05', overdueBefore: '2026-01-01' });
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      const chip = within(rowEl).getByText('Missed');
      const line = chip.parentElement!;
      expect(line.className.split(/\s+/)).toContain('flex-wrap');
    });

    it('caps the payee column on phones so one long name cannot widen the table', () => {
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      const payeeCell = within(rowEl).getByText('Grocery').closest('td')!;
      expect(payeeCell.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['max-w-[110px]', 'sm:max-w-none', 'overflow-hidden']),
      );
    });

    it('keeps the group rows aligned with the data rows when columns collapse', () => {
      // The group heading spans whole columns, so it cannot use one colSpan
      // sized for the desktop column count: each collapsing column gets its
      // own filler cell that collapses with it.
      renderTable({ groupByFlow: true });
      const groupRow = screen.getByText('Money in (1)').closest('tr')!;
      const label = within(groupRow).getByRole('columnheader');
      expect(label).toHaveAttribute('colspan', '3');
      const cells = within(groupRow).getAllByRole('cell');
      expect(cells).toHaveLength(4);
      expect(cells.filter(collapsedAt)).toHaveLength(3);
    });
  });

  // The register's mobile date-shortening option, shared store and all -- the
  // toggle on either register applies to both, because whether a full date
  // fits beside a payee is a property of the phone in the user's hand.
  describe('compact mobile dates', () => {
    afterEach(() => {
      // `cleanup()` first: vitest runs after-hooks in reverse registration
      // order, so a store write here would re-render the still-mounted tree
      // outside act. `src/test/test-hygiene.test.ts` is the rule.
      cleanup();
      useDateDisplayStore.setState({ compactMobileDates: false });
    });

    it('offers the toggle in the Date column header, off by default', () => {
      renderTable();
      const toggle = screen.getByRole('button', { name: 'Hide the year' });
      expect(toggle.closest('th')).toHaveTextContent('Date');
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      // Full date, single rendering -- no phone/desktop split.
      expect(screen.getAllByText('2026-02-01')).toHaveLength(1);
      expect(screen.queryByText('02-01')).not.toBeInTheDocument();
    });

    it('flipping the toggle does not also sort the Date column', () => {
      renderTable();
      fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));
      expect(defaults.onSort).not.toHaveBeenCalled();
    });

    it('drops the year for phones and keeps the full date for wider screens', () => {
      renderTable({ transactions: [row({ id: 'tx-a', transactionDate: '2026-02-01' })] });
      fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));
      const compact = screen.getByText('02-01');
      const full = screen.getByText('2026-02-01');
      expect(compact.className.split(/\s+/)).toContain('sm:hidden');
      expect(full.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['hidden', 'sm:inline']),
      );
      expect(useDateDisplayStore.getState().compactMobileDates).toBe(true);
    });

    it('closes the Date/Payee gap and widens the payee cap, header and cells alike', () => {
      renderTable();
      const dateHeader = () =>
        screen.getByRole('button', { name: 'Hide the year' }).closest('th')!;
      const payeeCell = () =>
        within(screen.getByTestId('reconcile-row-tx-a')).getAllByRole('cell')[2];
      const dateCell = () =>
        within(screen.getByTestId('reconcile-row-tx-a')).getAllByRole('cell')[1];

      expect(dateHeader().className).not.toContain('max-sm:pr-1');
      expect(payeeCell().className).toContain('max-w-[110px]');

      fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));

      // A `th` and its `td` that disagree about padding put the label and the
      // values it labels at different offsets, so both move together.
      expect(dateHeader().className).toContain('max-sm:pr-1');
      expect(dateCell().className).toContain('max-sm:pr-1');
      expect(payeeCell().className).toContain('max-sm:pl-1');
      expect(payeeCell().className).toContain('max-w-[160px]');
    });
  });
});
