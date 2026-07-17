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
import { Button } from '@/components/ui/Button';
import { SupportBackupModal } from '@/components/settings/SupportBackupModal';

const REPO_URL = 'https://github.com/kenlasko/monize';

const HELP_LINK_KEYS = [
  { key: 'github' as const, href: REPO_URL, Icon: CodeBracketIcon },
  { key: 'openIssue' as const, href: `${REPO_URL}/issues/new`, Icon: ExclamationTriangleIcon },
  { key: 'discussions' as const, href: `${REPO_URL}/discussions`, Icon: ChatBubbleLeftRightIcon },
  { key: 'wiki' as const, href: `${REPO_URL}/wiki`, Icon: BookOpenIcon },
] as const;

export function HelpSection() {
  const t = useTranslations('settings.help');
  const [supportBackupOpen, setSupportBackupOpen] = useState(false);

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('description')}
      </p>

      <div className="mb-4 flex items-start gap-3 rounded-md border border-gray-200 dark:border-gray-700 px-4 py-3">
        <ShieldCheckIcon className="h-6 w-6 shrink-0 text-gray-400 dark:text-gray-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('supportBackup.label')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('supportBackup.description')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setSupportBackupOpen(true)}>
          {t('supportBackup.action')}
        </Button>
      </div>

      <ul className="space-y-2">
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
