import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/**
 * Evergreen "New User Introduction" tour. Walks a first-time user from the
 * dashboard through the core areas: customizing the dashboard, the Tools menu,
 * Accounts, and the transaction register, with an interactive detour that opens
 * the New Transaction form to explain payees/categories/amounts, splits, and
 * foreign currencies before asking the user to close the form again. It then
 * visits Bills & Deposits, Investments, Budgets, and Reports. Offered from the
 * Getting Started card and from Settings.
 *
 * Steps anchored on desktop-only header controls (the Tools dropdown) or the
 * desktop Split button are `skipOnMobile`; the page steps use centered cards so
 * they show on every viewport.
 */
export const INTRO_TOUR: TourDefinition = {
  id: 'intro/basics',
  area: 'intro',
  i18nPrefix: 'intro.basics',
  steps: [
    {
      // Route-agnostic: shows wherever the user launched the tour, so the first
      // step never fights a closing pushHistory modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // Anchored on the top-right Customize button, which scrolls the page to
      // the top and points at how widgets are rearranged.
      id: 'dashboard',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardCustomize,
      placement: 'bottom',
    },
    {
      id: 'tools',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navTools,
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
      id: 'transactions',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
    },
    {
      // Interactive: clicking New Transaction opens the form; the step advances
      // once the form panel appears.
      id: 'createTransaction',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      // The following steps render while the form modal is open: focus stays
      // with the form (the engine leaves anchors inside a role="dialog" alone).
      id: 'fields',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionFields,
      placement: 'auto',
    },
    {
      id: 'splits',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionSplit,
      placement: 'auto',
      skipOnMobile: true,
    },
    {
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
      id: 'bills',
      route: '/bills',
      anchorId: null,
    },
    {
      id: 'investments',
      route: '/investments',
      anchorId: null,
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
