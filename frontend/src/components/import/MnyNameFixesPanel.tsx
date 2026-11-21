'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { Th } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { MnyNameFixes, MnyRename } from '@/lib/import-mny';

interface MnyNameFixesPanelProps {
  nameFixes: MnyNameFixes | undefined;
  /** The names the import will use, from `options.renames`. */
  renames: readonly MnyRename[] | undefined;
  onSetRename: (rename: MnyRename) => void;
}

/** The name the import uses for one entry: the user's, else the server's shortened one. */
export function renameFor(
  renames: readonly MnyRename[] | undefined,
  kind: MnyRename['kind'],
  handle: number,
): string | undefined {
  return renames?.find((entry) => entry.kind === kind && entry.handle === handle)
    ?.name;
}

/** True while some listed name has been cleared: the import cannot use a blank name. */
export function hasBlankRename(
  nameFixes: MnyNameFixes | undefined,
  renames: readonly MnyRename[] | undefined,
): boolean {
  return (nameFixes?.entries ?? []).some(
    (fix) => (renameFor(renames, fix.kind, fix.handle) ?? '').trim() === '',
  );
}

/**
 * The file's names that are longer than Monize can store (issue #2313): a
 * KMyMoney payee created from a SEPA direct debit carries the whole remittance
 * text. Each starts as the server's shortened name, and the input stops at the
 * element's own bound, so the import never refuses one.
 */
export function MnyNameFixesPanel({
  nameFixes,
  renames,
  onSetRename,
}: MnyNameFixesPanelProps) {
  const t = useTranslations('import');
  const { formatNumber } = useNumberFormat();

  if (!nameFixes || (nameFixes.entries.length === 0 && nameFixes.omitted === 0)) {
    return null;
  }

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-foreground mb-1">
        {t('kmyReview.nameFixes.heading', {
          count: nameFixes.entries.length + nameFixes.omitted,
        })}
      </h3>
      <p className="text-xs text-muted-foreground mb-2">
        {t('kmyReview.nameFixes.explainer')}
      </p>

      {nameFixes.entries.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-auto max-h-[32rem]">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <Th className="px-3 py-2">{t('kmyReview.nameFixes.table.kind')}</Th>
                <Th className="px-3 py-2">
                  {t('kmyReview.nameFixes.table.original')}
                </Th>
                <Th className="px-3 py-2">
                  {t('kmyReview.nameFixes.table.newName')}
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {nameFixes.entries.map((fix) => {
                const value = renameFor(renames, fix.kind, fix.handle) ?? '';
                const blank = value.trim() === '';
                const kindLabel = t(`kmyReview.nameFixes.kind.${fix.kind}`);
                return (
                  <tr key={`${fix.kind}:${fix.handle}`}>
                    <td className="px-3 py-2 align-top text-muted-foreground whitespace-nowrap">
                      {kindLabel}
                    </td>
                    <td className="px-3 py-2 align-top text-foreground break-words max-w-md">
                      {fix.original}
                      {fix.originalLength > fix.original.length && '…'}
                      <span className="block text-xs text-muted-foreground">
                        {t('kmyReview.nameFixes.originalLength', {
                          length: formatNumber(fix.originalLength, 0),
                        })}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top min-w-[16rem]">
                      <Input
                        id={`name-fix-${fix.kind}-${fix.handle}`}
                        value={value}
                        maxLength={fix.maxLength}
                        onChange={(e) =>
                          onSetRename({
                            kind: fix.kind,
                            handle: fix.handle,
                            name: e.target.value,
                          })
                        }
                        aria-label={t('kmyReview.nameFixes.table.newNameFor', {
                          kind: kindLabel,
                        })}
                        error={blank ? t('kmyReview.nameFixes.blank') : undefined}
                      />
                      <span className="block mt-1 text-xs text-muted-foreground">
                        {t('kmyReview.nameFixes.remaining', {
                          used: formatNumber(value.length, 0),
                          max: formatNumber(fix.maxLength, 0),
                        })}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nameFixes.omitted > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('kmyReview.nameFixes.omitted', { count: nameFixes.omitted })}
        </p>
      )}
    </div>
  );
}
