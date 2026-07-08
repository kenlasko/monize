'use client';

import { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { TopMover, FavouriteSecurityQuote } from '@/types/investment';
import { MonthlyNetWorth } from '@/types/net-worth';
import { DelegateSectionGrants } from '@/lib/delegation';
import { FavouriteAccounts } from './FavouriteAccounts';
import { UpcomingBills } from './UpcomingBills';
import { TopMovers } from './TopMovers';
import { FavouriteSecurities } from './FavouriteSecurities';
import { InsightsWidget } from './InsightsWidget';
import { BudgetStatusWidget } from './BudgetStatusWidget';
import { FavouriteReportsWidget } from './FavouriteReportsWidget';

const ExpensesPieChart = dynamic(() => import('./ExpensesPieChart').then(m => m.ExpensesPieChart), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 lg:min-h-[540px]" />,
});
const IncomeExpensesBarChart = dynamic(() => import('./IncomeExpensesBarChart').then(m => m.IncomeExpensesBarChart), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[540px]" />,
});
const NetWorthChart = dynamic(() => import('./NetWorthChart').then(m => m.NetWorthChart), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]" />,
});
const AssetsVsLiabilities = dynamic(() => import('./AssetsVsLiabilities').then(m => m.AssetsVsLiabilities), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]" />,
});

// Report-derived chart widgets (opt-in). Each self-fetches from the report APIs
// and persists its own settings via the cross-device `dashboardWidgetConfig`
// preference, so they are lazy-loaded to keep them off the default bundle.
const widgetSkeleton = () => (
  <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6 lg:min-h-[540px]" />
);
const PortfolioValueWidget = dynamic(() => import('./PortfolioValueWidget').then(m => m.PortfolioValueWidget), { ssr: false, loading: widgetSkeleton });
const SpendingByPayeeWidget = dynamic(() => import('./SpendingByPayeeWidget').then(m => m.SpendingByPayeeWidget), { ssr: false, loading: widgetSkeleton });
const MonthlySpendingTrendWidget = dynamic(() => import('./MonthlySpendingTrendWidget').then(m => m.MonthlySpendingTrendWidget), { ssr: false, loading: widgetSkeleton });
const IncomeBySourceWidget = dynamic(() => import('./IncomeBySourceWidget').then(m => m.IncomeBySourceWidget), { ssr: false, loading: widgetSkeleton });
const CreditUtilizationAccountsWidget = dynamic(() => import('./CreditUtilizationAccountsWidget').then(m => m.CreditUtilizationAccountsWidget), { ssr: false, loading: widgetSkeleton });
const CreditUtilizationTotalWidget = dynamic(() => import('./CreditUtilizationTotalWidget').then(m => m.CreditUtilizationTotalWidget), { ssr: false, loading: widgetSkeleton });
const SectorWeightingsWidget = dynamic(() => import('./SectorWeightingsWidget').then(m => m.SectorWeightingsWidget), { ssr: false, loading: widgetSkeleton });
const SecurityTypeAllocationWidget = dynamic(() => import('./SecurityTypeAllocationWidget').then(m => m.SecurityTypeAllocationWidget), { ssr: false, loading: widgetSkeleton });
const GeographicAllocationWidget = dynamic(() => import('./GeographicAllocationWidget').then(m => m.GeographicAllocationWidget), { ssr: false, loading: widgetSkeleton });
const RecurringExpensesWidget = dynamic(() => import('./RecurringExpensesWidget').then(m => m.RecurringExpensesWidget), { ssr: false, loading: widgetSkeleton });
const WeekendVsWeekdayWidget = dynamic(() => import('./WeekendVsWeekdayWidget').then(m => m.WeekendVsWeekdayWidget), { ssr: false, loading: widgetSkeleton });

export type DashboardWidgetId =
  | 'favourite-accounts'
  | 'upcoming-bills'
  | 'top-movers'
  | 'favourite-securities'
  | 'net-worth'
  | 'assets-liabilities'
  | 'expenses-pie'
  | 'income-expenses'
  | 'budget-status'
  | 'insights'
  | 'favourite-reports'
  | 'portfolio-value'
  | 'spending-by-payee'
  | 'monthly-spending-trend'
  | 'income-by-source'
  | 'credit-utilization-accounts'
  | 'credit-utilization-total'
  | 'sector-weightings'
  | 'security-type-allocation'
  | 'geographic-allocation'
  | 'recurring-expenses'
  | 'weekend-weekday';

