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

  it('previewMortgageAmortization posts to /accounts/mortgage-preview', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { schedule: [] } });
    await accountsApi.previewMortgageAmortization({ principal: 100000 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/mortgage-preview', {
      principal: 100000,
    });
  });

  it('updateMortgageRate patches /accounts/:id/mortgage-rate', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'acc-1' } });
    await accountsApi.updateMortgageRate('acc-1', { rate: 0.04 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/accounts/acc-1/mortgage-rate', {
      rate: 0.04,
    });
  });

  it('detectLoanPayments fetches /accounts/:id/detect-loan-payments', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: null });
    await accountsApi.detectLoanPayments('acc-1');
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1/detect-loan-payments');
  });

  it('setupLoanPayments posts to /accounts/:id/setup-loan-payments', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { created: 2 } });
    await accountsApi.setupLoanPayments('acc-1', { paymentAmount: 100 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/acc-1/setup-loan-payments', {
      paymentAmount: 100,
    });
  });

  it('reorderFavourites patches order', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({});
    await accountsApi.reorderFavourites(['a-1', 'a-2']);
    expect(apiClient.patch).toHaveBeenCalledWith('/accounts/reorder-favourites', {
      accountIds: ['a-1', 'a-2'],
    });
  });

  it('getInvestmentPair fetches /accounts/:id/investment-pair', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { cashAccount: {}, brokerageAccount: {} },
    });
    await accountsApi.getInvestmentPair('acc-1');
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1/investment-pair');
  });

  it('getDailyBalances fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await accountsApi.getDailyBalances({ startDate: '2025-01-01' });
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/daily-balances', {
      params: { startDate: '2025-01-01' },
    });
  });

  describe('exportAccount', () => {
    let createObjectURL: any;
    let revokeObjectURL: any;
    let appendChildSpy: any;
    let clickSpy: any;

    beforeEach(() => {
      createObjectURL = vi.fn().mockReturnValue('blob:mock');
      revokeObjectURL = vi.fn();
      Object.defineProperty(window.URL, 'createObjectURL', {
        value: createObjectURL,
        writable: true,
      });
      Object.defineProperty(window.URL, 'revokeObjectURL', {
        value: revokeObjectURL,
        writable: true,
      });

      clickSpy = vi.fn();
      appendChildSpy = vi
        .spyOn(document.body, 'appendChild')
        .mockImplementation((node: any) => {
          if (node?.tagName === 'A') {
            (node as HTMLAnchorElement).click = clickSpy;
          }
          return node;
        });
      vi.spyOn(document.body, 'removeChild').mockImplementation((node: any) => node);
    });

    it('downloads CSV with default filename when no Content-Disposition', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        data: 'csv,data',
        headers: { 'content-type': 'text/csv' },
      });

      await accountsApi.exportAccount('acc-1', 'csv');
      expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1/export', {
        params: { format: 'csv' },
        responseType: 'blob',
      });
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalled();
    });

    it('uses filename from Content-Disposition header', async () => {
      let capturedHref = '';
      appendChildSpy.mockImplementation((node: any) => {
        if (node?.tagName === 'A') {
          capturedHref = node.download;
          (node as HTMLAnchorElement).click = clickSpy;
        }
        return node;
      });

      vi.mocked(apiClient.get).mockResolvedValue({
        data: 'data',
        headers: { 'content-disposition': 'attachment; filename="my-export.qif"' },
      });

      await accountsApi.exportAccount('acc-1', 'qif');
      expect(capturedHref).toBe('my-export.qif');
    });

    it('passes expandSplits=false and dateFormat options', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        data: '',
        headers: {},
      });

      await accountsApi.exportAccount('acc-1', 'csv', {
        expandSplits: false,
        dateFormat: 'YYYY-MM-DD',
      });
      expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1/export', {
        params: { format: 'csv', expandSplits: 'false', dateFormat: 'YYYY-MM-DD' },
        responseType: 'blob',
      });
    });
  });
});
