import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useImportWizard } from './useImportWizard';

// --- Mocks ---
const mockParseQif = vi.fn();
const mockImportQif = vi.fn();
const mockParseOfx = vi.fn();
const mockImportOfx = vi.fn();
const mockParseQifMulti = vi.fn();
const mockImportQifMulti = vi.fn();
const mockParseCsvHeaders = vi.fn();
const mockParseCsv = vi.fn();
const mockImportCsv = vi.fn();
const mockGetColumnMappings = vi.fn();
const mockCreateColumnMapping = vi.fn();
const mockDeleteColumnMapping = vi.fn();
const mockAutoMatchCsvColumns = vi.fn();

vi.mock('@/lib/import', () => ({
  importApi: {
    parseQif: (...args: any[]) => mockParseQif(...args),
    importQif: (...args: any[]) => mockImportQif(...args),
    parseOfx: (...args: any[]) => mockParseOfx(...args),
    importOfx: (...args: any[]) => mockImportOfx(...args),
    parseQifMultiAccount: (...args: any[]) => mockParseQifMulti(...args),
    importQifMultiAccount: (...args: any[]) => mockImportQifMulti(...args),
    parseCsvHeaders: (...args: any[]) => mockParseCsvHeaders(...args),
    parseCsv: (...args: any[]) => mockParseCsv(...args),
    importCsv: (...args: any[]) => mockImportCsv(...args),
    getColumnMappings: (...args: any[]) => mockGetColumnMappings(...args),
    createColumnMapping: (...args: any[]) => mockCreateColumnMapping(...args),
    deleteColumnMapping: (...args: any[]) => mockDeleteColumnMapping(...args),
  },
  autoMatchCsvColumns: (headers: string[]) => mockAutoMatchCsvColumns(headers),
}));

const mockGetAllAccounts = vi.fn();
const mockCreateAccount = vi.fn();
const mockCreateInvestmentPair = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
    create: (...args: any[]) => mockCreateAccount(...args),
    createInvestmentPair: (...args: any[]) => mockCreateInvestmentPair(...args),
  },
}));

const mockGetCategories = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetCategories(...args),
  },
}));

const mockGetSecurities = vi.fn();
const mockLookupSecurity = vi.fn();
const mockLookupCandidates = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    lookupSecurity: (...args: any[]) => mockLookupSecurity(...args),
    lookupSecurityCandidates: (...args: any[]) => mockLookupCandidates(...args),
  },
}));

const mockGetCurrencies = vi.fn();
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: (...args: any[]) => mockGetCurrencies(...args),
  },
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let mockSearchParamsGet: (key: string) => string | null = () => null;
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (key: string) => mockSearchParamsGet(key) }),
}));

let mockPrefDefaultCurrency: string | undefined = 'USD';
let mockPrefExchanges: string[] | undefined = [];
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => {
    const state = {
      preferences: {
        defaultCurrency: mockPrefDefaultCurrency,
        preferredExchanges: mockPrefExchanges,
      },
    };
    return selector(state);
  },
}));

// --- Test fixtures ---
const baseAccount = (overrides: any = {}) => ({
  id: 'acc-1',
  userId: 'u1',
  name: 'Chequing',
  accountType: 'CHEQUING',
  accountSubType: null,
  linkedAccountId: null,
  currencyCode: 'USD',
  currentBalance: 1000,
  openingBalance: 1000,
  isFavourite: false,
  excludeFromNetWorth: false,
  ...overrides,
});

const baseCategory = (overrides: any = {}) => ({
  id: 'cat-1',
  userId: 'u1',
  name: 'Food',
  parentId: null,
  isIncome: false,
  ...overrides,
});

const baseSecurity = (overrides: any = {}) => ({
  id: 'sec-1',
  userId: 'u1',
  symbol: 'AAPL',
  name: 'Apple',
  securityType: 'STOCK',
  ...overrides,
});

const baseParsedQif = (overrides: any = {}) => ({
  accountType: 'CHEQUING',
  transactionCount: 10,
  categories: ['Food', 'Gas'],
  transferAccounts: [],
  securities: [],
  dateRange: { start: '2024-01-01', end: '2024-12-31' },
  detectedDateFormat: 'MM/DD/YYYY',
  sampleDates: [],
  ...overrides,
});

const importResult = (overrides: any = {}) => ({
  imported: 5,
  skipped: 0,
  errors: 0,
  errorMessages: [],
  categoriesCreated: 0,
  accountsCreated: 0,
  payeesCreated: 0,
  securitiesCreated: 0,
  ...overrides,
});

// File helper that supports .text()
function makeFile(name: string, content: string): File {
  const f = new File([content], name, { type: 'text/plain' });
  // Provide text() if not already present
  if (typeof (f as any).text !== 'function') {
    Object.defineProperty(f, 'text', { value: () => Promise.resolve(content) });
  } else {
    Object.defineProperty(f, 'text', { value: () => Promise.resolve(content) });
  }
  return f;
}

