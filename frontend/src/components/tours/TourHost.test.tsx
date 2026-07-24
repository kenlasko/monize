import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockPathname = '/';
const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
}));

const getProgress = vi.fn().mockResolvedValue({});
const saveProgress = vi.fn().mockResolvedValue({ saved: true });
vi.mock('@/lib/tours-api', () => ({
  toursApi: {
    getProgress: () => getProgress(),
    saveProgress: (...args: unknown[]) => saveProgress(...args),
  },
}));

import { act, render, screen, waitFor, fireEvent, cleanup } from '@/test/render';
import { TourHost } from './TourHost';
import { useTourStore } from '@/store/tourStore';
import { useAuthStore } from '@/store/authStore';
import { TOUR_ANCHORS } from '@/lib/tours/anchors';
import type { TourDefinition } from '@/lib/tours/types';

const CENTERED: TourDefinition = {
  id: 'test/centered',
  area: 'intro',
  i18nPrefix: 'intro.basics',
  steps: [
    { id: 'welcome', route: '/', anchorId: null },
    { id: 'dashboard', route: '/', anchorId: null },
    { id: 'finish', route: '/', anchorId: null },
  ],
};

function setDesktop() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function mountHost() {
  await act(async () => {
    render(<TourHost />);
  });
}

async function start(tour: TourDefinition) {
  await act(async () => {
    useTourStore.getState().startTour(tour);
  });
}

beforeEach(() => {
  mockPathname = '/';
  routerPush.mockClear();
  getProgress.mockClear();
  saveProgress.mockClear();
  setDesktop();
  useTourStore.setState({ active: null, progress: {}, progressLoaded: false });
  useAuthStore.setState({ isAuthenticated: true });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('TourHost', () => {
  it('loads progress once when authenticated', async () => {
    getProgress.mockResolvedValueOnce({
      'x/y': { status: 'completed', updatedAt: 'now' },
    });
    await mountHost();
    await waitFor(() =>
      expect(useTourStore.getState().progressLoaded).toBe(true),
    );
    expect(getProgress).toHaveBeenCalledTimes(1);
    expect(useTourStore.getState().progress['x/y'].status).toBe('completed');
  });

  it('walks a centered tour and completes on Done', async () => {
    await mountHost();
    await start(CENTERED);

    await waitFor(() =>
      expect(screen.getByText('Welcome to Monize')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Next'));
    });
    await waitFor(() =>
      expect(screen.getByText('Your dashboard')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Next'));
    });
    await waitFor(() =>
      expect(screen.getByText("You're all set")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Done'));
    });
    expect(useTourStore.getState().active).toBeNull();
    expect(saveProgress).toHaveBeenCalledWith('test/centered', 'completed');
  });

  it('dismisses on Escape (capture phase) and persists a dismissal', async () => {
    await mountHost();
    await start(CENTERED);
    await waitFor(() =>
      expect(screen.getByText('Welcome to Monize')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(useTourStore.getState().active).toBeNull();
    expect(saveProgress).toHaveBeenCalledWith('test/centered', 'dismissed');
  });

  it('auto-advances an interactive step when the anchor is clicked', async () => {
    const button = document.createElement('button');
    button.setAttribute('data-tour-id', TOUR_ANCHORS.accountsAddButton);
    document.body.appendChild(button);

    const tour: TourDefinition = {
      id: 'test/click',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        {
          id: 'accounts',
          route: '/',
          anchorId: TOUR_ANCHORS.accountsAddButton,
          advance: { type: 'click' },
        },
        { id: 'finish', route: '/', anchorId: null },
      ],
    };

    await mountHost();
    await start(tour);
    await waitFor(() =>
      expect(screen.getByText('Add an account')).toBeInTheDocument(),
    );

    await act(async () => {
      button.click();
    });
    await waitFor(() =>
      expect(screen.getByText("You're all set")).toBeInTheDocument(),
    );
  });

  it('shows a route-agnostic first step in place without navigating', async () => {
    // Launched from another page (e.g. the What's New modal on /settings): the
    // welcome step has no route, so it must render where we are and never push.
    mockPathname = '/settings';
    const tour: TourDefinition = {
      id: 'test/agnostic',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        { id: 'welcome', anchorId: null },
        { id: 'dashboard', route: '/dashboard', anchorId: null },
      ],
    };

    await mountHost();
    await start(tour);

    await waitFor(() =>
      expect(screen.getByText('Welcome to Monize')).toBeInTheDocument(),
    );
    // No navigation for the route-agnostic step; the tour is not dismissed.
    expect(routerPush).not.toHaveBeenCalled();
    expect(useTourStore.getState().active).not.toBeNull();

    // Next navigates to the routed step.
    await act(async () => {
      fireEvent.click(screen.getByText('Next'));
    });
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith('/dashboard'),
    );
  });

  it('advances a disappear step after the watched element is removed', async () => {
    const form = document.createElement('form');
    form.setAttribute('data-tour-id', TOUR_ANCHORS.transactionForm);
    document.body.appendChild(form);

    const tour: TourDefinition = {
      id: 'test/disappear',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        {
          id: 'closeForm',
          route: '/',
          anchorId: null,
          advance: { type: 'disappear', anchorId: TOUR_ANCHORS.transactionForm },
        },
        { id: 'finish', route: '/', anchorId: null },
      ],
    };

    await mountHost();
    await start(tour);
    await waitFor(() =>
      expect(
        screen.getByText('Close the form to continue'),
      ).toBeInTheDocument(),
    );

    // Let the watcher observe the element present first (as it is while the
    // user reads the step), then remove it; the step advances after the delay.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      form.remove();
    });
    await waitFor(
      () => expect(screen.getByText("You're all set")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it('gracefully skips a missing anchor and shows the skipped outro', async () => {
    const tour: TourDefinition = {
      id: 'test/skip',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        {
          id: 'accounts',
          route: '/',
          anchorId: TOUR_ANCHORS.foreignCurrencyFees,
          anchorTimeoutMs: 30,
        },
        { id: 'finish', route: '/', anchorId: null },
      ],
    };

    await mountHost();
    await start(tour);

    // The missing anchor times out; the tour skips to the centered finish step.
    await waitFor(() =>
      expect(screen.getByText("You're all set")).toBeInTheDocument(),
    );
    expect(useTourStore.getState().active!.skippedCount).toBe(1);

    // Done shows the generic "tour finished" outro before completing.
    await act(async () => {
      fireEvent.click(screen.getByText('Done'));
    });
    await waitFor(() =>
      expect(screen.getByText('Tour finished')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Done'));
    });
    expect(useTourStore.getState().active).toBeNull();
    expect(saveProgress).toHaveBeenCalledWith('test/skip', 'completed');
  });
});
