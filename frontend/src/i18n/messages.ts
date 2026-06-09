import { DEFAULT_LOCALE } from "./config";

/**
 * Per-locale namespaced catalogs. Each namespace is a small JSON file under
 * `messages/{locale}/{namespace}.json`. New namespaces are added by:
 *   1. Adding the namespace name to NAMESPACES below
 *   2. Creating `messages/en/{namespace}.json` (and any other locales)
 *
 * Loading goes through dynamic imports so a locale's catalogs are not bundled
 * into every page until they're needed.
 */
const NAMESPACES = [
  "common",
  "settings",
  "auth",
  "navigation",
  "accounts",
  "admin",
  "ai",
  "bills",
  "budgets",
  "categories",
  "currencies",
  "dashboard",
  "emergencyAccess",
  "import",
  "insights",
  "institutions",
  "investments",
  "layout",
  "payees",
  "reconcile",
  "reports",
  "scheduledTransactions",
  "securities",
  "tags",
  "transactions",
] as const;

type Namespace = (typeof NAMESPACES)[number];
type Messages = Record<string, unknown>;

async function loadNamespace(
  locale: string,
  namespace: Namespace,
): Promise<Messages> {
  try {
    return (await import(`./messages/${locale}/${namespace}.json`)).default;
  } catch {
    // Fall back to the default locale if a translation file is missing -- this
    // lets contributors land a new language without translating every namespace
    // in one PR.
    if (locale !== DEFAULT_LOCALE) {
      return (await import(`./messages/${DEFAULT_LOCALE}/${namespace}.json`))
        .default;
    }
    return {};
  }
}

export async function loadMessages(locale: string): Promise<Messages> {
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => [ns, await loadNamespace(locale, ns)] as const),
  );
  return Object.fromEntries(entries);
}
