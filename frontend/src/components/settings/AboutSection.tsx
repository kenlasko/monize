'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import toast from 'react-hot-toast';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  ScaleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TagIcon,
} from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { useDemoStore } from '@/store/demoStore';
import { useWhatsNewStore } from '@/store/whatsNewStore';
import { useTheme } from '@/contexts/ThemeContext';
import { updatesApi, type UpdateStatus } from '@/lib/updatesApi';
import { GITHUB_REPO_URL as REPO_URL } from '@/lib/github';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { createLogger } from '@/lib/logger';
import { CARD_CLASS } from '@/components/ui/Card';

const logger = createLogger('AboutSection');

const TILE_CLASSES =
  'flex w-full items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors';
const TILE_ICON_CLASSES = 'h-6 w-6 shrink-0 text-gray-400 dark:text-gray-500';
const TILE_LABEL_CLASSES =
  'block text-sm font-medium text-gray-900 dark:text-gray-100';
const TILE_DESCRIPTION_CLASSES =
  'block text-sm text-gray-500 dark:text-gray-400';

/**
 * Build the plain-text diagnostics block copied to the clipboard.
 *
 * Deliberately English-only, like the release notes themselves: this text is
 * written to be pasted into a GitHub issue that a maintainer reads, so
 * translating the labels would make reports harder to triage, not easier. The
 * button and toasts around it are translated normally.
 */
function buildDiagnostics(fields: {
  uiVersion: string;
  apiVersion: string | undefined;
  locale: string;
  theme: string;
  demoMode: boolean;
  authProvider: string | undefined;
}): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const userAgent =
    typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;
  return [
    'Monize diagnostics',
    `UI version: ${fields.uiVersion}`,
    `API version: ${fields.apiVersion ?? 'unknown'}`,
    `Locale: ${fields.locale}`,
    `Time zone: ${timeZone || 'unknown'}`,
    `Theme: ${fields.theme}`,
    `Demo mode: ${fields.demoMode ? 'yes' : 'no'}`,
    `Auth provider: ${fields.authProvider ?? 'unknown'}`,
    `Browser: ${userAgent}`,
  ].join('\n');
}

/**
 * Settings "About" section: what this instance is running, where to read the
 * release notes, and the project's licence and security policy.
 *
 * It replaces the bare clickable version label that used to sit under the
 * settings cards -- the release notes are now reachable from a labelled row
 * instead of only from the version string, though that string stays clickable
 * (and keeps its tour anchor) so the existing 1.13.0 tour still applies.
 *
 * The API version comes from the store rather than a request of its own:
 * `WhatsNewHost` already fetches the backend's release-notes payload on every
 * load and publishes the version it reports. Showing it only matters when it
 * disagrees with the UI build, which means a rolling upgrade half landed.
 */
