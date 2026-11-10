'use client';

import type { CSSProperties, ReactNode } from 'react';
import { CollapsingTitleContext } from '@/hooks/useCollapsingHeaderTitle';
import { useHasMobileTabBar } from '@/hooks/useIsMobile';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { PortfolioValuation } from '@/types/investment';
import type { Account } from '@/types/account';
import { DASHBOARD_HERO_WIDGET_ID, resolveDashboardHeroConfig } from './widget-config';
import { DashboardTrivia } from './DashboardTrivia';
import { HeroFiguresRefContext, HeroPanelActiveContext } from './hero-parts';
import { NetWorthHero } from './NetWorthHero';
import { PortfolioHero } from './PortfolioHero';
import { useDashboardTrivia } from './useDashboardTrivia';
import { useElementSize } from './useElementSize';
import { useHeroCycle } from './useHeroCycle';

interface DashboardHeroProps {
  /** The dashboard's portfolio valuation; `null` until loaded or when it failed. */
  portfolioValuation: PortfolioValuation | null;
  hasInvestments: boolean;
  /** The dashboard's own first load, before which no figure is known. */
  isLoading: boolean;
  /**
   * Whether the portfolio valuation behind the net worth set's "invested"
   * figure is still loading, separately from `isLoading`: it fetches after the
   * rest of the dashboard's first load so it never blocks it. `NetWorthHero`
   * holds a placeholder in that one figure's place meanwhile.
   */
  investmentSummaryLoading: boolean;
  /** The investment accounts the portfolio set can cover. */
  investmentAccounts: Account[];
  /**
   * The page header (greeting, date, Customize gear). Drawn once, above the
   * track, so it stays still while the sets slide under it; switched off, the
   * hero renders the header alone, so the page never loses its heading.
   */
  header: ReactNode;
}

/** The least room the trivia gets beside the greeting: 16rem and the row's gap. */
const TRIVIA_MIN_SPACE = '17rem';

const TRIVIA_TOPIC = { netWorth: 'netWorth', portfolio: 'investments' } as const;

/**
 * The dashboard's opening figures, in the set chosen in Customize Dashboard:
 * net worth (`NetWorthHero`), the portfolio (`PortfolioHero`), or Auto, which
 * alternates between them. Both sit side by side on a track, and the one not
 * showing is inert. Switched off, the page keeps its greeting and date and
 * asks for nothing.
 */
export function DashboardHero({
  portfolioValuation,
  hasInvestments,
  isLoading,
  investmentSummaryLoading,
  investmentAccounts,
  header,
}: DashboardHeroProps) {
  const stored = usePreferencesStore((s) => s.preferences?.dashboardWidgetConfig?.[DASHBOARD_HERO_WIDGET_ID]);
  const config = resolveDashboardHeroConfig(stored);
  const triviaOn = usePreferencesStore((s) => s.preferences?.aiTriviaEnabled) !== false;
  // Only with the desktop layout: below it there is no room beside the chart.
  const wideEnough = !useHasMobileTabBar();
  const trivia = useDashboardTrivia(config.enabled && triviaOn && wideEnough);
  const showTrivia = (trivia?.items.length ?? 0) > 0;
  const [headRef, head] = useElementSize<HTMLDivElement>();
  const [greetingRef, greeting] = useElementSize<HTMLDivElement>();
  const [figuresRef, figures] = useElementSize<HTMLDivElement>();
  const { sets, active, cycling, mounted, animate } = useHeroCycle({
    choice: config.set,
    hasInvestments,
    settled: !isLoading && !investmentSummaryLoading,
  });

  if (!config.enabled) return <>{header}</>;

  const activeIndex = sets.indexOf(active);

  return (
    <div
      className="mb-6"
      data-testid="dashboard-hero-root"
      style={
        {
          '--hero-head-h': `${head.height}px`,
          '--hero-figures-min': showTrivia ? `calc(${greeting.width}px + ${TRIVIA_MIN_SPACE})` : `${greeting.width}px`,
          ...(figures.width > 0 ? { '--hero-figures-w': `${figures.width}px` } : {}),
        } as CSSProperties
      }
    >
      {/* As wide as the figures under it, so the trivia ends where the chart begins. */}
      <div ref={headRef} className="flex items-start gap-4 lg:w-[var(--hero-figures-w,auto)]">
        {/* Beside the figures the headline is what collapses into the app
            header, so the greeting does not. */}
        <div ref={greetingRef} className="min-w-0 flex-none">
          <CollapsingTitleContext.Provider value={false}>{header}</CollapsingTitleContext.Provider>
        </div>
        {/* The space beside the greeting, above the figures. */}
        {/* Out of the flow, so the row keeps the greeting's height whatever it holds. */}
        {trivia && showTrivia && (
          <div className="relative min-w-0 flex-1 self-stretch">
            <div className="absolute inset-x-0 top-1">
              <DashboardTrivia trivia={trivia} topic={TRIVIA_TOPIC[active]} heroCycling={cycling} />
            </div>
          </div>
        )}
      </div>
      {/* Clipped sideways only: a clip on both axes would cut off the figures'
          popovers below the track. */}
      <div className="overflow-x-clip">
        <div
          data-testid="dashboard-hero-track"
          className={`flex ${animate ? 'transition-transform duration-500 ease-in-out motion-reduce:transition-none' : ''}`}
          style={{ transform: `translateX(-${activeIndex * 100}%)` }}
        >
          {sets.map((set) => (
            <div key={set} className="w-full min-w-0 flex-shrink-0" inert={set !== active}>
              <HeroPanelActiveContext.Provider value={set === active}>
                <HeroFiguresRefContext.Provider value={set === active ? figuresRef : null}>
                  {mounted.has(set) &&
                    (set === 'portfolio' ? (
                      <PortfolioHero
                        config={config}
                        investmentAccounts={investmentAccounts}
                        hasInvestments={hasInvestments}
                        isLoading={isLoading}
                      />
                    ) : (
                      <NetWorthHero
                        config={config}
                        portfolioValuation={portfolioValuation}
                        hasInvestments={hasInvestments}
                        isLoading={isLoading}
                        investmentSummaryLoading={investmentSummaryLoading}
                      />
                    ))}
                </HeroFiguresRefContext.Provider>
              </HeroPanelActiveContext.Provider>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
