'use client';

import { type MouseEvent, type ReactNode } from 'react';
import { docsUrl, type DocsLink } from '@/lib/docs-links';
import { onHelpLinkClick, useHelpPrefetch } from '@/lib/help-open';

interface HelpLinkProps {
  /** Where the guide explains this, a key of `DOCS_LINKS` (`@/lib/docs-links`). */
  link: DocsLink;
  children: ReactNode;
  className?: string;
  /** Run before the click decides whether to open the panel, e.g. to close a popover it sits in. */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * The one inline "Learn more" link, for an error banner, a wizard step or a
 * setting's description -- anywhere that is neither `InfoTooltip`'s
 * `learnMore` nor `EmptyState`'s `help`. A plain click opens the panel at
 * `link`; a modified click (new tab, copy link, middle button) follows the
 * anchor to the same page on monize.net, same as `PageHeader`'s help icon
 * (`lib/help-open.ts`).
 */
export function HelpLink({ link, children, className, onClick }: HelpLinkProps) {
  useHelpPrefetch();

  return (
    <a
      href={docsUrl(link)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        // A click that activates this link is not a toggle of whatever
        // control it sits inside (`InfoTooltip`'s pin, a clickable row).
        event.stopPropagation();
        onClick?.(event);
        onHelpLinkClick(event, link);
      }}
      className={className}
    >
      {children}
    </a>
  );
}
