/**
 * Config contract for the report-derived dashboard widgets. Each configurable
 * widget owns a slice of the cross-device `dashboardWidgetConfig` preference,
 * keyed by its widget id. Defaults are stable module-level constants (required
 * by useWidgetConfig, which memoizes on the defaults reference).
 */

import type { ForecastPeriod } from '@/lib/forecast';
import type { NetWorthBarStyle } from '@/components/reports/NetWorthByAccountTypeChart';
import { RECURRING_EXPENSE_RANGES, type RecurringExpenseRange } from '@/types/built-in-reports';
import { PORTFOLIO_CHART_RANGES } from '@/components/investments/portfolio-range-window';

/** Range presets offered by the transaction-based spending/income widgets. */
export const SPENDING_RANGES = ['mtd', '1m', '3m', '6m', '1y', 'ytd'] as const;
/** Range presets for month-trend widgets. */
export const TREND_RANGES = ['6m', 'ytd', '1y', '2y'] as const;
/**
 * Range presets for the portfolio value widget. 1W and MTD are measured from
 * the prior close (`PRIOR_CLOSE_BASELINE_RANGES`), which the daily series this
 * widget draws supports; 1D is absent because a single session has no daily
 * points to draw, and only the intraday chart on the Investments page can show
 * it.
 */
export const PORTFOLIO_RANGES = [
  '1w',
  'mtd',
  '3m',
  '6m',
  'ytd',
  '1y',
  '2y',
  '5y',
  'all',
] as const;
/** Range presets for the recurring expenses widget (the analysis' own windows). */
export const RECURRING_RANGES = RECURRING_EXPENSE_RANGES;
/** Range presets for the net worth widget: whole years of months. */
export const NET_WORTH_RANGES = ['1y', '2y', '5y', '10y'] as const;
/** Range presets for the weekend/weekday widget. */
export const WEEKEND_RANGES = ['1m', '3m', '6m', '1y'] as const;

/**
 * Identity overrides available on every configurable widget: a custom display
 * name replacing the built-in title, and an optional description shown in
 * smaller type under the title. Managed centrally by WidgetCard (keyed by the
 * same widget id as the rest of the widget's settings), so individual widgets
 * only opt in by passing their `widgetId`.
 */
export interface WidgetIdentityConfig {
  displayName?: string;
  description?: string;
}

/** Max lengths for the identity fields (backend caps config strings at 100). */
export const WIDGET_DISPLAY_NAME_MAX = 60;
export const WIDGET_DESCRIPTION_MAX = 100;

export interface RangeConfig {
  range: string;
}

export interface PortfolioValueConfig {
  range: string;
  accountIds: string[];
}

export interface IncomeBySourceConfig {
  range: string;
  chartType: 'pie' | 'bar';
}

export interface AccountsConfig {
  accountIds: string[];
}

/** Timeframe + accounts config for the transaction-based summary charts. */
export interface RangeAccountsConfig {
  range: string;
  accountIds: string[];
}

/**
 * Expenses by Category adds a rollup choice: with `topLevelOnly` a subcategory's
 * spend is counted against its top-level ancestor, so the chart answers "which
 * part of my budget" rather than listing every leaf. `view` names the top ten
 * categories in boxes beside the donut (`callouts`, which falls back to the
 * legend where the widget is too small for the boxes), or eleven in a legend
 * under it.
 */
export interface ExpensesPieConfig extends RangeAccountsConfig {
  topLevelOnly: boolean;
  view: 'callouts' | 'legend';
}

/**
 * Security Type Allocation view. `type` places each holding by its own security
 * type, from the portfolio summary; `assetClass` asks the backend for the
 * look-through breakdown, which sees inside a fund rather than filing the whole
 * of it under ETF.
 */
export interface SecurityTypeAllocationConfig {
  accountIds: string[];
  view: 'type' | 'assetClass';
}

export interface GeographicConfig {
  accountIds: string[];
  view: 'region' | 'exchange' | 'country';
}