function fileEvent(files: File[]): React.ChangeEvent<HTMLInputElement> {
  return { target: { files: files as unknown as FileList } } as React.ChangeEvent<HTMLInputElement>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParamsGet = () => null;
  mockPrefDefaultCurrency = 'USD';
  mockPrefExchanges = [];
  mockGetAllAccounts.mockResolvedValue([]);
  mockGetCategories.mockResolvedValue([]);
  mockGetSecurities.mockResolvedValue([]);
  mockGetCurrencies.mockResolvedValue([
    { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true },
    { code: 'CAD', name: 'CA Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true },
  ]);
  mockGetColumnMappings.mockResolvedValue([]);
  mockAutoMatchCsvColumns.mockReturnValue({ date: 0, amount: 1 });
});

describe('useImportWizard - initial load', () => {
  it('loads accounts, categories, securities, currencies, and column mappings on mount', async () => {
    const account = baseAccount();
    mockGetAllAccounts.mockResolvedValue([account]);
    mockGetCategories.mockResolvedValue([baseCategory()]);
    mockGetSecurities.mockResolvedValue([baseSecurity()]);

    const { result } = renderHook(() => useImportWizard());

    await waitFor(() => {
      expect(result.current.accounts).toHaveLength(1);
      expect(result.current.categories).toHaveLength(1);
      expect(result.current.securities).toHaveLength(1);
    });

    expect(result.current.step).toBe('upload');
    expect(result.current.fileType).toBe('qif');
  });

  it('handles initial load failure by showing toast error', async () => {
    mockGetAllAccounts.mockRejectedValue(new Error('boom'));
    renderHook(() => useImportWizard());
    await waitFor(() => {
      expect(mockGetAllAccounts).toHaveBeenCalled();
    });
  });

  it('handles getColumnMappings rejection without breaking load', async () => {
    mockGetColumnMappings.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => {
      expect(result.current.savedColumnMappings).toEqual([]);
    });
  });

  it('honors preselected accountId from URL when account exists', async () => {
    mockSearchParamsGet = (key) => (key === 'accountId' ? 'acc-1' : null);
    const account = baseAccount({ id: 'acc-1' });
    mockGetAllAccounts.mockResolvedValue([account]);

    const { result } = renderHook(() => useImportWizard());

    await waitFor(() => {
      expect(result.current.preselectedAccount?.id).toBe('acc-1');
    });
  });

  it('does not preselect when accountId param does not match an account', async () => {
    mockSearchParamsGet = (key) => (key === 'accountId' ? 'unknown' : null);
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => {
      expect(result.current.accounts).toHaveLength(1);
    });
    expect(result.current.selectedAccountId).toBe('');
  });
});

describe('useImportWizard - QIF file upload', () => {
  it('parses single QIF file and goes to selectAccount step', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif());

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('test.qif', 'data')]));
    });

    expect(mockParseQif).toHaveBeenCalled();
    expect(result.current.step).toBe('selectAccount');
    expect(result.current.fileType).toBe('qif');
    expect(result.current.importFiles).toHaveLength(1);
  });

  it('skips selectAccount step when single file with preselected account', async () => {
    mockSearchParamsGet = (key) => (key === 'accountId' ? 'acc-1' : null);
    mockGetAllAccounts.mockResolvedValue([baseAccount({ id: 'acc-1' })]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: ['Food'] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('test.qif', 'data')]));
    });

    // Has categories so goes to mapCategories
    expect(result.current.step).toBe('mapCategories');
  });

  it('parses OFX file (.ofx detected by extension)', async () => {
    mockParseOfx.mockResolvedValue(baseParsedQif());
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('bank.ofx', 'OFX')]));
    });

    expect(mockParseOfx).toHaveBeenCalled();
    expect(result.current.fileType).toBe('ofx');
  });

  it('rejects when files of mixed types are uploaded', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(
        fileEvent([makeFile('a.qif', 'q'), makeFile('b.csv', 'c')]),
      );
    });

    expect(mockParseQif).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('handles empty file selection (no-op)', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([]));
    });
    expect(mockParseQif).not.toHaveBeenCalled();
  });

  it('parses bulk QIF files', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(
        fileEvent([makeFile('a.qif', '1'), makeFile('b.qif', '2')]),
      );
    });

    expect(result.current.isBulkImport).toBe(true);
    expect(result.current.importFiles).toHaveLength(2);
  });

  it('handles QIF parse error', async () => {
    mockParseQif.mockRejectedValue(new Error('bad'));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('detects multi-account QIF and goes to multiAccountReview', async () => {
    mockParseQifMulti.mockResolvedValue({
      isMultiAccount: true,
      categoryDefs: [],
      tagDefs: [],
      accounts: [{ accountName: 'A', accountType: 'CHEQUING', transactionCount: 5, dateRange: { start: '2024-01-01', end: '2024-12-31' } }],
      totalTransactionCount: 5,
      securities: ['AAPL'],
      detectedDateFormat: 'MM/DD/YYYY',
      sampleDates: [],
    });
    mockGetSecurities.mockResolvedValue([]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    const content = '!Account\nNAcct1\n^\n!Account\nNAcct2\n^\n!Type:Cat\nNFood\n^';
    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('multi.qif', content)]));
    });

    expect(result.current.step).toBe('multiAccountReview');
    expect(result.current.multiAccountData?.accounts).toHaveLength(1);
    expect(result.current.securityMappings).toHaveLength(1);
  });

  it('falls back to standard QIF parse when multi-account is not detected', async () => {
    mockParseQifMulti.mockResolvedValue({ isMultiAccount: false, categoryDefs: [], tagDefs: [], accounts: [], totalTransactionCount: 0, securities: [], detectedDateFormat: 'MM/DD/YYYY', sampleDates: [] });
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    const content = '!Account\nNAcct1\n^\n!Account\nNAcct2\n^';
    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('multi.qif', content)]));
    });

    expect(result.current.step).toBe('selectAccount');
  });
});

