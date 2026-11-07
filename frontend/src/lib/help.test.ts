import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { clearAllCache } from './apiCache';
import { helpApi, helpImageUrl, type HelpManifest, type HelpPage } from './help';

vi.mock('./api', () => ({
  default: { get: vi.fn() },
}));

const MANIFEST: HelpManifest = {
  version: '1.2.3',
  available: true,
  pages: [
    { slug: 'index', title: 'Monize Documentation', summary: '', group: '' },
    { slug: 'budgets', title: 'Budgets', summary: 'Plan.', group: 'Core features' },
  ],
};

const PAGE: HelpPage = {
  slug: 'budgets',
  title: 'Budgets',
  group: 'Core features',
  markdown: '# Budgets\n',
  toc: [{ depth: 2, id: 'overview', heading: 'Overview' }],
  onlineUrl: 'https://www.monize.net/docs/budgets',
  images: {},
};

describe('helpApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
  });

  it('reads the manifest from GET /help', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MANIFEST });

    await expect(helpApi.getManifest()).resolves.toEqual(MANIFEST);
    expect(apiClient.get).toHaveBeenCalledWith('/help');
  });

  it('reads a page from GET /help/pages/:slug', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: PAGE });

    await expect(helpApi.getPage('budgets')).resolves.toEqual(PAGE);
    expect(apiClient.get).toHaveBeenCalledWith('/help/pages/budgets');
  });

  it('encodes the slug so it cannot add a path segment', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: PAGE });

    await helpApi.getPage('../etc');

    expect(apiClient.get).toHaveBeenCalledWith('/help/pages/..%2Fetc');
  });

  it('shares one request between concurrent callers', async () => {
    let resolve!: (value: { data: HelpPage }) => void;
    vi.mocked(apiClient.get).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const first = helpApi.getPage('budgets');
    const second = helpApi.getPage('budgets');
    resolve({ data: PAGE });

    await expect(Promise.all([first, second])).resolves.toEqual([PAGE, PAGE]);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('serves a repeat read from the cache', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MANIFEST });

    await helpApi.getManifest();
    await helpApi.getManifest();

    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('keeps a page per slug', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: PAGE });

    await helpApi.getPage('budgets');
    await helpApi.getPage('accounts');

    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('propagates a failure to every waiting caller and does not cache it', async () => {
    const failure = new Error('Network Error');
    vi.mocked(apiClient.get).mockRejectedValueOnce(failure);

    const first = helpApi.getPage('budgets');
    const second = helpApi.getPage('budgets');
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    vi.mocked(apiClient.get).mockResolvedValue({ data: PAGE });
    await expect(helpApi.getPage('budgets')).resolves.toEqual(PAGE);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('propagates a manifest failure', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('500'));

    await expect(helpApi.getManifest()).rejects.toThrow('500');
  });
});

describe('helpImageUrl', () => {
  it("is a same-origin API path carrying the picture's revision", () => {
    expect(
      helpImageUrl({ name: 'budgets-page.light', width: 1, height: 1, revision: '1.2.3-ab-cd' }),
    ).toBe('/api/v1/help/images/budgets-page.light?v=1.2.3-ab-cd');
  });

  it('encodes both parts', () => {
    expect(helpImageUrl({ name: 'a/b', width: 1, height: 1, revision: '1.0.0+build 1' })).toBe(
      '/api/v1/help/images/a%2Fb?v=1.0.0%2Bbuild%201',
    );
  });
});
