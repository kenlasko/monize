import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { MobileTabsGroup } from './MobileTabsGroup';

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ actingAsUserId: null, delegateCapabilities: null, delegateSections: null }),
}));

const commit = vi.fn();

function slot(number: number) {
  return screen.getByLabelText(`Tab ${number}`) as HTMLSelectElement;
}

describe('MobileTabsGroup', () => {
  beforeEach(() => {
    commit.mockReset();
  });

  it('shows the built-in tabs when none are stored', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    expect([slot(1).value, slot(2).value, slot(3).value]).toEqual([
      'dashboard',
      'transactions',
      'accounts',
    ]);
  });

  it('does not offer More as a choice', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    const labels = Array.from(slot(1).options).map((o) => o.textContent);
    expect(labels).toContain('Budgets');
    expect(labels).not.toContain('More');
  });

  it('saves the whole list when a place changes', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    fireEvent.change(slot(3), { target: { value: 'budgets' } });
    expect(commit.mock.calls[0][0]).toEqual({
      viewDefaults: { mobileTabs: ['dashboard', 'transactions', 'budgets'] },
    });
  });

  it('swaps instead of listing a tab twice', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    fireEvent.change(slot(1), { target: { value: 'accounts' } });
    expect(commit.mock.calls[0][0]).toEqual({
      viewDefaults: { mobileTabs: ['accounts', 'transactions', 'dashboard'] },
    });
  });

  it('lets a place be emptied', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    fireEvent.change(slot(2), { target: { value: '' } });
    expect(commit.mock.calls[0][0]).toEqual({
      viewDefaults: { mobileTabs: ['dashboard', 'accounts'] },
    });
    expect(slot(3).value).toBe('');
  });

  it('writes nothing when the value is unchanged', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    fireEvent.change(slot(1), { target: { value: 'dashboard' } });
    expect(commit).not.toHaveBeenCalled();
  });

  it('puts the previous list back when the save fails', () => {
    render(<MobileTabsGroup initial={undefined} commit={commit} />);
    fireEvent.change(slot(3), { target: { value: 'budgets' } });
    expect(slot(3).value).toBe('budgets');
    act(() => commit.mock.calls[0][1]());
    expect(slot(3).value).toBe('accounts');
  });

  describe('what the + button opens', () => {
    const addOpens = () => screen.getByLabelText('The + button opens') as HTMLSelectElement;

    it('shows Quick Add when nothing is stored, and the stored choice otherwise', () => {
      const { unmount } = render(<MobileTabsGroup initial={undefined} commit={commit} />);
      expect(addOpens().value).toBe('quickAdd');
      expect(Array.from(addOpens().options).map((o) => o.textContent)).toEqual([
        'Quick Add',
        'New Transaction form',
      ]);
      unmount();
      render(<MobileTabsGroup initial={{ mobileAddOpens: 'fullForm' }} commit={commit} />);
      expect(addOpens().value).toBe('fullForm');
    });

    it('saves the choice alone, leaving the tabs as they are', () => {
      render(<MobileTabsGroup initial={{ mobileTabs: ['bills'] }} commit={commit} />);
      fireEvent.change(addOpens(), { target: { value: 'fullForm' } });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0][0]).toEqual({ viewDefaults: { mobileAddOpens: 'fullForm' } });
      expect(addOpens().value).toBe('fullForm');
    });

    it('writes nothing when the choice is unchanged', () => {
      render(<MobileTabsGroup initial={undefined} commit={commit} />);
      fireEvent.change(addOpens(), { target: { value: 'quickAdd' } });
      expect(commit).not.toHaveBeenCalled();
    });

    it('puts the previous choice back when the save fails', () => {
      render(<MobileTabsGroup initial={{ mobileAddOpens: 'fullForm' }} commit={commit} />);
      fireEvent.change(addOpens(), { target: { value: 'quickAdd' } });
      expect(addOpens().value).toBe('quickAdd');
      act(() => commit.mock.calls[0][1]());
      expect(addOpens().value).toBe('fullForm');
    });
  });
});
