import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import ImportPage from './page';

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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD' },
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

// Mock API libs
const mockGetAllAccounts = vi.fn().mockResolvedValue([]);
const mockGetAllCategories = vi.fn().mockResolvedValue([]);
const mockGetSecurities = vi.fn().mockResolvedValue([]);
const mockGetCurrencies = vi.fn().mockResolvedValue([]);
const mockParseQif = vi.fn();
const mockImportQif = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
    create: vi.fn(),
    createInvestmentPair: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    lookupSecurity: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: (...args: any[]) => mockGetCurrencies(...args),
  },
}));

vi.mock('@/lib/import', () => ({
  importApi: {
    parseQif: (...args: any[]) => mockParseQif(...args),
    importQif: (...args: any[]) => mockImportQif(...args),
  },
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (error: any, fallback: string) => fallback,
}));

// Mock child components with data-testid markers
vi.mock('@/components/import/UploadStep', () => ({
  UploadStep: ({ isLoading, onFileSelect }: any) => (
    <div data-testid="upload-step">
      <span>{isLoading ? 'Processing...' : 'Upload QIF Files'}</span>
      <input
        data-testid="file-input"
        type="file"
        onChange={onFileSelect}
      />
    </div>
  ),
}));

vi.mock('@/components/import/SelectAccountStep', () => ({
  SelectAccountStep: ({ setStep }: any) => (
    <div data-testid="select-account-step">
      <span>Select Account</span>
      <button
        data-testid="next-to-map-categories"
        onClick={() => setStep('mapCategories')}
      >
        Next to Map Categories
      </button>
      <button
        data-testid="next-to-map-securities"
        onClick={() => setStep('mapSecurities')}
      >
        Next to Map Securities
      </button>
      <button
        data-testid="next-to-map-accounts"
        onClick={() => setStep('mapAccounts')}
      >
        Next to Map Accounts
      </button>
      <button
        data-testid="next-to-review"
        onClick={() => setStep('review')}
      >
        Next to Review
      </button>
      <button
        data-testid="back-to-upload"
        onClick={() => setStep('upload')}
      >
        Back to Upload
      </button>
    </div>
  ),
}));

vi.mock('@/components/import/MapCategoriesStep', () => ({
  MapCategoriesStep: ({ setStep }: any) => (
    <div data-testid="map-categories-step">
      <span>Map Categories</span>
      <button
        data-testid="back-to-select-account"
        onClick={() => setStep('selectAccount')}
      >
        Back
      </button>
      <button
        data-testid="next-from-categories"
        onClick={() => setStep('mapSecurities')}
      >
        Next
      </button>
    </div>
  ),
}));

vi.mock('@/components/import/MapSecuritiesStep', () => ({
  MapSecuritiesStep: ({ setStep }: any) => (
    <div data-testid="map-securities-step">
      <span>Map Securities</span>
      <button
        data-testid="back-from-securities"
        onClick={() => setStep('mapCategories')}
      >
        Back
      </button>
      <button
        data-testid="next-from-securities"
        onClick={() => setStep('mapAccounts')}
      >
        Next
      </button>
    </div>
  ),
}));

vi.mock('@/components/import/MapAccountsStep', () => ({
  MapAccountsStep: ({ setStep }: any) => (
    <div data-testid="map-accounts-step">
      <span>Map Accounts</span>
      <button
        data-testid="back-from-accounts"
        onClick={() => setStep('mapSecurities')}
      >
        Back
      </button>
      <button
        data-testid="next-from-accounts"
        onClick={() => setStep('review')}
      >
        Next
      </button>
    </div>
  ),
}));

vi.mock('@/components/import/ReviewStep', () => ({
  ReviewStep: ({ setStep, handleImport, isLoading }: any) => (
    <div data-testid="review-step">
      <span>Review Import</span>
      <button
        data-testid="back-from-review"
        onClick={() => setStep('mapAccounts')}
      >
        Back
      </button>
      <button
        data-testid="import-button"
        onClick={handleImport}
        disabled={isLoading}
      >
        {isLoading ? 'Importing...' : 'Import'}
      </button>
    </div>
  ),
}));

