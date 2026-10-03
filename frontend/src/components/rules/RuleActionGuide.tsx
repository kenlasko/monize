'use client';

import { useTranslations } from 'next-intl';
import { captureAmount, type EditorAction } from '@/lib/rule-actions';

const TEXT_CLASS = 'text-xs text-gray-500 dark:text-gray-400';
const HEADING_CLASS = 'text-xs font-medium text-gray-700 dark:text-gray-300';

/**
 * The usage guide under the action type: how a split is set up (patterns,
 * captures, parts) with a worked loan example, or the short note of a
 * conversion to a transfer. Other action types have none. The example's capture
 * names are catalog values passed as ICU arguments, so each locale's braces
 * render literally and its parts keep the pattern's own names.
 */
export function RuleActionGuide({ type }: { type: EditorAction['type'] }) {
  const t = useTranslations('rules.editor.action');

  if (type === 'convert_to_transfer') {
    return (
      <div className="space-y-1" data-testid="rule-action-guide">
        <p className={HEADING_CLASS}>{t('guideTitle')}</p>
        <p className={TEXT_CLASS}>{t('convertGuide')}</p>
      </div>
    );
  }
  if (type !== 'split') return null;
  const names = { first: captureAmount(t('splitGuideName1')), second: captureAmount(t('splitGuideName2')) };

  return (
    <div className="space-y-2" data-testid="rule-action-guide">
      <p className={HEADING_CLASS}>{t('guideTitle')}</p>
      <p className={TEXT_CLASS}>{t('splitGuideHow', names)}</p>
      <p className={HEADING_CLASS}>{t('splitGuideExampleTitle')}</p>
      <ul className={`list-disc space-y-1 pl-4 ${TEXT_CLASS}`}>
        <li>{t('splitGuideBank')}</li>
        <li>{t('splitGuidePattern', names)}</li>
        <li>{t('splitGuidePart1', names)}</li>
        <li>{t('splitGuidePart2', names)}</li>
        <li>{t('splitGuideResult')}</li>
      </ul>
      <p className={TEXT_CLASS}>{t('splitGuideTip')}</p>
    </div>
  );
}
