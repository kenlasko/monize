'use client';

import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  CodeBracketIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';

interface HelpLink {
  readonly label: string;
  readonly description: string;
  readonly href: string;
  readonly Icon: typeof CodeBracketIcon;
}

const REPO_URL = 'https://github.com/kenlasko/monize';

const HELP_LINKS: readonly HelpLink[] = [
  {
    label: 'GitHub',
    description: 'View the source code and star the project.',
    href: REPO_URL,
    Icon: CodeBracketIcon,
  },
  {
    label: 'Open an Issue',
    description: 'Report a bug or request a feature.',
    href: `${REPO_URL}/issues/new`,
    Icon: ExclamationTriangleIcon,
  },
  {
    label: 'Discussions',
    description: 'Ask questions and share ideas with the community.',
    href: `${REPO_URL}/discussions`,
    Icon: ChatBubbleLeftRightIcon,
  },
  {
    label: 'Wiki',
    description: 'Browse guides and documentation.',
    href: `${REPO_URL}/wiki`,
    Icon: BookOpenIcon,
  },
] as const;

export function HelpSection() {
  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Help & Support
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Find documentation, report issues, or join the conversation.
      </p>
      <ul className="space-y-2">
        {HELP_LINKS.map(({ label, description, href, Icon }) => (
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
        ))}
      </ul>
    </div>
  );
}
