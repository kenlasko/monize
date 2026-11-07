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
  aiSettings: { page: 'ai', section: 'setting-up-ai' },
  aiReviewInbox: { page: 'email-receipts', section: 'reviewing-and-approving-proposals' },
  adminBackups: { page: 'backup-and-restore', section: 'automatic-backups' },
  bills: { page: 'bills-and-deposits' },
  billOccurrenceOverride: { page: 'bills-and-deposits', section: 'overriding-individual-occurrences' },
  billSettlementAccount: { page: 'bills-and-deposits', section: 'investment-scheduling' },
  budgets: { page: 'budgets' },
  budgetRollover: { page: 'budgets', section: 'rollover-rules' },
  budgetExcludedAccounts: { page: 'budgets', section: 'excluded-accounts' },
  budgetVelocity: { page: 'budgets', section: 'spending-velocity' },
  categories: { page: 'categories-and-payees', section: 'categories' },
  payees: { page: 'categories-and-payees', section: 'payees' },
  googlePlacesSetup: { page: 'categories-and-payees', section: 'setting-up-google-places' },
  currencies: { page: 'currency-management' },
  currencyHomeRate: { page: 'currency-management', section: 'home-currency' },
  dashboard: { page: 'dashboard' },
  emailReceipts: { page: 'email-receipts' },
  importTransactions: { page: 'importing-transactions' },
  importCsvMapping: { page: 'importing-transactions', section: 'step-2-csv-column-mapping' },
  importAmountSign: { page: 'importing-transactions', section: 'amounts-have-wrong-sign' },
  importOfx: { page: 'importing-transactions', section: 'importing-ofxqfx-files' },
  importQif: { page: 'importing-transactions', section: 'importing-quicken-qif-files' },
  importMicrosoftMoney: { page: 'importing-from-microsoft-money' },
  importMnyTroubleshooting: {
    page: 'importing-from-microsoft-money',
    section: 'troubleshooting-the-mny-import',
  },
  importQuicken: { page: 'importing-from-quicken' },
  investments: { page: 'investments' },
  investmentCostBasis: { page: 'investments', section: 'how-average-cost-works' },
  investmentTradeTotal: { page: 'investments', section: 'total-amount-or-price-which-one-wins' },
  investmentPeriodResult: { page: 'investments', section: 'portfolio-value-over-time' },
  investmentCashVsReturns: { page: 'investments', section: 'cash-vs-investment-performance' },
  securities: { page: 'investments', section: 'securities-management' },
  cryptocurrency: { page: 'investments', section: 'cryptocurrency' },
  cryptoWallets: { page: 'accounts', section: 'cryptocurrency-wallets' },
  cryptoCurrencies: { page: 'currency-management', section: 'cryptocurrencies' },
  reconcile: { page: 'accounts', section: 'account-reconciliation' },
  reports: { page: 'reports' },
  rules: { page: 'rules' },
  rulesConditions: { page: 'rules', section: 'if-conditions' },
  rulesOrderAndStop: { page: 'rules', section: 'order-and-stop-processing' },
  rulesTesting: { page: 'rules', section: 'testing-a-rule' },
  rulesRunOnExisting: { page: 'rules', section: 'running-a-rule-on-existing-transactions' },
  settings: { page: 'settings-and-security' },
  bankSync: { page: 'settings-and-security', section: 'bank-sync' },
  sharedAccess: { page: 'settings-and-security', section: 'shared-access-delegated-users' },
  emergencyAccess: { page: 'settings-and-security', section: 'emergency-access' },
  tourSettings: { page: 'settings-and-security', section: 'guided-tours' },
  backupEncryption: { page: 'backup-and-restore', section: 'encrypted-backups' },
  backupRestore: { page: 'backup-and-restore', section: 'restoring-from-a-backup' },
  twoFactorBackupCodes: { page: 'settings-and-security', section: 'backup-codes' },
  sharedExpenses: { page: 'shared-expenses' },
  taxes: { page: 'taxes' },
  payrollDeductions: { page: 'taxes', section: 'payroll-deductions' },
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

/** A destination inside the bundled guide the backend serves (`GET /help`). */
export interface HelpTarget {
  /** The help page's slug, the argument of `helpApi.getPage`; the landing page is `index`. */
  page: string;
  /** Heading anchor on that page, when the link names one. */
  section?: string;
}

/**
 * Where a documentation key lands in the bundled guide. Consumers navigate the
 * in-app help by key through this, never by parsing `docsUrl`: the landing page
 * (`''` here) is the slug `index` in the help API.
 */
export function helpTarget(link: DocsLink): HelpTarget {
  const target: DocsTarget = DOCS_LINKS[link];
  return target.section === undefined
    ? { page: target.page || 'index' }
    : { page: target.page || 'index', section: target.section };
}

const DOCS_BASE = new URL(DOCS_BASE_URL);

/**
 * Recognise a link into the user documentation at monize.net -- the shape
 * release notes and the assistant's answers already write (`docsUrl(...)`,
 * or a link the model composed in the same shape) -- and resolve it to a
 * target the help panel can open. `ReleaseNotesMarkdown` and
 * `AssistantMarkdown` use this to open such a link in the panel on a plain
 * click. Anything else -- a different site, a lookalike host
 * (`www.monize.net.evil.com`), or a URL that fails to parse -- is `null` and
 * the link is left to the browser. Deliberately not checked against
 * `DOCS_LINKS` or the manifest's page set here: that would need either an
 * ambiguous reverse lookup or a network read inside a synchronous click
 * handler. A slug that does not exist opens the panel into the same load
 * error `useHelpPage` already shows for one, rather than falling through.
 */
export function isGuideUrl(href: string | undefined | null): HelpTarget | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, DOCS_BASE_URL);
  } catch {
    return null;
  }
  if (url.origin !== DOCS_BASE.origin) return null;
  const base = DOCS_BASE.pathname;
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  const page = url.pathname === base ? '' : url.pathname.slice(base.length + 1);
  let section: string | undefined;
  if (url.hash) {
    try {
      section = decodeURIComponent(url.hash.slice(1));
    } catch {
      // A malformed %-escape in the fragment: not a link this app composed,
      // so land on the page rather than letting the click handler throw.
      section = undefined;
    }
  }
  return section === undefined
    ? { page: page || 'index' }
    : { page: page || 'index', section };
}
