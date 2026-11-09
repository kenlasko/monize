import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { DashboardHero } from './DashboardHero';

const prefs: { current: Record<string, unknown> | undefined } = { current: undefined };
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ preferences: { dashboardWidgetConfig: prefs.current } }),
}));

vi.mock('./NetWorthHero', () => ({
  NetWorthHero: ({ config, header }: any) => (
    <div data-testid="net-worth-hero" data-range={config.range}>
      {header}
    </div>
  ),
}));
vi.mock('./PortfolioHero', () => ({
  PortfolioHero: ({ config, header }: any) => (
    <div data-testid="portfolio-hero" data-range={config.portfolioRange} data-metric={config.portfolioMetric}>
      {header}
    </div>
  ),
}));

const renderHero = () =>
  render(
    <DashboardHero
      portfolioValuation={null}
      investmentAccounts={[]}
      hasInvestments
      isLoading={false}
      investmentSummaryLoading={false}
      header={<h1>Good evening, Ken</h1>}
    />,
  );

describe('DashboardHero', () => {
  beforeEach(() => {
    prefs.current = undefined;
  });

  it('opens with the net worth set for a reader who never chose one', () => {
    renderHero();
    expect(screen.getByTestId('net-worth-hero')).toHaveAttribute('data-range', '1y');
    expect(screen.getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
  });

  it('shows the portfolio set with its own window and figure', () => {
    prefs.current = {
      'dashboard-hero': { set: 'portfolio', portfolioRange: 'ytd', portfolioMetric: 'cagr' },
    };
    renderHero();
    const hero = screen.getByTestId('portfolio-hero');
    expect(hero).toHaveAttribute('data-range', 'ytd');
    expect(hero).toHaveAttribute('data-metric', 'cagr');
    expect(screen.queryByTestId('net-worth-hero')).not.toBeInTheDocument();
  });

  it('keeps only the greeting header when switched off, whichever set was chosen', () => {
    prefs.current = { 'dashboard-hero': { enabled: false, set: 'portfolio' } };
    renderHero();
    expect(screen.getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
    expect(screen.queryByTestId('portfolio-hero')).not.toBeInTheDocument();
    expect(screen.queryByTestId('net-worth-hero')).not.toBeInTheDocument();
  });
});
