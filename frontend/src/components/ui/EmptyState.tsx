'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { HelpLink } from '@/components/help/HelpLink';
import { Guilloche } from '@/components/ui/Guilloche';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import type { DocsLink } from '@/lib/docs-links';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Grey glyph above the title; sized h-12 w-12 by the component. */
  icon?: ReactNode;
  /** Already-translated one-line answer to "why is this list empty?". */
  title: string;
  /** Optional second line (what to do about it). */
  description?: ReactNode;
  /** Optional call to action (a Button, a link). */
  action?: ReactNode;
  /**
   * Where the guide explains this empty screen, a key of `DOCS_LINKS`. Renders
   * a quiet "How this works" link under the description; `action` renders too
   * when both are given.
   */
  help?: DocsLink;
  className?: string;
}

interface EmptyStateViewProps extends EmptyStateProps {
  /** The "How this works" label, translated once by the owner. */
  helpLabel: string;
}

function HelpLine({ help, label }: { help: DocsLink; label: string }) {
  return (
    <div className="ui-empty-help mt-2">
      <HelpLink link={help} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        {label}
      </HelpLink>
    </div>
  );
}

/** Centered grey glyph, one-line title, description and action. */
function EmptyStateStandard({ icon, title, description, action, help, helpLabel, className }: EmptyStateViewProps) {
  return (
    <div className={cn('ui-empty text-center py-12', className)}>
      {icon && (
        <div
          aria-hidden
          className="ui-empty-icon mx-auto h-12 w-12 text-gray-400 dark:text-gray-500 [&>svg]:h-12 [&>svg]:w-12"
        >
          {icon}
        </div>
      )}
      <h3
        className={cn(
          'ui-empty-title text-sm font-medium text-gray-900 dark:text-gray-100',
          icon && 'mt-2',
        )}
      >
        {title}
      </h3>
      {description && (
        <div className="ui-empty-desc mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</div>
      )}
      {help && <HelpLine help={help} label={helpLabel} />}
      {action && <div className="ui-empty-action mt-4">{action}</div>}
    </div>
  );
}

/**
 * The Classic empty page (`Vocabulary.dc.html`): a serif line set flush left
 * on the ruled page, the description under it, and the engraved rosette in the
 * corner in place of the glyph. The ornament is decoration, hidden from
 * assistive technology, and clipped in a box of its own so a popover in the
 * action is not.
 */
function EmptyStateClassic({ title, description, action, help, helpLabel, className }: EmptyStateViewProps) {
  return (
    <div className={cn('ui-empty ui-empty-classic relative py-10 text-left', className)}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <Guilloche className="ui-empty-ornament absolute -bottom-20 -right-10 h-64 w-64 text-blue-600/30 dark:text-blue-400/35" />
      </div>
      <h3 className="ui-empty-title relative max-w-md text-2xl text-gray-900 dark:text-gray-100">{title}</h3>
      {description && (
        <div className="ui-empty-desc relative mt-2 max-w-sm text-sm text-gray-500 dark:text-gray-400">
          {description}
        </div>
      )}
      {help && (
        <div className="relative">
          <HelpLine help={help} label={helpLabel} />
        </div>
      )}
      {action && <div className="ui-empty-action relative mt-5">{action}</div>}
    </div>
  );
}

const VARIANTS: StyleVariants<EmptyStateViewProps> = {
  standard: EmptyStateStandard,
  classic: EmptyStateClassic,
};

/**
 * The one empty-state layout for a list or panel with nothing to show:
 * centered grey glyph, one-line title, optional description and action.
 * This was the same `text-center py-12` block hand-rolled in fourteen
 * files, each drifting on its own; `ui-conventions.test.ts` keeps the
 * inline copies shrink-only.
 *
 * Classic sets it as an empty ledger page (its own variant, above); Modern
 * re-skins the Standard markup through the `ui-empty*` markers
 * (`ui-styles-kit.css`).
 */
export function EmptyState(props: EmptyStateProps) {
  const t = useTranslations('help');
  return renderForStyle(useUiStyle(), VARIANTS, { ...props, helpLabel: t('howThisWorks') });
}
