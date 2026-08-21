'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { delegationApi, DelegateSummary } from '@/lib/delegation';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Button } from '@/components/ui/Button';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { buildPasswordSchema } from '@/lib/zod-helpers';
import { DelegateAccessModal } from './DelegateAccessModal';

const logger = createLogger('SharedAccess');

function sectionCount(d: DelegateSummary): number {
  const s = d.sections;
  if (!s) return 0;
  return [s.bills, s.investments, s.budgets, s.reports, s.ai].filter(Boolean)
    .length;
}

function accountCount(d: DelegateSummary): number {
  return d.grants.filter((g) => g.canRead).length;
}

function sharedDataCount(d: DelegateSummary): number {
  const c = d.capabilities;
  return [c.payees, c.categories, c.tags].reduce(
    (n, r) =>
      n + (r.create ? 1 : 0) + (r.edit ? 1 : 0) + (r.delete ? 1 : 0),
    0,
  );
}

const inputClass =
  'w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm';

/** Addresses worth spending a lookup on. The server applies the real rule. */
const LOOKUPABLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email lookup's result *and* the address that produced it. Without the
 * address the component cannot tell an answer about what is in the field from
 * an answer about what used to be, and every control below it is drawn from
 * whichever of the two arrived last.
 *
 * `failed` is a fourth state on purpose. It used to collapse into "no such
 * user", so a 500, a 403 or a timeout rendered as a confident invitation to set
 * a password for someone who may already have one -- indistinguishable, on
 * screen, from the answer this form exists to give.
 */
type EmailLookup =
  | { state: 'known'; email: string; exists: boolean }
  // `detail` is the server's or axios's own words, untranslated. Monize is
  // self-hosted, so the person hitting this is usually the one who can fix it,
  // and "403" or "Request failed with status code 500" is the difference
  // between a diagnosis and a shrug.
  | { state: 'failed'; email: string; detail?: string };

