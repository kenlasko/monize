import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { HELP_PANEL_DEFAULT_WIDTH } from '@/components/help/help-layout';

/**
 * How wide the reader has dragged the docked help panel, in px.
 *
 * Browser-local rather than a row in `user_preferences`: how much of the window
 * is worth giving a guide depends on the screen in front of the reader, so a
 * laptop and a wide monitor signed into the same account should not have to
 * agree. It survives logout deliberately, being a fact about the screen.
 *
 * Only the number persists, and it is stored as chosen: it is held to the
 * panel's bounds at the moment it is used (`clampHelpPanelWidth`), because the
 * window it was chosen in may not be the window it is read in. It is kept apart
 * from `helpStore`, whose state is never persisted, so that store's contents
 * stay out of storage an XSS can read.
 */
export const HELP_WIDTH_STORAGE_KEY = 'monize-help-width';

interface HelpWidthState {
  width: number;
  setWidth: (width: number) => void;
}

export const useHelpWidthStore = create<HelpWidthState>()(
  persist(
    (set) => ({
      width: HELP_PANEL_DEFAULT_WIDTH,
      setWidth: (width) => set({ width: Math.round(width) }),
    }),
    {
      name: HELP_WIDTH_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The action is rebuilt on load; only the number is stored.
      partialize: (state) => ({ width: state.width }),
      // A hand-edited or truncated entry is the default width, not a panel
      // with no width.
      merge: (persisted, current) => {
        const stored = (persisted as { width?: unknown } | undefined)?.width;
        return {
          ...current,
          width:
            typeof stored === 'number' && Number.isFinite(stored)
              ? stored
              : current.width,
        };
      },
    },
  ),
);
