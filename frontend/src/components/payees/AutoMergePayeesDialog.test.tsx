import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { AutoMergePayeesDialog } from './AutoMergePayeesDialog';
import { payeesApi } from '@/lib/payees';
import { AutoMergeGroup } from '@/types/payee';
import { Category } from '@/types/category';
import toast from 'react-hot-toast';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAutoMergePreview: vi.fn().mockResolvedValue([]),
    applyAutoMerge: vi.fn().mockResolvedValue({
      groupsMerged: 0,
      payeesMerged: 0,
      transactionsMigrated: 0,
      aliasesCreated: 0,
      skippedAliases: 0,
      transactionsBackfilled: 0,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const mockPreview = vi.mocked(payeesApi.getAutoMergePreview);
const mockApply = vi.mocked(payeesApi.applyAutoMerge);

const lidlGroup: AutoMergeGroup = {
  groupKey: 'LIDL',
  suggestedCanonicalPayeeId: 'p1',
  suggestedName: 'Lidl',
  suggestedAlias: '*LIDL*',
  suggestedCategoryId: null,
  uncategorizedTransactionCount: 6,
  totalTransactions: 17,
  members: [
    { payeeId: 'p1', name: 'Lidl', transactionCount: 10, isCanonical: true },
    { payeeId: 'p2', name: 'LIDL sp. z o.o.', transactionCount: 2, isCanonical: false },
    { payeeId: 'p3', name: 'LIDL WARSZAWA 0421', transactionCount: 5, isCanonical: false },
  ],
};

// A two-level category tree so the picker shows the "Parent: Child" label.
const categories = [
  { id: 'cat-food', name: 'Food', parentId: null },
  { id: 'cat-groceries', name: 'Groceries', parentId: 'cat-food' },
] as unknown as Category[];

const groceryGroup: AutoMergeGroup = {
  groupKey: 'LIDL',
  suggestedCanonicalPayeeId: 'p1',
  suggestedName: 'Lidl',
  suggestedAlias: '*LIDL*',
  suggestedCategoryId: 'cat-groceries',
  uncategorizedTransactionCount: 8,
  totalTransactions: 12,
  members: [
    { payeeId: 'p1', name: 'Lidl', transactionCount: 10, isCanonical: true },
    { payeeId: 'p2', name: 'LIDL sp. z o.o.', transactionCount: 2, isCanonical: false },
  ],
};

// Selecting (including) every previewed group; groups start de-selected.
async function selectAllGroups() {
  await act(async () => {
    fireEvent.click(screen.getByText('Select all'));
  });
}

describe('AutoMergePayeesDialog', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPreview.mockResolvedValue([]);
  });

  it('renders the title, description and knobs when open', () => {
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Auto-Merge Payees')).toBeInTheDocument();
    expect(screen.getByText('How it works')).toBeInTheDocument();
    expect(screen.getByText(/Minimum Group Size/)).toBeInTheDocument();
    expect(screen.getByText(/Similarity Threshold/)).toBeInTheDocument();
    expect(screen.getByText('Preview Groups')).toBeInTheDocument();
  });

  it('recommends a backup with a link to the backup settings section', () => {
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);
    const link = screen.getByRole('link', { name: 'backup' });
    expect(link).toHaveAttribute('href', '/settings#backup-restore');
    // The recommendation copy is rendered in bold for emphasis.
    expect(screen.getByText(/Recommended:/)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<AutoMergePayeesDialog isOpen={false} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.queryByText('Auto-Merge Payees')).not.toBeInTheDocument();
  });

  it('loads and displays a merge group with its members', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument();
      expect(screen.getByDisplayValue('*LIDL*')).toBeInTheDocument();
      expect(screen.getByText('LIDL sp. z o.o.')).toBeInTheDocument();
      expect(screen.getByText('LIDL WARSZAWA 0421')).toBeInTheDocument();
    });
    expect(mockPreview).toHaveBeenCalledWith({
      minGroupSize: 2,
      similarityThreshold: 0.85,
      minTokenLength: 3,
      includeInactive: false,
      categoryMatch: 'off',
      ignoreCommonWords: false,
      commonWordMinVariants: 5,
    });
  });

  it('shows a clickable uncategorized badge that navigates to the filtered transactions', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    await waitFor(() => {
      expect(screen.getByText('6 uncategorized')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('6 uncategorized'));
    });

    expect(onClose).toHaveBeenCalled();
    // The count spans every member, so the filter targets all member ids.
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?payeeIds=p1,p2,p3&categoryId=uncategorized',
    );
  });

  it('does not show an uncategorized badge when the group has none', async () => {
    mockPreview.mockResolvedValue([
      { ...lidlGroup, uncategorizedTransactionCount: 0 },
    ]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());
    expect(screen.queryByText(/uncategorized/)).not.toBeInTheDocument();
  });

  it('requests common-word filtering when the toggle is enabled', async () => {
    mockPreview.mockResolvedValue([]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Ignore common words' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreCommonWords: true, commonWordMinVariants: 5 }),
    );
  });

  it('requests category matching when enabled, defaulting to category granularity', async () => {
    mockPreview.mockResolvedValue([]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    // Enable the "same category" toggle, then preview.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: 'Only merge payees in the same category' }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({ categoryMatch: 'category' }),
    );
  });

  it('requests subcategory matching when that granularity is chosen', async () => {
    mockPreview.mockResolvedValue([]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: 'Only merge payees in the same category' }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Subcategory' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({ categoryMatch: 'subcategory' }),
    );
  });

  it('starts with every group de-selected', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    // Nothing is selected until the user opts in, so the apply button is
    // disabled and no footer count is shown.
    expect(
      screen.getByRole('button', { name: /Merge 0 Groups/ }),
    ).toBeDisabled();
    expect(screen.queryByText(/group selected/)).not.toBeInTheDocument();
  });

  it('selects then deselects every group with the bulk actions', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    await selectAllGroups();
    expect(screen.getByRole('button', { name: /Merge 1 Group/ })).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByText('Deselect all'));
    });

    // With no groups selected, the apply button is disabled.
    expect(
      screen.getByRole('button', { name: /Merge 0 Groups/ }),
    ).toBeDisabled();
  });

  it('applies the merge with the canonical and sources derived from selection', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    mockApply.mockResolvedValue({
      groupsMerged: 1,
      payeesMerged: 2,
      transactionsMigrated: 7,
      aliasesCreated: 1,
      skippedAliases: 0,
      transactionsBackfilled: 0,
    });
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    await selectAllGroups();
    await act(async () => {
      fireEvent.click(screen.getByText(/Merge 1 Group/));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply).toHaveBeenCalledWith([
      {
        canonicalPayeeId: 'p1',
        canonicalName: 'Lidl',
        sourcePayeeIds: ['p2', 'p3'],
        alias: '*LIDL*',
        backfillTransactions: false,
      },
    ]);
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the empty state when no groups are found', async () => {
    mockPreview.mockResolvedValue([]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });

    await waitFor(() =>
      expect(
        screen.getByText('No merge groups match the current criteria.'),
      ).toBeInTheDocument(),
    );
  });

  it('excludes a member from the merge when its checkbox is unchecked', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    mockApply.mockResolvedValue({
      groupsMerged: 1,
      payeesMerged: 1,
      transactionsMigrated: 5,
      aliasesCreated: 1,
      skippedAliases: 0,
      transactionsBackfilled: 0,
    });
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    // The member toggles are only enabled once the group is included.
    await selectAllGroups();

    // Uncheck the "include in merge" toggle for p2 (LIDL sp. z o.o.).
    // Index 0 is the canonical (p1, disabled); index 1 is p2.
    const includeToggles = screen.getAllByLabelText('Include in merge');
    await act(async () => {
      fireEvent.click(includeToggles[1]);
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/Merge 1 Group/));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply).toHaveBeenCalledWith([
      {
        canonicalPayeeId: 'p1',
        canonicalName: 'Lidl',
        sourcePayeeIds: ['p3'],
        alias: '*LIDL*',
        backfillTransactions: false,
      },
    ]);
  });

  it('lets groups that share a groupKey be de-selected independently', async () => {
    // Two distinct groups can carry the same groupKey (the shared token
    // prefix); they must still be editable independently.
    const groupA: AutoMergeGroup = {
      groupKey: 'ROYAL',
      suggestedCanonicalPayeeId: 'a1',
      suggestedName: 'Royal Electric',
      suggestedAlias: '*ROYAL ELECTRIC*',
      suggestedCategoryId: null,
      uncategorizedTransactionCount: 0,
      totalTransactions: 25,
      members: [
        { payeeId: 'a1', name: 'Royal Electric', transactionCount: 23, isCanonical: true },
        { payeeId: 'a2', name: 'Royal Electric Co', transactionCount: 2, isCanonical: false },
      ],
    };
    const groupB: AutoMergeGroup = {
      groupKey: 'ROYAL',
      suggestedCanonicalPayeeId: 'b1',
      suggestedName: 'Royal City Nursery',
      suggestedAlias: '*ROYAL CITY NURSERY*',
      suggestedCategoryId: null,
      uncategorizedTransactionCount: 0,
      totalTransactions: 11,
      members: [
        { payeeId: 'b1', name: 'Royal City Nursery', transactionCount: 9, isCanonical: true },
        { payeeId: 'b2', name: 'Royal City Nursery Downtown', transactionCount: 2, isCanonical: false },
      ],
    };
    mockPreview.mockResolvedValue([groupA, groupB]);
    mockApply.mockResolvedValue({
      groupsMerged: 1,
      payeesMerged: 1,
      transactionsMigrated: 2,
      aliasesCreated: 1,
      skippedAliases: 0,
      transactionsBackfilled: 0,
    });
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Royal Electric')).toBeInTheDocument());

    // Include both groups, then de-select only the first.
    await selectAllGroups();
    const groupToggles = screen.getAllByLabelText('Include this group');
    expect(groupToggles).toHaveLength(2);
    await act(async () => {
      fireEvent.click(groupToggles[0]);
    });

    // Footer should now offer to merge exactly one group.
    await act(async () => {
      fireEvent.click(screen.getByText(/Merge 1 Group/));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply).toHaveBeenCalledWith([
      {
        canonicalPayeeId: 'b1',
        canonicalName: 'Royal City Nursery',
        sourcePayeeIds: ['b2'],
        alias: '*ROYAL CITY NURSERY*',
        backfillTransactions: false,
      },
    ]);
  });

  it('labels the Keep/Merge columns and explains the radio choice', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    expect(
      screen.getByText('Select the payee to keep. The others are merged into it.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Merge')).toBeInTheDocument();
    // "Keep" labels both the column header and the canonical badge.
    expect(screen.getAllByText('Keep').length).toBeGreaterThanOrEqual(2);
  });

  it('shows how many payees will be merged next to the group count', async () => {
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    await selectAllGroups();

    // One group, two non-canonical members folded into the canonical.
    expect(screen.getByText('1 group selected')).toBeInTheDocument();
    expect(screen.getByText('2 payees to merge')).toBeInTheDocument();
  });

  it('prefills the suggested default category and applies it', async () => {
    mockPreview.mockResolvedValue([groceryGroup]);
    mockApply.mockResolvedValue({
      groupsMerged: 1,
      payeesMerged: 1,
      transactionsMigrated: 2,
      aliasesCreated: 1,
      skippedAliases: 0,
      transactionsBackfilled: 0,
    });
    render(
      <AutoMergePayeesDialog
        isOpen
        onClose={onClose}
        onSuccess={onSuccess}
        categories={categories}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    // The category picker is prefilled with the group's most-used category,
    // shown with its parent ("Food: Groceries").
    expect(screen.getByDisplayValue('Food: Groceries')).toBeInTheDocument();

    await selectAllGroups();
    await act(async () => {
      fireEvent.click(screen.getByText(/Merge 1 Group/));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply).toHaveBeenCalledWith([
      expect.objectContaining({
        canonicalPayeeId: 'p1',
        defaultCategoryId: 'cat-groceries',
      }),
    ]);
  });

  it('hides the backfill option when the group has no default category', async () => {
    // lidlGroup has uncategorized transactions but no suggested category.
    mockPreview.mockResolvedValue([lidlGroup]);
    render(<AutoMergePayeesDialog isOpen onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    expect(screen.queryByText(/Also categorize/)).not.toBeInTheDocument();
  });

  it('offers the backfill option with the group count once a category is set', async () => {
    mockPreview.mockResolvedValue([groceryGroup]);
    render(
      <AutoMergePayeesDialog
        isOpen
        onClose={onClose}
        onSuccess={onSuccess}
        categories={categories}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    // groceryGroup carries 8 uncategorized transactions and a default category.
    expect(
      screen.getAllByText(/Also categorize 8 existing uncategorized transactions/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('sends backfillTransactions and shows a backfilled toast when enabled', async () => {
    mockPreview.mockResolvedValue([groceryGroup]);
    mockApply.mockResolvedValue({
      groupsMerged: 1,
      payeesMerged: 1,
      transactionsMigrated: 2,
      aliasesCreated: 1,
      skippedAliases: 0,
      transactionsBackfilled: 8,
    });
    render(
      <AutoMergePayeesDialog
        isOpen
        onClose={onClose}
        onSuccess={onSuccess}
        categories={categories}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Preview Groups'));
    });
    await waitFor(() => expect(screen.getByDisplayValue('Lidl')).toBeInTheDocument());

    // The backfill toggle is enabled only once the group is included.
    await selectAllGroups();

    const backfillToggle = screen.getByLabelText(
      /Also categorize 8 existing uncategorized transactions/,
    );
    await act(async () => {
      fireEvent.click(backfillToggle);
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/Merge 1 Group/));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply).toHaveBeenCalledWith([
      expect.objectContaining({
        canonicalPayeeId: 'p1',
        defaultCategoryId: 'cat-groceries',
        backfillTransactions: true,
      }),
    ]);
    expect(toast.success).toHaveBeenCalledWith('Categorized 8 transactions');
  });
});
