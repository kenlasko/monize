import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import ReportPage from './page';

let paramsValue: Record<string, string> = { reportId: 'spending-by-category' };

vi.mock('next/navigation', () => ({
  useParams: () => paramsValue,
}));

// ProtectedRoute passthrough so ReportContent renders directly.
vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useOnUndoRedo', () => ({
  useOnUndoRedo: vi.fn(),
}));

vi.mock('@/hooks/useOnAiAction', () => ({
  useOnAiAction: vi.fn(),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-layout">{children}</div>
  ),
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title?: string;
    subtitle?: string;
    actions?: React.ReactNode;
  }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p data-testid="subtitle">{subtitle}</p>}
      {actions}
    </div>
  ),
}));

// Stub every lazily-imported report module so Suspense resolves immediately
// and each report id maps to a deterministic test id.
vi.mock('@/components/reports/SpendingByCategoryReport', () => ({ SpendingByCategoryReport: () => <div data-testid="r-spending-by-category" /> }));
vi.mock('@/components/reports/SpendingByPayeeReport', () => ({ SpendingByPayeeReport: () => <div data-testid="r-spending-by-payee" /> }));
vi.mock('@/components/reports/MonthlySpendingTrendReport', () => ({ MonthlySpendingTrendReport: () => <div data-testid="r-monthly-spending-trend" /> }));
vi.mock('@/components/reports/MonthlyCategoryBreakdownReport', () => ({ MonthlyCategoryBreakdownReport: () => <div data-testid="r-monthly-category-breakdown" /> }));
vi.mock('@/components/reports/IncomeVsExpensesReport', () => ({ IncomeVsExpensesReport: () => <div data-testid="r-income-vs-expenses" /> }));
vi.mock('@/components/reports/IncomeBySourceReport', () => ({ IncomeBySourceReport: () => <div data-testid="r-income-by-source" /> }));
vi.mock('@/components/reports/NetWorthReport', () => ({ NetWorthReport: () => <div data-testid="r-net-worth" /> }));
vi.mock('@/components/reports/AccountBalancesReport', () => ({ AccountBalancesReport: () => <div data-testid="r-account-balances" /> }));
vi.mock('@/components/reports/CashFlowReport', () => ({ CashFlowReport: () => <div data-testid="r-cash-flow" /> }));
vi.mock('@/components/reports/TaxSummaryReport', () => ({ TaxSummaryReport: () => <div data-testid="r-tax-summary" /> }));
vi.mock('@/components/reports/YearOverYearReport', () => ({ YearOverYearReport: () => <div data-testid="r-year-over-year" /> }));
vi.mock('@/components/reports/DebtPayoffTimelineReport', () => ({ DebtPayoffTimelineReport: () => <div data-testid="r-debt-payoff-timeline" /> }));
vi.mock('@/components/reports/LoanAmortizationReport', () => ({ LoanAmortizationReport: () => <div data-testid="r-loan-amortization" /> }));
vi.mock('@/components/reports/InvestmentPerformanceReport', () => ({ InvestmentPerformanceReport: () => <div data-testid="r-investment-performance" /> }));
vi.mock('@/components/reports/DividendIncomeReport', () => ({ DividendIncomeReport: () => <div data-testid="r-dividend-income" /> }));
vi.mock('@/components/reports/SectorWeightingsReport', () => ({ SectorWeightingsReport: () => <div data-testid="r-sector-weightings" /> }));
vi.mock('@/components/reports/RealizedGainsReport', () => ({ RealizedGainsReport: () => <div data-testid="r-realized-gains" /> }));
vi.mock('@/components/reports/PortfolioValueReport', () => ({ PortfolioValueReport: () => <div data-testid="r-portfolio-value" /> }));
vi.mock('@/components/reports/InvestmentTransactionHistoryReport', () => ({ InvestmentTransactionHistoryReport: () => <div data-testid="r-investment-transactions" /> }));
vi.mock('@/components/reports/SecurityTypeAllocationReport', () => ({ SecurityTypeAllocationReport: () => <div data-testid="r-security-type-allocation" /> }));
vi.mock('@/components/reports/GeographicAllocationReport', () => ({ GeographicAllocationReport: () => <div data-testid="r-geographic-allocation" /> }));
vi.mock('@/components/reports/DividendYieldGrowthReport', () => ({ DividendYieldGrowthReport: () => <div data-testid="r-dividend-yield-growth" /> }));
vi.mock('@/components/reports/SecurityPerformanceReport', () => ({ SecurityPerformanceReport: () => <div data-testid="r-security-performance" /> }));
vi.mock('@/components/reports/CurrencyExposureReport', () => ({ CurrencyExposureReport: () => <div data-testid="r-currency-exposure" /> }));
vi.mock('@/components/reports/MonteCarloReport', () => ({ MonteCarloReport: () => <div data-testid="r-monte-carlo-simulation" /> }));
vi.mock('@/components/reports/RecurringExpensesReport', () => ({ RecurringExpensesReport: () => <div data-testid="r-recurring-expenses" /> }));
vi.mock('@/components/reports/SpendingAnomaliesReport', () => ({ SpendingAnomaliesReport: () => <div data-testid="r-spending-anomalies" /> }));
vi.mock('@/components/reports/WeekendVsWeekdayReport', () => ({ WeekendVsWeekdayReport: () => <div data-testid="r-weekend-weekday-spending" /> }));
vi.mock('@/components/reports/MonthlyComparisonReport', () => ({ MonthlyComparisonReport: () => <div data-testid="r-monthly-comparison" /> }));
vi.mock('@/components/reports/UncategorizedTransactionsReport', () => ({ UncategorizedTransactionsReport: () => <div data-testid="r-uncategorized-transactions" /> }));
vi.mock('@/components/reports/DuplicateTransactionReport', () => ({ DuplicateTransactionReport: () => <div data-testid="r-duplicate-transactions" /> }));
vi.mock('@/components/reports/UpcomingBillsReport', () => ({ UpcomingBillsReport: () => <div data-testid="r-upcoming-bills" /> }));
vi.mock('@/components/reports/BillPaymentHistoryReport', () => ({ BillPaymentHistoryReport: () => <div data-testid="r-bill-payment-history" /> }));
vi.mock('@/components/reports/BudgetVsActualReport', () => ({ BudgetVsActualReport: () => <div data-testid="r-budget-vs-actual" /> }));
vi.mock('@/components/reports/BudgetHealthScoreReport', () => ({ BudgetHealthScoreReport: () => <div data-testid="r-budget-health-score" /> }));
vi.mock('@/components/reports/BudgetSeasonalPatternsReport', () => ({ BudgetSeasonalPatternsReport: () => <div data-testid="r-budget-seasonal-patterns" /> }));
vi.mock('@/components/reports/BudgetTrendReport', () => ({ BudgetTrendReport: () => <div data-testid="r-budget-trend" /> }));
vi.mock('@/components/reports/CategoryPerformanceReport', () => ({ CategoryPerformanceReport: () => <div data-testid="r-category-performance" /> }));
vi.mock('@/components/reports/SavingsRateReport', () => ({ SavingsRateReport: () => <div data-testid="r-savings-rate" /> }));
vi.mock('@/components/reports/HealthScoreHistoryReport', () => ({ HealthScoreHistoryReport: () => <div data-testid="r-health-score-history" /> }));
vi.mock('@/components/reports/FlexGroupAnalysisReport', () => ({ FlexGroupAnalysisReport: () => <div data-testid="r-flex-group-analysis" /> }));
vi.mock('@/components/reports/SeasonalSpendingMapReport', () => ({ SeasonalSpendingMapReport: () => <div data-testid="r-seasonal-spending-map" /> }));

