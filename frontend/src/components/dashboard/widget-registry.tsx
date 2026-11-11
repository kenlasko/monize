'use client';

import { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Account } from '@/types/account';
import type { Institution } from '@/types/institution';
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
import { Card } from '@/components/ui/Card';
import type { WidgetHeight, WidgetWidth } from './dashboard-layout';

/** Placeholder card while a lazy widget's chunk loads; matches WidgetCard's shell. */
const widgetSkeleton = (minHeight = 'lg:min-h-[540px]') =>
  function WidgetSkeleton() {
    return <Card padding="md" className={minHeight} />;
  };
const WarrantiesExpiringWidget = dynamic(() => import('./WarrantiesExpiringWidget').then(m => m.WarrantiesExpiringWidget), { ssr: false, loading: widgetSkeleton('lg:min-h-[390px]') });
const ExpensesPieChart = dynamic(() => import('./ExpensesPieChart').then(m => m.ExpensesPieChart), {
  ssr: false,
  loading: widgetSkeleton(),
});
const IncomeExpensesBarChart = dynamic(() => import('./IncomeExpensesBarChart').then(m => m.IncomeExpensesBarChart), {
  ssr: false,
  loading: widgetSkeleton(),
});
const NetWorthChart = dynamic(() => import('./NetWorthChart').then(m => m.NetWorthChart), {
  ssr: false,
  loading: widgetSkeleton('lg:min-h-[500px]'),
});
const AssetsVsLiabilities = dynamic(() => import('./AssetsVsLiabilities').then(m => m.AssetsVsLiabilities), {
  ssr: false,
  loading: widgetSkeleton('lg:min-h-[500px]'),
});
const PortfolioValueWidget = dynamic(() => import('./PortfolioValueWidget').then(m => m.PortfolioValueWidget), { ssr: false, loading: widgetSkeleton() });
const SpendingByPayeeWidget = dynamic(() => import('./SpendingByPayeeWidget').then(m => m.SpendingByPayeeWidget), { ssr: false, loading: widgetSkeleton() });
const MonthlySpendingTrendWidget = dynamic(() => import('./MonthlySpendingTrendWidget').then(m => m.MonthlySpendingTrendWidget), { ssr: false, loading: widgetSkeleton() });
const CashFlowSankeyWidget = dynamic(() => import('./CashFlowSankeyWidget').then(m => m.CashFlowSankeyWidget), { ssr: false, loading: widgetSkeleton() });
const IncomeBySourceWidget = dynamic(() => import('./IncomeBySourceWidget').then(m => m.IncomeBySourceWidget), { ssr: false, loading: widgetSkeleton() });
const CreditUtilizationAccountsWidget = dynamic(() => import('./CreditUtilizationAccountsWidget').then(m => m.CreditUtilizationAccountsWidget), { ssr: false, loading: widgetSkeleton() });
const CreditUtilizationTotalWidget = dynamic(() => import('./CreditUtilizationTotalWidget').then(m => m.CreditUtilizationTotalWidget), { ssr: false, loading: widgetSkeleton() });
const SectorWeightingsWidget = dynamic(() => import('./SectorWeightingsWidget').then(m => m.SectorWeightingsWidget), { ssr: false, loading: widgetSkeleton() });
const SecurityTypeAllocationWidget = dynamic(() => import('./SecurityTypeAllocationWidget').then(m => m.SecurityTypeAllocationWidget), { ssr: false, loading: widgetSkeleton() });
const GeographicAllocationWidget = dynamic(() => import('./GeographicAllocationWidget').then(m => m.GeographicAllocationWidget), { ssr: false, loading: widgetSkeleton() });
const RecurringExpensesWidget = dynamic(() => import('./RecurringExpensesWidget').then(m => m.RecurringExpensesWidget), { ssr: false, loading: widgetSkeleton() });
const CashFlowForecastWidget = dynamic(() => import('./CashFlowForecastWidget').then(m => m.CashFlowForecastWidget), { ssr: false, loading: widgetSkeleton() });
const TriviaWidget = dynamic(() => import('./TriviaWidget').then(m => m.TriviaWidget), { ssr: false, loading: widgetSkeleton() });
const WeekendVsWeekdayWidget = dynamic(() => import('./WeekendVsWeekdayWidget').then(m => m.WeekendVsWeekdayWidget), { ssr: false, loading: widgetSkeleton() });

