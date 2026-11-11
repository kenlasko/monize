import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_WIDGET_IDS,
  delegateDashboardWidgets,
  resolveDashboardWidgets,
} from './widget-registry';
import { WIDGET_HEIGHTS } from './dashboard-layout';

describe('widget-registry', () => {
  it('default layout matches the pre-customization dashboard', () => {
    expect(DEFAULT_DASHBOARD_WIDGET_IDS).toEqual([
      'favourite-accounts',
      'upcoming-bills',
      'top-movers',
      'portfolio-value',
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

  it('registers the warranties widget as opt-in, visible to a delegate only with the section', () => {
    const def = DASHBOARD_WIDGETS.find((w) => w.id === 'warranties-expiring');
    expect(def).toBeDefined();
    expect(def!.defaultEnabled).toBe(false);
    expect(def!.delegateVisible).toBeDefined();
    expect(def!.delegateVisible!(null)).toBe(false);
  });

  it('registers the cash flow forecast right after Upcoming Bills, and not for delegates', () => {
    const ids = DASHBOARD_WIDGETS.map((w) => w.id);
    expect(ids.indexOf('cash-flow-forecast')).toBe(ids.indexOf('upcoming-bills') + 1);
    const def = DASHBOARD_WIDGETS.find((w) => w.id === 'cash-flow-forecast')!;
    expect(def.delegateVisible).toBeUndefined();
  });

  it('every widget declares a valid minWidth and defaultHeight', () => {
    expect(DASHBOARD_WIDGETS).toHaveLength(26);
    for (const w of DASHBOARD_WIDGETS) {
      expect(['third', 'half'], w.id).toContain(w.minWidth);
      expect([...WIDGET_HEIGHTS], w.id).toContain(w.defaultHeight);
    }
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
    const grants = (bills: boolean, warranties = false) => ({
      bills,
      investments: false,
      budgets: false,
      reports: false,
      ai: false,
      warranties,
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

    it('adds Warranties Expiring with the warranties grant', () => {
      expect(delegateDashboardWidgets(grants(false, true)).map((w) => w.id)).toEqual([
        'favourite-accounts',
        'warranties-expiring',
      ]);
    });
  });

  it('gates the securities widgets on data, not the rest', () => {
    const ctx = { isLoading: false, hasSecurities: false, hasInvestments: false } as Parameters<
      NonNullable<(typeof DASHBOARD_WIDGETS)[number]['shouldRender']>
    >[0];
    // Investment chart widgets are hidden until the user has investments.
    const investmentGated = new Set([
      'portfolio-value',
      'sector-weightings',
      'security-type-allocation',
      'geographic-allocation',
    ]);
    for (const w of DASHBOARD_WIDGETS) {
      const rendered = !w.shouldRender || w.shouldRender(ctx);
      if (w.id === 'top-movers' || w.id === 'favourite-securities') {
        expect(rendered).toBe(false);
        expect(w.shouldRender!({ ...ctx, isLoading: true })).toBe(true);
        expect(w.shouldRender!({ ...ctx, hasSecurities: true })).toBe(true);
      } else if (investmentGated.has(w.id)) {
        expect(rendered).toBe(false);
        expect(w.shouldRender!({ ...ctx, isLoading: true })).toBe(true);
        expect(w.shouldRender!({ ...ctx, hasInvestments: true })).toBe(true);
      } else {
        expect(rendered).toBe(true);
      }
    }
  });

  it('registers all report-derived widgets as opt-in (not in the default layout)', () => {
    const reportWidgetIds = [
      'spending-by-payee',
      'monthly-spending-trend',
      'income-by-source',
      'credit-utilization-accounts',
      'credit-utilization-total',
      'sector-weightings',
      'security-type-allocation',
      'geographic-allocation',
      'recurring-expenses',
      'weekend-weekday',
      'cash-flow-sankey',
      'cash-flow-forecast',
    ];
    for (const id of reportWidgetIds) {
      const def = DASHBOARD_WIDGETS.find((w) => w.id === id);
      expect(def, `widget ${id} should be registered`).toBeDefined();
      expect(def!.defaultEnabled).toBe(false);
      expect(DEFAULT_DASHBOARD_WIDGET_IDS).not.toContain(id);
    }
  });
});
