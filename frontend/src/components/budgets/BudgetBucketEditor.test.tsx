import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { BudgetBucketEditor, BUDGET_BUCKET_LIMIT } from './BudgetBucketEditor';
import type { BudgetBucketEditorRow } from './utils/budget-bucket-presets';
import type { BudgetBucket } from '@/types/budget';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatPercentTrimmed: (n: number) => `${n}%`,
    }),
  };
});

const row = (overrides: Partial<BudgetBucketEditorRow> = {}): BudgetBucketEditorRow => ({
  key: 'r1',
  name: 'Savings',
  targetType: 'PERCENT',
  targetValue: 20,
  carryOver: true,
  carryCap: null,
  ...overrides,
});

const bucket = (overrides: Partial<BudgetBucket> = {}): BudgetBucket => ({
  id: 'b1',
  budgetId: 'budget-1',
  name: 'Savings',
  targetType: 'PERCENT',
  targetValue: 20,
  carryOver: true,
  carryCap: null,
  sortOrder: 0,
  createdAt: '2026-11-01',
  updatedAt: '2026-11-01',
  ...overrides,
});

/** The wizard's shape: the host holds the rows; `spy` sees every change. */
function MemoryHost({ initial, spy }: { initial: BudgetBucketEditorRow[]; spy: (rows: BudgetBucketEditorRow[]) => void }) {
  const [rows, setRows] = useState(initial);
  return (
    <BudgetBucketEditor
      mode="memory"
      currencyCode="USD"
      rows={rows}
      onChange={(next) => {
        spy(next);
        setRows(next);
      }}
    />
  );
}

function renderMemory(initial: BudgetBucketEditorRow[] = []) {
  const spy = vi.fn();
  render(<MemoryHost initial={initial} spy={spy} />);
  return spy;
}

function renderPersisted(buckets: BudgetBucket[] = [bucket()]) {
  const handlers = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onWritten: vi.fn(),
  };
  render(<BudgetBucketEditor mode="persisted" currencyCode="USD" buckets={buckets} {...handlers} />);
  return handlers;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function fillNewPercentBucket(name: string, percent: string) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Percent of Income'), { target: { value: percent } });
}

/** `ConfirmDialog` draws its title as a heading inside an unnamed dialog. */
function confirmDialog(title: string): HTMLElement {
  const dialog = screen.getByText(title).closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error(`No dialog titled ${title}`);
  return dialog;
}

/** A refusal shaped the way the API client rejects. */
const serverRefusal = (message: string) => ({ response: { data: { message } } });

