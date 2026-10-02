'use client';

import Link from 'next/link';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import type { ImportPreviewPayee } from '@/types/import-preview';

export const IMPORT_PREVIEW_HEADING_CLASS =
  'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
export const IMPORT_PREVIEW_LINK_CLASS =
  'inline-flex items-center gap-1 font-medium text-blue-600 hover:underline focus-visible:underline dark:text-blue-400';

/**
 * An in-app link inside the import preview opens in a NEW tab. The preview sits
 * in a `Modal` with `pushHistory`, which pops its own history entry when it
 * unmounts; following the link in this tab would run that pop after the
 * navigation and land the reader back on the page behind the modal, and would
 * discard a preview that costs a bank request to rebuild. `noopener` is the
 * security control: it denies the opened page a handle on this one.
 */
export const IMPORT_PREVIEW_LINK_PROPS = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;

/** The glyph that says the link leaves this tab; the accessible name says it in words. */
export function ImportPreviewNewTabIcon() {
  return <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
}

/** How the payee was found, as one sentence. */
function usePayeeSentence() {
  const t = useTranslations('import.preview.payee');
  return (payee: ImportPreviewPayee): string => {
    const name = payee.name ?? '';
    switch (payee.via) {
      case 'name':
        return t('name', { name });
      case 'alias':
        return payee.aliasPattern === null
          ? t('aliasNoPattern', { name })
          : t('alias', { name, pattern: payee.aliasPattern });
      case 'new':
        return t('new', { name });
      case 'rule':
        return payee.name === null ? t('ruleNone') : t('rule', { name });
      default:
        return t('none');
    }
  };
}

/**
 * The expanded part of an import preview row that explains its payee: the
 * source's text, how it became the payee, and a way to the payee's aliases when
 * the payee exists.
 */
export function ImportPreviewPayeeMapping({ payee }: { payee: ImportPreviewPayee | null }) {
  const t = useTranslations('import.preview.payee');
  const sentence = usePayeeSentence();
  return (
    <section aria-label={t('heading')} className="space-y-1">
      <h4 className={IMPORT_PREVIEW_HEADING_CLASS}>{t('heading')}</h4>
      {payee === null ? (
        <p className="text-gray-600 dark:text-gray-300">{t('unknown')}</p>
      ) : (
        <>
          {payee.original !== null && (
            <p className="text-gray-600 dark:text-gray-300">{t('original', { original: payee.original })}</p>
          )}
          <p>{sentence(payee)}</p>
          {payee.payeeId !== null && (
            <Link
              href={`/payees/${payee.payeeId}?tab=aliases`}
              {...IMPORT_PREVIEW_LINK_PROPS}
              aria-label={t('openAliasesNewTab')}
              className={IMPORT_PREVIEW_LINK_CLASS}
            >
              {t('openAliases')}
              <ImportPreviewNewTabIcon />
            </Link>
          )}
        </>
      )}
    </section>
  );
}
