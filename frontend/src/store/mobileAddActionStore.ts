import { useEffect, useRef } from 'react';
import { create } from 'zustand';

/** What the mobile tab bar's add button does on the page now on screen. */
export interface MobileAddAction {
  /** Who registered it, so a page leaving never clears its successor's. */
  owner: symbol;
  /** The button's accessible name: the page's own "New ..." label. */
  label: string;
  run: () => void;
}

interface MobileAddActionState {
  action: MobileAddAction | null;
  setAction: (action: MobileAddAction) => void;
  clearAction: (owner: symbol) => void;
}

/**
 * The add button's page-specific action. Not persisted: it lives exactly as
 * long as the page that registered it is mounted. With none registered the
 * button opens a new transaction, as it always did.
 */
export const useMobileAddActionStore = create<MobileAddActionState>((set) => ({
  action: null,
  setAction: (action) => set({ action }),
  clearAction: (owner) =>
    set((state) => (state.action?.owner === owner ? { action: null } : state)),
}));

/**
 * Makes the mobile add button perform this page's primary "new" action, the
 * same one its header button runs. `label` null registers nothing (a read-only
 * view, or a page still deciding), and the button falls back to a new
 * transaction. The latest `run` is always the one called, so a page need not
 * memoise it.
 */
export function useMobileAddAction(label: string | null, run: () => void): void {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (label === null) return;
    const owner = Symbol('mobile-add-action');
    useMobileAddActionStore.getState().setAction({ owner, label, run: () => runRef.current() });
    return () => useMobileAddActionStore.getState().clearAction(owner);
  }, [label]);
}
