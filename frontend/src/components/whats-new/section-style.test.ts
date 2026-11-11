import { describe, it, expect } from 'vitest';
import {
  CurrencyDollarIcon,
  SparklesIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { countChanges, sectionStyle } from './section-style';

describe('sectionStyle', () => {
  it.each([
    'Fixes',
    'Bug Fixes',
    'Everyday fixes',
    'For operators',
    'Under the Hood',
    'Tests & quality',
    'Credit',
    "What's Changed",
  ])('files "%s" with the maintenance sections', (heading) => {
    expect(sectionStyle(heading).maintenance).toBe(true);
  });

  it.each(['Crypto', 'Dashboard', 'Reports', 'Credit cards', 'Help inside the app'])(
    'treats "%s" as a feature',
    (heading) => {
      expect(sectionStyle(heading).maintenance).toBe(false);
    },
  );

  it('checks maintenance before feature keywords', () => {
    // "currency" would otherwise make this a Crypto-style feature.
    expect(sectionStyle('Currency fixes').Icon).toBe(WrenchScrewdriverIcon);
  });

  it('picks an area icon by keyword', () => {
    expect(sectionStyle('Crypto').Icon).toBe(CurrencyDollarIcon);
  });

  it('gives an unknown heading the neutral feature style', () => {
    expect(sectionStyle('Something brand new')).toMatchObject({
      Icon: SparklesIcon,
      maintenance: false,
    });
  });
});

describe('countChanges', () => {
  it('counts top-level bullets of any marker plus subsections', () => {
    expect(
      countChanges({
        heading: 'X',
        body: '- one\n* two\n+ three\n  - nested\nProse line.',
        children: [{ heading: 'Sub', body: '', children: [] }],
      }),
    ).toBe(4);
  });

  it('is zero for a prose-only section', () => {
    expect(countChanges({ heading: 'X', body: 'Just prose.', children: [] })).toBe(0);
  });
});
