import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import type { TriviaFigure } from '@/types/dashboard-trivia';
import { useTriviaFigureFormat } from './trivia-format';

function format(figure: TriviaFigure): string {
  const { result } = renderHook(() => useTriviaFigureFormat());
  return result.current(figure);
}

describe('useTriviaFigureFormat', () => {
  it('formats each existing kind', () => {
    expect(format({ kind: 'money', value: 1234.5, currency: 'CAD' })).toMatch(/1,234\.50/);
    expect(format({ kind: 'percent', value: 12.5 })).toBe('12.50%');
    expect(format({ kind: 'multiple', value: 2.03 })).toBe('2.03');
    expect(format({ kind: 'rate', value: 1.4066 })).toBe('1.4066');
    expect(format({ kind: 'count', value: 1200 })).toBe('1,200');
    expect(format({ kind: 'month', value: '2026-09' })).toBe('September 2026');
    expect(format({ kind: 'text', value: 'XGRO' })).toBe('XGRO');
  });

  it('formats a date in full and a day with its weekday', () => {
    expect(format({ kind: 'date', value: '2023-11-17' })).toBe('November 17, 2023');
    expect(format({ kind: 'day', value: '2026-11-18' })).toBe('Wednesday, November 18');
  });

  it('gives days and years their unit, singular at one', () => {
    expect(format({ kind: 'days', value: 1 })).toBe('1 day');
    expect(format({ kind: 'days', value: 3 })).toBe('3 days');
    expect(format({ kind: 'years', value: 1 })).toBe('1 year');
    expect(format({ kind: 'years', value: 3 })).toBe('3 years');
  });

  it('shows the raw value of a kind it does not know', () => {
    expect(format({ kind: 'ordinal', value: 7 } as unknown as TriviaFigure)).toBe('7');
  });
});
