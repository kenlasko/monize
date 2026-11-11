import { describe, it, expect } from 'vitest';
import {
  GRID_HEIGHT_KEY,
  GRID_WIDTH_KEY,
  HEIGHT_CLASSES,
  HEIGHT_FLOORS_PX,
  WIDGET_HEIGHTS,
  WIDGET_WIDTHS,
  WIDTH_CLASSES,
  WIDTH_SPANS,
  defaultDashboardLayout,
  layoutReducer,
  layoutsEqual,
  resolveDashboardLayout,
  serializeDashboardLayout,
  widthsOfferedFor,
  type DashboardLayout,
  type WidgetConfigMap,
} from './dashboard-layout';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_WIDGET_IDS,
  type DashboardWidgetId,
} from './widget-registry';

const def = (id: DashboardWidgetId) => DASHBOARD_WIDGETS.find((w) => w.id === id)!;

// Frozen deeply so any write to an input throws in strict mode.
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const item = (id: DashboardWidgetId, width = 'half', height?: string) =>
  ({ id, width, height: height ?? def(id).defaultHeight }) as DashboardLayout[number];

describe('presets and class maps', () => {
  it('lists the presets narrowest and shortest first', () => {
    expect([...WIDGET_WIDTHS]).toEqual(['third', 'half', 'twoThirds', 'full']);
    expect([...WIDGET_HEIGHTS]).toEqual(['auto', 'compact', 'standard', 'tall']);
    expect(GRID_WIDTH_KEY).toBe('gridWidth');
    expect(GRID_HEIGHT_KEY).toBe('gridHeight');
  });

  it('maps every preset to a literal class', () => {
    expect(WIDTH_CLASSES).toEqual({
      third: 'lg:col-span-4',
      half: 'lg:col-span-6',
      twoThirds: 'lg:col-span-8',
      full: 'lg:col-span-12',
    });
    expect(HEIGHT_CLASSES).toEqual({
      auto: '',
      compact: 'lg:min-h-[390px]',
      standard: 'lg:min-h-[540px]',
      tall: 'lg:min-h-[720px]',
    });
  });

  it('keeps each class string in step with the number the resize grip uses', () => {
    expect(WIDTH_SPANS).toEqual({ third: 4, half: 6, twoThirds: 8, full: 12 });
    expect(HEIGHT_FLOORS_PX).toEqual({ auto: 0, compact: 390, standard: 540, tall: 720 });
    for (const w of WIDGET_WIDTHS) {
      expect(WIDTH_CLASSES[w]).toBe(`lg:col-span-${WIDTH_SPANS[w]}`);
    }
    for (const h of WIDGET_HEIGHTS) {
      expect(HEIGHT_CLASSES[h]).toBe(HEIGHT_FLOORS_PX[h] === 0 ? '' : `lg:min-h-[${HEIGHT_FLOORS_PX[h]}px]`);
    }
  });
});

describe('defaultDashboardLayout', () => {
  it('is the default widgets in registry order at their default sizes', () => {
    const layout = defaultDashboardLayout();
    expect(layout.map((i) => i.id)).toEqual(DEFAULT_DASHBOARD_WIDGET_IDS);
    for (const i of layout) {
      expect(i.width).toBe('half');
      expect(i.height).toBe(def(i.id).defaultHeight);
    }
  });
});

describe('widthsOfferedFor', () => {
  it('offers the minimum width and every wider preset', () => {
    expect(widthsOfferedFor('expenses-pie')).toEqual(['third', 'half', 'twoThirds', 'full']);
    expect(widthsOfferedFor('net-worth')).toEqual(['half', 'twoThirds', 'full']);
  });
});

