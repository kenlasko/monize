'use client';

import type { ReactNode } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { PortfolioValuation } from '@/types/investment';
import type { Account } from '@/types/account';
import { DASHBOARD_HERO_WIDGET_ID, resolveDashboardHeroConfig } from './widget-config';
import { NetWorthHero } from './NetWorthHero';
import { PortfolioHero } from './PortfolioHero';

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
   * The page header (greeting, date, Customize gear). The hero draws it at the
   * top of its figures column so the chart can rise beside it; whenever the
   * hero shows nothing of its own (switched off, no data) it renders the
   * header alone, so the page never loses its heading.
   */
  header: ReactNode;
}

/**
 * The dashboard's opening figures, in the set chosen in Customize Dashboard:
 * net worth (`NetWorthHero`) or the portfolio (`PortfolioHero`). Switched off,
 * the page keeps its greeting and date and asks for nothing.
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

  if (!config.enabled) return <>{header}</>;
  if (config.set === 'portfolio') {
    return (
      <PortfolioHero
        config={config}
        header={header}
        investmentAccounts={investmentAccounts}
        hasInvestments={hasInvestments}
        isLoading={isLoading}
      />
    );
  }
  return (
    <NetWorthHero
      config={config}
      header={header}
      portfolioValuation={portfolioValuation}
      hasInvestments={hasInvestments}
      isLoading={isLoading}
      investmentSummaryLoading={investmentSummaryLoading}
    />
  );
}
