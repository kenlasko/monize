/**
 * The Settings page's sections, in page order. A section with an `href` is a
 * page of its own; the others are anchors on `/settings`.
 */
export const SETTINGS_SECTION_IDS = [
  { id: 'profile', navKey: 'profile', demoVisible: false },
  { id: 'preferences', navKey: 'preferences', demoVisible: true },
  { id: 'notifications', navKey: 'notifications', demoVisible: true },
  { id: 'security', navKey: 'security', demoVisible: false },
  { id: 'shared-access', navKey: 'sharedAccess', href: '/settings/shared-access', demoVisible: false },
  { id: 'emergency-access', navKey: 'emergencyAccess', href: '/settings/emergency-access', demoVisible: false },
  { id: 'api-access', navKey: 'apiAccess', demoVisible: false },
  { id: 'ai-settings', navKey: 'aiSettings', href: '/settings/ai', demoVisible: false },
  { id: 'bank-sync', navKey: 'bankSync', href: '/settings/bank-sync', demoVisible: false },
  { id: 'email-receipts', navKey: 'emailReceipts', href: '/email-receipts', demoVisible: false },
  { id: 'payee-lookup', navKey: 'payeeLookup', demoVisible: false },
  // Manual export/restore for the current user's own data. Automatic-backup
  // configuration is a deployment/operator concern and lives on its own
  // admin-only surface (Admin -> Backups, `/admin/backups`), not here.
  { id: 'backup-restore', navKey: 'backupRestore', demoVisible: false },
  { id: 'help', navKey: 'help', demoVisible: false },
  { id: 'tours', navKey: 'tours', href: '/settings/tours', demoVisible: true },
  { id: 'about', navKey: 'about', demoVisible: true },
  { id: 'danger-zone', navKey: 'dangerZone', variant: 'danger' as const, demoVisible: false },
] as const;
