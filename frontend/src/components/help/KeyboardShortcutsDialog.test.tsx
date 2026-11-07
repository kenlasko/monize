import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';

beforeEach(() => {
  useHelpShortcutsStore.setState({ open: true });
});

describe('KeyboardShortcutsDialog', () => {
  it('lists the global shortcuts', () => {
    render(<KeyboardShortcutsDialog />);
    expect(screen.getByText('Search help')).toBeInTheDocument();
    expect(screen.getByText('Ctrl/Cmd+K or ?')).toBeInTheDocument();
    expect(screen.getByText('Undo the last change')).toBeInTheDocument();
    expect(screen.getByText('Ctrl/Cmd+Z')).toBeInTheDocument();
    expect(screen.getByText('Redo')).toBeInTheDocument();
    expect(screen.getByText('Close the open dialog or panel')).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(<KeyboardShortcutsDialog />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useHelpShortcutsStore.getState().open).toBe(false);
  });
});
