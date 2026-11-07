import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderHook, screen, fireEvent } from '@/test/render';
import { HelpMenu } from './HelpMenu';
import { useHelpMenuEntries } from '@/hooks/useHelpMenuEntries';
import { useHelpStore } from '@/store/helpStore';
import { useHelpSearchStore } from '@/store/helpSearchStore';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';
import { useTourStore } from '@/store/tourStore';
import { useWhatsNewStore } from '@/store/whatsNewStore';

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  useHelpSearchStore.setState({ open: false });
  useHelpShortcutsStore.setState({ open: false });
  useTourStore.setState({ active: null, progress: {}, progressLoaded: false });
  useWhatsNewStore.setState({ isOpen: false, pausedForTour: false, backendVersion: undefined });
});

/** `AppHeader` builds entries once and passes them down; mirror that here. */
function openMenu() {
  const { result } = renderHook(() => useHelpMenuEntries());
  render(<HelpMenu entries={result.current} />);
  fireEvent.click(screen.getByRole('button', { name: 'Help' }));
}

describe('HelpMenu', () => {
  it('hides "Help for this page" when the current page registered no help key', () => {
    openMenu();
    expect(screen.queryByText('Help for this page')).not.toBeInTheDocument();
  });

  it('shows and opens the panel for "Help for this page" when one is registered', () => {
    useHelpStore.getState().setContextPage('budgets');
    openMenu();
    fireEvent.click(screen.getByText('Help for this page'));
    const state = useHelpStore.getState();
    expect(state.open).toBe(true);
    expect(state.history[state.cursor]).toEqual({ page: 'budgets' });
  });

  it('opens help search', () => {
    openMenu();
    fireEvent.click(screen.getByText('Search help'));
    expect(useHelpSearchStore.getState().open).toBe(true);
  });

  it('opens the keyboard shortcuts dialog', () => {
    openMenu();
    fireEvent.click(screen.getByText('Keyboard shortcuts'));
    expect(useHelpShortcutsStore.getState().open).toBe(true);
  });

  it('starts the introduction tour when the page has no mapped tour', () => {
    openMenu();
    fireEvent.click(screen.getByText('Take the tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('starts the dashboard page\'s mapped tour', () => {
    useHelpStore.getState().setContextPage('dashboard');
    openMenu();
    fireEvent.click(screen.getByText('Take the tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('opens the What\'s New modal', () => {
    openMenu();
    fireEvent.click(screen.getByText("What's new"));
    expect(useWhatsNewStore.getState().isOpen).toBe(true);
  });

  it('links Report an issue and Discussions to GitHub, opened in a new tab', () => {
    openMenu();
    const reportIssue = screen.getByText('Report an issue').closest('a');
    expect(reportIssue).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/issues/new',
    );
    expect(reportIssue).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Discussions').closest('a')).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/discussions',
    );
  });

  it('closes the menu after an action', () => {
    openMenu();
    fireEvent.click(screen.getByText('Search help'));
    expect(screen.queryByText('Search help')).not.toBeInTheDocument();
  });
});
