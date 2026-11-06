import { describe, it, expect, vi, beforeEach } from 'vitest';

const getManifest = vi.fn();
const getPage = vi.fn();
vi.mock('@/lib/help', () => ({
  helpApi: {
    getManifest: () => getManifest(),
    getPage: (slug: string) => getPage(slug),
  },
}));

import { openHelp } from './help-open';
import { useHelpStore } from '@/store/helpStore';

const open = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  getManifest.mockResolvedValue({ version: '1', available: true, pages: [] });
  getPage.mockResolvedValue({ slug: 'x' });
  vi.stubGlobal('open', open);
});

describe('openHelp', () => {
  it('opens the panel at the key once the page is known to load', async () => {
    await openHelp('institutions');
    expect(getPage).toHaveBeenCalledWith('accounts');
    expect(useHelpStore.getState().open).toBe(true);
    expect(useHelpStore.getState().history).toEqual([
      { page: 'accounts', section: 'financial-institutions' },
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the landing page by its help slug', async () => {
    await openHelp('home');
    expect(getPage).toHaveBeenCalledWith('index');
    expect(useHelpStore.getState().history).toEqual([{ page: 'index' }]);
  });

  it('falls through to the website when the server has no bundled guide', async () => {
    getManifest.mockResolvedValue({ version: '1', available: false, pages: [] });
    await openHelp('budgets');
    expect(open).toHaveBeenCalledWith('https://www.monize.net/docs/budgets', '_blank', 'noopener,noreferrer');
    expect(useHelpStore.getState().open).toBe(false);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('falls through to the website, section and all, when the manifest cannot be read', async () => {
    getManifest.mockRejectedValue(new Error('offline'));
    await openHelp('institutions');
    expect(open).toHaveBeenCalledWith(
      'https://www.monize.net/docs/accounts#financial-institutions',
      '_blank',
      'noopener,noreferrer',
    );
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('falls through to the website when the page request fails', async () => {
    getPage.mockRejectedValue(new Error('404'));
    await openHelp('tags');
    expect(open).toHaveBeenCalledWith('https://www.monize.net/docs/tags', '_blank', 'noopener,noreferrer');
    expect(useHelpStore.getState().open).toBe(false);
  });
});
