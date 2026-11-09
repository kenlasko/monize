import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@/test/render';

vi.mock('next/dynamic', () => ({
  default: () =>
    function Dynamic() {
      return <div data-testid="command-palette" />;
    },
}));

import { CommandPaletteShortcut } from './CommandPaletteShortcut';
import { useAuthStore } from '@/store/authStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useHelpSearchStore } from '@/store/helpSearchStore';

function keydown(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

beforeEach(() => {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useHelpSearchStore.setState(useHelpSearchStore.getInitialState(), true);
  useAuthStore.setState({ isAuthenticated: true });
  window.history.replaceState(null, '', '/dashboard');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CommandPaletteShortcut', () => {
  it('renders nothing while closed', () => {
    render(<CommandPaletteShortcut />);
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('opens on %o+K and claims the key', (modifier) => {
    render(<CommandPaletteShortcut />);
    expect(keydown({ key: 'k', ...modifier })).toBe(true);
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('opens from inside a text field', () => {
    render(<CommandPaletteShortcut />);
    const input = document.body.appendChild(document.createElement('input'));
    keydown({ key: 'K', ctrlKey: true }, input);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('closes when pressed again', () => {
    render(<CommandPaletteShortcut />);
    keydown({ key: 'k', ctrlKey: true });
    keydown({ key: 'k', ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('opens help search instead over another dialog, because results navigate', () => {
    render(<CommandPaletteShortcut />);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('aria-modal', 'true');
    keydown({ key: 'k', ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useHelpSearchStore.getState().open).toBe(true);
  });

  it('opens help search for a signed-out visitor', () => {
    useAuthStore.setState({ isAuthenticated: false });
    render(<CommandPaletteShortcut />);
    keydown({ key: 'k', ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useHelpSearchStore.getState().open).toBe(true);
  });

  it('opens help search on a public page even with a stored session', () => {
    window.history.replaceState(null, '', '/emergency-access/claim');
    render(<CommandPaletteShortcut />);
    keydown({ key: 'k', ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useHelpSearchStore.getState().open).toBe(true);
  });

  it('does not toggle on key repeat', () => {
    render(<CommandPaletteShortcut />);
    keydown({ key: 'k', ctrlKey: true });
    expect(keydown({ key: 'k', ctrlKey: true, repeat: true })).toBe(true);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('ignores a plain k', () => {
    render(<CommandPaletteShortcut />);
    expect(keydown({ key: 'k' })).toBe(false);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});
