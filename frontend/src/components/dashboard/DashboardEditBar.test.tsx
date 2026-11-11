import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { DashboardEditBar } from './DashboardEditBar';

function renderBar(over: Partial<Parameters<typeof DashboardEditBar>[0]> = {}) {
  const props = {
    onAddWidget: vi.fn(),
    onHeroSettings: vi.fn(),
    onReset: vi.fn(),
    onCancel: vi.fn(),
    onDone: vi.fn(),
    doneDisabled: false,
    saving: false,
    ...over,
  };
  render(<DashboardEditBar {...props} />);
  return props;
}

describe('DashboardEditBar', () => {
  it('is a named region holding the five actions, each wired to its handler', () => {
    const props = renderBar();
    expect(screen.getByRole('region', { name: 'Arrange the dashboard' })).toBeInTheDocument();
    const pairs: [string, keyof typeof props][] = [
      ['Add Widget', 'onAddWidget'],
      ['Hero Settings', 'onHeroSettings'],
      ['Reset to default', 'onReset'],
      ['Cancel', 'onCancel'],
      ['Done', 'onDone'],
    ];
    for (const [name, handler] of pairs) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(props[handler]).toHaveBeenCalledTimes(1);
    }
  });

  it('sticks under the pinned header, following it as it slides away', () => {
    renderBar();
    const bar = screen.getByTestId('dashboard-edit-bar');
    expect(bar).toHaveClass('sticky', 'z-20');
    expect(bar.className).toContain('top-[calc(4rem+env(safe-area-inset-top)-var(--app-header-offset,0px))]');
  });

  it('wraps on a phone by the toolbar rule, Cancel and Done sharing the last line', () => {
    renderBar();
    const done = screen.getByRole('button', { name: 'Done' });
    const trailing = done.parentElement as HTMLElement;
    expect(trailing).toHaveClass('w-full', 'sm:w-auto', 'sm:ml-auto');
    expect(trailing.parentElement).toHaveClass('flex-wrap');
    expect(done).toHaveClass('flex-1', 'sm:flex-none');
    expect(trailing).toContainElement(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('says below lg that sizes apply on wider screens', () => {
    renderBar();
    expect(screen.getByText('Widget sizes apply on wider screens.')).toHaveClass('lg:hidden');
  });

  it('disables Done when there is nothing to store, and every action while saving', () => {
    renderBar({ doneDisabled: true });
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('holds every action while a save is in flight', () => {
    renderBar({ saving: true });
    for (const name of ['Add Widget', 'Hero Settings', 'Reset to default', 'Cancel', 'Done']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});
