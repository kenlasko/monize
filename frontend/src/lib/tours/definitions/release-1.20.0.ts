import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';
import { SHARED_EXPENSES_TOUR } from './release-1.20.0.shared-expenses';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_20_MINOR = '1.20';

/**
 * Warranties: the three ways a warranty is created and every place it shows up
 * afterwards. A warranty never moves money; it hangs off a purchase.
 *
 * The order is where a reader finds the feature (Tools), the page and its
 * status cards, the two ways in from that page (Add warranty, Import CSV), how
 * the register shows a purchase that has one, the way in from the register
 * (the New Transaction window's Warranties line), and finally the two places a
 * warranty finds the reader again: the opt-in dashboard widget and the expiry
 * reminders.
 *
 * **No row is anchored.** The shield repeats on every row that has a
 * warranty, and one anchor across rows would break the anchor-uniqueness rule
 * and move under sorting and filtering, so that step is an anchorless coach
 * mark that leaves the register in view.
 *
 * **The New Transaction detour** opens the form as the introduction tour does
 * (`click` on the button, advancing when the form appears) and `requires`
 * `transactionEntry` for the same reason: with no account there is no form to
 * walk. The line is hidden for a joint account, which the form may default to,
 * so that step falls back to a centered card. The steps inside the form are
 * `skipOnBack`, so Back never lands on an anchor that closed with the form.
 * Being passive, the line's own Add warranty is covered by the step's blocker:
 * pressing it would save the transaction and leave for the Warranties page.
 *
 * **Gated on `ownerView`.** A delegate with the warranties section sees the
 * page read-only (no Add, no Import) and no Warranties line in the form, so a
 * tour about creating warranties has nothing to show them.
 *
 * The Tools step is `skipOnMobile`, as the other Tools steps are: the phone
 * drawer is not anchored. It carries `openToolsMenu` because it points inside
 * the menu, not at the closed trigger.
 */
export const RELEASE_1_20_WARRANTIES_TOUR: TourDefinition = {
  id: 'release-1.20.0/warranties',
  area: 'transactions',
  version: RELEASE_1_20_MINOR,
  i18nPrefix: 'release.v1_20_0.warranties',
  requiresData: 'ownerView',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // The Warranties entry inside the open Tools menu.
      id: 'warrantiesLink',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navWarranties,
      openToolsMenu: true,
      unobtrusive: true,
      placement: 'right',
      skipOnMobile: true,
    },
    {
      // The status cards render in every state of the page (a skeleton while
      // loading, "Not loaded" on a failure), so a user with no warranties
      // still has something to point at.
      id: 'overview',
      route: '/warranties',
      anchorId: TOUR_ANCHORS.warrantiesSummary,
      placement: 'bottom',
      unobtrusive: true,
    },
    {
      id: 'addWarranty',
      route: '/warranties',
      anchorId: TOUR_ANCHORS.warrantiesAddButton,
      placement: 'bottom',
    },
    {
      id: 'importCsv',
      route: '/warranties',
      anchorId: TOUR_ANCHORS.warrantiesImportButton,
      placement: 'bottom',
    },
    {
      id: 'inRegister',
      route: '/transactions',
      anchorId: null,
      unobtrusive: true,
    },
    {
      // Interactive: clicking New Transaction opens the form; the step advances
      // once the form panel appears.
      id: 'newTransaction',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionsNewButton,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.transactionForm },
    },
    {
      id: 'warrantiesLine',
      requires: 'transactionEntry',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.transactionWarrantiesLine,
      placement: 'auto',
      skipOnBack: true,
      // Hidden while the form's account is a joint one; say why instead.
      fallbackWhenMissing: true,
      anchorTimeoutMs: 2500,
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
      // The widget is off by default, so the step points at Customize, where
      // it is turned on, rather than at a card most users do not have.
      id: 'dashboardWidget',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardCustomize,
      placement: 'bottom',
      unobtrusive: true,
    },
    {
      id: 'reminders',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.notificationBell,
      placement: 'bottom',
    },
  ],
};

/**
 * Payroll deductions: a yearly maximum on a paycheque's deduction lines, under
 * Tools, Taxes.
 *
 * **The requirement comes first.** A rule hangs off a payroll scheduled bill
 * (a deposit split into its gross line and one negative line per deduction),
 * and the form has nothing to offer without one. So the welcome names it and
 * the first anchored step is the Bills page's New Schedule button, where the
 * bill is created, before the tour goes looking for the tool.
 *
 * The order then follows the way in (Tools, the Taxes card), the page (New
 * Rule and the rules card), the two collapsed tables, and the two places a
 * rule acts or speaks afterwards: the Cash Flow Forecast and the reset
 * reminder.
 *
 * **Every anchor renders in every state of its page.** The rules card holds
 * the spinner, the empty state or the list. The year-to-date and previous
 * periods buttons appear only once a rule exists, so that step is an
 * anchorless coach mark rather than an anchor a new user would never mount.
 *
 * **Gated on `ownerView`.** The Taxes entry is owner-only and every
 * payroll-deductions route refuses a delegate session.
 *
 * The Tools step is `skipOnMobile` and carries `openToolsMenu`, as the
 * warranties tour's does.
 */
export const RELEASE_1_20_PAYROLL_DEDUCTIONS_TOUR: TourDefinition = {
  id: 'release-1.20.0/payroll-deductions',
  area: 'transactions',
  version: RELEASE_1_20_MINOR,
  i18nPrefix: 'release.v1_20_0.payrollDeductions',
  requiresData: 'ownerView',
  steps: [
    {
      // Route-agnostic welcome: names the feature and its requirement wherever
      // the tour was launched.
      id: 'welcome',
      anchorId: null,
    },
    {
      // The requirement: the paycheque as a scheduled bill with deduction lines.
      id: 'payrollBill',
      route: '/bills',
      anchorId: TOUR_ANCHORS.billsNewButton,
      placement: 'bottom',
    },
    {
      // The Taxes entry inside the open Tools menu.
      id: 'taxesLink',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navTaxes,
      openToolsMenu: true,
      unobtrusive: true,
      placement: 'right',
      skipOnMobile: true,
    },
    {
      id: 'taxesCard',
      route: '/taxes',
      anchorId: TOUR_ANCHORS.taxesPayrollDeductions,
      placement: 'bottom',
    },
    {
      id: 'newRule',
      route: '/taxes/payroll-deductions',
      anchorId: TOUR_ANCHORS.payrollNewRuleButton,
      placement: 'bottom',
    },
    {
      id: 'rulesList',
      route: '/taxes/payroll-deductions',
      anchorId: TOUR_ANCHORS.payrollRulesList,
      placement: 'bottom',
      unobtrusive: true,
    },
    {
      // The two tables render only once a rule exists; describe, not anchor.
      id: 'periodTables',
      route: '/taxes/payroll-deductions',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'forecast',
      route: '/bills',
      anchorId: TOUR_ANCHORS.billsCashFlowForecast,
      placement: 'auto',
      unobtrusive: true,
    },
    {
      id: 'reminders',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.notificationBell,
      placement: 'bottom',
    },
  ],
};

export const RELEASE_1_20_TOURS: readonly TourDefinition[] = [
  RELEASE_1_20_WARRANTIES_TOUR,
  RELEASE_1_20_PAYROLL_DEDUCTIONS_TOUR,
  SHARED_EXPENSES_TOUR,
];
