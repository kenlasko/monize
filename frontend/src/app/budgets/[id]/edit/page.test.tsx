import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import BudgetEditPage from './page';

// Mock next/navigation
const mockPush = vi.fn();
// One router object, as Next gives: a fresh one per render would re-run the
// page's load effect on every render.
const mockRouter = { push: (...args: any[]) => mockPush(...args) };
vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/budgets/budget-1/edit',
  useParams: () => ({ id: 'budget-1' }),
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

// Mock preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD', numberFormat: 'en-US' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

// Mock number format
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
      formatNumber: (amount: number) => amount.toFixed(2),
      formatPercent: (amount: number) => `${amount}%`,
      defaultCurrency: 'USD',
    }),
  };
});

// Mock budgets API
const mockGetById = vi.fn();
const mockGetSummary = vi.fn();
const mockRemoveCategory = vi.fn();
const mockAddTransferIncomeLine = vi.fn();
const mockCreateBucket = vi.fn();
const mockUpdateBucket = vi.fn();
const mockDeleteBucket = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getById: (...args: any[]) => mockGetById(...args),
    getSummary: (...args: any[]) => mockGetSummary(...args),
    update: vi.fn(),
    updateCategory: vi.fn(),
    removeCategory: (...args: any[]) => mockRemoveCategory(...args),
    addTransferIncomeLine: (...args: any[]) => mockAddTransferIncomeLine(...args),
    createBucket: (...args: any[]) => mockCreateBucket(...args),
    updateBucket: (...args: any[]) => mockUpdateBucket(...args),
    deleteBucket: (...args: any[]) => mockDeleteBucket(...args),
  },
}));

const mockGetAccounts = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAccounts(...args),
  },
}));

vi.mock('@/components/budgets/TransferIncomeLineForm', () => ({
  TransferIncomeLineForm: ({ accounts, onSave }: any) => (
    <div data-testid="transfer-income-form">
      {accounts.map((a: any) => (
        <button key={a.id} onClick={() => onSave({ transferAccountId: a.id, amount: 2000 })}>
          {`Pick ${a.name}`}
        </button>
      ))}
    </div>
  ),
}));

