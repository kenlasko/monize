import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
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
