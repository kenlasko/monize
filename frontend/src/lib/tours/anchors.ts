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
  // Navigation (desktop header links + the Tools dropdown trigger)
  navAccounts: 'nav-accounts',
  navTransactions: 'nav-transactions',
  navBudgets: 'nav-budgets',
  navReports: 'nav-reports',
  navSettings: 'nav-settings',
  navTools: 'nav-tools',
  navToolsMenu: 'nav-tools-menu',
  navRules: 'nav-rules',
  navWarranties: 'nav-warranties',
  navTaxes: 'nav-taxes',
  navSharedExpenses: 'nav-shared-expenses',

  // Shared expenses: stable page/form containers, never one id per group row.
  sharedNewGroup: 'shared-new-group',
  sharedGroupList: 'shared-group-list',
  sharedGroupActions: 'shared-group-actions',
  sharedGroupTabs: 'shared-group-tabs',

  // Dashboard
  dashboardWidgets: 'dashboard-widgets',
  dashboardCustomize: 'dashboard-customize',

  // Accounts
  accountsAddButton: 'accounts-add-button',
  accountFxFeePercent: 'account-fx-fee-percent',
  accountFormActions: 'account-form-actions',
  foreignCurrencyFees: 'account-foreign-currency-fees',

  // Transactions
  transactionsNewButton: 'transactions-new-button',
  transactionForm: 'transaction-form',
  transactionAccountDate: 'transaction-account-date',
  transactionFields: 'transaction-fields',
  transactionSplit: 'transaction-split',
  transactionCurrencyField: 'transaction-currency-field',
  transactionAmountCurrency: 'transaction-amount-currency',
  transactionConvertedAmount: 'transaction-converted-amount',
  transactionFxConversion: 'transaction-fx-conversion',
  transactionFormActions: 'transaction-form-actions',
  transactionWarrantiesLine: 'transaction-warranties-line',

  // Securities (the detail page)
  securityDetailSummary: 'security-detail-summary',
  securityDetailChart: 'security-detail-chart',
  securityDetailKeyInfo: 'security-detail-key-info',
  securityDetailTabs: 'security-detail-tabs',

  // Reports
  reportForeignCurrencyFees: 'report-foreign-currency-fees',
  reportGemStrategy: 'report-gem-strategy',
  reportTagBreakdownSelect: 'report-tag-breakdown-select',

  // GEM strategy report (the page, its Overview tab, and its tab bar)
  gemStrategyHeader: 'gem-strategy-header',
  gemStrategyOverviewCards: 'gem-strategy-overview-cards',
  gemStrategyChartAndAction: 'gem-strategy-chart-and-action',
  gemStrategyReasoning: 'gem-strategy-reasoning',
  gemStrategyTabs: 'gem-strategy-tabs',
  gemStrategyEditSettings: 'gem-strategy-edit-settings',

  // GEM strategy settings form. Every one of these is on a container that
  // mounts with the form, never on the conditional "fill the missing roles"
  // box: an anchor that disappears mid-step reads as the tour breaking.
  gemSettingsAccounts: 'gem-settings-accounts',
  gemSettingsTimingAndCosts: 'gem-settings-timing-and-costs',
  gemSettingsAssets: 'gem-settings-assets',
  gemSettingsRoles: 'gem-settings-roles',
  gemSettingsSave: 'gem-settings-save',

  // Notifications (the header bell and the panel it opens)
  notificationBell: 'notification-bell',
  notificationPanel: 'notification-panel',
  notificationPanelFilters: 'notification-panel-filters',

  // Settings
  settingsWhatsNewToggle: 'settings-whats-new-toggle',
  settingsAppVersion: 'settings-app-version',
  // Settings -> Notifications. Each is on a container that renders in every
  // state of its block -- the push panel's heading wrapper is shared by its
  // "administrator has not enabled this" branch too -- so a step never points
  // at something only a configured deployment mounts.
  settingsNotifications: 'settings-notifications',
  notificationChannelMatrix: 'notification-channel-matrix',
  notificationPushDevices: 'notification-push-devices',
  notificationPortfolioAlert: 'notification-portfolio-alert',

  // Transaction rules (the list page, the editor's panels) and the AI review
  // inbox. Each is on a container that renders in every state of its screen:
  // the list card holds the spinner, the error, the empty state or the table.
  rulesList: 'rules-list',
  rulesCreateButton: 'rules-create-button',
  ruleEditorWhen: 'rule-editor-when',
  ruleEditorIf: 'rule-editor-if',
  ruleEditorThen: 'rule-editor-then',
  ruleEditorTest: 'rule-editor-test',
  aiReviewInbox: 'ai-review-inbox',

  // Email receipts (the hub's tabs, the profiles tab) and AI settings
  aiProviderList: 'ai-provider-list',
  emailReceiptsTabs: 'email-receipts-tabs',
  emailReceiptsUncovered: 'email-receipts-uncovered',
  emailReceiptsProfiles: 'email-receipts-profiles',

  // Warranties (the page's status cards and its toolbar buttons). The two
  // buttons render with the list, in its empty state too, and only for the
  // owner, as the tour that points at them is.
  warrantiesSummary: 'warranties-summary',
  warrantiesAddButton: 'warranties-add-button',
  warrantiesImportButton: 'warranties-import-button',

  // Payroll deductions (the payroll bill's way in on Bills, the Taxes card,
  // and the tool's page). The rules card holds the spinner, the empty state
  // or the list, so it renders in every state of the page.
  billsNewButton: 'bills-new-button',
  billsCashFlowForecast: 'bills-cash-flow-forecast',
  taxesPayrollDeductions: 'taxes-payroll-deductions',
  payrollNewRuleButton: 'payroll-new-rule-button',
  payrollRulesList: 'payroll-rules-list',
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
