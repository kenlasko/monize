'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { investmentsApi } from '@/lib/investments';
import type { BondProgramSummary } from '@/types/bond';

interface BondUnitHintProps {
  /** The security's linked bond program; nothing is shown (or asked) without one. */
  programId: string | null | undefined;
  /** False where only the price is entered (the manual price form): the unit sentence is left out. Default true. */
  showUnit?: boolean;
}

/**
 * Says what one unit of a program-linked security is: its quantity counts bonds
 * of the program's face value (a broker's "10,000.00 face" of a 100 USD unit is
 * 100 units). The face value is the program's own, read from the catalog, so no
 * country's unit is known here. Shown only when the catalog states one. For a
 * program whose securities trade (`cashPriced`) it also says what a price is:
 * the cash price of one unit, without accrued interest, and for an indexed
 * principal (`indexedPrincipal`) including the inflation adjustment, the quoted
 * price times the index ratio (`docs/specs/bond-marketable-primitives.md`
 * section 3).
 */
export function BondUnitHint({ programId, showUnit = true }: BondUnitHintProps) {
  const t = useTranslations('investments');
  const [program, setProgram] = useState<BondProgramSummary | null>(null);

  useEffect(() => {
    if (!programId) return;
    let cancelled = false;
    investmentsApi
      .listBondPrograms()
      .then((programs) => {
        if (!cancelled) setProgram(programs.find((p) => p.id === programId) ?? null);
      })
      .catch(() => {
        // The hint is a convenience: without the catalog the form just has none.
        if (!cancelled) setProgram(null);
      });
    return () => {
      cancelled = true;
    };
  }, [programId]);

  if (!programId || !program || program.id !== programId || !program.faceValue) return null;
  if (!showUnit && program.cashPriced !== true) return null;
  const args = { faceValue: program.faceValue, currency: program.currency };
  const priceKey = program.indexedPrincipal
    ? 'transactionForm.bondPriceIndexed'
    : 'transactionForm.bondPriceCash';
  return (
    <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="bond-unit-hint">
      {showUnit && t('transactionForm.bondUnit', args)}
      {showUnit && program.cashPriced === true && ' '}
      {program.cashPriced === true && t(priceKey, args)}
    </p>
  );
}
