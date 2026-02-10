import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { GettingStarted } from './GettingStarted';

const mockUpdatePreferences = vi.fn();

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: () => ({
    preferences: { gettingStartedDismissed: false },
    updatePreferences: mockUpdatePreferences,
  }),
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
