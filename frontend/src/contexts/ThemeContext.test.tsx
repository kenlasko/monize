import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import Cookies from 'js-cookie';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { THEME_SWATCHES } from '@/lib/theme-swatches';

vi.mock('js-cookie', () => ({
  default: { set: vi.fn(), get: vi.fn(), remove: vi.fn() },
}));

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(Cookies.set).mockClear();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((el) => el.remove());
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('renders children after mount', () => {
    render(
      <ThemeProvider>
        <div data-testid="child">Hello</div>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('defaults to system theme', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });
    expect(result.current.theme).toBe('system');
  });

  it('resolves to light when system preference is light', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('resolves to dark when system prefers dark', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('adds dark class to html element when resolved theme is dark', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(
      <ThemeProvider>
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists theme to localStorage when setTheme is called', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    act(() => {
      result.current.setTheme('dark');
    });

    expect(localStorage.setItem).toHaveBeenCalledWith('monize-theme', 'dark');
    expect(result.current.theme).toBe('dark');
  });

  it('reads persisted theme from localStorage on mount', () => {
    localStorage.setItem('monize-theme', 'dark');

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });
    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('defaults to the default colour theme', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.colorTheme).toBe('default');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('persists colour theme to localStorage and applies data-theme when setColorTheme is called', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    act(() => {
      result.current.setColorTheme('nord');
    });

    expect(localStorage.setItem).toHaveBeenCalledWith('monize-color-theme', 'nord');
    expect(result.current.colorTheme).toBe('nord');
    expect(document.documentElement.getAttribute('data-theme')).toBe('nord');
  });

  it('removes the data-theme attribute when switching back to the default colour theme', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    act(() => {
      result.current.setColorTheme('latte');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('latte');

    act(() => {
      result.current.setColorTheme('default');
    });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reads persisted colour theme from localStorage on mount', () => {
    localStorage.setItem('monize-color-theme', 'solarized');

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.colorTheme).toBe('solarized');
    expect(document.documentElement.getAttribute('data-theme')).toBe('solarized');
  });

  it('ignores invalid stored colour theme values', () => {
    localStorage.setItem('monize-color-theme', 'neon-disco');

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.colorTheme).toBe('default');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('throws when useTheme is called outside ThemeProvider', () => {
    // Suppress console.error for the expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useTheme());
    }).toThrow('useTheme must be used within a ThemeProvider');

    spy.mockRestore();
  });

  it('ignores invalid stored theme values', () => {
    localStorage.setItem('monize-theme', 'invalid-theme');
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.theme).toBe('system');
  });

  it('removes dark class when switching from dark to light', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      result.current.setTheme('light');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('reacts to system preference change while in system mode', () => {
    let changeHandler: (() => void) | null = null;
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_event: string, handler: any) => {
        changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.resolvedTheme).toBe('light');

    // Simulate system change to dark by switching the matchMedia mock
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    act(() => {
      changeHandler?.();
    });
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('mirrors the resolved theme and palette into cookies for the boot surfaces', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(Cookies.set).toHaveBeenCalledWith('monize-resolved-theme', 'light', {
      sameSite: 'lax',
      expires: 365,
    });
    expect(Cookies.set).toHaveBeenCalledWith('monize-color-theme', 'default', {
      sameSite: 'lax',
      expires: 365,
    });

    act(() => {
      result.current.setTheme('dark');
    });
    expect(Cookies.set).toHaveBeenCalledWith('monize-resolved-theme', 'dark', {
      sameSite: 'lax',
      expires: 365,
    });

    act(() => {
      result.current.setColorTheme('nord');
    });
    expect(Cookies.set).toHaveBeenCalledWith('monize-color-theme', 'nord', {
      sameSite: 'lax',
      expires: 365,
    });
  });

  it('defaults to the standard UI style with no data-ui-style attribute', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.uiStyle).toBe('standard');
    expect(document.documentElement.hasAttribute('data-ui-style')).toBe(false);
  });

  it('persists UI style, applies data-ui-style and mirrors the cookie', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    act(() => {
      result.current.setUiStyle('folio');
    });
    expect(localStorage.setItem).toHaveBeenCalledWith('monize-ui-style', 'folio');
    expect(result.current.uiStyle).toBe('folio');
    expect(document.documentElement.getAttribute('data-ui-style')).toBe('folio');
    expect(Cookies.set).toHaveBeenCalledWith('monize-ui-style', 'folio', {
      sameSite: 'lax',
      expires: 365,
    });

    act(() => {
      result.current.setUiStyle('standard');
    });
    expect(document.documentElement.hasAttribute('data-ui-style')).toBe(false);
  });

  it('reads persisted UI style on mount and ignores invalid values', () => {
    localStorage.setItem('monize-ui-style', 'pebble');
    const first = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(first.result.current.uiStyle).toBe('pebble');
    expect(document.documentElement.getAttribute('data-ui-style')).toBe('pebble');
    first.unmount();

    localStorage.setItem('monize-ui-style', 'neon-disco');
    const second = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(second.result.current.uiStyle).toBe('standard');
  });

  it('pins the theme-color metas to the active palette page colour', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#ffffff';
    document.head.appendChild(meta);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(meta.getAttribute('content')).toBe(THEME_SWATCHES.default.light.page);

    act(() => {
      result.current.setColorTheme('nord');
    });
    expect(meta.getAttribute('content')).toBe(THEME_SWATCHES.nord.light.page);

    act(() => {
      result.current.setTheme('dark');
    });
    expect(meta.getAttribute('content')).toBe(THEME_SWATCHES.nord.dark.page);
  });

  it('creates a theme-color meta when none was rendered', () => {
    renderHook(() => useTheme(), { wrapper: ThemeProvider });
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toBe(THEME_SWATCHES.default.light.page);
  });

  it('does not change resolvedTheme on system change when in non-system mode', () => {
    let changeHandler: (() => void) | null = null;
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_event: string, handler: any) => {
        changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    act(() => {
      result.current.setTheme('light');
    });

    // Switch matchMedia to dark
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    act(() => {
      changeHandler?.();
    });
    expect(result.current.resolvedTheme).toBe('light');
  });
});
