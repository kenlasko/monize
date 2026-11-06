import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect, useState, type ComponentType } from 'react';
import { act, render, screen } from '@/test/render';

// `next/dynamic` as it behaves in the browser: the module is requested when the
// component first renders, not when its importer loads.
vi.mock('next/dynamic', () => ({
  default: (load: () => Promise<ComponentType>) =>
    function Dynamic() {
      const [Loaded, setLoaded] = useState<ComponentType | null>(null);
      useEffect(() => {
        void load().then((c) => setLoaded(() => c));
      }, []);
      return Loaded ? <Loaded /> : null;
    },
}));

const panelModuleLoaded = vi.fn();
vi.mock('./HelpPanel', () => {
  panelModuleLoaded();
  return { HelpPanel: () => <div data-testid="help-panel" /> };
});

import { HelpPanelLoader } from './HelpPanelLoader';
import { useHelpStore } from '@/store/helpStore';

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

describe('HelpPanelLoader', () => {
  it('loads nothing while the panel is closed', async () => {
    await act(async () => {
      render(<HelpPanelLoader />);
    });
    expect(screen.queryByTestId('help-panel')).not.toBeInTheDocument();
    expect(panelModuleLoaded).not.toHaveBeenCalled();
  });

  it('loads and shows the panel when it opens, and drops it when it closes', async () => {
    await act(async () => {
      render(<HelpPanelLoader />);
    });
    await act(async () => useHelpStore.getState().openAt({ page: 'budgets' }));
    expect(await screen.findByTestId('help-panel')).toBeInTheDocument();
    expect(panelModuleLoaded).toHaveBeenCalledTimes(1);

    await act(async () => useHelpStore.getState().close());
    expect(screen.queryByTestId('help-panel')).not.toBeInTheDocument();
  });
});
