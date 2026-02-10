import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { accountsApi } from './accounts';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('accountsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create posts to /accounts', async () => {
    const mockAccount = { id: 'acc-1', name: 'Checking' };
    vi.mocked(apiClient.post).mockResolvedValue({ data: mockAccount });
    const result = await accountsApi.create({ name: 'Checking' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts', { name: 'Checking' });
    expect(result).toEqual(mockAccount);
  });

  it('createInvestmentPair posts with createInvestmentPair flag', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { cashAccount: {}, brokerageAccount: {} } });
    await accountsApi.createInvestmentPair({ name: 'Investment' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts', {
      name: 'Investment',
      createInvestmentPair: true,
    });
  });

  it('getAll fetches /accounts with includeInactive param', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await accountsApi.getAll(true);
    expect(apiClient.get).toHaveBeenCalledWith('/accounts', { params: { includeInactive: true } });
  });

  it('getAll defaults includeInactive to false', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await accountsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/accounts', { params: { includeInactive: false } });
  });

  it('getById fetches /accounts/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'acc-1' } });
    const result = await accountsApi.getById('acc-1');
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1');
    expect(result.id).toBe('acc-1');
  });

  it('update patches /accounts/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'acc-1', name: 'Savings' } });
    await accountsApi.update('acc-1', { name: 'Savings' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/accounts/acc-1', { name: 'Savings' });
  });

  it('close posts to /accounts/:id/close', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'acc-1', isClosed: true } });
    await accountsApi.close('acc-1');
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/acc-1/close');
  });

  it('reopen posts to /accounts/:id/reopen', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'acc-1', isClosed: false } });
    await accountsApi.reopen('acc-1');
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/acc-1/reopen');
  });

  it('getBalance fetches /accounts/:id/balance', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { balance: 1500 } });
    const result = await accountsApi.getBalance('acc-1');
    expect(result.balance).toBe(1500);
  });

  it('getSummary fetches /accounts/summary', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalAssets: 5000 } });
    await accountsApi.getSummary();
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/summary');
  });

  it('delete calls DELETE /accounts/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await accountsApi.delete('acc-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/accounts/acc-1');
  });

  it('canDelete fetches /accounts/:id/can-delete', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { canDelete: true, transactionCount: 0, investmentTransactionCount: 0 } });
    const result = await accountsApi.canDelete('acc-1');
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1/can-delete');
    expect(result.canDelete).toBe(true);
  });

  it('previewLoanAmortization posts to /accounts/loan-preview', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { schedule: [] } });
    await accountsApi.previewLoanAmortization({ principal: 10000 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/loan-preview', { principal: 10000 });
  });
});
