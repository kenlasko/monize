import { DEFAULT_LOCALE, localeBase } from "./config";
import { deepMerge } from "./deep-merge";

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
  "accountDetail",
  "accountDetail-creditCard",
  "accountDetail-banking",
  "accountDetail-investment",
  "accountDetail-asset",
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

async function importNamespace(
  locale: string,
  namespace: Namespace,
): Promise<Messages | null> {
  try {
    return (await import(`./messages/${locale}/${namespace}.json`)).default;
  } catch {
    return null;
  }
}

async function loadNamespace(
  locale: string,
  namespace: Namespace,
): Promise<Messages> {
  const base = localeBase(locale);
  if (base) {
    // Regional variant (e.g. en-GB): layer its partial overrides over the base
    // locale so every non-overridden key -- and any namespace it omits entirely
    // -- falls back to the base per key.
    const baseMessages = (await importNamespace(base, namespace)) ?? {};
    const override = await importNamespace(locale, namespace);
    return override ? deepMerge(baseMessages, override) : baseMessages;
  }
  // Full locale: load its own catalog, falling back to the default locale if a
  // namespace file is missing -- this lets contributors land a new language
  // without translating every namespace in one PR.
  const own = await importNamespace(locale, namespace);
  if (own) return own;
  if (locale !== DEFAULT_LOCALE) {
    return (await importNamespace(DEFAULT_LOCALE, namespace)) ?? {};
  }
  return {};
}

export async function loadMessages(locale: string): Promise<Messages> {
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => [ns, await loadNamespace(locale, ns)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Load a single namespace catalog for an arbitrary locale. For the rare spots
 * that must render a string in a locale other than the active one -- e.g.
 * confirming a language change in the *target* language, while the UI is
 * still rendered in the old one.
 */
export async function loadNamespaceMessages(
  locale: string,
  namespace: Namespace,
): Promise<Messages> {
  return loadNamespace(locale, namespace);
}