describe('BudgetBucketEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('in memory (the wizard)', () => {
    it('shows the empty state with no buckets', () => {
      renderMemory();
      expect(screen.getByText('No buckets yet')).toBeInTheDocument();
      expect(screen.queryByTestId('bucket-target-summary')).not.toBeInTheDocument();
    });

    it('adds a bucket through the form and hands the host the new list', async () => {
      const spy = renderMemory([row()]);
      await click(screen.getByRole('button', { name: 'Add Bucket' }));
      expect(screen.getByRole('dialog', { name: 'New Bucket' })).toBeInTheDocument();

      fillNewPercentBucket('Needs', '50');
      await click(screen.getByRole('button', { name: 'Save' }));

      expect(spy).toHaveBeenCalledTimes(1);
      const next = spy.mock.calls[0][0] as BudgetBucketEditorRow[];
      expect(next).toHaveLength(2);
      expect(next[0]).toEqual(row());
      expect(next[1]).toEqual({
        key: expect.any(String),
        name: 'Needs',
        targetType: 'PERCENT',
        targetValue: 50,
        carryOver: false,
        carryCap: null,
      });
      expect(next[1].key).not.toBe('r1');
      expect(screen.queryByRole('dialog', { name: 'New Bucket' })).not.toBeInTheDocument();
      expect(screen.getByText('Needs')).toBeInTheDocument();
    });

    it('edits a bucket in place, keeping its key', async () => {
      const spy = renderMemory([row(), row({ key: 'r2', name: 'Fun', targetValue: 10, carryOver: false })]);
      await click(screen.getByRole('button', { name: 'Edit Fun' }));
      expect(screen.getByRole('dialog', { name: 'Edit Fun' })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Splurge' } });
      await click(screen.getByRole('button', { name: 'Save Changes' }));

      expect(spy).toHaveBeenCalledWith([
        row(),
        row({ key: 'r2', name: 'Splurge', targetValue: 10, carryOver: false }),
      ]);
    });

    it('checks the duplicate name against the other buckets only', async () => {
      const spy = renderMemory([row(), row({ key: 'r2', name: 'Fun', carryOver: false })]);

      // Its own name is not a duplicate of itself.
      await click(screen.getByRole('button', { name: 'Edit Savings' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' SAVINGS ' } });
      await click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(spy).toHaveBeenLastCalledWith([row({ name: 'SAVINGS' }), row({ key: 'r2', name: 'Fun', carryOver: false })]);

      await click(screen.getByRole('button', { name: 'Edit SAVINGS' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'fun ' } });
      await click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(screen.getByText('Another bucket already has this name')).toBeInTheDocument();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('removes a bucket after confirming, saying its categories become unassigned', async () => {
      const spy = renderMemory([row(), row({ key: 'r2', name: 'Fun' })]);
      await click(screen.getByRole('button', { name: 'Delete Fun' }));

      const dialog = confirmDialog('Delete Bucket');
      expect(within(dialog).getByText('Delete the bucket "Fun"? Its categories become unassigned.')).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Delete' }));

      expect(spy).toHaveBeenCalledWith([row()]);
      expect(screen.queryByText('Fun')).not.toBeInTheDocument();
    });

    it('applies a preset to an empty list without asking', async () => {
      const spy = renderMemory();
      await click(screen.getByRole('button', { name: 'Three Buckets' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const next = spy.mock.calls[0][0] as BudgetBucketEditorRow[];
      expect(next.map(({ name, targetValue, carryOver }) => ({ name, targetValue, carryOver }))).toEqual([
        { name: 'Fixed costs', targetValue: 50, carryOver: false },
        { name: 'Everyday spending', targetValue: 30, carryOver: false },
        { name: 'Savings', targetValue: 20, carryOver: true },
      ]);
      expect(new Set(next.map((r) => r.key)).size).toBe(3);
    });

    it('asks before a preset replaces a non-empty list, and Cancel keeps it', async () => {
      const spy = renderMemory([row({ name: 'Mine' })]);
      await click(screen.getByRole('button', { name: 'Four Buckets (60/10/10/20)' }));

      const dialog = confirmDialog('Replace Buckets');
      expect(within(dialog).getByText(/Replace the current buckets with "Four Buckets \(60\/10\/10\/20\)"\?/)).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByText('Mine')).toBeInTheDocument();

      await click(screen.getByRole('button', { name: 'Four Buckets (60/10/10/20)' }));
      await click(screen.getByRole('button', { name: 'Replace' }));
      expect((spy.mock.calls[0][0] as BudgetBucketEditorRow[]).map((r) => r.name)).toEqual([
        'Daily expenses',
        'Splurge',
        'Long-term goals',
        'Safety and debt',
      ]);
    });

    it('Start from scratch clears a non-empty list after confirming, and does nothing to an empty one', async () => {
      const spy = renderMemory([row()]);
      await click(screen.getByRole('button', { name: 'Start From Scratch' }));
      expect(screen.getByText('Delete every bucket and start from scratch? Their categories become unassigned.')).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Replace' }));
      expect(spy).toHaveBeenCalledWith([]);

      await click(screen.getByRole('button', { name: 'Start From Scratch' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('sums the percent targets and the amount targets separately, and never blocks on 100', () => {
      renderMemory([
        row({ key: 'a', name: 'A', targetValue: 50 }),
        row({ key: 'b', name: 'B', targetValue: 30.25 }),
        row({ key: 'c', name: 'C', targetType: 'AMOUNT', targetValue: 200 }),
        row({ key: 'd', name: 'D', targetType: 'AMOUNT', targetValue: 0.5 }),
      ]);
      expect(screen.getByTestId('bucket-target-summary')).toHaveTextContent(
        'Percent targets add up to 80.25%. Amount targets add up to $200.50.',
      );
      expect(screen.getByRole('button', { name: 'Add Bucket' })).toBeEnabled();
    });

    it('describes each bucket by its target and carry-over', () => {
      renderMemory([
        row({ key: 'a', name: 'A', targetValue: 20, carryOver: false }),
        row({ key: 'b', name: 'B', targetType: 'AMOUNT', targetValue: 100, carryOver: true, carryCap: 300 }),
        row({ key: 'c', name: 'C', targetValue: 5, carryOver: true }),
      ]);
      expect(screen.getByText('20% of income · Starts each period fresh')).toBeInTheDocument();
      expect(screen.getByText('$100.00 per period · Carries over, up to $300.00')).toBeInTheDocument();
      expect(screen.getByText('5% of income · Carries over')).toBeInTheDocument();
    });

    it(`disables Add Bucket at ${BUDGET_BUCKET_LIMIT} buckets and says why`, () => {
      const rows = Array.from({ length: BUDGET_BUCKET_LIMIT }, (_, i) =>
        row({ key: `k${i}`, name: `Bucket ${i}`, targetValue: 1 }),
      );
      renderMemory(rows);

      const add = screen.getByRole('button', { name: 'Add Bucket' });
      expect(add).toBeDisabled();
      expect(add).toHaveAccessibleDescription('A budget can have at most 12 buckets.');
    });

    it('allows Add Bucket at one under the limit', () => {
      const rows = Array.from({ length: BUDGET_BUCKET_LIMIT - 1 }, (_, i) =>
        row({ key: `k${i}`, name: `Bucket ${i}`, targetValue: 1 }),
      );
      renderMemory(rows);
      expect(screen.getByRole('button', { name: 'Add Bucket' })).toBeEnabled();
      expect(screen.queryByText('A budget can have at most 12 buckets.')).not.toBeInTheDocument();
    });
  });

  describe('persisted (the edit page)', () => {
    it('lists the budget buckets', () => {
      renderPersisted([bucket(), bucket({ id: 'b2', name: 'Rent', targetType: 'AMOUNT', targetValue: 1500, carryOver: false })]);
      const list = screen.getByRole('list', { name: 'Buckets' });
      expect(within(list).getByText('Savings')).toBeInTheDocument();
      expect(within(list).getByText('$1500.00 per period · Starts each period fresh')).toBeInTheDocument();
    });

    it('creates a bucket after the last sort order, then asks the host to re-read', async () => {
      const handlers = renderPersisted([bucket({ sortOrder: 4 })]);
      await click(screen.getByRole('button', { name: 'Add Bucket' }));
      fillNewPercentBucket('Needs', '50');
      await click(screen.getByRole('button', { name: 'Save' }));

      expect(handlers.onCreate).toHaveBeenCalledWith({
        name: 'Needs',
        targetType: 'PERCENT',
        targetValue: 50,
        carryOver: false,
        sortOrder: 5,
      });
      expect(handlers.onWritten).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Bucket added');
      expect(screen.queryByRole('dialog', { name: 'New Bucket' })).not.toBeInTheDocument();
    });

    it('shows the server refusal and keeps the form open', async () => {
      const handlers = renderPersisted();
      handlers.onCreate.mockRejectedValueOnce(serverRefusal('A bucket named "Needs" already exists'));
      await click(screen.getByRole('button', { name: 'Add Bucket' }));
      fillNewPercentBucket('Needs', '50');
      await click(screen.getByRole('button', { name: 'Save' }));

      expect(toast.error).toHaveBeenCalledWith('A bucket named "Needs" already exists');
      expect(handlers.onWritten).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'New Bucket' })).toBeInTheDocument();
    });

    it('updates a bucket by id, clearing the cap when carry-over is turned off', async () => {
      const handlers = renderPersisted([bucket({ carryCap: 250 })]);
      await click(screen.getByRole('button', { name: 'Edit Savings' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Carry Over What Is Left' }));
      await click(screen.getByRole('button', { name: 'Save Changes' }));

      expect(handlers.onUpdate).toHaveBeenCalledWith('b1', {
        name: 'Savings',
        targetType: 'PERCENT',
        targetValue: 20,
        carryOver: false,
        carryCap: null,
      });
      expect(handlers.onWritten).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Bucket updated');
    });

    it('deletes a bucket after confirming', async () => {
      const handlers = renderPersisted();
      await click(screen.getByRole('button', { name: 'Delete Savings' }));
      expect(screen.getByText('Delete the bucket "Savings"? Its categories become unassigned.')).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Delete' }));

      expect(handlers.onDelete).toHaveBeenCalledWith('b1');
      expect(handlers.onWritten).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Bucket deleted');
    });

    it('shows the server refusal of a delete', async () => {
      const handlers = renderPersisted();
      handlers.onDelete.mockRejectedValueOnce(serverRefusal('Bucket not found'));
      await click(screen.getByRole('button', { name: 'Delete Savings' }));
      await click(screen.getByRole('button', { name: 'Delete' }));

      expect(toast.error).toHaveBeenCalledWith('Bucket not found');
      expect(handlers.onWritten).not.toHaveBeenCalled();
    });

    it('a confirmed preset deletes the current buckets, creates the preset in order, and re-reads once', async () => {
      const handlers = renderPersisted([bucket(), bucket({ id: 'b2', name: 'Fun', sortOrder: 1 })]);
      await click(screen.getByRole('button', { name: 'Three Buckets' }));
      await click(screen.getByRole('button', { name: 'Replace' }));

      expect(handlers.onDelete.mock.calls).toEqual([['b1'], ['b2']]);
      expect(handlers.onCreate.mock.calls).toEqual([
        [{ name: 'Fixed costs', targetType: 'PERCENT', targetValue: 50, carryOver: false, sortOrder: 0 }],
        [{ name: 'Everyday spending', targetType: 'PERCENT', targetValue: 30, carryOver: false, sortOrder: 1 }],
        [{ name: 'Savings', targetType: 'PERCENT', targetValue: 20, carryOver: true, sortOrder: 2 }],
      ]);
      expect(handlers.onWritten).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Preset applied');
    });

    it('a preset that fails part-way reports the refusal and still re-reads what was written', async () => {
      const handlers = renderPersisted([]);
      handlers.onCreate
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(serverRefusal('A budget can have at most 12 buckets'));
      await click(screen.getByRole('button', { name: 'Three Buckets' }));

      expect(handlers.onCreate).toHaveBeenCalledTimes(2);
      expect(toast.error).toHaveBeenCalledWith('A budget can have at most 12 buckets');
      expect(handlers.onWritten).toHaveBeenCalledTimes(1);
    });
  });
});