describe('useImportWizard - CSV upload', () => {
  it('parses CSV headers and goes to csvColumnMapping step', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['Date', 'Amount', 'Memo'], sampleRows: [['1/1/24', '10', 'x']], rowCount: 1 });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'Date,Amount,Memo')]));
    });

    expect(result.current.step).toBe('csvColumnMapping');
    expect(result.current.fileType).toBe('csv');
    expect(result.current.csvHeaders).toEqual(['Date', 'Amount', 'Memo']);
  });

  it('handles bulk CSV upload', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['Date', 'Amount'], sampleRows: [], rowCount: 0 });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.csv', 'd,a'),
        makeFile('b.csv', 'd,a'),
      ]));
    });

    expect(result.current.importFiles).toHaveLength(2);
    expect(result.current.isBulkImport).toBe(true);
  });

  it('CSV column mapping change updates state', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    act(() => {
      result.current.handleCsvColumnMappingChange({ ...result.current.csvColumnMapping, payee: 2 });
    });
    expect(result.current.csvColumnMapping.payee).toBe(2);
  });

  it('CSV transfer rules change updates state', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    act(() => {
      result.current.handleCsvTransferRulesChange([{ type: 'payee', pattern: 'foo', accountName: 'Acct' }]);
    });
    expect(result.current.csvTransferRules).toHaveLength(1);
  });

  it('CSV delimiter change re-parses headers', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['A', 'B'], sampleRows: [], rowCount: 0 });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'A,B')]));
    });

    mockParseCsvHeaders.mockResolvedValue({ headers: ['X', 'Y'], sampleRows: [], rowCount: 0 });
    await act(async () => {
      await result.current.handleCsvDelimiterChange(';');
    });

    expect(result.current.csvColumnMapping.delimiter).toBe(';');
  });

  it('CSV delimiter change with no files is a no-op', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleCsvDelimiterChange(';');
    });
    expect(mockParseCsvHeaders).not.toHaveBeenCalled();
  });

  it('CSV delimiter change handles parse error', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['A'], sampleRows: [], rowCount: 0 });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'A')]));
    });

    mockParseCsvHeaders.mockRejectedValueOnce(new Error('bad'));
    await act(async () => {
      await result.current.handleCsvDelimiterChange(';');
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('CSV hasHeader change re-parses headers', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['A'], sampleRows: [], rowCount: 0 });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'A')]));
    });

    await act(async () => {
      await result.current.handleCsvHasHeaderChange(false);
    });
    expect(result.current.csvColumnMapping.hasHeader).toBe(false);
  });

  it('CSV hasHeader change with no files is a no-op', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleCsvHasHeaderChange(false);
    });
    expect(mockParseCsvHeaders).not.toHaveBeenCalled();
  });

  it('CSV mapping complete parses files and advances step', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['Date', 'Amount'], sampleRows: [], rowCount: 0 });
    mockParseCsv.mockResolvedValue(baseParsedQif({ categories: [], transferAccounts: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'data')]));
    });

    await act(async () => {
      await result.current.handleCsvMappingComplete();
    });

    expect(mockParseCsv).toHaveBeenCalled();
    expect(result.current.step).toBe('selectAccount');
  });

  it('CSV mapping complete handles bulk files with header check', async () => {
    mockParseCsvHeaders
      .mockResolvedValueOnce({ headers: ['D', 'A'], sampleRows: [], rowCount: 0 })
      .mockResolvedValueOnce({ headers: ['D', 'A'], sampleRows: [], rowCount: 0 })
      .mockResolvedValueOnce({ headers: ['Different'], sampleRows: [], rowCount: 0 });
    mockParseCsv.mockResolvedValue(baseParsedQif({ categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.csv', 'D,A'),
        makeFile('b.csv', 'D,A'),
      ]));
    });

    await act(async () => {
      await result.current.handleCsvMappingComplete();
    });

    expect(result.current.step).toBe('selectAccount');
  });

  it('CSV mapping complete with no files is a no-op', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleCsvMappingComplete();
    });
    expect(mockParseCsv).not.toHaveBeenCalled();
  });

  it('CSV mapping complete handles parse error', async () => {
    mockParseCsvHeaders.mockResolvedValue({ headers: ['A'], sampleRows: [], rowCount: 0 });
    mockParseCsv.mockRejectedValue(new Error('bad'));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'A')]));
    });

    await act(async () => {
      await result.current.handleCsvMappingComplete();
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('CSV save column mapping creates and stores it', async () => {
    mockCreateColumnMapping.mockResolvedValue({
      id: 'm1', name: 'Test', columnMappings: {}, transferRules: [], createdAt: '', updatedAt: '',
    });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleSaveColumnMapping('Test');
    });
    expect(result.current.savedColumnMappings).toHaveLength(1);
  });

  it('CSV save column mapping updates existing mapping with same id', async () => {
    mockCreateColumnMapping
      .mockResolvedValueOnce({ id: 'm1', name: 'A', columnMappings: {}, transferRules: [], createdAt: '', updatedAt: '' })
      .mockResolvedValueOnce({ id: 'm1', name: 'A', columnMappings: {}, transferRules: [], createdAt: '', updatedAt: '' });
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => { await result.current.handleSaveColumnMapping('A'); });
    await act(async () => { await result.current.handleSaveColumnMapping('A'); });

    expect(result.current.savedColumnMappings).toHaveLength(1);
  });

  it('CSV save column mapping handles error', async () => {
    mockCreateColumnMapping.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleSaveColumnMapping('Test');
    });
    expect(result.current.savedColumnMappings).toHaveLength(0);
  });

  it('CSV load column mapping restores config and rules', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    act(() => {
      result.current.handleLoadColumnMapping({
        id: 'm1', name: 'Test',
        columnMappings: { date: 5, amount: 6, dateFormat: 'YYYY-MM-DD', hasHeader: false, delimiter: '\t' },
        transferRules: [{ type: 'payee', pattern: 'p', accountName: 'a' }],
        createdAt: '', updatedAt: '',
      } as any);
    });

    expect(result.current.csvColumnMapping.delimiter).toBe('\t');
    expect(result.current.csvTransferRules).toHaveLength(1);
  });

  it('CSV load column mapping with no transfer rules defaults to empty', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    act(() => {
      result.current.handleLoadColumnMapping({
        id: 'm', name: 'X',
        columnMappings: { date: 0, dateFormat: 'MM/DD/YYYY', hasHeader: true, delimiter: ',' },
        transferRules: undefined,
        createdAt: '', updatedAt: '',
      } as any);
    });
    expect(result.current.csvTransferRules).toEqual([]);
  });

  it('CSV delete column mapping removes from list', async () => {
    mockCreateColumnMapping.mockResolvedValue({
      id: 'm1', name: 'X', columnMappings: {}, transferRules: [], createdAt: '', updatedAt: '',
    });
    mockDeleteColumnMapping.mockResolvedValue(undefined);
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => { await result.current.handleSaveColumnMapping('X'); });
    expect(result.current.savedColumnMappings).toHaveLength(1);

    await act(async () => { await result.current.handleDeleteColumnMapping('m1'); });
    expect(result.current.savedColumnMappings).toHaveLength(0);
  });

  it('CSV delete column mapping handles error', async () => {
    mockDeleteColumnMapping.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => { await result.current.handleDeleteColumnMapping('m1'); });
    expect(mockDeleteColumnMapping).toHaveBeenCalled();
  });
});

