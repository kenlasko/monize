/**
 * Stable DOM anchor ids for guided tours.
 *
 * Each id is attached to the UI with `{...tourAnchor(TOUR_ANCHORS.x)}`, which
 * spreads a single `data-tour-id` attribute (zero behaviour change). Rules:
 *
 *  - Anchor stable containers or buttons, never text nodes -- text moves and
 *    re-wraps far more than the control around it.
 *  - Attach each id in exactly one place. The task-4 anchor-uniqueness test
 *    fails if an id is missing or attached twice, since anchor drift is the
 *    engine's biggest long-term failure mode.
 *
 * The values are the literal attribute strings; keep them stable once shipped
 * so persisted tours keep working across refactors.
 */
export const TOUR_ANCHORS = {
  // Navigation (desktop header + mobile drawer share the same ids)
  navAccounts: 'nav-accounts',
  navTransactions: 'nav-transactions',
  navBudgets: 'nav-budgets',
  navReports: 'nav-reports',
  navSettings: 'nav-settings',

  // Dashboard
  dashboardWidgets: 'dashboard-widgets',

  // Accounts
  accountsAddButton: 'accounts-add-button',
  foreignCurrencyFees: 'account-foreign-currency-fees',

  // Transactions
  transactionsNewButton: 'transactions-new-button',
  transactionForm: 'transaction-form',
  transactionCurrencyField: 'transaction-currency-field',

  // Settings
  settingsWhatsNewToggle: 'settings-whats-new-toggle',
  settingsAppVersion: 'settings-app-version',
} as const;

export type TourAnchorId = (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS];

/** Spread onto an element to mark it as a tour anchor: `{...tourAnchor(id)}`. */
export function tourAnchor(id: TourAnchorId): { 'data-tour-id': TourAnchorId } {
  return { 'data-tour-id': id };
}

/** CSS selector matching a tour anchor. */
export function tourAnchorSelector(id: TourAnchorId): string {
  return `[data-tour-id="${id}"]`;
}

/** Find the live element for an anchor id, or null when it is not mounted. */
export function findTourAnchor(id: TourAnchorId): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(tourAnchorSelector(id));
}
