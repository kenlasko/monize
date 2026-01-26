import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { UserPreferences } from '@/types/auth';
import { userSettingsApi } from '@/lib/user-settings';

interface PreferencesState {
  preferences: UserPreferences | null;
  isLoaded: boolean;
  _hasHydrated: boolean;
  loadPreferences: () => Promise<void>;
  updatePreferences: (prefs: Partial<UserPreferences>) => void;
  clearPreferences: () => void;
  setHasHydrated: (state: boolean) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set, get) => ({
      preferences: null,
      isLoaded: false,
      _hasHydrated: false,

      loadPreferences: async () => {
        try {
          const prefs = await userSettingsApi.getPreferences();
          set({ preferences: prefs, isLoaded: true });
        } catch (error) {
          console.error('Failed to load preferences:', error);
          // Set defaults if loading fails
          set({ isLoaded: true });
        }
      },

      updatePreferences: (prefs) => {
        const current = get().preferences;
        if (current) {
          set({ preferences: { ...current, ...prefs } });
        } else {
          // If no current preferences, set the new prefs directly
          set({ preferences: prefs as UserPreferences });
        }
      },

      clearPreferences: () => {
        set({ preferences: null, isLoaded: false });
      },

      setHasHydrated: (state) => {
        set({ _hasHydrated: state });
      },
    }),
    {
      name: 'moneymate-preferences',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ preferences: state.preferences, isLoaded: state.isLoaded }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