vi.mock('@/components/import/CompleteStep', () => ({
  CompleteStep: ({ onImportMore }: any) => (
    <div data-testid="complete-step">
      <span>Import Complete</span>
      <button data-testid="import-more" onClick={onImportMore}>
        Import More
      </button>
    </div>
  ),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

const mockParsedData = {
  accountType: 'CHEQUING',
  transactionCount: 5,
  categories: ['Groceries', 'Utilities'],
  transferAccounts: ['Savings'],
  securities: [],
  dateRange: { start: '2025-01-01', end: '2025-01-31' },
  detectedDateFormat: 'MM/DD/YYYY' as const,
  sampleDates: ['01/15/2025'],
};

const mockAccounts = [
  {
    id: 'acc-1',
    name: 'Chequing',
    accountType: 'CHEQUING',
    currencyCode: 'USD',
    openingBalance: 0,
    currentBalance: 1000,
    accountSubType: null,
    linkedAccountId: null,
    canDelete: true,
  },
  {
    id: 'acc-2',
    name: 'Savings',
    accountType: 'SAVINGS',
    currencyCode: 'USD',
    openingBalance: 0,
    currentBalance: 5000,
    accountSubType: null,
    linkedAccountId: null,
    canDelete: true,
  },
];

const mockCategories = [
  { id: 'cat-1', name: 'Groceries', parentId: null, type: 'EXPENSE' },
  { id: 'cat-2', name: 'Utilities', parentId: null, type: 'EXPENSE' },
];

const mockCurrencies = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01' },
];

/**
 * Creates a File object with a polyfilled .text() method.
 * jsdom's File implementation does not support .text(), but the source code
 * calls file.text() to read file contents. This helper ensures the File
 * works correctly in tests.
 */
function createTestFile(content: string, name: string, type = 'application/qif'): File {
  const file = new File([content], name, { type });
  file.text = () => Promise.resolve(content);
  return file;
}

/**
 * Helper to simulate a file upload via the mock UploadStep input.
 * Sets up the file on the input and fires the change event.
 * Waits for data loading to complete before triggering the upload.
 */
async function uploadFile(fileContent: string, fileName: string) {
  // Wait for initial data load to finish so handleFileSelect has current accounts
  await waitFor(() => {
    expect(mockGetAllAccounts).toHaveBeenCalled();
  });

  const fileInput = screen.getByTestId('file-input');
  const file = createTestFile(fileContent, fileName);
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fireEvent.change(fileInput);
}

describe('ImportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    mockGetCurrencies.mockResolvedValue([]);
  });

  describe('initial render', () => {
    it('renders the page header with "Import Transactions" title', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(screen.getByText('Import Transactions')).toBeInTheDocument();
      });
    });

    it('renders the subtitle', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(screen.getByText('Import transactions from a QIF file')).toBeInTheDocument();
      });
    });

    it('renders within page layout', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('shows the upload step initially', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });
    });

    it('does not show other steps initially', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('select-account-step')).not.toBeInTheDocument();
      expect(screen.queryByTestId('map-categories-step')).not.toBeInTheDocument();
      expect(screen.queryByTestId('map-securities-step')).not.toBeInTheDocument();
      expect(screen.queryByTestId('map-accounts-step')).not.toBeInTheDocument();
      expect(screen.queryByTestId('review-step')).not.toBeInTheDocument();
      expect(screen.queryByTestId('complete-step')).not.toBeInTheDocument();
    });
  });

  describe('step indicator', () => {
    it('renders the step progress indicator', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        // The step indicator renders circles with step numbers
        // On the upload step, step 1 should be shown as active
        const stepIndicators = screen.getByTestId('page-layout').querySelectorAll('.rounded-full');
        expect(stepIndicators.length).toBeGreaterThan(0);
      });
    });
  });

  describe('data loading', () => {
    it('loads accounts on mount', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(mockGetAllAccounts).toHaveBeenCalled();
      });
    });

    it('loads categories on mount', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(mockGetAllCategories).toHaveBeenCalled();
      });
    });

    it('loads securities on mount', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(mockGetSecurities).toHaveBeenCalledWith(true);
      });
    });

    it('loads currencies on mount', async () => {
      render(<ImportPage />);
      await waitFor(() => {
        expect(mockGetCurrencies).toHaveBeenCalled();
      });
    });

    it('loads all data in parallel via Promise.all', async () => {
      // All four API calls should be made on mount
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await waitFor(() => {
        expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);
        expect(mockGetAllCategories).toHaveBeenCalledTimes(1);
        expect(mockGetSecurities).toHaveBeenCalledTimes(1);
        expect(mockGetCurrencies).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('error states', () => {
    it('shows error toast when data loading fails', async () => {
      const toast = (await import('react-hot-toast')).default;
      mockGetAllAccounts.mockRejectedValue(new Error('Network error'));

      render(<ImportPage />);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load data');
      });
    });

    it('shows error toast when file parsing fails', async () => {
      const toast = (await import('react-hot-toast')).default;
      mockParseQif.mockRejectedValue(new Error('Invalid file'));

      render(<ImportPage />);

      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });

      // Simulate file selection that triggers parse failure
      await uploadFile('invalid content', 'test.qif');

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to parse QIF file(s)');
      });
    });
  });

  describe('step progression', () => {
    it('transitions from upload to selectAccount after file upload', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });

      // Simulate file selection
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('upload-step')).not.toBeInTheDocument();
    });

    it('navigates from selectAccount to mapCategories', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // First go to selectAccount via file upload
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Navigate to mapCategories
      fireEvent.click(screen.getByTestId('next-to-map-categories'));

      await waitFor(() => {
        expect(screen.getByTestId('map-categories-step')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('select-account-step')).not.toBeInTheDocument();
    });

    it('navigates from selectAccount directly to review', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-review'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });
    });

    it('navigates from mapCategories to mapSecurities', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // Upload a file to progress
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-map-categories'));

      await waitFor(() => {
        expect(screen.getByTestId('map-categories-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-from-categories'));

      await waitFor(() => {
        expect(screen.getByTestId('map-securities-step')).toBeInTheDocument();
      });
    });

    it('navigates from mapSecurities to mapAccounts', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-map-securities'));

      await waitFor(() => {
        expect(screen.getByTestId('map-securities-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-from-securities'));

      await waitFor(() => {
        expect(screen.getByTestId('map-accounts-step')).toBeInTheDocument();
      });
    });

    it('navigates from mapAccounts to review', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-map-accounts'));

      await waitFor(() => {
        expect(screen.getByTestId('map-accounts-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-from-accounts'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });
    });
  });

  describe('back navigation', () => {
    it('navigates back from selectAccount to upload', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('back-to-upload'));

      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });
    });

    it('navigates back from mapCategories to selectAccount', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-map-categories'));

      await waitFor(() => {
        expect(screen.getByTestId('map-categories-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('back-to-select-account'));

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });
    });

    it('navigates back from review to mapAccounts', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-map-accounts'));

      await waitFor(() => {
        expect(screen.getByTestId('map-accounts-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-from-accounts'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('back-from-review'));

      await waitFor(() => {
        expect(screen.getByTestId('map-accounts-step')).toBeInTheDocument();
      });
    });
  });

  describe('import execution', () => {
    it('transitions to complete step after successful import', async () => {
      mockParseQif.mockResolvedValue({
        ...mockParsedData,
        categories: [],
        transferAccounts: [],
        securities: [],
      });
      mockImportQif.mockResolvedValue({
        imported: 5,
        skipped: 0,
        errors: 0,
        errorMessages: [],
        categoriesCreated: 0,
        accountsCreated: 0,
        payeesCreated: 0,
        securitiesCreated: 0,
      });
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue([]);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // Upload file
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Go to review
      fireEvent.click(screen.getByTestId('next-to-review'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });

      // Execute import
      fireEvent.click(screen.getByTestId('import-button'));

      await waitFor(() => {
        expect(screen.getByTestId('complete-step')).toBeInTheDocument();
      });
    });

    it('shows error toast when import fails', async () => {
      const toast = (await import('react-hot-toast')).default;
      mockParseQif.mockResolvedValue({
        ...mockParsedData,
        categories: [],
        transferAccounts: [],
        securities: [],
      });
      mockImportQif.mockRejectedValue(new Error('Import failed'));
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue([]);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // Upload file
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Go to review
      fireEvent.click(screen.getByTestId('next-to-review'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });

      // Execute import
      fireEvent.click(screen.getByTestId('import-button'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Import failed');
      });
    });
  });

  describe('import more (reset)', () => {
    it('resets to upload step when import more is clicked', async () => {
      mockParseQif.mockResolvedValue({
        ...mockParsedData,
        categories: [],
        transferAccounts: [],
        securities: [],
      });
      mockImportQif.mockResolvedValue({
        imported: 5,
        skipped: 0,
        errors: 0,
        errorMessages: [],
        categoriesCreated: 0,
        accountsCreated: 0,
        payeesCreated: 0,
        securitiesCreated: 0,
      });
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue([]);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // Upload file
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-to-review'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('import-button'));

      await waitFor(() => {
        expect(screen.getByTestId('complete-step')).toBeInTheDocument();
      });

      // Click import more to reset
      fireEvent.click(screen.getByTestId('import-more'));

      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });
    });
  });

  describe('loading states', () => {
    it('passes isLoading to upload step during file processing', async () => {
      // Create a deferred promise to control when parseQif resolves
      let resolveParseQif: (value: any) => void;
      mockParseQif.mockReturnValue(new Promise((resolve) => {
        resolveParseQif = resolve;
      }));
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });

      // The upload step should initially show 'Upload QIF Files' (not loading)
      expect(screen.getByText('Upload QIF Files')).toBeInTheDocument();

      // Simulate file selection which triggers loading
      // Wait for data to be loaded first
      await waitFor(() => {
        expect(mockGetAllAccounts).toHaveBeenCalled();
      });

      const fileInput = screen.getByTestId('file-input');
      const file = createTestFile('!Type:Bank\n^', 'test.qif');
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fireEvent.change(fileInput);

      // During parse, isLoading should be true and the component should show Processing
      await waitFor(() => {
        expect(screen.getByText('Processing...')).toBeInTheDocument();
      });

      // Resolve to complete the flow
      resolveParseQif!(mockParsedData);

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });
    });
  });

  describe('conditional step visibility', () => {
    it('skips map categories step indicator when no categories in parsed data', async () => {
      const parsedWithNoCategories = {
        ...mockParsedData,
        categories: [],
        transferAccounts: [],
        securities: [],
      };
      mockParseQif.mockResolvedValue(parsedWithNoCategories);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue([]);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // Upload file - no categories means category mapping step is unnecessary
      await uploadFile('!Type:Bank\n^', 'test.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Navigate directly to review (skipping categories/securities/accounts)
      fireEvent.click(screen.getByTestId('next-to-review'));

      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });
    });

    it('handles parsed data with securities', async () => {
      const parsedWithSecurities = {
        ...mockParsedData,
        accountType: 'INVESTMENT',
        categories: [],
        transferAccounts: [],
        securities: ['AAPL', 'GOOGL'],
      };
      mockParseQif.mockResolvedValue(parsedWithSecurities);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue([]);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      await uploadFile('!Type:Invst\n^', 'investments.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Navigate to map securities step
      fireEvent.click(screen.getByTestId('next-to-map-securities'));

      await waitFor(() => {
        expect(screen.getByTestId('map-securities-step')).toBeInTheDocument();
      });
    });
  });

  describe('file upload with empty file list', () => {
    it('does not change step when no files are selected', async () => {
      render(<ImportPage />);

      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });

      // Simulate file input change with no files
      const fileInput = screen.getByTestId('file-input');
      Object.defineProperty(fileInput, 'files', { value: [], configurable: true });
      fireEvent.change(fileInput);

      // Should remain on upload step
      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });
      expect(mockParseQif).not.toHaveBeenCalled();
    });
  });

  describe('multi-step navigation round trip', () => {
    it('supports full forward and backward navigation through wizard', async () => {
      mockParseQif.mockResolvedValue(mockParsedData);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetSecurities.mockResolvedValue([]);
      mockGetCurrencies.mockResolvedValue(mockCurrencies);

      render(<ImportPage />);

      // Step 1: Upload
      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });

      // Upload file -> Step 2: Select Account
      await uploadFile('!Type:Bank\n^', 'chequing.qif');

      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Step 2 -> Step 3: Map Categories
      fireEvent.click(screen.getByTestId('next-to-map-categories'));
      await waitFor(() => {
        expect(screen.getByTestId('map-categories-step')).toBeInTheDocument();
      });

      // Step 3 -> Step 4: Map Securities
      fireEvent.click(screen.getByTestId('next-from-categories'));
      await waitFor(() => {
        expect(screen.getByTestId('map-securities-step')).toBeInTheDocument();
      });

      // Step 4 -> Step 5: Map Accounts
      fireEvent.click(screen.getByTestId('next-from-securities'));
      await waitFor(() => {
        expect(screen.getByTestId('map-accounts-step')).toBeInTheDocument();
      });

      // Step 5 -> Step 6: Review
      fireEvent.click(screen.getByTestId('next-from-accounts'));
      await waitFor(() => {
        expect(screen.getByTestId('review-step')).toBeInTheDocument();
      });

      // Now navigate back: Review -> Map Accounts
      fireEvent.click(screen.getByTestId('back-from-review'));
      await waitFor(() => {
        expect(screen.getByTestId('map-accounts-step')).toBeInTheDocument();
      });

      // Map Accounts -> Map Securities
      fireEvent.click(screen.getByTestId('back-from-accounts'));
      await waitFor(() => {
        expect(screen.getByTestId('map-securities-step')).toBeInTheDocument();
      });

      // Map Securities -> Map Categories
      fireEvent.click(screen.getByTestId('back-from-securities'));
      await waitFor(() => {
        expect(screen.getByTestId('map-categories-step')).toBeInTheDocument();
      });

      // Map Categories -> Select Account
      fireEvent.click(screen.getByTestId('back-to-select-account'));
      await waitFor(() => {
        expect(screen.getByTestId('select-account-step')).toBeInTheDocument();
      });

      // Select Account -> Upload
      fireEvent.click(screen.getByTestId('back-to-upload'));
      await waitFor(() => {
        expect(screen.getByTestId('upload-step')).toBeInTheDocument();
      });
    });
  });
});
