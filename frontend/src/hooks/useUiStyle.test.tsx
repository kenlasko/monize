import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/render';
import { renderForStyle, useUiStyle, type StyleVariants } from './useUiStyle';

const theme = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => theme.value,
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('useUiStyle', () => {
  beforeEach(() => {
    theme.value = {};
  });

  it('reads the active style', () => {
    theme.value = { uiStyle: 'classic' };
    expect(renderHook(() => useUiStyle()).result.current).toBe('classic');
  });

  it('falls back to standard when the context carries no style', () => {
    expect(renderHook(() => useUiStyle()).result.current).toBe('standard');
  });
});

describe('renderForStyle', () => {
  const Standard = ({ label }: { label: string }) => <span>standard {label}</span>;
  const Classic = ({ label }: { label: string }) => <span>classic {label}</span>;
  const VARIANTS: StyleVariants<{ label: string }> = { standard: Standard, classic: Classic };

  it('renders the variant for the style, with the same props', () => {
    const el = renderForStyle('classic', VARIANTS, { label: 'x' });
    expect(el.type).toBe(Classic);
    expect(el.props).toEqual({ label: 'x' });
  });

  it('falls back to standard for a style without its own variant', () => {
    expect(renderForStyle('modern', VARIANTS, { label: 'x' }).type).toBe(Standard);
  });
});
