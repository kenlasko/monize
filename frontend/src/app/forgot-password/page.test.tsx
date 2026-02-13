import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { fireEvent } from '@testing-library/react';
import ForgotPasswordPage from './page';

const mockReplace = vi.fn();

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: mockReplace,
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/forgot-password',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const mockGetAuthMethods = vi.fn();
const mockForgotPassword = vi.fn();

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: (...args: any[]) => mockGetAuthMethods(...args),
    forgotPassword: (...args: any[]) => mockForgotPassword(...args),
  },
}));

// Mock zodResolver
vi.mock('@/lib/zodResolver', () => ({
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

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthMethods.mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: true, force2fa: false,
    });
    mockForgotPassword.mockResolvedValue(undefined);
  });

  it('renders loading state initially while checking SMTP', () => {
    // Before getAuthMethods resolves, show loading
    mockGetAuthMethods.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ForgotPasswordPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders the page heading after SMTP check', async () => {
    render(<ForgotPasswordPage />);
    await waitFor(() => {
      expect(screen.getByText('Reset your password')).toBeInTheDocument();
    });
  });

  it('renders the description text', async () => {
    render(<ForgotPasswordPage />);
    await waitFor(() => {
      expect(
        screen.getByText(/Enter your email address and we/),
      ).toBeInTheDocument();
    });
  });

  it('renders the email input field', async () => {
    render(<ForgotPasswordPage />);
    await waitFor(() => {
      expect(screen.getByText('Email address')).toBeInTheDocument();
    });
  });

  it('renders the submit button', async () => {
    render(<ForgotPasswordPage />);
    await waitFor(() => {
      expect(screen.getByText('Send reset link')).toBeInTheDocument();
    });
  });

  it('renders the back to sign in link', async () => {
    render(<ForgotPasswordPage />);
    await waitFor(() => {
      expect(screen.getByText('Back to sign in')).toBeInTheDocument();
    });
  });

  it('renders the Monize logo', async () => {
    render(<ForgotPasswordPage />);
    await waitFor(() => {
      expect(screen.getByAltText('Monize')).toBeInTheDocument();
    });
  });

  it('redirects to login when SMTP is not configured', async () => {
    mockGetAuthMethods.mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    });

    render(<ForgotPasswordPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
  });

  it('redirects to login when local auth is not available', async () => {
    mockGetAuthMethods.mockResolvedValue({
      local: false, oidc: true, registration: true, smtp: true, force2fa: false,
    });

    render(<ForgotPasswordPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
  });

  it('shows success message after form submission', async () => {
    render(<ForgotPasswordPage />);

    await waitFor(() => {
      expect(screen.getByText('Send reset link')).toBeInTheDocument();
    });

    // Fill in the email field
    const emailInput = screen.getByTestId('input-Email address');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });

    // Submit the form
    const submitBtn = screen.getByText('Send reset link');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/If an account exists with that email address/),
      ).toBeInTheDocument();
    });
  });
});