/**
 * Upcoming Bills settings.
 *
 * `scope` is which occurrences the widget lists: `dueSoon` keeps the reminder
 * window each schedule carries, `all` shows every active schedule's next
 * occurrence however far off it is. `view` picks the list or the month grid.
 */
export interface UpcomingBillsConfig {
  scope: 'dueSoon' | 'all';
  view: 'list' | 'calendar';
}

/**
 * Cash Flow Forecast settings: how far ahead to project, and which accounts.
 * An empty `accountIds` is every account, drawn as one line.
 */
export interface CashFlowForecastConfig {
  period: ForecastPeriod;
  accountIds: string[];
}

/**
 * Top Recurring Expenses settings. `view` names each slice either in a box
 * beside the donut with a line to its slice (`callouts`, which falls back to
 * the legend where the widget is too small for the boxes) or in a legend
 * under it.
 */
export interface RecurringConfig {
  minOccurrences: number;
  range: RecurringExpenseRange;
  view: 'callouts' | 'legend';
}

/**
 * Assets vs Liabilities settings. `view` names the two slices either in boxes
 * beside the donut with a line to each slice (`callouts`, which falls back to
 * the legend where the widget is too small for the boxes) or in a legend
 * under it.
 */
export interface AssetsLiabilitiesConfig {
  view: 'callouts' | 'legend';
}

/**
 * Net Worth settings: how many years of months to draw, and whether the bars
 * are one solid bar of net worth or stacked by account type.
 */
export interface NetWorthConfig {
  range: (typeof NET_WORTH_RANGES)[number];
  barStyle: NetWorthBarStyle;
}

export interface WeekendConfig {
  range: string;
  view: 'overview' | 'byDay';
}

export const PORTFOLIO_VALUE_DEFAULT: PortfolioValueConfig = {
  range: '1y',
  accountIds: [],
};

export const SPENDING_BY_PAYEE_DEFAULT: RangeConfig = { range: '3m' };

export const MONTHLY_SPENDING_TREND_DEFAULT: RangeConfig = { range: '1y' };

export const INCOME_BY_SOURCE_DEFAULT: IncomeBySourceConfig = {
  range: '1y',
  chartType: 'pie',
};

export const CREDIT_UTILIZATION_ACCOUNTS_DEFAULT: AccountsConfig = {
  accountIds: [],
};

export const CREDIT_UTILIZATION_TOTAL_DEFAULT: AccountsConfig = {
  accountIds: [],
};

export const SECTOR_WEIGHTINGS_DEFAULT: AccountsConfig = { accountIds: [] };

export const SECURITY_TYPE_ALLOCATION_DEFAULT: SecurityTypeAllocationConfig = {
  accountIds: [],
  view: 'type',
};

export const GEOGRAPHIC_ALLOCATION_DEFAULT: GeographicConfig = {
  accountIds: [],
  view: 'region',
};

// The historical behaviour: only what is overdue or inside its reminder window,
// as a list.
export const UPCOMING_BILLS_DEFAULT: UpcomingBillsConfig = {
  scope: 'dueSoon',
  view: 'list',
};

// The Bills & Deposits chart's own default window.
export const CASH_FLOW_FORECAST_DEFAULT: CashFlowForecastConfig = {
  period: 'month',
  accountIds: [],
};

// Six months is the window the widget always used.
export const RECURRING_EXPENSES_DEFAULT: RecurringConfig = {
  minOccurrences: 3,
  range: '6m',
  view: 'callouts',
};

// Twelve months is the window the widget always drew; stacked by account
// type is the bar it draws today.
/**
 * The dashboard hero above the widget grid, in one of two sets: net worth
 * (its change this month, assets, liabilities, invested, a net worth chart)
 * or the portfolio (its value, holdings and cash, one chosen return, a value
 * chart). It is not one of the ordered widgets (it always sits first and spans
 * the page), so its settings live here, in the per-widget settings map, rather
 * than in `dashboardWidgets` -- which is also what lets it default on for a
 * reader who customized the grid before it existed. The greeting and date above
 * it are the page header and stay when the hero is off.
 */
