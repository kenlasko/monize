import { describe, it, expect } from 'vitest';
import { nextDensity, type DensityLevel } from '@/hooks/useTableDensity';
import {
  BUILT_IN_VIEW_DEFAULTS,
  VIEW_DEFAULT_FIELDS,
  readViewDefault,
  readViewDefaults,
} from './view-defaults';
import { AI_LINKS, NAV_LINKS, TOOLS_LINKS } from './nav-links';

describe('the mobile tabs default', () => {
  it('reads known tabs once each, in order, within the limit', () => {
    expect(
      readViewDefault(
        { mobileTabs: ['bills', 'nope', 'bills', 'reports', 'taxes', 'tags'] },
        'mobileTabs',
      ),
    ).toEqual(['bills', 'reports', 'taxes']);
  });

  it('keeps an empty list, and reads anything but a list as no default', () => {
    expect(readViewDefault({ mobileTabs: [] }, 'mobileTabs')).toEqual([]);
    expect(readViewDefault({ mobileTabs: 'bills' }, 'mobileTabs')).toBeUndefined();
  });

  it('can name every link the bar could carry', () => {
    const links = [...NAV_LINKS, ...AI_LINKS, ...TOOLS_LINKS].map((l) => l.labelKey);
    expect([...VIEW_DEFAULT_FIELDS.mobileTabs.list].sort()).toEqual(
      ['dashboard', 'settings', ...links].sort(),
    );
  });
});

describe('readViewDefault', () => {
  it('reads every declared value of every key', () => {
    for (const [key, allowed] of Object.entries(VIEW_DEFAULT_FIELDS)) {
      // A list field holds several of its values; the others hold one.
      const values =
        allowed === 'boolean'
          ? [true, false]
          : 'list' in allowed
            ? allowed.list.map((item) => [item])
            : [...allowed];
      for (const value of values) {
        expect(readViewDefault({ [key]: value }, key as keyof typeof VIEW_DEFAULT_FIELDS)).toEqual(
          value,
        );
      }
    }
  });

  it.each([
    ['a missing map', undefined],
    ['a null map', null],
    ['an array', ['compact']],
    ['a string', 'compact'],
    ['an empty map', {}],
  ])('reads %s as no default', (_label, map) => {
    expect(readViewDefault(map, 'density')).toBeUndefined();
  });

  it('drops a value this client does not know rather than adopting it', () => {
    expect(readViewDefault({ density: 'gigantic' }, 'density')).toBeUndefined();
    expect(readViewDefault({ accountOpenTarget: 'investments' }, 'accountOpenTarget')).toBeUndefined();
  });

  it('drops a flag that is not a boolean, so a string never folds a panel', () => {
    expect(readViewDefault({ chartCollapsed: 'true' }, 'chartCollapsed')).toBeUndefined();
    expect(readViewDefault({ widgetsCollapsed: 1 }, 'widgetsCollapsed')).toBeUndefined();
  });

  it('reads only own keys, never one inherited from the prototype', () => {
    const map = Object.create({ density: 'dense' });
    expect(readViewDefault(map, 'density')).toBeUndefined();
  });
});

describe('readViewDefaults', () => {
  it('keeps the known entries and drops the rest', () => {
    expect(
      readViewDefaults({
        density: 'compact',
        chartCollapsed: true,
        hideRegisterYear: 'yes',
        rowHeight: 'tall',
      }),
    ).toEqual({ density: 'compact', chartCollapsed: true });
  });

  it('reads a malformed map as no defaults', () => {
    expect(readViewDefaults('compact')).toEqual({});
  });
});

describe('VIEW_DEFAULT_FIELDS', () => {
  it('offers every density level the toggle cycles through, so none is missing from Settings', () => {
    // The list is a literal the backend contract spec parses, so it cannot be
    // derived; the toggle's own cycle is the check that it is complete.
    const cycled: DensityLevel[] = [];
    let level: DensityLevel = 'normal';
    do {
      cycled.push(level);
      level = nextDensity(level);
    } while (level !== 'normal');

    expect([...VIEW_DEFAULT_FIELDS.density].sort()).toEqual([...cycled].sort());
  });
});

describe('BUILT_IN_VIEW_DEFAULTS', () => {
  it('holds a declared value for every key, so a fallback is always valid', () => {
    expect(readViewDefaults(BUILT_IN_VIEW_DEFAULTS)).toEqual(BUILT_IN_VIEW_DEFAULTS);
    expect(Object.keys(BUILT_IN_VIEW_DEFAULTS)).toEqual(Object.keys(VIEW_DEFAULT_FIELDS));
  });

  it('keeps today\'s behaviour for anyone who sets nothing', () => {
    expect(BUILT_IN_VIEW_DEFAULTS).toEqual({
      density: 'normal',
      hideRegisterYear: false,
      widgetsCollapsed: false,
      chartCollapsed: false,
      accountOpenTarget: 'register',
      mobileTabs: ['dashboard', 'transactions', 'accounts'],
    });
  });
});
