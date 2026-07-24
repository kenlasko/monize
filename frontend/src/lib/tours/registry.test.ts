import { describe, it, expect } from 'vitest';
import {
  ALL_TOURS,
  getReleaseTours,
  getTourById,
  toMinorLine,
  INTRO_TOUR,
} from './registry';
import enMessages from '@/i18n/messages/en/tours.json';

function getNested(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

describe('tour registry', () => {
  it('exposes the intro tour and both release tours', () => {
    expect(ALL_TOURS).toContain(INTRO_TOUR);
    expect(ALL_TOURS.length).toBeGreaterThanOrEqual(3);
  });

  it('looks up a tour by id', () => {
    expect(getTourById('intro/basics')).toBe(INTRO_TOUR);
    expect(getTourById('nope')).toBeUndefined();
  });

  it('has unique tour ids', () => {
    const ids = ALL_TOURS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique step ids within each tour', () => {
    for (const tour of ALL_TOURS) {
      const ids = tour.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  describe('toMinorLine', () => {
    it('truncates to major.minor', () => {
      expect(toMinorLine('1.13.2')).toBe('1.13');
      expect(toMinorLine('1.13.0-beta.1')).toBe('1.13');
      expect(toMinorLine('2.0')).toBe('2.0');
    });
  });

  describe('getReleaseTours', () => {
    it('matches release tours on the minor line, not the exact patch', () => {
      expect(getReleaseTours('1.13.0').map((t) => t.id)).toEqual([
        'release-1.13.0/accounts',
        'release-1.13.0/settings',
      ]);
      // Any patch on the same minor still matches.
      expect(getReleaseTours('1.13.7')).toHaveLength(2);
    });

    it('offers no release tours for other minor lines', () => {
      expect(getReleaseTours('1.12.1')).toHaveLength(0);
      expect(getReleaseTours('1.14.0')).toHaveLength(0);
    });
  });

  it('has an English title and body for every step of every tour', () => {
    for (const tour of ALL_TOURS) {
      expect(getNested(enMessages, `${tour.i18nPrefix}.title`)).toBeTruthy();
      for (const step of tour.steps) {
        const base = `${tour.i18nPrefix}.steps.${step.id}`;
        expect(getNested(enMessages, `${base}.title`)).toBeTruthy();
        expect(getNested(enMessages, `${base}.body`)).toBeTruthy();
      }
    }
  });
});
