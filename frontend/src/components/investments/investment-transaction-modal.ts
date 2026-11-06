/**
 * The width and padding of every modal that hosts `InvestmentTransactionForm`,
 * spread onto `Modal`: a quarter wider than the `xl` / `3xl` its `maxWidth`
 * names, so Quantity, Price per Share and Commission / Fees fit on one line,
 * and wider again while the form asks for a currency conversion (the host
 * learns that from the form's `onConversionStateChange`). Literal class
 * strings, so Tailwind sees them; a module of its own, so a host's test that
 * mocks the form still gets the real width.
 */
export function investmentTransactionModalProps(needsConversion: boolean) {
  return needsConversion
    ? ({ maxWidth: '3xl', className: 'p-6 !max-w-[60rem]' } as const)
    : ({ maxWidth: 'xl', className: 'p-6 !max-w-[45rem]' } as const);
}
