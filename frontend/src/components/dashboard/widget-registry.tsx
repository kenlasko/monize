'use client';

import { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';
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
  | 'favourite-reports';

/** Everything the dashboard page loads, handed to each widget's render. */
export interface DashboardWidgetContext {
  accounts: Account[];
  transactions: Transaction[];
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
    defaultEnabled: true,
    render: (ctx) => <NetWorthChart data={ctx.netWorthData} isLoading={ctx.isLoading} />,
  },
  {
    id: 'assets-liabilities',
    titleSection: 'assetsVsLiabilities',
    defaultEnabled: true,
    render: (ctx) => <AssetsVsLiabilities data={ctx.netWorthData} isLoading={ctx.isLoading} />,
  },
  {
    id: 'expenses-pie',
    titleSection: 'expensesPieChart',
    defaultEnabled: true,
    render: (ctx) => (
      <ExpensesPieChart
        transactions={ctx.transactions}
        categories={ctx.categories}
        isLoading={ctx.isLoading}
      />
    ),
  },
  {
    id: 'income-expenses',
    titleSection: 'incomeExpenses',
    defaultEnabled: true,
    render: (ctx) => (
      <IncomeExpensesBarChart transactions={ctx.transactions} isLoading={ctx.isLoading} />
    ),
  },
  {
    id: 'budget-status',
    titleSection: 'budgetStatus',
    defaultEnabled: true,
    render: (ctx) => <BudgetStatusWidget isLoading={ctx.isLoading} />,
  },
  {
    id: 'insights',
    titleSection: 'insights',
    defaultEnabled: true,
    render: (ctx) => <InsightsWidget isLoading={ctx.isLoading} />,
  },
  // Opt-in: not part of the default layout so existing users see no change.
  {
    id: 'favourite-reports',
    titleSection: 'favouriteReports',
    defaultEnabled: false,
    render: (ctx) => <FavouriteReportsWidget isLoading={ctx.isLoading} />,
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
