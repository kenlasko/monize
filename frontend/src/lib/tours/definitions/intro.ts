import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/**
 * Evergreen "New User Introduction" tour. Walks a first-time user from the
 * dashboard through the core areas: customizing the dashboard, the Tools menu,
 * Accounts (including an interactive detour that opens an account's own
 * type-specific detail page), and the transaction register, with a second
 * interactive detour that opens the New Transaction form to explain
 * payees/categories/amounts, splits, and foreign currencies before asking the
 * user to close the form again. It then
 * visits Bills & Deposits, Investments, Budgets, and Reports. Offered from the
 * Getting Started card and from Settings.
 *
 * Steps anchored on desktop-only header controls (the Tools dropdown) or the
 * desktop Split button are `skipOnMobile`; the page steps use centered cards so
 * they show on every viewport.
 *
 * The steps that introduce a whole screen -- Dashboard, Tools, Accounts,
 * Transactions, Bills, Investments, Budgets, Reports -- are `unobtrusive`:
 * dimming would hide the very page being described. Anchored ones keep their
 * highlight ring, so they still point at the control they name.
 *
 * The steps that render inside the open transaction form are `skipOnBack`: once
 * the user has closed it, Back has to walk past them, or it would land on a
 * step whose anchor can never mount again and strand the tour.
 *
 * The record-a-transaction detour `requires` an account to record against: for
 * a user who has none yet, walking through the form teaches nothing, so the
 * engine omits those five steps entirely. The account-detail pair `requires` an
 * account with a dedicated detail page for the same reason -- there is nothing
 * for a zero-account user to open, and the tour continues without them.
 */
export const INTRO_TOUR: TourDefinition = {
  id: 'intro/basics',
  area: 'intro',
  i18nPrefix: 'intro.basics',
  docs: 'dashboard',
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
      unobtrusive: true,
    },
    {
      id: 'tools',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navToolsMenu,
      openToolsMenu: true,
      unobtrusive: true,
      placement: 'right',
      skipOnMobile: true,
    },
    {
      id: 'accounts',
      route: '/accounts',
      anchorId: TOUR_ANCHORS.accountsAddButton,
      placement: 'bottom',
      unobtrusive: true,
    },
    {
      // Asks the user to open any account's Details page, and advances when
      // they land on one. Deliberately unanchored: the eye icon repeats on
      // every row, and one shared anchor across rows would break the tour's
      // anchor-uniqueness rule and move under filtering and sorting. The copy
      // names the **Details** action (the durable concept) and mentions both
      // ways to reach it, so a mobile user completing it by long-press is not
      // chasing a desktop-only icon.
      id: 'openAccountDetail',
      requires: 'accountsExist',
      route: '/accounts',
      anchorId: null,
      unobtrusive: true,
      // Bottom-LEFT: row actions are right-aligned and sticky, so the default
      // corner parks the card on top of the Details button this step asks the
      // user to click (CI proved it, at a 720px-tall viewport with one row).
      placement: 'left',
      advance: { type: 'route', route: '/accounts/' },
    },
    {
      // The per-type page they just opened. `routeMatch` keeps it on whichever
      // account was chosen; unobtrusive and anchorless so the tailored page the
      // copy is about stays visible behind the card. The engine cannot navigate
      // here itself, so `isStepReachable` skips it rather than hanging if the
      // user skipped the step above.
      id: 'accountDetailView',
      requires: 'accountsExist',
      route: '/accounts',
      routeMatch: '/accounts/',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'transactions',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
      unobtrusive: true,
    },
    {
      // Interactive: clicking New Transaction opens the form; the step advances
      // once the form panel appears.
      id: 'createTransaction',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      // The following steps render while the form modal is open: focus stays
      // with the form (the engine leaves anchors inside a role="dialog" alone).
      id: 'fields',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionFields,
      placement: 'auto',
      skipOnBack: true,
    },
    {
      id: 'splits',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionSplit,
      placement: 'auto',
      skipOnMobile: true,
      skipOnBack: true,
    },
    {
      // Rings the entry-currency picker together with the Amount it applies to:
      // the step asks the user to set both, so highlighting only the picker
      // would leave half the instruction unmarked.
      id: 'currencyField',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionAmountCurrency,
      placement: 'auto',
      skipOnBack: true,
    },
    {
      // Spotlights the form's own Cancel/Create pair; advance when it closes.
      id: 'closeForm',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionFormActions,
      placement: 'top',
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.transactionForm },
      skipOnBack: true,
    },
    {
      id: 'bills',
      route: '/bills',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'investments',
      route: '/investments',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'budgets',
      route: '/budgets',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'reports',
      route: '/reports',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'finish',
      route: '/settings',
      anchorId: null,
    },
  ],
};
