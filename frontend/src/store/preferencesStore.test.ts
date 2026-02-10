import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePreferencesStore } from './preferencesStore';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    getPreferences: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { userSettingsApi } from '@/lib/user-settings';

describe('preferencesStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    usePreferencesStore.setState({
      preferences: null,
      isLoaded: false,
      _hasHydrated: false,
    });
  });

  it('has initial state', () => {
    const state = usePreferencesStore.getState();
    expect(state.preferences).toBeNull();
    expect(state.isLoaded).toBe(false);
  });

  it('loadPreferences fetches and sets preferences', async () => {
    vi.mocked(userSettingsApi.getPreferences).mockResolvedValue({
      defaultCurrency: 'CAD',
      theme: 'dark',
      dateFormat: 'YYYY-MM-DD',
    } as any);

    await usePreferencesStore.getState().loadPreferences();
    const state = usePreferencesStore.getState();
    expect(state.preferences?.defaultCurrency).toBe('CAD');
    expect(state.isLoaded).toBe(true);
  });

  it('loadPreferences sets isLoaded on failure', async () => {
    vi.mocked(userSettingsApi.getPreferences).mockRejectedValue(new Error('fail'));

    await usePreferencesStore.getState().loadPreferences();
    const state = usePreferencesStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.preferences).toBeNull();
  });

  it('updatePreferences merges with current', () => {
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'CAD', theme: 'dark' } as any,
    });

    usePreferencesStore.getState().updatePreferences({ theme: 'light' } as any);
    const state = usePreferencesStore.getState();
    expect(state.preferences?.theme).toBe('light');
    expect(state.preferences?.defaultCurrency).toBe('CAD');
  });

  it('updatePreferences sets directly when no current preferences', () => {
    usePreferencesStore.getState().updatePreferences({ theme: 'light' } as any);
    const state = usePreferencesStore.getState();
    expect(state.preferences?.theme).toBe('light');
  });

  it('clearPreferences resets state', () => {
    usePreferencesStore.setState({
      preferences: { theme: 'dark' } as any,
      isLoaded: true,
    });

    usePreferencesStore.getState().clearPreferences();
    const state = usePreferencesStore.getState();
    expect(state.preferences).toBeNull();
    expect(state.isLoaded).toBe(false);
  });

  it('setHasHydrated updates hydration state', () => {
    usePreferencesStore.getState().setHasHydrated(true);
    expect(usePreferencesStore.getState()._hasHydrated).toBe(true);
  });
});
