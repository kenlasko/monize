import { create } from 'zustand';

/** The payee a palette action asked a new transaction to start from. */
export interface NewTransactionPayee {
  id: string;
  name: string;
  defaultCategoryId: string | null;
}

/**
 * Whether the command palette is open, and the one-shot requests a palette
 * action leaves for the Transactions page: "open the new transaction form",
 * and "open Quick Add with this line".
 *
 * A request travels here rather than in the URL because it carries a whole
 * payee or a typed line, must work while the page is already mounted, and must
 * not reopen the dialog when the reader later comes back to that history entry.
 */
interface CommandPaletteState {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
  /** `null` is no request; `{ payee: null }` is a new transaction with no payee. */
  newTransactionRequest: { payee: NewTransactionPayee | null } | null;
  requestNewTransaction: (payee?: NewTransactionPayee) => void;
  clearNewTransactionRequest: () => void;
  /** `null` is no request; `text` is the line the palette read, read again by the page. */
  quickAddRequest: { text: string } | null;
  requestQuickAdd: (text: string) => void;
  clearQuickAddRequest: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false }),
  newTransactionRequest: null,
  requestNewTransaction: (payee) => set({ newTransactionRequest: { payee: payee ?? null } }),
  clearNewTransactionRequest: () => set({ newTransactionRequest: null }),
  quickAddRequest: null,
  requestQuickAdd: (text) => set({ quickAddRequest: { text } }),
  clearQuickAddRequest: () => set({ quickAddRequest: null }),
}));

/**
 * Opens the new transaction form, from anywhere. Already on the register, the
 * page answers the request itself; a push would stack on the form's own history
 * entry and drop the filters from the URL.
 */
export function startNewTransaction(
  pathname: string,
  push: (href: string) => void,
  payee?: NewTransactionPayee,
): void {
  useCommandPaletteStore.getState().requestNewTransaction(payee);
  if (pathname !== '/transactions') push('/transactions');
}

/**
 * Opens Quick Add with `text` in its box, from anywhere: the palette's "Quick
 * add" row, or the phone's + with an empty line where the reader chose Quick
 * Add for it. The dialog reads the line again in the register's own context,
 * so nothing but the text travels. Already on the register, the page answers
 * the request itself, as it does `startNewTransaction`'s.
 */
export function startQuickAdd(
  text: string,
  pathname: string,
  push: (href: string) => void,
): void {
  useCommandPaletteStore.getState().requestQuickAdd(text);
  if (pathname !== '/transactions') push('/transactions');
}
