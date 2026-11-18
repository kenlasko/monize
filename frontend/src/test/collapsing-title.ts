import { act } from '@/test/render';
import { vi } from 'vitest';
import { useMobileChromeStore } from '@/store/mobileChromeStore';

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;

/**
 * Stubs `IntersectionObserver` so a test can scroll a page's `<h1>` behind
 * the app header (`useCollapsingHeaderTitle`) and read what the page handed
 * the header. Only observers watching a heading are driven, so other
 * observers on the page are left alone. Undo with `vi.unstubAllGlobals()`.
 */
export function stubCollapsingTitle() {
  const headings = new Map<Element, Callback>();
  useMobileChromeStore.setState({ collapsedTitle: null });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly callback: Callback;
      constructor(callback: Callback) {
        this.callback = callback;
      }
      observe(target: Element) {
        if (target.tagName === 'H1') headings.set(target, this.callback);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );

  return {
    /** Scroll every observed page heading up behind the header. */
    collapse() {
      act(() => {
        for (const callback of headings.values()) {
          callback([{ isIntersecting: false, boundingClientRect: { top: -40 } as DOMRectReadOnly }]);
        }
      });
    },
    /** What the header currently shows in place of the page title. */
    current: () => useMobileChromeStore.getState().collapsedTitle,
  };
}
