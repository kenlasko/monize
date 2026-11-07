'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AdminUser } from '@/types/auth';
import { AdminUserStorage } from '@/lib/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatTime } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { SortIcon } from '@/components/ui/SortIcon';
import { CellLabel, SortableTh, TABLE_BODY_CLASS, TABLE_CLASS, Th } from '@/components/ui/Table';
import { useDensityPreference } from '@/store/densityStore';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLocalStorage } from '@/hooks/useLocalStorage';

/**
 * What the two storage columns know, which is not the same question as what the
 * user list knows: the figures come from their own request, so they are still
 * loading when the rows are already on screen, and they can fail on their own.
 *
 * Three states rather than an optional map, because "not fetched yet", "the
 * request failed" and "fetched, and this user has no row in it" need three
 * different things said to the reader -- and an optional map collapses all
 * three into an empty cell that reads as zero.
 */
export type AdminStorageState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; byUser: Map<string, AdminUserStorage> };

/** The columns the user list sorts by; the storage figures can be unknown, so they do not sort. */
export type AdminUserSortField = 'name' | 'role' | 'provider' | 'status' | 'lastLogin';
type SortDirection = 'asc' | 'desc';

/**
 * Every sortable field in header order. A `Record` keyed by the union so the
 * phone's slim header, which announces a direction unconditionally, cannot
 * offer fewer fields than the list can be sorted by.
 */
const SORT_FIELD_ORDER: Record<AdminUserSortField, number> = {
  name: 0,
  role: 1,
  provider: 2,
  status: 3,
  lastLogin: 4,
};

const SORT_FIELDS: readonly AdminUserSortField[] = (
  Object.keys(SORT_FIELD_ORDER) as AdminUserSortField[]
).sort((a, b) => SORT_FIELD_ORDER[a] - SORT_FIELD_ORDER[b]);

interface UserManagementTableProps {
  users: AdminUser[];
  storage: AdminStorageState;
  currentUserId: string;
  /** OIDC_ALLOW_PASSWORD_LOGIN: an SSO row's password resets only while it can sign in. */
  oidcPasswordLogin?: boolean;
  onChangeRole: (user: AdminUser, role: 'admin' | 'user') => void;
  onToggleStatus: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onUnlinkSso: (user: AdminUser) => void;
  onResetTwoFactor: (user: AdminUser) => void;
  onDeleteUser: (user: AdminUser) => void;
}

type UserRowActions = Pick<
  UserManagementTableProps,
  'onChangeRole' | 'onToggleStatus' | 'onResetPassword' | 'onUnlinkSso' | 'onResetTwoFactor' | 'onDeleteUser'
>;

