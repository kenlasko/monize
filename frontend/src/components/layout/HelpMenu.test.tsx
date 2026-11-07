import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent } from '@/test/render';
import { HelpMenu } from './HelpMenu';
import { useHelpMenuEntries } from '@/hooks/useHelpMenuEntries';
import { useAuthStore } from '@/store/authStore';
import { useHelpStore } from '@/store/helpStore';
import { useHelpSearchStore } from '@/store/helpSearchStore';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';
import { useTourStore } from '@/store/tourStore';
import { useWhatsNewStore } from '@/store/whatsNewStore';

// email-receipts/basics (requiresData: 'ownerView') is the only
// requirements-gated tour mapped in lib/help-tours.ts, so resolving it always
// touches the account/securities lookups resolveTourRequirements batches
// together -- mocked here even though this file's own gating test only cares
// about the synchronous ownerView field.
const getAllAccounts = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: () => getAllAccounts() },
}));
const getSecurities = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurities: () => getSecurities() },
}));

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  useHelpSearchStore.setState({ open: false });
  useHelpShortcutsStore.setState({ open: false });
  useTourStore.setState({ active: null, progress: {}, progressLoaded: false });
  useWhatsNewStore.setState({ isOpen: false, pausedForTour: false, backendVersion: undefined });
  useAuthStore.setState({ actingAsUserId: null });
});

/** `AppHeader` builds entries once and passes them down; mirror that here. */
function openMenu() {
  const { result } = renderHook(() => useHelpMenuEntries());
  render(<HelpMenu entries={result.current} />);
  fireEvent.click(screen.getByRole('button', { name: 'Help' }));
}

/** For a page whose mapped tour is gated: lets the requirements lookup settle
 *  before the menu reads the resolved entries, like `openMenu` does for the
 *  synchronous (ungated) cases. */
async function openMenuAsync() {
  const { result } = renderHook(() => useHelpMenuEntries());
  await act(async () => {});
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

  it('falls back to the introduction tour when the mapped tour\'s data requirement is not met', async () => {
    // email-receipts/basics requires ownerView; a delegate session does not
    // have it, so "Take the tour" must offer the evergreen intro instead.
    useAuthStore.setState({ actingAsUserId: 'delegate-user-id' });
    useHelpStore.getState().setContextPage('email-receipts');
    await openMenuAsync();
    fireEvent.click(screen.getByText('Take the tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('offers the mapped tour once ownerView resolves true for the owner', async () => {
    useHelpStore.getState().setContextPage('email-receipts');
    await openMenuAsync();
    fireEvent.click(screen.getByText('Take the tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('email-receipts/basics');
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
