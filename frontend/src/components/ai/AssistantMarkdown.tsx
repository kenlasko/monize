'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AssistantTable } from './AssistantTable';

interface AssistantMarkdownProps {
  content: string;
}

export function AssistantMarkdown({ content }: AssistantMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
        ),
        h1: ({ children }) => (
          <h1 className="text-base font-semibold mt-3 mb-2 first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-sm font-semibold mt-3 mb-2 first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">
            {children}
          </h3>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-0.5">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-0.5">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ children, className }) => {
          const isBlock = /language-/.test(className ?? '');
          if (isBlock) {
            return (
              <code className="block font-mono text-[12px]">{children}</code>
            );
          }
          return (
            <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-800/70">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="mb-2 last:mb-0 p-2 rounded bg-gray-200 dark:bg-gray-800/70 overflow-x-auto text-[12px]">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-gray-300 dark:border-gray-600 pl-3 my-2 text-gray-700 dark:text-gray-300">
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline hover:no-underline"
          >
            {children}
          </a>
        ),
        table: ({ children }) => <AssistantTable>{children}</AssistantTable>,
        th: ({ children }) => (
          <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 font-semibold bg-gray-200/60 dark:bg-gray-800/60 text-left">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-gray-300 dark:border-gray-600 px-2 py-1">
            {children}
          </td>
        ),
        hr: () => (
          <hr className="my-3 border-gray-300 dark:border-gray-600" />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
