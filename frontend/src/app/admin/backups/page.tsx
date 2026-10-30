'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { AutoBackupSection } from '@/components/settings/AutoBackupSection';
import { useAuthStore } from '@/store/authStore';
import { useDemoMode } from '@/hooks/useDemoMode';
import { docsUrl } from '@/lib/docs-links';

export default function AdminBackupsPage() {
  return (
    <ProtectedRoute>
      <AdminBackupsContent />
    </ProtectedRoute>
  );
}

/**
 * Instance-level automatic backup configuration: where the server writes its
 * scheduled per-user backup files, how often, and how many it keeps.
 *
 * This is an operator surface, not an account preference. The endpoints behind
 * it live on `AutoBackupController` under a class-level `@Roles("admin")`, and
 * what they read and write is one deployment policy that every active account
 * is reconciled onto (`docs/backup-restore-contract.md` section 7). A person's
 * own manual export/restore lives in Settings -> Backup & Restore instead, and
 * touches only their own data.
 *
 * The admin gate mirrors `admin/notifications`: an admin-only endpoint answers a
 * non-admin with a 403, so the page redirects rather than fetching, and renders
 * nothing while the auth store is still hydrating (`role` undefined).
 */
function AdminBackupsContent() {
  const t = useTranslations('admin.backupsPage');
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';
  const isDemoMode = useDemoMode();

  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      router.push('/dashboard');
    }
  }, [currentUser, router]);

  if (!isAdmin) {
    return null;
  }

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          helpUrl={docsUrl('adminBackups')}
        />

        {isDemoMode && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              {t('demoRestricted.heading')}
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('demoRestricted.body')}
            </p>
          </div>
        )}

        {/* The one thing this page must make unambiguous: what an automatic
            backup is and, more importantly, what it is not. Two paragraphs, not
            five -- an operator who stops reading after the first has still been
            told the thing that matters. */}
        <Card as="section" padding="md" className="mb-6" aria-labelledby="admin-backups-scope-heading">
          <h2
            id="admin-backups-scope-heading"
            className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2"
          >
            {t('scope.heading')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
            {t('scope.perUser')}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('scope.notFullDatabase')}
          </p>
        </Card>

        <AutoBackupSection />
      </main>
    </PageLayout>
  );
}
