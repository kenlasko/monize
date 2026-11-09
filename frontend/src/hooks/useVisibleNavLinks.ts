'use client';

import { useAuthStore } from '@/store/authStore';
import { AI_LINKS, NAV_LINKS, TOOLS_LINKS } from '@/lib/nav-links';

/**
 * The navigation this session can actually reach, so the header, the mobile
 * drawer and the command palette cannot disagree about it.
 *
 * A delegate sees a top-nav entry only if it is reachable: granted sections
 * (bills/investments/budgets/reports) plus Transactions when they can read any
 * non-investment account (delegateSections.transactions, derived server-side).
 * Accounts stays per-account scoped and hidden from the section nav; the
 * dashboard remains the delegate's landing page.
 */
export function useVisibleNavLinks() {
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const delegateCapabilities = useAuthStore((s) => s.delegateCapabilities);
  const delegateSections = useAuthStore((s) => s.delegateSections);
  const isDelegateView = !!actingAsUserId;

  const navSectionByHref: Record<
    string,
    | 'bills'
    | 'investments'
    | 'budgets'
    | 'reports'
    | 'transactions'
    | 'accounts'
  > = {
    '/accounts': 'accounts',
    '/transactions': 'transactions',
    '/bills': 'bills',
    '/investments': 'investments',
    '/budgets': 'budgets',
    '/reports': 'reports',
  };
  const visibleNavLinks = isDelegateView
    ? NAV_LINKS.filter((l) => {
        const sec = navSectionByHref[l.href];
        return !!sec && !!delegateSections?.[sec];
      })
    : NAV_LINKS;

  const showAiMenu = !isDelegateView || !!delegateSections?.ai;
  // The review inbox is owner-only: the API refuses a delegate session.
  const visibleAiLinks = isDelegateView
    ? AI_LINKS.filter((l) => !l.ownerOnly)
    : AI_LINKS;

  // A delegate sees a Tools entry when either its manage capability
  // (payees/categories/tags) or its READ section (warranties) was granted.
  // Everyone else sees all.
  const toolsCapabilityByHref: Record<
    string,
    'payees' | 'categories' | 'tags'
  > = {
    '/categories': 'categories',
    '/payees': 'payees',
    '/tags': 'tags',
  };
  const toolsSectionByHref: Record<string, 'warranties'> = {
    '/warranties': 'warranties',
  };
  const visibleToolsLinks = isDelegateView
    ? TOOLS_LINKS.filter((l) => {
        const sec = toolsSectionByHref[l.href];
        if (sec && delegateSections?.[sec]) return true;
        const cap = toolsCapabilityByHref[l.href];
        if (!cap) return false;
        const r = delegateCapabilities?.[cap];
        return !!r && (r.create || r.edit || r.delete);
      })
    : TOOLS_LINKS;

  return {
    isDelegateView,
    visibleNavLinks,
    visibleToolsLinks,
    visibleAiLinks,
    showAiMenu,
  };
}
