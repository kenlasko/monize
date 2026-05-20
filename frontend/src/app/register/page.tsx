'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import Image from 'next/image';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import { authApi, AuthMethods } from '@/lib/auth';
import { passwordSchema, PASSWORD_REQUIREMENTS_TEXT } from '@/lib/zod-helpers';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Register');

const registerSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: passwordSchema,
  confirmPassword: z.string(),
  firstName: z.string().max(100, 'First name must be less than 100 characters').optional(),
  lastName: z.string().max(100, 'Last name must be less than 100 characters').optional(),
  // Surfaces only after a first submit reveals the email already belongs
  // to a delegate row. Proves the registrant owns that row so the backend
  // claims (joins) it into the new account instead of failing the submit.
  delegatePassword: z.string().max(200).optional(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
});

type RegisterFormData = z.infer<typeof registerSchema>;

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [authMethods, setAuthMethods] = useState<AuthMethods>({ local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false });
  const [isLoadingMethods, setIsLoadingMethods] = useState(true);

  // Set to the email when a submit reveals it's already a delegate row;
  // surfaces the inline "Delegate password" prompt. Cleared when the
  // registrant edits the email so they can try a different one cleanly.
  const [delegateEmail, setDelegateEmail] = useState<string | null>(null);
  const [delegatePasswordError, setDelegatePasswordError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAuthMethods = async () => {
      try {
        const methods = await authApi.getAuthMethods();
        setAuthMethods(methods);
        // Redirect to login if local auth or registration is disabled
        if (!methods.local || !methods.registration || methods.demo) {
          router.replace('/login');
        }
      } catch (error) {
        logger.error('Failed to fetch auth methods:', error);
      } finally {
        setIsLoadingMethods(false);
      }
    };
    fetchAuthMethods();
  }, [router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
  });

  // "Info from previous render" pattern (no setState in useEffect): when
  // the email field is edited after we surfaced the delegate prompt, the
  // prompt no longer applies, so drop it.
  const watchedEmail = watch('email');
  const [trackedEmail, setTrackedEmail] = useState(watchedEmail);
  if (watchedEmail !== trackedEmail) {
    setTrackedEmail(watchedEmail);
    if (delegateEmail && watchedEmail !== delegateEmail) {
      setDelegateEmail(null);
      setDelegatePasswordError(null);
    }
  }

  const onSubmit = async (data: RegisterFormData) => {
    const { confirmPassword, delegatePassword, ...rest } = data;
    // Only include the delegate password when the inline prompt is
    // active. react-hook-form keeps unmounted field values, so a stale
    // value from a previous (now-dismissed) prompt would otherwise leak
    // into the wrong code path.
    const trimmed = delegateEmail ? delegatePassword?.trim() : undefined;
    const sendingClaim = !!trimmed;

    if (delegateEmail && !sendingClaim) {
      setDelegatePasswordError('Please enter your delegate password.');
      return;
    }

    setIsLoading(true);
    setDelegatePasswordError(null);
    try {
      const registerData = sendingClaim
        ? { ...rest, currentPassword: trimmed }
        : rest;
      const response = await authApi.register(registerData);
      // Token is now in httpOnly cookie, not in response body
      login(response.user!, 'httpOnly');
      toast.success('Account created successfully!');
      // Show 2FA setup after registration
      setShowTwoFactorSetup(true);
    } catch (error) {
      // 401 from /auth/register means the email already belongs to a
      // pure delegate row that the backend will join into the new
      // account only when given the matching delegate password.
      //   - no delegate password sent: first-time detection, surface the
      //     inline prompt so the registrant can supply it.
      //   - delegate password sent and still rejected: the password is
      //     wrong; keep the prompt up with an inline error so they can
      //     retry. The backend never creates a duplicate account in
      //     either case.
      // Other failures (409 duplicate, 429 rate limit, 5xx) use a
      // generic message to avoid account enumeration.
      if (
        error instanceof AxiosError &&
        error.response?.status === 401
      ) {
        if (sendingClaim) {
          setDelegatePasswordError(
            'The delegate password is incorrect. Please try again.',
          );
        } else {
          setDelegateEmail(rest.email);
          setTrackedEmail(rest.email);
        }
      } else if (
        error instanceof AxiosError &&
        error.response?.status === 400
      ) {
        const fallback = 'Unable to create account. Please try again.';
        toast.error(error.response.data?.message || fallback);
      } else {
        toast.error('Unable to create account. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleOidcLogin = () => {
    authApi.initiateOidc();
  };

  if (isLoadingMethods || !authMethods.local || !authMethods.registration) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (showTwoFactorSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
            <h2 className="mt-4 text-3xl font-extrabold text-gray-900 dark:text-gray-100">
              Secure Your Account
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {authMethods.force2fa
                ? 'Two-factor authentication is required by the administrator.'
                : 'Add an extra layer of security to your account.'}
            </p>
          </div>
          <TwoFactorSetup
            onComplete={() => router.push('/dashboard')}
            onSkip={authMethods.force2fa ? undefined : () => router.push('/dashboard')}
            isForced={authMethods.force2fa}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
          <h2 className="mt-4 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Or{' '}
            <Link
              href="/login"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
            >
              sign in to your existing account
            </Link>
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              error={errors.email?.message}
              {...register('email')}
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="First name"
                type="text"
                autoComplete="given-name"
                error={errors.firstName?.message}
                {...register('firstName')}
              />

              <Input
                label="Last name"
                type="text"
                autoComplete="family-name"
                error={errors.lastName?.message}
                {...register('lastName')}
              />
            </div>

            <div>
              <Input
                label="Password"
                type="password"
                autoComplete="new-password"
                error={errors.password?.message}
                {...register('password')}
              />
              {!errors.password && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {PASSWORD_REQUIREMENTS_TEXT}
                </p>
              )}
            </div>

            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              error={errors.confirmPassword?.message}
              {...register('confirmPassword')}
            />

            {delegateEmail && (
              <div
                role="alert"
                className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-3 text-sm text-amber-900 dark:text-amber-100"
              >
                <p className="font-semibold">
                  This email already exists as a shared user.
                </p>
                <p className="mt-1">
                  Someone has already invited{' '}
                  <span className="font-mono">{delegateEmail}</span> as a
                  delegate on their account. Enter the delegate password
                  you were given to join that access to this new account.
                  If the password is wrong, no account will be created.
                </p>
              </div>
            )}

            {delegateEmail && (
              <div>
                <Input
                  label="Delegate password"
                  type="password"
                  autoComplete="off"
                  error={
                    delegatePasswordError ||
                    errors.delegatePassword?.message
                  }
                  {...register('delegatePassword')}
                />
              </div>
            )}
          </div>

          <div className="space-y-3">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={isLoading}
              className="w-full"
            >
              Create account
            </Button>

            {authMethods.oidc && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300 dark:border-gray-700" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
                      Or continue with
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={handleOidcLogin}
                  className="w-full"
                >
                  <svg
                    className="w-5 h-5 mr-2"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  Sign up with SSO
                </Button>
              </>
            )}
          </div>

          <p className="text-xs text-center text-gray-500 dark:text-gray-400">
            By creating an account, you agree to our{' '}
            <a href="#" className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="#" className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">
              Privacy Policy
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
