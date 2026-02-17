import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import ResetPasswordPage from './page';

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/reset-password',
  useSearchParams: () => mockSearchParams,
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const mockResetPassword = vi.fn();

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    resetPassword: (...args: any[]) => mockResetPassword(...args),
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
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

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams('token=valid-reset-token');
    mockResetPassword.mockResolvedValue(undefined);
  });

  it('renders the page heading', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('Set new password')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('Enter your new password below.')).toBeInTheDocument();
  });

  it('renders the Monize logo', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByAltText('Monize')).toBeInTheDocument();
  });

  it('renders the new password field when token is present', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('New Password')).toBeInTheDocument();
  });

  it('renders the confirm password field when token is present', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('Confirm Password')).toBeInTheDocument();
  });

  it('renders the submit button when token is present', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('Reset password')).toBeInTheDocument();
  });

  it('renders back to sign in link', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('Back to sign in')).toBeInTheDocument();
  });

  it('shows error message when token is missing', () => {
    mockSearchParams = new URLSearchParams();

    render(<ResetPasswordPage />);
    expect(screen.getByText('Invalid or missing reset token.')).toBeInTheDocument();
  });

  it('shows request new link when token is missing', () => {
    mockSearchParams = new URLSearchParams();

    render(<ResetPasswordPage />);
    expect(screen.getByText('Request a new reset link')).toBeInTheDocument();
  });

  it('does not show password fields when token is missing', () => {
    mockSearchParams = new URLSearchParams();

    render(<ResetPasswordPage />);
    expect(screen.queryByText('New Password')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirm Password')).not.toBeInTheDocument();
  });
});
