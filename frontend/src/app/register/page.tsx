'use client';

import { useState, useEffect } from 'react';
import { useTranslations, useLocale } from 'next-intl';
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
import { buildPasswordSchema, buildEmailSchema } from '@/lib/zod-helpers';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { OnboardingPreferences } from '@/components/auth/OnboardingPreferences';
import { AuthLanguageSwitcher } from '@/components/auth/AuthLanguageSwitcher';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Register');

const buildRegisterSchema = (t: (key: string) => string, tc: (key: string) => string) => z.object({
  email: buildEmailSchema(tc),
  password: buildPasswordSchema(tc),
  confirmPassword: z.string(),
  firstName: z.string().max(100, t('errors.firstNameMax')).optional(),
  lastName: z.string().max(100, t('errors.lastNameMax')).optional(),
  // Surfaces only after a first submit reveals the email already belongs
  // to a delegate row. Proves the registrant owns that row so the backend
  // claims (joins) it into the new account instead of failing the submit.
  delegatePassword: z.string().max(200).optional(),
}).refine((data) => data.password === data.confirmPassword, {
  message: t('errors.passwordsNoMatch'),
  path: ['confirmPassword'],
});

type RegisterFormData = z.infer<ReturnType<typeof buildRegisterSchema>>;

export default function RegisterPage() {
  const t = useTranslations('auth.register');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const { login } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showPreferencesSetup, setShowPreferencesSetup] = useState(false);
  // Set when registration requires email verification (SMTP enabled): the
  // account exists but cannot sign in until the emailed link is clicked, so
  // we show a "check your email" screen instead of logging the user in.
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);
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
    resolver: zodResolver(buildRegisterSchema(t, tc)),
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
      setDelegatePasswordError(t('errors.delegatePasswordRequired'));
      return;
    }

    setIsLoading(true);
    setDelegatePasswordError(null);
    try {
      const registerData = sendingClaim
        ? { ...rest, currentPassword: trimmed }
        : rest;
      const response = await authApi.register(registerData);
      // When SMTP is enabled the backend does not log the user in; it sends a
      // verification link instead. Show the "check your email" screen.
      if (response.verificationRequired) {
        setVerificationEmail(rest.email);
        return;
      }
      // Token is now in httpOnly cookie, not in response body
      login(response.user!, 'httpOnly');
      toast.success(t('toasts.created'));
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
          setDelegatePasswordError(t('errors.delegatePasswordIncorrect'));
        } else {
          setDelegateEmail(rest.email);
          setTrackedEmail(rest.email);
        }
      } else if (
        error instanceof AxiosError &&
        error.response?.status === 400
      ) {
        toast.error(error.response.data?.message || t('errors.createFailed'));
      } else {
        toast.error(t('errors.createFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleOidcLogin = () => {
    authApi.initiateOidc();
  };

  const handleResendVerification = async () => {
    if (!verificationEmail) return;
    setIsResending(true);
    try {
      await authApi.resendVerification(verificationEmail);
      toast.success(t('checkEmail.resendSuccess'));
    } catch {
      toast.error(t('checkEmail.resendError'));
    } finally {
      setIsResending(false);
    }
  };

  if (isLoadingMethods || !authMethods.local || !authMethods.registration) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">{tc('loading')}</div>
      </div>
    );
  }

  if (verificationEmail) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
            <h2 className="mt-4 text-3xl font-extrabold text-gray-900 dark:text-gray-100">
              {t('checkEmail.title')}
            </h2>
          </div>
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              {t('checkEmail.body', { email: verificationEmail })}
            </p>
          </div>
          <div className="space-y-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              isLoading={isResending}
              onClick={handleResendVerification}
              className="w-full"
            >
              {t('checkEmail.resendButton')}
            </Button>
            <Link
              href="/login"
              className="block text-center font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {t('checkEmail.backToSignIn')}
            </Link>
          </div>
        </div>
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
              {t('twoFactor.title')}
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {authMethods.force2fa
                ? t('twoFactor.requiredSubtitle')
                : t('twoFactor.optionalSubtitle')}
            </p>
          </div>
          <TwoFactorSetup
            onComplete={() => { setShowTwoFactorSetup(false); setShowPreferencesSetup(true); }}
            onSkip={authMethods.force2fa ? undefined : () => { setShowTwoFactorSetup(false); setShowPreferencesSetup(true); }}
            isForced={authMethods.force2fa}
          />
        </div>
      </div>
    );
  }

  if (showPreferencesSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <Image src="/icons/monize-logo.svg" alt="Monize" width={96} height={96} className="mx-auto rounded-xl" priority />
            <h2 className="mt-4 text-3xl font-extrabold text-gray-900 dark:text-gray-100">
              {t('preferences.title')}
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {t('preferences.subtitle')}
            </p>
          </div>
          <OnboardingPreferences
            initialLanguage={locale}
            onComplete={(result) => {
              if (result?.localeChanged) {
                // Full document load so every layout segment re-renders in
                // the newly chosen language; a client-side push would reuse
                // the cached root layout (and its catalogs) in the old one.
                window.location.assign('/dashboard');
              } else {
                router.push('/dashboard');
              }
            }}
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
            {t('title')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            {t('orPrefix')}{' '}
            <Link
              href="/login"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {t('signInLink')}
            </Link>
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <Input
              label={t('emailLabel')}
              type="email"
              autoComplete="email"
              error={errors.email?.message}
              {...register('email')}
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('firstNameLabel')}
                type="text"
                autoComplete="given-name"
                error={errors.firstName?.message}
                {...register('firstName')}
              />

              <Input
                label={t('lastNameLabel')}
                type="text"
                autoComplete="family-name"
                error={errors.lastName?.message}
                {...register('lastName')}
              />
            </div>

            <div>
              <Input
                label={t('passwordLabel')}
                type="password"
                autoComplete="new-password"
                error={errors.password?.message}
                {...register('password')}
              />
              {!errors.password && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {tc('passwordRequirements')}
                </p>
              )}
            </div>

            <Input
              label={t('confirmPasswordLabel')}
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
                  {t('delegateNotice.title')}
                </p>
                <p className="mt-1">
                  {t.rich('delegateNotice.body', {
                    email: delegateEmail,
                    mono: (chunks) => (
                      <span className="font-mono">{chunks}</span>
                    ),
                  })}
                </p>
              </div>
            )}

            {delegateEmail && (
              <div>
                <Input
                  label={t('delegatePasswordLabel')}
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
              {t('submit')}
            </Button>

            {authMethods.oidc && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300 dark:border-gray-700" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
                      {t('orContinueWith')}
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
                  {t('ssoButton')}
                </Button>
              </>
            )}
          </div>

          <p className="text-xs text-center text-gray-500 dark:text-gray-400">
            {t.rich('agreement', {
              terms: (chunks) => (
                <a href="#" className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">
                  {chunks}
                </a>
              ),
              privacy: (chunks) => (
                <a href="#" className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </form>

        <AuthLanguageSwitcher />
      </div>
    </div>
  );
}
