import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { AxiosError, AxiosHeaders } from 'axios';
import RegisterPage from './page';
import toast from 'react-hot-toast';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
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

// Build an AxiosError that mirrors what /auth/register returns when the
// email already belongs to a pure delegate row that needs the delegate
// password to be claimed.
function delegateAxiosError(message = 'shared user'): AxiosError {
  const err = new AxiosError(
    'Request failed with status code 401',
    'ERR_BAD_REQUEST',
    undefined,
    {},
    {
      data: { message },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
    },
  );
  return err;
}

async function fillBaseFields() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'shared@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'StrongPass1!' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'StrongPass1!' },
    });
  });
}

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

  it('does not show the delegate password field until a submit reveals it', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/delegate password/i)).not.toBeInTheDocument();
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

  it('shows loading state initially', async () => {
    render(<RegisterPage />);
    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });
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

  it('does not include currentPassword on a normal first submit', async () => {
    const mockUser = { id: 'u2', email: 'new@example.com' };
    (authApi.register as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: 'new@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'StrongPass1!' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'StrongPass1!' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => expect(authApi.register).toHaveBeenCalled());
    const callArg = (authApi.register as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg).not.toHaveProperty('currentPassword');
  });

  it('surfaces the delegate prompt and resubmits with currentPassword on 401', async () => {
    const mockUser = { id: 'd1', email: 'shared@example.com' };
    (authApi.register as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(delegateAxiosError())
      .mockResolvedValueOnce({ user: mockUser });

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await fillBaseFields();

    // First submit: no delegate password yet, backend says it's a delegate.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await act(async () => {}); // flush rejected promise handler

    await waitFor(() => {
      expect(screen.getByText(/already exists as a shared user/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/delegate password/i)).toBeInTheDocument();
    });

    // Second submit: registrant supplies the delegate password.
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/delegate password/i), {
        target: { value: '  Temp-Pw-9!aB  ' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => {
      expect(
        (authApi.register as ReturnType<typeof vi.fn>).mock.calls[1][0],
      ).toEqual(
        expect.objectContaining({
          email: 'shared@example.com',
          password: 'StrongPass1!',
          currentPassword: 'Temp-Pw-9!aB',
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
    });
  });

  it('keeps the prompt visible with an inline error when the delegate password is wrong', async () => {
    (authApi.register as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(delegateAxiosError())
      .mockRejectedValueOnce(delegateAxiosError('still wrong'));

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await fillBaseFields();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByLabelText(/delegate password/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/delegate password/i), {
        target: { value: 'WrongPw1!' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await act(async () => {});

    await waitFor(() => {
      expect(
        screen.getByText(/delegate password is incorrect/i),
      ).toBeInTheDocument();
    });
    // Backend has been called twice (initial detection + retry), but no
    // account was ever created -- the inline prompt is still visible.
    expect(
      (authApi.register as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(2);
    expect(screen.getByLabelText(/delegate password/i)).toBeInTheDocument();
  });

  it('dismisses the delegate prompt when the email is edited', async () => {
    (authApi.register as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      delegateAxiosError(),
    );

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await fillBaseFields();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByLabelText(/delegate password/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: 'different@example.com' },
      });
    });

    expect(screen.queryByLabelText(/delegate password/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/already exists as a shared user/i),
    ).not.toBeInTheDocument();
  });

  it('shows an inline error and does not call the API when the delegate prompt is visible but the password is blank', async () => {
    (authApi.register as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      delegateAxiosError(),
    );

    render(<RegisterPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await fillBaseFields();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByLabelText(/delegate password/i)).toBeInTheDocument();
    });

    // Submit again without filling the delegate password.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/please enter your delegate password/i),
      ).toBeInTheDocument();
    });
    expect(
      (authApi.register as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
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
