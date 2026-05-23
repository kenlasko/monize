import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { useClickOutside } from './useClickOutside';

function mountRef() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement }).current = el;
  return { el, ref };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useClickOutside', () => {
  it('fires the handler on mousedown outside the ref', () => {
    const { ref } = mountRef();
    const handler = vi.fn();
    renderHook(() => useClickOutside(ref, handler));

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire when mousedown lands inside the ref', () => {
    const { el, ref } = mountRef();
    const handler = vi.fn();
    renderHook(() => useClickOutside(ref, handler));

    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('treats a click inside any of multiple refs as inside', () => {
    const a = mountRef();
    const b = mountRef();
    const handler = vi.fn();
    renderHook(() => useClickOutside([a.ref, b.ref], handler));

    b.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not attach listeners when disabled', () => {
    const { ref } = mountRef();
    const handler = vi.fn();
    renderHook(() => useClickOutside(ref, handler, { enabled: false }));

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls onEscape on Escape keydown when provided', () => {
    const { ref } = mountRef();
    const onEscape = vi.fn();
    renderHook(() => useClickOutside(ref, vi.fn(), { onEscape }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('ignores non-Escape keys', () => {
    const { ref } = mountRef();
    const onEscape = vi.fn();
    renderHook(() => useClickOutside(ref, vi.fn(), { onEscape }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('reads the latest handler without re-subscribing', () => {
    const { ref } = mountRef();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }) => useClickOutside(ref, h), {
      initialProps: { h: first },
    });

    rerender({ h: second });
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('removes listeners on unmount', () => {
    const { ref } = mountRef();
    const handler = vi.fn();
    const { unmount } = renderHook(() => useClickOutside(ref, handler));

    unmount();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });
});
