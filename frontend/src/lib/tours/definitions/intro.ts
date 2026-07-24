import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/**
 * Evergreen "New User Introduction" tour. Walks a first-time user from the
 * dashboard through the core areas, including an interactive detour that opens
 * the New Transaction form and highlights the currency field before asking the
 * user to close the form again (the engine never closes a modal it does not
 * own). Offered from the Getting Started card and from Settings.
 */
export const INTRO_TOUR: TourDefinition = {
  id: 'intro/basics',
  area: 'intro',
  i18nPrefix: 'intro.basics',
  steps: [
    {
      id: 'welcome',
      route: '/dashboard',
      anchorId: null,
    },
    {
      id: 'dashboard',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardWidgets,
      placement: 'auto',
    },
    {
      id: 'navigation',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navAccounts,
      placement: 'bottom',
      skipOnMobile: true,
    },
    {
      id: 'accounts',
      route: '/accounts',
      anchorId: TOUR_ANCHORS.accountsAddButton,
      placement: 'bottom',
    },
    {
      // Interactive: the user clicks New Transaction; the step advances once the
      // form panel appears, which is more robust than a raw click listener.
      id: 'createTransaction',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      // Renders while the form modal is open: focus stays with the form (the
      // engine leaves anchors inside a role="dialog" alone).
      id: 'currencyField',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionCurrencyField,
      placement: 'auto',
    },
    {
      // Centered: ask the user to close the form; advance when it disappears.
      id: 'closeForm',
      route: '/transactions',
      anchorId: null,
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      id: 'budgets',
      route: '/budgets',
      anchorId: null,
    },
    {
      id: 'reports',
      route: '/reports',
      anchorId: null,
    },
    {
      id: 'finish',
      route: '/settings',
      anchorId: null,
    },
  ],
};
