import { describe, it, expect } from 'vitest';
import { benchmarkLabel, issuerLabel, programLabel, rateRuleLines } from './bond-labels';
import type { BondRateRule } from '@/types/bond';

const translator = (messages: Record<string, string>) => {
  const t = ((key: string) => messages[key]) as ((key: string) => string) & {
    has: (key: string) => boolean;
  };
  t.has = (key: string) => key in messages;
  return t;
};

describe('bond labels', () => {
  const t = translator({
    'bond.benchmarks.PL_CPI_GUS_YOY': 'CPI',
    'bond.issuers.PL_MF': 'Ministry of Finance (PL)',
    'bond.programs.EDO': '10-year indexed bonds',
  });

  it('uses the translated name where the catalog has one', () => {
    expect(benchmarkLabel(t, 'PL_CPI_GUS_YOY')).toBe('CPI');
    expect(issuerLabel(t, 'PL_MF')).toBe('Ministry of Finance (PL)');
    expect(programLabel(t, 'EDO')).toBe('10-year indexed bonds');
  });

  it('falls back to the code, never to an empty string', () => {
    expect(issuerLabel(t, 'XX_NEW')).toBe('XX_NEW');
    expect(programLabel(t, 'NEW')).toBe('NEW');
  });
});

describe('rateRuleLines', () => {
  const t = Object.assign(
    ((key: string, values?: Record<string, string | number>) =>
      `${key}${values ? JSON.stringify(values) : ''}`) as never,
    { has: (key: string) => key === 'bond.benchmarks.CPI' },
  ) as Parameters<typeof rateRuleLines>[0];
  const pct = (fraction: string) => `pct(${fraction})`;
  const rule = (over: Partial<BondRateRule>): BondRateRule => ({
    type: 'BENCHMARK_PLUS_SPREAD',
    benchmarkId: 'CPI',
    annualRate: null,
    firstPeriodRate: null,
    addend: '0.0200',
    benchmarkFloor: null,
    ...over,
  });

  it('says a discount bond\'s rule as a discount, whatever else the rule carries', () => {
    expect(
      rateRuleLines(t, rule({ type: 'ZERO_COUPON_DISCOUNT', benchmarkId: null, addend: null }), pct),
    ).toEqual(['bond.rate.rule.discount']);
  });

  it('says a fixed rule as one sentence, and nothing for a fixed rule with no rate', () => {
    expect(rateRuleLines(t, rule({ type: 'FIXED', benchmarkId: null, annualRate: '0.0500', addend: null }), pct)).toEqual([
      'bond.rate.rule.fixed{"rate":"pct(0.0500)"}',
    ]);
    expect(rateRuleLines(t, rule({ type: 'FIXED', benchmarkId: null, annualRate: null, addend: null }), pct)).toEqual([]);
  });

  it('says a floating rule as a daily sentence with the floor and the lockout', () => {
    expect(
      rateRuleLines(
        t,
        rule({
          type: 'DAILY_INDEX_PLUS_SPREAD',
          addend: '0.00103',
          benchmarkFloor: '0',
          lockoutBusinessDays: 2,
        }),
        pct,
      ),
    ).toEqual([
      'bond.rate.rule.daily{"benchmark":"bond.benchmarks.CPI","addend":"pct(0.00103)"}',
      'bond.rate.rule.floorZero{"benchmark":"bond.benchmarks.CPI"}',
      'bond.rate.rule.lockout{"days":2}',
    ]);
  });

  it('names the first period and then the benchmark plus the margin', () => {
    expect(rateRuleLines(t, rule({ firstPeriodRate: '0.0560' }), pct)).toEqual([
      'bond.rate.rule.firstThen{"firstRate":"pct(0.0560)","benchmark":"bond.benchmarks.CPI","addend":"pct(0.0200)"}',
    ]);
  });

  it('says every period when there is no first-period rate, and adds the zero floor', () => {
    expect(rateRuleLines(t, rule({ benchmarkFloor: '0.0000' }), pct)).toEqual([
      'bond.rate.rule.every{"benchmark":"bond.benchmarks.CPI","addend":"pct(0.0200)"}',
      'bond.rate.rule.floorZero{"benchmark":"bond.benchmarks.CPI"}',
    ]);
  });

  it('says nothing for a rule that lacks its benchmark or margin', () => {
    expect(rateRuleLines(t, rule({ benchmarkId: null }), pct)).toEqual([]);
    expect(rateRuleLines(t, rule({ addend: null }), pct)).toEqual([]);
  });
});
