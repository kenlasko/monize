'use client';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { splitMoneyFigure } from '@/lib/money-parts';
import { cn } from '@/lib/utils';

interface MoneyFigureProps {
  amount: number;
  currencyCode?: string;
  /**
   * A headline figure (a hero balance, a statement total). The Folio and
   * Pebble UI styles set it with a small raised symbol and small cents; the
   * Standard style renders it exactly as a plain formatted string.
   */
  display?: boolean;
  className?: string;
}

/**
 * A money amount whose pieces a UI style can typeset: `ui-money-sign`,
 * `ui-money-prefix` (the symbol), `ui-money-whole`, `ui-money-fraction`,
 * `ui-money-suffix` (`ui-styles.css`). The text is `formatCurrency`'s own, so
 * a screen reader and a copy-paste read the ordinary figure.
 */
export function MoneyFigure({ amount, currencyCode, display = false, className }: MoneyFigureProps) {
  const { formatCurrency, numberSeparators } = useNumberFormat();
  const formatted = formatCurrency(amount, currencyCode);
  // A test's useNumberFormat mock may omit the separators; '.' is the
  // fallback, and a miss only leaves the cents unsplit, never misread.
  const parts = splitMoneyFigure(formatted, numberSeparators?.decimal ?? '.');
  return (
    <span className={cn('ui-money', display && 'ui-money-display', className)}>
      {parts.sign && <span className="ui-money-sign">{parts.sign}</span>}
      {parts.prefix && <span className="ui-money-prefix">{parts.prefix}</span>}
      <span className="ui-money-whole">{parts.whole}</span>
      {parts.fraction && <span className="ui-money-fraction">{parts.fraction}</span>}
      {parts.suffix && <span className="ui-money-suffix">{parts.suffix}</span>}
    </span>
  );
}
