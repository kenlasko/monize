/**
 * The classes of every modal that hosts `InvestmentTransactionForm`: a quarter
 * wider than the `xl` / `3xl` its `maxWidth` names, so Quantity, Price per
 * Share and Commission / Fees fit on one line. Literal class strings, so
 * Tailwind sees them; a module of its own, so a host's test that mocks the
 * form still gets the real width.
 */
export function investmentTransactionModalClass(needsConversion: boolean): string {
  return needsConversion ? 'p-6 !max-w-[60rem]' : 'p-6 !max-w-[45rem]';
}
