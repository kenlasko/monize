import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';
import { useWidgetConfig } from './useWidgetConfig';

const { storeState } = vi.hoisted(() => ({
  storeState: {
    preferences: { dashboardWidgetConfig: {} as Record<string, Record<string, unknown>> },
  },
}));

const updatePreferencesApi = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/store/preferencesStore', () => {
  const usePreferencesStore = ((selector: (s: unknown) => unknown) =>
    selector({ preferences: storeState.preferences })) as unknown as {
    (selector: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  usePreferencesStore.getState = () => ({
    preferences: storeState.preferences,
    updatePreferences: (patch: Record<string, unknown>) => {
      storeState.preferences = { ...storeState.preferences, ...patch } as typeof storeState.preferences;
    },
  });
  return { usePreferencesStore };
});

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => updatePreferencesApi(...args),
  },
}));

const DEFAULTS = { range: '3m', accountIds: [] as string[] };

describe('useWidgetConfig', () => {
  beforeEach(() => {
    storeState.preferences = { dashboardWidgetConfig: {} };
    updatePreferencesApi.mockReset();
    (toast.error as ReturnType<typeof vi.fn>).mockReset?.();
  });

  it('returns defaults when nothing is stored', () => {
    const { result } = renderHook(() => useWidgetConfig('w1', DEFAULTS));
    expect(result.current.config).toEqual(DEFAULTS);
  });

  it('merges stored settings over the defaults', () => {
    storeState.preferences = { dashboardWidgetConfig: { w1: { range: '1y' } } };
    const { result } = renderHook(() => useWidgetConfig('w1', DEFAULTS));
    expect(result.current.config).toEqual({ range: '1y', accountIds: [] });
  });

  it('persists a merged patch for only its own widget id', async () => {
    storeState.preferences = {
      dashboardWidgetConfig: { other: { range: '6m' } },
    };
    updatePreferencesApi.mockResolvedValue({
      dashboardWidgetConfig: { other: { range: '6m' }, w1: { range: '1y', accountIds: [] } },
    });

    const { result } = renderHook(() => useWidgetConfig('w1', DEFAULTS));
    await act(async () => {
      await result.current.updateConfig({ range: '1y' });
    });

    expect(updatePreferencesApi).toHaveBeenCalledWith({
      dashboardWidgetConfig: {
        other: { range: '6m' },
        w1: { range: '1y', accountIds: [] },
      },
    });
    // Store retains the other widget's config.
    expect(storeState.preferences.dashboardWidgetConfig.other).toEqual({ range: '6m' });
  });

  it('reverts the optimistic update and toasts on failure', async () => {
    const before = { w1: { range: '3m', accountIds: [] } };
    storeState.preferences = { dashboardWidgetConfig: before };
    updatePreferencesApi.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useWidgetConfig('w1', DEFAULTS));
    await act(async () => {
      await result.current.updateConfig({ range: '1y' });
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Reverted to the pre-edit map.
    expect(storeState.preferences.dashboardWidgetConfig).toEqual(before);
  });
});
