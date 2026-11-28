/**
 * What a budget line's server flags say about each of its figures. The spent
 * figure follows `valuationComplete` alone; the budgeted figure follows
 * `budgetedComplete` (an income-linked percentage line over income with no
 * exchange rate); what is left and the percent need both. Read as
 * `=== false`: an absent flag is no information, not "unknown".
 */
interface LineFlags {
  valuationComplete?: boolean;
  budgetedComplete?: boolean;
  missingRatePairs?: readonly string[];
  budgetedMissingRatePairs?: readonly string[];
}

export const spentUnknown = (line: LineFlags) => line.valuationComplete === false;
export const budgetedUnknown = (line: LineFlags) => line.budgetedComplete === false;
/** `remaining` and `percentUsed` compare spent with the budget: both must be known. */
export const figuresUnknown = (line: LineFlags) => spentUnknown(line) || budgetedUnknown(line);

/** The pairs behind the line's own spent figure. */
export const spentPairs = (line: LineFlags): string[] => [...(line.missingRatePairs ?? [])];
/** The income's pairs behind the line's budget. */
export const budgetedPairs = (line: LineFlags): string[] => [...(line.budgetedMissingRatePairs ?? [])];
/** Every pair behind a withheld figure of the line, spent and budgeted. */
export const unknownPairs = (line: LineFlags): string[] =>
  [...new Set([...spentPairs(line), ...budgetedPairs(line)])].sort();
