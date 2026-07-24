import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@/test/render';
import { GettingStarted } from './GettingStarted';
import { useTourStore } from '@/store/tourStore';
import { useDemoStore } from '@/store/demoStore';

const mockUpdatePreferences = vi.fn();

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      preferences: { gettingStartedDismissed: false },
      updatePreferences: mockUpdatePreferences,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: { updatePreferences: vi.fn().mockResolvedValue({}) },
}));

describe('GettingStarted', () => {
  it('renders getting started steps', () => {
    render(<GettingStarted />);
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('Review your settings')).toBeInTheDocument();
    expect(screen.getByText('Set up categories')).toBeInTheDocument();
    expect(screen.getByText('Add your first account')).toBeInTheDocument();
    expect(screen.getByText('Import from QIF')).toBeInTheDocument();
  });

  it('renders links to appropriate pages', () => {
    render(<GettingStarted />);
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/settings');
    expect(hrefs).toContain('/categories');
    expect(hrefs).toContain('/accounts');
    expect(hrefs).toContain('/import');
  });

  it('calls updatePreferences on dismiss', () => {
    render(<GettingStarted />);
    const dismissBtn = screen.getByTitle('Dismiss');
    fireEvent.click(dismissBtn);
    expect(mockUpdatePreferences).toHaveBeenCalledWith({ gettingStartedDismissed: true });
  });
});

describe('GettingStarted tour CTA', () => {
  beforeEach(() => {
    useTourStore.setState({ active: null, progress: {}, progressLoaded: true });
    useDemoStore.setState({ isDemoMode: false });
  });
  afterEach(() => cleanup());

  it('starts the introduction tour from the CTA', () => {
    render(<GettingStarted />);
    fireEvent.click(screen.getByText('Take the tour'));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('flips to "Retake the tour" once the intro is completed', () => {
    useTourStore.setState({
      progress: { 'intro/basics': { status: 'completed', updatedAt: 'now' } },
    });
    render(<GettingStarted />);
    expect(screen.getByText('Retake the tour')).toBeInTheDocument();
  });

  it('hides the CTA in demo mode', () => {
    useDemoStore.setState({ isDemoMode: true });
    render(<GettingStarted />);
    expect(screen.queryByText('Take the tour')).toBeNull();
  });
});
