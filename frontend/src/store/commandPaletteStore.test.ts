import { describe, it, expect, beforeEach } from 'vitest';
import { useCommandPaletteStore } from './commandPaletteStore';

beforeEach(() => {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
});

describe('commandPaletteStore', () => {
  it('opens and closes', () => {
    useCommandPaletteStore.getState().openPalette();
    expect(useCommandPaletteStore.getState().open).toBe(true);
    useCommandPaletteStore.getState().closePalette();
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('tells a request with no payee from no request', () => {
    expect(useCommandPaletteStore.getState().newTransactionRequest).toBeNull();
    useCommandPaletteStore.getState().requestNewTransaction();
    expect(useCommandPaletteStore.getState().newTransactionRequest).toEqual({ payee: null });
  });

  it('carries the payee until cleared', () => {
    const payee = { id: 'p1', name: 'Hydro One', defaultCategoryId: null };
    useCommandPaletteStore.getState().requestNewTransaction(payee);
    expect(useCommandPaletteStore.getState().newTransactionRequest).toEqual({ payee });
    useCommandPaletteStore.getState().clearNewTransactionRequest();
    expect(useCommandPaletteStore.getState().newTransactionRequest).toBeNull();
  });
});
