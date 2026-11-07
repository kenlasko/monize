import { create } from 'zustand';

/**
 * Whether the help search dialog (`Ctrl/Cmd+K`, `?`, or a click from the
 * help panel or menu) is open. Kept apart from `helpStore`, which is the
 * panel's own state: the two are opened independently, and the dialog hands
 * off to the panel (`useHelpStore.getState().openAt(...)`) rather than
 * sharing its state.
 */
interface HelpSearchState {
  open: boolean;
  openSearch: () => void;
  closeSearch: () => void;
}

export const useHelpSearchStore = create<HelpSearchState>((set) => ({
  open: false,
  openSearch: () => set({ open: true }),
  closeSearch: () => set({ open: false }),
}));
