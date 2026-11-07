import { describe, it, expect, beforeEach } from 'vitest';
import { useHelpShortcutsStore } from './helpShortcutsStore';

beforeEach(() => {
  useHelpShortcutsStore.setState(useHelpShortcutsStore.getInitialState(), true);
});

describe('helpShortcutsStore', () => {
  it('starts closed', () => {
    expect(useHelpShortcutsStore.getState().open).toBe(false);
  });

  it('opens and closes', () => {
    useHelpShortcutsStore.getState().openShortcuts();
    expect(useHelpShortcutsStore.getState().open).toBe(true);
    useHelpShortcutsStore.getState().closeShortcuts();
    expect(useHelpShortcutsStore.getState().open).toBe(false);
  });
});
