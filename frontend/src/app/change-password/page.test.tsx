import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import ChangePasswordPage from './page';

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
  usePathname: () => '/change-password',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Track auth store state so tests can modify it
let mockUser: any = {
  id: 'test-user-id',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  role: 'user',
  hasPassword: true,
  mustChangePassword: true,
};

const mockSetUser = vi.fn();

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: mockUser,
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        setUser: mockSetUser,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: mockUser,
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

// Mock user settings API
const mockChangePassword = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    changePassword: (...args: any[]) => mockChangePassword(...args),
  },
}));

// Mock auth API
const mockGetProfile = vi.fn().mockResolvedValue({
  id: 'test-user-id',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  role: 'user',
  hasPassword: true,
  mustChangePassword: false,
});

vi.mock('@/lib/auth', () => ({
  authApi: {
    getProfile: (...args: any[]) => mockGetProfile(...args),
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
  },
}));

// Mock zodResolver
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: (schema: any) => {
    return async (data: any) => {
      try {
        const result = schema.parse(data);
        return { values: result, errors: {} };
      } catch (error: any) {
        const fieldErrors: any = {};
        if (error.errors) {
          for (const err of error.errors) {
            const path = err.path.join('.');
            if (!fieldErrors[path]) {
              fieldErrors[path] = { type: 'validation', message: err.message };
            }
          }
        }
        return { values: {}, errors: fieldErrors };
      }
    };
  },
}));

// Mock UI components
vi.mock('@/components/ui/Input', () => ({
  Input: ({ label, error, ...props }: any) => (
    <div>
      <label>{label}</label>
      <input data-testid={`input-${label}`} aria-label={label} {...props} />
      {error && <span data-testid={`error-${label}`}>{error}</span>}
    </div>
  ),
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, isLoading, ...props }: any) => (
    <button {...props} disabled={isLoading}>
      {isLoading ? 'Loading...' : children}
    </button>
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (error: any, fallback: string) => fallback,
}));

describe('ChangePasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      role: 'user',
      hasPassword: true,
      mustChangePassword: true,
    };
  });

  it('renders the page heading', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByText('Change Your Password')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByText('Your password must be changed before you can continue.')).toBeInTheDocument();
  });

  it('renders current password field', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByText('Current Password')).toBeInTheDocument();
  });

  it('renders new password field', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByText('New Password')).toBeInTheDocument();
  });

  it('renders confirm password field', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByText('Confirm New Password')).toBeInTheDocument();
  });

  it('renders password requirements text', () => {
    render(<ChangePasswordPage />);
    expect(
      screen.getByText(/Password must be at least 8 characters/),
    ).toBeInTheDocument();
  });

  it('renders the submit button', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByText('Change Password')).toBeInTheDocument();
  });

  it('renders the Monize logo', () => {
    render(<ChangePasswordPage />);
    expect(screen.getByAltText('Monize')).toBeInTheDocument();
  });

  it('redirects to dashboard if user does not need to change password', () => {
    mockUser = {
      ...mockUser,
      mustChangePassword: false,
    };

    const { container } = render(<ChangePasswordPage />);
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
    expect(container.innerHTML).toBe('');
  });

  it('does not redirect when user must change password', () => {
    render(<ChangePasswordPage />);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
