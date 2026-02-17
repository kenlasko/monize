import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDemoMode } from './useDemoMode';
import { useDemoStore } from '@/store/demoStore';

describe('useDemoMode', () => {
  beforeEach(() => {
    useDemoStore.setState({ isDemoMode: false });
  });

  it('returns false when demo mode is not active', () => {
    const { result } = renderHook(() => useDemoMode());
    expect(result.current).toBe(false);
  });

  it('returns true when demo mode is active', () => {
    useDemoStore.setState({ isDemoMode: true });
    const { result } = renderHook(() => useDemoMode());
    expect(result.current).toBe(true);
  });

  it('reacts to store changes', () => {
    const { result } = renderHook(() => useDemoMode());
    expect(result.current).toBe(false);

    act(() => {
      useDemoStore.getState().setDemoMode(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      useDemoStore.getState().setDemoMode(false);
    });
    expect(result.current).toBe(false);
  });
});