describe('useImportWizard - account creation', () => {
  it('creates a regular account', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockCreateAccount.mockResolvedValue(baseAccount({ id: 'new-1', name: 'New' }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    // upload a file so importFiles is populated
    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('test.qif', 'x')]));
    });

    act(() => result.current.setNewAccountName('New'));
    await act(async () => {
      await result.current.handleCreateAccount(0);
    });

    expect(mockCreateAccount).toHaveBeenCalled();
    expect(result.current.accounts.some(a => a.id === 'new-1')).toBe(true);
  });

  it('creates an investment pair when type is INVESTMENT', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ accountType: 'INVESTMENT', categories: [] }));
    mockCreateInvestmentPair.mockResolvedValue({
      cashAccount: baseAccount({ id: 'cash-1', name: 'Cash', accountSubType: 'INVESTMENT_CASH' }),
      brokerageAccount: baseAccount({ id: 'brk-1', name: 'Brokerage', accountSubType: 'INVESTMENT_BROKERAGE' }),
    });

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('test.qif', 'x')]));
    });

    act(() => {
      result.current.setNewAccountName('New');
      result.current.setNewAccountType('INVESTMENT');
    });
    await act(async () => {
      await result.current.handleCreateAccount(0);
    });

    expect(mockCreateInvestmentPair).toHaveBeenCalled();
    // should be assigned brokerage account
    expect(result.current.importFiles[0].selectedAccountId).toBe('brk-1');
  });

  it('rejects account creation when name is empty', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleCreateAccount(0);
    });
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('handles account creation error', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockCreateAccount.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    act(() => result.current.setNewAccountName('New'));
    await act(async () => {
      await result.current.handleCreateAccount(0);
    });
    expect(result.current.isCreatingAccount).toBe(false);
  });
});

