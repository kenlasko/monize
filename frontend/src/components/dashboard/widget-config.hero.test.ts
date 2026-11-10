import { describe, it, expect } from 'vitest';
import { DASHBOARD_HERO_DEFAULT, resolveDashboardHeroConfig } from './widget-config';

describe('resolveDashboardHeroConfig', () => {
  it('is the default for a reader who never set the hero', () => {
    expect(resolveDashboardHeroConfig(undefined)).toEqual(DASHBOARD_HERO_DEFAULT);
    expect(resolveDashboardHeroConfig(null)).toEqual(DASHBOARD_HERO_DEFAULT);
  });

  it('keeps every value the hero offers', () => {
    const stored = {
      enabled: false,
      set: 'portfolio',
      range: '10y',
      portfolioRange: '1d',
      portfolioAccountIds: ['a', 'b'],
      portfolioMetric: 'mwr',
    };
    expect(resolveDashboardHeroConfig(stored)).toEqual(stored);
  });

  it('opens on Auto, and keeps a set a reader already chose', () => {
    expect(DASHBOARD_HERO_DEFAULT.set).toBe('auto');
    expect(resolveDashboardHeroConfig({ set: 'auto' }).set).toBe('auto');
    expect(resolveDashboardHeroConfig({ set: 'netWorth' }).set).toBe('netWorth');
  });

  it('drops stale keys and falls back on any value no longer offered', () => {
    const resolved = resolveDashboardHeroConfig({
      greeting: false,
      set: 'budgets',
      range: '3m',
      portfolioRange: '6m',
      portfolioAccountIds: ['a', 7],
      portfolioMetric: 'valueChange',
      enabled: 'yes',
    });
    expect(resolved).toEqual({ ...DASHBOARD_HERO_DEFAULT, portfolioAccountIds: ['a'] });
    expect(resolved).not.toHaveProperty('greeting');
  });
});
