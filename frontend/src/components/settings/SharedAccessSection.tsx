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
import { passwordSchema } from '@/lib/zod-helpers';
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
  // null = unknown / not yet checked; true = email already has a login.
  const [emailExists, setEmailExists] = useState<boolean | null>(null);

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
    setEmailExists(null);
  };

  // Debounced check: if the email already has a Monize login (existing
  // full account, or a delegate of another owner), the owner only links
  // the additional access -- no password / invite is set here.
  useEffect(() => {
    if (!showCreate) return;
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setEmailExists(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      delegationApi
        .lookupEmail(value)
        .then((r) => {
          if (!cancelled) setEmailExists(r.exists);
        })
        .catch(() => {
          if (!cancelled) setEmailExists(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [email, showCreate]);

  const openCreate = () => {
    resetCreateForm();
    setShowCreate(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    // Existing login: just link the access, never touch their credentials.
    if (!emailExists && !sendInvite) {
      if (!password) {
        toast.error(t('errors.setPasswordOrInvite'));
        return;
      }
      const parsed = passwordSchema.safeParse(password);
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
          emailExists || sendInvite ? undefined : password || undefined,
        sendInvite: emailExists ? false : sendInvite,
      });
      if (res.temporaryPassword) {
        toast.success(
          `Delegate created. Temporary password: ${res.temporaryPassword}`,
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
      toast.error(getErrorMessage(err, 'Failed to create delegate'));
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
      toast.error(getErrorMessage(err, 'Failed to revoke delegate'));
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
      toast.error(getErrorMessage(err, 'Failed to reset password'));
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
                <p className="font-medium text-gray-900 dark:text-white truncate">
                  {d.delegate.email}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('statusLabel', { status: d.status })} &middot; {t('sectionsLabel', { count: sectionCount(d) })}{' '}
                  &middot; {t('accountsLabel', { count: accountCount(d) })} &middot; {t('sharedDataLabel', { count: sharedDataCount(d) })}
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
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
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
              />
            </div>

            {!emailExists && (
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

            {emailExists ? (
              <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-3 py-2 text-sm text-blue-800 dark:text-blue-200">
                {t('createModal.existingAccountNotice')}
              </div>
            ) : (
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
              Cancel
            </Button>
            <Button type="submit" isLoading={submitting}>
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
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
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
