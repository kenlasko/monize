/**
 * The width and padding of every modal that hosts the cash `TransactionForm`,
 * spread onto `Modal` so the Transactions page, the payee and category detail
 * tabs, reconcile, warranties and the rest open the same dialog. The form lays
 * out its fields at this width, so a host that picks its own ends up wrapping
 * them. Literal class strings, so Tailwind sees them; a module of its own, so a
 * host's test that mocks the form still gets the real width.
 */
export const transactionModalProps = {
  maxWidth: '6xl',
  className: 'p-6 !max-w-[69rem]',
} as const;