/** The kind of visualization a widget renders, shown as an icon in Customize. */
export type WidgetIconType = 'bar' | 'line' | 'pie' | 'table' | 'list';

/** Everything the dashboard page loads, handed to each widget's render. */
export interface DashboardWidgetContext {
  accounts: Account[];
  categories: Category[];
  scheduledTransactions: ScheduledTransaction[];
  topMovers: TopMover[];
  favouriteSecurities: FavouriteSecurityQuote[];
  netWorthData: MonthlyNetWorth[];
  brokerageMarketValues: Map<string, number>;
  isLoading: boolean;
  hasInvestments: boolean;
  hasSecurities: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onAccountsChanged: () => void;
}

export interface DashboardWidgetDefinition {
  id: DashboardWidgetId;
  /** Key inside the `dashboard` namespace whose `.title` names the widget. */
  titleSection: string;
  /** Visualization kind, surfaced as an icon in the Customize dashboard modal. */
  iconType: WidgetIconType;
  /** Part of the default layout shown to users who never customized. */
  defaultEnabled: boolean;
  /** Rendered for a delegate acting on behalf of the account owner. */
  delegateVisible?: (delegateSections: DelegateSectionGrants | null) => boolean;
  /** Data-driven condition; when false the widget is skipped entirely. */
  shouldRender?: (ctx: DashboardWidgetContext) => boolean;
  render: (ctx: DashboardWidgetContext) => ReactNode;
}

const upcomingBillsMaxItems = (accounts: Account[]) =>
  accounts.filter((a) => a.isFavourite && !a.isClosed).length + 2;

/**
 * All dashboard widgets in default display order. The dashboard renders a
 * two-column grid, so consecutive visible widgets pair up into rows.
 */