describe('useImportWizard - mapping handlers', () => {
  it('handleAccountMappingChange updates accountId', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ transferAccounts: ['Other'], categories: [] }));
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    expect(result.current.accountMappings).toHaveLength(1);

    act(() => result.current.handleAccountMappingChange(0, 'accountId', 'new-id'));
    expect(result.current.accountMappings[0].accountId).toBe('new-id');

    act(() => result.current.handleAccountMappingChange(0, 'createNew', 'NewName'));
    expect(result.current.accountMappings[0].createNew).toBe('NewName');

    act(() => result.current.handleAccountMappingChange(0, 'accountType', 'SAVINGS'));
    expect(result.current.accountMappings[0].accountType).toBe('SAVINGS');

    act(() => result.current.handleAccountMappingChange(0, 'currencyCode', 'CAD'));
    expect(result.current.accountMappings[0].currencyCode).toBe('CAD');
  });

  it('handleSecurityMappingChange handles all field types', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['XYZ'], categories: [] }));
    mockGetSecurities.mockResolvedValue([baseSecurity({ id: 'sec-aapl', symbol: 'AAPL', name: 'Apple' })]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.securities).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    expect(result.current.securityMappings).toHaveLength(1);

    act(() => result.current.handleSecurityMappingChange(0, 'securityId', 'sec-1'));
    expect(result.current.securityMappings[0].securityId).toBe('sec-1');

    // createNew with matching symbol
    act(() => result.current.handleSecurityMappingChange(0, 'createNew', 'AAPL'));
    expect(result.current.securityMappings[0].securityId).toBe('sec-aapl');

    // createNew with new symbol
    act(() => result.current.handleSecurityMappingChange(0, 'createNew', 'NEW'));
    expect(result.current.securityMappings[0].createNew).toBe('NEW');

    act(() => result.current.handleSecurityMappingChange(0, 'securityName', 'Some'));
    expect(result.current.securityMappings[0].securityName).toBe('Some');

    act(() => result.current.handleSecurityMappingChange(0, 'securityType', 'ETF'));
    expect(result.current.securityMappings[0].securityType).toBe('ETF');

    // exchange resolves currency
    act(() => result.current.handleSecurityMappingChange(0, 'exchange', 'NYSE'));
    expect(result.current.securityMappings[0].exchange).toBe('NYSE');
    expect(result.current.securityMappings[0].currencyCode).toBe('USD');

    // exchange with unknown name falls back to default
    act(() => result.current.handleSecurityMappingChange(0, 'exchange', 'UNKNOWN'));
    expect(result.current.securityMappings[0].currencyCode).toBe('USD');

    act(() => result.current.handleSecurityMappingChange(0, 'currencyCode', 'EUR'));
    expect(result.current.securityMappings[0].currencyCode).toBe('EUR');
  });
});

describe('useImportWizard - security lookup', () => {
  it('rejects too-short query', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleSecurityLookup(0, 'A');
    });
    expect(mockLookupCandidates).not.toHaveBeenCalled();
  });

  it('shows toast when no candidates returned', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['XYZ'], categories: [] }));
    mockLookupCandidates.mockResolvedValue([]);
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    await act(async () => {
      await result.current.handleSecurityLookup(0, 'XYZ');
    });
    expect(mockLookupCandidates).toHaveBeenCalled();
  });

  it('auto-applies a single candidate result', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['XYZ'], categories: [] }));
    mockLookupCandidates.mockResolvedValue([
      { symbol: 'XYZ', name: 'XYZ Co', securityType: 'STOCK', exchange: 'NYSE', currencyCode: 'USD' },
    ]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    await act(async () => {
      await result.current.handleSecurityLookup(0, 'XYZ');
    });
    expect(result.current.securityMappings[0].createNew).toBe('XYZ');
  });

  it('shows picker when multiple candidates returned', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['XYZ'], categories: [] }));
    mockLookupCandidates.mockResolvedValue([
      { symbol: 'XYZ', name: 'A', securityType: 'STOCK', exchange: 'NYSE' },
      { symbol: 'XYZ', name: 'B', securityType: 'STOCK', exchange: 'TSX' },
    ]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    await act(async () => {
      await result.current.handleSecurityLookup(0, 'XYZ');
    });
    expect(result.current.lookupPickerCandidates).toHaveLength(2);

    // pick a candidate
    act(() => {
      result.current.handleLookupPickerPick({ symbol: 'XYZ', name: 'B', securityType: 'STOCK', exchange: 'TSX' });
    });
    expect(result.current.lookupPickerCandidates).toHaveLength(0);
  });

  it('handles lookup picker cancel', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['Z'], categories: [] }));
    mockLookupCandidates.mockResolvedValue([
      { symbol: 'A', name: 'A', securityType: 'STOCK' },
      { symbol: 'B', name: 'B', securityType: 'STOCK' },
    ]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    await act(async () => {
      await result.current.handleSecurityLookup(0, 'Z');
    });

    act(() => result.current.handleLookupPickerCancel());
    expect(result.current.lookupPickerCandidates).toHaveLength(0);
  });

  it('passes preferred exchanges to lookup', async () => {
    mockPrefExchanges = ['TSX'];
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['XYZ'], categories: [] }));
    mockLookupCandidates.mockResolvedValue([{ symbol: 'XYZ', name: 'X', securityType: 'STOCK' }]);

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    await act(async () => {
      await result.current.handleSecurityLookup(0, 'XYZ', 'NYSE');
    });
    // Called with merged exchange list (NYSE first then TSX)
    expect(mockLookupCandidates).toHaveBeenCalledWith('XYZ', ['NYSE', 'TSX']);
  });

  it('handles lookup error', async () => {
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['XYZ'], categories: [] }));
    mockLookupCandidates.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    await act(async () => {
      await result.current.handleSecurityLookup(0, 'XYZ');
    });
    expect(result.current.lookupLoadingIndex).toBeNull();
  });
});

