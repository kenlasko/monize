'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import { LOCALE_COOKIE, isSupportedLocale, detectBrowserLocale } from '@/i18n/config';
import { isColorTheme } from '@/lib/color-themes';
import { userSettingsApi } from '@/lib/user-settings';
import { consumePreLoginLocale } from '@/lib/pre-login-locale';
import { createLogger } from '@/lib/logger';

const logger = createLogger('PreferencesLoader');

/**
 * Component that loads user preferences when authenticated.
 * Should be placed inside the app layout.
 */
export function PreferencesLoader({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authHydrated = useAuthStore((state) => state._hasHydrated);
  const loadPreferences = usePreferencesStore((state) => state.loadPreferences);
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const clearPreferences = usePreferencesStore((state) => state.clearPreferences);
  const preferences = usePreferencesStore((state) => state.preferences);
  const isLoaded = usePreferencesStore((state) => state.isLoaded);
  const prefsHydrated = usePreferencesStore((state) => state._hasHydrated);
  const { setTheme, setColorTheme } = useTheme();

  useEffect(() => {
    // Wait for both stores to hydrate
    if (!authHydrated || !prefsHydrated) return;

    if (isAuthenticated && !isLoaded) {
      loadPreferences();
    } else if (!isAuthenticated) {
      clearPreferences();
    }
  }, [isAuthenticated, authHydrated, prefsHydrated, isLoaded, loadPreferences, clearPreferences]);

  // Sync theme when preferences change
  useEffect(() => {
    if (prefsHydrated && preferences?.theme) {
      setTheme(preferences.theme as 'light' | 'dark' | 'system');
    }
  }, [prefsHydrated, preferences?.theme, setTheme]);

  // Sync colour theme when preferences change
  useEffect(() => {
    if (prefsHydrated && isColorTheme(preferences?.colorTheme)) {
      setColorTheme(preferences.colorTheme);
    }
  }, [prefsHydrated, preferences?.colorTheme, setColorTheme]);

  // Sync language cookie from DB preference. The proxy reads NEXT_LOCALE and
  // sets the x-locale header on the next request; we refresh the router so
  // the new language takes effect immediately if it differs from the cookie.
  // Exception: a language deliberately chosen on the login screen wins over
  // the stored preference -- persist it instead of reverting the cookie.
  useEffect(() => {
    if (!prefsHydrated || !preferences?.language) return;
    const pref = preferences.language;
    // 'browser' resolves to the locale the browser advertises; a concrete code
    // must be a supported locale before it is applied to the cookie.
    if (pref !== 'browser' && !isSupportedLocale(pref)) return;
    const effective = pref === 'browser' ? detectBrowserLocale() : pref;

    const preLogin = consumePreLoginLocale();
    if (preLogin && isSupportedLocale(preLogin)) {
      if (preLogin !== pref) {
        userSettingsApi
          .updatePreferences({ language: preLogin })
          .then((updated) => updatePreferencesStore(updated))
          .catch((error) =>
            logger.error('Failed to persist pre-login language choice:', error),
          );
      }
      return;
    }

    const current = Cookies.get(LOCALE_COOKIE);
    if (current === effective) return;
    Cookies.set(LOCALE_COOKIE, effective, {
      sameSite: 'lax',
      expires: 365,
    });
    router.refresh();
  }, [prefsHydrated, preferences?.language, router, updatePreferencesStore]);

  return <>{children}</>;
}
