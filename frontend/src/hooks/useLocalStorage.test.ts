import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLocalStorage } from './useLocalStorage';

describe('useLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('returns initial value when localStorage is empty', () => {
    const { result } = renderHook(() => useLocalStorage('key', 'default'));
    expect(result.current[0]).toBe('default');
  });

  it('reads existing value from localStorage', () => {
    window.localStorage.setItem('key', JSON.stringify('stored'));
    const { result } = renderHook(() => useLocalStorage('key', 'default'));
    expect(result.current[0]).toBe('stored');
  });

  it('persists value to localStorage on set', () => {
    const { result } = renderHook(() => useLocalStorage('key', 'default'));
    act(() => {
      result.current[1]('updated');
    });
    expect(result.current[0]).toBe('updated');
    expect(JSON.parse(window.localStorage.getItem('key')!)).toBe('updated');
  });

  it('supports functional updates', () => {
    const { result } = renderHook(() => useLocalStorage<number>('count', 0));
    act(() => {
      result.current[1]((prev) => prev + 1);
    });
    expect(result.current[0]).toBe(1);
  });

  it('handles objects', () => {
    const { result } = renderHook(() => useLocalStorage('obj', { a: 1 }));
    act(() => {
      result.current[1]({ a: 2 });
    });
    expect(result.current[0]).toEqual({ a: 2 });
  });

  it('returns initial value when JSON parse fails', () => {
    window.localStorage.setItem('bad', 'not-json');
    const { result } = renderHook(() => useLocalStorage('bad', 'fallback'));
    expect(result.current[0]).toBe('fallback');
  });
});
