import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { PreferencesLoader } from './PreferencesLoader';

const mockLoadPreferences = vi.fn();
const mockClearPreferences = vi.fn();
const mockSetTheme = vi.fn();

// Mock useTheme
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: mockSetTheme,
  }),
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => {
    const state = {
      isAuthenticated: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => {
    const state = {
      preferences: { theme: 'dark' },
      isLoaded: false,
      _hasHydrated: true,
      loadPreferences: mockLoadPreferences,
      clearPreferences: mockClearPreferences,
    };
    return selector ? selector(state) : state;
  },
}));

describe('PreferencesLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children', () => {
    render(
      <PreferencesLoader>
        <div data-testid="child">Child content</div>
      </PreferencesLoader>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('calls loadPreferences when authenticated and not yet loaded', () => {
    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );
    expect(mockLoadPreferences).toHaveBeenCalled();
  });

  it('syncs theme when preferences have a theme value', () => {
    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });
});
