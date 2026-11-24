'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import Cookies from 'js-cookie';
import { ColorTheme, isColorTheme } from '@/lib/color-themes';
import { UiStyle, isUiStyle } from '@/lib/ui-styles';
import {
  COLOR_THEME_COOKIE,
  UI_STYLE_COOKIE,
  RESOLVED_THEME_COOKIE,
  bootPageColor,
} from '@/lib/pwa-theme';
import { preferenceCookieAttributes } from '@/lib/preference-cookie';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  colorTheme: ColorTheme;
  setColorTheme: (colorTheme: ColorTheme) => void;
  uiStyle: UiStyle;
  setUiStyle: (uiStyle: UiStyle) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_KEY = 'monize-theme';
const COLOR_THEME_KEY = 'monize-color-theme';
const UI_STYLE_KEY = 'monize-ui-style';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [colorTheme, setColorThemeState] = useState<ColorTheme>('default');
  const [uiStyle, setUiStyleState] = useState<UiStyle>('standard');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const [mounted, setMounted] = useState(false);

  // Get system preference
  const getSystemTheme = (): 'light' | 'dark' => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  };

  // Load theme from localStorage on mount
  /* eslint-disable react-hooks/set-state-in-effect -- one-time initialization from localStorage */
  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY) as Theme | null;
    if (stored && ['light', 'dark', 'system'].includes(stored)) {
      setThemeState(stored);
    }
    const storedColorTheme = localStorage.getItem(COLOR_THEME_KEY);
    if (isColorTheme(storedColorTheme)) {
      setColorThemeState(storedColorTheme);
    }
    const storedUiStyle = localStorage.getItem(UI_STYLE_KEY);
    if (isUiStyle(storedUiStyle)) {
      setUiStyleState(storedUiStyle);
    }
    setMounted(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Update resolved theme when theme or system preference changes
  useEffect(() => {
    const updateResolvedTheme = () => {
      if (theme === 'system') {
        setResolvedTheme(getSystemTheme());
      } else {
        setResolvedTheme(theme);
      }
    };

    updateResolvedTheme();

    // Listen for system preference changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        setResolvedTheme(getSystemTheme());
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Apply dark class to html element, and mirror the resolved theme into a
  // cookie so the server-rendered boot surfaces (the dark class layout.tsx
  // stamps pre-hydration, the PWA manifest's splash palette) can read it --
  // they paint before this provider mounts and cannot see localStorage.
  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    if (resolvedTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    Cookies.set(RESOLVED_THEME_COOKIE, resolvedTheme, preferenceCookieAttributes());
  }, [resolvedTheme, mounted]);

  // Apply data-theme attribute to html element ('default' = no attribute),
  // and mirror the palette into a cookie for the same server-rendered boot
  // surfaces the resolved-theme cookie serves.
  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    if (colorTheme === 'default') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', colorTheme);
    }
    Cookies.set(COLOR_THEME_COOKIE, colorTheme, preferenceCookieAttributes());
  }, [colorTheme, mounted]);

  // Apply data-ui-style attribute to html element ('standard' = no attribute),
  // and mirror it into a cookie so layout.tsx can stamp it server-side.
  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    if (uiStyle === 'standard') {
      root.removeAttribute('data-ui-style');
    } else {
      root.setAttribute('data-ui-style', uiStyle);
    }
    Cookies.set(UI_STYLE_COOKIE, uiStyle, preferenceCookieAttributes());
  }, [uiStyle, mounted]);

  // Keep the theme-color meta on the active palette's page colour so the
  // browser / installed-PWA chrome follows both the mode and the palette.
  // The SSR metas are media-split on the system preference, which is wrong
  // once the user forces a mode, so every tag is pinned to the resolved
  // colour rather than left to the media query.
  useEffect(() => {
    if (!mounted) return;

    const page = bootPageColor(colorTheme, resolvedTheme);
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length === 0) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = page;
      document.head.appendChild(meta);
    } else {
      metas.forEach((el) => el.setAttribute('content', page));
    }
  }, [resolvedTheme, colorTheme, mounted]);

  // The setters and the value are stable across renders. PreferencesLoader
  // re-applies the stored preference whenever a setter's identity changes, so
  // a setter rebuilt on every render would put the saved choice back the
  // moment a new one was picked, before the save that records it returned.
  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(THEME_KEY, newTheme);
  }, []);

  const setColorTheme = useCallback((newColorTheme: ColorTheme) => {
    setColorThemeState(newColorTheme);
    localStorage.setItem(COLOR_THEME_KEY, newColorTheme);
  }, []);

  const setUiStyle = useCallback((newUiStyle: UiStyle) => {
    setUiStyleState(newUiStyle);
    localStorage.setItem(UI_STYLE_KEY, newUiStyle);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, colorTheme, setColorTheme, uiStyle, setUiStyle }),
    [theme, resolvedTheme, setTheme, colorTheme, setColorTheme, uiStyle, setUiStyle],
  );

  // Prevent flash of incorrect theme
  if (!mounted) {
    return null;
  }

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