// Mock components
vi.mock('@/components/budgets/BudgetForm', () => ({
  BudgetForm: ({ onCancel }: any) => (
    <div data-testid="budget-form">
      <button data-testid="form-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

const categoryFormProps: { current: any } = { current: null };
vi.mock('@/components/budgets/BudgetCategoryForm', () => ({
  BudgetCategoryForm: (props: any) => {
    categoryFormProps.current = props;
    return (
      <div data-testid="category-form">
        <button data-testid="category-remove" onClick={props.onRemove}>Remove from budget</button>
      </div>
    );
  },
}));

// The editor has its own suite; here only its wiring to the page matters.
const bucketEditorProps: { current: any } = { current: null };
vi.mock('@/components/budgets/BudgetBucketEditor', () => ({
  BudgetBucketEditor: (props: any) => {
    bucketEditorProps.current = props;
    return <div data-testid="bucket-editor" />;
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: {
    success: (...args: any[]) => mockToastSuccess(...args),
    error: (...args: any[]) => mockToastError(...args),
  },
}));

vi.mock('@/components/budgets/BudgetProgressBar', () => ({
  BudgetProgressBar: () => <div data-testid="progress-bar" />,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message, confirmLabel, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <button onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onCancel}>Keep</button>
      </div>
    ) : null,
}));

const mockBudget = {
  id: 'budget-1',
  userId: 'user-1',
  name: 'February 2026',
  description: null,
  budgetType: 'MONTHLY',
  periodStart: '2026-02-01',
  periodEnd: '2026-02-28',
  baseIncome: 6000,
  incomeLinked: false,
  strategy: 'FIXED',
  isActive: true,
  currencyCode: 'USD',
  config: {},
  categories: [
    {
      id: 'bc-1',
      budgetId: 'budget-1',
      categoryId: 'cat-1',
      category: { id: 'cat-1', name: 'Groceries', isIncome: false },
      amount: 600,
      isIncome: false,
      rolloverType: 'NONE',
      rolloverCap: null,
      flexGroup: null,
      alertWarnPercent: 80,
      alertCriticalPercent: 95,
      notes: null,
      sortOrder: 0,
    },
  ],
  createdAt: '2026-02-01',
  updatedAt: '2026-02-01',
};

const mockSummary = {
  budget: mockBudget,
  totalBudgeted: 5200,
  totalSpent: 3100,
  totalIncome: 6000,
  categoryIncome: 6000,
  transferFunding: 0,
  outsideTransferIncome: 0,
  remaining: 2100,
  percentUsed: 59.62,
  categoryBreakdown: [
    {
      budgetCategoryId: 'bc-1',
      categoryId: 'cat-1',
      categoryName: 'Groceries',
      budgeted: 600,
      spent: 420,
      remaining: 180,
      percentUsed: 70,
      isIncome: false,
    },
  ],
};

describe('BudgetEditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(mockBudget);
    mockGetSummary.mockResolvedValue(mockSummary);
    mockRemoveCategory.mockResolvedValue(undefined);
    mockGetAccounts.mockResolvedValue([]);
    categoryFormProps.current = null;
    bucketEditorProps.current = null;
  });

  it('shows loading spinner initially', async () => {
    render(<BudgetEditPage />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();

    // Wait for async operations to complete to prevent act() warnings
    await waitFor(() => {
      expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
    });
  });

  it('renders budget form after loading', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-form')).toBeInTheDocument();
    });
  });

  it('displays budget name in header', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Edit: February 2026')).toBeInTheDocument();
    });
  });

  it('shows category list with expense categories', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
  });

  it('draws a partial line as unknown, with no progress bar (audit #2365 p)', async () => {
    mockGetSummary.mockResolvedValue({
      ...mockSummary,
      categoryBreakdown: [
        {
          ...mockSummary.categoryBreakdown[0],
          spent: 20,
          percentUsed: 2,
          valuationComplete: false,
          missingRatePairs: ['QQQ->USD'],
        },
      ],
    });
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
    expect(screen.queryByText(/2% used/)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThanOrEqual(1);
  });

  it('shows expenses heading with count', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Expenses (1)')).toBeInTheDocument();
    });
  });

  it('returns to the budget through a chevron link above the title', async () => {
    render(<BudgetEditPage />);

    // The way back names the budget and sits on the line above the title,
    // not among the header actions.
    const back = await screen.findByRole('link', { name: 'Back to February 2026' });
    expect(back).toHaveAttribute('href', '/budgets/budget-1');
    expect(back.querySelector('svg')).not.toBeNull();
    const header = screen.getByTestId('page-header');
    expect(header.contains(back)).toBe(false);
    expect(back.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Back to Dashboard')).toBeNull();
  });

  it('redirects to budgets list on error', async () => {
    mockGetById.mockRejectedValue(new Error('Not found'));

    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/budgets');
    });
  });

  it('opens category edit modal when expense category is clicked', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByTestId('category-form')).toBeInTheDocument();
    });
  });

  it('shows modal title with category name when editing', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    await waitFor(() => {
      expect(screen.getByText('Edit Groceries')).toBeInTheDocument();
    });
  });

  it('shows income categories section when income categories exist', async () => {
    const budgetWithIncome = {
      ...mockBudget,
      categories: [
        ...mockBudget.categories,
        {
          id: 'bc-income-1',
          budgetId: 'budget-1',
          categoryId: 'cat-income',
          category: { id: 'cat-income', name: 'Salary', isIncome: true },
          amount: 5000,
          isIncome: true,
          rolloverType: 'NONE',
          rolloverCap: null,
          flexGroup: null,
          alertWarnPercent: 0,
          alertCriticalPercent: 0,
          notes: null,
          sortOrder: 0,
        },
      ],
    };
    mockGetById.mockResolvedValue(budgetWithIncome);
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Salary')).toBeInTheDocument();
    });
  });

  it('shows parent category name in getCategoryDisplayName', async () => {
    const budgetWithParent = {
      ...mockBudget,
      categories: [
        {
          id: 'bc-sub',
          budgetId: 'budget-1',
          categoryId: 'cat-sub',
          category: {
            id: 'cat-sub',
            name: 'Groceries',
            isIncome: false,
            parent: { id: 'cat-parent', name: 'Food' },
          },
          amount: 400,
          isIncome: false,
          rolloverType: 'ROLLOVER',
          rolloverCap: null,
          flexGroup: 'flex-group-1',
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          notes: null,
          sortOrder: 0,
        },
      ],
    };
    mockGetById.mockResolvedValue(budgetWithParent);
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Food: Groceries')).toBeInTheDocument();
    });
    // Also check rollover text and flex group badge
    expect(screen.getByText('Rollover: rollover')).toBeInTheDocument();
    expect(screen.getByText('flex-group-1')).toBeInTheDocument();
  });

  describe('removing a category', () => {
    async function openRemoveConfirm() {
      render(<BudgetEditPage />);
      await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Groceries'));
      fireEvent.click(await screen.findByTestId('category-remove'));
      return screen.findByTestId('confirm-dialog');
    }

    it('asks for confirmation, naming the line and its allocation, before removing', async () => {
      const dialog = await openRemoveConfirm();

      expect(dialog).toHaveTextContent('Remove Category');
      expect(dialog).toHaveTextContent('Remove "Groceries" from this budget? Its $600.00 allocation');
      // The edit modal closes so the confirmation is the only dialog open.
      expect(screen.queryByTestId('category-form')).not.toBeInTheDocument();
      expect(mockRemoveCategory).not.toHaveBeenCalled();
    });

    it('removes the budget line and reloads the budget on confirm', async () => {
      await openRemoveConfirm();
      mockGetById.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(mockRemoveCategory).toHaveBeenCalledWith('budget-1', 'bc-1');
      });
      await waitFor(() => expect(mockGetById).toHaveBeenCalledWith('budget-1'));
      // The reload settles back to the page, not the spinner.
      await screen.findByTestId('budget-form');
      expect(mockToastSuccess).toHaveBeenCalledWith('Category removed from budget');
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    it('does not remove anything when the confirmation is cancelled', async () => {
      await openRemoveConfirm();

      fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
      expect(mockRemoveCategory).not.toHaveBeenCalled();
    });

    it('reports a failed removal', async () => {
      mockRemoveCategory.mockRejectedValue(new Error('boom'));
      await openRemoveConfirm();

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to remove category');
      });
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });
  });
  describe('transfer income (issue #2141)', () => {
    const account = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      userId: 'user-1',
      isClosed: false,
      ...extra,
    });

    it('offers only the user\'s open accounts no transfer line names, and adds the line', async () => {
      mockGetById.mockResolvedValue({
        ...mockBudget,
        categories: [
          ...mockBudget.categories,
          {
            ...mockBudget.categories[0],
            id: 'bc-save',
            categoryId: null,
            category: null,
            isTransfer: true,
            transferAccountId: 'acc-tfsa',
            transferAccount: { id: 'acc-tfsa', name: 'TFSA', accountType: 'SAVINGS' },
          },
        ],
      });
      mockGetAccounts.mockResolvedValue([
        account('acc-hisa', 'HISA'),
        account('acc-tfsa', 'TFSA'),
        account('acc-old', 'Old', { isClosed: true }),
        account('acc-joint', 'Partner', { userId: 'user-2' }),
      ]);
      mockAddTransferIncomeLine.mockResolvedValue({ id: 'bc-new' });
      render(<BudgetEditPage />);

      fireEvent.click(await screen.findByText('Add Transfer Income'));
      expect(screen.getByText('Pick HISA')).toBeInTheDocument();
      expect(screen.queryByText('Pick TFSA')).not.toBeInTheDocument();
      expect(screen.queryByText('Pick Old')).not.toBeInTheDocument();
      expect(screen.queryByText('Pick Partner')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Pick HISA'));

      await waitFor(() => {
        expect(mockAddTransferIncomeLine).toHaveBeenCalledWith('budget-1', {
          transferAccountId: 'acc-hisa',
          amount: 2000,
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Transfer income added');
    });

    it('reports a refused add', async () => {
      mockGetAccounts.mockResolvedValue([account('acc-hisa', 'HISA')]);
      mockAddTransferIncomeLine.mockRejectedValue(new Error('refused'));
      render(<BudgetEditPage />);

      fireEvent.click(await screen.findByText('Add Transfer Income'));
      fireEvent.click(screen.getByText('Pick HISA'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to add transfer income');
      });
    });

    it('offers no add when the accounts did not load', async () => {
      mockGetAccounts.mockRejectedValue(new Error('down'));
      render(<BudgetEditPage />);

      await screen.findByText('Groceries');
      expect(screen.queryByText('Add Transfer Income')).not.toBeInTheDocument();
    });

    it('names a transfer income line after its source and shows the toggle\'s figure', async () => {
      mockGetById.mockResolvedValue({
        ...mockBudget,
        config: { excludedAccountIds: ['acc-rrsp'], transfersInAsIncome: true },
        categories: [
          ...mockBudget.categories,
          {
            ...mockBudget.categories[0],
            id: 'bc-hisa',
            categoryId: null,
            category: null,
            isIncome: true,
            isTransfer: true,
            transferAccountId: 'acc-hisa',
            transferAccount: { id: 'acc-hisa', name: 'HISA', accountType: 'SAVINGS' },
            amount: 2000,
          },
        ],
      });
      mockGetSummary.mockResolvedValue({
        ...mockSummary,
        outsideTransferIncome: 300,
        totalIncome: 2300,
        categoryIncome: 0,
        transferFunding: 2300,
      });
      render(<BudgetEditPage />);

      expect(await screen.findByText('Transfers from HISA')).toBeInTheDocument();
      expect(screen.getByText('Transfers from accounts outside this budget')).toBeInTheDocument();
      expect(screen.getByText('$300.00')).toBeInTheDocument();
      // The period's funding as its three figures (transfer categories, 6.2).
      expect(screen.getByText('Actual Income')).toBeInTheDocument();
      expect(screen.getByText('$0.00', { selector: 'dd' })).toBeInTheDocument();
      expect(screen.getByText('Transfer Funding')).toBeInTheDocument();
      expect(screen.getByText('Total Budget Funding')).toBeInTheDocument();
      expect(screen.getAllByText('$2300.00', { selector: 'dd' })).toHaveLength(2);
    });
  });

  describe('buckets', () => {
    const buckets = [
      {
        id: 'bk-1',
        budgetId: 'budget-1',
        name: 'Fixed costs',
        targetType: 'PERCENT',
        targetValue: 50,
        carryOver: false,
        carryCap: null,
        sortOrder: 0,
        createdAt: '2026-11-01',
        updatedAt: '2026-11-01',
      },
    ];
    const bucketBudget = {
      ...mockBudget,
      strategy: 'BUCKET',
      buckets,
      categories: [
        { ...mockBudget.categories[0], bucketId: 'bk-1' },
        {
          ...mockBudget.categories[0],
          id: 'bc-2',
          categoryId: 'cat-2',
          category: { id: 'cat-2', name: 'Dining', isIncome: false },
          bucketId: null,
        },
      ],
    };

    it('has no Buckets section for a budget of another strategy, even one holding buckets', async () => {
      mockGetById.mockResolvedValue({ ...bucketBudget, strategy: 'FIFTY_THIRTY_TWENTY' });
      render(<BudgetEditPage />);

      await screen.findByTestId('budget-form');
      expect(screen.queryByRole('heading', { name: 'Buckets' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('bucket-editor')).not.toBeInTheDocument();
      expect(screen.queryByText('Fixed costs')).not.toBeInTheDocument();
      expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
    });

    it('shows the Buckets section with the persisted editor for a Bucket budget', async () => {
      mockGetById.mockResolvedValue(bucketBudget);
      render(<BudgetEditPage />);

      expect(await screen.findByRole('region', { name: 'Buckets' })).toBeInTheDocument();
      expect(screen.getByTestId('bucket-editor')).toBeInTheDocument();
      expect(bucketEditorProps.current).toMatchObject({
        mode: 'persisted',
        currencyCode: 'USD',
        buckets,
      });
    });

    it('badges each expense line with its bucket, or Unassigned', async () => {
      mockGetById.mockResolvedValue(bucketBudget);
      render(<BudgetEditPage />);

      await screen.findByTestId('bucket-editor');
      expect(screen.getByRole('button', { name: /Groceries/ })).toHaveTextContent('Fixed costs');
      expect(screen.getByRole('button', { name: /Dining/ })).toHaveTextContent('Unassigned');
    });

    it('hands the line form the strategy and the buckets', async () => {
      mockGetById.mockResolvedValue(bucketBudget);
      render(<BudgetEditPage />);

      fireEvent.click(await screen.findByRole('button', { name: /Groceries/ }));
      await screen.findByTestId('category-form');
      expect(categoryFormProps.current).toMatchObject({ strategy: 'BUCKET', buckets });
    });

    it('sends each editor callback to the bucket routes of this budget', async () => {
      mockGetById.mockResolvedValue(bucketBudget);
      mockCreateBucket.mockResolvedValue(buckets[0]);
      mockUpdateBucket.mockResolvedValue(buckets[0]);
      mockDeleteBucket.mockResolvedValue(undefined);
      render(<BudgetEditPage />);
      await screen.findByTestId('bucket-editor');

      const data = { name: 'Savings', targetType: 'PERCENT', targetValue: 20 };
      await act(async () => {
        await bucketEditorProps.current.onCreate(data);
        await bucketEditorProps.current.onUpdate('bk-1', { name: 'Needs' });
        await bucketEditorProps.current.onDelete('bk-1');
      });

      expect(mockCreateBucket).toHaveBeenCalledWith('budget-1', data);
      expect(mockUpdateBucket).toHaveBeenCalledWith('budget-1', 'bk-1', { name: 'Needs' });
      expect(mockDeleteBucket).toHaveBeenCalledWith('budget-1', 'bk-1');
    });

    it('re-reads the budget in place after a bucket write, so the list sees the new bucket', async () => {
      mockGetById.mockResolvedValue(bucketBudget);
      render(<BudgetEditPage />);
      await screen.findByTestId('bucket-editor');
      expect(screen.getByRole('button', { name: /Dining/ })).toHaveTextContent('Unassigned');

      const savings = { ...buckets[0], id: 'bk-2', name: 'Savings', sortOrder: 1 };
      mockGetById.mockResolvedValue({
        ...bucketBudget,
        buckets: [...buckets, savings],
        categories: [bucketBudget.categories[0], { ...bucketBudget.categories[1], bucketId: 'bk-2' }],
      });
      mockGetById.mockClear();
      await act(async () => {
        await bucketEditorProps.current.onWritten();
      });

      expect(mockGetById).toHaveBeenCalledTimes(1);
      expect(mockGetSummary).toHaveBeenCalled();
      // In place: the editor stayed mounted and never gave way to the spinner.
      expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Dining/ })).toHaveTextContent('Savings');
      expect(bucketEditorProps.current.buckets).toEqual([...buckets, savings]);
    });

    it('reports a failed re-read without leaving the page', async () => {
      mockGetById.mockResolvedValue(bucketBudget);
      render(<BudgetEditPage />);
      await screen.findByTestId('bucket-editor');

      mockGetById.mockRejectedValue(new Error('boom'));
      await act(async () => {
        await bucketEditorProps.current.onWritten();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to load budget');
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.getByTestId('bucket-editor')).toBeInTheDocument();
    });
  });
});
