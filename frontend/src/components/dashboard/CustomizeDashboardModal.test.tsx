import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent, createEvent, within } from '@testing-library/react';
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

const tile = (id: string) => screen.getByTestId(`widget-tile-${id}`);

// The mockup grid flows left to right, so the insertion gap is picked from
// the pointer's horizontal position. jsdom tiles have a zero-size bounding
// rect: a negative clientX lands in the leading half (insert before) and a
// positive one in the trailing half (insert after).
const dragOverAt = (el: Element, clientX: number) => {
  const evt = createEvent.dragOver(el);
  Object.defineProperty(evt, 'clientX', { value: clientX });
  fireEvent(el, evt);
};

describe('CustomizeDashboardModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsState.current = { dashboardWidgets: [] };
    updatePreferencesMock.mockImplementation(async (data) => ({
      dashboardWidgets: data.dashboardWidgets,
    }));
  });

  it('shows visible widgets as grid tiles and the rest as hidden chips', async () => {
    await renderModal();
    for (const id of DEFAULT_DASHBOARD_WIDGET_IDS) {
      expect(screen.getByTestId(`widget-tile-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('widget-tile-favourite-reports')).not.toBeInTheDocument();
    expect(screen.getByTestId('widget-hidden-favourite-reports')).toBeInTheDocument();
    expect(screen.getByText('Hidden widgets')).toBeInTheDocument();
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
      fireEvent.click(screen.getByLabelText('Hide Upcoming Bills & Deposits'));
    });
    expect(screen.getByTestId('widget-hidden-upcoming-bills')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({
      dashboardWidgets: DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'upcoming-bills'),
    });
  });

  it('saves the new order after moving a widget earlier with the arrow button', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Move Upcoming Bills & Deposits earlier'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const expected = [...DEFAULT_DASHBOARD_WIDGET_IDS];
    [expected[0], expected[1]] = [expected[1], expected[0]];
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: expected });
  });

  it('showing Favourite Reports appends it to the layout', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByTestId('widget-hidden-favourite-reports'));
    });
    expect(screen.getByTestId('widget-tile-favourite-reports')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({
      dashboardWidgets: [...DEFAULT_DASHBOARD_WIDGET_IDS, 'favourite-reports'],
    });
  });

  it('seeds from a stored custom layout: order kept, others hidden', async () => {
    prefsState.current = { dashboardWidgets: ['insights', 'net-worth'] };
    await renderModal();
    const tiles = screen.getAllByTestId(/^widget-tile-/);
    expect(tiles.map((el) => el.getAttribute('data-testid'))).toEqual([
      'widget-tile-insights',
      'widget-tile-net-worth',
    ]);
    expect(screen.getByTestId('widget-hidden-favourite-accounts')).toBeInTheDocument();
  });

  it('blocks saving when no widget is visible', async () => {
    prefsState.current = { dashboardWidgets: ['insights'] };
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Hide Spending Insights'));
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

  it('dropping in the leading half of a tile inserts before it', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.dragStart(tile('insights'));
    });
    await act(async () => {
      dragOverAt(tile('favourite-accounts'), -5);
    });
    await act(async () => {
      fireEvent.drop(tile('favourite-accounts'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const expected = [
      'insights',
      ...DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
    ];
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: expected });
  });

  it('dropping in the trailing half of a tile inserts after it', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.dragStart(tile('insights'));
    });
    await act(async () => {
      dragOverAt(tile('favourite-accounts'), 5);
    });
    await act(async () => {
      fireEvent.drop(tile('favourite-accounts'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const rest = DEFAULT_DASHBOARD_WIDGET_IDS.filter(
      (id) => id !== 'insights' && id !== 'favourite-accounts',
    );
    expect(updatePreferencesMock).toHaveBeenCalledWith({
      dashboardWidgets: ['favourite-accounts', 'insights', ...rest],
    });
  });

  it('renders one insertion line per gap, shared by adjacent tile halves', async () => {
    await renderModal();
    const first = tile('favourite-accounts');
    const second = tile('upcoming-bills');
    await act(async () => {
      fireEvent.dragStart(tile('insights'));
    });

    // Trailing half of the first tile and leading half of the second are the
    // same gap: both draw the single line before the second tile.
    await act(async () => {
      dragOverAt(first, 5);
    });
    expect(within(second).getByTestId('drop-indicator-before')).toBeInTheDocument();
    expect(within(first).queryByTestId('drop-indicator-after')).not.toBeInTheDocument();

    await act(async () => {
      dragOverAt(second, -5);
    });
    expect(within(second).getByTestId('drop-indicator-before')).toBeInTheDocument();
    expect(within(first).queryByTestId('drop-indicator-after')).not.toBeInTheDocument();

    // Only the end-of-list gap draws after the last tile. Drag a different
    // widget for this: the gap after the last tile is a no-op for itself.
    await act(async () => {
      fireEvent.dragEnd(tile('insights'));
    });
    const last = tile(DEFAULT_DASHBOARD_WIDGET_IDS[DEFAULT_DASHBOARD_WIDGET_IDS.length - 1]);
    await act(async () => {
      fireEvent.dragStart(first);
    });
    await act(async () => {
      dragOverAt(last, 5);
    });
    expect(within(last).getByTestId('drop-indicator-after')).toBeInTheDocument();

    await act(async () => {
      fireEvent.dragEnd(first);
    });
    expect(screen.queryByTestId('drop-indicator-after')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drop-indicator-before')).not.toBeInTheDocument();
  });

  it('shows no insertion line for the gaps beside the dragged tile', async () => {
    await renderModal();
    const dragged = tile('insights');
    await act(async () => {
      fireEvent.dragStart(dragged);
    });
    await act(async () => {
      dragOverAt(dragged, -5);
    });
    expect(screen.queryByTestId('drop-indicator-before')).not.toBeInTheDocument();
  });

  it('dropping a tile onto itself keeps the default layout', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.dragStart(tile('insights'));
    });
    await act(async () => {
      fireEvent.drop(tile('insights'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: [] });
  });

  it('a drop with no drag in progress changes nothing', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.drop(tile('favourite-accounts'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({ dashboardWidgets: [] });
  });

  it('shows a widget-type icon in each visible tile and hidden chip', async () => {
    await renderModal();
    // Expenses by Category is a pie; Income vs Expenses is a bar chart.
    expect(within(tile('expenses-pie')).getByTestId('widget-type-icon-pie')).toBeInTheDocument();
    expect(within(tile('income-expenses')).getByTestId('widget-type-icon-bar')).toBeInTheDocument();
    // Hidden chips carry their type icon too.
    const chip = screen.getByTestId('widget-hidden-portfolio-value');
    expect(within(chip).getByTestId('widget-type-icon-line')).toBeInTheDocument();
  });

  it('every registered widget appears exactly once (tile or hidden chip)', async () => {
    await renderModal();
    for (const w of DASHBOARD_WIDGETS) {
      const asTile = screen.queryByTestId(`widget-tile-${w.id}`);
      const asChip = screen.queryByTestId(`widget-hidden-${w.id}`);
      expect(!!asTile !== !!asChip).toBe(true);
    }
  });
});