export const DASHBOARD_WIDGETS: DashboardWidgetDefinition[] = [
  {
    id: 'favourite-accounts',
    titleSection: 'favouriteAccounts',
    iconType: 'table',
    defaultEnabled: true,
    delegateVisible: () => true,
    render: (ctx) => (
      <FavouriteAccounts
        accounts={ctx.accounts}
        brokerageMarketValues={ctx.brokerageMarketValues}
        isLoading={ctx.isLoading}
        onAccountsChanged={ctx.onAccountsChanged}
      />
    ),
  },
  {
    id: 'upcoming-bills',
    titleSection: 'upcomingBills',
    iconType: 'table',
    defaultEnabled: true,
    delegateVisible: (sections) => !!sections?.bills,
    render: (ctx) => (
      <UpcomingBills
        scheduledTransactions={ctx.scheduledTransactions}
        accounts={ctx.accounts}
        isLoading={ctx.isLoading}
        maxItems={upcomingBillsMaxItems(ctx.accounts)}
      />
    ),
  },
  {
    id: 'top-movers',
    titleSection: 'topMovers',
    iconType: 'table',
    defaultEnabled: true,
    shouldRender: (ctx) => ctx.isLoading || ctx.hasSecurities,
    render: (ctx) => (
      <TopMovers
        movers={ctx.topMovers}
        isLoading={ctx.isLoading}
        hasInvestmentAccounts={ctx.hasInvestments}
        onRefresh={ctx.onRefresh}
        isRefreshing={ctx.isRefreshing}
      />
    ),
  },
  {
    id: 'favourite-securities',
    titleSection: 'favouriteSecurities',
    iconType: 'table',
    defaultEnabled: true,
    shouldRender: (ctx) => ctx.isLoading || ctx.hasSecurities,
    render: (ctx) => (
      <FavouriteSecurities
        securities={ctx.favouriteSecurities}
        isLoading={ctx.isLoading}
        onRefresh={ctx.onRefresh}
        isRefreshing={ctx.isRefreshing}
      />
    ),
  },
  {
    id: 'net-worth',
    titleSection: 'netWorth',
    iconType: 'line',
    defaultEnabled: true,
    render: (ctx) => <NetWorthChart data={ctx.netWorthData} isLoading={ctx.isLoading} />,
  },
  {
    id: 'assets-liabilities',
    titleSection: 'assetsVsLiabilities',
    iconType: 'bar',
    defaultEnabled: true,
    render: (ctx) => <AssetsVsLiabilities data={ctx.netWorthData} isLoading={ctx.isLoading} />,
  },
  {
    id: 'expenses-pie',
    titleSection: 'expensesPieChart',
    iconType: 'pie',
    defaultEnabled: true,
    render: (ctx) => (
      <ExpensesPieChart
        accounts={ctx.accounts}
        categories={ctx.categories}
        isLoading={ctx.isLoading}
      />
    ),
  },
  {
    id: 'income-expenses',
    titleSection: 'incomeExpenses',
    iconType: 'bar',
    defaultEnabled: true,
    render: (ctx) => (
      <IncomeExpensesBarChart accounts={ctx.accounts} isLoading={ctx.isLoading} />
    ),
  },
  {
    id: 'budget-status',
    titleSection: 'budgetStatus',
    iconType: 'bar',
    defaultEnabled: true,
    render: (ctx) => <BudgetStatusWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'insights',
    titleSection: 'insights',
    iconType: 'list',
    defaultEnabled: true,
    render: (ctx) => <InsightsWidget isLoading={ctx.isLoading} />,
  },
  // Opt-in: not part of the default layout so existing users see no change.
  {
    id: 'favourite-reports',
    titleSection: 'favouriteReports',
    iconType: 'list',
    defaultEnabled: false,
    render: (ctx) => <FavouriteReportsWidget isLoading={ctx.isLoading} />,
  },
  // Report-derived chart widgets: all opt-in, each with its own persisted
  // settings. Investment widgets are hidden unless the user has investments.
  {
    id: 'portfolio-value',
    titleSection: 'portfolioValue',
    iconType: 'line',
    defaultEnabled: false,
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <PortfolioValueWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'spending-by-payee',
    titleSection: 'spendingByPayee',
    iconType: 'bar',
    defaultEnabled: false,
    render: (ctx) => <SpendingByPayeeWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'monthly-spending-trend',
    titleSection: 'monthlySpendingTrend',
    iconType: 'line',
    defaultEnabled: false,
    render: (ctx) => <MonthlySpendingTrendWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'income-by-source',
    titleSection: 'incomeBySource',
    iconType: 'pie',
    defaultEnabled: false,
    render: (ctx) => <IncomeBySourceWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'credit-utilization-accounts',
    titleSection: 'creditUtilizationAccounts',
    iconType: 'bar',
    defaultEnabled: false,
    render: (ctx) => <CreditUtilizationAccountsWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'credit-utilization-total',
    titleSection: 'creditUtilizationTotal',
    iconType: 'pie',
    defaultEnabled: false,
    render: (ctx) => <CreditUtilizationTotalWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'sector-weightings',
    titleSection: 'sectorWeightings',
    iconType: 'pie',
    defaultEnabled: false,
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <SectorWeightingsWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'security-type-allocation',
    titleSection: 'securityTypeAllocation',
    iconType: 'pie',
    defaultEnabled: false,
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <SecurityTypeAllocationWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'geographic-allocation',
    titleSection: 'geographicAllocation',
    iconType: 'pie',
    defaultEnabled: false,
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <GeographicAllocationWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'recurring-expenses',
    titleSection: 'recurringExpenses',
    iconType: 'table',
    defaultEnabled: false,
    render: (ctx) => <RecurringExpensesWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'weekend-weekday',
    titleSection: 'weekendVsWeekday',
    iconType: 'bar',
    defaultEnabled: false,
    render: (ctx) => <WeekendVsWeekdayWidget isLoading={ctx.isLoading} />,
  },
];

export const DEFAULT_DASHBOARD_WIDGET_IDS: DashboardWidgetId[] = DASHBOARD_WIDGETS.filter(
  (w) => w.defaultEnabled,
).map((w) => w.id);

/**
 * Resolve the stored `dashboardWidgets` preference into the ordered list of
 * widget definitions to render. An empty/missing preference means the user
 * never customized and gets the default layout; unknown ids (e.g. from a
 * newer/older app version) are silently dropped.
 */
export function resolveDashboardWidgets(
  preferredIds: string[] | null | undefined,
): DashboardWidgetDefinition[] {
  const byId = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));
  const known = (preferredIds ?? []).filter((id): id is DashboardWidgetId => byId.has(id as DashboardWidgetId));
  if (known.length === 0) {
    return DASHBOARD_WIDGETS.filter((w) => w.defaultEnabled);
  }
  return known.map((id) => byId.get(id)!);
}

/** The widgets a delegate may see, regardless of the owner's stored layout. */
export function delegateDashboardWidgets(
  delegateSections: DelegateSectionGrants | null,
): DashboardWidgetDefinition[] {
  return DASHBOARD_WIDGETS.filter((w) => w.delegateVisible?.(delegateSections));
}