describe('resolveDashboardLayout', () => {
  const sizeOf = (stored: unknown, id: DashboardWidgetId, key = 'gridWidth') =>
    resolveDashboardLayout([id], { [id]: { [key]: stored } })[0];

  // Truth table B.
  it('B: absent width resolves to half', () => {
    expect(resolveDashboardLayout(['expenses-pie'], {})[0].width).toBe('half');
    expect(resolveDashboardLayout(['net-worth'], {})[0].width).toBe('half');
  });

  it('B: third on a third-capable widget stays third', () => {
    expect(sizeOf('third', 'expenses-pie').width).toBe('third');
  });

  it('B: third on a half-minimum widget is raised to half', () => {
    expect(sizeOf('third', 'net-worth').width).toBe('half');
  });

  it('B: full stays full for any widget', () => {
    expect(sizeOf('full', 'expenses-pie').width).toBe('full');
    expect(sizeOf('full', 'net-worth').width).toBe('full');
  });

  it('B: a non-preset, number or null width resolves to half', () => {
    for (const bad of ['huge', 7, null, {}, ['full'], true]) {
      expect(sizeOf(bad, 'expenses-pie').width).toBe('half');
    }
  });

  it('B: height resolves the same way against defaultHeight, with no minimum', () => {
    expect(resolveDashboardLayout(['insights'], {})[0].height).toBe('compact');
    expect(sizeOf('tall', 'insights', 'gridHeight').height).toBe('tall');
    expect(sizeOf('auto', 'insights', 'gridHeight').height).toBe('auto');
    for (const bad of ['huge', 7, null]) {
      expect(sizeOf(bad, 'insights', 'gridHeight').height).toBe('compact');
    }
  });

  it('ignores a slice that is not an object', () => {
    const layout = resolveDashboardLayout(['insights'], { insights: 'oops' } as never);
    expect(layout[0]).toEqual({ id: 'insights', width: 'half', height: 'compact' });
  });

  it('keeps stored order and drops unknown ids', () => {
    const layout = resolveDashboardLayout(['insights', 'nope', 'net-worth'], {});
    expect(layout.map((i) => i.id)).toEqual(['insights', 'net-worth']);
  });

  it('gives the default layout for an empty, missing or all-unknown preference', () => {
    const expected = defaultDashboardLayout();
    expect(resolveDashboardLayout([], {})).toEqual(expected);
    expect(resolveDashboardLayout(null, null)).toEqual(expected);
    expect(resolveDashboardLayout(undefined, undefined)).toEqual(expected);
    expect(resolveDashboardLayout(['nope'], {})).toEqual(expected);
  });

  it('resolves a layout stored before this feature to default sizes for every widget', () => {
    const ids = DASHBOARD_WIDGETS.map((w) => w.id);
    const settings: WidgetConfigMap = {
      'net-worth': { range: '2y', barStyle: 'accountType' },
      'dashboard-hero': { enabled: true },
    };
    const layout = resolveDashboardLayout(ids, settings);
    expect(layout).toHaveLength(26);
    for (const i of layout) {
      expect(i.width).toBe('half');
      expect(i.height).toBe(def(i.id).defaultHeight);
    }
  });

  it('does not mutate its inputs', () => {
    const ids = deepFreeze(['net-worth', 'insights']);
    const cfg = deepFreeze({ 'net-worth': { gridWidth: 'full' } });
    expect(() => resolveDashboardLayout(ids, cfg)).not.toThrow();
  });
});

