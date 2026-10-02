import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import apiClient from './api';
import { bankSyncApi } from './bank-sync';
import { clearAllCache, getCached, setCache } from './apiCache';
import type { BankSyncFailure, BankSyncResult } from '@/types/bank-sync';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

function result(imported: number, bankAccountId = 'ba-1'): BankSyncResult {
  return {
    bankAccountId,
    imported,
    skipped: 0,
    refused: {},
    pending: 0,
    beforeCutoff: 0,
    bankBalance: null,
  };
}

const failure = (bankAccountId: string): BankSyncFailure => ({
  bankAccountId,
  error: { code: 'unavailable', message: 'The bank did not answer.' },
});

/** An axios failure: a timeout has no response, anything else has a status. */
const axiosFailure = (status?: number) =>
  status === undefined
    ? new AxiosError('timeout of 120000ms exceeded', 'ECONNABORTED')
    : new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status,
        statusText: '',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {},
      });

/** Fill the caches a sync could wrongly leave alone or wrongly drop. */
function seedCaches() {
  setCache('bank-sync:connections', ['stale']);
  setCache('bank-sync:status', { stale: true });
  setCache('accounts:all:false', ['stale']);
  setCache('investments:summary', ['stale']);
  setCache('budgets:dashboard', ['stale']);
  setCache('payees:all', ['stale']);
}

