import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import RegisterPage from './page';

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
      force2fa: false,
    }),
    register: vi.fn(),
    initiateOidc: vi.fn(),
  },
  AuthMethods: {},
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    login: vi.fn(),
  })),
}));

// Mock TwoFactorSetup
vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: () => <div data-testid="two-factor-setup">TwoFactorSetup</div>,
}));

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
