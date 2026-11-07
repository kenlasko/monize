import { describe, it, expect, beforeEach } from 'vitest';
import { useHelpSearchStore } from './helpSearchStore';

beforeEach(() => {
  useHelpSearchStore.setState(useHelpSearchStore.getInitialState(), true);
});

describe('helpSearchStore', () => {
  it('starts closed', () => {
    expect(useHelpSearchStore.getState().open).toBe(false);
  });

  it('opens and closes', () => {
    useHelpSearchStore.getState().openSearch();
    expect(useHelpSearchStore.getState().open).toBe(true);
    useHelpSearchStore.getState().closeSearch();
    expect(useHelpSearchStore.getState().open).toBe(false);
  });
});