export function SharedAccessSection() {
  const t = useTranslations('settings.sharedAccess');
  const tc = useTranslations('common');
  const [delegates, setDelegates] = useState<DelegateSummary[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [sendInvite, setSendInvite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lookup, setLookup] = useState<EmailLookup | null>(null);
  // Bumped by the retry button: the lookup for a failed address is otherwise
  // keyed only on the address, so re-running it needs something to change.
  const [lookupAttempt, setLookupAttempt] = useState(0);

  const [revokeTarget, setRevokeTarget] = useState<DelegateSummary | null>(
    null,
  );
  const [revoking, setRevoking] = useState(false);

  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    showForm,
    editingItem,
    openEdit,
    close,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<DelegateSummary>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, a] = await Promise.all([
        delegationApi.listDelegates(),
        accountsApi.getAll(),
      ]);
      setDelegates(d);
      setAccounts(a);
    } catch (err) {
      toast.error(getErrorMessage(err, t('errors.loadFailed')));
      logger.error(err);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetCreateForm = () => {
    setEmail('');
    setFirstName('');
    setLastName('');
    setPassword('');
    setSendInvite(false);
    setLookup(null);
  };

  const trimmedEmail = email.trim();
  const emailIsLookupable = LOOKUPABLE_EMAIL.test(trimmedEmail);
  // Adopt the lookup only while it still describes what is in the field. A
  // response for a previous address is stale, not an answer, so it is dropped
  // here during render rather than cleared from an effect.
  const currentLookup =
    lookup && lookup.email === trimmedEmail ? lookup : null;

  const existingLogin =
    currentLookup?.state === 'known' && currentLookup.exists;
  const lookupFailed = currentLookup?.state === 'failed';
  // No answer yet for the address on screen: the debounce is still running or
  // the request is in flight. Absence of a result is the whole condition, so
  // there is no separate loading state to set -- and setting one would make
  // this effect re-run and cancel the request it is waiting for.
  const lookupChecking = emailIsLookupable && currentLookup === null;

  // Debounced check: if the email already has a Monize login (existing
  // full account, or a delegate of another owner), the owner only links
  // the additional access -- no password / invite is set here.
  useEffect(() => {
    if (!showCreate || !emailIsLookupable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      delegationApi
        .lookupEmail(trimmedEmail)
        .then((r) => {
          if (!cancelled)
            setLookup({
              state: 'known',
              email: trimmedEmail,
              exists: r.exists,
            });
        })
        .catch((err) => {
          if (cancelled) return;
          logger.error(err);
          setLookup({
            state: 'failed',
            email: trimmedEmail,
            detail: getErrorMessage(err, '') || undefined,
          });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `t` is deliberately absent: useTranslations returns a fresh identity each
    // render, so depending on it re-runs this effect, and the cleanup then
    // cancels the very request the component is waiting on. The failure copy is
    // resolved at render instead.
  }, [trimmedEmail, emailIsLookupable, showCreate, lookupAttempt]);

  const openCreate = () => {
    resetCreateForm();
    setShowCreate(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    // Whether this address already has a login decides what the rest of the
    // form even means, so an unanswered lookup is not a licence to guess: the
    // "no" branch below would set a password for a person who may already have
    // one. The server refuses to overwrite a real account's credentials, but
    // submitting blind is how this stayed invisible in the first place.
    if (lookupFailed) {
      toast.error(t('errors.lookupFailed'));
      return;
    }
    // Existing login: just link the access, never touch their credentials.
    if (!existingLogin && !sendInvite) {
      if (!password) {
        toast.error(t('errors.setPasswordOrInvite'));
        return;
      }
      const parsed = buildPasswordSchema(tc).safeParse(password);
      if (!parsed.success) {
        toast.error(tc('passwordRequirements'));
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await delegationApi.createDelegate({
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        password:
          existingLogin || sendInvite ? undefined : password || undefined,
        sendInvite: existingLogin ? false : sendInvite,
      });
      if (res.temporaryPassword) {
        toast.success(
          t('toasts.createdWithTempPassword', {
            password: res.temporaryPassword,
          }),
          { duration: 12000 },
        );
      } else if (res.invited) {
        toast.success(t('toasts.invited'));
      } else {
        toast.success(t('toasts.created'));
      }
      setShowCreate(false);
      resetCreateForm();
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('errors.createFailed')));
      logger.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await delegationApi.revokeDelegate(revokeTarget.id);
      toast.success(t('toasts.removed'));
      setRevokeTarget(null);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('errors.revokeFailed')));
      logger.error(err);
    } finally {
      setRevoking(false);
    }
  };

  const handleResetPassword = async (id: string) => {
    try {
      const res = await delegationApi.resetPassword(id);
      setCopied(false);
      setTempPassword(res.temporaryPassword);
    } catch (err) {
      toast.error(getErrorMessage(err, t('errors.resetPasswordFailed')));
      logger.error(err);
    }
  };

  const copyTempPassword = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
    } catch (err) {
      toast.error(t('errors.copyFailed'));
      logger.error(err);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
          {t('description')}
        </p>
        <Button size="sm" onClick={openCreate}>
          {t('addDelegateButton')}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">{t('loading')}</p>
      ) : delegates.length === 0 ? (
        <p className="text-sm text-gray-500">{t('noDelegates')}</p>
      ) : (
        <ul className="space-y-3">
          {delegates.map((d) => (
            <li
              key={d.id}
              className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
                  {d.delegate.email}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('statusLabel', { status: d.status })} &middot; {t('sectionsLabel', { count: sectionCount(d) })}{' '}
                  &middot; {t('accountsLabel', { count: accountCount(d) })} &middot; {t('sharedDataLabel', { count: sharedDataCount(d) })}
                  {d.grants.some((g) => g.isJoint) && (
                    <>
                      {' '}&middot;{' '}
                      <span className="text-amber-700 dark:text-amber-300">
                        {t('jointLabel', {
                          count: d.grants.filter((g) => g.isJoint).length,
                        })}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => openEdit(d)}>
                  {t('editAccessButton')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!d.delegate.canResetPassword}
                  title={
                    !d.delegate.canResetPassword
                      ? t('resetPasswordDisabledTitle')
                      : undefined
                  }
                  onClick={() => handleResetPassword(d.id)}
                >
                  {t('resetPasswordButton')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setRevokeTarget(d)}
                >
                  {t('removeButton')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        maxWidth="lg"
        pushHistory
      >
        <form onSubmit={handleCreate} className="flex flex-col">
          <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('createModal.title')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('createModal.description')}
            </p>
          </div>

          <div className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('createModal.emailLabel')}
              </label>
              <input
                type="email"
                required
                placeholder={t('createModal.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                aria-describedby="delegate-email-status"
              />
              <p
                id="delegate-email-status"
                className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                aria-live="polite"
              >
                {lookupChecking ? t('createModal.checkingEmail') : null}
              </p>
            </div>

            {lookupFailed && (
              <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-800 dark:text-red-200">
                <p>{t('errors.lookupFailed')}</p>
                {currentLookup.detail && (
                  <p className="mt-1 text-xs opacity-80">
                    {currentLookup.detail}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setLookupAttempt((n) => n + 1)}
                  className="mt-2 font-medium underline"
                >
                  {t('createModal.retryEmailCheck')}
                </button>
              </div>
            )}

            {!existingLogin && !lookupFailed && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('createModal.firstNameLabel')}
                  </label>
                  <input
                    type="text"
                    placeholder={t('createModal.firstNamePlaceholder')}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('createModal.lastNameLabel')}
                  </label>
                  <input
                    type="text"
                    placeholder={t('createModal.lastNamePlaceholder')}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            )}

            {existingLogin ? (
              <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-3 py-2 text-sm text-blue-800 dark:text-blue-200">
                {t('createModal.existingAccountNotice')}
              </div>
            ) : lookupFailed ? null : (
              <>
                <div className="flex items-center gap-3">
                  <ToggleSwitch
                    checked={sendInvite}
                    onChange={setSendInvite}
                    label={t('createModal.sendInviteLabel')}
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    {t('createModal.sendInviteLabel')}
                  </span>
                </div>

                {!sendInvite && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('createModal.passwordLabel')}
                    </label>
                    <PasswordInput
                      required
                      placeholder={t('createModal.passwordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={inputClass}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {tc('passwordRequirements')}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCreate(false)}
              disabled={submitting}
            >
              {tc('cancel')}
            </Button>
            <Button
              type="submit"
              isLoading={submitting}
              disabled={lookupFailed}
            >
              {t('createModal.submitButton')}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={showForm}
        onClose={close}
        maxWidth="4xl"
        {...modalProps}
      >
        {editingItem && (
          <DelegateAccessModal
            delegate={editingItem}
            accounts={accounts}
            onCancel={close}
            onSaved={() => {
              close();
              void load();
            }}
            setFormDirty={setFormDirty}
            submitRef={formSubmitRef}
          />
        )}
      </Modal>

      <ConfirmDialog
        isOpen={revokeTarget !== null}
        title={t('revokeDialog.title')}
        message={t('revokeDialog.message')}
        confirmLabel={revoking ? t('revokeDialog.removingButton') : t('revokeDialog.removeButton')}
        variant="danger"
        pushHistory
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />

      <Modal
        isOpen={tempPassword !== null}
        onClose={() => setTempPassword(null)}
        maxWidth="md"
        pushHistory
      >
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('tempPasswordModal.title')}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('tempPasswordModal.description')}
          </p>
          <div className="mt-4 flex items-stretch gap-2">
            <code className="flex-1 select-all rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-sm font-mono break-all">
              {tempPassword}
            </code>
            <Button type="button" variant="outline" onClick={copyTempPassword}>
              {copied ? t('tempPasswordModal.copiedButton') : t('tempPasswordModal.copyButton')}
            </Button>
          </div>
          <div className="mt-6 flex justify-end">
            <Button type="button" onClick={() => setTempPassword(null)}>
              {t('tempPasswordModal.doneButton')}
            </Button>
          </div>
        </div>
      </Modal>

      <UnsavedChangesDialog {...unsavedChangesDialog} />
    </div>
  );
}
