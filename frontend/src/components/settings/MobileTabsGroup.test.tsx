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
});
