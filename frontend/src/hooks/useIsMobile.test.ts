import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@/test/render';
import { useIsLgUp, useIsMobile } from './useIsMobile';

describe('useIsMobile', () => {
  it('returns false when matchMedia does not match', () => {
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('subscribes to changes and unsubscribes on unmount', () => {
    const addSpy = vi.fn();
    const removeSpy = vi.fn();
    const original = window.matchMedia;
    let listener: ((e: MediaQueryListEvent) => void) | null = null;
    (window as any).matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(max-width: 639px)',
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        listener = cb;
        addSpy();
      },
      removeEventListener: () => removeSpy(),
    });

    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect(addSpy).toHaveBeenCalled();

    // Trigger a change - useSyncExternalStore re-fetches snapshot via getSnapshot
    act(() => {
      listener?.({ matches: false } as MediaQueryListEvent);
    });

    unmount();
    expect(removeSpy).toHaveBeenCalled();

    (window as any).matchMedia = original;
  });
});

describe('useIsLgUp', () => {
  it('asks for lg and up, and is false where nothing matches', () => {
    const original = window.matchMedia;
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 1024px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    (window as any).matchMedia = matchMedia;
    try {
      expect(renderHook(() => useIsLgUp()).result.current).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith('(min-width: 1024px)');
    } finally {
      (window as any).matchMedia = original;
    }
    expect(renderHook(() => useIsLgUp()).result.current).toBe(false);
  });
});
