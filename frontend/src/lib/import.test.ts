import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from './api';
import { importApi } from './import';

vi.mock('./api', () => ({
  default: { post: vi.fn() },
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
});
