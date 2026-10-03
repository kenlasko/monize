import { describe, it, expect } from 'vitest';
import navigation from '@/i18n/messages/en/navigation.json';
import { NAV_LINKS, TOOLS_LINKS, AI_LINKS, NAV_ICONS } from './nav-links';

describe('nav-links', () => {
  it('gives every nav route an icon', () => {
    // The drawer and the header dropdowns render NAV_ICONS[href]; a link
    // added without an icon would ship a bare row beside decorated ones.
    const missing = [...NAV_LINKS, ...TOOLS_LINKS, ...AI_LINKS]
      .map((l) => l.href)
      .filter((href) => !NAV_ICONS[href]);
    expect(missing).toEqual([]);
  });

  it('covers the fixed drawer entries outside the arrays', () => {
    for (const href of ['/dashboard', '/admin/users', '/settings']) {
      expect(NAV_ICONS[href], `no icon for ${href}`).toBeTruthy();
    }
  });

  it('keeps hrefs unique across the three arrays', () => {
    const hrefs = [...NAV_LINKS, ...TOOLS_LINKS, ...AI_LINKS].map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('puts Rules in the Tools menu with an icon and a catalog label', () => {
    expect(TOOLS_LINKS).toContainEqual({ href: '/rules', labelKey: 'rules' });
    expect(NAV_ICONS['/rules']).toBeTruthy();
  });

  it('puts the review inbox in the AI menu, owner-only, with an icon', () => {
    expect(AI_LINKS).toContainEqual({ href: '/ai-reviews', labelKey: 'aiReviews', ownerOnly: true });
    expect(NAV_ICONS['/ai-reviews']).toBeTruthy();
    expect([...NAV_LINKS, ...TOOLS_LINKS, ...AI_LINKS].filter((l) => l.ownerOnly).map((l) => l.href)).toEqual([
      '/email-receipts',
      '/ai-reviews',
    ]);
  });

  it('puts the email receipts page in the Tools menu, owner-only, with an icon', () => {
    expect(TOOLS_LINKS).toContainEqual({ href: '/email-receipts', labelKey: 'emailReceipts', ownerOnly: true });
    expect(NAV_ICONS['/email-receipts']).toBeTruthy();
  });

  it('has a navigation label for every link', () => {
    const catalog = navigation as Record<string, unknown>;
    const missing = [...NAV_LINKS, ...TOOLS_LINKS, ...AI_LINKS]
      .map((l) => l.labelKey)
      .filter((key) => typeof catalog[key] !== 'string');
    expect(missing).toEqual([]);
  });
});
