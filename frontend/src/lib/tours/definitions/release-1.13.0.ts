import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_13_MINOR = '1.13';

/**
 * Foreign-currency fees on the account detail view (#949). The middle step is an
 * interactive route step -- there is no way to synthesize an account with
 * foreign-currency activity, so the user opens one themselves. When the opened
 * account has none, the fx-fees anchor never appears and the tour falls through
 * to the centered outro so the three-step tour never loses its payoff silently.
 */
export const RELEASE_1_13_ACCOUNTS_TOUR: TourDefinition = {
  id: 'release-1.13.0/accounts',
  area: 'accounts',
  version: RELEASE_1_13_MINOR,
  i18nPrefix: 'release.v1_13_0.accounts',
  steps: [
    {
      id: 'openAccount',
      route: '/accounts',
      anchorId: null,
      advance: { type: 'route', route: '/accounts/' },
    },
    {
      id: 'fxFees',
      route: '/accounts',
      routeMatch: '/accounts/',
      anchorId: TOUR_ANCHORS.foreignCurrencyFees,
      placement: 'auto',
    },
    {
      id: 'outro',
      route: '/accounts',
      routeMatch: '/accounts/',
      anchorId: null,
    },
  ],
};

/**
 * The What's New feature itself (#951): the Settings toggle that controls the
 * auto-popup and the clickable version label that reopens the notes.
 */
export const RELEASE_1_13_SETTINGS_TOUR: TourDefinition = {
  id: 'release-1.13.0/settings',
  area: 'settings',
  version: RELEASE_1_13_MINOR,
  i18nPrefix: 'release.v1_13_0.settings',
  steps: [
    {
      id: 'whatsNewToggle',
      route: '/settings',
      anchorId: TOUR_ANCHORS.settingsWhatsNewToggle,
      placement: 'auto',
    },
    {
      id: 'appVersion',
      route: '/settings',
      anchorId: TOUR_ANCHORS.settingsAppVersion,
      placement: 'top',
    },
    {
      id: 'done',
      route: '/settings',
      anchorId: null,
    },
  ],
};

export const RELEASE_1_13_TOURS: readonly TourDefinition[] = [
  RELEASE_1_13_ACCOUNTS_TOUR,
  RELEASE_1_13_SETTINGS_TOUR,
];