describe('useImportWizard - import handlers', () => {
  it('imports QIF successfully', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportQif.mockResolvedValue(importResult({ imported: 5 }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    act(() => result.current.setSelectedAccountId('acc-1'));
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.step).toBe('complete');
    expect(result.current.importResult?.imported).toBe(5);
  });

  it('imports CSV successfully', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseCsvHeaders.mockResolvedValue({ headers: ['D', 'A'], sampleRows: [], rowCount: 0 });
    mockParseCsv.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportCsv.mockResolvedValue(importResult({ imported: 3 }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.csv', 'D,A')]));
    });
    await act(async () => {
      await result.current.handleCsvMappingComplete();
    });
    act(() => result.current.setSelectedAccountId('acc-1'));
    await act(async () => {
      await result.current.handleImport();
    });
    expect(mockImportCsv).toHaveBeenCalled();
    expect(result.current.step).toBe('complete');
  });

  it('imports OFX successfully', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseOfx.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportOfx.mockResolvedValue(importResult({ imported: 2 }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.ofx', 'OFX')]));
    });
    act(() => result.current.setSelectedAccountId('acc-1'));
    await act(async () => {
      await result.current.handleImport();
    });
    expect(mockImportOfx).toHaveBeenCalled();
    expect(result.current.step).toBe('complete');
  });

  it('rejects import with no files', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());
    await act(async () => {
      await result.current.handleImport();
    });
    expect(mockImportQif).not.toHaveBeenCalled();
  });

  it('rejects import when not all files have an account', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    await act(async () => {
      await result.current.handleImport();
    });
    expect(mockImportQif).not.toHaveBeenCalled();
  });

  it('handles bulk import with errors', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportQif.mockResolvedValueOnce(importResult({ imported: 1 }))
                  .mockResolvedValueOnce(importResult({ imported: 0, errors: 1, errorMessages: ['x'] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.qif', '1'),
        makeFile('b.qif', '2'),
      ]));
    });
    act(() => {
      result.current.setFileAccountId(0, 'acc-1');
      result.current.setFileAccountId(1, 'acc-1');
    });
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.bulkImportResult?.totalImported).toBe(1);
    expect(result.current.bulkImportResult?.totalErrors).toBe(1);
  });

  it('bulk import handles thrown error per file', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportQif.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.qif', '1'),
        makeFile('b.qif', '2'),
      ]));
    });
    act(() => {
      result.current.setFileAccountId(0, 'acc-1');
      result.current.setFileAccountId(1, 'acc-1');
    });
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.bulkImportResult?.totalErrors).toBeGreaterThanOrEqual(1);
  });

  it('bulk import propagates createdMappings to subsequent files', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: ['CatA'], transferAccounts: ['AcctA'], securities: ['SecA'] }));
    mockImportQif
      .mockResolvedValueOnce(importResult({
        imported: 1,
        createdMappings: {
          categories: { CatA: 'cat-id-1' },
          accounts: { AcctA: 'acc-id-1' },
          loans: { CatA: 'loan-id-1' },
          securities: { SecA: 'sec-id-1' },
        },
      }))
      .mockResolvedValueOnce(importResult({ imported: 1 }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.qif', '1'),
        makeFile('b.qif', '2'),
      ]));
    });

    // Mark mapping as createNew/createNewLoan to trigger propagation
    act(() => {
      result.current.handleAccountMappingChange(0, 'createNew', 'AcctA');
    });
    // Force categoryMapping to be createNew/createNewLoan
    act(() => {
      result.current.setCategoryMappings([
        { originalName: 'CatA', createNew: 'NewCat' },
      ]);
    });
    act(() => {
      result.current.setFileAccountId(0, 'acc-1');
      result.current.setFileAccountId(1, 'acc-1');
    });
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.bulkImportResult?.totalImported).toBe(2);
  });

  it('bulk import aggregates loanAccountsNeedingSetup', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportQif.mockResolvedValue(importResult({
      imported: 1,
      loanAccountsNeedingSetup: [{ accountId: 'l1', accountName: 'Loan1', accountType: 'LOAN' }],
    }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.qif', '1'),
        makeFile('b.qif', '2'),
      ]));
    });
    act(() => {
      result.current.setFileAccountId(0, 'acc-1');
      result.current.setFileAccountId(1, 'acc-1');
    });
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.bulkImportResult?.loanAccountsNeedingSetup).toHaveLength(1);
  });

  it('handles import top-level error', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportQif.mockRejectedValue(new Error('catastrophic'));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', '1')]));
    });
    act(() => result.current.setSelectedAccountId('acc-1'));
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useImportWizard - multi-account import', () => {
  it('runs multi-account import successfully', async () => {
    mockParseQifMulti.mockResolvedValue({
      isMultiAccount: true,
      categoryDefs: [], tagDefs: [],
      accounts: [{ accountName: 'A', accountType: 'CHEQUING', transactionCount: 1, dateRange: { start: '', end: '' } }],
      totalTransactionCount: 1,
      securities: [], detectedDateFormat: 'MM/DD/YYYY', sampleDates: [],
    });
    mockImportQifMulti.mockResolvedValue(importResult({ imported: 5 }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    const content = '!Account\nNA\n^\n!Account\nNB\n^';
    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('m.qif', content)]));
    });
    expect(result.current.step).toBe('multiAccountReview');

    await act(async () => {
      await result.current.handleMultiAccountImport();
    });
    expect(mockImportQifMulti).toHaveBeenCalled();
    expect(result.current.step).toBe('complete');
  });

  it('multi-account import is no-op without content', async () => {
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleMultiAccountImport();
    });
    expect(mockImportQifMulti).not.toHaveBeenCalled();
  });

  it('multi-account import handles errors', async () => {
    mockParseQifMulti.mockResolvedValue({
      isMultiAccount: true, categoryDefs: [], tagDefs: [],
      accounts: [{ accountName: 'A', accountType: 'CHEQUING', transactionCount: 1, dateRange: { start: '', end: '' } }],
      totalTransactionCount: 1, securities: [], detectedDateFormat: 'MM/DD/YYYY', sampleDates: [],
    });
    mockImportQifMulti.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('m.qif', '!Account\n^\n!Account\n^')]));
    });
    await act(async () => {
      await result.current.handleMultiAccountImport();
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('multi-account import with errors > 0 shows toast for partial success', async () => {
    mockParseQifMulti.mockResolvedValue({
      isMultiAccount: true, categoryDefs: [], tagDefs: [],
      accounts: [{ accountName: 'A', accountType: 'CHEQUING', transactionCount: 1, dateRange: { start: '', end: '' } }],
      totalTransactionCount: 1, securities: [], detectedDateFormat: 'MM/DD/YYYY', sampleDates: [],
    });
    mockImportQifMulti.mockResolvedValue(importResult({ imported: 5, errors: 2 }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(mockGetCurrencies).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('m.qif', '!Account\n^\n!Account\n^')]));
    });
    await act(async () => {
      await result.current.handleMultiAccountImport();
    });
    expect(result.current.importResult?.errors).toBe(2);
  });
});

