'use client';

import { useState } from 'react';
import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  CodeBracketIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { SupportBackupModal } from '@/components/settings/SupportBackupModal';
import { GITHUB_REPO_URL as REPO_URL } from '@/lib/github';
import { docsUrl } from '@/lib/docs-links';
import { onHelpLinkClick, useHelpPrefetch } from '@/lib/help-open';

const HELP_LINK_KEYS = [
  { key: 'github' as const, href: REPO_URL, Icon: CodeBracketIcon },
  { key: 'openIssue' as const, href: `${REPO_URL}/issues/new`, Icon: ExclamationTriangleIcon },
  { key: 'discussions' as const, href: `${REPO_URL}/discussions`, Icon: ChatBubbleLeftRightIcon },
] as const;

export function HelpSection() {
  const t = useTranslations('settings.help');
  const [supportBackupOpen, setSupportBackupOpen] = useState(false);
  useHelpPrefetch();

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('description')}
      </p>

      <ul className="space-y-2">
        <li>
          <button
            type="button"
            onClick={() => setSupportBackupOpen(true)}
            className="flex w-full items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            <ShieldCheckIcon className="h-6 w-6 shrink-0 text-gray-400 dark:text-gray-500" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                {t('supportBackup.label')}
              </span>
              <span className="block text-sm text-gray-500 dark:text-gray-400">
                {t('supportBackup.description')}
              </span>
            </span>
          </button>
        </li>
        <li>
          {/* The guide opens in the help panel when the server bundles it; the
              anchor's own href is the fallback, so the tile is never a dead
              button. The website also stays one click away on the right. */}
          <div className="flex items-stretch rounded-md border border-gray-200 dark:border-gray-700">
            <a
              href={docsUrl('home')}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => onHelpLinkClick(e, 'home')}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <BookOpenIcon className="h-6 w-6 shrink-0 text-gray-400 dark:text-gray-500" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('docs.label')}
                </span>
                <span className="block text-sm text-gray-500 dark:text-gray-400">
                  {t('docs.description')}
                </span>
              </span>
            </a>
            <a
              href={docsUrl('home')}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 rounded-r-md border-l border-gray-200 px-3 text-sm text-blue-600 hover:bg-gray-50 dark:border-gray-700 dark:text-blue-400 dark:hover:bg-gray-700 transition-colors"
            >
              {t('docs.openOnline')}
              <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0" />
            </a>
          </div>
        </li>
        {HELP_LINK_KEYS.map(({ key, href, Icon }) => {
          const label = t(`${key}.label`);
          const description = t(`${key}.description`);
          return (
            <li key={href}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Icon className="h-6 w-6 shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    {label}
                  </span>
                  <span className="block text-sm text-gray-500 dark:text-gray-400">
                    {description}
                  </span>
                </span>
                <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              </a>
            </li>
          );
        })}
      </ul>

      <SupportBackupModal
        isOpen={supportBackupOpen}
        onClose={() => setSupportBackupOpen(false)}
      />
    </div>
  );
}
