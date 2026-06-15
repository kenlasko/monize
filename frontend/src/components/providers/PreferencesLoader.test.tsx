import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { PreferencesLoader } from './PreferencesLoader';
import { detectBrowserLocale } from '@/i18n/config';

const mockLoadPreferences = vi.fn();
const mockClearPreferences = vi.fn();
const mockStoreUpdate = vi.fn();
const mockSetTheme = vi.fn();
const mockSetColorTheme = vi.fn();
const mockApiUpdatePreferences = vi.fn();
const mockRefresh = vi.fn();

// Mock useTheme
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: mockSetTheme,
    colorTheme: 'default',
    setColorTheme: mockSetColorTheme,
  }),
}));

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>(
    'next/navigation',
  );
  return {
    ...actual,
    useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
  };
});

vi.mock('js-cookie', () => ({
  default: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => mockApiUpdatePreferences(...args),
  },
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

let mockPreferences: Record<string, unknown>;

// Mock preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => {
    const state = {
      preferences: mockPreferences,
      isLoaded: false,
      _hasHydrated: true,
      loadPreferences: mockLoadPreferences,
      clearPreferences: mockClearPreferences,
      updatePreferences: mockStoreUpdate,
    };
    return selector ? selector(state) : state;
  },
}));

import Cookies from 'js-cookie';

describe('PreferencesLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockPreferences = { theme: 'dark', colorTheme: 'latte' };
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

  it('syncs colour theme when preferences have a valid colorTheme value', () => {
    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );
    expect(mockSetColorTheme).toHaveBeenCalledWith('latte');
  });

  it('reverts the locale cookie to the stored preference and refreshes', () => {
    mockPreferences = { ...mockPreferences, language: 'es' };
    vi.mocked(Cookies.get).mockReturnValue('en' as never);

    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );

    expect(Cookies.set).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      'es',
      expect.objectContaining({ sameSite: 'lax' }),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('resolves a "browser" language preference to the detected locale cookie', () => {
    mockPreferences = { ...mockPreferences, language: 'browser' };
    // Cookies.get returns undefined (cleared each test), so the cookie is set
    // to the detected locale rather than the 'browser' sentinel.
    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );

    expect(Cookies.set).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      detectBrowserLocale(),
      expect.objectContaining({ sameSite: 'lax' }),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('leaves the cookie alone when it already matches the stored preference', () => {
    mockPreferences = { ...mockPreferences, language: 'es' };
    vi.mocked(Cookies.get).mockReturnValue('es' as never);

    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );

    expect(Cookies.set).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('persists a deliberate pre-login language choice instead of reverting it', async () => {
    sessionStorage.setItem('preLoginLocale', 'fr');
    mockPreferences = { ...mockPreferences, language: 'es' };
    vi.mocked(Cookies.get).mockReturnValue('fr' as never);
    mockApiUpdatePreferences.mockResolvedValue({ language: 'fr' });

    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );

    await waitFor(() =>
      expect(mockApiUpdatePreferences).toHaveBeenCalledWith({ language: 'fr' }),
    );
    await waitFor(() =>
      expect(mockStoreUpdate).toHaveBeenCalledWith({ language: 'fr' }),
    );
    // The cookie already holds the chosen language; it must not be reverted
    // to the stored preference, and no refresh is needed.
    expect(Cookies.set).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('preLoginLocale')).toBeNull();
  });

  it('consumes the pre-login flag without saving when it matches the stored preference', () => {
    sessionStorage.setItem('preLoginLocale', 'es');
    mockPreferences = { ...mockPreferences, language: 'es' };
    vi.mocked(Cookies.get).mockReturnValue('es' as never);

    render(
      <PreferencesLoader>
        <div>Child</div>
      </PreferencesLoader>,
    );

    expect(mockApiUpdatePreferences).not.toHaveBeenCalled();
    expect(Cookies.set).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('preLoginLocale')).toBeNull();
  });
});
