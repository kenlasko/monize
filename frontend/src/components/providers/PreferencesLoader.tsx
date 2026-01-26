'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';

/**
 * Component that loads user preferences when authenticated.
 * Should be placed inside the app layout.
 */
export function PreferencesLoader({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authHydrated = useAuthStore((state) => state._hasHydrated);
  const loadPreferences = usePreferencesStore((state) => state.loadPreferences);
  const clearPreferences = usePreferencesStore((state) => state.clearPreferences);
  const preferences = usePreferencesStore((state) => state.preferences);
  const isLoaded = usePreferencesStore((state) => state.isLoaded);
  const prefsHydrated = usePreferencesStore((state) => state._hasHydrated);
  const { setTheme } = useTheme();

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

  return <>{children}</>;
}
