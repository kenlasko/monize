'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { StepUpAuthModal } from '@/components/auth/StepUpAuthModal';
import { authApi } from '@/lib/auth';
import apiClient from '@/lib/api';
import {
  StepUpRequiredError,
  consumeOidcReauthArtifact,
  consumeOidcStepUpPending,
  rethrowStepUpError,
  useStepUpTokenStore,
} from '@/lib/stepUpToken';
import { PersonalAccessToken, SelfUserProfile } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useRelativeTime } from '@/hooks/useRelativeTime';

const MCP_PATH = '/api/v1/mcp';

/**
 * Creating a token is step-up protected: a PAT outlives the session that mints
 * it, so the server asks for the account's strongest factor again first.
 */
const STEP_UP_PURPOSE = 'personal-access-token';

const SCOPE_OPTIONS = [
  { value: 'read', labelKey: 'createModal.scopes.read.label', descriptionKey: 'createModal.scopes.read.description' },
  { value: 'write', labelKey: 'createModal.scopes.write.label', descriptionKey: 'createModal.scopes.write.description' },
];

const EXPIRY_OPTIONS = [
  { value: '30', labelKey: 'createModal.expiry.d30' },
  { value: '90', labelKey: 'createModal.expiry.d90' },
  { value: '365', labelKey: 'createModal.expiry.y1' },
  { value: '', labelKey: 'createModal.expiry.none' },
];

/** The server's own default, so a form that is never touched matches an omitted `expiresAt`. */
const DEFAULT_EXPIRY_DAYS = '90';

const buildCreateTokenSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('createModal.validation.nameRequired')).max(100, t('createModal.validation.nameMax')),
  expiryDays: z.string(),
});

type CreateTokenFormData = z.infer<ReturnType<typeof buildCreateTokenSchema>>;

/** The create form as it was, carried across a step-up or an OIDC round trip. */
interface PendingCreate {
  name: string;
  expiryDays: string;
  scopes: string[];
}

function isPendingCreate(value: unknown): value is PendingCreate {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.expiryDays === 'string' &&
    Array.isArray(v.scopes) &&
    v.scopes.every((scope) => typeof scope === 'string')
  );
}