const ALL_REPORT_IDS = [
  'spending-by-category',
  'spending-by-payee',
  'monthly-spending-trend',
  'monthly-category-breakdown',
  'income-vs-expenses',
  'income-by-source',
  'net-worth',
  'account-balances',
  'cash-flow',
  'tax-summary',
  'year-over-year',
  'debt-payoff-timeline',
  'loan-amortization',
  'investment-performance',
  'dividend-income',
  'sector-weightings',
  'realized-gains',
  'portfolio-value',
  'investment-transactions',
  'security-type-allocation',
  'geographic-allocation',
  'dividend-yield-growth',
  'security-performance',
  'currency-exposure',
  'monte-carlo-simulation',
  'recurring-expenses',
  'spending-anomalies',
  'weekend-weekday-spending',
  'monthly-comparison',
  'uncategorized-transactions',
  'duplicate-transactions',
  'upcoming-bills',
  'bill-payment-history',
  'budget-vs-actual',
  'budget-health-score',
  'budget-seasonal-patterns',
  'budget-trend',
  'category-performance',
  'savings-rate',
  'health-score-history',
  'flex-group-analysis',
  'seasonal-spending-map',
];

describe('ReportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paramsValue = { reportId: 'spending-by-category' };
  });

  it('renders the page header with the report name and description', async () => {
    await act(async () => {
      render(<ReportPage />);
    });
    await act(async () => {});
    expect(await screen.findByText('Spending by Category')).toBeInTheDocument();
    expect(screen.getByTestId('subtitle')).toHaveTextContent(
      /See where your money goes/,
    );
    expect(screen.getByText('Back to Reports')).toBeInTheDocument();
  });

  it('renders the Report Not Found state for an unknown report id', async () => {
    paramsValue = { reportId: 'does-not-exist' };
    await act(async () => {
      render(<ReportPage />);
    });
    expect(await screen.findByText('Report Not Found')).toBeInTheDocument();
    expect(
      screen.getByText('The requested report does not exist.'),
    ).toBeInTheDocument();
    // The header (with Back to Reports) is not rendered in the not-found branch.
    expect(screen.queryByText('Back to Reports')).not.toBeInTheDocument();
  });

  it('renders the back link pointing to /reports', async () => {
    paramsValue = { reportId: 'tax-summary' };
    await act(async () => {
      render(<ReportPage />);
    });
    expect(await screen.findByText('Tax Summary')).toBeInTheDocument();
    const backLink = screen.getByText('Back to Reports').closest('a');
    expect(backLink).toHaveAttribute('href', '/reports');
  });

  // Render every built-in report id so each lazy() factory, its resolved
  // component, and its name/description map entries are exercised.
  it.each(ALL_REPORT_IDS)('lazily renders the %s report', async (id) => {
    paramsValue = { reportId: id };
    await act(async () => {
      render(<ReportPage />);
    });
    await act(async () => {});
    expect(await screen.findByTestId(`r-${id}`)).toBeInTheDocument();
    // The header is shown for every known report.
    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    expect(screen.getByText('Back to Reports')).toBeInTheDocument();
  });
});
