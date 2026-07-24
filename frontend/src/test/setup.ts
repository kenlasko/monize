import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
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

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
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
