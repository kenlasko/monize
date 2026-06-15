import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import VerifyEmailPage from './page';

const mockVerifyEmail = vi.fn();
const mockResendVerification = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/verify-email',
  useSearchParams: () => mockSearchParams,
}));

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    verifyEmail: (...args: any[]) => mockVerifyEmail(...args),
    resendVerification: (...args: any[]) => mockResendVerification(...args),
  },
}));

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

vi.mock('@/components/ui/Input', () => ({
  Input: ({ label, error, ...props }: any) => (
    <div>
      <label>{label}</label>
      <input aria-label={label} {...props} />
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

async function renderPage() {
  await act(async () => {
    render(<VerifyEmailPage />);
  });
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams('token=valid-verify-token');
    mockVerifyEmail.mockResolvedValue(undefined);
    mockResendVerification.mockResolvedValue({ message: 'ok' });
  });

  it('verifies the token on mount and shows the success message', async () => {
    await renderPage();

    await waitFor(() => {
      expect(mockVerifyEmail).toHaveBeenCalledWith('valid-verify-token');
      expect(
        screen.getByText(/your email address has been verified/i),
      ).toBeInTheDocument();
    });
  });

  it('shows the error and resend form when verification fails, then confirms the resend', async () => {
    mockVerifyEmail.mockRejectedValueOnce(new Error('expired'));

    await renderPage();

    await waitFor(() => {
      expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Email address'), {
        target: { value: 'user@example.com' },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /resend verification email/i }),
      );
    });

    await waitFor(() => {
      expect(mockResendVerification).toHaveBeenCalledWith('user@example.com');
      expect(screen.getByText(/we've sent a new link/i)).toBeInTheDocument();
    });
  });

  it('does not call verify and shows the resend form when no token is present', async () => {
    mockSearchParams = new URLSearchParams();

    await renderPage();

    await waitFor(() => {
      expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    });
    expect(mockVerifyEmail).not.toHaveBeenCalled();
  });
});
