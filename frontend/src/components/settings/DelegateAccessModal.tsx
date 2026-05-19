'use client';

import { MutableRefObject, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  delegationApi,
  DelegateSummary,
  AccountGrant,
  DelegateCapabilities,
  DelegateSectionFlags,
} from '@/lib/delegation';
import { Account, AccountType } from '@/types/account';
import { formatAccountType } from '@/lib/account-utils';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Button } from '@/components/ui/Button';

const logger = createLogger('DelegateAccessModal');

type GrantOp = 'canRead' | 'canCreate' | 'canEdit' | 'canDelete';
type CapOp = 'create' | 'edit' | 'delete';
type CapResource = 'payees' | 'categories' | 'tags';
type SectionKey = 'bills' | 'investments' | 'budgets' | 'reports' | 'ai';
type Tab = 'sections' | 'accounts' | 'shared';

interface DraftGrant {
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

interface Draft {
  grants: Record<string, DraftGrant>;
  capabilities: Record<CapResource, Record<CapOp, boolean>>;
  sections: Record<SectionKey, boolean>;
}

const GRANT_OPS: { key: GrantOp; label: string }[] = [
  { key: 'canRead', label: 'Read' },
  { key: 'canCreate', label: 'Create' },
  { key: 'canEdit', label: 'Edit' },
  { key: 'canDelete', label: 'Delete' },
];

const CAP_RESOURCES: { key: CapResource; label: string }[] = [
  { key: 'payees', label: 'Payees' },
  { key: 'categories', label: 'Categories' },
  { key: 'tags', label: 'Tags' },
];

const CAP_OPS: { op: CapOp; label: string }[] = [
  { op: 'create', label: 'Create' },
  { op: 'edit', label: 'Edit' },
  { op: 'delete', label: 'Delete' },
];

const SECTIONS: { key: SectionKey; label: string; description: string }[] = [
  {
    key: 'bills',
    label: 'Bills & Deposits',
    description: 'Scheduled transactions for granted accounts',
  },
  {
    key: 'investments',
    label: 'Investments',
    description: 'Holdings and investment transactions for granted accounts',
  },
  { key: 'budgets', label: 'Budgets', description: 'Read-only budget figures' },
  { key: 'reports', label: 'Reports', description: 'Read-only reports' },
  {
    key: 'ai',
    label: 'AI Assistant',
    description: "Uses the owner's configured AI provider",
  },
];

const SECTION_FIELD: Record<SectionKey, keyof DelegateSectionFlags> = {
  bills: 'billsCanRead',
  investments: 'investmentsCanRead',
  budgets: 'budgetsCanRead',
  reports: 'reportsCanRead',
  ai: 'aiCanRead',
};

function emptyGrant(): DraftGrant {
  return { canRead: false, canCreate: false, canEdit: false, canDelete: false };
}

function buildInitialDraft(delegate: DelegateSummary): Draft {
  const grants: Record<string, DraftGrant> = {};
  for (const g of delegate.grants) {
    grants[g.accountId] = {
      canRead: !!g.canRead,
      canCreate: !!g.canCreate,
      canEdit: !!g.canEdit,
      canDelete: !!g.canDelete,
    };
  }
  const caps = delegate.capabilities;
  return {
    grants,
    capabilities: {
      payees: { ...caps.payees },
      categories: { ...caps.categories },
      tags: { ...caps.tags },
    },
    sections: {
      bills: !!delegate.sections?.bills,
      investments: !!delegate.sections?.investments,
      budgets: !!delegate.sections?.budgets,
      reports: !!delegate.sections?.reports,
      ai: !!delegate.sections?.ai,
    },
  };
}

/** Apply READ-prerequisite rules to a single grant change. */
function applyGrantRule(
  current: DraftGrant,
  op: GrantOp,
  value: boolean,
): DraftGrant {
  const next: DraftGrant = { ...current, [op]: value };
  if (op === 'canRead' && !value) {
    next.canCreate = false;
    next.canEdit = false;
    next.canDelete = false;
  }
  if (op !== 'canRead' && value) {
    next.canRead = true;
  }
  return next;
}

function grantsToArray(
  accounts: Account[],
  grants: Record<string, DraftGrant>,
): AccountGrant[] {
  return accounts
    .map((a) => ({ accountId: a.id, ...(grants[a.id] ?? emptyGrant()) }))
    .filter((g) => g.canRead);
}

interface DelegateAccessModalProps {
  delegate: DelegateSummary;
  accounts: Account[];
  onCancel: () => void;
  onSaved: () => void;
  setFormDirty: (dirty: boolean) => void;
  submitRef: MutableRefObject<(() => void) | null>;
}

export function DelegateAccessModal({
  delegate,
  accounts,
  onCancel,
  onSaved,
  setFormDirty,
  submitRef,
}: DelegateAccessModalProps) {
  const baseline = useMemo(
    () => buildInitialDraft(delegate),
    [delegate],
  );
  const [draft, setDraft] = useState<Draft>(baseline);
  const [tab, setTab] = useState<Tab>('accounts');
  const [saving, setSaving] = useState(false);

  const groupedAccounts = useMemo(() => {
    const groups = new Map<AccountType, Account[]>();
    for (const a of accounts) {
      const list = groups.get(a.accountType) ?? [];
      list.push(a);
      groups.set(a.accountType, list);
    }
    return Array.from(groups.entries()).sort((x, y) =>
      formatAccountType(x[0]).localeCompare(formatAccountType(y[0])),
    );
  }, [accounts]);

  const baselineGrantArray = useMemo(
    () => grantsToArray(accounts, baseline.grants),
    [accounts, baseline],
  );

  // Diffs against the baseline drive both the dirty flag and the batched save.
  const grantChanged =
    JSON.stringify(grantsToArray(accounts, draft.grants)) !==
    JSON.stringify(baselineGrantArray);

  const capabilityPatch: DelegateCapabilities = {};
  for (const { key: resource } of CAP_RESOURCES) {
    for (const { op } of CAP_OPS) {
      if (
        draft.capabilities[resource][op] !==
        baseline.capabilities[resource][op]
      ) {
        const cap = op.charAt(0).toUpperCase() + op.slice(1);
        const field =
          `${resource}Can${cap}` as keyof DelegateCapabilities;
        capabilityPatch[field] = draft.capabilities[resource][op];
      }
    }
  }

  const sectionPatch: DelegateSectionFlags = {};
  for (const { key } of SECTIONS) {
    if (draft.sections[key] !== baseline.sections[key]) {
      sectionPatch[SECTION_FIELD[key]] = draft.sections[key];
    }
  }

  const dirty =
    grantChanged ||
    Object.keys(capabilityPatch).length > 0 ||
    Object.keys(sectionPatch).length > 0;
  setFormDirty(dirty);

  const setGrant = (accountId: string, op: GrantOp, value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      grants: {
        ...prev.grants,
        [accountId]: applyGrantRule(
          prev.grants[accountId] ?? emptyGrant(),
          op,
          value,
        ),
      },
    }));
  };

  const setColumnForAccounts = (
    accountIds: string[],
    op: GrantOp,
    value: boolean,
  ) => {
    setDraft((prev) => {
      const grants = { ...prev.grants };
      for (const id of accountIds) {
        grants[id] = applyGrantRule(grants[id] ?? emptyGrant(), op, value);
      }
      return { ...prev, grants };
    });
  };

  const setCapability = (
    resource: CapResource,
    op: CapOp,
    value: boolean,
  ) => {
    setDraft((prev) => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [resource]: { ...prev.capabilities[resource], [op]: value },
      },
    }));
  };

  const setSection = (key: SectionKey, value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      sections: { ...prev.sections, [key]: value },
    }));
  };

  const handleSave = async () => {
    if (!dirty) {
      onSaved();
      return;
    }
    setSaving(true);
    try {
      const calls: Promise<void>[] = [];
      if (grantChanged) {
        calls.push(
          delegationApi.setGrants(
            delegate.id,
            grantsToArray(accounts, draft.grants),
          ),
        );
      }
      if (Object.keys(capabilityPatch).length > 0) {
        calls.push(
          delegationApi.setCapabilities(delegate.id, capabilityPatch),
        );
      }
      if (Object.keys(sectionPatch).length > 0) {
        calls.push(
          delegationApi.setSectionGrants(delegate.id, sectionPatch),
        );
      }
      await Promise.all(calls);
      toast.success('Access updated');
      setFormDirty(false);
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to update access'));
      logger.error(err);
    } finally {
      setSaving(false);
    }
  };

  submitRef.current = () => {
    void handleSave();
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'accounts', label: 'Accounts' },
    { key: 'sections', label: 'Sections' },
    { key: 'shared', label: 'Shared data' },
  ];

  return (
    <div className="flex flex-col max-h-[90vh]">
      <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Edit access
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {delegate.delegate.email}
        </p>
      </div>

      <div
        role="tablist"
        className="flex gap-1 border-b border-gray-200 dark:border-gray-700 px-2"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="overflow-y-auto px-4 py-3 h-[65vh]">
        {tab === 'sections' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Grant read-only access to whole app sections. Account-scoped
              data still also needs per-account access.
            </p>
            {SECTIONS.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between gap-4 border-b border-gray-100 dark:border-gray-700/50 pb-2"
              >
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {s.label}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {s.description}
                  </p>
                </div>
                <ToggleSwitch
                  checked={draft.sections[s.key]}
                  onChange={(v) => setSection(s.key, v)}
                  label={`${s.label} section`}
                />
              </div>
            ))}
          </div>
        )}

        {tab === 'accounts' && (
          <div className="space-y-3">
            {accounts.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No accounts to grant.
              </p>
            ) : (
              groupedAccounts.map(([type, list]) => {
                const typeLabel = formatAccountType(type);
                const ids = list.map((a) => a.id);
                return (
                  <details
                    key={type}
                    open
                    className="border border-gray-200 dark:border-gray-700 rounded-lg"
                  >
                    <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-gray-800 dark:text-gray-200">
                      {typeLabel}{' '}
                      <span className="text-xs text-gray-400">
                        ({list.length})
                      </span>
                    </summary>
                    <div className="px-3 pb-3">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-100 dark:border-gray-700/50 pb-2 mb-2">
                        <span className="w-40 text-xs uppercase tracking-wide text-gray-400">
                          Grant all
                        </span>
                        {GRANT_OPS.map((o) => (
                          <label
                            key={o.key}
                            className="flex items-center gap-1.5"
                          >
                            <ToggleSwitch
                              size="sm"
                              checked={list.every(
                                (a) =>
                                  !!(draft.grants[a.id] ?? emptyGrant())[
                                    o.key
                                  ],
                              )}
                              onChange={(v) =>
                                setColumnForAccounts(ids, o.key, v)
                              }
                              label={`${o.label} all ${typeLabel} accounts`}
                            />
                            <span className="text-xs">{o.label}</span>
                          </label>
                        ))}
                      </div>
                      <div className="space-y-2">
                        {list.map((a) => {
                          const g = draft.grants[a.id] ?? emptyGrant();
                          return (
                            <div
                              key={a.id}
                              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300"
                            >
                              <span className="w-40 truncate font-medium">
                                {a.name}
                              </span>
                              {GRANT_OPS.map((o) => (
                                <label
                                  key={o.key}
                                  className="flex items-center gap-1.5"
                                >
                                  <ToggleSwitch
                                    size="sm"
                                    checked={!!g[o.key]}
                                    disabled={
                                      o.key !== 'canRead' && !g.canRead
                                    }
                                    onChange={(v) =>
                                      setGrant(a.id, o.key, v)
                                    }
                                    label={`${o.label} access to ${a.name}`}
                                  />
                                  <span className="text-xs">{o.label}</span>
                                </label>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </details>
                );
              })
            )}
          </div>
        )}

        {tab === 'shared' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              READ of payees, categories and tags is always allowed. These
              control create/edit/delete.
            </p>
            {CAP_RESOURCES.map((res) => (
              <div
                key={res.key}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700/50 pb-2"
              >
                <span className="w-40 truncate font-medium">
                  {res.label}
                </span>
                {CAP_OPS.map((o) => (
                  <label key={o.op} className="flex items-center gap-1.5">
                    <ToggleSwitch
                      size="sm"
                      checked={draft.capabilities[res.key][o.op]}
                      onChange={(v) => setCapability(res.key, o.op, v)}
                      label={`${o.label} ${res.label}`}
                    />
                    <span className="text-xs">{o.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3 flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleSave()}
          isLoading={saving}
          disabled={!dirty}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
