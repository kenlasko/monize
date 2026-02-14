import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import Setup2FAPage from './page';

const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/setup-2fa',
  useSearchParams: () => new URLSearchParams(),
}));

let mockPreferences: any = { twoFactorEnabled: false, theme: 'system' };

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: mockPreferences,
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: ({ isForced, onComplete }: any) => (
    <div data-testid="two-factor-setup">
      <span data-testid="is-forced">{isForced ? 'forced' : 'optional'}</span>
      <button onClick={onComplete}>Complete Setup</button>
    </div>
  ),
}));

describe('Setup2FAPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferences = { twoFactorEnabled: false, theme: 'system' };
  });

  it('renders setup page title', () => {
    render(<Setup2FAPage />);
    expect(screen.getByText('Set Up Two-Factor Authentication')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    render(<Setup2FAPage />);
    expect(screen.getByText(/required by the administrator/)).toBeInTheDocument();
  });

  it('renders TwoFactorSetup component with isForced prop', () => {
    render(<Setup2FAPage />);
    expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
    expect(screen.getByTestId('is-forced')).toHaveTextContent('forced');
  });

  it('redirects to dashboard when 2FA is already enabled', async () => {
    mockPreferences = { twoFactorEnabled: true, theme: 'system' };
    render(<Setup2FAPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('does not render setup component when 2FA is already enabled', () => {
    mockPreferences = { twoFactorEnabled: true, theme: 'system' };
    const { container } = render(<Setup2FAPage />);
    expect(container.querySelector('[data-testid="two-factor-setup"]')).toBeNull();
  });

  it('navigates to dashboard on setup completion', () => {
    render(<Setup2FAPage />);
    screen.getByText('Complete Setup').click();
    expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
  });
});
