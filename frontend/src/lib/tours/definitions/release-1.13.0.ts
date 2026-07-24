import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_13_MINOR = '1.13';

/**
 * The full foreign-currency workflow (#931, #933, #935, #949): configure a
 * card's foreign-transaction fee, record a purchase in a foreign currency, see
 * the resulting per-account fee section, and find the cross-account report.
 *
 * It is deliberately interactive because there is no way to synthesize the
 * dynamic pieces (a specific account id, an open form, real foreign activity):
 *  - The fee step opens the account edit form itself (`appear` on the fee
 *    field, which the form always renders) and closes it again (`disappear`).
 *  - The transaction step opens the New Transaction form the same way and
 *    points at the entry-currency picker, whose popover hosts "Add currency..."
 *    for users whose only active currency is their own.
 *  - The detail-page steps use interactive route advances to `/accounts/` --
 *    the user opens the account via its Details action. When the account has no
 *    foreign activity yet, the fee-section anchor never mounts and the engine
 *    gracefully skips that step (falling through to the centered finish/outro),
 *    so the tour never strands silently.
 *
 * Every anchor it relies on is either page-level (New Transaction, the report
 * card) or a form field that renders unconditionally (the fee input, the
 * currency picker), so the tour runs on every viewport without desktop-only
 * skips.
 */
export const RELEASE_1_13_FOREIGN_CURRENCY_TOUR: TourDefinition = {
  id: 'release-1.13.0/foreign-currency',
  area: 'transactions',
  version: RELEASE_1_13_MINOR,
  i18nPrefix: 'release.v1_13_0.foreignCurrency',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // Centered prompt on the accounts list; advances when the account edit
      // form opens (its fee field mounts), however the user opens it.
      id: 'openAccountEdit',
      route: '/accounts',
      anchorId: null,
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.accountFxFeePercent },
    },
    {
      // In-form: the fee field renders unconditionally, so it is present for
      // every account type; the modal layers over /accounts (no route change).
      id: 'fxFeePercent',
      route: '/accounts',
      anchorId: TOUR_ANCHORS.accountFxFeePercent,
      placement: 'auto',
    },
    {
      // Centered: ask the user to save/close; advance once the form is gone.
      id: 'closeAccountForm',
      route: '/accounts',
      anchorId: null,
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.accountFxFeePercent },
    },
    {
      // Interactive: clicking New Transaction opens the form; advance on appear.
      id: 'newTransaction',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      // In-form: the entry-currency picker. Its popover carries "Add
      // currency..." for users whose only active currency is their own.
      id: 'entryCurrency',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionCurrencyField,
      placement: 'auto',
    },
    {
      // Centered: close the form; advance when it disappears.
      id: 'closeTransactionForm',
      route: '/transactions',
      anchorId: null,
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      // Centered prompt on the accounts list; advance when the user opens an
      // account's Details page (any /accounts/<id>).
      id: 'openAccountDetail',
      route: '/accounts',
      anchorId: null,
      advance: { type: 'route', route: '/accounts/' },
    },
    {
      // The new per-account section. Skips gracefully when the account has no
      // foreign activity yet (the section renders nothing, so nothing mounts).
      id: 'fxSection',
      route: '/accounts',
      routeMatch: '/accounts/',
      anchorId: TOUR_ANCHORS.foreignCurrencyFees,
      placement: 'auto',
    },
    {
      // The cross-account report card on the Reports listing.
      id: 'report',
      route: '/reports',
      anchorId: TOUR_ANCHORS.reportForeignCurrencyFees,
      placement: 'auto',
    },
    {
      id: 'finish',
      route: '/reports',
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
  RELEASE_1_13_FOREIGN_CURRENCY_TOUR,
  RELEASE_1_13_SETTINGS_TOUR,
];