describe('serializeDashboardLayout', () => {
  const nonDefault = (id: DashboardWidgetId) =>
    ({ ...item(id), width: 'full' }) as DashboardLayout[number];

  // Truth table A.
  it('A row 1: default order, default sizes stores [] and no size keys', () => {
    const out = serializeDashboardLayout(defaultDashboardLayout(), {
      'net-worth': { range: '2y', gridWidth: 'full' },
    });
    expect(out.dashboardWidgets).toEqual([]);
    expect(out.dashboardWidgetConfig).toEqual({ 'net-worth': { range: '2y' } });
  });

  it('A row 2: default order, a non-default size stores [] and only the differing key', () => {
    const draft = defaultDashboardLayout().map((i) =>
      i.id === 'insights' ? { ...i, width: 'full' as const } : i,
    );
    const out = serializeDashboardLayout(draft, {});
    // [] keeps the reader following later default-layout changes (DASH-1);
    // the size is read back from the settings map with the default ids.
    expect(out.dashboardWidgets).toEqual([]);
    expect(out.dashboardWidgetConfig).toEqual({ insights: { gridWidth: 'full' } });
    expect(resolveDashboardLayout(out.dashboardWidgets, out.dashboardWidgetConfig)).toEqual(draft);
  });

  it('A row 3: different order, default sizes stores the ids and no size keys', () => {
    const draft = [...defaultDashboardLayout()].reverse();
    const out = serializeDashboardLayout(draft, {});
    expect(out.dashboardWidgets).toEqual([...DEFAULT_DASHBOARD_WIDGET_IDS].reverse());
    expect(out.dashboardWidgetConfig).toEqual({});
  });

  it('A row 4: different order, a non-default size stores the ids and the differing keys', () => {
    const draft = [item('insights', 'third'), item('net-worth', 'half', 'tall')];
    const out = serializeDashboardLayout(draft, {});
    expect(out.dashboardWidgets).toEqual(['insights', 'net-worth']);
    expect(out.dashboardWidgetConfig).toEqual({
      insights: { gridWidth: 'third' },
      'net-worth': { gridHeight: 'tall' },
    });
  });

  it('A row 5: an empty draft stores an empty list (Done is disabled by the caller)', () => {
    const out = serializeDashboardLayout([], { insights: { gridWidth: 'full', foo: 1 } });
    expect(out.dashboardWidgets).toEqual([]);
    expect(out.dashboardWidgetConfig).toEqual({ insights: { foo: 1 } });
  });

  it('stores a size key only when it differs from the widget default', () => {
    const out = serializeDashboardLayout(
      [item('insights', 'half', 'compact'), item('net-worth', 'half', 'tall')],
      { insights: { gridWidth: 'full', gridHeight: 'tall' } },
    );
    expect(out.dashboardWidgetConfig).toEqual({ 'net-worth': { gridHeight: 'tall' } });
  });

  it('a removed widget loses only its size keys', () => {
    const out = serializeDashboardLayout([item('insights')], {
      'net-worth': { range: '2y', gridWidth: 'full', gridHeight: 'tall' },
      insights: { gridWidth: 'full' },
    });
    expect(out.dashboardWidgetConfig['net-worth']).toEqual({ range: '2y' });
  });

  it('an emptied slice is omitted', () => {
    const out = serializeDashboardLayout([item('insights')], {
      'net-worth': { gridWidth: 'full', gridHeight: 'tall' },
    });
    expect(out.dashboardWidgetConfig).toEqual({});
  });

  it('passes through other keys, unknown slices and the hero slice untouched', () => {
    const hero = { enabled: true, set: 'auto', portfolioAccountIds: ['a', 'b'] };
    const before = deepFreeze({
      'dashboard-hero': hero,
      'future-widget': { gridWidth: 'full', x: 1 },
      insights: { limit: 5, gridWidth: 'third' },
    });
    const out = serializeDashboardLayout([nonDefault('insights')], before);
    expect(out.dashboardWidgetConfig['dashboard-hero']).toBe(hero);
    expect(out.dashboardWidgetConfig['future-widget']).toEqual({ gridWidth: 'full', x: 1 });
    expect(out.dashboardWidgetConfig.insights).toEqual({ limit: 5, gridWidth: 'full' });
  });

  it('does not mutate the draft or the settings it was given', () => {
    const draft = deepFreeze([nonDefault('insights'), item('net-worth')]);
    const before = deepFreeze({ insights: { gridHeight: 'tall' }, 'net-worth': { gridWidth: 'full' } });
    const snapshot = structuredClone(before);
    serializeDashboardLayout(draft, before);
    expect(before).toEqual(snapshot);
  });

  it('treats missing settings as an empty map', () => {
    expect(serializeDashboardLayout([item('insights')], null).dashboardWidgetConfig).toEqual({});
  });

  it('round-trips through resolveDashboardLayout', () => {
    const draft: DashboardLayout = [
      item('net-worth', 'full', 'tall'),
      item('expenses-pie', 'third'),
      item('insights', 'twoThirds', 'auto'),
    ];
    const out = serializeDashboardLayout(draft, {});
    expect(
      resolveDashboardLayout(out.dashboardWidgets, out.dashboardWidgetConfig),
    ).toEqual(draft);
  });

  // Port of backend/src/users/validators/is-dashboard-widget-config.validator.ts.
  function passesServerBounds(value: unknown): boolean {
    const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
    const primitive = (v: unknown) =>
      (typeof v === 'string' && v.length <= 100) ||
      typeof v === 'number' ||
      typeof v === 'boolean';
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const ids = Object.keys(value);
    if (ids.length > 50) return false;
    for (const id of ids) {
      if (dangerous.has(id) || !/^[a-z0-9-]+$/.test(id) || id.length > 100) return false;
      const slice = (value as Record<string, unknown>)[id];
      if (slice === null) continue;
      if (typeof slice !== 'object' || Array.isArray(slice)) return false;
      const keys = Object.keys(slice);
      if (keys.length > 20) return false;
      for (const key of keys) {
        if (dangerous.has(key) || key.length > 100) return false;
        const v = (slice as Record<string, unknown>)[key];
        if (v === null || v === undefined) continue;
        if (Array.isArray(v)) {
          if (v.length > 200 || !v.every(primitive)) return false;
        } else if (!primitive(v)) return false;
      }
    }
    return true;
  }

  it('the port rejects what the server rejects', () => {
    expect(passesServerBounds({ 'Bad Id': {} })).toBe(false);
    expect(passesServerBounds({ a: { k: { nested: 1 } } })).toBe(false);
    expect(passesServerBounds({ a: { k: 'x'.repeat(101) } })).toBe(false);
  });

  it('output for a full 26-widget layout with non-default sizes passes the server bounds', () => {
    const draft = DASHBOARD_WIDGETS.map((w, i) => ({
      id: w.id,
      width: WIDGET_WIDTHS[(i + 2) % 4],
      height: WIDGET_HEIGHTS[(i + 1) % 4],
    })) as DashboardLayout;
    const before: WidgetConfigMap = {
      'dashboard-hero': { enabled: true, set: 'auto', portfolioAccountIds: ['a', 'b'] },
      'net-worth': { range: '2y', barStyle: 'accountType' },
      'expenses-pie': { accountIds: ['x'], topLevelOnly: false },
    };
    const out = serializeDashboardLayout(draft, before);
    expect(out.dashboardWidgets).toHaveLength(26);
    expect(Object.keys(out.dashboardWidgetConfig).length).toBeLessThanOrEqual(50);
    expect(passesServerBounds(out.dashboardWidgetConfig)).toBe(true);
    expect(out.dashboardWidgetConfig['net-worth']).toMatchObject({ range: '2y' });
  });
});

