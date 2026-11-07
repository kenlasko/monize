'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'next-intl';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useTheme } from '@/contexts/ThemeContext';
import { DOCS_BASE_URL, type HelpTarget } from '@/lib/docs-links';
import {
  helpImageUrl,
  type HelpImage,
  type HelpImageVariant,
  type HelpTocEntry,
} from '@/lib/help';
import { remarkHelp } from '@/lib/markdown/remark-help';

interface HelpMarkdownProps {
  /** The page's Markdown, as the website reads it. */
  markdown: string;
  /** The page's table of contents; its ids are the ones the headings carry. */
  toc: readonly HelpTocEntry[];
  /** The page being shown: what a link to `#section` on its own page means. */
  slug: string;
  /** The page on monize.net, which a screenshot's "view online" link points into. */
  onlineUrl: string;
  /**
   * The page's pictures the bundle holds, by the `<name>` of `images/<name>.png`.
   * Absent from a backend older than the frontend, when every picture shows
   * as its caption.
   */
  images?: Readonly<Record<string, HelpImage>>;
  /** A link to another page of the guide, followed inside the panel. */
  onNavigate: (target: HelpTarget) => void;
}

const INTERNAL_LINK = /^([a-z0-9-]+)\.md(?:#([^\s]*))?$/;

/** A screenshot as the guide names it, the dark picture's file. */
const IMAGE_SRC = /^images\/([a-z0-9-]+)\.png$/;

const CALLOUT_VARIANTS: Record<string, BadgeVariant> = {
  note: 'blue',
  tip: 'green',
  important: 'purple',
  warning: 'amber',
  caution: 'red',
};

const LINK_CLASS =
  'text-blue-600 dark:text-blue-400 underline hover:no-underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm';

const HEADING_CLASS =
  'scroll-mt-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/** A heading that can take focus, so following a link to a section can land on it. */
function Heading({
  as: Tag,
  className,
  id,
  children,
}: {
  as: 'h2' | 'h3' | 'h4';
  className: string;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <Tag id={id} tabIndex={-1} className={`${HEADING_CLASS} ${className}`}>
      {children}
    </Tag>
  );
}

const H2_CLASS =
  'mt-6 mb-2 border-t border-gray-200 pt-4 text-lg font-semibold text-gray-900 first:mt-0 first:border-t-0 first:pt-0 dark:border-gray-700 dark:text-gray-100';
const H3_CLASS = 'mt-4 mb-1 text-base font-semibold text-gray-900 dark:text-gray-100';
const H4_CLASS = 'mt-3 mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100';

/** One of the guide's pictures, its caption and its online link. */
function HelpScreenshot({
  variant,
  alt,
  caption,
  online,
  onError,
}: {
  variant: HelpImageVariant;
  alt: string;
  /** The Markdown's alt text, shown under the picture; none when it has none. */
  caption?: string;
  online: ReactNode;
  onError: () => void;
}) {
  return (
    <span className="my-3 block">
      {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin API picture with its own size; next/image would re-encode it */}
      <img
        src={helpImageUrl(variant)}
        alt={alt}
        width={variant.width}
        height={variant.height}
        loading="lazy"
        decoding="async"
        onError={onError}
        className="block h-auto max-w-full rounded-md border border-gray-200 dark:border-gray-700"
      />
      {/* The alt text already names the picture to a screen reader. */}
      {caption && (
        <span aria-hidden="true" className="mt-1 block text-xs text-gray-600 dark:text-gray-400">
          {caption}
        </span>
      )}
      {online}
    </span>
  );
}

/** A click the browser should handle itself: a new tab, a window, a download. */
function isModifiedClick(e: MouseEvent): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** The page on monize.net, with the section when there is one. */
export function onlineHref(target: HelpTarget): string {
  const path = target.page === 'index' ? '' : target.page;
  return `${DOCS_BASE_URL}/${path}${target.section ? `#${target.section}` : ''}`;
}

/**
 * Renders a page of the user guide inside the help panel: the third Markdown
 * renderer in the app, after the assistant's and the release notes'. What the
 * Markdown means comes from the website's renderer (`remark-help.ts` lists the
 * rules); this file maps it onto the app's own components. A screenshot is the
 * picture the backend bundles, in the app's theme (the light twin when there is
 * one, as on the website), with its caption and a link to it on monize.net; one
 * the bundle lacks is the caption and the link alone. No raw HTML is rendered.
 */
export function HelpMarkdown({
  markdown,
  toc,
  slug,
  onlineUrl,
  images = {},
  onNavigate,
}: HelpMarkdownProps) {
  const t = useTranslations('help.markdown');
  const { resolvedTheme } = useTheme();
  // Pictures whose request failed (a throttled or refused request, a replica
  // without it) show as their caption, never a broken image. Held here rather
  // than in each picture: ReactMarkdown's `components` are new on every render,
  // which remounts a picture and would forget it. A theme change asks for the
  // other picture, which has not failed.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  return (
    <div className="text-sm text-gray-700 dark:text-gray-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkHelp({ toc })]}
        components={{
          h2: ({ id, children }) => (
            <Heading as="h2" id={id} className={H2_CLASS}>
              {children}
            </Heading>
          ),
          h3: ({ id, children }) => (
            <Heading as="h3" id={id} className={H3_CLASS}>
              {children}
            </Heading>
          ),
          h4: ({ id, children }) => (
            <Heading as="h4" id={id} className={H4_CLASS}>
              {children}
            </Heading>
          ),
          p: ({ children }) => (
            <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-gray-900 dark:text-gray-100">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children, className }) =>
            /language-/.test(className ?? '') ? (
              <code className="block font-mono text-xs">{children}</code>
            ) : (
              <code className="rounded bg-gray-200 px-1 py-0.5 font-mono text-xs dark:bg-gray-700">
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="mb-3 overflow-x-auto rounded bg-gray-100 p-2 text-xs last:mb-0 dark:bg-gray-900">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-gray-300 pl-3 text-gray-600 dark:border-gray-600 dark:text-gray-400">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-gray-200 dark:border-gray-700" />,
          aside: (props) => {
            const kind = (props as Record<string, unknown>)['data-callout'];
            const key = typeof kind === 'string' ? kind : 'note';
            return (
              <aside
                data-callout={key}
                className="my-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"
              >
                <Badge variant={CALLOUT_VARIANTS[key] ?? 'gray'} className="mb-1">
                  {t(`callout.${key in CALLOUT_VARIANTS ? key : 'note'}`)}
                </Badge>
                <div>{props.children}</div>
              </aside>
            );
          },
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className={TABLE_CLASS}>{children}</table>
            </div>
          ),
          tbody: ({ children }) => <tbody className={TABLE_BODY_CLASS}>{children}</tbody>,
          th: ({ children }) => <Th className="px-3 py-2 align-top">{children}</Th>,
          td: ({ children }) => <Td className="px-3 py-2 align-top">{children}</Td>,
          img: (props) => {
            const section = (props as Record<string, unknown>)['data-section'];
            const href = onlineUrl + (typeof section === 'string' && section ? `#${section}` : '');
            const name = typeof props.src === 'string' ? IMAGE_SRC.exec(props.src)?.[1] : undefined;
            const image =
              name !== undefined && Object.hasOwn(images, name) ? images[name] : undefined;
            const variant =
              image && (resolvedTheme === 'light' && image.light ? image.light : image.dark);
            const online = (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={`mt-1 inline-flex items-center gap-1 ${LINK_CLASS}`}
              >
                {t('viewScreenshot')}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            );
            const fallback = (
              <span className="my-2 block rounded-md border border-dashed border-gray-300 p-3 dark:border-gray-600">
                <span className="block text-gray-600 dark:text-gray-400">
                  {props.alt || t('screenshot')}
                </span>
                {online}
              </span>
            );
            if (!variant || failed.has(variant.name)) return fallback;
            return (
              <HelpScreenshot
                variant={variant}
                alt={props.alt || t('screenshot')}
                caption={props.alt || undefined}
                online={online}
                onError={() => setFailed((prev) => new Set([...prev, variant.name]))}
              />
            );
          },
          a: ({ href, children }) => {
            if (!href) return <>{children}</>;
            const internal = href.match(INTERNAL_LINK);
            const sameEntry = href.startsWith('#') && href.length > 1;
            if (internal || sameEntry) {
              const target: HelpTarget = internal
                ? {
                    page: internal[1],
                    ...(internal[2] ? { section: internal[2] } : {}),
                  }
                : { page: slug, section: href.slice(1) };
              return (
                <a
                  href={onlineHref(target)}
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    e.preventDefault();
                    onNavigate(target);
                  }}
                  className={LINK_CLASS}
                >
                  {children}
                </a>
              );
            }
            if (/^(https?:\/\/|mailto:)/.test(href)) {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK_CLASS}
                >
                  {children}
                </a>
              );
            }
            return <>{children}</>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
