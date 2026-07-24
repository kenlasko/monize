'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useHideOnScroll } from '@/hooks/useHideOnScroll';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/lib/auth';
import Image from 'next/image';
import { Button } from '@/components/ui/Button';
import { BudgetAlertBadge } from '@/components/budgets/BudgetAlertBadge';
import { ActionHistoryPanel } from '@/components/layout/ActionHistoryPanel';
import { MobileNavDrawer } from '@/components/layout/MobileNavDrawer';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import {
  HEADER_SEARCH_EVENT,
  clearTransactionFilterStorage,
  type HeaderSearchEventDetail,
} from '@/hooks/useTransactionFilters';
import toast from 'react-hot-toast';

// Labels are translation keys in the `navigation` namespace, resolved at
// render time. The href doubles as the route and the active-state match.
const navLinks = [
  { href: '/transactions', labelKey: 'transactions' },
  { href: '/bills', labelKey: 'bills' },
  { href: '/investments', labelKey: 'investments' },
  { href: '/accounts', labelKey: 'accounts' },
  { href: '/budgets', labelKey: 'budgets' },
  { href: '/reports', labelKey: 'reports' },
];

const toolsLinks: { href: string; labelKey: string; badge?: string }[] = [
  { href: '/categories', labelKey: 'categories' },
  { href: '/payees', labelKey: 'payees' },
  { href: '/institutions', labelKey: 'institutions' },
  { href: '/tags', labelKey: 'tags' },
  { href: '/securities', labelKey: 'securities' },
  { href: '/currencies', labelKey: 'currencies' },
  { href: '/import', labelKey: 'import' },
];

const aiLinks: { href: string; labelKey: string }[] = [
  { href: '/insights', labelKey: 'insights' },
  { href: '/ai', labelKey: 'aiAssistant' },
];

// Guided-tour anchors for the desktop nav, keyed by route. Attached in exactly
// one place (here) so the anchor-uniqueness test stays satisfied; the mobile
// drawer is left un-anchored since nav tour steps are skipOnMobile.
const NAV_TOUR_ANCHORS: Record<string, { 'data-tour-id': string }> = {
  '/transactions': tourAnchor(TOUR_ANCHORS.navTransactions),
  '/accounts': tourAnchor(TOUR_ANCHORS.navAccounts),
  '/budgets': tourAnchor(TOUR_ANCHORS.navBudgets),
  '/reports': tourAnchor(TOUR_ANCHORS.navReports),
};

