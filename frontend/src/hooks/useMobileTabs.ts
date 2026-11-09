'use client';

import { HomeIcon } from '@heroicons/react/24/outline';
import { useVisibleNavLinks } from '@/hooks/useVisibleNavLinks';
import { useViewDefault } from '@/hooks/useViewDefault';
import { NAV_ICONS, type NavIcon, type NavLinkDef } from '@/lib/nav-links';
import {
  BUILT_IN_VIEW_DEFAULTS,
  VIEW_DEFAULT_FIELDS,
  type MobileTabId,
} from '@/lib/view-defaults';

export interface MobileTab {
  id: MobileTabId;
  href: string;
  /** Translation key in the `navigation` namespace. */
  labelKey: string;
  icon: NavIcon;
}

const DASHBOARD_LINK: NavLinkDef = { href: '/dashboard', labelKey: 'dashboard' };
const SETTINGS_LINK: NavLinkDef = { href: '/settings', labelKey: 'settings' };

function isMobileTabId(id: string): id is MobileTabId {
  return (VIEW_DEFAULT_FIELDS.mobileTabs.list as readonly string[]).includes(id);
}

function toTab(link: NavLinkDef): MobileTab | null {
  if (!isMobileTabId(link.labelKey)) return null;
  // The dashboard is "Home" on the bar, as the first tab of a phone app is.
  const isHome = link.href === DASHBOARD_LINK.href;
  return {
    id: link.labelKey,
    href: link.href,
    labelKey: isHome ? 'home' : link.labelKey,
    icon: isHome ? HomeIcon : NAV_ICONS[link.href],
  };
}

/**
 * The tabs this session can use: `options` is everything it could pick, `tabs`
 * the reader's picks among them. A pick the session cannot reach (a delegate's
 * missing section) is left off the bar rather than leading to a refusal.
 */
export function useMobileTabs() {
  const { visibleNavLinks, visibleToolsLinks, visibleAiLinks, showAiMenu } =
    useVisibleNavLinks();
  const stored = useViewDefault('mobileTabs');

  const options = [
    DASHBOARD_LINK,
    ...visibleNavLinks,
    ...(showAiMenu ? visibleAiLinks : []),
    ...visibleToolsLinks,
    SETTINGS_LINK,
  ].flatMap((link) => toTab(link) ?? []);

  const tabs = (stored ?? BUILT_IN_VIEW_DEFAULTS.mobileTabs).flatMap(
    (id) => options.find((option) => option.id === id) ?? [],
  );

  return {
    options,
    tabs,
    canAddTransaction: visibleNavLinks.some((l) => l.href === '/transactions'),
  };
}
