'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { delegationApi, DelegateSummary } from '@/lib/delegation';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { passwordSchema, PASSWORD_REQUIREMENTS_TEXT } from '@/lib/zod-helpers';

const logger = createLogger('SharedAccess');

export function SharedAccessSection() {
  const [delegates, setDelegates] = useState<DelegateSummary[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [sendInvite, setSendInvite] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      toast.error(getErrorMessage(err, 'Failed to load shared access'));
      logger.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!sendInvite && password) {
      const parsed = passwordSchema.safeParse(password);
      if (!parsed.success) {
        toast.error(PASSWORD_REQUIREMENTS_TEXT);
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await delegationApi.createDelegate({
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        password: sendInvite ? undefined : password || undefined,
        sendInvite,
      });
      if (res.temporaryPassword) {
        toast.success(
          `Delegate created. Temporary password: ${res.temporaryPassword}`,
          { duration: 12000 },
        );
      } else if (res.invited) {
        toast.success('Invitation email sent');
      } else {
        toast.success('Delegate created');
      }
      setEmail('');
      setFirstName('');
      setPassword('');
      setSendInvite(false);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to create delegate'));
      logger.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleGrant = async (delegate: DelegateSummary, accountId: string) => {
    const has = delegate.accountIds.includes(accountId);
    const next = has
      ? delegate.accountIds.filter((id) => id !== accountId)
      : [...delegate.accountIds, accountId];
    try {
      await delegationApi.setGrants(delegate.id, next);
      setDelegates((prev) =>
        prev.map((d) =>
          d.id === delegate.id ? { ...d, accountIds: next } : d,
        ),
      );
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to update access'));
      logger.error(err);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!window.confirm('Revoke this delegate? They will lose all access.')) {
      return;
    }
    try {
      await delegationApi.revokeDelegate(id);
      toast.success('Delegate revoked');
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to revoke delegate'));
      logger.error(err);
    }
  };

  const handleResetPassword = async (id: string) => {
    try {
      const res = await delegationApi.resetPassword(id);
      toast.success(`Temporary password: ${res.temporaryPassword}`, {
        duration: 12000,
      });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to reset password'));
      logger.error(err);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Delegates sign in with their own credentials and never see your
        password. They only see the accounts you grant them.
      </p>

      <form
        onSubmit={handleCreate}
        className="grid gap-3 sm:grid-cols-2 mb-6 border-b border-gray-200 dark:border-gray-700 pb-6"
      >
        <input
          type="email"
          required
          placeholder="Delegate email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />
        <input
          type="text"
          placeholder="First name (optional)"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />

        <div className="sm:col-span-2 flex items-center gap-3">
          <ToggleSwitch
            checked={sendInvite}
            onChange={setSendInvite}
            label="Send an email invite instead of setting a password"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Send an email invite instead of setting a password
          </span>
        </div>

        {!sendInvite && (
          <div className="sm:col-span-2">
            <input
              type="password"
              placeholder="Set a password (optional)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {PASSWORD_REQUIREMENTS_TEXT} Leave blank to auto-generate a
              temporary password.
            </p>
          </div>
        )}

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 text-sm font-medium"
          >
            {submitting ? 'Adding...' : 'Add delegate'}
          </button>
        </div>
      </form>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : delegates.length === 0 ? (
        <p className="text-sm text-gray-500">No delegates yet.</p>
      ) : (
        <ul className="space-y-6">
          {delegates.map((d) => (
            <li
              key={d.id}
              className="border border-gray-200 dark:border-gray-700 rounded-lg p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">
                    {d.delegate.email}
                  </p>
                  <p className="text-xs text-gray-500">Status: {d.status}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleResetPassword(d.id)}
                    className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs"
                  >
                    Reset password
                  </button>
                  <button
                    onClick={() => handleRevoke(d.id)}
                    className="rounded border border-red-300 text-red-600 px-3 py-1 text-xs"
                  >
                    Revoke
                  </button>
                </div>
              </div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                Accounts this delegate can read:
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {accounts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                  >
                    <ToggleSwitch
                      size="sm"
                      checked={d.accountIds.includes(a.id)}
                      onChange={() => toggleGrant(d, a.id)}
                      label={`Read access to ${a.name}`}
                    />
                    <span>{a.name}</span>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
