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

const dialogModuleLoaded = vi.fn();
vi.mock('./HelpSearchDialog', () => {
  dialogModuleLoaded();
  return { HelpSearchDialog: () => <div data-testid="help-search-dialog" /> };
});

import { HelpSearchShortcut } from './HelpSearchShortcut';
import { useHelpSearchStore } from '@/store/helpSearchStore';

function keydown(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  useHelpSearchStore.setState(useHelpSearchStore.getInitialState(), true);
});

describe('HelpSearchShortcut', () => {
  it('loads nothing while search is closed', async () => {
    await act(async () => {
      render(<HelpSearchShortcut />);
    });
    expect(screen.queryByTestId('help-search-dialog')).not.toBeInTheDocument();
    expect(dialogModuleLoaded).not.toHaveBeenCalled();
  });

  it('loads and shows the dialog once it opens', async () => {
    await act(async () => {
      render(<HelpSearchShortcut />);
    });
    await act(async () => useHelpSearchStore.getState().openSearch());
    expect(await screen.findByTestId('help-search-dialog')).toBeInTheDocument();
    expect(dialogModuleLoaded).toHaveBeenCalledTimes(1);
  });

  it('leaves Ctrl/Cmd+K to the command palette', async () => {
    await act(async () => {
      render(<HelpSearchShortcut />);
    });
    expect(keydown({ ctrlKey: true, key: 'k' })).toBe(false);
    expect(useHelpSearchStore.getState().open).toBe(false);
  });

  it('opens on a bare "?" outside an editable element', async () => {
    await act(async () => {
      render(<HelpSearchShortcut />);
    });
    let prevented = false;
    await act(async () => {
      prevented = keydown({ key: '?' });
    });
    expect(prevented).toBe(true);
    expect(useHelpSearchStore.getState().open).toBe(true);
  });

  it('leaves a "?" typed into an input alone', async () => {
    await act(async () => {
      render(<HelpSearchShortcut />);
    });
    const input = document.createElement('input');
    document.body.append(input);
    let prevented = false;
    await act(async () => {
      prevented = keydown({ key: '?' }, input);
    });
    expect(prevented).toBe(false);
    expect(useHelpSearchStore.getState().open).toBe(false);
    input.remove();
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }])(
    // Shift is not tested here: "?" on a US keyboard already arrives with
    // shiftKey true (it is Shift+/), so excluding it would break the
    // ordinary case this shortcut exists for.
    'leaves "?" alone when combined with another modifier (%j)',
    async (init) => {
      await act(async () => {
        render(<HelpSearchShortcut />);
      });
      await act(async () => {
        keydown({ key: '?', ...init });
      });
      expect(useHelpSearchStore.getState().open).toBe(false);
    },
  );
});
