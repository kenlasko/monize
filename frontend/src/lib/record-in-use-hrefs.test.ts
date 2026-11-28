import { describe, it, expect } from 'vitest';
import { accountInUseHref } from './record-in-use-hrefs';

describe('accountInUseHref', () => {
  it('links Monte Carlo scenarios to the simulation report', () => {
    expect(accountInUseHref('a1', { kind: 'monteCarloScenarios', count: 1 })).toBe(
      '/reports/monte-carlo-simulation',
    );
  });

  it('links investment reports to the saved reports list', () => {
    expect(accountInUseHref('a1', { kind: 'investmentReports', count: 2 })).toBe('/reports');
  });

  it('leaves an unknown kind unlinked', () => {
    expect(accountInUseHref('a1', { kind: 'nothing', count: 1 })).toBeUndefined();
  });
});
