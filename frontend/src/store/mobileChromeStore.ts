import { create } from 'zustand';
import type { EntitySwitcherItem } from '@/components/ui/EntitySwitcher';

/**
 * The caret a collapsed title carries to switch what the page is narrowed to
 * (the Transactions page's one account), with `EntitySwitcher`'s own props.
 * The caller memoizes it: the header redraws whenever its identity changes.
 */
export interface CollapsedHeaderSwitcher {
  currentId: string;
  items: readonly EntitySwitcherItem[];
  onSelect: (id: string) => void;
  triggerLabel: string;
  filterPlaceholder: string;
  noMatchesLabel: string;
  /** List the current entry too, highlighted (the reports switcher). */
  showCurrent?: boolean;
}

/** What the page's scrolled-away title leaves behind in the app header. */
export interface CollapsedHeaderTitle {
  title: string;
  /**
   * What the page is narrowed to, drawn after the title ("Transactions - WS
   * Chequing"). Where the line does not fit, the title is dropped and this
   * stands alone.
   */
  context?: string;
  /** A caret after `context` that switches it. */
  switcher?: CollapsedHeaderSwitcher;
  /** A headline figure, already formatted, drawn under the title. */
  figure?: string;
  /** Whether `figure` is a subtotal, so the header keeps the marker it had. */
  figurePartial?: boolean;
  change?: { text: string; up: boolean };
}

/**
 * The state the tab bar, the page title and the app header share below `xl`.
 * The header owns the drawer's contents (they need its help entries and sign
 * out), so the More tab asks for it here instead of holding a second copy.
 */
interface MobileChromeState {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  /** `null` while the page's own title is still on screen. */
  collapsedTitle: CollapsedHeaderTitle | null;
  setCollapsedTitle: (title: CollapsedHeaderTitle | null) => void;
}

export const useMobileChromeStore = create<MobileChromeState>((set) => ({
  drawerOpen: false,
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set((state) => ({ drawerOpen: !state.drawerOpen })),
  collapsedTitle: null,
  setCollapsedTitle: (title) => set({ collapsedTitle: title }),
}));
