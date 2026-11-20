import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@/test/render';
import { useMainAccountName, useAccountOptionLabel } from './useMainAccountName';
import { Account } from '@/types/account';
import { usePreferencesStore } from '@/store/preferencesStore';

const cashHalf = {
  id: 'cash',
  name: 'TFSA - Cash',
  currencyCode: 'CAD',
  isClosed: false,
} as Account;

describe('useMainAccountName', () => {
  it('strips the pair suffixes', () => {
    const { result } = renderHook(() => useMainAccountName());

    expect(result.current('TFSA - Brokerage')).toBe('TFSA');
    expect(result.current('TFSA - Cash')).toBe('TFSA');
    expect(result.current('Chequing')).toBe('Chequing');
  });

  // The stripper is a dependency of memos and effects across the reports and
  // the account surfaces. Keyed on `t` it changed identity every render, so
  // every memo built on it recomputed and every effect depending on one re-ran.
  it('keeps a stable identity across renders', () => {
    const { result, rerender } = renderHook(() => useMainAccountName());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});

describe('useAccountOptionLabel', () => {
  beforeEach(() => {
    // A USD user, so the CAD fixture is a foreign-currency account.
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'USD' } as never,
      isLoaded: true,
    });
  });

  it('leaves the currency off an account in the default currency', () => {
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'CAD' } as never,
      isLoaded: true,
    });
    const { result } = renderHook(() => useAccountOptionLabel());

    expect(result.current(cashHalf)).toBe('TFSA');
    expect(
      result.current({ ...cashHalf, id: 'usd', name: 'US Chequing', currencyCode: 'USD' }),
    ).toBe('US Chequing (USD)');
  });

  it('labels an option with the entity name and currency, suffix stripped', () => {
    const { result } = renderHook(() => useAccountOptionLabel());

    expect(result.current(cashHalf)).toBe('TFSA (CAD)');
  });

  it('marks a closed account with the translated status word', () => {
    const { result } = renderHook(() => useAccountOptionLabel());

    expect(result.current({ ...cashHalf, isClosed: true })).toBe(
      'TFSA (CAD) (Closed)',
    );
  });

  it('keeps a stable identity across renders', () => {
    const { result, rerender } = renderHook(() => useAccountOptionLabel());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
  // Money pickers list the cash half of a pair -- that is where the money
  // lands -- so without stripping they offer "TFSA - Cash" while every other
  // surface calls the same account "TFSA".
  it('reads a linked cash half as the account the user knows', () => {
    const { result } = renderHook(() => useAccountOptionLabel());

    expect(result.current(cashHalf)).not.toContain(' - Cash');
    expect(result.current(cashHalf)).toContain('TFSA');
  });

  it('drops the currency for narrow rows that ask for it', () => {
    const { result } = renderHook(
      () => useAccountOptionLabel({ withCurrency: false }),
          );

    expect(result.current(cashHalf)).toBe('TFSA');
  });
});
