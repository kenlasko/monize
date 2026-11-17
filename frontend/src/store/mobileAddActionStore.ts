import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { TourAnchorId } from '@/lib/tours/anchors';

/** One of the things a page's "new" button can create, when it offers several. */
export interface MobileAddChoice {
  /** Stable identity for React keys. */
  key: string;
  /** Already-translated label, e.g. "Cash transaction". */
  label: string;
  run: () => void;
}

/** What the mobile tab bar's add button does on the page now on screen. */
export interface MobileAddAction {
  /** Who registered it, so a page leaving never clears its successor's. */
  owner: symbol;
  /** The button's accessible name: the page's own "New ..." label. */
  label: string;
  run: () => void;
  /**
   * The choices the page's header menu offers, when its "new" button is a
   * menu. The add button then opens a sheet listing them, so a page whose
   * header button is not drawn on a phone loses none of it. `null` for a
   * single action; `run` runs the first choice.
   */
  choices?: () => readonly MobileAddChoice[] | null;
  /**
   * The tour anchor the page's header button carries. The header button is
   * not drawn while the tab bar is, so the add button carries it instead and a
   * tour step pointing at "New ..." still has something to point at.
   */
  tourAnchor?: TourAnchorId;
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
 * memoise it. A header label's visual "+ " is dropped: the button already
 * draws one, and a screen reader would read it as "plus".
 */
export function useMobileAddAction(
  label: string | null,
  run: () => void,
  options: { tourAnchor?: TourAnchorId } = {},
): void {
  useRegisterMobileAdd(label, run, options.tourAnchor);
}

/**
 * `useMobileAddAction` for a page whose header "new" button is a menu (a
 * brokerage or a cash transaction on Investments): the add button asks which
 * of `choices` to create rather than picking one for the reader.
 */
export function useMobileAddChoices(
  label: string | null,
  choices: readonly MobileAddChoice[],
  options: { tourAnchor?: TourAnchorId } = {},
): void {
  useRegisterMobileAdd(label, choices, options.tourAnchor);
}

function useRegisterMobileAdd(
  label: string | null,
  handler: (() => void) | readonly MobileAddChoice[],
  tourAnchor: TourAnchorId | undefined,
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (label === null) return;
    const owner = Symbol('mobile-add-action');
    useMobileAddActionStore.getState().setAction({
      owner,
      label: label.replace(/^\+\s*/, ''),
      run: () => {
        const current = handlerRef.current;
        if (typeof current === 'function') current();
        else current[0]?.run();
      },
      choices: () => {
        const current = handlerRef.current;
        return typeof current === 'function' ? null : current;
      },
      tourAnchor,
    });
    return () => useMobileAddActionStore.getState().clearAction(owner);
  }, [label, tourAnchor]);
}
