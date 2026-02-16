import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import RegisterPage from './page';
import toast from 'react-hot-toast';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    }),
    register: vi.fn(),
    initiateOidc: vi.fn(),
  },
  AuthMethods: {},
}));

// Mock auth store
const mockLogin = vi.fn();
vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    login: mockLogin,
  })),
}));

// Mock TwoFactorSetup
vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: ({ onComplete, onSkip, isForced }: any) => (
    <div data-testid="two-factor-setup">
      TwoFactorSetup
      <button data-testid="complete-2fa" onClick={onComplete}>Complete</button>
      {onSkip && <button data-testid="skip-2fa" onClick={onSkip}>Skip</button>}
      {isForced && <span data-testid="forced-2fa">forced</span>}
    </div>
  ),
}));

import { authApi } from '@/lib/auth';

const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/register',
  useSearchParams: () => new URLSearchParams(),
}));

describe('RegisterPage', () => {
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

  it('renders the create account heading', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByText('Create your account')).toBeInTheDocument();
    });
  });

  it('renders email, password, and confirm password fields', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });
  });

  it('renders create account button', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    });
  });

  it('renders link to sign in', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByText(/sign in to your existing account/i)).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    render(<RegisterPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders first name and last name fields', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
    });
  });

  it('redirects to login when registration is disabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<RegisterPage />);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
  });

  it('redirects to login when local auth is disabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<RegisterPage />);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
  });

  it('submits registration form and shows 2FA setup', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true };
    (authApi.register as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'StrongPass1!' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => {
      expect(authApi.register).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
      expect(screen.getByText('Secure Your Account')).toBeInTheDocument();
    });
  });

  it('shows error toast on registration failure', async () => {
    (authApi.register as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Registration failed'));

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'StrongPass1!' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Unable to create account. Please try again.');
    });
  });

  it('shows OIDC SSO button when OIDC is enabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign up with sso/i })).toBeInTheDocument();
      expect(screen.getByText(/Or continue with/i)).toBeInTheDocument();
    });
  });

  it('calls initiateOidc when SSO button is clicked', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign up with sso/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign up with sso/i }));
    expect(authApi.initiateOidc).toHaveBeenCalled();
  });

  it('renders terms of service and privacy policy links', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByText(/Terms of Service/i)).toBeInTheDocument();
      expect(screen.getByText(/Privacy Policy/i)).toBeInTheDocument();
    });
  });

  it('shows forced 2FA message when force2fa is true', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: true, demo: false,
    });

    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true };
    (authApi.register as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'StrongPass1!' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
      expect(screen.getByText(/Two-factor authentication is required/i)).toBeInTheDocument();
      expect(screen.getByTestId('forced-2fa')).toBeInTheDocument();
    });
    // Skip button should not be present when forced
    expect(screen.queryByTestId('skip-2fa')).not.toBeInTheDocument();
  });

  it('shows skip button for 2FA when not forced', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true };
    (authApi.register as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'StrongPass1!' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
      expect(screen.getByTestId('skip-2fa')).toBeInTheDocument();
    });
  });
});
