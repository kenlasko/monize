'use client';

import { useTranslations } from 'next-intl';
import { RECEIPT_PARSER_LIMITS, type ReceiptParserValidationError } from '@/types/email-receipts';

const PATTERN_FIELDS = ['orderId', 'total', 'shipping', 'discount'] as const;
type PatternField = (typeof PATTERN_FIELDS)[number];

const isPatternField = (name: string): name is PatternField => (PATTERN_FIELDS as readonly string[]).includes(name);

type Translator = ReturnType<typeof useTranslations>;

/**
 * Where a problem is, in the words of the form rather than the JSON: the
 * server reports `items.patterns[1]`, the person sees "Item patterns, line 2".
 * A path this client does not know is shown as it is, never dropped.
 */
export function describeProblemPath(path: string, t: Translator): string {
  if (path === '' || path === 'version') return t('paths.definition');

  const pattern = /^(\w+)\[(\d+)\]$/.exec(path);
  if (pattern && isPatternField(pattern[1])) {
    return t('paths.line', { field: t(`fields.${pattern[1]}`), line: Number(pattern[2]) + 1 });
  }
  if (isPatternField(path)) return t(`fields.${path}`);

  const item = /^items\.patterns\[(\d+)\]$/.exec(path);
  if (item) return t('paths.line', { field: t('fields.itemPatterns'), line: Number(item[1]) + 1 });
  if (path === 'items.patterns') return t('fields.itemPatterns');
  if (path === 'items.startAfter') return t('fields.startAfter');
  if (path === 'items.stopAt') return t('fields.stopAt');
  if (path === 'items') return t('fields.items');

  const rule = /^categoryRules\[(\d+)\]\.(match|categoryId)$/.exec(path);
  if (rule) {
    return t('paths.rule', { rule: Number(rule[1]) + 1, part: t(rule[2] === 'match' ? 'fields.rulePattern' : 'fields.ruleCategory') });
  }
  if (path === 'categoryRules') return t('fields.categoryRules');
  if (path === 'defaultCategoryId') return t('fields.defaultCategory');
  if (path === 'shippingCategoryId') return t('fields.shippingCategory');
  return path;
}

/** The bound a `too_many` or `too_long` code refers to at this path. */
function boundFor(code: string, path: string): number {
  if (code === 'too_many') {
    return path.startsWith('categoryRules')
      ? RECEIPT_PARSER_LIMITS.maxCategoryRules
      : RECEIPT_PARSER_LIMITS.maxPatternsPerField;
  }
  return path.endsWith('startAfter') || path.endsWith('stopAt')
    ? RECEIPT_PARSER_LIMITS.maxSectionMarkerLength
    : RECEIPT_PARSER_LIMITS.maxPatternLength;
}

const KNOWN_CODES = new Set([
  'not_object',
  'unknown_key',
  'invalid_version',
  'invalid_type',
  'empty',
  'too_many',
  'too_long',
  'control_character',
  'malformed_capture',
  'too_many_captures',
  'duplicate_capture',
  'capture_not_allowed',
  'capture_missing',
  'capture_conflict',
  'invalid_uuid',
]);

interface ParserProblemsProps {
  /** The problems the server's validator listed. */
  problems: readonly ReceiptParserValidationError[];
}

/**
 * The validator's `path: code` problems as a list a person can act on, each
 * with where it is and what is wrong. The codes come from the server's closed
 * list; one this client has not heard of falls back to the raw code rather than
 * hiding that something was refused.
 */
export function ParserProblems({ problems }: ParserProblemsProps) {
  const t = useTranslations('emailReceipts.problems');

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-900/20">
      <p className="text-sm font-semibold text-red-800 dark:text-red-200">{t('heading')}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-300">
        {problems.map((problem, index) => (
          <li key={`${problem.path}-${problem.code}-${index}`}>
            {t('item', {
              where: describeProblemPath(problem.path, t),
              problem: KNOWN_CODES.has(problem.code)
                ? t(`codes.${problem.code}`, {
                    max: boundFor(problem.code, problem.path),
                    capture: '{name}',
                  })
                : problem.code,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
