import { create } from 'zustand';

/** The payee a palette action asked a new transaction to start from. */
export interface NewTransactionPayee {
  id: string;
  name: string;
  defaultCategoryId: string | null;
}

/**
 * Whether the command palette is open, and the one-shot "open the new
 * transaction form" request a palette action leaves for the Transactions page.
 *
 * The request travels here rather than in the URL because it carries a whole
 * payee, must work while the page is already mounted, and must not reopen the
 * form when the reader later comes back to that history entry.
 */
interface CommandPaletteState {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
  /** `null` is no request; `{ payee: null }` is a new transaction with no payee. */
  newTransactionRequest: { payee: NewTransactionPayee | null } | null;
  requestNewTransaction: (payee?: NewTransactionPayee) => void;
  clearNewTransactionRequest: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false }),
  newTransactionRequest: null,
  requestNewTransaction: (payee) => set({ newTransactionRequest: { payee: payee ?? null } }),
  clearNewTransactionRequest: () => set({ newTransactionRequest: null }),
}));
