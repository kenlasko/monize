import type { RecurringCharge } from "../../transactions/recurring-charges.util";

/**
 * One occurrence of a detected recurring charge as an AI prompt states it,
 * beside figures in `promptCurrency` (issue #2155).
 *
 * A charge in the prompt's currency is its amount. A foreign one is its
 * converted amount with the native one named beside it, so the model neither
 * reads 15.99 USD as 15.99 of the prompt's currency nor loses what was billed.
 * A foreign occurrence with no rate is said to be unknown and names the pair;
 * the native amount is never passed off as the converted one.
 */
export function recurringChargeAmountForPrompt(
  charge: RecurringCharge,
  which: "current" | "previous",
  promptCurrency: string,
): string {
  const native =
    which === "current" ? charge.currentAmount : charge.previousAmount;
  if (charge.currencyCode === promptCurrency) return native.toFixed(2);
  const billed = `${native.toFixed(2)} ${charge.currencyCode}`;
  const converted =
    charge.converted?.currency === promptCurrency
      ? which === "current"
        ? charge.converted.currentAmount
        : charge.converted.previousAmount
      : null;
  return converted === null
    ? `unknown (no ${charge.currencyCode}->${promptCurrency} exchange rate; billed ${billed})`
    : `${converted.toFixed(2)} (billed ${billed})`;
}
