import { create } from 'zustand';

/** What the page's scrolled-away title leaves behind in the app header. */
export interface CollapsedHeaderTitle {
  title: string;
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
