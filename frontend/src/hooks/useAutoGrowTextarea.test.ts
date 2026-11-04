import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import { fitTextareaToContent, useAutoGrowTextarea } from './useAutoGrowTextarea';

/** jsdom has no layout, so the measurements a browser would supply are stubbed. */
function measuredTextarea(scrollHeight: number, borders = 2): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 20 });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 20 + borders });
  document.body.appendChild(el);
  return el;
}

describe('fitTextareaToContent', () => {
  it('sets the border-box height that shows every line', () => {
    const el = measuredTextarea(64);
    fitTextareaToContent(el);
    expect(el.style.height).toBe('66px');
  });

  it('leaves the rows height when nothing is laid out', () => {
    const el = measuredTextarea(0);
    el.style.height = '120px';
    fitTextareaToContent(el);
    expect(el.style.height).toBe('auto');
  });
});

describe('useAutoGrowTextarea', () => {
  it('fits on attach and again when the value changes', () => {
    let scrollHeight = 22;
    const el = document.createElement('textarea');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 20 });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 22 });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(({ value }) => useAutoGrowTextarea(value), {
      initialProps: { value: 'one line' },
    });
    result.current(el);
    expect(el.style.height).toBe('24px');

    scrollHeight = 62;
    rerender({ value: 'one line\ntwo\nthree' });
    expect(el.style.height).toBe('64px');
  });

  it('does not re-measure when handed the element it already holds', () => {
    const el = measuredTextarea(40);
    const { result } = renderHook(() => useAutoGrowTextarea('x'));
    result.current(el);
    el.style.height = '200px'; // the reader dragged it taller
    result.current(null);
    result.current(el);
    expect(el.style.height).toBe('200px');
  });
});
