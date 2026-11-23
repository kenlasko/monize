import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@/test/render';
import { PriceAutoRefresher } from './PriceAutoRefresher';
import { AUTO_PRICE_REFRESH_INTERVAL_MS } from '@/lib/price-auto-refresh';

const mockRun = vi.fn();
const mockDue = vi.fn();

vi.mock('@/lib/price-refresh-state', () => ({
  runAutomaticPriceRefresh: () => mockRun(),
  isAutomaticPriceRefreshDue: (now: number) => mockDue(now),
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

/** Moves the clock and fires every timer due on the way. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('PriceAutoRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRun.mockResolvedValue(undefined);
    mockDue.mockReturnValue(true);
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
    advance(60_000);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('refreshes once the interval has passed with the site open', async () => {
    await renderRefresher();
    advance(AUTO_PRICE_REFRESH_INTERVAL_MS - 30_000);
    expect(mockRun).not.toHaveBeenCalled();
    advance(30_000);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('leaves the interval to the shared refresh state', async () => {
    // A refresh from a page or a Refresh button restarts the interval; the
    // shared state is what knows when one last ran.
    mockDue.mockReturnValue(false);
    await renderRefresher();
    advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
    expect(mockDue).toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('asks nothing while the tab is hidden, and refreshes on coming back', async () => {
    await renderRefresher();
    act(() => setVisibility('hidden'));
    advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
    expect(mockRun).not.toHaveBeenCalled();

    act(() => setVisibility('visible'));
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
      advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
      act(() => setVisibility('visible'));
      unmount();
    }
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('stops on unmount', async () => {
    const { unmount } = await renderRefresher();
    unmount();
    advance(AUTO_PRICE_REFRESH_INTERVAL_MS * 2);
    act(() => setVisibility('visible'));
    expect(mockRun).not.toHaveBeenCalled();
  });
});
