import { describe, it, expect, vi } from 'vitest';
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

const dialogModuleLoaded = vi.fn();
vi.mock('./KeyboardShortcutsDialog', () => {
  dialogModuleLoaded();
  return { KeyboardShortcutsDialog: () => <div data-testid="keyboard-shortcuts-dialog" /> };
});

import { KeyboardShortcutsHost } from './KeyboardShortcutsHost';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';

describe('KeyboardShortcutsHost', () => {
  it('loads nothing while the dialog is closed', async () => {
    useHelpShortcutsStore.setState({ open: false });
    await act(async () => {
      render(<KeyboardShortcutsHost />);
    });
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).not.toBeInTheDocument();
    expect(dialogModuleLoaded).not.toHaveBeenCalled();
  });

  it('loads and shows the dialog once it opens', async () => {
    useHelpShortcutsStore.setState({ open: false });
    await act(async () => {
      render(<KeyboardShortcutsHost />);
    });
    await act(async () => useHelpShortcutsStore.getState().openShortcuts());
    expect(await screen.findByTestId('keyboard-shortcuts-dialog')).toBeInTheDocument();
    expect(dialogModuleLoaded).toHaveBeenCalledTimes(1);
  });
});
