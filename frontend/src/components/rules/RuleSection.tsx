import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { HelpLink } from '@/components/help/HelpLink';
import type { DocsLink } from '@/lib/docs-links';
import type { TourAnchorId } from '@/lib/tours/anchors';

interface RuleSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  /** The `tourAnchor(...)` attribute a guided tour points at. */
  anchor?: { 'data-tour-id': TourAnchorId };
  /** Where the guide explains this panel; renders a "Learn more" link under the description. */
  learnMore?: DocsLink;
}

/** One of the editor's When / If / Then panels. */
export function RuleSection({ title, description, children, anchor, learnMore }: RuleSectionProps) {
  const t = useTranslations('help');
  return (
    <Card as="section" aria-label={title} padding="md" {...anchor}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
      {learnMore && (
        <p className="mb-4 mt-1 text-sm">
          <HelpLink link={learnMore} className="text-blue-600 hover:underline dark:text-blue-400">
            {t('learnMore')}
          </HelpLink>
        </p>
      )}
      {!learnMore && <div className="mb-4" />}
      {children}
    </Card>
  );
}
