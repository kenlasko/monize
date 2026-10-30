/**
 * Every place the app links into the user documentation at monize.net/docs.
 *
 * The documentation is `website/docs/<page>.md` in this repository, and a
 * section's anchor is its heading's GitHub-style slug. A help link names a
 * destination here rather than spelling a URL, so `docs-links.test.ts` can
 * check each page and section against the generated site: renaming a heading in
 * the docs without updating its entry fails a test instead of leaving a help
 * link that lands at the top of the wrong page.
 */
export const DOCS_BASE_URL = 'https://www.monize.net/docs';

interface DocsTarget {
  /** File name of the page in `website/docs/`, without `.md`; `''` is the landing page. */
  page: string;
  /** Heading anchor on that page. */
  section?: string;
}

export const DOCS_LINKS = {
  home: { page: '' },
  accounts: { page: 'accounts' },
  institutions: { page: 'accounts', section: 'financial-institutions' },
  aiAssistant: { page: 'ai' },
  aiInsights: { page: 'ai', section: 'financial-insights' },
  adminBackups: { page: 'backup-and-restore', section: 'automatic-backups' },
  bills: { page: 'bills-and-deposits' },
  budgets: { page: 'budgets' },
  categories: { page: 'categories-and-payees', section: 'categories' },
  payees: { page: 'categories-and-payees', section: 'payees' },
  googlePlacesSetup: { page: 'categories-and-payees', section: 'setting-up-google-places' },
  currencies: { page: 'currency-management' },
  dashboard: { page: 'dashboard' },
  emailReceipts: { page: 'email-receipts' },
  importTransactions: { page: 'importing-transactions' },
  importMicrosoftMoney: { page: 'importing-from-microsoft-money' },
  importQuicken: { page: 'importing-from-quicken' },
  investments: { page: 'investments' },
  securities: { page: 'investments', section: 'securities-management' },
  reports: { page: 'reports' },
  settings: { page: 'settings-and-security' },
  notifications: { page: 'settings-and-security', section: 'notifications' },
  adminUsers: { page: 'settings-and-security', section: 'user-management' },
  adminNotifications: { page: 'settings-and-security', section: 'instance-notification-settings' },
  tags: { page: 'tags' },
  transactions: { page: 'transactions' },
  warranties: { page: 'warranties' },
} as const satisfies Record<string, DocsTarget>;

export type DocsLink = keyof typeof DOCS_LINKS;

/** The URL of a documentation destination. */
export function docsUrl(link: DocsLink): string {
  const target: DocsTarget = DOCS_LINKS[link];
  return `${DOCS_BASE_URL}/${target.page}${target.section ? `#${target.section}` : ''}`;
}