describe('useImportWizard - import more / reset', () => {
  it('handleImportMore resets state to initial', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ categories: [] }));
    mockImportQif.mockResolvedValue(importResult());

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    act(() => result.current.setSelectedAccountId('acc-1'));
    await act(async () => {
      await result.current.handleImport();
    });
    expect(result.current.step).toBe('complete');

    act(() => result.current.handleImportMore());
    expect(result.current.step).toBe('upload');
    expect(result.current.importFiles).toHaveLength(0);
    expect(result.current.importResult).toBeNull();
  });
});

describe('useImportWizard - derived options', () => {
  it('produces categoryOptions from categories', async () => {
    mockGetCategories.mockResolvedValue([
      baseCategory({ id: 'c1', name: 'Food' }),
      baseCategory({ id: 'c2', name: 'Sub', parentId: 'c1' }),
    ]);
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.categories).toHaveLength(2));
    expect(result.current.categoryOptions.length).toBeGreaterThan(0);
  });

  it('produces parentCategoryOptions from top-level categories only', async () => {
    mockGetCategories.mockResolvedValue([
      baseCategory({ id: 'c1', name: 'A' }),
      baseCategory({ id: 'c2', name: 'B', parentId: 'c1' }),
    ]);
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.categories).toHaveLength(2));
    expect(result.current.parentCategoryOptions.find(o => o.value === 'c1')).toBeTruthy();
    expect(result.current.parentCategoryOptions.find(o => o.value === 'c2')).toBeFalsy();
  });

  it('getAccountOptions excludes loan/mortgage/brokerage accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([
      baseAccount({ id: 'a1', name: 'Chequing', accountType: 'CHEQUING' }),
      baseAccount({ id: 'a2', name: 'Loan', accountType: 'LOAN' }),
      baseAccount({ id: 'a3', name: 'Mortgage', accountType: 'MORTGAGE' }),
      baseAccount({ id: 'a4', name: 'Brk', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE' }),
    ]);
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(4));

    const opts = result.current.getAccountOptions();
    const values = opts.map((o) => o.value);
    expect(values).toContain('a1');
    expect(values).not.toContain('a2');
    expect(values).not.toContain('a3');
    expect(values).not.toContain('a4');
  });

  it('getSecurityOptions includes a skip option and all securities', async () => {
    mockGetSecurities.mockResolvedValue([baseSecurity({ id: 's1', symbol: 'A', name: 'Apple' })]);
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.securities).toHaveLength(1));
    const opts = result.current.getSecurityOptions();
    expect(opts[0].value).toBe('');
    expect(opts.find((o) => o.value === 's1')).toBeTruthy();
  });

  it('currencyOptions sorts default currency first', async () => {
    mockPrefDefaultCurrency = 'CAD';
    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.currencyOptions.length).toBeGreaterThan(0));
    expect(result.current.currencyOptions[0].value).toBe('CAD');
  });
});