export function AboutSection() {
  const t = useTranslations('settings.about');
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  const openWhatsNew = useWhatsNewStore((s) => s.open);
  const backendVersion = useWhatsNewStore((s) => s.backendVersion);
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isDemoMode = useDemoStore((s) => s.isDemoMode);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  const isAdmin = isAuthenticated && user?.role === 'admin';

  // Update status is an admin-only endpoint, so non-admins simply never see the
  // row. Failures stay silent for the same reason the update banner's do -- it
  // is a nicety, and an unreachable GitHub should not raise an error here.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;

    updatesApi
      .getStatus()
      .then((status) => {
        if (!cancelled) setUpdateStatus(status);
      })
      .catch((error) => {
        logger.debug('Failed to fetch update status', error);
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const handleCopyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(
        buildDiagnostics({
          uiVersion: version ?? 'unknown',
          apiVersion: backendVersion,
          locale,
          theme: resolvedTheme,
          demoMode: isDemoMode,
          authProvider: user?.authProvider,
        }),
      );
      toast.success(t('diagnostics.copied'));
    } catch {
      toast.error(t('diagnostics.copyFailed'));
    }
  };

  const versionMismatch = Boolean(
    version && backendVersion && backendVersion !== version,
  );

  const links = [
    {
      key: 'allReleases',
      href: `${REPO_URL}/releases`,
      Icon: TagIcon,
    },
    {
      key: 'license',
      href: `${REPO_URL}/blob/main/LICENSE`,
      Icon: ScaleIcon,
    },
    {
      key: 'securityPolicy',
      href: `${REPO_URL}/security/policy`,
      Icon: ShieldCheckIcon,
    },
  ] as const;

  return (
    <div className={`${CARD_CLASS} p-6 mb-6`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('description')}
      </p>

      <div className="flex items-center gap-4 mb-4">
        <Image
          src="/icons/monize-logo-transparent.svg"
          alt=""
          width={56}
          height={56}
          className="shrink-0 rounded-xl"
        />
        <div className="min-w-0">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('appName')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('tagline')}
          </p>
        </div>
      </div>

      <dl className="mb-4 divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700 text-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <dt className="text-gray-500 dark:text-gray-400">
            {t('versionLabel')}
          </dt>
          <dd className="text-gray-900 dark:text-gray-100 font-medium">
            {version ? (
              <button
                type="button"
                {...tourAnchor(TOUR_ANCHORS.settingsAppVersion)}
                onClick={openWhatsNew}
                title={t('versionButtonTitle', { version })}
                className="hover:underline focus:outline-none focus:underline"
              >
                v{version}
              </button>
            ) : (
              t('versionUnknown')
            )}
          </dd>
        </div>

        {versionMismatch && (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <dt className="text-gray-500 dark:text-gray-400">
              {t('apiVersionLabel')}
            </dt>
            <dd className="font-medium text-amber-700 dark:text-amber-400">
              v{backendVersion}
            </dd>
          </div>
        )}

        {isAdmin && updateStatus && !updateStatus.disabled && (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <dt className="text-gray-500 dark:text-gray-400">
              {t('updateLabel')}
            </dt>
            <dd className="flex items-center gap-2 font-medium">
              {updateStatus.updateAvailable ? (
                <>
                  <span className="text-blue-700 dark:text-blue-300">
                    {updateStatus.latestVersion
                      ? t('updateAvailable', {
                          version: updateStatus.latestVersion,
                        })
                      : t('updateAvailableGeneric')}
                  </span>
                  {updateStatus.releaseUrl && (
                    <a
                      href={updateStatus.releaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {t('updateViewRelease')}
                    </a>
                  )}
                </>
              ) : (
                <span className="flex items-center gap-1.5 text-green-700 dark:text-green-400">
                  <CheckCircleIcon className="h-4 w-4 shrink-0" />
                  {t('updateUpToDate')}
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>

      {versionMismatch && (
        <p className="mb-4 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
          <span>{t('versionMismatch')}</span>
        </p>
      )}

      <ul className="space-y-2">
        <li>
          <button type="button" onClick={openWhatsNew} className={TILE_CLASSES}>
            <SparklesIcon className={TILE_ICON_CLASSES} />
            <span className="min-w-0 flex-1">
              <span className={TILE_LABEL_CLASSES}>
                {version
                  ? t('whatsNew.label', { version })
                  : t('whatsNew.labelGeneric')}
              </span>
              <span className={TILE_DESCRIPTION_CLASSES}>
                {t('whatsNew.description')}
              </span>
            </span>
          </button>
        </li>

        {links.map(({ key, href, Icon }) => (
          <li key={key}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={TILE_CLASSES}
            >
              <Icon className={TILE_ICON_CLASSES} />
              <span className="min-w-0 flex-1">
                <span className={TILE_LABEL_CLASSES}>{t(`${key}.label`)}</span>
                <span className={TILE_DESCRIPTION_CLASSES}>
                  {t(`${key}.description`)}
                </span>
              </span>
              <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
            </a>
          </li>
        ))}

        <li>
          <button
            type="button"
            onClick={handleCopyDiagnostics}
            className={TILE_CLASSES}
          >
            <ClipboardDocumentIcon className={TILE_ICON_CLASSES} />
            <span className="min-w-0 flex-1">
              <span className={TILE_LABEL_CLASSES}>
                {t('diagnostics.label')}
              </span>
              <span className={TILE_DESCRIPTION_CLASSES}>
                {t('diagnostics.description')}
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
}
