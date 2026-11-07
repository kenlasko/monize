import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@/test/render';
import type { MouseEvent } from 'react';

const getManifest = vi.fn();
const getPage = vi.fn();
vi.mock('@/lib/help', () => ({
  helpApi: {
    getManifest: () => getManifest(),
    getPage: (slug: string) => getPage(slug),
  },
}));

import { onGuideLinkClick, onHelpLinkClick, prefetchHelp, useHelpPrefetch } from './help-open';
import { useHelpStore } from '@/store/helpStore';

const open = vi.fn();

function click(init: Partial<MouseEvent<HTMLAnchorElement>> = {}) {
  const preventDefault = vi.fn();
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault,
    ...init,
  } as unknown as MouseEvent<HTMLAnchorElement>;
  return { event, preventDefault };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  getManifest.mockResolvedValue({ version: '1', available: true, pages: [] });
  vi.stubGlobal('open', open);
});

describe('prefetchHelp', () => {
  it('records that the guide is bundled', async () => {
    prefetchHelp();
    await flush();
    expect(useHelpStore.getState().guideAvailable).toBe(true);
  });

  it('records that the guide is not bundled', async () => {
    getManifest.mockResolvedValue({ version: '1', available: false, pages: [] });
    prefetchHelp();
    await flush();
    expect(useHelpStore.getState().guideAvailable).toBe(false);
  });

  it('leaves the answer unknown when the manifest cannot be read, and asks again next time', async () => {
    getManifest.mockRejectedValueOnce(new Error('offline'));
    prefetchHelp();
    await flush();
    expect(useHelpStore.getState().guideAvailable).toBeNull();

    prefetchHelp();
    await flush();
    expect(getManifest).toHaveBeenCalledTimes(2);
    expect(useHelpStore.getState().guideAvailable).toBe(true);
  });

  it('does not ask again once it knows', () => {
    useHelpStore.getState().setGuideAvailable(true);
    prefetchHelp();
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('runs on mount when enabled, and not when disabled', async () => {
    renderHook(() => useHelpPrefetch(false));
    await flush();
    expect(getManifest).not.toHaveBeenCalled();
    renderHook(() => useHelpPrefetch(true));
    await flush();
    expect(getManifest).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing read escape into the render of the page', async () => {
    getManifest.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => renderHook(() => useHelpPrefetch())).not.toThrow();
    await flush();
    expect(useHelpStore.getState().guideAvailable).toBeNull();
  });
});

describe('onHelpLinkClick', () => {
  it('opens the panel at once, in the same tick as the click, when the guide is known to be bundled', () => {
    useHelpStore.getState().setGuideAvailable(true);
    const { event, preventDefault } = click();
    onHelpLinkClick(event, 'institutions');
    // Nothing was awaited: the decision and the effect are both already done.
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useHelpStore.getState().open).toBe(true);
    expect(useHelpStore.getState().history).toEqual([
      { page: 'accounts', section: 'financial-institutions' },
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the landing page by its help slug', () => {
    useHelpStore.getState().setGuideAvailable(true);
    onHelpLinkClick(click().event, 'home');
    expect(useHelpStore.getState().history).toEqual([{ page: 'index' }]);
  });

  it('leaves the click to the anchor while the manifest is not known yet', () => {
    const { event, preventDefault } = click();
    onHelpLinkClick(event, 'budgets');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useHelpStore.getState().open).toBe(false);
    // It never opens a window itself: the anchor's href does that natively.
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves the click to the anchor when the server has no bundled guide', () => {
    useHelpStore.getState().setGuideAvailable(false);
    const { event, preventDefault } = click();
    onHelpLinkClick(event, 'budgets');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useHelpStore.getState().open).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('asks the server again after an unknown click, so the next click can open the panel', async () => {
    onHelpLinkClick(click().event, 'budgets');
    await flush();
    expect(getManifest).toHaveBeenCalledTimes(1);

    const { event, preventDefault } = click();
    onHelpLinkClick(event, 'budgets');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useHelpStore.getState().open).toBe(true);
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['middle', { button: 1 }],
  ])('leaves a %s-click to the browser even when the guide is bundled', (_name, init) => {
    useHelpStore.getState().setGuideAvailable(true);
    const { event, preventDefault } = click(init);
    onHelpLinkClick(event, 'budgets');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useHelpStore.getState().open).toBe(false);
  });
});

describe('onGuideLinkClick', () => {
  it('opens the panel for a recognised guide link when the guide is bundled', () => {
    useHelpStore.getState().setGuideAvailable(true);
    const { event, preventDefault } = click();
    onGuideLinkClick(event, 'https://www.monize.net/docs/budgets#rollover-rules');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useHelpStore.getState().history).toEqual([
      { page: 'budgets', section: 'rollover-rules' },
    ]);
  });

  it('leaves a non-guide link to the browser', () => {
    useHelpStore.getState().setGuideAvailable(true);
    const { event, preventDefault } = click();
    onGuideLinkClick(event, 'https://github.com/kenlasko/monize');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('leaves the click to the anchor while the manifest is not known yet', () => {
    const { event, preventDefault } = click();
    onGuideLinkClick(event, 'https://www.monize.net/docs/budgets');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('leaves a modified click to the browser even when the guide is bundled', () => {
    useHelpStore.getState().setGuideAvailable(true);
    const { event, preventDefault } = click({ ctrlKey: true });
    onGuideLinkClick(event, 'https://www.monize.net/docs/budgets');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useHelpStore.getState().open).toBe(false);
  });
});
