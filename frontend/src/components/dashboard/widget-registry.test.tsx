import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_WIDGET_IDS,
  delegateDashboardWidgets,
  resolveDashboardWidgets,
} from './widget-registry';

describe('widget-registry', () => {
  it('default layout matches the pre-customization dashboard', () => {
    expect(DEFAULT_DASHBOARD_WIDGET_IDS).toEqual([
      'favourite-accounts',
      'upcoming-bills',
      'top-movers',
      'favourite-securities',
      'net-worth',
      'assets-liabilities',
      'expenses-pie',
      'income-expenses',
      'budget-status',
      'insights',
    ]);
  });

  it('favourite-reports is registered but not part of the default layout', () => {
    const def = DASHBOARD_WIDGETS.find((w) => w.id === 'favourite-reports');
    expect(def).toBeDefined();
    expect(def!.defaultEnabled).toBe(false);
  });

  describe('resolveDashboardWidgets', () => {
    it('returns the default layout for an empty or missing preference', () => {
      expect(resolveDashboardWidgets(undefined).map((w) => w.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGET_IDS,
      );
      expect(resolveDashboardWidgets(null).map((w) => w.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGET_IDS,
      );
      expect(resolveDashboardWidgets([]).map((w) => w.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGET_IDS,
      );
    });

    it('returns the stored widgets in stored order', () => {
      const resolved = resolveDashboardWidgets(['insights', 'favourite-reports', 'net-worth']);
      expect(resolved.map((w) => w.id)).toEqual(['insights', 'favourite-reports', 'net-worth']);
    });

    it('drops unknown ids and falls back to the default when none survive', () => {
      expect(
        resolveDashboardWidgets(['unknown-widget', 'net-worth']).map((w) => w.id),
      ).toEqual(['net-worth']);
      expect(resolveDashboardWidgets(['unknown-widget']).map((w) => w.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGET_IDS,
      );
    });
  });

  describe('delegateDashboardWidgets', () => {
    const grants = (bills: boolean) => ({
      bills,
      investments: false,
      budgets: false,
      reports: false,
      ai: false,
    });

    it('shows only Favourite Accounts without the bills grant', () => {
      expect(delegateDashboardWidgets(null).map((w) => w.id)).toEqual(['favourite-accounts']);
      expect(delegateDashboardWidgets(grants(false)).map((w) => w.id)).toEqual([
        'favourite-accounts',
      ]);
    });

    it('adds Upcoming Bills with the bills grant', () => {
      expect(delegateDashboardWidgets(grants(true)).map((w) => w.id)).toEqual([
        'favourite-accounts',
        'upcoming-bills',
      ]);
    });
  });

  it('gates the securities widgets on data, not the rest', () => {
    const ctx = { isLoading: false, hasSecurities: false } as Parameters<
      NonNullable<(typeof DASHBOARD_WIDGETS)[number]['shouldRender']>
    >[0];
    for (const w of DASHBOARD_WIDGETS) {
      const rendered = !w.shouldRender || w.shouldRender(ctx);
      if (w.id === 'top-movers' || w.id === 'favourite-securities') {
        expect(rendered).toBe(false);
        expect(w.shouldRender!({ ...ctx, isLoading: true })).toBe(true);
        expect(w.shouldRender!({ ...ctx, hasSecurities: true })).toBe(true);
      } else {
        expect(rendered).toBe(true);
      }
    }
  });
});