describe('bankSyncApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
  });

  describe('reads', () => {
    it('getStatus fetches /bank-sync/status and caches the answer', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { redirectUrl: 'u' } });
      await bankSyncApi.getStatus();
      await bankSyncApi.getStatus();
      expect(apiClient.get).toHaveBeenCalledTimes(1);
      expect(apiClient.get).toHaveBeenCalledWith('/bank-sync/status');
    });

    it('listInstitutions sends the country and caches per country', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      await bankSyncApi.listInstitutions('PL');
      await bankSyncApi.listInstitutions('PL');
      await bankSyncApi.listInstitutions('DE');
      expect(apiClient.get).toHaveBeenCalledTimes(2);
      expect(apiClient.get).toHaveBeenCalledWith('/bank-sync/institutions', {
        params: { country: 'PL' },
      });
      expect(apiClient.get).toHaveBeenCalledWith('/bank-sync/institutions', {
        params: { country: 'DE' },
      });
    });

    it('listConnections fetches /bank-sync/connections', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'c1' }] });
      const connections = await bankSyncApi.listConnections();
      expect(apiClient.get).toHaveBeenCalledWith('/bank-sync/connections');
      expect(connections).toHaveLength(1);
    });

    it('does not cache a failed read', async () => {
      vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('down'));
      await expect(bankSyncApi.listConnections()).rejects.toThrow('down');
      vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [] });
      await expect(bankSyncApi.listConnections()).resolves.toEqual([]);
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('writes use the routes of the contract and drop bank-sync only', () => {
    it.each([
      [
        'saveCredentials PUTs /bank-sync/credentials',
        () => bankSyncApi.saveCredentials({ applicationId: 'app', privateKey: 'k' }),
        'put',
        ['/bank-sync/credentials', { applicationId: 'app', privateKey: 'k' }],
      ],
      [
        'deleteCredentials DELETEs /bank-sync/credentials',
        () => bankSyncApi.deleteCredentials(),
        'delete',
        ['/bank-sync/credentials'],
      ],
      [
        'createConnection POSTs /bank-sync/connections',
        () =>
          bankSyncApi.createConnection({
            institutionName: 'Bank',
            country: 'PL',
            psuType: 'personal',
          }),
        'post',
        [
          '/bank-sync/connections',
          { institutionName: 'Bank', country: 'PL', psuType: 'personal' },
        ],
      ],
      [
        'reauthorize POSTs the reauthorize route',
        () => bankSyncApi.reauthorize('c1'),
        'post',
        ['/bank-sync/connections/c1/reauthorize'],
      ],
      [
        'completeCallback POSTs /bank-sync/callback',
        () => bankSyncApi.completeCallback({ state: 's', code: 'c' }),
        'post',
        ['/bank-sync/callback', { state: 's', code: 'c' }],
      ],
      [
        'updateConnection PATCHes the connection',
        () => bankSyncApi.updateConnection('c1', { autoSync: true }),
        'patch',
        ['/bank-sync/connections/c1', { autoSync: true }],
      ],
      [
        'deleteConnection DELETEs the connection',
        () => bankSyncApi.deleteConnection('c1'),
        'delete',
        ['/bank-sync/connections/c1'],
      ],
      [
        'updateAccount PATCHes the bank account',
        () =>
          bankSyncApi.updateAccount('ba-1', {
            accountId: 'a1',
            syncFromDate: '2026-01-01',
          }),
        'patch',
        ['/bank-sync/accounts/ba-1', { accountId: 'a1', syncFromDate: '2026-01-01' }],
      ],
    ] as const)('%s', async (_name, call, method, args) => {
      vi.mocked(apiClient[method]).mockResolvedValue({ data: {} });
      seedCaches();
      await call();
      expect(apiClient[method]).toHaveBeenCalledWith(...args);
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('bank-sync:status')).toBeUndefined();
      // Not a write of transaction rows: the balance caches stay.
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('investments:summary')).toBeDefined();
      expect(getCached('budgets:dashboard')).toBeDefined();
      expect(getCached('payees:all')).toBeDefined();
    });

    it('matchAccounts POSTs the match route with a long timeout, drops bank-sync only, and returns the answer', async () => {
      const answer = { connection: { id: 'c1' }, linked: [], suggestions: [] };
      vi.mocked(apiClient.post).mockResolvedValue({ data: answer });
      seedCaches();
      await expect(bankSyncApi.matchAccounts('c1')).resolves.toBe(answer);
      expect(apiClient.post).toHaveBeenCalledWith(
        '/bank-sync/connections/c1/match',
        undefined,
        { timeout: 120_000 },
      );
      expect(getCached('bank-sync:connections')).toBeUndefined();
      // Linking moves no money.
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('investments:summary')).toBeDefined();
    });

    it('a match the server refused still drops bank-sync', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(new Error('409'));
      seedCaches();
      await expect(bankSyncApi.matchAccounts('c1')).rejects.toThrow();
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('accounts:all:false')).toBeDefined();
    });

    it('the callback answers the connection with what the server linked', async () => {
      const answer = {
        connection: { id: 'c1' },
        linked: [{ bankAccountId: 'ba-1', accountId: 'a1' }],
        suggestions: [],
      };
      vi.mocked(apiClient.post).mockResolvedValue({ data: answer });
      await expect(bankSyncApi.completeCallback({ state: 's', code: 'c' })).resolves.toBe(answer);
    });

    it('testCredentials POSTs the test route and changes no cache', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: { ok: true, applicationName: 'App', redirectUrls: [] },
      });
      seedCaches();
      const answer = await bankSyncApi.testCredentials();
      expect(apiClient.post).toHaveBeenCalledWith('/bank-sync/credentials/test');
      expect(answer.ok).toBe(true);
      expect(getCached('bank-sync:connections')).toBeDefined();
    });

    it('a callback the server refused still drops bank-sync', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(new Error('400'));
      seedCaches();
      await expect(bankSyncApi.completeCallback({ state: 's', error: 'x' })).rejects.toThrow();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });
  });

  describe('getLinkDefaults', () => {
    it('GETs the link defaults of the pair and is never cached', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        data: { newestTransactionDate: '2026-09-10', defaultSyncFromDate: '2026-09-11' },
      });
      const first = await bankSyncApi.getLinkDefaults('ba-1', 'a1');
      await bankSyncApi.getLinkDefaults('ba-1', 'a1');
      expect(first).toEqual({
        newestTransactionDate: '2026-09-10',
        defaultSyncFromDate: '2026-09-11',
      });
      // The newest transaction is whatever it is now: every call asks again.
      expect(apiClient.get).toHaveBeenCalledTimes(2);
      expect(apiClient.get).toHaveBeenCalledWith('/bank-sync/accounts/ba-1/link-defaults', {
        params: { accountId: 'a1' },
      });
    });

    it('changes no cache', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
      seedCaches();
      await bankSyncApi.getLinkDefaults('ba-1', 'a1');
      expect(getCached('bank-sync:connections')).toBeDefined();
      expect(getCached('accounts:all:false')).toBeDefined();
    });
  });

  describe('previewAccount', () => {
    it('POSTs the preview route with a long timeout and returns the preview', async () => {
      const preview = { planFingerprint: 'f'.repeat(64) };
      vi.mocked(apiClient.post).mockResolvedValue({ data: preview });
      await expect(bankSyncApi.previewAccount('ba-1')).resolves.toBe(preview);
      expect(apiClient.post).toHaveBeenCalledWith(
        '/bank-sync/accounts/ba-1/preview',
        undefined,
        { timeout: 120_000 },
      );
    });

    it('writes nothing, so it drops no cache when it succeeds', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: {} });
      seedCaches();
      await bankSyncApi.previewAccount('ba-1');
      expect(getCached('bank-sync:connections')).toBeDefined();
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('investments:summary')).toBeDefined();
    });

    it('re-reads bank-sync, and only that, when it failed: the server may have recorded a lapsed consent', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(axiosFailure(409));
      seedCaches();
      await expect(bankSyncApi.previewAccount('ba-1')).rejects.toBeInstanceOf(AxiosError);
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('accounts:all:false')).toBeDefined();
    });
  });

  describe('removeExceptions', () => {
    it('POSTs the keys to the exceptions route and answers how many were removed', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { removed: 2 } });
      await expect(bankSyncApi.removeExceptions('ba-1', ['ref:a', 'ref:b'])).resolves.toEqual({ removed: 2 });
      expect(apiClient.post).toHaveBeenCalledWith('/bank-sync/accounts/ba-1/exceptions/remove', {
        keys: ['ref:a', 'ref:b'],
      });
    });

    it('drops the bank-sync caches and no balance cache: it moves no balance', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { removed: 1 } });
      seedCaches();
      await bankSyncApi.removeExceptions('ba-1', ['ref:a']);
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('accounts:all:false')).toBeDefined();
    });

    it('drops the bank-sync caches when it fails, and rethrows', async () => {
      const error = axiosFailure(404);
      vi.mocked(apiClient.post).mockRejectedValue(error);
      seedCaches();
      await expect(bankSyncApi.removeExceptions('ba-1', ['ref:a'])).rejects.toBe(error);
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('accounts:all:false')).toBeDefined();
    });
  });

  describe('syncAccount', () => {
    it('sends the fingerprint of the preview the person confirmed', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(2) });
      await bankSyncApi.syncAccount('ba-1', 'f'.repeat(64));
      expect(apiClient.post).toHaveBeenCalledWith(
        '/bank-sync/accounts/ba-1/sync',
        { planFingerprint: 'f'.repeat(64) },
        { timeout: 120_000 },
      );
    });

    it('sends no body without one', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(0) });
      await bankSyncApi.syncAccount('ba-1');
      expect(vi.mocked(apiClient.post).mock.calls[0][1]).toBeUndefined();
    });

    it('sends the selection beside the fingerprint, and an empty importKeys as a selection of nothing', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(1) });
      await bankSyncApi.syncAccount('ba-1', 'f'.repeat(64), {
        importKeys: ['ref:a'],
        excludeKeys: ['ref:b'],
      });
      expect(vi.mocked(apiClient.post).mock.calls[0][1]).toEqual({
        planFingerprint: 'f'.repeat(64),
        importKeys: ['ref:a'],
        excludeKeys: ['ref:b'],
      });
      await bankSyncApi.syncAccount('ba-1', 'f'.repeat(64), { importKeys: [], excludeKeys: [] });
      expect(vi.mocked(apiClient.post).mock.calls[1][1]).toEqual({
        planFingerprint: 'f'.repeat(64),
        importKeys: [],
        excludeKeys: [],
      });
    });

    it('keeps the balance caches when a selection only added exceptions: no balance moved', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { ...result(0), excluded: 3 } });
      seedCaches();
      await bankSyncApi.syncAccount('ba-1', 'f'.repeat(64), { importKeys: [], excludeKeys: ['a', 'b', 'c'] });
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });

    it('drops the balance caches when a selection imported rows', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(2) });
      seedCaches();
      await bankSyncApi.syncAccount('ba-1', 'f'.repeat(64), { importKeys: ['a', 'b'], excludeKeys: [] });
      expect(getCached('accounts:all:false')).toBeUndefined();
    });

    it('still drops the balance caches when a confirmed sync imported rows', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(2) });
      seedCaches();
      await bankSyncApi.syncAccount('ba-1', 'f'.repeat(64));
      expect(getCached('accounts:all:false')).toBeUndefined();
    });

    it('keeps the balance caches when a fingerprint was refused (409): nothing was written', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(axiosFailure(409));
      seedCaches();
      await expect(bankSyncApi.syncAccount('ba-1', 'f'.repeat(64))).rejects.toBeInstanceOf(AxiosError);
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });

    it('POSTs the sync route with a long timeout', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(0) });
      await bankSyncApi.syncAccount('ba-1');
      expect(apiClient.post).toHaveBeenCalledWith(
        '/bank-sync/accounts/ba-1/sync',
        undefined,
        { timeout: 120_000 },
      );
    });

    it('drops the balance caches when rows were imported', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(3) });
      seedCaches();
      await bankSyncApi.syncAccount('ba-1');
      expect(getCached('accounts:all:false')).toBeUndefined();
      expect(getCached('investments:summary')).toBeUndefined();
      expect(getCached('budgets:dashboard')).toBeUndefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
      // Reference data is not a balance.
      expect(getCached('payees:all')).toBeDefined();
    });

    it('keeps the balance caches when nothing was imported', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: result(0) });
      seedCaches();
      await bankSyncApi.syncAccount('ba-1');
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('investments:summary')).toBeDefined();
      expect(getCached('budgets:dashboard')).toBeDefined();
      // The sync outcome is written to the row, so the connections are re-read.
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });

    it('drops bank-sync but not the balances when the sync was refused', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(new Error('409'));
      seedCaches();
      await expect(bankSyncApi.syncAccount('ba-1')).rejects.toThrow('409');
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('accounts:all:false')).toBeDefined();
    });

    it.each([400, 409, 429])('keeps the balance caches for a %s refusal, which wrote nothing', async (status) => {
      vi.mocked(apiClient.post).mockRejectedValue(axiosFailure(status));
      seedCaches();
      await expect(bankSyncApi.syncAccount('ba-1')).rejects.toBeDefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('investments:summary')).toBeDefined();
    });

    it.each([undefined, 500, 502, 503, 504])(
      'drops the balance caches and bank-sync when the outcome is unknown (%s)',
      async (status) => {
        vi.mocked(apiClient.post).mockRejectedValue(axiosFailure(status));
        seedCaches();
        await expect(bankSyncApi.syncAccount('ba-1')).rejects.toBeDefined();
        expect(getCached('bank-sync:connections')).toBeUndefined();
        expect(getCached('accounts:all:false')).toBeUndefined();
        expect(getCached('investments:summary')).toBeUndefined();
        expect(getCached('budgets:dashboard')).toBeUndefined();
        expect(getCached('payees:all')).toBeDefined();
      },
    );

    it('rethrows the original error so the caller can tell the outcome is unknown', async () => {
      const error = axiosFailure(undefined);
      vi.mocked(apiClient.post).mockRejectedValue(error);
      await expect(bankSyncApi.syncAccount('ba-1')).rejects.toBe(error);
    });
  });

  describe('syncConnection', () => {
    it('POSTs the connection sync route and returns one result per account', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: [result(0, 'ba-1'), result(0, 'ba-2')],
      });
      const results = await bankSyncApi.syncConnection('c1');
      expect(apiClient.post).toHaveBeenCalledWith(
        '/bank-sync/connections/c1/sync',
        undefined,
        { timeout: 120_000 },
      );
      expect(results).toHaveLength(2);
    });

    it('drops the balance caches when any account imported rows', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: [result(0, 'ba-1'), result(2, 'ba-2')],
      });
      seedCaches();
      await bankSyncApi.syncConnection('c1');
      expect(getCached('accounts:all:false')).toBeUndefined();
    });

    it('keeps the balance caches when no account imported anything', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: [result(0, 'ba-1'), result(0, 'ba-2')],
      });
      seedCaches();
      await bankSyncApi.syncConnection('c1');
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });
    it('drops the balance caches when one account imported rows although another failed', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: [failure('ba-1'), result(2, 'ba-2')],
      });
      seedCaches();
      const entries = await bankSyncApi.syncConnection('c1');
      expect(entries).toHaveLength(2);
      expect(getCached('accounts:all:false')).toBeUndefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });

    it('keeps the balance caches when every account failed, but re-reads bank-sync', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: [failure('ba-1'), failure('ba-2')],
      });
      seedCaches();
      await bankSyncApi.syncConnection('c1');
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });

    it.each([undefined, 500, 504])(
      'drops the balance caches when the outcome is unknown (%s)',
      async (status) => {
        vi.mocked(apiClient.post).mockRejectedValue(axiosFailure(status));
        seedCaches();
        await expect(bankSyncApi.syncConnection('c1')).rejects.toBeDefined();
        expect(getCached('accounts:all:false')).toBeUndefined();
        expect(getCached('bank-sync:connections')).toBeUndefined();
      },
    );

    it('keeps the balance caches for a 409 refusal of the whole connection', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(axiosFailure(409));
      seedCaches();
      await expect(bankSyncApi.syncConnection('c1')).rejects.toBeDefined();
      expect(getCached('accounts:all:false')).toBeDefined();
      expect(getCached('bank-sync:connections')).toBeUndefined();
    });
  });
});
