import { describe, it, expect, beforeEach } from 'vitest';
import { HELP_PANEL_DEFAULT_WIDTH } from '@/components/help/help-layout';
import { HELP_WIDTH_STORAGE_KEY, useHelpWidthStore } from './helpWidthStore';

beforeEach(() => {
  window.localStorage.clear();
  useHelpWidthStore.setState({ width: HELP_PANEL_DEFAULT_WIDTH });
});

describe('helpWidthStore', () => {
  it('starts at the default width', () => {
    expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH);
  });

  it('stores the width as a whole number, and nothing else', () => {
    useHelpWidthStore.getState().setWidth(512.6);
    expect(JSON.parse(window.localStorage.getItem(HELP_WIDTH_STORAGE_KEY)!)).toEqual({
      state: { width: 513 },
      version: 0,
    });
  });

  it('reads the stored width back after a reload', async () => {
    window.localStorage.setItem(
      HELP_WIDTH_STORAGE_KEY,
      JSON.stringify({ state: { width: 700 }, version: 0 }),
    );
    await useHelpWidthStore.persist.rehydrate();
    expect(useHelpWidthStore.getState().width).toBe(700);
  });

  it('falls back to the default for an entry that is not a width', async () => {
    window.localStorage.setItem(
      HELP_WIDTH_STORAGE_KEY,
      JSON.stringify({ state: { width: 'wide' }, version: 0 }),
    );
    await useHelpWidthStore.persist.rehydrate();
    expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH);
  });
});
