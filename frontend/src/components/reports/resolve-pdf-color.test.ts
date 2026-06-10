import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolvePdfColor } from './resolve-pdf-color';

function mockComputedColor(value: string) {
  return vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: () => value,
  } as unknown as CSSStyleDeclaration);
}

describe('resolvePdfColor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns plain hex colours unchanged without consulting computed styles', () => {
    const spy = mockComputedColor('#123456');
    expect(resolvePdfColor('#ff0000')).toBe('#ff0000');
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves a CSS variable reference to its computed hex value', () => {
    mockComputedColor(' #3b82f6 ');
    expect(resolvePdfColor('var(--chart-1)')).toBe('#3b82f6');
  });

  it('falls back to neutral gray when the variable resolves to a non-hex colour', () => {
    mockComputedColor('oklch(55.1% 0.027 264.364)');
    expect(resolvePdfColor('var(--chart-axis)')).toBe('#6b7280');
  });

  it('falls back to neutral gray when the variable is undefined', () => {
    mockComputedColor('');
    expect(resolvePdfColor('var(--chart-missing)')).toBe('#6b7280');
  });
});
