import { create } from 'zustand';

/**
 * Whether the keyboard-shortcuts dialog (opened only from the header Help
 * menu / mobile drawer -- there is no key of its own) is open. A separate
 * store from `helpSearchStore`, same reason: each surface is opened and
 * closed on its own.
 */
interface HelpShortcutsState {
  open: boolean;
  openShortcuts: () => void;
  closeShortcuts: () => void;
}

export const useHelpShortcutsStore = create<HelpShortcutsState>((set) => ({
  open: false,
  openShortcuts: () => set({ open: true }),
  closeShortcuts: () => set({ open: false }),
}));
