import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from './api';
import {
  importApi,
  autoMatchCsvColumns,
  autoMatchInvestmentColumns,
  looksLikeInvestmentCsv,
  classifyCsvActionValue,
} from './import';
import { setCache, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe('importApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parseQif posts content with 60s timeout', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { transactionCount: 10 } });
    const result = await importApi.parseQif('!Type:Bank\nD01/15/2025\nT-50.00\n^');
    expect(api.post).toHaveBeenCalledWith(
      '/import/qif/parse',
      { content: '!Type:Bank\nD01/15/2025\nT-50.00\n^' },
      { timeout: 60000 },
    );
    expect(result.transactionCount).toBe(10);
  });

  it('importQif posts data with 5min timeout', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { imported: 5, skipped: 0, errors: 0 } });
    const data = { content: 'qif', accountId: 'a1', categoryMappings: [], accountMappings: [] } as any;
    const result = await importApi.importQif(data);
    expect(api.post).toHaveBeenCalledWith('/import/qif', data, { timeout: 300000 });
    expect(result.imported).toBe(5);
  });

  it('parseQifMultiAccount posts to /import/qif/multi-account/parse', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { isMultiAccount: true, accounts: [] } });
    await importApi.parseQifMultiAccount('!Account\n');
    expect(api.post).toHaveBeenCalledWith(
      '/import/qif/multi-account/parse',
      { content: '!Account\n' },
      { timeout: 60000 },
    );
  });

  it('importQifMultiAccount posts to /import/qif/multi-account', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { imported: 5 } });
    await importApi.importQifMultiAccount({ content: 'qif', currencyCode: 'USD' });
    expect(api.post).toHaveBeenCalledWith(
      '/import/qif/multi-account',
      { content: 'qif', currencyCode: 'USD' },
      { timeout: 300000 },
    );
  });

  it('parseOfx posts to /import/ofx/parse', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { transactionCount: 1 } });
    await importApi.parseOfx('<OFX>');
    expect(api.post).toHaveBeenCalledWith(
      '/import/ofx/parse',
      { content: '<OFX>' },
      { timeout: 60000 },
    );
  });

  it('importOfx posts to /import/ofx', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { imported: 1 } });
    const data = { content: 'ofx', accountId: 'a1', categoryMappings: [], accountMappings: [] } as any;
    await importApi.importOfx(data);
    expect(api.post).toHaveBeenCalledWith('/import/ofx', data, { timeout: 300000 });
  });

  it('parseCsvHeaders posts content and delimiter', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { headers: [], sampleRows: [], rowCount: 0 } });
    await importApi.parseCsvHeaders('a,b\n1,2', ',');
    expect(api.post).toHaveBeenCalledWith(
      '/import/csv/headers',
      { content: 'a,b\n1,2', delimiter: ',' },
      { timeout: 60000 },
    );
  });

  it('parseCsv posts content with column mapping and rules', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { transactionCount: 1 } });
    const mapping = { date: 0, dateFormat: 'YYYY-MM-DD', hasHeader: true, delimiter: ',' } as any;
    await importApi.parseCsv('a,b\n1,2', mapping, []);
    expect(api.post).toHaveBeenCalledWith(
      '/import/csv/parse',
      { content: 'a,b\n1,2', columnMapping: mapping, transferRules: [] },
      { timeout: 60000 },
    );
  });

  it('importCsv posts to /import/csv', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { imported: 5 } });
    const data = { content: 'csv', accountId: 'a1', columnMapping: {} } as any;
    await importApi.importCsv(data);
    expect(api.post).toHaveBeenCalledWith('/import/csv', data, { timeout: 300000 });
  });
});

describe('importApi column mappings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getColumnMappings fetches saved mappings', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    await importApi.getColumnMappings();
    expect(api.get).toHaveBeenCalledWith('/import/column-mappings');
  });

  it('createColumnMapping posts new mapping', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'm-1' } });
    await importApi.createColumnMapping({ name: 'Bank', columnMappings: {} as any });
    expect(api.post).toHaveBeenCalledWith('/import/column-mappings', {
      name: 'Bank',
      columnMappings: {},
    });
  });

  it('updateColumnMapping puts to /import/column-mappings/:id', async () => {
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    await importApi.updateColumnMapping('m-1', { name: 'Renamed' });
    expect(api.put).toHaveBeenCalledWith('/import/column-mappings/m-1', {
      name: 'Renamed',
    });
  });

  it('deleteColumnMapping deletes mapping', async () => {
    vi.mocked(api.delete).mockResolvedValue({});
    await importApi.deleteColumnMapping('m-1');
    expect(api.delete).toHaveBeenCalledWith('/import/column-mappings/m-1');
  });
});