export function AppHeader() {
  const t = useTranslations('navigation');
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const delegateCapabilities = useAuthStore((s) => s.delegateCapabilities);
  const delegateSections = useAuthStore((s) => s.delegateSections);
  const isDelegateView = !!actingAsUserId;
  // A delegate sees a top-nav entry only if it is reachable: granted
  // sections (bills/investments/budgets/reports) plus Transactions when
  // they can read any non-investment account (delegateSections.transactions,
  // derived server-side). Accounts stays per-account scoped and hidden from
  // the section nav; the dashboard remains the delegate's landing page.
  const navSectionByHref: Record<
    string,
    'bills' | 'investments' | 'budgets' | 'reports' | 'transactions' | 'accounts'
  > = {
    '/accounts': 'accounts',
    '/transactions': 'transactions',
    '/bills': 'bills',
    '/investments': 'investments',
    '/budgets': 'budgets',
    '/reports': 'reports',
  };
  const visibleNavLinks = isDelegateView
    ? navLinks.filter((l) => {
        const sec = navSectionByHref[l.href];
        return !!sec && !!delegateSections?.[sec];
      })
    : navLinks;
  const showAiMenu = !isDelegateView || !!delegateSections?.ai;
  // A delegate sees only the Tools sections they were granted manage
  // capability for (payees/categories/tags). Everyone else sees all.
  const toolsCapabilityByHref: Record<
    string,
    'payees' | 'categories' | 'tags'
  > = {
    '/categories': 'categories',
    '/payees': 'payees',
    '/tags': 'tags',
  };
  const visibleToolsLinks = isDelegateView
    ? toolsLinks.filter((l) => {
        const cap = toolsCapabilityByHref[l.href];
        if (!cap) return false;
        const r = delegateCapabilities?.[cap];
        return !!r && (r.create || r.edit || r.delete);
      })
    : toolsLinks;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const toolsRef = useRef<HTMLDivElement>(null);
  const aiRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdowns when clicking outside
  useClickOutside(toolsRef, () => setToolsOpen(false));
  useClickOutside(aiRef, () => setAiOpen(false));
  useClickOutside(searchRef, () => setSearchOpen(false));

  // Focus the search input as it slides open.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const submitSearch = () => {
    const term = searchTerm.trim();
    if (!term) return;
    // Wipe persisted filters so the hook initializes clean (including
    // `accountStatus`, which is not represented in the URL).
    clearTransactionFilterStorage();
    // Notify a mounted Transactions page to reset and apply the term.
    const detail: HeaderSearchEventDetail = { term };
    window.dispatchEvent(new CustomEvent(HEADER_SEARCH_EVENT, { detail }));
    router.push(`/transactions?search=${encodeURIComponent(term)}`);
    setSearchOpen(false);
    setSearchTerm('');
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSearch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSearchOpen(false);
      setSearchTerm('');
    }
  };

  // Close mobile menu on route change (setState during render pattern)
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setMobileMenuOpen(false);
  }

  const isToolsActive = toolsLinks.some((link) => pathname === link.href);
  const isAiActive = aiLinks.some((link) => pathname === link.href);

  // Slide the header out of view when scrolling down, back in when scrolling up,
  // moving it in lockstep with the scroll position. Keep it pinned while any
  // menu or the search field is open so the open surface never scrolls away.
  const { ref: headerRef, offset: scrollOffset } = useHideOnScroll<HTMLElement>();
  const anyMenuOpen = mobileMenuOpen || searchOpen || toolsOpen || aiOpen;
  const headerOffset = anyMenuOpen ? 0 : scrollOffset;

  // Publish how far the header is currently slid up so sticky sub-navigation
  // (e.g. the Settings menu) can anchor to the header instead of floating where
  // the header used to be once it slides out of view.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--app-header-offset', `${headerOffset}px`);
    return () => {
      root.style.removeProperty('--app-header-offset');
    };
  }, [headerOffset]);

  const handleLogout = async () => {
    try {
      await authApi.logout();
      logout();
      toast.success(t('loggedOut'));
      router.push('/login');
    } catch {
      logout();
      router.push('/login');
    }
  };

  return (
    <header
      ref={headerRef}
      style={{ transform: `translateY(-${headerOffset}px)` }}
      // No transition while scrolling so the header tracks the scroll speed 1:1;
      // a short transition only when a menu forces it back into view.
      className={`sticky top-0 z-40 bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 ${
        anyMenuOpen ? 'transition-transform duration-200 ease-out' : ''
      }`}
    >
      <div className="px-4 sm:px-6 lg:px-12">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            {/* Mobile hamburger menu button */}
            <div className="lg:hidden">
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="p-2 mr-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
                aria-label={t('toggleMenu')}
              >
                {mobileMenuOpen ? (
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>

              {/* Mobile navigation drawer (slides in from the left).
                  Delegates land on a Security-only Settings view that manages
                  their OWN credentials. */}
              <MobileNavDrawer
                isOpen={mobileMenuOpen}
                onClose={() => setMobileMenuOpen(false)}
                pathname={pathname}
                onNavigate={(href) => {
                  // Close the drawer up front so navigating to the current
                  // route (no pathname change, so the route-change effect
                  // below never fires) still dismisses it.
                  setMobileMenuOpen(false);
                  router.push(href);
                }}
                navLinks={visibleNavLinks.map((l) => ({
                  href: l.href,
                  label: t(l.labelKey),
                }))}
                aiLinks={aiLinks.map((l) => ({
                  href: l.href,
                  label: t(l.labelKey),
                }))}
                showAiMenu={showAiMenu}
                toolsLinks={visibleToolsLinks.map((l) => ({
                  href: l.href,
                  label: t(l.labelKey),
                  badge: l.badge,
                }))}
                showAdmin={!isDelegateView && user?.role === 'admin'}
              />
            </div>

            <button
              onClick={() => router.push('/dashboard')}
              className="hidden lg:flex items-center gap-2 text-2xl font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              <Image src="/icons/monize-logo.svg" alt="Monize" width={32} height={32} className="rounded" priority />
              <span className="hidden lg:inline">Monize</span>
            </button>
            {(!isDelegateView ||
              visibleNavLinks.length > 0 ||
              visibleToolsLinks.length > 0 ||
              showAiMenu) && (
            <nav className="hidden lg:ml-8 lg:flex lg:items-center lg:space-x-4">
              {visibleNavLinks.map((link) => (
                <button
                  key={link.href}
                  {...NAV_TOUR_ANCHORS[link.href]}
                  onClick={() => router.push(link.href)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    pathname === link.href
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  {t(link.labelKey)}
                </button>
              ))}

              {showAiMenu && (
              <>
              {/* AI Dropdown */}
              <div className="relative" ref={aiRef}>
                <button
                  onClick={() => setAiOpen(!aiOpen)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1 ${
                    isAiActive
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  {t('ai')}
                  <svg
                    className={`w-4 h-4 transition-transform ${aiOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {aiOpen && (
                  <div className="absolute left-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50">
                    <div className="py-1">
                      {aiLinks.map((link) => (
                        <button
                          key={link.href}
                          onClick={() => {
                            router.push(link.href);
                            setAiOpen(false);
                          }}
                          className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                            pathname === link.href
                              ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {t(link.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              </>
              )}

              {visibleToolsLinks.length > 0 && (
              <>
              {/* Tools Dropdown */}
              <div className="relative" ref={toolsRef}>
                <button
                  {...tourAnchor(TOUR_ANCHORS.navTools)}
                  onClick={() => setToolsOpen(!toolsOpen)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1 ${
                    isToolsActive
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  {t('tools')}
                  <svg
                    className={`w-4 h-4 transition-transform ${toolsOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {toolsOpen && (
                  <div className="absolute left-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50">
                    <div className="py-1">
                      {visibleToolsLinks.map((link) => (
                        <button
                          key={link.href}
                          onClick={() => {
                            router.push(link.href);
                            setToolsOpen(false);
                          }}
                          className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                            pathname === link.href
                              ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {t(link.labelKey)}
                          {link.badge && (
                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                              {link.badge}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              </>
              )}

              {/* Admin link - only visible to admins */}
              {!isDelegateView && user?.role === 'admin' && (
                <button
                  onClick={() => router.push('/admin/users')}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    pathname.startsWith('/admin')
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  {t('admin')}
                </button>
              )}
            </nav>
            )}
          </div>
          <div className="flex items-center space-x-1 sm:space-x-4">
            <div className="relative" ref={searchRef}>
              <div className="flex items-center">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t('search.placeholder')}
                  aria-label={t('search.label')}
                  aria-hidden={!searchOpen}
                  tabIndex={searchOpen ? 0 : -1}
                  className={`overflow-hidden transition-all duration-200 ease-out rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    searchOpen
                      ? 'w-44 sm:w-64 px-3 py-1.5 mr-1 opacity-100'
                      : 'w-0 px-0 py-1.5 border-transparent opacity-0 pointer-events-none'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (searchOpen) {
                      submitSearch();
                    } else {
                      setSearchOpen(true);
                    }
                  }}
                  aria-label={searchOpen ? t('search.submit') : t('search.open')}
                  title={t('search.label')}
                  className="p-2 rounded-md text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-5 h-5"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <ActionHistoryPanel />
            <BudgetAlertBadge />
            <button
              {...tourAnchor(TOUR_ANCHORS.navSettings)}
              onClick={() => router.push('/settings')}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                pathname === '/settings'
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title={t('settings')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                />
              </svg>
              <span className="hidden sm:inline">{user?.firstName || user?.email}</span>
            </button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              title={t('logout')}
              aria-label={t('logout')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
                />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
