/**
 * Split an already-formatted money figure into the pieces a display figure
 * typesets differently: the sign, the currency symbol, the whole units and
 * the fraction. The Folio and Pebble UI styles set a headline balance as
 * "$ 453,227 .01" -- a small raised symbol, large units, small muted cents.
 *
 * It takes the STRING `formatCurrency` produced rather than formatting again,
 * so locale, symbol placement, coin symbols and rounding stay decided in one
 * place (`useNumberFormat`). Concatenating the parts in order always gives
 * back the input exactly.
 */
export interface MoneyParts {
  /** Leading sign or opening parenthesis, if any ("-", "−", "+", "("). */
  sign: string;
  /** Currency symbol and its spacing before the number ("$", "CA$", "€ "). */
  prefix: string;
  /** Whole units with their group separators ("453,227"). */
  whole: string;
  /** Decimal separator and fraction digits (".01", ",01"), or "". */
  fraction: string;
  /** Everything after the digits: a trailing symbol, closing parenthesis (" €"). */
  suffix: string;
}

const SIGN = /^[-−+(]/;

export function splitMoneyFigure(formatted: string, decimalSeparator: string): MoneyParts {
  const firstDigit = formatted.search(/\d/);
  if (firstDigit < 0) {
    return { sign: '', prefix: formatted, whole: '', fraction: '', suffix: '' };
  }
  let lastDigit = formatted.length - 1;
  while (lastDigit >= 0 && !/\d/.test(formatted[lastDigit])) lastDigit -= 1;

  let head = formatted.slice(0, firstDigit);
  const core = formatted.slice(firstDigit, lastDigit + 1);
  const suffix = formatted.slice(lastDigit + 1);

  // Only a LEADING sign is split out. A locale that writes the sign after the
  // symbol ("$-5") keeps it in `prefix`, so the parts still concatenate back
  // to the input in order.
  let sign = '';
  const leadingSign = head.match(SIGN);
  if (leadingSign) {
    sign = leadingSign[0];
    head = head.slice(sign.length);
  }

  const at = decimalSeparator ? core.lastIndexOf(decimalSeparator) : -1;
  const isFraction = at > 0 && /^\d+$/.test(core.slice(at + decimalSeparator.length));
  return {
    sign,
    prefix: head,
    whole: isFraction ? core.slice(0, at) : core,
    fraction: isFraction ? core.slice(at) : '',
    suffix,
  };
}
