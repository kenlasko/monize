import { describe, it, expect, beforeEach } from 'vitest';
import { useHelpStore, currentHelpTarget } from './helpStore';

const state = () => useHelpStore.getState();
const current = () => currentHelpTarget(state());

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

describe('helpStore', () => {
  it('does not know whether the guide is bundled until told, and keeps that across a close', () => {
    expect(state().guideAvailable).toBeNull();
    state().setGuideAvailable(true);
    state().openAt({ page: 'budgets' });
    state().close();
    expect(state().guideAvailable).toBe(true);
  });

  it('starts closed with no target', () => {
    expect(state().open).toBe(false);
    expect(current()).toBeNull();
  });

  it('opens at a target with a fresh history', () => {
    state().openAt({ page: 'budgets', section: 'alerts' });
    expect(state().open).toBe(true);
    expect(current()).toEqual({ page: 'budgets', section: 'alerts' });
    expect(state().history).toHaveLength(1);
  });

  it('starts a new history when it is reopened after a close', () => {
    state().openAt({ page: 'budgets' });
    state().navigate({ page: 'reports' });
    state().close();
    state().openAt({ page: 'tags' });
    expect(state().history).toEqual([{ page: 'tags' }]);
    expect(state().cursor).toBe(0);
  });

  it('moves to another page by pushing history', () => {
    state().openAt({ page: 'budgets' });
    state().openAt({ page: 'reports', section: 'budget-reports' });
    expect(state().history).toEqual([
      { page: 'budgets' },
      { page: 'reports', section: 'budget-reports' },
    ]);
    expect(state().cursor).toBe(1);
  });

  it('pushes an entry when only the section changes, so Back returns to the previous section', () => {
    state().openAt({ page: 'budgets' });
    state().navigate({ page: 'budgets', section: 'alerts' });
    state().navigate({ page: 'budgets', section: 'rollover-rules' });
    expect(state().history).toEqual([
      { page: 'budgets' },
      { page: 'budgets', section: 'alerts' },
      { page: 'budgets', section: 'rollover-rules' },
    ]);
    expect(state().cursor).toBe(2);

    state().back();
    expect(current()).toEqual({ page: 'budgets', section: 'alerts' });
    state().back();
    expect(current()).toEqual({ page: 'budgets' });
    state().forward();
    expect(current()).toEqual({ page: 'budgets', section: 'alerts' });
  });

  it('pushes when another help icon opens a different section of the page on screen', () => {
    state().openAt({ page: 'accounts', section: 'financial-institutions' });
    state().openAt({ page: 'accounts' });
    expect(state().history).toEqual([
      { page: 'accounts', section: 'financial-institutions' },
      { page: 'accounts' },
    ]);
  });

  it('does not add an entry for the target already on screen, but counts the visit', () => {
    state().openAt({ page: 'budgets', section: 'alerts' });
    const before = state().visit;
    state().navigate({ page: 'budgets', section: 'alerts' });
    expect(state().history).toHaveLength(1);
    expect(state().visit).toBe(before + 1);
  });

  it('goes back and forward through the history', () => {
    state().openAt({ page: 'a' });
    state().navigate({ page: 'b' });
    state().navigate({ page: 'c' });
    state().back();
    expect(current()).toEqual({ page: 'b' });
    state().back();
    expect(current()).toEqual({ page: 'a' });
    state().back();
    expect(current()).toEqual({ page: 'a' });
    state().forward();
    expect(current()).toEqual({ page: 'b' });
    state().forward();
    state().forward();
    expect(current()).toEqual({ page: 'c' });
  });

  it('drops the entries ahead of the cursor when a link is followed after going back', () => {
    state().openAt({ page: 'a' });
    state().navigate({ page: 'b' });
    state().navigate({ page: 'c' });
    state().back();
    state().navigate({ page: 'd' });
    expect(state().history).toEqual([{ page: 'a' }, { page: 'b' }, { page: 'd' }]);
  });

  it('counts a visit when stepping through the history so the panel rescrolls', () => {
    state().openAt({ page: 'a' });
    state().navigate({ page: 'b' });
    const before = state().visit;
    state().back();
    expect(state().visit).toBe(before + 1);
  });

  it('clears pin and expanded state on close', () => {
    state().openAt({ page: 'a' });
    state().setPinned(true);
    state().setExpanded(true);
    state().close();
    expect(state()).toMatchObject({ open: false, pinned: false, expanded: false });
  });
});
