import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@/test/render';
import { useContext } from 'react';
import { CollapsingTitleContext } from '@/hooks/useCollapsingHeaderTitle';
import { DashboardHero } from './DashboardHero';
import { HeroPanelActiveContext } from './hero-parts';
import { HERO_CYCLE_MS, HERO_PRELOAD_MS } from './useHeroCycle';

const prefs: { current: Record<string, unknown> | undefined; trivia?: boolean } = { current: undefined };
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ preferences: { dashboardWidgetConfig: prefs.current, aiTriviaEnabled: prefs.trivia } }),
}));

const triviaState: { list: unknown; asked: boolean[] } = { list: null, asked: [] };
vi.mock('./useDashboardTrivia', () => ({
  useDashboardTrivia: (enabled: boolean) => {
    triviaState.asked.push(enabled);
    return enabled ? triviaState.list : null;
  },
}));
const viewport = { hasTabBar: false };
vi.mock('@/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useIsMobile')>()),
  useHasMobileTabBar: () => viewport.hasTabBar,
}));

vi.mock('./NetWorthHero', () => ({
  NetWorthHero: ({ config }: any) => (
    <div data-testid="net-worth-hero" data-range={config.range}>
      <ActiveProbe />
    </div>
  ),
}));
vi.mock('./PortfolioHero', () => ({
  PortfolioHero: ({ config }: any) => (
    <div data-testid="portfolio-hero" data-range={config.portfolioRange} data-metric={config.portfolioMetric}>
      <ActiveProbe />
    </div>
  ),
}));
vi.mock('./DashboardTrivia', () => ({
  DashboardTrivia: ({ topic, heroCycling }: any) => (
    <div data-testid="trivia" data-topic={topic} data-cycling={String(heroCycling)} />
  ),
}));

/** Hoisted: the module mocks above render it. */
function ActiveProbe() {
  return <span data-testid="active-probe">{String(useContext(HeroPanelActiveContext))}</span>;
}

function GreetingProbe() {
  return <span data-testid="greeting-collapses">{String(useContext(CollapsingTitleContext))}</span>;
}

const renderHero = (over: { hasInvestments?: boolean } = {}) =>
  render(
    <DashboardHero
      portfolioValuation={null}
      investmentAccounts={[]}
      hasInvestments={over.hasInvestments ?? true}
      isLoading={false}
      investmentSummaryLoading={false}
      header={<h1>Good evening, Ken</h1>}
    />,
  );

const track = () => screen.getByTestId('dashboard-hero-track');
const onPortfolio = () => track().style.transform === 'translateX(-100%)';
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

