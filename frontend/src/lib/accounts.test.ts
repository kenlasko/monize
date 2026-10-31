import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { accountsApi } from './accounts';
import { scheduledTransactionsApi } from './scheduled-transactions';
import { getCached, invalidateCache, setCache } from './apiCache';

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
    // The scheduled read model is cached across modules; clear it so one test's
    // populated `scheduled:all` cannot serve the next.
    invalidateCache('scheduled:');
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

  it('getAllFresh re-reads the list a cached getAll would have served', async () => {
    invalidateCache('accounts:');
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [{ id: 'stale' }] });
    await accountsApi.getAll(true);
    expect(await accountsApi.getAll(true)).toEqual([{ id: 'stale' }]);
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [{ id: 'fresh' }] });
    expect(await accountsApi.getAllFresh(true)).toEqual([{ id: 'fresh' }]);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    // And the fresh answer is what later readers are served.
    expect(await accountsApi.getAll(true)).toEqual([{ id: 'fresh' }]);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
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

  // Issue #1167 review: a settlement/funding/brokerage account's currency is one
  // side of a scheduled investment's settlement pair, and the scheduled read
  // model caches server-derived FX fields resolved against it. An account edit
  // must invalidate `scheduled:all` so getAll() re-resolves them rather than
  // serving the pre-edit rate from the 120s cache.
  it('invalidates the scheduled forecast read model when an account is updated', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ id: 'st-1', investmentForecastExchangeRate: 1.5 }],
    });
    await scheduledTransactionsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    // Cached within TTL: no second backend call yet.
    await scheduledTransactionsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    vi.mocked(apiClient.patch).mockResolvedValue({
      data: { id: 'cash-1', currencyCode: 'USD' },
    });
    await accountsApi.update('cash-1', { currencyCode: 'USD' } as any);

    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ id: 'st-1', investmentForecastExchangeRate: 1.35 }],
    });
    const refreshed = await scheduledTransactionsApi.getAll();

    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(apiClient.get).toHaveBeenLastCalledWith('/scheduled-transactions');
    expect(refreshed[0].investmentForecastExchangeRate).toBe(1.35);
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

  // The Investments page lists accounts from `investments:accounts`, so a write
  // that changes the account list must drop it too; otherwise a just-created
  // investment pair is missing from that page's selector for up to 30 seconds.
  it.each([
    ['create', () => accountsApi.create({ name: 'Checking' } as any)],
    ['createInvestmentPair', () => accountsApi.createInvestmentPair({ name: 'Investment' } as any)],
    ['update', () => accountsApi.update('acc-1', { name: 'Renamed' } as any)],
    ['close', () => accountsApi.close('acc-1')],
    ['reopen', () => accountsApi.reopen('acc-1')],
    ['delete', () => accountsApi.delete('acc-1')],
  ])('%s drops the cached investment account list', async (_name, write) => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'acc-1' } });
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'acc-1' } });
    vi.mocked(apiClient.delete).mockResolvedValue({});
    setCache('investments:accounts', [{ id: 'old' }]);
    setCache('accounts:all:false', [{ id: 'old' }]);
    await write();
    expect(getCached('investments:accounts')).toBeUndefined();
    expect(getCached('accounts:all:false')).toBeUndefined();
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

  it('createPaymentMatchingRule posts the patterns and drops the account, bill and rule lists', async () => {
    const { dedupe } = await import('./apiCache');
    invalidateCache('accounts:');
    const stale = vi.fn().mockResolvedValue(['stale']);
    await dedupe('accounts:all:false', stale, 60_000);
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'rule-1' } });
    const data = { payeePattern: '*ING*' };
    await expect(accountsApi.createPaymentMatchingRule('acc-1', data)).resolves.toEqual({ id: 'rule-1' });
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/acc-1/payment-matching-rule', data);
    await dedupe('accounts:all:false', stale, 60_000);
    expect(stale).toHaveBeenCalledTimes(2);
  });

  it('createPaymentMatchingRule drops the lists on a refusal too', async () => {
    const { dedupe } = await import('./apiCache');
    invalidateCache('accounts:');
    const stale = vi.fn().mockResolvedValue(['stale']);
    await dedupe('accounts:all:false', stale, 60_000);
    vi.mocked(apiClient.post).mockRejectedValue(new Error('409'));
    await expect(accountsApi.createPaymentMatchingRule('acc-1', { payeePattern: '*ING*' })).rejects.toThrow('409');
    await dedupe('accounts:all:false', stale, 60_000);
    expect(stale).toHaveBeenCalledTimes(2);
  });

  it('getLoanSettlements reads the loan settlements, uncached', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ claimId: 'c-1' }] });
    await expect(accountsApi.getLoanSettlements('acc-1')).resolves.toEqual([{ claimId: 'c-1' }]);
    await accountsApi.getLoanSettlements('acc-1');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/acc-1/loan-settlements');
  });

  it('previewLoanPaymentSetup posts to the setup preview and returns its answer', async () => {
    const preview = {
      derivesInstallment: true,
      principalPayment: 833.3333,
      interestPayment: 500,
      paymentAmount: 1333.3333,
    };
    vi.mocked(apiClient.post).mockResolvedValue({ data: preview });
    const data = { paymentFrequency: 'MONTHLY', nextDueDate: '2024-01-01' };
    await expect(accountsApi.previewLoanPaymentSetup('acc-1', data)).resolves.toEqual(preview);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/accounts/acc-1/setup-loan-payments/preview',
      data,
    );
  });

  it('detectMortgageType posts the typed installments and returns the suggestion', async () => {
    const detection = { type: 'LINEAR', confidence: 'high', reason: 'CONSTANT_PRINCIPAL' };
    vi.mocked(apiClient.post).mockResolvedValue({ data: detection });
    const data = {
      samples: [
        { principal: 833.33, interest: 500 },
        { principal: 833.33, interest: 498.61 },
      ],
      interestRate: 2,
      paymentFrequency: 'MONTHLY' as const,
    };
    await expect(accountsApi.detectMortgageType(data)).resolves.toEqual(detection);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/mortgage-type/detect', data);
  });

  it('detectMortgageTypeFromHistory posts to the account route and returns the suggestion', async () => {
    const detection = {
      type: 'CANADIAN_FIXED',
      confidence: 'high',
      reason: 'CONSTANT_INSTALLMENT_SEMI_ANNUAL',
      quotedAnnualRate: 5.24,
      paymentFrequency: 'MONTHLY',
      samples: [],
    };
    vi.mocked(apiClient.post).mockResolvedValue({ data: detection });
    await expect(accountsApi.detectMortgageTypeFromHistory('acc-1')).resolves.toEqual(detection);
    expect(apiClient.post).toHaveBeenCalledWith('/accounts/acc-1/mortgage-type/detect');
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

  it('getDailyBalances forwards the allTime flag', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await accountsApi.getDailyBalances({ accountIds: 'acc-9', allTime: true });
    expect(apiClient.get).toHaveBeenCalledWith('/accounts/daily-balances', {
      params: { accountIds: 'acc-9', allTime: true },
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