export function ApiAccessSection() {
  const t = useTranslations('settings.apiAccess');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const relativeTime = useRelativeTime();
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [revokeTokenId, setRevokeTokenId] = useState<string | null>(null);

  // Scope selection state (managed separately since it's a multi-select toggle)
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['read']);

  // Show token once state
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Step-up: the modal needs the account's factor (authProvider + hasPassword),
  // which only the full self profile carries.
  const [selfUser, setSelfUser] = useState<SelfUserProfile | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const clearStepUp = useStepUpTokenStore((s) => s.clear);

  const {
    register,
    handleSubmit,
    reset: resetForm,
    formState: { errors },
  } = useForm<CreateTokenFormData>({
    resolver: zodResolver(buildCreateTokenSchema(t)),
    defaultValues: {
      name: '',
      expiryDays: DEFAULT_EXPIRY_DAYS,
    },
  });

  const mcpServerUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${MCP_PATH}`
    : MCP_PATH;

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const loadTokens = useCallback(() => {
    const run = async () => {
      try {
        const data = await authApi.getTokens();
        setTokens(data);
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  useEffect(() => {
    authApi
      .getSelfProfile()
      .then((user) => setSelfUser(user))
      .catch(() => {
        // Without it the step-up modal cannot pick a factor and stays closed;
        // creating a token then fails with the server's own message.
      });
  }, []);

  /** Ask for the step-up, remembering the form so it can be submitted after. */
  const requestStepUp = (pending: PendingCreate) => {
    clearStepUp(STEP_UP_PURPOSE);
    setPendingCreate(pending);
    setStepUpOpen(true);
  };

  const submitCreate = async (pending: PendingCreate) => {
    const stepUpToken = useStepUpTokenStore.getState().getValid(STEP_UP_PURPOSE);
    if (!stepUpToken) {
      requestStepUp(pending);
      return;
    }

    setIsCreating(true);
    try {
      // `null` is an explicit "never expires": an omitted value means 90 days server-side.
      let expiresAt: string | null = null;
      if (pending.expiryDays) {
        const date = new Date();
        date.setDate(date.getDate() + parseInt(pending.expiryDays));
        expiresAt = date.toISOString();
      }

      const result = await authApi
        .createToken(
          {
            name: pending.name.trim(),
            scopes: pending.scopes.join(','),
            expiresAt,
          },
          stepUpToken,
        )
        .catch((error: unknown) => rethrowStepUpError(error));

      setCreatedToken(result.token);
      setTokens((prev) => [result, ...prev]);
      setCopied(false);
    } catch (error) {
      if (error instanceof StepUpRequiredError) {
        // Expired or rejected between verifying and submitting: ask again.
        requestStepUp(pending);
        return;
      }
      toast.error(getErrorMessage(error, t('toasts.createFailed')));
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreate = async (formData: CreateTokenFormData) => {
    if (selectedScopes.length === 0) {
      toast.error(t('toasts.selectScope'));
      return;
    }
    await submitCreate({
      name: formData.name,
      expiryDays: formData.expiryDays,
      scopes: selectedScopes,
    });
  };

  // Finish a step-up that went through the identity provider. The modal
  // stashed the form and sent the user away; the auth callback brought them
  // back here with a one-time artifact, which is exchanged for a step-up token
  // before the form is reopened as it was.
  useEffect(() => {
    const pending = consumeOidcStepUpPending(STEP_UP_PURPOSE);
    if (!pending) return;
    const resumed = isPendingCreate(pending.payload) ? pending.payload : null;
    (async () => {
      try {
        const artifact = consumeOidcReauthArtifact();
        const res = await apiClient.post<{
          stepUpToken: string;
          expiresAt: string;
        }>('/auth/step-up', {
          purpose: STEP_UP_PURPOSE,
          oidcReauthToken: artifact ?? undefined,
        });
        useStepUpTokenStore
          .getState()
          .set(STEP_UP_PURPOSE, res.data.stepUpToken, res.data.expiresAt);
        if (resumed) {
          resetForm({ name: resumed.name, expiryDays: resumed.expiryDays });
          setSelectedScopes(resumed.scopes);
          setShowCreateModal(true);
        }
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.reauthFailed')));
      }
    })();
    // Once per mount: the sentinel is consumed on the first call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
    setCreatedToken(null);
    resetForm({ name: '', expiryDays: DEFAULT_EXPIRY_DAYS });
    setSelectedScopes(['read']);
    setCopied(false);
  };

  const handleCopyToken = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
      toast.success(t('toasts.copied'));
    } catch {
      toast.error(t('toasts.copyTokenFailed'));
    }
  };

  const handleRevoke = async () => {
    if (!revokeTokenId) return;
    try {
      await authApi.revokeToken(revokeTokenId);
      setTokens((prev) => prev.filter((tok) => tok.id !== revokeTokenId));
      toast.success(t('toasts.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.revokeFailed')));
    } finally {
      setRevokeTokenId(null);
    }
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((s) => s !== scope)
        : [...prev, scope],
    );
  };

  const activeTokens = tokens.filter((tok) => !tok.isRevoked);

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('heading')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('description')}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('restrictedNote')}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowCreateModal(true)}
        >
          {t('createTokenButton')}
        </Button>
      </div>

      {/* MCP Server URL */}
      <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t('mcpServerUrlLabel')}
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={mcpServerUrl}
            className="flex-1 text-sm font-mono bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 text-gray-900 dark:text-gray-100"
          />
          <Button
            variant={mcpUrlCopied ? 'secondary' : 'outline'}
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(mcpServerUrl);
                setMcpUrlCopied(true);
                toast.success(t('toasts.mcpUrlCopied'));
                setTimeout(() => setMcpUrlCopied(false), 2000);
              } catch {
                toast.error(t('toasts.copyUrlFailed'));
              }
            }}
          >
            {mcpUrlCopied ? t('copiedButton') : t('copyButton')}
          </Button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
          {t('mcpServerUrlHelp')}
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner size="sm" fullContainer={false} />
        </div>
      ) : activeTokens.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg">
          <svg
            className="mx-auto h-10 w-10 text-gray-400 dark:text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t('noTokens')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {activeTokens.map((token) => (
            <div
              key={token.id}
              className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {token.name}
                  </p>
                  <code className="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-600 px-1.5 py-0.5 rounded">
                    {token.tokenPrefix}...
                  </code>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {token.scopes.split(',').map((scope) => (
                    <span
                      key={scope}
                      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t('created')} {formatDate(new Date(token.createdAt))}
                  {' \u00B7 '}
                  {t('lastUsed')} {token.lastUsedAt ? relativeTime(token.lastUsedAt) : t('relative.never')}
                  {token.expiresAt && (
                    <>
                      {' \u00B7 '}
                      {t('expires')} {formatDate(new Date(token.expiresAt))}
                    </>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevokeTokenId(token.id)}
                className="ml-3 flex-shrink-0"
              >
                {t('revokeButton')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Create Token Modal */}
      <Modal isOpen={showCreateModal} onClose={handleCloseCreateModal}>
        <div className="p-6">
          {createdToken ? (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('createdModal.title')}
              </h2>
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {t('createdModal.warningNote')}
                </p>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={createdToken}
                  className="flex-1 text-sm font-mono bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-gray-900 dark:text-gray-100"
                />
                <Button
                  variant={copied ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={handleCopyToken}
                >
                  {copied ? t('copiedButton') : t('copyButton')}
                </Button>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={handleCloseCreateModal}>
                  {t('createdModal.doneButton')}
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit(handleCreate)} className="space-y-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('createModal.title')}
              </h2>
              <Input
                label={t('createModal.tokenNameLabel')}
                {...register('name')}
                error={errors.name?.message}
                placeholder={t('createModal.tokenNamePlaceholder')}
                maxLength={100}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('createModal.scopesLabel')}
                </label>
                <div className="space-y-2">
                  {SCOPE_OPTIONS.map((scope) => (
                    <label
                      key={scope.value}
                      className="flex items-start gap-3 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope.value)}
                        onChange={() => toggleScope(scope.value)}
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {t(scope.labelKey)}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {t(scope.descriptionKey)}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('createModal.expirationLabel')}
                </label>
                <select
                  {...register('expiryDays')}
                  className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" type="button" onClick={handleCloseCreateModal}>
                  {tc('cancel')}
                </Button>
                <Button type="submit" disabled={isCreating}>
                  {isCreating ? t('createModal.creatingButton') : t('createModal.createButton')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Modal>

      <StepUpAuthModal
        isOpen={stepUpOpen && !!selfUser}
        purpose={STEP_UP_PURPOSE}
        authProvider={selfUser?.authProvider ?? 'local'}
        hasPassword={selfUser?.hasPassword ?? false}
        reason={t('stepUp.reason')}
        oidcReturnTo="/settings"
        oidcResumePayload={pendingCreate ? { ...pendingCreate } : undefined}
        onClose={() => {
          setStepUpOpen(false);
          setPendingCreate(null);
        }}
        onVerified={() => {
          const pending = pendingCreate;
          setStepUpOpen(false);
          setPendingCreate(null);
          if (pending) void submitCreate(pending);
        }}
      />

      {/* Revoke Confirmation */}
      <ConfirmDialog
        isOpen={!!revokeTokenId}
        title={t('revokeModal.title')}
        message={t('revokeModal.message')}
        confirmLabel={t('revokeModal.confirmLabel')}
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTokenId(null)}
      />
    </div>
  );
}