describe('detectCsvDateFormat', () => {
  it('detects YYYY-MM-DD', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['2025-01-15'])).toBe('YYYY-MM-DD');
  });

  it('detects YYYY-DD-MM when middle part is greater than 12', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['2025-15-01'])).toBe('YYYY-DD-MM');
  });

  it('defaults YYYY-prefixed to YYYY-MM-DD when ambiguous', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['2025-05-06'])).toBe('YYYY-MM-DD');
  });

  it('detects MM/DD/YYYY when first part is <= 12', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['12/31/2025'])).toBe('MM/DD/YYYY');
  });

  it('detects DD/MM/YYYY when first part > 12', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['31/12/2025'])).toBe('DD/MM/YYYY');
  });

  it('returns null for empty input', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat([])).toBeNull();
    expect(detectCsvDateFormat([''])).toBeNull();
  });

  it('returns null for unrecognized date pattern', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['Q1 2025'])).toBeNull();
  });

  it('strips ISO time components', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['2025-01-15T12:00:00Z'])).toBe('YYYY-MM-DD');
  });

  it('strips space-separated time components', async () => {
    const { detectCsvDateFormat } = await import('./import');
    expect(detectCsvDateFormat(['01/15/2025 14:30'])).toBe('MM/DD/YYYY');
  });
});

