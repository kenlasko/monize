import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@/test/render';
import { useDashboardLayoutDraft } from './useDashboardLayoutDraft';
import { defaultDashboardLayout } from '@/components/dashboard/dashboard-layout';
import { DEFAULT_DASHBOARD_WIDGET_IDS } from '@/components/dashboard/widget-registry';

const { store, updateStorePreferences } = vi.hoisted(() => ({
  store: {
    preferences: {
      dashboardWidgets: [] as string[],
      dashboardWidgetConfig: {} as Record<string, Record<string, unknown>>,
    },
  },
  updateStorePreferences: vi.fn(),
}));
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: Object.assign(() => undefined, {
    getState: () => ({ preferences: store.preferences, updatePreferences: updateStorePreferences }),
  }),
}));

const updatePreferences = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: { updatePreferences: (...args: unknown[]) => updatePreferences(...args) },
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({ default: { error: toastError, success: vi.fn() } }));

function setup() {
  return renderHook(() => useDashboardLayoutDraft());
}

const back = () => {
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
};

describe('useDashboardLayoutDraft', () => {
  let pushState: ReturnType<typeof vi.spyOn>;
  let historyBack: ReturnType<typeof vi.spyOn>;
  let historyState: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    store.preferences = { dashboardWidgets: [], dashboardWidgetConfig: {} };
    updatePreferences.mockImplementation(async (body) => body);
    historyState = null;
    pushState = vi.spyOn(window.history, 'pushState').mockImplementation((state) => {
      historyState = state as Record<string, unknown>;
    });
    historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {
      historyState = null;
    });
    vi.spyOn(window.history, 'state', 'get').mockImplementation(() => historyState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts outside edit mode with no draft', () => {
    const { result } = setup();
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBeNull();
    expect(result.current.dirty).toBe(false);
  });

  it('enters seeded from the stored layout and pushes one history entry', () => {
    store.preferences = {
      dashboardWidgets: ['insights', 'net-worth'],
      dashboardWidgetConfig: { 'net-worth': { gridWidth: 'full' } },
    };
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.enter());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toEqual([
      { id: 'insights', width: 'half', height: 'compact' },
      { id: 'net-worth', width: 'full', height: 'standard' },
    ]);
    expect(result.current.dirty).toBe(false);
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(historyState).toMatchObject({ dashboardEdit: expect.any(String) });
  });

  it('marks each visit\'s history entry with a token of its own', () => {
    const { result } = setup();
    act(() => result.current.enter());
    const first = historyState?.dashboardEdit;
    act(() => result.current.cancel());
    act(() => result.current.enter());
    expect(historyState?.dashboardEdit).toEqual(expect.any(String));
    expect(historyState?.dashboardEdit).not.toBe(first);
  });

  it('is dirty once the draft differs from its seed, and clean again when it matches', () => {
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'move', from: 0, to: 1 }));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.dispatch({ type: 'move', from: 1, to: 0 }));
    expect(result.current.dirty).toBe(false);
  });

  it('cancels at once with an unchanged draft, popping its entry and storing nothing', () => {
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.cancel());
    expect(result.current.editing).toBe(false);
    expect(historyBack).toHaveBeenCalledTimes(1);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('asks before cancelling a changed draft, and discards only when told to (DASH-4)', () => {
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
    act(() => result.current.cancel());
    expect(result.current.editing).toBe(true);
    expect(result.current.confirmingLeave).toBe(true);
    act(() => result.current.keepEditing());
    expect(result.current.confirmingLeave).toBe(false);
    expect(result.current.draft?.some((i) => i.id === 'insights')).toBe(false);
    act(() => result.current.cancel());
    act(() => result.current.discard());
    expect(result.current.editing).toBe(false);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  describe('Escape typed in a panel with an Escape of its own', () => {
    // The AI sheet is a dialog without aria-modal; the docked help panel is complementary.
    it.each([
      ['the AI assistant sheet', 'dialog'],
      ['the docked help panel', 'complementary'],
    ])('stays in edit mode for %s', (_name, role) => {
      const { result } = setup();
      act(() => result.current.enter());
      const panel = document.createElement('div');
      panel.setAttribute('role', role);
      const field = document.createElement('input');
      panel.appendChild(field);
      document.body.appendChild(panel);
      field.focus();
      act(() => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(result.current.editing).toBe(true);
      expect(result.current.confirmingLeave).toBe(false);
      panel.remove();
    });

    it('still leaves for an Escape typed on the page itself', () => {
      const { result } = setup();
      act(() => result.current.enter());
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(result.current.editing).toBe(false);
    });
  });

  it('leaves on Escape, but not while a dialog is open on top', () => {
    const { result } = setup();
    act(() => result.current.enter());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.editing).toBe(true);
    dialog.remove();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.editing).toBe(false);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('leaves on Back with an unchanged draft, without popping a second entry', () => {
    const { result } = setup();
    act(() => result.current.enter());
    act(back);
    expect(result.current.editing).toBe(false);
    expect(historyBack).not.toHaveBeenCalled();
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('puts its entry back and asks on Back with a changed draft', () => {
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
    act(back);
    expect(result.current.editing).toBe(true);
    expect(result.current.confirmingLeave).toBe(true);
    expect(pushState).toHaveBeenCalledTimes(2);
  });

  it('skips the late popstate of its own history.back() when entered again at once', () => {
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.cancel());
    act(() => result.current.enter());
    act(back);
    expect(result.current.editing).toBe(true);
    act(back);
    expect(result.current.editing).toBe(false);
  });

  it('ignores a Back that only closed a dialog above its own entry', () => {
    const { result } = setup();
    act(() => result.current.enter());
    const own = { ...historyState };
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: own }));
    });
    expect(result.current.editing).toBe(true);
  });

  it('leaves in one Back when the entry under it is one an earlier visit left behind', () => {
    // An earlier visit's entry, as a link's navigation leaves it (section 10.3).
    historyState = { dashboardEdit: true };
    const { result } = setup();
    act(() => result.current.enter());
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { dashboardEdit: true } }));
    });
    expect(result.current.editing).toBe(false);
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('saves once, the draft over the settings map read at save time (DASH-5, DASH-6)', async () => {
    store.preferences = { dashboardWidgets: [], dashboardWidgetConfig: { 'net-worth': { range: '2y' } } };
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
    act(() => result.current.dispatch({ type: 'resize', id: 'net-worth', width: 'full' }));
    // A widget's gear saved a setting while the draft was open.
    store.preferences = {
      dashboardWidgets: [],
      dashboardWidgetConfig: { 'net-worth': { range: '5y' }, 'expenses-pie': { months: 6 } },
    };
    updatePreferences.mockResolvedValueOnce({
      dashboardWidgets: DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
      dashboardWidgetConfig: { 'net-worth': { range: '5y', gridWidth: 'full' }, 'expenses-pie': { months: 6 } },
    });
    await act(async () => {
      await result.current.save();
    });
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    // Only the resized slice, over the setting read at save time; the server
    // merges it by widget id and answers with the whole map.
    expect(updatePreferences).toHaveBeenCalledWith({
      dashboardWidgets: DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
      dashboardWidgetConfig: { 'net-worth': { range: '5y', gridWidth: 'full' } },
    });
    expect(updateStorePreferences).toHaveBeenCalledWith({
      dashboardWidgets: DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
      dashboardWidgetConfig: { 'net-worth': { range: '5y', gridWidth: 'full' }, 'expenses-pie': { months: 6 } },
    });
    expect(result.current.editing).toBe(false);
    expect(historyBack).toHaveBeenCalledTimes(1);
  });

  it('saves a draft equal to the default layout as never customized', async () => {
    store.preferences = { dashboardWidgets: ['insights'], dashboardWidgetConfig: {} };
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'reset' }));
    expect(result.current.draft).toEqual(defaultDashboardLayout());
    expect(updatePreferences).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.save();
    });
    expect(updatePreferences.mock.calls[0][0].dashboardWidgets).toEqual([]);
  });

  it('keeps the draft and edit mode when the save is refused', async () => {
    updatePreferences.mockRejectedValue(new Error('nope'));
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
    const draft = result.current.draft;
    await act(async () => {
      await result.current.save();
    });
    expect(toastError).toHaveBeenCalledWith('nope');
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toBe(draft);
    expect(result.current.saving).toBe(false);
    expect(updateStorePreferences).not.toHaveBeenCalled();
    expect(historyBack).not.toHaveBeenCalled();
  });

  it('leaves on Done with nothing changed, like a discard, sending no request', async () => {
    const { result } = setup();
    act(() => result.current.enter());
    await act(async () => {
      await result.current.save();
    });
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(updateStorePreferences).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
    expect(historyBack).toHaveBeenCalledTimes(1);
  });

  describe('while a save is in flight', () => {
    function pendingSave() {
      let finish!: () => void;
      updatePreferences.mockImplementation(
        (body) =>
          new Promise((resolve) => {
            finish = () => resolve(body);
          }),
      );
      return { finish: () => finish() };
    }

    it('ignores a discard, and the save then leaves as usual', async () => {
      const save = pendingSave();
      const { result } = setup();
      act(() => result.current.enter());
      act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
      let saving!: Promise<void>;
      act(() => {
        saving = result.current.save();
      });
      act(() => result.current.discard());
      expect(result.current.editing).toBe(true);
      expect(historyBack).not.toHaveBeenCalled();
      await act(async () => {
        save.finish();
        await saving;
      });
      expect(updatePreferences).toHaveBeenCalledTimes(1);
      expect(result.current.editing).toBe(false);
      expect(historyBack).toHaveBeenCalledTimes(1);
    });

    it('refuses a layout change, and stores the draft Done was pressed on', async () => {
      const save = pendingSave();
      const { result } = setup();
      act(() => result.current.enter());
      act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
      const pressed = result.current.draft;
      let saving!: Promise<void>;
      act(() => {
        saving = result.current.save();
      });
      act(() => result.current.dispatch({ type: 'remove', id: 'net-worth' }));
      act(() => result.current.dispatch({ type: 'add', id: 'favourite-reports' }));
      expect(result.current.draft).toBe(pressed);
      await act(async () => {
        save.finish();
        await saving;
      });
      expect(updatePreferences).toHaveBeenCalledTimes(1);
      expect(updatePreferences.mock.calls[0][0].dashboardWidgets).toEqual(
        DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
      );
    });

    it('puts its entry back on Back without asking or leaving, and the save then leaves', async () => {
      const save = pendingSave();
      const { result } = setup();
      act(() => result.current.enter());
      act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
      let saving!: Promise<void>;
      act(() => {
        saving = result.current.save();
      });
      historyState = null;
      act(back);
      expect(result.current.editing).toBe(true);
      expect(result.current.confirmingLeave).toBe(false);
      expect(pushState).toHaveBeenCalledTimes(2);
      expect(historyState).toMatchObject({ dashboardEdit: expect.any(String) });
      await act(async () => {
        save.finish();
        await saving;
      });
      expect(result.current.editing).toBe(false);
      expect(result.current.confirmingLeave).toBe(false);
      expect(historyBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('unmounted while editing', () => {
    const settle = () => act(async () => {});

    it('pops its own entry when that entry is still the current one', async () => {
      const { result, unmount } = setup();
      act(() => result.current.enter());
      unmount();
      await settle();
      expect(historyBack).toHaveBeenCalledTimes(1);
    });

    it('leaves history alone once a navigation pushed a new entry over it', async () => {
      const { result, unmount } = setup();
      act(() => result.current.enter());
      // The router's entry for the next page, which does not carry the marker.
      historyState = { __NA: true };
      unmount();
      await settle();
      expect(historyBack).not.toHaveBeenCalled();
    });

    it('pops its own entry once a dialog open over it has popped its own', async () => {
      const { result, unmount } = setup();
      act(() => result.current.enter());
      const own = { ...historyState };
      // A Modal's entry, which spreads the state under it.
      historyState = { ...own, modal: true };
      unmount();
      await settle();
      // The Modal's own unmount pops its entry; that lands as a popstate.
      expect(historyBack).not.toHaveBeenCalled();
      historyState = own;
      window.dispatchEvent(new PopStateEvent('popstate', { state: own }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(historyBack).toHaveBeenCalledTimes(1);
    });

    it('does nothing when unmounted outside edit mode', async () => {
      const { unmount } = setup();
      unmount();
      await settle();
      expect(historyBack).not.toHaveBeenCalled();
    });
  });

  it('does not save an empty draft', async () => {
    store.preferences = { dashboardWidgets: ['insights'], dashboardWidgetConfig: {} };
    const { result } = setup();
    act(() => result.current.enter());
    act(() => result.current.dispatch({ type: 'remove', id: 'insights' }));
    await act(async () => {
      await result.current.save();
    });
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(true);
  });
});