describe('DashboardHero', () => {
  beforeEach(() => {
    prefs.current = undefined;
    prefs.trivia = undefined;
    viewport.hasTabBar = false;
    triviaState.asked = [];
    triviaState.list = { items: [{ topic: 'netWorth', source: 'ai', text: 'x' }], figures: {}, generatedAt: '' };
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on net worth, holding the greeting above the track', () => {
    renderHero();
    expect(screen.getByTestId('net-worth-hero')).toHaveAttribute('data-range', '1y');
    const greeting = screen.getByRole('heading', { name: 'Good evening, Ken' });
    expect(track()).not.toContainElement(greeting);
    expect(onPortfolio()).toBe(false);
  });

  it('asks for the other set only once the first has settled and time has passed', async () => {
    renderHero();
    expect(screen.queryByTestId('portfolio-hero')).not.toBeInTheDocument();
    await advance(HERO_PRELOAD_MS);
    expect(screen.getByTestId('portfolio-hero')).toBeInTheDocument();
    expect(onPortfolio()).toBe(false);
  });

  it('slides to the other set every minute in Auto, and back', async () => {
    renderHero();
    await advance(HERO_CYCLE_MS);
    expect(onPortfolio()).toBe(true);
    expect(track().className).toContain('transition-transform');
    expect(track().className).toContain('motion-reduce:transition-none');
    await advance(HERO_CYCLE_MS);
    expect(onPortfolio()).toBe(false);
  });

  it('keeps the trivia on the set on screen', async () => {
    renderHero();
    expect(screen.getByTestId('trivia')).toHaveAttribute('data-topic', 'netWorth');
    expect(screen.getByTestId('trivia')).toHaveAttribute('data-cycling', 'true');
    await advance(HERO_CYCLE_MS);
    expect(screen.getByTestId('trivia')).toHaveAttribute('data-topic', 'investments');
  });

  it('drops the trivia line when it is switched off, keeping the hero', () => {
    prefs.trivia = false;
    renderHero();
    expect(screen.queryByTestId('trivia')).not.toBeInTheDocument();
    expect(screen.getByTestId('net-worth-hero')).toBeInTheDocument();
  });

  it('lets only the set on screen hand its headline to the app header', async () => {
    renderHero();
    await advance(HERO_PRELOAD_MS);
    const probeIn = (id: string) => within(screen.getByTestId(id)).getByTestId('active-probe');
    expect(probeIn('net-worth-hero')).toHaveTextContent('true');
    expect(probeIn('portfolio-hero')).toHaveTextContent('false');
    await advance(HERO_CYCLE_MS);
    expect(probeIn('net-worth-hero')).toHaveTextContent('false');
    expect(probeIn('portfolio-hero')).toHaveTextContent('true');
  });

  it('stops the greeting collapsing while the hero is on, the headline does instead', () => {
    render(
      <DashboardHero
        portfolioValuation={null}
        investmentAccounts={[]}
        hasInvestments
        isLoading={false}
        investmentSummaryLoading={false}
        header={<GreetingProbe />}
      />,
    );
    expect(screen.getByTestId('greeting-collapses')).toHaveTextContent('false');
  });

  it('leaves trivia off phones and tablets, and does not ask for it', () => {
    viewport.hasTabBar = true;
    renderHero();
    expect(screen.queryByTestId('trivia')).not.toBeInTheDocument();
    expect(triviaState.asked).not.toContain(true);
  });

  it('puts the trivia beside the greeting, off the track', () => {
    renderHero();
    const headRow = screen.getByRole('heading', { name: 'Good evening, Ken' }).closest(
      '[data-testid="dashboard-hero-root"] > div',
    );
    expect(headRow).toContainElement(screen.getByTestId('trivia'));
    expect(screen.getByTestId('dashboard-hero-track')).not.toContainElement(screen.getByTestId('trivia'));
  });

  it('offers no control to switch sets by hand', () => {
    renderHero();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows no trivia for an empty list', () => {
    triviaState.list = { items: [], figures: {}, generatedAt: '' };
    renderHero();
    expect(screen.queryByTestId('trivia')).not.toBeInTheDocument();
  });

  it('makes the set off screen inert', async () => {
    renderHero();
    await advance(HERO_PRELOAD_MS);
    const panelOf = (id: string) => screen.getByTestId(id).closest('[inert]');
    expect(panelOf('portfolio-hero')).not.toBeNull();
    expect(panelOf('net-worth-hero')).toBeNull();
  });

  it('does not advance in a hidden tab', async () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHero();
    await advance(HERO_CYCLE_MS);
    expect(onPortfolio()).toBe(false);
    hidden.mockRestore();
  });

  it('has nothing to cycle without investments', async () => {
    renderHero({ hasInvestments: false });
    await advance(HERO_CYCLE_MS);
    expect(screen.getByTestId('net-worth-hero')).toBeInTheDocument();
    expect(screen.queryByTestId('portfolio-hero')).not.toBeInTheDocument();
  });

  it('stays on a chosen set', async () => {
    prefs.current = { 'dashboard-hero': { set: 'portfolio', portfolioRange: 'ytd', portfolioMetric: 'cagr' } };
    renderHero();
    const hero = screen.getByTestId('portfolio-hero');
    expect(hero).toHaveAttribute('data-range', 'ytd');
    expect(hero).toHaveAttribute('data-metric', 'cagr');
    expect(screen.queryByTestId('net-worth-hero')).not.toBeInTheDocument();
    await advance(HERO_CYCLE_MS * 2);
    expect(onPortfolio()).toBe(true);
    expect(screen.queryByTestId('net-worth-hero')).not.toBeInTheDocument();
  });

  it('does not slide into place on the first paint of a chosen portfolio', () => {
    prefs.current = { 'dashboard-hero': { set: 'portfolio' } };
    renderHero();
    expect(track().className).not.toContain('transition-transform');
  });

  it('keeps only the greeting header when switched off, whichever set was chosen', () => {
    prefs.current = { 'dashboard-hero': { enabled: false, set: 'portfolio' } };
    renderHero();
    expect(screen.getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
    expect(screen.queryByTestId('portfolio-hero')).not.toBeInTheDocument();
    expect(screen.queryByTestId('net-worth-hero')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trivia')).not.toBeInTheDocument();
  });
});