export type DashboardWidgetId =
  | 'favourite-accounts'
  | 'upcoming-bills'
  | 'cash-flow-forecast'
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
  | 'weekend-weekday'
  | 'cash-flow-sankey'
  | 'warranties-expiring'
  | 'trivia';

/** The kind of visualization a widget renders, shown as an icon in Customize. */
export type WidgetIconType = 'bar' | 'line' | 'pie' | 'table' | 'list';

/** Everything the dashboard page loads, handed to each widget's render. */
export interface DashboardWidgetContext {
  accounts: Account[];
  scheduledTransactions: ScheduledTransaction[];
  topMovers: TopMover[];
  favouriteSecurities: FavouriteSecurityQuote[];
  netWorthData: MonthlyNetWorth[];
  /** The net worth request failed; `netWorthData` is then empty, not "no history". */
  netWorthFailed: boolean;
  brokerageMarketValues: Map<string, number>;
  /** Holdings account id -> how many of its holdings have no price. */
  unpricedHoldingCounts: Map<string, number>;
  /** Holdings account ids whose valuation is a subtotal for any cause, a missing rate included. */
  incompleteHoldingAccountIds: ReadonlySet<string>;
  /** Empty for a delegate, or when the list could not be loaded. */
  institutions: Institution[];
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
  /** The narrowest width the widget is legible at. Wider presets are always offered. */
  minWidth: Extract<WidgetWidth, 'third' | 'half'>;
  /** The height floor the widget has when the reader chose none. */
  defaultHeight: WidgetHeight;
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
    minWidth: 'half',
    defaultHeight: 'auto',
    delegateVisible: () => true,
    render: (ctx) => (
      <FavouriteAccounts
        accounts={ctx.accounts}
        brokerageMarketValues={ctx.brokerageMarketValues}
        unpricedHoldingCounts={ctx.unpricedHoldingCounts}
        incompleteHoldingAccountIds={ctx.incompleteHoldingAccountIds}
        institutions={ctx.institutions}
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
    minWidth: 'half',
    defaultHeight: 'auto',
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
  // Opt-in, and listed beside Upcoming Bills so the Customize modal's hidden
  // widgets offer the two together.
  {
    id: 'cash-flow-forecast',
    titleSection: 'cashFlowForecast',
    iconType: 'line',
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => (
      <CashFlowForecastWidget
        scheduledTransactions={ctx.scheduledTransactions}
        accounts={ctx.accounts}
        isLoading={ctx.isLoading}
      />
    ),
  },
  {
    id: 'top-movers',
    titleSection: 'topMovers',
    iconType: 'table',
    defaultEnabled: true,
    minWidth: 'half',
    defaultHeight: 'standard',
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
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
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
  // Part of the default layout: the portfolio value chart occupies the slot
  // Favourite Securities used to hold. Hidden until the user has investments.
  {
    id: 'portfolio-value',
    titleSection: 'portfolioValue',
    iconType: 'line',
    defaultEnabled: true,
    minWidth: 'half',
    defaultHeight: 'standard',
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <PortfolioValueWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'net-worth',
    titleSection: 'netWorth',
    iconType: 'line',
    defaultEnabled: true,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => <NetWorthChart isLoading={ctx.isLoading} />,
  },
  {
    id: 'assets-liabilities',
    titleSection: 'assetsVsLiabilities',
    iconType: 'bar',
    defaultEnabled: true,
    minWidth: 'third',
    defaultHeight: 'standard',
    render: (ctx) => <AssetsVsLiabilities data={ctx.netWorthData} isLoading={ctx.isLoading} error={ctx.netWorthFailed} />,
  },
  {
    id: 'expenses-pie',
    titleSection: 'expensesPieChart',
    iconType: 'pie',
    defaultEnabled: true,
    minWidth: 'third',
    defaultHeight: 'standard',
    render: (ctx) => (
      <ExpensesPieChart accounts={ctx.accounts} isLoading={ctx.isLoading} />
    ),
  },
  {
    id: 'income-expenses',
    titleSection: 'incomeExpenses',
    iconType: 'bar',
    defaultEnabled: true,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => (
      <IncomeExpensesBarChart accounts={ctx.accounts} isLoading={ctx.isLoading} />
    ),
  },
  {
    id: 'budget-status',
    titleSection: 'budgetStatus',
    iconType: 'bar',
    defaultEnabled: true,
    minWidth: 'third',
    defaultHeight: 'compact',
    render: (ctx) => <BudgetStatusWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'insights',
    titleSection: 'insights',
    iconType: 'list',
    defaultEnabled: true,
    minWidth: 'third',
    defaultHeight: 'compact',
    render: (ctx) => <InsightsWidget isLoading={ctx.isLoading} />,
  },
  // Opt-in: not part of the default layout so existing users see no change.
  {
    id: 'favourite-reports',
    titleSection: 'favouriteReports',
    iconType: 'list',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'auto',
    render: (ctx) => <FavouriteReportsWidget isLoading={ctx.isLoading} />,
  },
  // Report-derived chart widgets: opt-in, each with its own persisted
  // settings. Investment widgets are hidden unless the user has investments.
  {
    id: 'spending-by-payee',
    titleSection: 'spendingByPayee',
    iconType: 'bar',
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => <SpendingByPayeeWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'monthly-spending-trend',
    titleSection: 'monthlySpendingTrend',
    iconType: 'line',
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => <MonthlySpendingTrendWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'income-by-source',
    titleSection: 'incomeBySource',
    iconType: 'pie',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'standard',
    render: (ctx) => <IncomeBySourceWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'credit-utilization-accounts',
    titleSection: 'creditUtilizationAccounts',
    iconType: 'bar',
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => <CreditUtilizationAccountsWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'credit-utilization-total',
    titleSection: 'creditUtilizationTotal',
    iconType: 'pie',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'standard',
    render: (ctx) => <CreditUtilizationTotalWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'sector-weightings',
    titleSection: 'sectorWeightings',
    iconType: 'pie',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'standard',
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <SectorWeightingsWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'security-type-allocation',
    titleSection: 'securityTypeAllocation',
    iconType: 'pie',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'standard',
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <SecurityTypeAllocationWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'geographic-allocation',
    titleSection: 'geographicAllocation',
    iconType: 'pie',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'standard',
    shouldRender: (ctx) => ctx.isLoading || ctx.hasInvestments,
    render: (ctx) => <GeographicAllocationWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  {
    id: 'recurring-expenses',
    titleSection: 'recurringExpenses',
    iconType: 'table',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'standard',
    render: (ctx) => <RecurringExpensesWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'weekend-weekday',
    titleSection: 'weekendVsWeekday',
    iconType: 'bar',
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => <WeekendVsWeekdayWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'cash-flow-sankey',
    titleSection: 'cashFlowSankey',
    iconType: 'bar',
    defaultEnabled: false,
    minWidth: 'half',
    defaultHeight: 'standard',
    render: (ctx) => <CashFlowSankeyWidget accounts={ctx.accounts} isLoading={ctx.isLoading} />,
  },
  // Opt-in for the owner; a delegate sees it with the warranties section.
  {
    id: 'warranties-expiring',
    titleSection: 'warrantiesExpiring',
    iconType: 'list',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'compact',
    delegateVisible: (sections) => !!sections?.warranties,
    render: (ctx) => <WarrantiesExpiringWidget isLoading={ctx.isLoading} />,
  },
  // Opt-in, as every widget added after the default layout was set. The
  // backend builds the facts only for a layout that holds it.
  {
    id: 'trivia',
    titleSection: 'trivia',
    iconType: 'list',
    defaultEnabled: false,
    minWidth: 'third',
    defaultHeight: 'compact',
    render: (ctx) => <TriviaWidget isLoading={ctx.isLoading} />,
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