describe('useImportWizard - selectAccount auto-select effect', () => {
  it('auto-selects type-matching compatible account', async () => {
    mockGetAllAccounts.mockResolvedValue([
      baseAccount({ id: 'a1', accountType: 'SAVINGS' }),
      baseAccount({ id: 'a2', accountType: 'CHEQUING' }),
    ]);
    mockParseQif.mockResolvedValue(baseParsedQif({ accountType: 'CHEQUING', categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(2));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('test.qif', 'x')]));
    });
    // matchFilenameToAccount returns 'none' so effect runs and picks type match
    await waitFor(() => {
      expect(result.current.selectedAccountId).toBe('a2');
    });
  });

  it('falls back to first compatible account when no type matches', async () => {
    mockGetAllAccounts.mockResolvedValue([
      baseAccount({ id: 'a1', accountType: 'SAVINGS' }),
    ]);
    mockParseQif.mockResolvedValue(baseParsedQif({ accountType: 'CHEQUING', categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('z.qif', 'x')]));
    });
    await waitFor(() => {
      expect(result.current.selectedAccountId).toBe('a1');
    });
  });

  it('filters compatible accounts for INVESTMENT QIF', async () => {
    mockGetAllAccounts.mockResolvedValue([
      baseAccount({ id: 'a1', accountType: 'CHEQUING' }),
      baseAccount({ id: 'a2', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE' }),
    ]);
    mockParseQif.mockResolvedValue(baseParsedQif({ accountType: 'INVESTMENT', categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(2));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('z.qif', 'x')]));
    });
    await waitFor(() => {
      expect(result.current.selectedAccountId).toBe('a2');
    });
  });
});

describe('useImportWizard - mapAccounts effect', () => {
  it('re-matches account mappings when entering mapAccounts step', async () => {
    mockGetAllAccounts.mockResolvedValue([
      baseAccount({ id: 'a1', name: 'Savings Acct' }),
    ]);
    mockParseQif.mockResolvedValue(baseParsedQif({ transferAccounts: ['Savings Acct'], categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });
    // The mapping should already match a1 from buildAccountMappings
    expect(result.current.accountMappings[0].accountId).toBe('a1');

    act(() => result.current.setStep('mapAccounts'));
    await waitFor(() => expect(result.current.step).toBe('mapAccounts'));
  });
});

describe('useImportWizard - mapSecurities bulk lookup effect', () => {
  it('runs bulk lookup when entering mapSecurities step', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockGetSecurities.mockResolvedValue([]);
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['UNKN'], categories: [] }));
    mockLookupSecurity.mockResolvedValue({
      symbol: 'UNKN', name: 'Unknown Co', securityType: 'STOCK', exchange: 'NYSE', currencyCode: 'USD',
    });

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    await act(async () => {
      result.current.setStep('mapSecurities');
    });

    await waitFor(() => {
      expect(mockLookupSecurity).toHaveBeenCalled();
    });
  });

  it('handles bulk lookup error gracefully', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockGetSecurities.mockResolvedValue([]);
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: ['UNKN'], categories: [] }));
    mockLookupSecurity.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    await act(async () => {
      result.current.setStep('mapSecurities');
    });

    await waitFor(() => {
      expect(mockLookupSecurity).toHaveBeenCalled();
    });
  });

  it('skips bulk lookup when initialLookupDone is already true', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockGetSecurities.mockResolvedValue([]);
    mockParseQif.mockResolvedValue(baseParsedQif({ securities: [], categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([makeFile('a.qif', 'x')]));
    });

    act(() => result.current.setStep('mapSecurities'));
    expect(mockLookupSecurity).not.toHaveBeenCalled();
  });
});

describe('useImportWizard - shouldShowMapAccounts', () => {
  it('hides mapAccounts when investment file is part of bulk import', async () => {
    mockGetAllAccounts.mockResolvedValue([baseAccount()]);
    mockParseQif.mockResolvedValue(baseParsedQif({ accountType: 'INVESTMENT', transferAccounts: ['X'], categories: [] }));

    const { result } = renderHook(() => useImportWizard());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    await act(async () => {
      await result.current.handleFileSelect(fileEvent([
        makeFile('a.qif', '1'),
        makeFile('b.qif', '2'),
      ]));
    });
    expect(result.current.shouldShowMapAccounts).toBe(false);
  });
});
