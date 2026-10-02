import type { ReactNode } from 'react';

/**
 * An outbound link in the bank sync setup help. `target` and `rel` live here
 * once so the control panel link and the template links cannot drift apart.
 * `noopener` is the security control: without it the opened page gets a handle
 * on this one through `window.opener`.
 */
export function BankSyncExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
    >
      {children}
    </a>
  );
}
