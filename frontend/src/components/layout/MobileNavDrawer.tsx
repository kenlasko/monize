'use client';

import Image from 'next/image';
import { isNavSectionActive } from '@/lib/nav-section';
import { ADMIN_LINKS, NAV_ICONS } from '@/lib/nav-links';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import {
  ArrowRightOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { HelpMenuEntries } from '@/hooks/useHelpMenuEntries';

interface NavLink {
  href: string;
  label: string;
  badge?: string;
}

interface MobileNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current route, used to highlight the active entry. */
  pathname: string;
  /** Navigate to a route. The caller closes the drawer on route change. */
  onNavigate: (href: string) => void;
  /** Sign out; the header's button is hidden on the phones this drawer serves. */
  onLogout: () => void;
  /** Main section links the current user is allowed to see. */
  navLinks: NavLink[];
  /** AI links; only rendered when `showAiMenu` is true. */
  aiLinks: NavLink[];
  showAiMenu: boolean;
  /** Tools links the current user is allowed to see. */
  toolsLinks: NavLink[];
  /** Whether to render the Admin section. */
  showAdmin: boolean;
  /** The header Help menu's entries (`useHelpMenuEntries`), rendered as their
   *  own section instead of behind a hover the drawer has no room for. */
  helpEntries: HelpMenuEntries;
}

const SECTION_HEADER_CLASS =
  'px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider';

/**
 * Mobile navigation drawer: a full-height panel that slides in from the left
 * over a dimmed backdrop. Reuses the shared `Modal` primitive for the portal,
 * body-scroll lock, focus trap, and Escape handling. Links are a flat list
 * grouped under section headers.
 *
 * Note: the drawer deliberately does NOT use the Modal's `pushHistory`
 * (back-button-to-close). That option pushes a history entry on open and pops
 * it with `history.back()` on close; closing the drawer in response to an
 * in-drawer navigation would then revert the `router.push` that triggered the
 * close, leaving the user on the original page. The drawer instead closes via
 * the caller's route-change effect (and the explicit close in `onNavigate`).
 */
export function MobileNavDrawer({
  isOpen,
  onClose,
  pathname,
  onNavigate,
  onLogout,
  navLinks,
  aiLinks,
  showAiMenu,
  toolsLinks,
  showAdmin,
  helpEntries,
}: MobileNavDrawerProps) {
  const t = useTranslations('navigation');
  const itemClass = (active: boolean) =>
    `flex w-full items-center text-left px-4 py-3 text-base transition-colors ${
      active
        ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
    }`;

  const renderLink = (link: NavLink, active: boolean) => {
    const Icon = NAV_ICONS[link.href];
    return (
      <button
        key={link.href}
        onClick={() => onNavigate(link.href)}
        className={itemClass(active)}
      >
        {Icon && (
          <Icon
            aria-hidden
            className={`mr-4 h-5 w-5 flex-shrink-0 ${
              active
                ? 'text-blue-600 dark:text-blue-300'
                : 'text-gray-400 dark:text-gray-500'
            }`}
          />
        )}
        {link.label}
        {link.badge && (
          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            {link.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} variant="drawer-left">
      <nav aria-label={t('mainMenu')} className="flex flex-col">
        {/* Drawer header: brand + close button */}
        <div className="flex items-center justify-between px-4 h-16 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => onNavigate('/dashboard')}
            className="flex items-center gap-2 text-xl font-bold text-blue-600 dark:text-blue-400"
          >
            <Image
              src="/icons/monize-logo-transparent.svg"
              alt="Monize"
              width={28}
              height={28}
              className="rounded"
              priority
            />
            <span>Monize</span>
          </button>
          <button
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="p-2 -mr-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
          >
            <XMarkIcon className="w-6 h-6" aria-hidden="true" />
          </button>
        </div>

        <div className="py-2">
          {renderLink({ href: '/dashboard', label: t('dashboard') }, pathname === '/dashboard')}
          {navLinks.map((link) =>
            renderLink(link, isNavSectionActive(pathname, link.href)),
          )}

          {showAiMenu && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-700 mt-2" />
              <div className={SECTION_HEADER_CLASS}>{t('ai')}</div>
              {aiLinks.map((link) =>
                renderLink(link, isNavSectionActive(pathname, link.href)),
              )}
            </>
          )}

          {toolsLinks.length > 0 && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-700 mt-2" />
              <div className={SECTION_HEADER_CLASS}>{t('tools')}</div>
              {toolsLinks.map((link) =>
                renderLink(link, isNavSectionActive(pathname, link.href)),
              )}
            </>
          )}

          {showAdmin && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-700 mt-2" />
              <div className={SECTION_HEADER_CLASS}>{t('admin')}</div>
              {ADMIN_LINKS.map((link) =>
                renderLink(
                  { href: link.href, label: t(link.labelKey) },
                  isNavSectionActive(pathname, link.href),
                ),
              )}
            </>
          )}

          <div className="border-t border-gray-200 dark:border-gray-700 mt-2" />
          <div className={SECTION_HEADER_CLASS}>{t('help')}</div>
          {helpEntries.helpForPage && (
            <button
              key={helpEntries.helpForPage.key}
              onClick={() => {
                helpEntries.helpForPage?.onClick();
                onClose();
              }}
              className={itemClass(false)}
            >
              <helpEntries.helpForPage.Icon
                aria-hidden
                className="mr-4 h-5 w-5 flex-shrink-0 text-gray-400 dark:text-gray-500"
              />
              {helpEntries.helpForPage.label}
            </button>
          )}
          {helpEntries.actions.map((entry) => (
            <button
              key={entry.key}
              onClick={() => {
                entry.onClick();
                onClose();
              }}
              className={itemClass(false)}
            >
              <entry.Icon
                aria-hidden
                className="mr-4 h-5 w-5 flex-shrink-0 text-gray-400 dark:text-gray-500"
              />
              {entry.label}
            </button>
          ))}
          {helpEntries.links.map((link) => (
            <a
              key={link.key}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className={`${itemClass(false)} gap-1.5`}
            >
              <link.Icon
                aria-hidden
                className="mr-4 h-5 w-5 flex-shrink-0 text-gray-400 dark:text-gray-500"
              />
              <span className="flex-1">{link.label}</span>
              <ArrowTopRightOnSquareIcon
                aria-hidden
                className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500"
              />
            </a>
          ))}

          <div className="border-t border-gray-200 dark:border-gray-700 mt-2" />
          {renderLink({ href: '/settings', label: t('settings') }, pathname === '/settings')}
          <button type="button" onClick={onLogout} className={itemClass(false)}>
            <ArrowRightOnRectangleIcon
              aria-hidden
              className="mr-4 h-5 w-5 flex-shrink-0 text-gray-400 dark:text-gray-500"
            />
            {t('logout')}
          </button>
        </div>
      </nav>
    </Modal>
  );
}
