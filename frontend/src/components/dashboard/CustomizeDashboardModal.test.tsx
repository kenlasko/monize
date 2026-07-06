import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent, within } from '@testing-library/react';
import { render } from '@/test/render';
import { CustomizeDashboardModal } from './CustomizeDashboardModal';
import { DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_WIDGET_IDS } from './widget-registry';

const { prefsState, updateStorePreferencesMock } = vi.hoisted(() => ({
  prefsState: {
    current: { dashboardWidgets: [] as string[] },
  },
  updateStorePreferencesMock: vi.fn(),
}));
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      preferences: prefsState.current,
      updatePreferences: updateStorePreferencesMock,
    };
    return selector ? selector(state) : state;
  },
}));

const updatePreferencesMock = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => updatePreferencesMock(...args),
  },
}));

const onClose = vi.fn();

async function renderModal() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CustomizeDashboardModal isOpen onClose={onClose} />);
  });
  return result!;
}

const rowFor = (name: string) => screen.getByText(name).closest('li')!;

describe('CustomizeDashboardModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsState.current = { dashboardWidgets: [] };
    updatePreferencesMock.mockImplementation(async (data) => ({
      dashboardWidgets: data.dashboardWidgets,
    }));
  });

  it('lists every registered widget with default enabled states', async () => {
    await renderModal();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(DASHBOARD_WIDGETS.length);
    expect(within(rowFor('Favourite Accounts')).getByRole('checkbox')).toBeChecked();
    expect(within(rowFor('Favourite Reports')).getByRole('checkbox')).not.toBeChecked();
  });

  it('saves an unmodified default layout as empty (not customized)', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: [] });
    expect(updateStorePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: [] });
    expect(onClose).toHaveBeenCalled();
  });

  it('saves the explicit list when a widget is hidden', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(within(rowFor('Upcoming Bills & Deposits')).getByRole('checkbox'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({
      dashboardWidgets: DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'upcoming-bills'),
    });
  });

  it('saves the new order after moving a widget up', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Move Upcoming Bills & Deposits up'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const expected = [...DEFAULT_DASHBOARD_WIDGET_IDS];
    [expected[0], expected[1]] = [expected[1], expected[0]];
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: expected });
  });

  it('enabling Favourite Reports saves it at its list position', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(within(rowFor('Favourite Reports')).getByRole('checkbox'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({
      dashboardWidgets: [...DEFAULT_DASHBOARD_WIDGET_IDS, 'favourite-reports'],
    });
  });

  it('seeds from a stored custom layout: order kept, hidden widgets appended unchecked', async () => {
    prefsState.current = { dashboardWidgets: ['insights', 'net-worth'] };
    await renderModal();
    const labels = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(labels[0]).toContain('Spending Insights');
    expect(labels[1]).toContain('Net Worth');
    expect(within(rowFor('Spending Insights')).getByRole('checkbox')).toBeChecked();
    expect(within(rowFor('Favourite Accounts')).getByRole('checkbox')).not.toBeChecked();
  });

  it('blocks saving when no widget is enabled', async () => {
    prefsState.current = { dashboardWidgets: ['insights'] };
    await renderModal();
    await act(async () => {
      fireEvent.click(within(rowFor('Spending Insights')).getByRole('checkbox'));
    });
    expect(screen.getByText(/Select at least one widget/)).toBeInTheDocument();
    expect(screen.getByText('Save').closest('button')).toBeDisabled();
  });

  it('reset restores the default layout', async () => {
    prefsState.current = { dashboardWidgets: ['insights'] };
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Reset to default'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: [] });
  });

  it('shows an error toast and stays open when saving fails', async () => {
    const toast = (await import('react-hot-toast')).default;
    updatePreferencesMock.mockRejectedValue(new Error('nope'));
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    await act(async () => {});
    expect(toast.error).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