export function UserManagementTable({
  users,
  storage,
  currentUserId,
  oidcPasswordLogin = false,
  ...handlers
}: UserManagementTableProps) {
  const t = useTranslations('admin');
  const { formatDate } = useDateFormat();
  const timeFormat = usePreferencesStore((s) => s.preferences?.timeFormat) || '24h';
  const [sortField, setSortField] = useLocalStorage<AdminUserSortField>('monize-admin-users-sort-field', 'name');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-admin-users-sort-dir', 'asc');
  const { density } = useDensityPreference('adminUsers');
  const { cellPadding, headerPadding } = useTableDensity(density);
  // On a phone at Normal density each user is one wrapped card, as on the
  // reference lists; Compact and Dense keep the table.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  const formatLastLogin = (iso: string): string => {
    const d = new Date(iso);
    const time24 = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${formatDate(d)} ${formatTime(time24, timeFormat)}`;
  };

  const getUserDisplayName = (user: AdminUser): string => {
    if (user.firstName || user.lastName) {
      return [user.firstName, user.lastName].filter(Boolean).join(' ');
    }
    return user.email || t('userTable.unknown');
  };

  const sortedUsers = useMemo(() => {
    const key = (user: AdminUser): string | number => {
      switch (sortField) {
        case 'role':
          return user.role;
        case 'provider':
          return user.authProvider;
        case 'status':
          return user.isActive ? 0 : 1;
        case 'lastLogin':
          // Never signed in sorts as the oldest login.
          return user.lastLogin ? new Date(user.lastLogin).getTime() : 0;
        default:
          return (
            [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || ''
          ).toLowerCase();
      }
    };
    const sign = sortDirection === 'asc' ? 1 : -1;
    return [...users].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const order =
        typeof ka === 'number' && typeof kb === 'number'
          ? ka - kb
          : String(ka).localeCompare(String(kb));
      // Ties keep the order the accounts were created in.
      return (
        order * sign ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    });
  }, [users, sortField, sortDirection]);

  const handleSort = (field: AdminUserSortField) => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };
  const sortProps = { sortField, sortDirection, onSort: handleSort };

  const sortFieldLabels: Record<AdminUserSortField, string> = {
    name: t('userTable.colUser'),
    role: t('userTable.colRole'),
    provider: t('userTable.colProvider'),
    status: t('userTable.colStatus'),
    lastLogin: t('userTable.colLastLogin'),
  };

  return (
    <div>
      <DensityToggleBar view="adminUsers" />
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
              <tr>
                {/* The card names its own values, so the header keeps only the
                    sort controls, every sortable field as a button. */}
                <th
                  className={`${headerPadding} text-left`}
                  aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
                >
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {SORT_FIELDS.map((field) => (
                      <button
                        key={field}
                        type="button"
                        onClick={() => handleSort(field)}
                        className="flex items-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
                      >
                        {sortFieldLabels[field]}
                        <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
                      </button>
                    ))}
                  </div>
                </th>
              </tr>
            ) : (
              <tr>
                <SortableTh {...sortProps} field="name" className={headerPadding}>
                  {sortFieldLabels.name}
                </SortableTh>
                <SortableTh {...sortProps} field="role" className={headerPadding}>
                  {sortFieldLabels.role}
                </SortableTh>
                <SortableTh {...sortProps} field="provider" className={headerPadding}>
                  {sortFieldLabels.provider}
                </SortableTh>
                <SortableTh {...sortProps} field="status" className={headerPadding}>
                  {sortFieldLabels.status}
                </SortableTh>
                <SortableTh {...sortProps} field="lastLogin" className={headerPadding}>
                  {sortFieldLabels.lastLogin}
                </SortableTh>
                <Th className={headerPadding}>{t('userTable.colBackups')}</Th>
                <Th className={headerPadding}>{t('userTable.colAttachments')}</Th>
                <Th
                  align="right"
                  className={`${headerPadding} sticky right-0 bg-gray-50 dark:bg-gray-800`}
                >
                  {t('userTable.colActions')}
                </Th>
              </tr>
            )}
          </thead>
          <tbody className={`bg-white dark:bg-gray-900 ${TABLE_BODY_CLASS}`}>
            {sortedUsers.map((user, index) => {
              const isSelf = user.id === currentUserId;
              const rowBg = isSelf
                ? 'bg-blue-50 dark:bg-blue-950'
                : density !== 'normal' && index % 2 === 1
                  ? 'bg-gray-50 dark:bg-table-stripe-dark'
                  : 'bg-white dark:bg-gray-900';
              const lastLogin = user.lastLogin ? formatLastLogin(user.lastLogin) : t('userTable.never');

              if (wrapped) {
                return (
                  <tr key={user.id} className={rowBg}>
                    <td className="p-0">
                      <div className={cellPadding}>
                        <div className="flex items-start justify-between gap-3">
                          <UserIdentity user={user} isSelf={isSelf} name={getUserDisplayName(user)} />
                          <StatusControl user={user} isSelf={isSelf} onToggleStatus={handlers.onToggleStatus} />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                          <div>
                            <CellLabel>{sortFieldLabels.role}</CellLabel>
                            <RoleControl user={user} isSelf={isSelf} onChangeRole={handlers.onChangeRole} />
                          </div>
                          <div>
                            <CellLabel>{sortFieldLabels.provider}</CellLabel>
                            <ProviderBadge user={user} />
                          </div>
                          <div className="col-span-2">
                            <CellLabel>{sortFieldLabels.lastLogin}</CellLabel>
                            <div className="text-sm text-gray-500 dark:text-gray-400">{lastLogin}</div>
                          </div>
                          <div>
                            <CellLabel>{t('userTable.colBackups')}</CellLabel>
                            <BackupUsageCell state={storage} userId={user.id} />
                          </div>
                          <div>
                            <CellLabel>{t('userTable.colAttachments')}</CellLabel>
                            <AttachmentUsageCell state={storage} userId={user.id} />
                          </div>
                        </div>
                        {!isSelf && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <UserActionButtons user={user} oidcPasswordLogin={oidcPasswordLogin} {...handlers} />
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={user.id} className={`group hover:bg-gray-100 dark:hover:bg-gray-800 ${rowBg}`}>
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <UserIdentity user={user} isSelf={isSelf} name={getUserDisplayName(user)} />
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <RoleControl user={user} isSelf={isSelf} onChangeRole={handlers.onChangeRole} />
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <ProviderBadge user={user} />
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <StatusControl user={user} isSelf={isSelf} onToggleStatus={handlers.onToggleStatus} />
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400`}>
                    {lastLogin}
                  </td>
                  {/* Automatic backups held for this user */}
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <BackupUsageCell state={storage} userId={user.id} />
                  </td>
                  {/* Attachment bytes this user has uploaded */}
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <AttachmentUsageCell state={storage} userId={user.id} />
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap text-right text-sm space-x-2 sticky right-0 ${rowBg} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
                    {!isSelf && <UserActionButtons user={user} oidcPasswordLogin={oidcPasswordLogin} {...handlers} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sortedUsers.length === 0 && (
        <EmptyState title={t('userTable.noUsers')} help="adminUsers" />
      )}
    </div>
  );
}

