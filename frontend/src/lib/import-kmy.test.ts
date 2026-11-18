import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { kmyImportApi } from './import-kmy';
import { clearAllCache, getCached, setCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const mockedClient = vi.mocked(apiClient);

/** The KMyMoney client is the Money one over `/import/kmy`: same bodies, same timeouts. */
describe('kmyImportApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    mockedClient.post.mockResolvedValue({ data: {} } as never);
    mockedClient.get.mockResolvedValue({ data: {} } as never);
    mockedClient.delete.mockResolvedValue({ data: {} } as never);
  });

  it('uploads the file as multipart to the KMyMoney route with the long parse timeout and no password', async () => {
    const file = new File(['bytes'], 'budget.kmy');

    await kmyImportApi.parse(file);

    const [url, body, config] = mockedClient.post.mock.calls[0];
    expect(url).toBe('/import/kmy/parse');
    expect((body as FormData).get('file')).toBe(file);
    expect((body as FormData).has('password')).toBe(false);
    expect(config?.headers?.['Content-Type']).toBe('multipart/form-data');
    expect(config?.timeout).toBe(300_000);
  });

  it('starts with the options, the wipe credentials and the start timeout', async () => {
    await kmyImportApi.start('staged-1', { importPrices: false }, { password: 'pw' });

    const [url, body, config] = mockedClient.post.mock.calls[0];
    expect(url).toBe('/import/kmy/start');
    expect(body).toEqual({
      stagedFileId: 'staged-1',
      options: { importPrices: false },
      wipePassword: 'pw',
    });
    expect(config?.timeout).toBe(120_000);
  });

  it('polls the job with the short timeout', async () => {
    await kmyImportApi.getJob('job-1');

    expect(mockedClient.get).toHaveBeenCalledWith('/import/kmy/jobs/job-1', { timeout: 10_000 });
  });

  it.each(['completed', 'failed'])('clears every cache when a job is %s', async (status) => {
    setCache('accounts', [1]);
    mockedClient.get.mockResolvedValue({ data: { status } } as never);

    await kmyImportApi.getJob('job-1');

    expect(getCached('accounts')).toBeUndefined();
  });

  it('keeps the caches while a job is running', async () => {
    setCache('accounts', [1]);
    mockedClient.get.mockResolvedValue({ data: { status: 'running' } } as never);

    await kmyImportApi.getJob('job-1');

    expect(getCached('accounts')).toBeDefined();
  });

  it('discards a staged file on the KMyMoney route', async () => {
    await kmyImportApi.discardStagedFile('staged-1');

    expect(mockedClient.delete).toHaveBeenCalledWith('/import/kmy/staged/staged-1');
  });
});