describe('autoMatchCsvColumns', () => {
  it('matches common header names to fields', () => {
    const result = autoMatchCsvColumns(['Date', 'Amount', 'Payee', 'Category', 'Memo']);
    expect(result.date).toBe(0);
    expect(result.amount).toBe(1);
    expect(result.payee).toBe(2);
    expect(result.category).toBe(3);
    expect(result.memo).toBe(4);
  });

  it('matches case-insensitively', () => {
    const result = autoMatchCsvColumns(['DATE', 'AMOUNT', 'DESCRIPTION']);
    expect(result.date).toBe(0);
    expect(result.amount).toBe(1);
    expect(result.payee).toBe(2);
  });

  it('matches multi-word header names', () => {
    const result = autoMatchCsvColumns(['Transaction Date', 'Transaction Amount', 'Check Number']);
    expect(result.date).toBe(0);
    expect(result.amount).toBe(1);
    expect(result.referenceNumber).toBe(2);
  });

  it('matches debit/credit columns', () => {
    const result = autoMatchCsvColumns(['Date', 'Debit', 'Credit', 'Description']);
    expect(result.date).toBe(0);
    expect(result.debit).toBe(1);
    expect(result.credit).toBe(2);
    expect(result.amount).toBeUndefined();
    expect(result.payee).toBe(3);
  });

  it('clears a default amount column when spread over it in split mode', () => {
    // The wizard spreads the result over a default mapping with amount: 1;
    // a leftover amount wins over debit/credit and imports every row as 0.
    const result = autoMatchCsvColumns(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
    const merged = { date: 0, amount: 1, ...result };
    expect(merged.amount).toBeUndefined();
    expect(merged.debit).toBe(2);
    expect(merged.credit).toBe(3);
  });

  it('prefers amount over debit/credit when amount is present', () => {
    const result = autoMatchCsvColumns(['Date', 'Amount', 'Debit', 'Credit']);
    expect(result.amount).toBe(1);
    expect(result.debit).toBeUndefined();
    expect(result.credit).toBeUndefined();
  });

  it('returns empty result for unrecognized headers', () => {
    const result = autoMatchCsvColumns(['Col A', 'Col B', 'Col C']);
    expect(result.date).toBeUndefined();
    expect(result.amount).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it('matches substring patterns', () => {
    const result = autoMatchCsvColumns(['Post Date', 'Txn Amount', 'Merchant Name']);
    expect(result.date).toBe(0);
    expect(result.amount).toBe(1);
    expect(result.payee).toBe(2);
  });

  it('does not double-assign the same column', () => {
    // "Note" matches memo; each column used only once
    const result = autoMatchCsvColumns(['Date', 'Note', 'Notes']);
    expect(result.date).toBe(0);
    expect(result.memo).toBe(1);
  });

  it('auto-matches tags and reconciliation status columns', () => {
    const result = autoMatchCsvColumns([
      'Date',
      'Amount',
      'Payee',
      'Tags',
      'Status',
    ]);
    expect(result.date).toBe(0);
    expect(result.amount).toBe(1);
    expect(result.payee).toBe(2);
    expect(result.tags).toBe(3);
    expect(result.reconciliationStatus).toBe(4);
  });

  it('auto-matches "Labels" header to tags and "Reconciliation" header to status', () => {
    const result = autoMatchCsvColumns([
      'Posting Date',
      'Amount',
      'Merchant',
      'Labels',
      'Reconciliation',
    ]);
    expect(result.tags).toBe(3);
    expect(result.reconciliationStatus).toBe(4);
  });

  it('leaves tags and reconciliationStatus undefined when no matching header exists', () => {
    const result = autoMatchCsvColumns(['Date', 'Amount', 'Payee']);
    expect(result.tags).toBeUndefined();
    expect(result.reconciliationStatus).toBeUndefined();
  });
});

describe('autoMatchInvestmentColumns', () => {
  it('matches action, symbol, quantity, price, and commission headers', () => {
    const result = autoMatchInvestmentColumns([
      'Trade Date',
      'Action',
      'Symbol',
      'Quantity',
      'Price',
      'Commission',
      'Amount',
    ]);
    expect(result.actionColumn).toBe(1);
    expect(result.securityColumn).toBe(2);
    expect(result.quantityColumn).toBe(3);
    expect(result.priceColumn).toBe(4);
    expect(result.commissionColumn).toBe(5);
  });

  it('matches case-insensitively and via substrings', () => {
    const result = autoMatchInvestmentColumns(['ACTIVITY', 'Ticker Symbol', 'No. of Shares']);
    expect(result.actionColumn).toBe(0);
    expect(result.securityColumn).toBe(1);
    expect(result.quantityColumn).toBe(2);
  });

  it('does not double-assign the same column', () => {
    // 'Type' matches actionColumn; nothing else should claim column 0.
    const result = autoMatchInvestmentColumns(['Type', 'Symbol']);
    expect(result.actionColumn).toBe(0);
    expect(result.securityColumn).toBe(1);
  });

  it('returns empty result for a plain bank CSV', () => {
    const result = autoMatchInvestmentColumns(['Date', 'Amount', 'Description']);
    expect(result.actionColumn).toBeUndefined();
    expect(result.securityColumn).toBeUndefined();
    expect(result.quantityColumn).toBeUndefined();
    expect(result.priceColumn).toBeUndefined();
    expect(result.commissionColumn).toBeUndefined();
  });
});

describe('looksLikeInvestmentCsv', () => {
  it('is true when action, security, and quantity headers are all present', () => {
    expect(
      looksLikeInvestmentCsv(['Trade Date', 'Action', 'Symbol', 'Quantity', 'Price', 'Commission', 'Amount']),
    ).toBe(true);
  });

  it('is false for a plain bank CSV', () => {
    expect(looksLikeInvestmentCsv(['Date', 'Amount', 'Description'])).toBe(false);
  });

  it('is false when only some investment headers are present', () => {
    // Action and Symbol without a quantity-ish header is not enough.
    expect(looksLikeInvestmentCsv(['Date', 'Action', 'Symbol', 'Amount'])).toBe(false);
  });
});

describe('classifyCsvActionValue', () => {
  it('matches default keywords ("Bought" resolves to buy)', () => {
    expect(classifyCsvActionValue('Bought')).toBe('buy');
    expect(classifyCsvActionValue('You Sold')).toBe('sell');
    expect(classifyCsvActionValue('Dividend')).toBe('dividend');
  });

  it('is case and whitespace insensitive', () => {
    expect(classifyCsvActionValue('  BOUGHT  ')).toBe('buy');
    expect(classifyCsvActionValue(' cash dividend ')).toBe('dividend');
  });

  it('user override replaces the defaults for that action', () => {
    const overrides = { buy: ['acquisto'] };
    // The default keyword no longer matches once buy is overridden...
    expect(classifyCsvActionValue('bought', overrides)).toBeNull();
    // ...and the override does.
    expect(classifyCsvActionValue('acquisto', overrides)).toBe('buy');
    expect(classifyCsvActionValue('ACQUISTO', overrides)).toBe('buy');
  });

  it('bare QIF code still resolves via fallback even when that action is overridden', () => {
    // 'buy' is dropped from the keyword list by the override but is a QIF
    // action code, so the passthrough still classifies it.
    expect(classifyCsvActionValue('buy', { buy: ['acquisto'] })).toBe('buy');
  });

  it('an override for one action leaves other actions on their defaults', () => {
    expect(classifyCsvActionValue('sold', { buy: ['acquisto'] })).toBe('sell');
  });

  it('passes QIF action codes through ("reinvdiv" resolves to reinvest)', () => {
    expect(classifyCsvActionValue('reinvdiv')).toBe('reinvest');
    expect(classifyCsvActionValue('ShrsIn')).toBe('transferIn');
    expect(classifyCsvActionValue('cglong')).toBe('capitalGain');
  });

  it('returns null for unknown values and empty input', () => {
    expect(classifyCsvActionValue('Journal')).toBeNull();
    expect(classifyCsvActionValue('')).toBeNull();
    expect(classifyCsvActionValue('   ')).toBeNull();
  });
});

describe('importApi creates reference data (INV-CACHE-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    setCache('categories:all', [{ id: 'c' }]);
    setCache('payees:all', [{ id: 'p' }]);
  });

  it.each(['importQif', 'importQifMultiAccount', 'importOfx', 'importCsv'] as const)('%s drops the category and payee caches', async (method) => {
    vi.mocked(api.post).mockResolvedValue({ data: { imported: 1 } });
    await (importApi[method] as (d: any) => Promise<unknown>)({} as any);
    expect(getCached('categories:all')).toBeUndefined();
    expect(getCached('payees:all')).toBeUndefined();
  });
});
