import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { transactionsApi } from './transactions';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe('transactionsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create posts to /transactions', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'tx-1' } });
    const result = await transactionsApi.create({ amount: 100 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/transactions', { amount: 100 });
    expect(result.id).toBe('tx-1');
  });

  it('getAll fetches /transactions with no params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await transactionsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/transactions', {
      params: expect.objectContaining({}),
      timeout: 60000,
    });
  });

  it('getAll converts accountIds array to comma-separated', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await transactionsApi.getAll({ accountIds: ['a1', 'a2'] });
    const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
    expect(params.accountIds).toBe('a1,a2');
  });

  it('getAll uses accountId when accountIds is empty', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await transactionsApi.getAll({ accountId: 'a1', accountIds: [] });
    const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
    expect(params.accountId).toBe('a1');
  });

  it('getAll converts categoryIds array', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await transactionsApi.getAll({ categoryIds: ['c1', 'c2'] });
    const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
    expect(params.categoryIds).toBe('c1,c2');
  });

  it('getAll converts payeeIds array', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await transactionsApi.getAll({ payeeIds: ['p1', 'p2'] });
    const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
    expect(params.payeeIds).toBe('p1,p2');
  });

  it('getById fetches /transactions/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'tx-1' } });
    await transactionsApi.getById('tx-1');
    expect(apiClient.get).toHaveBeenCalledWith('/transactions/tx-1');
  });

  it('update patches /transactions/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'tx-1' } });
    await transactionsApi.update('tx-1', { amount: 200 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/transactions/tx-1', { amount: 200 });
  });

  it('delete calls DELETE /transactions/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await transactionsApi.delete('tx-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/transactions/tx-1');
  });

  it('markCleared posts to /transactions/:id/clear', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'tx-1' } });
    await transactionsApi.markCleared('tx-1', true);
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/tx-1/clear', { isCleared: true });
  });

  it('reconcile posts to /transactions/:id/reconcile', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'tx-1' } });
    await transactionsApi.reconcile('tx-1');
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/tx-1/reconcile');
  });

  it('unreconcile posts to /transactions/:id/unreconcile', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'tx-1' } });
    await transactionsApi.unreconcile('tx-1');
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/tx-1/unreconcile');
  });

  it('updateStatus patches /transactions/:id/status', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'tx-1' } });
    await transactionsApi.updateStatus('tx-1', 'cleared' as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/transactions/tx-1/status', { status: 'cleared' });
  });

  it('getSummary fetches /transactions/summary with array params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { total: 500 } });
    await transactionsApi.getSummary({ accountIds: ['a1'], categoryIds: ['c1'], payeeIds: ['p1'] });
    const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
    expect(params.accountIds).toBe('a1');
    expect(params.categoryIds).toBe('c1');
    expect(params.payeeIds).toBe('p1');
  });

  it('getSummary uses singular ids as fallback', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { total: 500 } });
    await transactionsApi.getSummary({ accountId: 'a1', categoryId: 'c1', payeeId: 'p1' });
    const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
    expect(params.accountId).toBe('a1');
    expect(params.categoryId).toBe('c1');
    expect(params.payeeId).toBe('p1');
  });

  it('getSplits fetches /transactions/:id/splits', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 's1' }] });
    const result = await transactionsApi.getSplits('tx-1');
    expect(apiClient.get).toHaveBeenCalledWith('/transactions/tx-1/splits');
    expect(result).toHaveLength(1);
  });

  it('updateSplits puts /transactions/:id/splits', async () => {
    vi.mocked(apiClient.put).mockResolvedValue({ data: [{ id: 's1' }] });
    await transactionsApi.updateSplits('tx-1', [{ amount: 50 }] as any);
    expect(apiClient.put).toHaveBeenCalledWith('/transactions/tx-1/splits', [{ amount: 50 }]);
  });

  it('addSplit posts to /transactions/:id/splits', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's1' } });
    await transactionsApi.addSplit('tx-1', { amount: 50 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/tx-1/splits', { amount: 50 });
  });

  it('deleteSplit deletes /transactions/:id/splits/:splitId', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await transactionsApi.deleteSplit('tx-1', 's1');
    expect(apiClient.delete).toHaveBeenCalledWith('/transactions/tx-1/splits/s1');
  });

  it('createTransfer posts to /transactions/transfer', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { from: {}, to: {} } });
    await transactionsApi.createTransfer({ amount: 100 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/transfer', { amount: 100 });
  });

  it('getLinkedTransaction fetches /transactions/:id/linked', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'tx-2' } });
    const result = await transactionsApi.getLinkedTransaction('tx-1');
    expect(apiClient.get).toHaveBeenCalledWith('/transactions/tx-1/linked');
    expect(result!.id).toBe('tx-2');
  });

  it('deleteTransfer deletes /transactions/:id/transfer', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await transactionsApi.deleteTransfer('tx-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/transactions/tx-1/transfer');
  });

  it('updateTransfer patches /transactions/:id/transfer', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { from: {}, to: {} } });
    await transactionsApi.updateTransfer('tx-1', { amount: 200 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/transactions/tx-1/transfer', { amount: 200 });
  });

  it('getReconciliationData fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { transactions: [] } });
    await transactionsApi.getReconciliationData('acc-1', '2025-01-31', 1000);
    expect(apiClient.get).toHaveBeenCalledWith('/transactions/reconcile/acc-1', {
      params: { statementDate: '2025-01-31', statementBalance: 1000 },
    });
  });

  it('bulkReconcile posts to /transactions/reconcile/:accountId', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { reconciled: 5 } });
    await transactionsApi.bulkReconcile('acc-1', ['tx-1', 'tx-2'], '2025-01-31');
    expect(apiClient.post).toHaveBeenCalledWith('/transactions/reconcile/acc-1', {
      transactionIds: ['tx-1', 'tx-2'],
      reconciledDate: '2025-01-31',
    });
  });
});
