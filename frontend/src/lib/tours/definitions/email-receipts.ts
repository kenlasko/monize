import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line this tour is offered under in What's New; matched against major.minor. */
export const EMAIL_RECEIPTS_MINOR = '1.18';

/**
 * Email receipts: why Monize reads order-confirmation emails, why in practice
 * an AI provider is required (the per-shop profiles are written by an AI), and
 * where the pieces live. Offered from the 1.18 What's New digest, where the
 * feature arrived, and, like every tour, from Settings > Tours afterwards.
 *
 * Its id keeps the `email-receipts/basics` shape (ids are never renamed, and
 * the tour shipped under it), so unlike a `release-*` id the saved progress
 * carries no version stamp. Completing it once therefore also counts after 1.19
 * -- the tour is not re-offered with a new release.
 *
 * The order is the order a reader needs it: the purpose, the AI requirement,
 * the AI provider settings, the hub's tabs, the two blocks of the Profiles tab,
 * and finally a closing card on the AI review inbox where the proposals are
 * approved.
 *
 * **No empty views.** A new user has no profile, no mailbox (so no uncovered
 * domain) and an empty review inbox. The uncovered and profiles anchors are
 * attached only when their view holds data, and those two steps fall back to a
 * centered card with an example; the inbox is described, never navigated to.
 *
 * **Routing.** The first two steps are route-agnostic centered cards, so they
 * show wherever the tour was launched. The three hub steps share one URL,
 * `/email-receipts?tab=profiles`, with `routeMatch: '/email-receipts'`: the
 * engine compares `pathname` only, so a second step with a different `?tab=` on
 * the same pathname would never navigate. Every page step therefore uses the
 * Profiles tab, and the copy of the tabs step describes the other three.
 *
 * **Demo mode.** The hub replaces the Profiles tab with a note for the demo
 * account, so the uncovered and profiles anchors are missing there too; the
 * `fallbackWhenMissing` stand-ins of those steps cover it.
 *
 * **Gated on `ownerView`.** The page and its API are owner-only
 * (`app/email-receipts/layout.tsx` redirects a delegate), as is the AI review
 * inbox.
 */
export const EMAIL_RECEIPTS_TOUR: TourDefinition = {
  id: 'email-receipts/basics',
  area: 'transactions',
  version: EMAIL_RECEIPTS_MINOR,
  i18nPrefix: 'emailReceipts.basics',
  requiresData: 'ownerView',
  docs: 'emailReceipts',
  steps: [
    {
      id: 'welcome',
      anchorId: null,
    },
    {
      id: 'aiRequired',
      anchorId: null,
    },
    {
      id: 'aiProviders',
      route: '/settings/ai',
      anchorId: TOUR_ANCHORS.aiProviderList,
      placement: 'auto',
      unobtrusive: true,
    },
    {
      id: 'tabs',
      route: '/email-receipts?tab=profiles',
      routeMatch: '/email-receipts',
      anchorId: TOUR_ANCHORS.emailReceiptsTabs,
      placement: 'bottom',
    },
    {
      id: 'uncovered',
      route: '/email-receipts?tab=profiles',
      routeMatch: '/email-receipts',
      anchorId: TOUR_ANCHORS.emailReceiptsUncovered,
      placement: 'auto',
      // The block is anchored only once it lists a domain. A new user has no
      // mailbox yet, so a centered card with an example stands in.
      fallbackWhenMissing: true,
      anchorTimeoutMs: 2500,
    },
    {
      id: 'profiles',
      route: '/email-receipts?tab=profiles',
      routeMatch: '/email-receipts',
      anchorId: TOUR_ANCHORS.emailReceiptsProfiles,
      placement: 'auto',
      // Anchored only once the list holds a profile; see the step above.
      fallbackWhenMissing: true,
      anchorTimeoutMs: 2500,
    },
    {
      // Route-agnostic closing card: a new user's inbox is empty, so the tour
      // names it instead of navigating to a blank screen. The tour's own
      // `requiresData: 'ownerView'` already hides it from a delegate.
      id: 'reviews',
      anchorId: null,
    },
  ],
};
