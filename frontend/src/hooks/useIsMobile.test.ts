import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './useIsMobile';

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
