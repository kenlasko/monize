import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import Setup2FAPage from './page';

const mockPush = vi.fn();

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/setup-2fa',
  useSearchParams: () => new URLSearchParams(),
}));

// Track preferences mock state
let mockPreferences = { twoFactorEnabled: false, theme: 'system', defaultCurrency: 'USD' };

// Mock preferences store
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

// Mock TwoFactorSetup component
vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: ({ isForced }: any) => (
    <div data-testid="two-factor-setup" data-forced={isForced}>
      TwoFactorSetup
    </div>
  ),
}));

describe('Setup2FAPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferences = { twoFactorEnabled: false, theme: 'system', defaultCurrency: 'USD' };
  });

  it('renders the 2FA setup heading', () => {
    render(<Setup2FAPage />);
    expect(screen.getByText('Set Up Two-Factor Authentication')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    render(<Setup2FAPage />);
    expect(
      screen.getByText('Two-factor authentication is required by the administrator before you can continue.'),
    ).toBeInTheDocument();
  });

  it('renders the TwoFactorSetup component', () => {
    render(<Setup2FAPage />);
    expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
  });

  it('passes isForced prop to TwoFactorSetup', () => {
    render(<Setup2FAPage />);
    expect(screen.getByTestId('two-factor-setup')).toHaveAttribute('data-forced', 'true');
  });

  it('redirects to dashboard if 2FA is already enabled', () => {
    mockPreferences = { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD' };

    const { container } = render(<Setup2FAPage />);
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
    expect(container.innerHTML).toBe('');
  });

  it('does not redirect when 2FA is not enabled', () => {
    render(<Setup2FAPage />);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