describe('layoutsEqual', () => {
  it('compares ids, order and both sizes', () => {
    const a = defaultDashboardLayout();
    expect(layoutsEqual(a, defaultDashboardLayout())).toBe(true);
    expect(layoutsEqual(a, a.slice(1))).toBe(false);
    expect(layoutsEqual(a, [...a].reverse())).toBe(false);
    expect(layoutsEqual(a, a.map((i, n) => (n === 0 ? { ...i, width: 'full' } : i)))).toBe(false);
    expect(layoutsEqual(a, a.map((i, n) => (n === 0 ? { ...i, height: 'tall' } : i)))).toBe(false);
  });
});

describe('layoutReducer', () => {
  const base = (): DashboardLayout =>
    deepFreeze([item('net-worth', 'full'), item('insights'), item('expenses-pie', 'third')]);

  it('add appends an unlisted widget at its default size', () => {
    const state = base();
    const next = layoutReducer(state, { type: 'add', id: 'trivia' });
    expect(next.map((i) => i.id)).toEqual(['net-worth', 'insights', 'expenses-pie', 'trivia']);
    expect(next[3]).toEqual({ id: 'trivia', width: 'half', height: 'compact' });
    expect(state).toHaveLength(3);
  });

  it('add of a present or unknown id is a no-op', () => {
    const state = base();
    expect(layoutReducer(state, { type: 'add', id: 'insights' })).toBe(state);
    expect(layoutReducer(state, { type: 'add', id: 'nope' as DashboardWidgetId })).toBe(state);
  });

  it('remove drops the widget; an absent one is a no-op', () => {
    const state = base();
    expect(layoutReducer(state, { type: 'remove', id: 'insights' }).map((i) => i.id)).toEqual([
      'net-worth',
      'expenses-pie',
    ]);
    expect(layoutReducer(state, { type: 'remove', id: 'trivia' })).toBe(state);
  });

  it('move puts the widget at the target index', () => {
    const state = base();
    expect(layoutReducer(state, { type: 'move', from: 0, to: 2 }).map((i) => i.id)).toEqual([
      'insights',
      'expenses-pie',
      'net-worth',
    ]);
    expect(layoutReducer(state, { type: 'move', from: 2, to: 0 }).map((i) => i.id)).toEqual([
      'expenses-pie',
      'net-worth',
      'insights',
    ]);
  });

  it('an out-of-range or same-place move returns the same reference', () => {
    const state = base();
    for (const [from, to] of [[-1, 0], [0, 3], [3, 0], [0, -1], [1, 1], [0.5, 1]]) {
      expect(layoutReducer(state, { type: 'move', from, to })).toBe(state);
    }
  });

  it('resize changes width and height, together or alone', () => {
    const state = base();
    const next = layoutReducer(state, { type: 'resize', id: 'insights', width: 'twoThirds', height: 'tall' });
    expect(next[1]).toEqual({ id: 'insights', width: 'twoThirds', height: 'tall' });
    expect(layoutReducer(state, { type: 'resize', id: 'insights', height: 'auto' })[1]).toEqual({
      id: 'insights',
      width: 'half',
      height: 'auto',
    });
    expect(layoutReducer(state, { type: 'resize', id: 'insights', width: 'third' })[1].width).toBe('third');
  });

  it('resize below minWidth is refused with the same reference', () => {
    const state = base();
    const refused = layoutReducer(state, { type: 'resize', id: 'net-worth', width: 'third', height: 'tall' });
    expect(refused).toBe(state);
  });

  it('a resize that changes nothing, or names an absent widget, returns the same reference', () => {
    const state = base();
    expect(layoutReducer(state, { type: 'resize', id: 'insights', width: 'half' })).toBe(state);
    expect(layoutReducer(state, { type: 'resize', id: 'trivia', width: 'full' })).toBe(state);
  });

  it('reset returns the default layout', () => {
    const state = base();
    expect(layoutReducer(state, { type: 'reset' })).toEqual(defaultDashboardLayout());
  });
});
