import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { monteCarloApi } from './monte-carlo';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('monteCarloApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('list fetches /monte-carlo/scenarios', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await monteCarloApi.list();
    expect(apiClient.get).toHaveBeenCalledWith('/monte-carlo/scenarios');
  });

  it('get fetches a scenario by id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 's-1' } });
    await monteCarloApi.get('s-1');
    expect(apiClient.get).toHaveBeenCalledWith('/monte-carlo/scenarios/s-1');
  });

  it('create posts to /monte-carlo/scenarios', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await monteCarloApi.create({ name: 'My Scenario' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/monte-carlo/scenarios', {
      name: 'My Scenario',
    });
  });

  it('update patches a scenario', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 's-1' } });
    await monteCarloApi.update('s-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/monte-carlo/scenarios/s-1', {
      name: 'Updated',
    });
  });

  it('remove deletes a scenario', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await monteCarloApi.remove('s-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/monte-carlo/scenarios/s-1');
  });

  it('reorder patches /monte-carlo/scenarios/reorder', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({});
    await monteCarloApi.reorder(['s-1', 's-2']);
    expect(apiClient.patch).toHaveBeenCalledWith('/monte-carlo/scenarios/reorder', {
      scenarioIds: ['s-1', 's-2'],
    });
  });

  it('runSaved posts to /monte-carlo/scenarios/:id/run', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { successRate: 1 } });
    await monteCarloApi.runSaved('s-1');
    expect(apiClient.post).toHaveBeenCalledWith('/monte-carlo/scenarios/s-1/run');
  });

  it('run posts to /monte-carlo/run', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { successRate: 0.95 } });
    await monteCarloApi.run({ accountIds: ['a-1'] } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/monte-carlo/run', {
      accountIds: ['a-1'],
    });
  });

  it('brokerageAccounts fetches /monte-carlo/accounts', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await monteCarloApi.brokerageAccounts();
    expect(apiClient.get).toHaveBeenCalledWith('/monte-carlo/accounts');
  });

  it('holdingStats fetches with comma-separated account ids', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await monteCarloApi.holdingStats(['a-1', 'a-2']);
    expect(apiClient.get).toHaveBeenCalledWith('/monte-carlo/holding-stats', {
      params: { accountIds: 'a-1,a-2' },
    });
  });

  it('historicalStats fetches with comma-separated account ids', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { yearsObserved: 5, meanReturn: 0.07, volatility: 0.15, currentBalance: 100 },
    });
    await monteCarloApi.historicalStats(['a-1']);
    expect(apiClient.get).toHaveBeenCalledWith('/monte-carlo/historical-stats', {
      params: { accountIds: 'a-1' },
    });
  });
});
