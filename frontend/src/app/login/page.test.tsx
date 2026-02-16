import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import LoginPage from './page';
import toast from 'react-hot-toast';

// Mock the auth API module
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    }),
    login: vi.fn(),
    initiateOidc: vi.fn(),
  },
  AuthMethods: {},
}));

// Mock the auth store
const mockLogin = vi.fn();
vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    login: mockLogin,
  })),
}));

// Mock the logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock TwoFactorVerify
vi.mock('@/components/auth/TwoFactorVerify', () => ({
  TwoFactorVerify: ({ onVerified, onCancel }: any) => (
    <div data-testid="two-factor-verify">
      TwoFactorVerify
      <button data-testid="verify-2fa" onClick={() => onVerified({ id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false })}>Verify</button>
      <button data-testid="cancel-2fa" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

// Import mocked modules to control them
import { authApi } from '@/lib/auth';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/login',
  useSearchParams: () => new URLSearchParams(),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogin.mockClear();
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });
  });

  it('renders the sign in heading', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText('Sign in to Monize')).toBeInTheDocument();
    });
  });

  it('renders email and password fields', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    });
  });

  it('renders sign in button', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
  });

  it('renders registration link when enabled', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/create a new account/i)).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    render(<LoginPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders SSO-only mode when only OIDC is available', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: true,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/Single Sign-On/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in with sso/i })).toBeInTheDocument();
    });
  });

  it('shows error message when no auth methods configured', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: false,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/no authentication methods/i)).toBeInTheDocument();
    });
  });

  it('shows OIDC button alongside form when both are enabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in with sso/i })).toBeInTheDocument();
    });
  });

  it('shows forgot password link when SMTP is enabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: true,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/forgot your password/i)).toBeInTheDocument();
    });
  });

  it('does not show forgot password link when SMTP is disabled', async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/forgot your password/i)).not.toBeInTheDocument();
  });

  it('does not show registration link when registration is disabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/create a new account/i)).not.toBeInTheDocument();
  });

  it('submits login form with valid credentials and redirects to dashboard', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false };
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(authApi.login).toHaveBeenCalledWith({ email: 'test@example.com', password: 'password123' });
    });

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith(mockUser, 'httpOnly');
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('redirects to change-password when mustChangePassword is true', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: true };
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/change-password');
    });
  });

  it('shows error toast on login failure', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Invalid credentials'));

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Invalid email or password');
    });
  });

  it('shows 2FA verify when login requires 2FA', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ requires2FA: true, tempToken: 'temp-token-123' });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-verify')).toBeInTheDocument();
    });
  });

  it('renders remember me checkbox', async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/remember me/i)).toBeInTheDocument();
    });
  });

  it('shows Or continue with text when OIDC is enabled alongside local', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/Or continue with/i)).toBeInTheDocument();
    });
  });

  it('calls initiateOidc when SSO button is clicked in SSO-only mode', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: true,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with sso/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign in with sso/i }));
    expect(authApi.initiateOidc).toHaveBeenCalled();
  });

  it('renders version number', async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByText(/^v/)).toBeInTheDocument();
    });
  });
});
