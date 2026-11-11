import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, fireEvent, within } from '@/test/render';
import { DashboardHeroSettingsModal } from './DashboardHeroSettingsModal';
import { DASHBOARD_HERO_DEFAULT } from './widget-config';

const { prefsState, updateStorePreferencesMock } = vi.hoisted(() => ({
  prefsState: {
    current: { dashboardWidgets: [] as string[] } as {
      dashboardWidgets: string[];
      dashboardWidgetConfig?: Record<string, Record<string, unknown>>;
    },
  },
  updateStorePreferencesMock: vi.fn(),
}));
vi.mock('@/store/preferencesStore', () => {
  const state = () => ({ preferences: prefsState.current, updatePreferences: updateStorePreferencesMock });
  return {
    usePreferencesStore: Object.assign(
      (selector?: (s: unknown) => unknown) => (selector ? selector(state()) : state()),
      { getState: state },
    ),
  };
});

const updatePreferencesMock = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => updatePreferencesMock(...args),
  },
}));

const onClose = vi.fn();

async function renderModal() {
  await act(async () => {
    render(<DashboardHeroSettingsModal isOpen onClose={onClose} />);
  });
}

const section = () => screen.getByTestId('hero-settings');

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
}

describe('DashboardHeroSettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsState.current = { dashboardWidgets: [] };
    updatePreferencesMock.mockImplementation(async (data) => ({
      dashboardWidgets: prefsState.current.dashboardWidgets,
      dashboardWidgetConfig: data.dashboardWidgetConfig,
    }));
  });

  it('is named by its title and keeps its explanation in a tooltip', async () => {
    await renderModal();
    expect(screen.getByRole('dialog', { name: 'Dashboard hero' })).toHaveAccessibleDescription(
      /opening figures and chart/,
    );
  });

  it('saves only the hero slice, merged into the map read at save time, and never the layout', async () => {
    prefsState.current = {
      dashboardWidgets: ['insights', 'net-worth'],
      dashboardWidgetConfig: { 'net-worth': { range: '5y', gridWidth: 'full' } },
    };
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '10Y' }));
    });
    // Another widget's setting saved while the dialog was open.
    prefsState.current = {
      ...prefsState.current,
      dashboardWidgetConfig: { 'net-worth': { range: '2y', gridWidth: 'full' }, insights: { gridHeight: 'tall' } },
    };
    await save();
    expect(updatePreferencesMock).toHaveBeenCalledTimes(1);
    const sent = updatePreferencesMock.mock.calls[0][0];
    expect(Object.keys(sent)).toEqual(['dashboardWidgetConfig']);
    expect(sent.dashboardWidgetConfig).toEqual({
      'net-worth': { range: '2y', gridWidth: 'full' },
      insights: { gridHeight: 'tall' },
      'dashboard-hero': { ...DASHBOARD_HERO_DEFAULT, range: '10y' },
    });
    expect(updateStorePreferencesMock).toHaveBeenCalledWith({ dashboardWidgetConfig: sent.dashboardWidgetConfig });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error toast and stays open when saving fails', async () => {
    const toast = (await import('react-hot-toast')).default;
    const toastError = vi.spyOn(toast, 'error');
    updatePreferencesMock.mockRejectedValue(new Error('nope'));
    await renderModal();
    await save();
    expect(toastError).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(updateStorePreferencesMock).not.toHaveBeenCalled();
    toastError.mockRestore();
  });

  it('cannot be closed by Escape or its backdrop while the save is in flight', async () => {
    let answer!: () => void;
    updatePreferencesMock.mockImplementationOnce(
      (data) =>
        new Promise((resolve) => {
          answer = () => resolve({ dashboardWidgets: [], dashboardWidgetConfig: data.dashboardWidgetConfig });
        }),
    );
    await renderModal();
    await save();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => answer());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from Cancel without saving', async () => {
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(updatePreferencesMock).not.toHaveBeenCalled();
  });

  it('spreads the net worth and portfolio buttons across a phone line, not past `sm`', async () => {
    await renderModal();
    for (const name of ['Net worth', 'Portfolio value']) {
      const button = within(section()).getByRole('button', { name });
      expect(button.className).toContain('grow');
      expect(button.className).toContain('sm:grow-0');
      expect(button.parentElement?.className).toContain('w-full');
      expect(button.parentElement?.className).toContain('sm:w-auto');
    }
  });

  it('is on, over a one-year chart, for a reader who never set it', async () => {
    await renderModal();
    expect(within(section()).getByRole('switch', { name: 'Show the dashboard hero' })).toBeChecked();
    expect(within(section()).getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
    const windows = within(section()).getByRole('group', { name: 'Chart' });
    expect(within(windows).getAllByRole('button').map((b) => b.textContent)).toEqual(['1Y', '2Y', '5Y', '10Y']);
    expect(within(windows).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(section()).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers both sets\' settings on Auto, and only the chosen set\'s otherwise', async () => {
    await renderModal();
    expect(within(section()).getByRole('group', { name: 'Chart' })).toBeInTheDocument();
    expect(within(section()).getByRole('group', { name: 'Figure' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Net worth' }));
    });
    expect(within(section()).getByRole('group', { name: 'Chart' })).toBeInTheDocument();
    expect(within(section()).queryByRole('group', { name: 'Figure' })).not.toBeInTheDocument();
  });

  it('names which set each setting belongs to on Auto, and drops the names for one set', async () => {
    await renderModal();
    const netWorth = within(section()).getByRole('group', { name: 'Net worth' });
    const portfolio = within(section()).getByRole('group', { name: 'Portfolio value' });
    expect(within(netWorth).getByRole('group', { name: 'Chart' })).toBeInTheDocument();
    expect(within(netWorth).queryByRole('group', { name: 'Figure' })).not.toBeInTheDocument();
    expect(within(portfolio).getByRole('group', { name: 'Figure' })).toBeInTheDocument();
    expect(within(portfolio).getByRole('group', { name: 'Timeframe' })).toBeInTheDocument();
    expect(within(portfolio).queryByRole('group', { name: 'Chart' })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Portfolio value' }));
    });
    expect(within(section()).queryByRole('group', { name: 'Portfolio value' })).not.toBeInTheDocument();
    expect(within(section()).getByRole('group', { name: 'Figure' })).toBeInTheDocument();
  });

  it('hides the window choice when the hero is switched off, and saves it off', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Show the dashboard hero' }));
    });
    expect(screen.queryByRole('group', { name: 'Chart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument();
    await save();
    expect(updatePreferencesMock.mock.calls[0][0].dashboardWidgetConfig['dashboard-hero'].enabled).toBe(false);
  });

  it('starts from the stored choice, drops stale keys, and resets to on over one year', async () => {
    prefsState.current = {
      dashboardWidgets: [],
      dashboardWidgetConfig: { 'dashboard-hero': { enabled: false, range: '10y', greeting: false } },
    };
    await renderModal();
    expect(screen.getByRole('switch', { name: 'Show the dashboard hero' })).not.toBeChecked();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    });
    await save();
    expect(updatePreferencesMock.mock.calls[0][0].dashboardWidgetConfig['dashboard-hero']).toEqual(
      DASHBOARD_HERO_DEFAULT,
    );
  });

  it('offers the portfolio set with its accounts, the value chart\'s timeframes and a figure', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Portfolio value' }));
    });
    expect(within(section()).queryByRole('group', { name: 'Chart' })).not.toBeInTheDocument();
    expect(within(section()).getByText('Accounts')).toBeInTheDocument();
    const timeframe = within(section()).getByRole('group', { name: 'Timeframe' });
    expect(within(timeframe).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '1D', '1W', 'MTD', '1M', '3M', 'YTD', '1Y', '2Y', '5Y', 'All',
    ]);
    const figure = within(section()).getByRole('group', { name: 'Figure' });
    expect(within(figure).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Simple return', 'TWR', 'MWR', 'CAGR',
    ]);
    expect(within(figure).getByRole('button', { name: 'TWR' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      fireEvent.click(within(timeframe).getByRole('button', { name: 'YTD' }));
      fireEvent.click(within(figure).getByRole('button', { name: 'CAGR' }));
    });
    await save();
    expect(updatePreferencesMock.mock.calls[0][0].dashboardWidgetConfig['dashboard-hero']).toEqual({
      ...DASHBOARD_HERO_DEFAULT,
      set: 'portfolio',
      portfolioRange: 'ytd',
      portfolioMetric: 'cagr',
    });
  });

  it('starts from a stored portfolio choice', async () => {
    prefsState.current = {
      dashboardWidgets: [],
      dashboardWidgetConfig: {
        'dashboard-hero': { set: 'portfolio', portfolioRange: '5y', portfolioMetric: 'mwr' },
      },
    };
    await renderModal();
    expect(screen.getByRole('button', { name: 'Portfolio value' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('group', { name: 'Figure' })).getByRole('button', { name: 'MWR' })).toHaveAttribute('aria-pressed', 'true');
    await save();
    expect(updatePreferencesMock.mock.calls[0][0].dashboardWidgetConfig['dashboard-hero']).toMatchObject({
      set: 'portfolio',
      portfolioRange: '5y',
      portfolioMetric: 'mwr',
    });
  });

  it('ignores a stored window it does not offer', async () => {
    prefsState.current = {
      dashboardWidgets: [],
      dashboardWidgetConfig: { 'dashboard-hero': { range: '3m' } },
    };
    await renderModal();
    const windows = within(section()).getByRole('group', { name: 'Chart' });
    expect(within(windows).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
  });
});