/** The user's name, the "(you)" marker and the email under it. */
function UserIdentity({ user, isSelf, name }: { user: AdminUser; isSelf: boolean; name: string }) {
  const t = useTranslations('admin');
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
        {name}
        {isSelf && (
          <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">{t('userTable.youSuffix')}</span>
        )}
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400 break-all">
        {user.email || t('userTable.noEmail')}
      </div>
    </div>
  );
}

/** The role, as a badge for the admin themself and a select for anyone else. */
function RoleControl({
  user,
  isSelf,
  onChangeRole,
}: {
  user: AdminUser;
  isSelf: boolean;
  onChangeRole: UserRowActions['onChangeRole'];
}) {
  const t = useTranslations('admin');
  if (isSelf) {
    return <RoleBadge role={user.role} adminLabel={t('userTable.roleAdmin')} userLabel={t('userTable.roleUser')} />;
  }
  return (
    <select
      value={user.role}
      aria-label={t('userTable.colRole')}
      onChange={(e) => onChangeRole(user, e.target.value as 'admin' | 'user')}
      className="text-sm rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
    >
      <option value="admin">{t('userTable.roleAdmin')}</option>
      <option value="user">{t('userTable.roleUser')}</option>
    </select>
  );
}

function ProviderBadge({ user }: { user: AdminUser }) {
  const t = useTranslations('admin');
  return (
    <Badge variant={user.authProvider === 'oidc' ? 'purple' : 'gray'}>
      {user.authProvider === 'oidc' ? t('userTable.providerSso') : t('userTable.providerLocal')}
    </Badge>
  );
}

/** The status, as a badge for the admin themself and a toggle for anyone else. */
function StatusControl({
  user,
  isSelf,
  onToggleStatus,
}: {
  user: AdminUser;
  isSelf: boolean;
  onToggleStatus: UserRowActions['onToggleStatus'];
}) {
  const t = useTranslations('admin');
  const badge = (clickable?: boolean) => (
    <StatusBadge
      isActive={user.isActive}
      activeLabel={t('userTable.statusActive')}
      disabledLabel={t('userTable.statusDisabled')}
      clickable={clickable}
    />
  );
  if (isSelf) return badge();
  return (
    <button
      onClick={() => onToggleStatus(user)}
      className="group flex items-center"
      title={user.isActive ? t('userTable.clickToDisable') : t('userTable.clickToEnable')}
    >
      {badge(true)}
    </button>
  );
}

/** Reset Password, Reset 2FA and Delete for any user but the admin themself. */
function UserActionButtons({
  user,
  oidcPasswordLogin,
  onResetPassword,
  onUnlinkSso,
  onResetTwoFactor,
  onDeleteUser,
}: { user: AdminUser; oidcPasswordLogin: boolean } & UserRowActions) {
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  return (
    <>
      {user.hasPassword && (user.authProvider !== 'oidc' || oidcPasswordLogin) && (
        <Button variant="outline" size="sm" onClick={() => onResetPassword(user)}>
          {t('userTable.resetPassword')}
        </Button>
      )}
      {user.authProvider === 'oidc' && (
        <Button variant="outline" size="sm" onClick={() => onUnlinkSso(user)}>
          {t('userTable.unlinkSso')}
        </Button>
      )}
      {/* Offered for every other user: the list does not carry 2FA state, and
          the server refuses (400) a user with none, which the page reports. */}
      <Button variant="outline" size="sm" onClick={() => onResetTwoFactor(user)}>
        {t('userTable.resetTwoFactor')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onDeleteUser(user)}
        className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/50"
      >
        {tc('delete')}
      </Button>
    </>
  );
}

/**
 * A figure that is not a figure: still loading, unavailable, or genuinely
 * unknown. Rendered in its own muted style so it cannot be misread as a size,
 * and always carrying the reason -- a cell that only says "Unknown" tells the
 * reader nothing they can act on.
 */
function AbsentFigure({ label, hint }: { label: string; hint?: string }) {
  return (
    <span
      className="text-sm italic text-gray-400 dark:text-gray-500"
      title={hint}
    >
      {label}
    </span>
  );
}

