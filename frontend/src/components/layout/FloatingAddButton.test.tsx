import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { FloatingAddButton } from './FloatingAddButton';
import { useMobileAddActionStore } from '@/store/mobileAddActionStore';

const register = (choices: { key: string; label: string; run: () => void }[] | null, run = vi.fn()) =>
  act(() =>
    useMobileAddActionStore.getState().setAction({
      owner: Symbol('test'),
      label: 'New Account',
      run,
      choices: () => choices,
    }),
  );

describe('FloatingAddButton', () => {
  beforeEach(() => {
    useMobileAddActionStore.setState({ action: null });
  });

  it('draws nothing where the page registered no action', () => {
    render(<FloatingAddButton />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it("runs the page's own add action", () => {
    const run = vi.fn();
    render(<FloatingAddButton />);
    register(null, run);
    const button = screen.getByRole('button', { name: 'New Account' });
    expect(button).toHaveClass('rounded-full', 'bg-blue-600');
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('offers the choices as a menu when the page has several', () => {
    const cash = vi.fn();
    render(<FloatingAddButton />);
    register([
      { key: 'investment', label: 'Investment Transaction', run: vi.fn() },
      { key: 'cash', label: 'Cash Transaction', run: cash },
    ]);
    const trigger = screen.getByRole('button', { name: 'New Account' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Cash Transaction' }));
    expect(cash).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Investment Transaction' })).not.toBeInTheDocument();
  });
});
