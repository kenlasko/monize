import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from './api';
import { importApi, autoMatchCsvColumns } from './import';

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
