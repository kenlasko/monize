import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { investmentsApi } from './investments';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('investmentsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getPortfolioSummary fetches /portfolio/summary', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalValue: 1000 } });
    await investmentsApi.getPortfolioSummary();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/summary', { params: undefined });
  });

  it('getPortfolioSummary passes accountIds', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalValue: 1000 } });
    await investmentsApi.getPortfolioSummary(['a1', 'a2']);
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/summary', {
      params: { accountIds: 'a1,a2' },
    });
  });

  it('getAssetAllocation fetches /portfolio/allocation', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await investmentsApi.getAssetAllocation();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/allocation', { params: undefined });
  });

  it('getInvestmentAccounts fetches /portfolio/accounts', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getInvestmentAccounts();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/accounts');
  });

  it('getTopMovers fetches /portfolio/top-movers', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getTopMovers();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/top-movers');
  });

  it('getHoldings fetches /holdings with optional accountId', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getHoldings('a1');
    expect(apiClient.get).toHaveBeenCalledWith('/holdings', { params: { accountId: 'a1' } });
  });

  it('getHoldings without accountId passes undefined params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getHoldings();
    expect(apiClient.get).toHaveBeenCalledWith('/holdings', { params: undefined });
  });

  it('getTransactions fetches /investment-transactions', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await investmentsApi.getTransactions({ page: 1, limit: 20 });
    expect(apiClient.get).toHaveBeenCalledWith('/investment-transactions', {
      params: { page: 1, limit: 20 },
    });
  });

  it('createTransaction posts to /investment-transactions', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'it-1' } });
    await investmentsApi.createTransaction({ action: 'BUY' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/investment-transactions', { action: 'BUY' });
  });

  it('updateTransaction patches /investment-transactions/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'it-1' } });
    await investmentsApi.updateTransaction('it-1', { quantity: 10 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/investment-transactions/it-1', { quantity: 10 });
  });

  it('getTransaction fetches /investment-transactions/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'it-1' } });
    await investmentsApi.getTransaction('it-1');
    expect(apiClient.get).toHaveBeenCalledWith('/investment-transactions/it-1');
  });

  it('deleteTransaction deletes /investment-transactions/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await investmentsApi.deleteTransaction('it-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/investment-transactions/it-1');
  });

  it('getSecurities fetches /securities', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getSecurities();
    expect(apiClient.get).toHaveBeenCalledWith('/securities', { params: undefined });
  });

  it('getSecurities passes includeInactive', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getSecurities(true);
    expect(apiClient.get).toHaveBeenCalledWith('/securities', { params: { includeInactive: true } });
  });

  it('getSecurity fetches /securities/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.getSecurity('s-1');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/s-1');
  });

  it('createSecurity posts to /securities', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.createSecurity({ symbol: 'AAPL' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/securities', { symbol: 'AAPL' });
  });

  it('updateSecurity patches /securities/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.updateSecurity('s-1', { name: 'Apple' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/securities/s-1', { name: 'Apple' });
  });

  it('deactivateSecurity posts to /securities/:id/deactivate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.deactivateSecurity('s-1');
    expect(apiClient.post).toHaveBeenCalledWith('/securities/s-1/deactivate');
  });

  it('activateSecurity posts to /securities/:id/activate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.activateSecurity('s-1');
    expect(apiClient.post).toHaveBeenCalledWith('/securities/s-1/activate');
  });

  it('searchSecurities fetches /securities/search', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.searchSecurities('AAPL');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/search', { params: { q: 'AAPL' } });
  });

  it('lookupSecurity fetches /securities/lookup', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { symbol: 'AAPL', name: 'Apple' } });
    const result = await investmentsApi.lookupSecurity('AAPL');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/lookup', { params: { q: 'AAPL' } });
    expect(result!.symbol).toBe('AAPL');
  });

  it('refreshPrices posts to /securities/prices/refresh', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 5 } });
    const result = await investmentsApi.refreshPrices();
    expect(apiClient.post).toHaveBeenCalledWith('/securities/prices/refresh');
    expect(result.updated).toBe(5);
  });

  it('refreshSelectedPrices posts with securityIds', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 2 } });
    await investmentsApi.refreshSelectedPrices(['s-1', 's-2']);
    expect(apiClient.post).toHaveBeenCalledWith('/securities/prices/refresh/selected', {
      securityIds: ['s-1', 's-2'],
    });
  });

  it('getPriceStatus fetches /securities/prices/status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { lastUpdated: '2025-01-01' } });
    const result = await investmentsApi.getPriceStatus();
    expect(result.lastUpdated).toBe('2025-01-01');
  });
});