export const DASHBOARD_HERO_SETS = ['netWorth', 'portfolio'] as const;
export type DashboardHeroSet = (typeof DASHBOARD_HERO_SETS)[number];

/**
 * The portfolio set's one chosen return beside its holdings and cash: the
 * Investments page summary card's four, since inception. The change over the
 * chosen window is always shown, beside the value.
 */
export const DASHBOARD_HERO_PORTFOLIO_METRICS = ['simpleReturn', 'twr', 'mwr', 'cagr'] as const;
export type DashboardHeroPortfolioMetric = (typeof DASHBOARD_HERO_PORTFOLIO_METRICS)[number];

export interface DashboardHeroConfig {
  enabled: boolean;
  set: DashboardHeroSet;
  /** The net worth chart's window. */
  range: (typeof NET_WORTH_RANGES)[number];
  /** The portfolio chart's window: the Investments page value chart's ranges. */
  portfolioRange: (typeof PORTFOLIO_CHART_RANGES)[number];
  /** The investment accounts the portfolio set covers; empty is all of them. */
  portfolioAccountIds: string[];
  portfolioMetric: DashboardHeroPortfolioMetric;
}

export const DASHBOARD_HERO_WIDGET_ID = 'dashboard-hero';

export const DASHBOARD_HERO_DEFAULT: DashboardHeroConfig = {
  enabled: true,
  set: 'netWorth',
  range: '1y',
  portfolioRange: '1y',
  portfolioAccountIds: [],
  portfolioMetric: 'twr',
};

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * The hero's settings read from whatever is stored: each key the hero has,
 * taken only when it holds a value the hero offers, so a stale key from an
 * older version or a value no longer offered falls back to the default.
 */
export function resolveDashboardHeroConfig(stored: unknown): DashboardHeroConfig {
  const s = (stored ?? {}) as Partial<Record<keyof DashboardHeroConfig, unknown>>;
  const d = DASHBOARD_HERO_DEFAULT;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    set: isOneOf(DASHBOARD_HERO_SETS, s.set) ? s.set : d.set,
    range: isOneOf(NET_WORTH_RANGES, s.range) ? s.range : d.range,
    portfolioRange: isOneOf(PORTFOLIO_CHART_RANGES, s.portfolioRange) ? s.portfolioRange : d.portfolioRange,
    portfolioAccountIds: Array.isArray(s.portfolioAccountIds)
      ? s.portfolioAccountIds.filter((id): id is string => typeof id === 'string')
      : d.portfolioAccountIds,
    portfolioMetric: isOneOf(DASHBOARD_HERO_PORTFOLIO_METRICS, s.portfolioMetric)
      ? s.portfolioMetric
      : d.portfolioMetric,
  };
}

export const NET_WORTH_DEFAULT: NetWorthConfig = {
  range: '1y',
  barStyle: 'accountType',
};

// The legend is what the widget always showed.
export const ASSETS_LIABILITIES_DEFAULT: AssetsLiabilitiesConfig = {
  view: 'legend',
};

export const WEEKEND_WEEKDAY_DEFAULT: WeekendConfig = {
  range: '3m',
  view: 'overview',
};

// The two default summary charts default to their historical windows: the pie
// showed the past 30 days, the income/expenses bars the recent weeks.
export const EXPENSES_PIE_DEFAULT: ExpensesPieConfig = {
  range: '1m',
  accountIds: [],
  topLevelOnly: false,
  view: 'legend',
};

/**
 * The Cash Flow Sankey widget: the report's own settings. An empty
 * `accountIds` is the server's default cash-flow scope.
 */
export interface CashFlowSankeyConfig extends RangeAccountsConfig {
  depth: 1 | 2;
  view: 'sankey' | 'table';
}

export const CASH_FLOW_SANKEY_DEFAULT: CashFlowSankeyConfig = {
  range: 'mtd',
  accountIds: [],
  depth: 1,
  view: 'sankey',
};

export const INCOME_EXPENSES_DEFAULT: RangeAccountsConfig = {
  range: '1m',
  accountIds: [],
};
