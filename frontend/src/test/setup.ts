import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, vi } from 'vitest';

import { failOnActWarnings, recordIfActWarning } from './act-guard';
import { failOnIntlErrors, recordIfIntlError } from './intl-guard';

afterEach(async () => {
  cleanup();
  // Persisted UI preferences must not leak between tests: e.g. an account
  // filter a test selects is written to localStorage, and without this the
  // next test in the file would start with that filter still applied.
  window.localStorage?.clear();
  // sessionStorage is the same hazard and was missed. The Portfolio Value
  // chart caches its intraday response there, and a leaked entry hydrates the
  // next test's chart *synchronously on mount* -- which moves the prior-close
  // baseline request from second-stage to immediate. Tests asserting on that
  // request then passed or failed on whether an earlier test happened to leave
  // a usable entry behind, which is how `InvestmentValueChart` went green in
  // isolation and red in a full suite (CI run #2877).
  window.sessionStorage?.clear();
  // Row density is one store for every view, so clearing its localStorage
  // entry is not enough -- the module-level state outlives it. Reset after `cleanup()`,
  // never before: writing to a store while the tree is still mounted
  // re-renders it outside act() (see docs/frontend/testing.md).
  //
  // Imported here rather than at the top of this file, and that is not a
  // style choice. `createJSONStorage(() => localStorage)` resolves the storage
  // object once, when the store module is evaluated -- and a top-level import
  // is hoisted above the `Object.defineProperty(window, 'localStorage', ...)`
  // below, so the store would bind jsdom's native storage while every
  // assertion read the mock. The two would never see each other's writes.
  const { useDensityStore } = await import('@/store/densityStore');
  useDensityStore.setState({ densities: {} });
  // Hidden columns are the same shape of store, for the same reason.
  const { useHiddenColumnsStore } = await import('@/store/hiddenColumnsStore');
  useHiddenColumnsStore.setState({ columns: {} });
  // A page's last-drawn data and the reader's place on it live in module
  // memory for the tab's life, so one test's page must not hand them to the
  // next test's mount (it would skip the spinner and restore a scroll).
  const { clearPageSnapshots } = await import('@/lib/page-snapshot');
  clearPageSnapshots();
  const { clearRetainedScroll } = await import('@/lib/scroll-retention');
  clearRetainedScroll();
  // Last, so an update React commits during `cleanup()` is counted against the
  // test that mounted the tree rather than the next one.
  failOnIntlErrors();
  failOnActWarnings();
});

// `cleanup()` for the file's final test runs inside that test's own afterEach
// above, but a warning React logs after the last hook has nowhere else to go.
afterAll(() => {
  failOnIntlErrors();
  failOnActWarnings();
});

// Suppress known-harmless jsdom warnings for SVG elements used by Recharts.
// Also suppress tagged output from the project's `createLogger` (e.g.
// "[useMonteCarloScenarios] Save failed: ..."). Tests intentionally exercise
// logger.error/warn paths and assert behavioral effects (toasts, state) rather
// than console output, so the tagged log lines are pure noise.
const LOGGER_TAG_RE = /^\[[A-Za-z][\w-]*\]$/;
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  // Recorded rather than printed: the failure raised in `afterEach` names the
  // test, which one line on stderr in a 14,000-test run does not. See
  // `act-guard.ts` for why these are failures and not noise.
  if (recordIfActWarning(args)) {
    return;
  }
  // The same treatment for next-intl's message errors, and the reason this is
  // here as well as on the provider's `onError`: a tree rendered outside
  // `@/test/render` falls back to next-intl's default handler, which prints the
  // IntlError object here. Catching it in both places means the guard does not
  // depend on the test having used the right harness -- which is exactly the
  // thing it exists to detect. See `intl-guard.ts`.
  if (args.some(recordIfIntlError)) {
    return;
  }
  if (
    msg.includes('is unrecognized in this browser') ||
    msg.includes('is using incorrect casing') ||
    LOGGER_TAG_RE.test(msg)
  ) {
    return;
  }
  originalConsoleError(...args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (LOGGER_TAG_RE.test(msg)) return;
  originalConsoleWarn(...args);
};

const originalConsoleInfo = console.info;
console.info = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (LOGGER_TAG_RE.test(msg)) return;
  originalConsoleInfo(...args);
};

// Mock next/navigation.
//
// One router object for the whole run, because that is what the real hook
// returns. A fresh object per call gives every `useCallback([router])` a new
// identity on every render, and any effect depending on such a callback then
// re-runs on every render -- which, when the effect also sets state, is an
// endless loop. The Transactions page did exactly that: 83 `transactions.getAll`
// calls in 300ms, and act warnings from the updates still landing after the test
// had ended. Nothing in production behaves that way; only the mock did.
const routerMock = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
};
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock react-hot-toast. The default export is callable (toast(msg, opts)) with
// success/error/loading/dismiss attached, mirroring the real module.
vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  });
  return {
    default: toast,
    Toaster: () => null,
  };
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock scrollTo (not implemented in jsdom)
window.scrollTo = vi.fn() as any;

// Mock scrollIntoView (not implemented in jsdom); used by dropdown/combobox lists
Element.prototype.scrollIntoView = vi.fn() as any;

// Stub ResizeObserver (not implemented in jsdom); used by the tour overlay's
// live-rect tracking. A no-op observer is enough: tests drive rects directly.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