/** A size over the line that says what it covers. */
function StorageFigure({ size, detail, note }: { size: string; detail: string; note?: { label: string; hint: string } }) {
  return (
    <>
      <div className="text-sm text-gray-900 dark:text-gray-100">{size}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {detail}
        {note && (
          <span className="ml-1 text-amber-600 dark:text-amber-500" title={note.hint}>
            {note.label}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * The shell both storage columns share: the three ways a figure can be absent
 * before either column's own reading begins.
 *
 * Written once because the three are the same question for both columns and
 * because each has to stay distinguishable -- "not fetched yet", "the request
 * failed" and "this user was not in the reading" have three different repairs,
 * and a shared empty cell would read as zero for all of them. `render` is
 * reached only with a reading that actually covers this user.
 */
function StorageCell({
  state,
  userId,
  render,
}: {
  state: AdminStorageState;
  userId: string;
  render: (usage: AdminUserStorage) => ReactNode;
}) {
  const t = useTranslations('admin');

  if (state.status === 'loading') {
    return <AbsentFigure label={t('userTable.storageLoading')} />;
  }
  if (state.status === 'error') {
    return (
      <AbsentFigure
        label={t('userTable.storageUnavailable')}
        hint={t('userTable.storageUnavailableHint')}
      />
    );
  }

  const usage = state.byUser.get(userId);
  if (!usage) {
    return (
      <AbsentFigure
        label={t('userTable.storageNotReported')}
        hint={t('userTable.storageNotReportedHint')}
      />
    );
  }
  return <>{render(usage)}</>;
}

/**
 * How much of the backup store this user's automatic backups occupy.
 *
 * Two absences of its own beyond the shared three: the store could not be
 * enumerated for this user (`bytes` and `artifacts` are null together), and the
 * schedule is off with nothing stored. Neither is zero, and a known zero is a
 * real answer rather than an absence. The schedule is also a separate fact from
 * the bytes -- a user switched off still occupies whatever retention has not
 * aged out -- so "off" is the headline only when there is nothing stored, and a
 * note beside the size otherwise.
 */
function BackupUsageCell({ state, userId }: { state: AdminStorageState; userId: string }) {
  const t = useTranslations('admin');
  const { formatBytes } = useNumberFormat();

  return (
    <StorageCell
      state={state}
      userId={userId}
      render={({ backups: { enabled, artifacts, bytes } }) => {
        if (bytes === null || artifacts === null) {
          return (
            <AbsentFigure
              label={t('userTable.storageUnknown')}
              hint={t('userTable.storageUnknownStore')}
            />
          );
        }
        if (!enabled && artifacts === 0) {
          return (
            <AbsentFigure
              label={t('userTable.backupsOff')}
              hint={t('userTable.backupsOffHint')}
            />
          );
        }
        return (
          <StorageFigure
            size={formatBytes(bytes)}
            detail={t('userTable.backupCount', { count: artifacts })}
            note={
              enabled
                ? undefined
                : {
                    label: t('userTable.backupScheduleOff'),
                    hint: t('userTable.backupScheduleOffHint'),
                  }
            }
          />
        );
      }}
    />
  );
}

/**
 * How much this user's transaction attachments occupy.
 *
 * No unknown of its own, unlike the backups: the figure is a COUNT and a SUM
 * over the metadata rows that record each file's size, so it is known whichever
 * provider holds the bytes -- database, local disk or S3 -- and an account with
 * no attachments genuinely stores zero.
 */
function AttachmentUsageCell({ state, userId }: { state: AdminStorageState; userId: string }) {
  const t = useTranslations('admin');
  const { formatBytes } = useNumberFormat();

  return (
    <StorageCell
      state={state}
      userId={userId}
      render={({ attachments }) => (
        <StorageFigure
          size={formatBytes(attachments.bytes)}
          detail={t('userTable.attachmentCount', { count: attachments.files })}
        />
      )}
    />
  );
}

function RoleBadge({ role, adminLabel, userLabel }: { role: string; adminLabel: string; userLabel: string }) {
  return (
    <Badge variant={role === 'admin' ? 'blue' : 'gray'}>
      {role === 'admin' ? adminLabel : userLabel}
    </Badge>
  );
}

function StatusBadge({ isActive, activeLabel, disabledLabel, clickable }: { isActive: boolean; activeLabel: string; disabledLabel: string; clickable?: boolean }) {
  return (
    <Badge
      variant={isActive ? 'green' : 'red'}
      className={clickable ? 'cursor-pointer hover:opacity-80' : undefined}
    >
      {isActive ? activeLabel : disabledLabel}
    </Badge>
  );
}
