import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDateFormat } from './useDateFormat';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { dateFormat: 'YYYY-MM-DD' } })
  ),
}));

vi.mock('@/lib/utils', () => ({
  formatDate: vi.fn((date: Date | string, fmt: string) => `formatted:${fmt}`),
}));

describe('useDateFormat', () => {
  it('returns formatDate function and dateFormat', () => {
    const { result } = renderHook(() => useDateFormat());
    expect(result.current.dateFormat).toBe('YYYY-MM-DD');
    expect(typeof result.current.formatDate).toBe('function');
  });

  it('formatDate delegates to utils formatDate', () => {
    const { result } = renderHook(() => useDateFormat());
    const formatted = result.current.formatDate('2025-01-15');
    expect(formatted).toBe('formatted:YYYY-MM-DD');
  });
});
