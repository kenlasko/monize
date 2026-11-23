import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@/test/render';
import { PriceAutoRefresher } from './PriceAutoRefresher';
import { AUTO_PRICE_REFRESH_INTERVAL_MS } from '@/lib/price-auto-refresh';

const mockRun = vi.fn();

vi.mock('@/lib/price-refresh-state', () => ({
  runAutomaticPriceRefresh: () => mockRun(),
}));

let authState: { isAuthenticated: boolean; _hasHydrated: boolean; actingAsUserId: string | null } = {
  isAuthenticated: true,
  _hasHydrated: true,
  actingAsUserId: null,
};

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function renderRefresher() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<PriceAutoRefresher />);
  });
  return result!;
}

/**
 * Moves the clock, fires every timer due on the way and lets the refresh
 * module (imported on first use) load.
 */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await vi.dynamicImportSettled();
  });
}

async function showTab(next: DocumentVisibilityState) {
  await act(async () => {
    setVisibility(next);
    await vi.dynamicImportSettled();
  });
}

describe('PriceAutoRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRun.mockResolvedValue(undefined);
    authState = { isAuthenticated: true, _hasHydrated: true, actingAsUserId: null };
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not refresh as the site opens', async () => {
    // The landing page asks for its own refresh once its first figures are
    // in; one here as well would value the same history beside it (#1888).
    await renderRefresher();
    await advance(60_000);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('asks for a refresh once the interval has passed with the site open', async () => {
    await renderRefresher();
    await advance(AUTO_PRICE_REFRESH_INTERVAL_MS - 30_000);
    expect(mockRun).not.toHaveBeenCalled();
    await advance(30_000);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('keeps asking, and leaves whether one is due to the shared refresh state', async () => {
    // A refresh from a page or a Refresh button restarts the interval; the
    // shared state is what knows when one last ran, and turns down the asks
    // in between.
    await renderRefresher();
    await advance(AUTO_PRICE_REFRESH_INTERVAL_MS);
    await advance(30_000);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('asks nothing while the tab is hidden, and asks on coming back', async () => {
    await renderRefresher();
    await showTab('hidden');
    await advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
    expect(mockRun).not.toHaveBeenCalled();

    await showTab('visible');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('does nothing signed out, before the auth store hydrates, or in a delegate view', async () => {
    for (const state of [
      { isAuthenticated: false, _hasHydrated: true, actingAsUserId: null },
      { isAuthenticated: true, _hasHydrated: false, actingAsUserId: null },
      { isAuthenticated: true, _hasHydrated: true, actingAsUserId: 'owner-1' },
    ]) {
      authState = state;
      const { unmount } = await renderRefresher();
      await advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
      await showTab('visible');
      unmount();
    }
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('stops on unmount', async () => {
    const { unmount } = await renderRefresher();
    unmount();
    await advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
    await showTab('visible');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('does not refresh for a page it has left while the refresh module loaded', async () => {
    const { unmount } = await renderRefresher();
    act(() => {
      vi.advanceTimersByTime(AUTO_PRICE_REFRESH_INTERVAL_MS);
    });
    unmount();
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(mockRun).not.toHaveBeenCalled();
  });
});
