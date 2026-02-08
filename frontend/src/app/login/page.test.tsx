import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import userEvent from '@testing-library/user-event';
import LoginPage from './page';

// Mock the auth API module
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false,
    }),
    login: vi.fn(),
    initiateOidc: vi.fn(),
  },
  AuthMethods: {},
}));

// Mock the auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    login: vi.fn(),
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

// Import mocked modules to control them
import { authApi } from '@/lib/auth';

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false,
    });
  });

  it('renders the sign in heading', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText('Sign in to MoneyMate')).toBeInTheDocument();
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
      force2fa: false,
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
      force2fa: false,
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
      force2fa: false,
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
      force2fa: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/forgot your password/i)).toBeInTheDocument();
    });
  });
});
