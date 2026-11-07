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

const listAccounts = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/accounts', () => ({ accountsApi: { getAll: () => listAccounts() } }));

import { act, render, screen, waitFor, fireEvent, cleanup } from '@/test/render';
import { TourHost } from './TourHost';
import { useTourStore } from '@/store/tourStore';
import { useAuthStore } from '@/store/authStore';
import { useHelpStore } from '@/store/helpStore';
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
  listAccounts.mockClear().mockResolvedValue([]);
  useTourStore.setState({ active: null, progress: {}, progressLoaded: false });
  useAuthStore.setState({ isAuthenticated: true });
  useHelpStore.setState({ open: false, history: [], cursor: -1 });
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

  it('opens the guide and finishes the tour from "Read the full guide" on the last step', async () => {
    const WITH_DOCS: TourDefinition = { ...CENTERED, id: 'test/with-docs', docs: 'dashboard' };
    await mountHost();
    await start(WITH_DOCS);
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
      fireEvent.click(screen.getByText('Read the full guide'));
    });
    const help = useHelpStore.getState();
    expect(help.open).toBe(true);
    expect(help.history[help.cursor]).toEqual({ page: 'dashboard' });
    expect(useTourStore.getState().active).toBeNull();
    expect(saveProgress).toHaveBeenCalledWith('test/with-docs', 'completed');
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
      expect(screen.getByText('Your accounts')).toBeInTheDocument(),
    );

    await act(async () => {
      button.click();
    });
    await waitFor(() =>
      expect(screen.getByText("You're all set")).toBeInTheDocument(),
    );
  });

  it('keeps the spotlit field clickable on an allowInteraction step', async () => {
    // A passive step that asks the user to type into the highlighted control:
    // it still advances with Next, but must not cover the cutout with the
    // click blocker that ordinary passive steps use.
    const field = document.createElement('div');
    field.setAttribute('data-tour-id', TOUR_ANCHORS.transactionFields);
    document.body.appendChild(field);

    const buildTour = (allowInteraction: boolean): TourDefinition => ({
      id: `test/allow-${allowInteraction}`,
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        {
          id: 'fields',
          route: '/',
          anchorId: TOUR_ANCHORS.transactionFields,
          ...(allowInteraction ? { allowInteraction: true } : {}),
        },
        // A following step so the one under test is not the final one (whose
        // primary button reads "Done" rather than "Next").
        { id: 'finish', route: '/', anchorId: null },
      ],
    });

    const spotlightChildren = () =>
      document.body.querySelector('[aria-hidden="true"].inset-0')!
        .childElementCount;

    await mountHost();

    await start(buildTour(false));
    await waitFor(() =>
      expect(screen.getByText('Payee and category')).toBeInTheDocument(),
    );
    const passiveChildren = spotlightChildren();

    await act(async () => {
      useTourStore.getState().endTour('dismissed');
    });
    await start(buildTour(true));
    await waitFor(() =>
      expect(screen.getByText('Payee and category')).toBeInTheDocument(),
    );

    // One fewer child: the hole blocker is gone, so the field accepts input.
    expect(spotlightChildren()).toBe(passiveChildren - 1);
    // Still a passive step, so Next drives it (no "Skip this step" affordance).
    expect(screen.getByText('Next')).toBeInTheDocument();
    expect(screen.queryByText('Skip this step')).toBeNull();
  });

  it('renders an unobtrusive step with no dim, parked in the corner', async () => {
    const tour: TourDefinition = {
      id: 'test/unobtrusive',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        { id: 'welcome', route: '/', anchorId: null, unobtrusive: true },
        { id: 'finish', route: '/', anchorId: null },
      ],
    };

    await mountHost();
    await start(tour);
    await waitFor(() =>
      expect(screen.getByText('Welcome to Monize')).toBeInTheDocument(),
    );

    // No dimming overlay at all: the page behind stays fully visible/usable.
    expect(document.body.querySelector('.bg-black\\/50')).toBeNull();

    // The next (ordinary centered) step brings the dim back.
    await act(async () => {
      fireEvent.click(screen.getByText('Next'));
    });
    await waitFor(() =>
      expect(document.body.querySelector('.bg-black\\/50')).not.toBeNull(),
    );
  });

  describe('step requirements', () => {
    const GATED: TourDefinition = {
      id: 'test/requires',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        { id: 'welcome', route: '/', anchorId: null },
        {
          id: 'createTransaction',
          route: '/',
          anchorId: null,
          requires: 'transactionEntry',
        },
        { id: 'finish', route: '/', anchorId: null },
      ],
    };

    it('omits the step when the user has no account to record against', async () => {
      // No accounts: the form cannot be submitted, so it would teach nothing.
      await mountHost();
      await start(GATED);
      await waitFor(() =>
        expect(screen.getByText('Welcome to Monize')).toBeInTheDocument(),
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Next'));
      });

      // Straight past the gated step to the one after it...
      await waitFor(() =>
        expect(screen.getByText("You're all set")).toBeInTheDocument(),
      );
      // ...and the omission is deliberate, so the tour is not marked degraded.
      expect(useTourStore.getState().active?.skippedCount).toBe(0);
    });

    it('shows the step once the user has an account', async () => {
      // Payee and category are optional on a transaction and can be created
      // from inside the form, so an account alone is enough.
      listAccounts.mockResolvedValueOnce([{ id: 'a' }]);

      await mountHost();
      await start(GATED);
      await waitFor(() =>
        expect(screen.getByText('Welcome to Monize')).toBeInTheDocument(),
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Next'));
      });

      await waitFor(() =>
        expect(screen.getByText('Record a transaction')).toBeInTheDocument(),
      );
    });
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


  describe('the account-detail pair', () => {
    // The two real intro steps, so the copy under test is the shipped copy.
    const DETAIL: TourDefinition = {
      id: 'test/account-detail',
      area: 'intro',
      i18nPrefix: 'intro.basics',
      steps: [
        {
          id: 'openAccountDetail',
          requires: 'accountsExist',
          route: '/accounts',
          anchorId: null,
          unobtrusive: true,
          advance: { type: 'route', route: '/accounts/' },
        },
        {
          id: 'accountDetailView',
          requires: 'accountsExist',
          route: '/accounts',
          routeMatch: '/accounts/',
          anchorId: null,
          unobtrusive: true,
        },
        { id: 'finish', route: '/accounts', anchorId: null },
      ],
    };

    async function mountAt(path: string) {
      mockPathname = path;
      let utils!: ReturnType<typeof render>;
      await act(async () => {
        utils = render(<TourHost />);
      });
      return utils;
    }

    async function navigateTo(
      utils: ReturnType<typeof render>,
      path: string,
    ) {
      mockPathname = path;
      await act(async () => {
        utils.rerender(<TourHost />);
      });
    }

    it('advances onto any account detail route the user opens', async () => {
      listAccounts.mockResolvedValue([{ id: 'a', accountType: 'CREDIT_CARD' }]);
      const utils = await mountAt('/accounts');
      await start(DETAIL);

      await waitFor(() =>
        expect(
          screen.getByText("Open an account's detailed view"),
        ).toBeInTheDocument(),
      );
      // The instruction names Details and both ways to reach it, so a mobile
      // user has something to do; nothing here anchors on the desktop icon.
      expect(screen.getByText(/press and hold/i)).toBeInTheDocument();

      await navigateTo(utils, '/accounts/6f1c4e2a');

      // Whichever account they chose: the step is pinned to the prefix.
      await waitFor(() =>
        expect(
          screen.getByText('A view built for this account'),
        ).toBeInTheDocument(),
      );
      expect(useTourStore.getState().active!.skippedCount).toBe(0);
    });

    it('continues the tour for a user with no account to open', async () => {
      // No accounts: there is no Details page anywhere, so waiting for a route
      // change the user cannot make would strand them.
      listAccounts.mockResolvedValue([]);
      await mountAt('/accounts');
      await start(DETAIL);

      await waitFor(() =>
        expect(screen.getByText("You're all set")).toBeInTheDocument(),
      );
      // Both omissions are deliberate, so the tour is not marked degraded.
      expect(useTourStore.getState().active!.skippedCount).toBe(0);
    });

    it('omits the pair for an account with no dedicated detail page', async () => {
      listAccounts.mockResolvedValue([{ id: 'a', accountType: 'NOT_A_TYPE' }]);
      await mountAt('/accounts');
      await start(DETAIL);

      await waitFor(() =>
        expect(screen.getByText("You're all set")).toBeInTheDocument(),
      );
    });

    it('skips the detail step instead of hanging when the prompt is skipped', async () => {
      // Skipped from the list, the user never reaches '/accounts/<id>' -- and
      // the engine cannot navigate there, so the step would sit in its
      // navigating phase behind an overlay that renders nothing.
      listAccounts.mockResolvedValue([{ id: 'a', accountType: 'CHEQUING' }]);
      await mountAt('/accounts');
      await start(DETAIL);

      await waitFor(() =>
        expect(
          screen.getByText("Open an account's detailed view"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.click(screen.getByText('Skip this step'));
      });

      await waitFor(() =>
        expect(screen.getByText("You're all set")).toBeInTheDocument(),
      );
    });

    it('offers no Back onto the detail step once the user has left it', async () => {
      listAccounts.mockResolvedValue([{ id: 'a', accountType: 'CHEQUING' }]);
      const utils = await mountAt('/accounts');
      await start(DETAIL);

      await waitFor(() =>
        expect(
          screen.getByText("Open an account's detailed view"),
        ).toBeInTheDocument(),
      );
      await navigateTo(utils, '/accounts/6f1c4e2a');
      await waitFor(() =>
        expect(
          screen.getByText('A view built for this account'),
        ).toBeInTheDocument(),
      );

      // On to the last step, and back to the accounts list with it.
      await act(async () => {
        fireEvent.click(screen.getByText('Next'));
      });
      await navigateTo(utils, '/accounts');
      await waitFor(() =>
        expect(screen.getByText("You're all set")).toBeInTheDocument(),
      );

      // Back reaches the prompt, never the step pinned to the account's own id.
      await act(async () => {
        fireEvent.click(screen.getByText('Back'));
      });
      await waitFor(() =>
        expect(
          screen.getByText("Open an account's detailed view"),
        ).toBeInTheDocument(),
      );
    });
  });

  it('stands in for a missing anchor when the step asked to', async () => {
    const tour: TourDefinition = {
      id: 'test/fallback',
      area: 'transactions',
      i18nPrefix: 'release.v1_13_0.foreignCurrency',
      steps: [
        { id: 'welcome', route: '/', anchorId: null },
        {
          id: 'fxSection',
          route: '/',
          anchorId: TOUR_ANCHORS.foreignCurrencyFees,
          anchorTimeoutMs: 30,
          fallbackWhenMissing: true,
        },
        { id: 'finish', route: '/', anchorId: null },
      ],
    };

    await mountHost();
    await start(tour);
    await act(async () => {
      fireEvent.click(screen.getByText('Next'));
    });

    // The section only exists once an account has foreign activity. Rather than
    // vanish (and jump the counter), the step explains itself in place.
    await waitFor(() =>
      expect(
        screen.getByText(/no foreign-currency activity yet/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Your foreign-currency section')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    // Shown, not skipped: no degraded-tour outro waiting at the end.
    expect(useTourStore.getState().active!.skippedCount).toBe(0);

    // And it advances like any passive step.
    await act(async () => {
      fireEvent.click(screen.getByText('Next'));
    });
    await waitFor(() =>
      expect(
        screen.getByText("That's foreign currency in Monize"),
      ).toBeInTheDocument(),
    );
  });
});
