/**
 * Config contract for the report-derived dashboard widgets. Each configurable
 * widget owns a slice of the cross-device `dashboardWidgetConfig` preference,
 * keyed by its widget id. Defaults are stable module-level constants (required
 * by useWidgetConfig, which memoizes on the defaults reference).
 */

/** Range presets offered by the transaction-based spending/income widgets. */
export const SPENDING_RANGES = ['1m', '3m', '6m', '1y', 'ytd'] as const;
/** Range presets for month-trend widgets. */
export const TREND_RANGES = ['6m', '1y', '2y'] as const;
/** Range presets for the portfolio value widget. */
export const PORTFOLIO_RANGES = ['3m', '6m', '1y', '2y', '5y', 'all'] as const;
/** Range presets for the weekend/weekday widget. */
export const WEEKEND_RANGES = ['1m', '3m', '6m', '1y'] as const;

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

export interface GeographicConfig {
  accountIds: string[];
  view: 'region' | 'exchange' | 'country';
}

export interface RecurringConfig {
  minOccurrences: number;
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

export const SECURITY_TYPE_ALLOCATION_DEFAULT: AccountsConfig = {
  accountIds: [],
};

export const GEOGRAPHIC_ALLOCATION_DEFAULT: GeographicConfig = {
  accountIds: [],
  view: 'region',
};

export const RECURRING_EXPENSES_DEFAULT: RecurringConfig = { minOccurrences: 3 };

export const WEEKEND_WEEKDAY_DEFAULT: WeekendConfig = {
  range: '3m',
  view: 'overview',
};
