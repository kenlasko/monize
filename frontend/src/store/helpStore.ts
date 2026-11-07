import { create } from 'zustand';
import type { HelpTarget } from '@/lib/docs-links';

/**
 * State of the in-app help panel (`components/help/HelpPanel.tsx`).
 *
 * Nothing here is persisted. If a reader's "remember pinned" is wanted later it
 * goes through `persisted-storage.guard.test.ts` with its reason, not into this
 * store quietly.
 *
 * `history` is a list of pages the reader has been to and `cursor` the one on
 * screen, as in a browser: following a link while back in the list drops the
 * entries ahead of it. Every move to a different page or section adds an entry,
 * a table-of-contents click and a link to another section of the same page
 * included, so Back returns to the section the reader came from. (Section moves
 * used to replace the entry; on a long guide page that left Back and Forward
 * disabled through the whole visit, which read as buttons that did nothing.)
 * Asking for the target already on screen adds nothing and only rescrolls.
 */
interface HelpState {
  open: boolean;
  /** Filling the viewport rather than docked at the edge. */
  expanded: boolean;
  /** Stays open across route changes. Cleared when the panel closes. */
  pinned: boolean;
  history: HelpTarget[];
  cursor: number;
  /**
   * Counts every request to show something, including one for the section
   * already on screen, so the panel scrolls to it again rather than treating
   * the repeat as no change.
   */
  visit: number;
  /**
   * Whether the server has a bundled guide: `null` until the manifest has been
   * read, then what it said. A help control decides synchronously, at click
   * time, from this (`lib/help-open.ts`); it is a fact about the server, so it
   * survives the panel closing.
   */
  guideAvailable: boolean | null;

  /** Open at a target, or move to it when the panel is already open. */
  openAt: (target: HelpTarget) => void;
  /** Go to a target inside the open panel. */
  navigate: (target: HelpTarget) => void;
  back: () => void;
  forward: () => void;
  close: () => void;
  setPinned: (pinned: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  setGuideAvailable: (available: boolean) => void;
}

const INITIAL = {
  open: false,
  expanded: false,
  pinned: false,
  history: [] as HelpTarget[],
  cursor: -1,
  visit: 0,
  guideAvailable: null as boolean | null,
};

function sameTarget(a: HelpTarget, b: HelpTarget): boolean {
  return a.page === b.page && a.section === b.section;
}

export const useHelpStore = create<HelpState>((set) => ({
  ...INITIAL,

  openAt: (target) =>
    set((s) =>
      s.open
        ? moveTo(s, target)
        : { open: true, history: [target], cursor: 0, visit: s.visit + 1 },
    ),

  navigate: (target) => set((s) => moveTo(s, target)),

  back: () =>
    set((s) =>
      s.cursor > 0 ? { cursor: s.cursor - 1, visit: s.visit + 1 } : s,
    ),

  forward: () =>
    set((s) =>
      s.cursor < s.history.length - 1
        ? { cursor: s.cursor + 1, visit: s.visit + 1 }
        : s,
    ),

  close: () =>
    set((s) => (s.open ? { open: false, expanded: false, pinned: false } : s)),

  setPinned: (pinned) => set({ pinned }),

  setExpanded: (expanded) => set({ expanded }),

  setGuideAvailable: (guideAvailable) => set({ guideAvailable }),
}));

function moveTo(
  s: Pick<HelpState, 'history' | 'cursor' | 'visit'>,
  target: HelpTarget,
): Partial<HelpState> {
  const current = s.history[s.cursor];
  const visit = s.visit + 1;
  if (current === undefined) return { history: [target], cursor: 0, visit };
  if (sameTarget(current, target)) return { visit };
  const history = [...s.history.slice(0, s.cursor + 1), target];
  return { history, cursor: history.length - 1, visit };
}

/** The target on screen, or `null` while the panel has not been opened. */
export function currentHelpTarget(
  s: Pick<HelpState, 'history' | 'cursor'>,
): HelpTarget | null {
  return s.history[s.cursor] ?? null;
}
