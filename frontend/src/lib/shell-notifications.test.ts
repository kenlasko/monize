import { describe, it, expect } from 'vitest';
import enNotifications from '@/i18n/messages/en/notifications.json';
import type { Notification, NotificationCategory } from '@/types/notification';
import {
  bridgeIdentity,
  NATIVE_COPY_FALLBACK_KEY,
  NATIVE_COPY_KEY,
  nativeCopyKey,
  nextShellPollDelay,
  SHELL_POLL_INTERVAL_MS,
  SHELL_POLL_MAX_DELAY_MS,
  shellNotificationRows,
} from './shell-notifications';

function notification(overrides: Partial<Notification>): Notification {
  return {
    id: 'n-1',
    userId: 'user-1',
    budgetId: null,
    budgetCategoryId: null,
    type: 'BILL_DUE',
    severity: 'warning',
    category: 'PAYMENTS',
    title: 'Rent: $1,250.00 due tomorrow',
    message: 'Rent of $1,250.00 is due on 2026-11-14.',
    data: {},
    target: '/bills',
    isRead: false,
    isEmailSent: false,
    periodStart: '2026-11-01',
    createdAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

const copy = (key: string) => ({ title: `${key} title`, body: `${key} body` });

describe('nextShellPollDelay', () => {
  it('polls every interval while requests succeed', () => {
    expect(nextShellPollDelay(0)).toBe(SHELL_POLL_INTERVAL_MS);
  });

  it('doubles per consecutive failure up to the ceiling', () => {
    expect(nextShellPollDelay(1)).toBe(SHELL_POLL_INTERVAL_MS * 2);
    expect(nextShellPollDelay(2)).toBe(SHELL_POLL_INTERVAL_MS * 4);
    expect(nextShellPollDelay(50)).toBe(SHELL_POLL_MAX_DELAY_MS);
  });
});

describe('bridgeIdentity', () => {
  const signedIn = {
    hasHydrated: true,
    isAuthenticated: true,
    userId: 'user-1',
    actingAsUserId: null,
  };

  it('is the signed-in user', () => {
    expect(bridgeIdentity(signedIn)).toBe('user-1');
  });

  it('is nobody once signed out', () => {
    expect(bridgeIdentity({ ...signedIn, isAuthenticated: false, userId: null })).toBeNull();
  });

  it('is nobody while acting for another account', () => {
    expect(bridgeIdentity({ ...signedIn, actingAsUserId: 'owner-2' })).toBeNull();
  });

  // A reload starts signed out until the store hydrates; saying "nobody" then
  // would make the shell close every notification on every page load.
  it('is not known while the store hydrates or the profile is loading', () => {
    expect(bridgeIdentity({ ...signedIn, hasHydrated: false })).toBeUndefined();
    expect(bridgeIdentity({ ...signedIn, userId: null })).toBeUndefined();
  });
});

describe('shellNotificationRows', () => {
  it('hands over unread rows with the generic copy, never the row text', () => {
    const rows = shellNotificationRows(
      [notification({}), notification({ id: 'n-2', isRead: true })],
      copy,
    );
    expect(rows).toEqual([
      {
        id: 'n-1',
        createdAt: '2026-11-13T10:00:00.000Z',
        title: 'payments title',
        body: 'payments body',
        target: '/bills',
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('1,250');
  });

  it('drops a target that leaves the origin, as the bell does', () => {
    const [row] = shellNotificationRows(
      [notification({ target: '/\t/evil.example/steal' })],
      copy,
    );
    expect(row.target).toBeNull();
    const [none] = shellNotificationRows([notification({ target: null })], copy);
    expect(none.target).toBeNull();
  });

  it('uses the fallback copy for a row without a known category', () => {
    const [missing] = shellNotificationRows([notification({ category: undefined })], copy);
    expect(missing.title).toBe('fallback title');
    expect(nativeCopyKey('NOT_A_CATEGORY' as NotificationCategory)).toBe(
      NATIVE_COPY_FALLBACK_KEY,
    );
  });
});

describe('the native copy catalog', () => {
  it('has a title and a body for every category and the fallback', () => {
    const native = (enNotifications as { native: Record<string, { title: string; body: string }> })
      .native;
    for (const key of [...Object.values(NATIVE_COPY_KEY), NATIVE_COPY_FALLBACK_KEY]) {
      expect(native[key]?.title, key).toBeTruthy();
      expect(native[key]?.body, key).toBeTruthy();
    }
  });
});
