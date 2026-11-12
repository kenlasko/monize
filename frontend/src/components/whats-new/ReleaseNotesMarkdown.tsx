'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkIssueLinks } from '@/lib/markdown/remark-issue-links';
import { onGuideLinkClick, useHelpPrefetch } from '@/lib/help-open';

interface ReleaseNotesMarkdownProps {
  content: string;
  /** `lead` sets the release's intro a size up, as the dialog's opening line. */
  size?: 'body' | 'lead';
}

/**
 * Renders a snippet of release-notes Markdown for the What's New modal.
 * Patterned on AssistantMarkdown but tuned for readable prose in a dialog:
 * external links open in a new tab, and the `#123` references the notes credit
 * their changes with become links to GitHub. Headings are intentionally styled
 * small because the modal supplies the section/subsection structure itself.
 *
 * A link into the guide (`isGuideUrl`, e.g. a release note linking a new
 * feature's page) opens the help panel there on a plain click instead of
 * monize.net; a modified click still goes to the website (`onGuideLinkClick`).
 */
export function ReleaseNotesMarkdown({
  content,
  size = 'body',
}: ReleaseNotesMarkdownProps) {
  useHelpPrefetch();
  if (!content) return null;

  return (
    <div
      className={`${size === 'lead' ? 'text-base' : 'text-sm'} text-gray-700 dark:text-gray-300`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkIssueLinks]}
        components={{
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
          ),
          h1: ({ children }) => (
            <h4 className="text-sm font-semibold mt-3 mb-1 first:mt-0 text-gray-900 dark:text-gray-100">
              {children}
            </h4>
          ),
          h2: ({ children }) => (
            <h4 className="text-sm font-semibold mt-3 mb-1 first:mt-0 text-gray-900 dark:text-gray-100">
              {children}
            </h4>
          ),
          h3: ({ children }) => (
            <h5 className="text-sm font-semibold mt-2 mb-1 first:mt-0 text-gray-900 dark:text-gray-100">
              {children}
            </h5>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-1">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-1">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-gray-900 dark:text-gray-100">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children, className }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return (
                <code className="block font-mono text-xs">{children}</code>
              );
            }
            return (
              <code className="font-mono text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-700">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 last:mb-0 p-2 rounded bg-gray-100 dark:bg-gray-900 overflow-x-auto text-xs">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-gray-300 dark:border-gray-600 pl-3 my-2 text-gray-600 dark:text-gray-400">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => onGuideLinkClick(e, href)}
              className="text-blue-600 dark:text-blue-400 underline hover:no-underline"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-3 border-gray-200 dark:border-gray-700" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
