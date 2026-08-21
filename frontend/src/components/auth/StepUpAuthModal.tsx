'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import apiClient from '@/lib/api';
import { authApi } from '@/lib/auth';
import { usePreferencesStore } from '@/store/preferencesStore';
import {
  useStepUpTokenStore,
  stashOidcStepUpPending,
} from '@/lib/stepUpToken';
import { getErrorMessage } from '@/lib/errors';
import { buildTotpCodeSchema } from '@/lib/zod-helpers';

interface StepUpAuthModalProps {
  isOpen: boolean;
  purpose: string;
  /**
   * Auth provider for the caller's account. REQUIRED -- the auth store's
   * cached user is hydrated from /auth/profile which (today) omits this
   * field, so callers must source it from /auth/me-self (`authApi.getSelfProfile`)
   * or another full-user endpoint before opening the modal.
   */
  authProvider: 'local' | 'oidc';
  /**
   * Whether the user has a local password set. Same caveat as
   * `authProvider` -- pass the value from a full-user fetch.
   */
  hasPassword: boolean;
  /** Optional headline shown in the modal (e.g. "View your emergency message"). */
  reason?: string;
  onClose: () => void;
  /** Called after the token is stored in the in-memory step-up store. */
  onVerified?: () => void;
  /**
   * Path the user should return to after the OIDC roundtrip, and an
   * opaque caller-controlled payload that survives the redirect (e.g. which
   * mode -- 'view' or 'edit' -- to resume in).
   */
  oidcReturnTo?: string;
  oidcResumePayload?: Record<string, unknown>;
}

const buildPasswordSchema = (t: (key: string) => string) => z.object({
  password: z
    .string()
    .min(1, t('validation.passwordRequired'))
    .max(256, t('validation.passwordTooLong')),
});

const buildTotpSchema = (tc: (key: string) => string) => z.object({
  totpCode: buildTotpCodeSchema(tc),
});

type PasswordForm = z.infer<ReturnType<typeof buildPasswordSchema>>;
type TotpForm = z.infer<ReturnType<typeof buildTotpSchema>>;

/**
 * Prompt the user to re-prove possession of the account before unlocking a
 * sensitive surface. Picks the strongest factor available:
 *   - 2FA enabled  -> TOTP code
 *   - local user without 2FA -> password
 *   - OIDC user without 2FA -> message asking them to enable 2FA first
 */
export function StepUpAuthModal({
  isOpen,
  purpose,
  authProvider,
  hasPassword,
  reason,
  onClose,
  onVerified,
  oidcReturnTo,
  oidcResumePayload,
}: StepUpAuthModalProps) {
  const t = useTranslations('auth.stepUp');
  const tc = useTranslations('common');
  const preferences = usePreferencesStore((s) => s.preferences);
  const setStepUp = useStepUpTokenStore((s) => s.set);

  const twoFactorEnabled = !!preferences?.twoFactorEnabled;
  const mode: 'totp' | 'password' | 'oidc' | 'unavailable' = twoFactorEnabled
    ? 'totp'
    : authProvider === 'oidc'
      ? 'oidc'
      : authProvider === 'local' && hasPassword
        ? 'password'
        : 'unavailable';

  const handleOidcReauth = () => {
    // Stash the resume payload + the return-to path so the page can finalize
    // the step-up after the IdP roundtrip. Then redirect.
    stashOidcStepUpPending({
      purpose,
      returnTo: oidcReturnTo,
      payload: oidcResumePayload,
    });
    // The re-auth route, not ordinary login: it names the purpose and asks the
    // provider to challenge the user, and its callback mints the proof the
    // step-up endpoint verifies (P2-005).
    authApi.beginOidcReauth(purpose);
  };

  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(buildPasswordSchema(t)),
    defaultValues: { password: '' },
  });
  const totpForm = useForm<TotpForm>({
    resolver: zodResolver(buildTotpSchema(tc)),
    defaultValues: { totpCode: '' },
  });
  const totpRef = totpForm.register('totpCode');

  useEffect(() => {
    if (!isOpen) {
      passwordForm.reset({ password: '' });
      totpForm.reset({ totpCode: '' });
      setServerError(null);
      setSubmitting(false);
    }
  }, [isOpen, passwordForm, totpForm]);

  const submit = async (body: { password?: string; totpCode?: string }) => {
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await apiClient.post<{
        stepUpToken: string;
        expiresAt: string;
      }>('/auth/step-up', { purpose, ...body });
      setStepUp(purpose, res.data.stepUpToken, res.data.expiresAt);
      toast.success(t('toasts.verified'));
      onVerified?.();
      onClose();
    } catch (error) {
      setServerError(getErrorMessage(error, t('toasts.failed')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md" pushHistory>
      <div className="flex flex-col">
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('title')}
          </h2>
          {reason && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {reason}
            </p>
          )}
        </div>

        {mode === 'unavailable' ? (
          <div className="px-6 py-6 space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('unavailable')}
            </p>
            <div className="flex justify-end">
              <Button variant="outline" onClick={onClose}>
                {tc('close')}
              </Button>
            </div>
          </div>
        ) : mode === 'oidc' ? (
          <div className="px-6 py-6 space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('oidcPrompt')}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={onClose}>
                {tc('cancel')}
              </Button>
              <Button onClick={handleOidcReauth}>
                {t('continueOidc')}
              </Button>
            </div>
          </div>
        ) : mode === 'totp' ? (
          <form
            onSubmit={totpForm.handleSubmit((data) =>
              submit({ totpCode: data.totpCode }),
            )}
            className="flex flex-col"
          >
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t('totpPrompt')}
              </p>
              <Input
                label={t('totpLabel')}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                autoFocus
                error={totpForm.formState.errors.totpCode?.message}
                {...totpRef}
                onChange={(e) => {
                  const filtered = e.target.value.replace(/\D/g, '');
                  e.target.value = filtered;
                  totpRef.onChange(e);
                }}
              />
              {serverError && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {serverError}
                </p>
              )}
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
              >
                {tc('cancel')}
              </Button>
              <Button type="submit" isLoading={submitting}>
                {t('verify')}
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={passwordForm.handleSubmit((data) =>
              submit({ password: data.password }),
            )}
            className="flex flex-col"
          >
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t('passwordPrompt')}
              </p>
              <Input
                label={t('passwordLabel')}
                type="password"
                autoComplete="current-password"
                autoFocus
                error={passwordForm.formState.errors.password?.message}
                {...passwordForm.register('password')}
              />
              {serverError && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {serverError}
                </p>
              )}
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
              >
                {tc('cancel')}
              </Button>
              <Button type="submit" isLoading={submitting}>
                {t('verify')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
